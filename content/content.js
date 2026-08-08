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
    // Prefer an already-translated track in the target language.
    const translated = tracks.find((t) =>
      (t.langCode === target || t.languageCode === target) &&
      (t.kind === 'translation' || t.isTranslation || t.name && String(t.name).toLowerCase().includes('translate'))
    );
    if (translated) return translated;
    // Otherwise pick the first available track so we can request translation.
    return tracks[0];
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

  // --- UI fallback: click the actual player buttons so YouTube does the work for us ---

  // Dispatch a full event chain so YouTube's player buttons actually respond.
  // YouTube listens for pointer/mouse sequences, not just a synthetic .click().
  function fireRealClick(el) {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      screenX: rect.left + rect.width / 2,
      screenY: rect.top + rect.height / 2,
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

  function findMenuItem(labelRe, root) {
    const items = root
      ? Array.from(root.querySelectorAll('.ytp-menuitem'))
      : settingsMenuItems();
    return items.find((el) => labelRe.test(el.textContent.trim()));
  }

  // Click a menu item matching labelRe, then poll until the next submenu
  // (a new .ytp-panel-menu) actually appears before resolving.
  async function clickMenuItemAndWait(labelRe, timeout = 3000) {
    const start = Date.now();
    const prevPanels = document.querySelectorAll('.ytp-panel-menu').length;
    while (Date.now() - start < timeout) {
      const item = findMenuItem(labelRe);
      if (item) {
        fireRealClick(item);
        // Wait for a deeper panel to render (submenu opened) OR just settle.
        for (let t = 0; t < 10; t++) {
          await sleep(120);
          if (document.querySelectorAll('.ytp-panel-menu').length > prevPanels) return true;
        }
        return true;
      }
      await sleep(150);
    }
    return false;
  }

  // Click the CC button; on newer players a language list pops up directly.
  // We poll until either a panel appears or the button reports pressed.
  async function openCcPanel(maxTries = 5) {
    const btn = document.querySelector('.ytp-subtitles-button');
    if (!btn) return false;
    for (let i = 0; i < maxTries; i++) {
      const panel = document.querySelector('.ytp-panel-menu, .ytp-popup .ytp-panel-menu');
      if (panel && panel.offsetParent) return true;
      if (btn.getAttribute('aria-pressed') !== 'true') fireRealClick(btn);
      await sleep(200);
    }
    return false;
  }

  function closeSettingsMenu() {
    const btn = document.querySelector('.ytp-settings-button');
    const panel = document.querySelector('.ytp-settings-menu');
    if (panel && panel.offsetParent && btn) fireRealClick(btn);
  }

  function langLabelRe(lang) {
    return lang === 'zh-CN' || lang === 'zh-Hans' || lang.startsWith('zh')
      ? /^(中文（简体）|中文 \(简体\)|中文 ?- ?简体|中文|Chinese ?\(Simplified\)|Chinese ?- ?Simplified|Chinese)$/i
      : new RegExp('^' + lang.replace(/[-]/g, '[- ]?') + '$', 'i');
  }

  async function applyUiFallback() {
    if (!isEnabled()) return false;

    // Step 1: make sure captions are on.
    const ccOn = await ensureCaptionsOn();
    if (!ccOn) return false;

    try {
      if (settings[K.CAPTION_MODE] === MODE.AUTO_GENERATED) {
        // Path: CC panel -> "English (auto-generated)".
        await openCcPanel();
        const panelItems = document.querySelectorAll('.ytp-panel-menu .ytp-menuitem, .ytp-popup .ytp-menuitem');
        const target = /^(English \(auto-generated\)|英语（自动生成）|英语 ?\(auto-generated\)|English ?\(auto-generated\))$/i;
        for (const el of panelItems) {
          if (target.test(el.textContent.trim())) {
            fireRealClick(el);
            closeSettingsMenu();
            return true;
          }
        }
        // Fallback through settings gear.
        if (!await openSettingsMenu()) return false;
        await clickMenuItemAndWait(/^(Subtitles\/CC|CC|Subtitles|字幕|字幕\/CC)$/i);
        await clickMenuItemAndWait(/^(English \(auto-generated\)|英语（自动生成）|English ?\(auto-generated\))$/i);
        closeSettingsMenu();
        return true;
      }

      // Auto-translate path.
      const target = settings[K.TARGET_LANG];
      const labelRe = langLabelRe(target);

      // Try the direct CC panel first.
      await openCcPanel();
      let panelItems = document.querySelectorAll('.ytp-panel-menu .ytp-menuitem, .ytp-popup .ytp-menuitem');
      for (const el of panelItems) {
        if (labelRe.test(el.textContent.trim())) {
          fireRealClick(el);
          closeSettingsMenu();
          return true;
        }
      }

      // Fallback: settings gear -> Subtitles/CC -> Auto-translate -> target.
      if (!await openSettingsMenu()) return false;
      await clickMenuItemAndWait(/^(Subtitles\/CC|CC|Subtitles|字幕|字幕\/CC)$/i);
      await clickMenuItemAndWait(/^(Auto-translate|自动翻译|Translate|翻译)$/i);
      // Now we are in the language list; click the target language.
      const start = Date.now();
      while (Date.now() - start < 3000) {
        const items = document.querySelectorAll('.ytp-panel-menu .ytp-menuitem, .ytp-popup .ytp-menuitem');
        let picked = false;
        for (const el of items) {
          if (labelRe.test(el.textContent.trim())) {
            fireRealClick(el);
            picked = true;
            break;
          }
        }
        if (picked) break;
        await sleep(150);
      }
      closeSettingsMenu();
      return true;
    } catch (e) {
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

  async function applyOnce() {
    if (applied || !isEnabled()) return;

    const player = await waitForPlayer(12000);
    if (!player) {
      // Keep trying via observer/SPA events.
      return;
    }

    let ok = applyApi(player);
    if (!ok) {
      // API route failed; use the UI fallback.
      ok = await applyUiFallback();
    }

    if (ok) {
      applied = true;
      console.log('[SubtitleMate] captions + translation applied');
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
