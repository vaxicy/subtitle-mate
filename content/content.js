// SubtitleMate content script.
// Auto-enables YouTube captions and translates them to the target language
// without requiring the user to click anything.

(function () {
  const K = {
    AUTO_CAPTIONS: 'sm_autoCaptions',
    SOURCE_LANG: 'sm_sourceLang',
    TARGET_LANG: 'sm_targetLang',
    REMEMBER_LANG: 'sm_rememberLang',
    AUTO_ON_YT: 'sm_autoOnYt',
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
      [K.SOURCE_LANG]: 'en',
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
    // Otherwise pick the source-language track (or the first one) so we can request translation.
    const source = tracks.find((t) => t.langCode === settings[K.SOURCE_LANG] || t.languageCode === settings[K.SOURCE_LANG]);
    return source || tracks[0];
  }

  function applyApi(player) {
    if (!player || !isEnabled()) return false;
    try {
      const target = settings[K.TARGET_LANG];
      const track = findCaptionTrack(player, target);

      // Turn captions on.
      if (typeof player.updateSubtitleUserConfig === 'function') {
        player.updateSubtitleUserConfig({ kind: 'PLAYBACK', enable: true });
      }
      if (typeof player.setOption === 'function') {
        try { player.setOption('captions', 'track', track || {}); } catch (_) {}
        // Several YouTube player builds accept one of these translation options.
        const translationOptions = [
          ['captions', 'translationLanguage', { languageCode: target }],
          ['captions', 'translationLang', target],
          ['captions', 'translation_language', target],
        ];
        for (const args of translationOptions) {
          try { player.setOption(...args); } catch (_) {}
        }
      }
      if (typeof player.updateTranslateLanguage === 'function') {
        try { player.updateTranslateLanguage(target); } catch (_) {}
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

  function clickSubtitlesButton() {
    const btn = document.querySelector('.ytp-subtitles-button');
    if (!btn) return false;
    const pressed = btn.getAttribute('aria-pressed') === 'true';
    if (!pressed) {
      fireRealClick(btn);
      return true;
    }
    return false;
  }

  // Click the CC button and detect whether a language panel popped up.
  // Returns 'pressed' if we turned captions on, 'panel' if a language list appeared, false otherwise.
  function clickCcAndDetectPanel() {
    const btn = document.querySelector('.ytp-subtitles-button');
    if (!btn) return false;
    // If a language panel (the new popout list) is already visible, treat as panel.
    const panel = document.querySelector('.ytp-panel-menu, .ytp-popup .ytp-panel-menu, .ytp-sb-slot, .ytp-caption-window-container');
    if (panel && panel.offsetParent && /中文|Chinese/.test(panel.textContent)) return 'panel';

    const pressed = btn.getAttribute('aria-pressed') === 'true';
    if (!pressed) {
      fireRealClick(btn);
      // Give YouTube a moment to render the language menu.
      return 'clicked';
    }
    return 'already';
  }

  function settingsMenuVisible() {
    const panel = document.querySelector('.ytp-settings-menu');
    return !!(panel && panel.offsetParent && (panel.style.display !== 'none'));
  }

  // Click the settings gear with a real event chain, then poll until the
  // settings menu actually opens. Retry up to maxTries with a short delay.
  async function openSettingsMenu(maxTries = 3) {
    const btn = document.querySelector('.ytp-settings-button');
    if (!btn) return false;
    if (settingsMenuVisible()) return true;
    for (let i = 0; i < maxTries; i++) {
      fireRealClick(btn);
      for (let t = 0; t < 5; t++) {
        await sleep(100);
        if (settingsMenuVisible()) return true;
      }
    }
    return false;
  }

  function settingsMenuItems() {
    return Array.from(document.querySelectorAll('.ytp-menuitem, .ytp-panel-menu .ytp-menuitem'));
  }

  function findMenuItem(labelRe) {
    return settingsMenuItems().find((el) => labelRe.test(el.textContent.trim()));
  }

  function closeSettingsMenu() {
    const btn = document.querySelector('.ytp-settings-button');
    const panel = document.querySelector('.ytp-settings-menu');
    if (panel && panel.offsetParent && btn) fireRealClick(btn);
  }

  async function selectMenuPath(labels, timeout = 3500) {
    const start = Date.now();
    for (const labelRe of labels) {
      while (Date.now() - start < timeout) {
        const item = findMenuItem(labelRe);
        if (item) {
          fireRealClick(item);
          await sleep(250);
          break;
        }
        await sleep(150);
      }
    }
  }

  async function applyUiFallback() {
    if (!isEnabled()) return false;
    const target = settings[K.TARGET_LANG];
    const targetLabel = target === 'zh-CN' || target === 'zh-Hans' || target.startsWith('zh')
      ? /^(中文（简体）|中文 \(简体\)|中文 ?- ?简体|中文|Chinese ?\(Simplified\)|Chinese ?- ?Simplified|Chinese)$/i
      : new RegExp('^' + target.replace(/[-]/g, '[- ]?') + '$', 'i');

    try {
      // Path B: click the CC button directly; on newer players a language list pops up.
      const res = clickCcAndDetectPanel();
      await sleep(400);
      if (res === 'clicked' || res === 'panel' || res === 'already') {
        // Look for a standalone language panel (new YouTube UI).
        const panelItems = document.querySelectorAll('.ytp-panel-menu .ytp-menuitem, .ytp-popup .ytp-menuitem');
        let picked = false;
        for (const el of panelItems) {
          if (targetLabel.test(el.textContent.trim())) {
            fireRealClick(el);
            picked = true;
            break;
          }
        }
        if (picked) {
          closeSettingsMenu();
          return true;
        }
      }

      // Path A: settings gear -> Subtitles/CC -> Auto-translate -> target language.
      clickSubtitlesButton();
      await sleep(300);
      if (!await openSettingsMenu()) return false;
      await sleep(350);
      await selectMenuPath([
        /^(Subtitles\/CC|CC|Subtitles|字幕|字幕\/CC)$/i,
        /^(Auto-translate|自动翻译|Translate|翻译)$/i,
        targetLabel,
      ], 2000);

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
