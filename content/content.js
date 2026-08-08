// SubtitleMate content script.
// Auto-enables YouTube captions, either auto-translated into the target
// language or using "English (auto-generated)" captions, without requiring
// the user to click anything.

(function () {
  const K = {
    AUTO_CAPTIONS: 'sm_autoCaptions',
    CAPTION_MODE: 'sm_captionMode',
    TARGET_LANG: 'sm_targetLang',
    REMEMBER_LANG: 'sm_rememberLang',
    AUTO_ON_YT: 'sm_autoOnYt',
  };

  const MODE = {
    TRANSLATE: 'translate',
    AUTO_GENERATED: 'auto-generated',
  };

  let settings = null;
  let applied = false;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function getVideo() {
    return document.querySelector('video.html5-main-video');
  }

  function getPlayer() {
    const video = getVideo();
    if (!video) return null;
    if (window.yt && window.yt.player && typeof window.yt.player.getPlayerByElement === 'function') {
      const p = window.yt.player.getPlayerByElement(video);
      if (p && typeof p.getPlayerResponse === 'function') return p;
    }
    const mp = document.getElementById('movie_player');
    if (mp && typeof mp.getPlayerResponse === 'function') return mp;
    return null;
  }

  async function loadSettings() {
    const defs = {
      [K.AUTO_CAPTIONS]: true,
      [K.CAPTION_MODE]: MODE.TRANSLATE,
      [K.TARGET_LANG]: 'zh-CN',
      [K.REMEMBER_LANG]: true,
      [K.AUTO_ON_YT]: true,
    };
    settings = await chrome.storage.sync.get(defs);
  }

  function isEnabled() {
    return settings && settings[K.AUTO_CAPTIONS] && settings[K.AUTO_ON_YT];
  }

  function findCaptionTrack(player, target) {
    if (typeof player.getAvailableCaptionTracks !== 'function') return null;
    const tracks = player.getAvailableCaptionTracks();
    if (!Array.isArray(tracks) || !tracks.length) return null;
    // For auto-translation we must select an ORIGINAL track first.
    // Prefer English auto-generated, otherwise the first non-translation track.
    const isTranslation = (t) => t.kind === 'translation' || t.isTranslation ||
      (t.name && String(t.name).toLowerCase().includes('translate'));
    const original = tracks.find((t) =>
      !isTranslation(t) && (t.langCode === 'en' || t.languageCode === 'en')
    ) || tracks.find((t) => !isTranslation(t)) || tracks[0];
    return original;
  }

  function applyApi(player) {
    if (!player || !isEnabled()) return false;
    try {
      // Turn captions on.
      if (typeof player.updateSubtitleUserConfig === 'function') {
        player.updateSubtitleUserConfig({ kind: 'PLAYBACK', enable: true });
      }
      if (typeof player.setOption === 'function') {
        if (settings[K.CAPTION_MODE] === MODE.AUTO_GENERATED) {
          // Pick "English (auto-generated)".
          try { player.setOption('captions', 'track', { languageCode: 'en', kind: 'asr' }); } catch (_) {}
          // Stop any active translation.
          const clearTranslation = [
            ['captions', 'translationLanguage', {}],
            ['captions', 'translationLang', null],
          ];
          for (const args of clearTranslation) {
            try { player.setOption(...args); } catch (_) {}
          }
        } else {
          const target = settings[K.TARGET_LANG];
          const track = findCaptionTrack(player, target);
          try { player.setOption('captions', 'track', track || {}); } catch (_) {}
          const translationOptions = [
            ['captions', 'translationLanguage', { languageCode: target }],
            ['captions', 'translationLang', target],
            ['captions', 'translation_language', target],
          ];
          for (const args of translationOptions) {
            try { player.setOption(...args); } catch (_) {}
          }
        }
      }
      if (settings[K.CAPTION_MODE] !== MODE.AUTO_GENERATED &&
          typeof player.updateTranslateLanguage === 'function') {
        try { player.updateTranslateLanguage(settings[K.TARGET_LANG]); } catch (_) {}
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function isTargetLang(current) {
    if (!current) return false;
    const target = settings[K.TARGET_LANG];
    const cur = String(current).toLowerCase();
    const tgt = target.toLowerCase();
    if (cur === tgt) return true;
    // zh-CN / zh-Hans / zh should all match each other.
    if (tgt.startsWith('zh') && cur.includes('zh')) return true;
    return cur.startsWith(tgt.split('-')[0]);
  }

  // --- UI fallback: click the actual player buttons so YouTube does the work for us ---

  // Dispatch a full event chain so YouTube's player buttons actually respond.
  // YouTube listens for pointer/mouse sequences, not just a synthetic .click().
  function fireRealClick(el) {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: cx,
      clientY: cy,
      screenX: cx,
      screenY: cy,
      button: 0,
      buttons: 1,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
    };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  // Resolve when a MutationObserver predicate holds or timeout elapses.
  function waitFor(condition, { timeout = 4000, interval = 120 } = {}) {
    return new Promise((resolve) => {
      if (condition()) return resolve(true);
      const start = Date.now();
      const mo = new MutationObserver(() => {
        if (condition()) {
          mo.disconnect();
          clearTimeout(timer);
          resolve(true);
        }
      });
      const timer = setTimeout(() => {
        mo.disconnect();
        resolve(!!condition());
      }, timeout);
      mo.observe(document.documentElement, { childList: true, subtree: true });
    });
  }

  // Count currently visible .ytp-panel-menu panels (settings submenus).
  function countPanels() {
    return Array.from(document.querySelectorAll('.ytp-panel-menu'))
      .filter((p) => p.offsetParent).length;
  }

  // Run cb after the CC button is guaranteed pressed; returns true if captions
  // ended up on. We poll until the aria-pressed attribute reflects "true".
  async function ensureCaptionsOn(maxTries = 5) {
    const btn = document.querySelector('.ytp-subtitles-button');
    if (!btn) return false;
    if (btn.getAttribute('aria-pressed') === 'true') return true;
    fireRealClick(btn);
    for (let i = 0; i < maxTries; i++) {
      await sleep(180);
      if (btn.getAttribute('aria-pressed') === 'true') return true;
    }
    return false;
  }

  function settingsMenuVisible() {
    const panel = document.querySelector('.ytp-settings-menu');
    return !!(panel && panel.offsetParent && (panel.style.display !== 'none'));
  }

  // Click the settings gear with a real event chain, then poll until the
  // settings menu actually opens. Retry up to maxTries with a short delay.
  async function openSettingsMenu(maxTries = 4) {
    const btn = document.querySelector('.ytp-settings-button');
    if (!btn) return false;
    if (settingsMenuVisible()) return true;
    for (let i = 0; i < maxTries; i++) {
      fireRealClick(btn);
      for (let t = 0; t < 6; t++) {
        await sleep(120);
        if (settingsMenuVisible()) return true;
      }
    }
    return false;
  }

  function settingsMenuItems() {
    return Array.from(document.querySelectorAll('.ytp-menuitem, .ytp-panel-menu .ytp-menuitem'));
  }

  // Menu item text is nested in .ytp-menuitem-label; read it first, fall back
  // to the whole element's textContent (avoids matching icon glyphs).
  function menuItemText(el) {
    const label = el.querySelector('.ytp-menuitem-label');
    return (label ? label.textContent : el.textContent).trim();
  }

  function findMenuItem(labelRe, root) {
    const items = root
      ? Array.from(root.querySelectorAll('.ytp-menuitem'))
      : settingsMenuItems();
    return items.find((el) => labelRe.test(menuItemText(el)));
  }

  // Click a menu item matching labelRe, then wait until the next submenu
  // (a new .ytp-panel-menu) appears OR the menu has simply settled. Some
  // YouTube menus replace the current panel instead of adding a deeper one,
  // so we must not fail solely because panel count did not increase.
  // Re-reads the item right before clicking to avoid a stale element after a
  // menu re-render.
  async function clickMenuItemAndWait(labelRe, timeout = 3000) {
    const ok = await waitFor(() => !!findMenuItem(labelRe), { timeout });
    if (!ok) return false;
    const item = findMenuItem(labelRe);
    if (!item) return false;
    fireRealClick(item);
    // Resolve when either a deeper panel appears (submenu opened) or the menu
    // has settled after a short wait. We do NOT require an extra panel because
    // YouTube sometimes swaps the panel content in place.
    const settled = await waitFor(() => countPanels() >= 1, { timeout: 2500 });
    if (!settled) {
      // Even if we can't observe a panel, give it a brief settle so the next
      // step finds the freshly rendered menu.
      await sleep(400);
    }
    return true;
  }

  // Click a menu item matching labelRe inside the current language list, then
  // wait until captions reflect the target (or the menu settles). Re-reads the
  // item immediately before clicking to avoid a stale element.
  async function clickLangItemAndWait(labelRe, timeout = 3000) {
    const ok = await waitFor(() => !!findMenuItem(labelRe), { timeout });
    if (!ok) return false;
    const item = findMenuItem(labelRe);
    if (!item) return false;
    fireRealClick(item);
    // Give the language selection a moment to apply.
    await sleep(500);
    return true;
  }

  // Click the CC button; on newer players a language list pops up directly.
  // We poll until either a panel appears or the button reports pressed.
  async function openCcPanel(maxTries = 5) {
    const btn = document.querySelector('.ytp-subtitles-button');
    if (!btn) return false;
    const wasPressed = btn.getAttribute('aria-pressed') === 'true';
    for (let i = 0; i < maxTries; i++) {
      const panel = document.querySelector('.ytp-panel-menu, .ytp-popup .ytp-panel-menu');
      if (panel && panel.offsetParent) return true;
      // Only click if captions are currently off; otherwise we'd toggle them off.
      if (!wasPressed && btn.getAttribute('aria-pressed') !== 'true') fireRealClick(btn);
      await sleep(250);
    }
    return false;
  }

  function closeSettingsMenu() {
    const btn = document.querySelector('.ytp-settings-button');
    const panel = document.querySelector('.ytp-settings-menu');
    if (panel && panel.offsetParent && btn) fireRealClick(btn);
  }

  function langLabelRe(lang) {
    // Use a partial match (not anchored fully) so YouTube's trailing
    // annotations like "(auto-generated)" after a language name still match.
    if (lang === 'zh-CN' || lang === 'zh-Hans' || lang.startsWith('zh')) {
      return /(中文（简体）|中文 \(简体\)|简体中文|中文 ?- ?简体|中文|Chinese ?\(Simplified\)|Chinese ?- ?Simplified|Chinese)/i;
    }
    // For other langs, allow the base code plus optional suffixes.
    const base = lang.split('-')[0];
    return new RegExp('(^|[^a-z])' + base.replace(/[-]/g, '[- ]?') + '($|[^a-z])', 'i');
  }

  async function applyUiFallback() {
    if (!isEnabled()) return false;

    // Step 1: make sure captions are on.
    const ccOn = await ensureCaptionsOn();
    console.log('[SubtitleMate] step: captions on =', ccOn);
    if (!ccOn) return false;

    try {
      if (settings[K.CAPTION_MODE] === MODE.AUTO_GENERATED) {
        // Path: CC panel -> "English (auto-generated)".
        await openCcPanel();
        let panelItems = document.querySelectorAll('.ytp-panel-menu .ytp-menuitem, .ytp-popup .ytp-menuitem');
        const target = /(English \(auto-generated\)|英语（自动生成）|英语 ?\(auto-generated\)|English)/i;
        let clickedEn = false;
        for (const el of panelItems) {
          if (target.test(menuItemText(el))) {
            fireRealClick(el);
            clickedEn = true;
            break;
          }
        }
        if (clickedEn) {
          console.log('[SubtitleMate] step: clicked English (auto-generated)');
          closeSettingsMenu();
          return true;
        }
        // Fallback through settings gear.
        if (!await openSettingsMenu()) return false;
        const okGear = await clickMenuItemAndWait(/^(Subtitles\/CC|CC|Subtitles|字幕|字幕\/CC|CC\/字幕)/i) &&
          await clickMenuItemAndWait(/^(English \(auto-generated\)|英语（自动生成）|English)/i);
        console.log('[SubtitleMate] step: auto-generated via gear =', okGear);
        closeSettingsMenu();
        return okGear;
      }

      // Auto-translate path.
      const target = settings[K.TARGET_LANG];
      const labelRe = langLabelRe(target);
      console.log('[SubtitleMate] step: translate target =', target);

      // Try the direct CC panel first (some players expose the language list here).
      await openCcPanel();
      let panelItems = document.querySelectorAll('.ytp-panel-menu .ytp-menuitem, .ytp-popup .ytp-menuitem');
      for (const el of panelItems) {
        if (labelRe.test(menuItemText(el))) {
          console.log('[SubtitleMate] step: clicked target in CC panel');
          fireRealClick(el);
          closeSettingsMenu();
          return true;
        }
      }

      // Main path: settings gear -> Subtitles/CC -> Auto-translate -> target.
      if (!await openSettingsMenu()) return false;
      const okCC = await clickMenuItemAndWait(/^(Subtitles\/CC|CC|Subtitles|字幕|字幕\/CC|CC\/字幕)/i);
      console.log('[SubtitleMate] step: opened Subtitles/CC =', okCC);
      const okAt = await clickMenuItemAndWait(/^(Auto-translate|自动翻译|自动翻译字幕|Auto-translate subtitles|Translate|翻译)/i);
      console.log('[SubtitleMate] step: opened Auto-translate =', okAt);
      // Now we are in the language list; click the target language and wait
      // for the menu to settle (panel count may stay the same, so use a short
      // wait instead of relying on a deeper panel).
      const clicked = await clickLangItemAndWait(labelRe, 4000);
      console.log('[SubtitleMate] step: clicked target language =', clicked);
      if (!clicked) {
        // Target language not found in the list; bail so we can retry.
        closeSettingsMenu();
        return false;
      }
      await sleep(400);
      closeSettingsMenu();
      return true;
    } catch (e) {
      console.log('[SubtitleMate] step: exception', e && e.message);
      closeSettingsMenu();
      return false;
    }
  }

  // --- Main retry loop ---

  async function waitForPlayer(maxMs = 12000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const player = getPlayer();
      if (player) return player;
      await sleep(400);
    }
    return null;
  }

  // Detect whether captions/translation really took effect by inspecting the
  // live caption text OR the player's caption track option. Used to gate the
  // "applied" lock so a fake success never stops the retry loop.
  function verifyApplied(player) {
    // Auto-generated mode: visible caption text is sufficient proof.
    if (settings[K.CAPTION_MODE] === MODE.AUTO_GENERATED) {
      const segs = document.querySelectorAll('.ytp-caption-segment');
      if (segs.length) return true;
      try {
        if (typeof player.getOption === 'function') {
          const track = player.getOption('captions', 'track');
          if (track && (track.kind === 'asr' ||
              String(track.languageCode || track.langCode || '').toLowerCase().startsWith('en'))) {
            return true;
          }
        }
      } catch (_) {}
      return false;
    }

    // Translate mode: captions must be visible AND actively translated into the
    // target language. Visible English segments alone are NOT enough — that just
    // means the original English track is showing. If we can read the player
    // track, confirm a translation target is set; otherwise fall back to "keep
    // retrying" so we never lock in a false success.
    try {
      if (typeof player.getOption === 'function') {
        const track = player.getOption('captions', 'track');
        if (track) {
          const tl = track.translationLanguage || track.translationLang;
          if (tl && isTargetLang(tl.languageCode || tl)) {
            return document.querySelectorAll('.ytp-caption-segment').length > 0;
          }
        }
      }
    } catch (_) {}

    // We cannot confirm translation is active (no player signal). Do NOT lock
    // success — let the retry loop keep trying. This prevents the previous bug
    // where English captions were mistaken for a finished translation.
    console.log('[SubtitleMate] verify: captions present but translation not confirmed, will retry');
    return false;
  }

  async function applyOnce() {
    if (applied) return;
    if (!isEnabled()) {
      console.log('[SubtitleMate] applyOnce skipped: disabled (autoCaptions/onYt)');
      return;
    }

    const player = await waitForPlayer(12000);
    if (!player) {
      console.log('[SubtitleMate] applyOnce: player not found yet, will retry via observer');
      return;
    }

    // API is only a lightweight pre-trigger now: try to flip the switch, but
    // its result is NEVER used to decide success. YouTube's internal state is
    // unreliable through this path, so we always follow with the UI click
    // path which drives the real player UI.
    try { applyApi(player); } catch (_) {}

    const ok = await applyUiFallback();
    console.log('[SubtitleMate] applyUiFallback returned =', ok);

    if (ok && verifyApplied(player)) {
      applied = true;
      console.log('[SubtitleMate] captions + translation applied');
    } else if (ok) {
      // UI path reported success but verification failed — keep retrying.
      console.log('[SubtitleMate] UI path done but caption not confirmed, will retry');
    } else {
      console.log('[SubtitleMate] UI path did not complete, will retry');
    }
  }

  function reset() {
    applied = false;
  }

  async function runWithRetries() {
    if (applied || !isEnabled()) return;
    for (let i = 0; i < 15; i++) {
      await applyOnce();
      if (applied) return;
      await sleep(600 + i * 250);
    }
  }

  // React to settings updates from popup/options.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'SM_SETTINGS_CHANGED') {
      settings = msg.settings;
      reset();
      runWithRetries();
    } else if (msg && msg.type === 'SM_APPLY_SUBTITLES') {
      // Manual "Apply to current video" trigger from the popup.
      console.log('[SubtitleMate] manual apply requested');
      // Ensure settings are loaded before running — init() is async and the
      // message may arrive before settings are ready, which would make
      // isEnabled() return false and silently abort.
      if (!settings) await loadSettings();
      console.log('[SubtitleMate] settings loaded, enabled =', isEnabled());
      reset();
      runWithRetries();
    }
  });

  // React to YouTube SPA navigation.
  window.addEventListener('yt-navigate-finish', () => {
    reset();
    runWithRetries();
  });

  // Watch for video injection when run_at is document_start.
  const observer = new MutationObserver(() => {
    if (!applied && isEnabled() && getVideo()) {
      runWithRetries();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  async function init() {
    await loadSettings();
    runWithRetries();
  }

  init();
})();
