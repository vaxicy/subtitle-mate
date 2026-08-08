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

  function clickSubtitlesButton() {
    const btn = document.querySelector('.ytp-subtitles-button');
    if (!btn) return false;
    const pressed = btn.getAttribute('aria-pressed') === 'true';
    if (!pressed) {
      btn.click();
      return true;
    }
    return false;
  }

  function openSettingsMenu() {
    const btn = document.querySelector('.ytp-settings-button');
    if (!btn) return false;
    const panel = document.querySelector('.ytp-settings-menu');
    if (!panel || panel.style.display === 'none' || !panel.offsetParent) {
      btn.click();
    }
    return true;
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
    if (panel && panel.offsetParent && btn) btn.click();
  }

  async function selectMenuPath(labels, timeout = 3500) {
    const start = Date.now();
    for (const labelRe of labels) {
      while (Date.now() - start < timeout) {
        const item = findMenuItem(labelRe);
        if (item) {
          item.click();
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
      ? /^(中文（简体）|中文 \(简体\)|中文|Chinese \(Simplified\)|Chinese)$/
      : new RegExp('^' + target.replace(/[-]/g, '[- ]?') + '$', 'i');

    try {
      // 1. Make sure captions are on.
      clickSubtitlesButton();
      await sleep(300);

      // 2. Open the player settings gear.
      if (!openSettingsMenu()) return false;
      await sleep(350);

      // 3. Navigate: Subtitles/CC -> Auto-translate -> target language.
      await selectMenuPath([
        /^(Subtitles\/CC|CC|Subtitles|字幕)$/i,
        /^(Auto-translate|自动翻译|Translate)$/i,
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
