// SubtitleMate content script.
// Injects into YouTube watch pages and uses the YouTube player API (yt.player)
// to enable captions and set the translation target language automatically.

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

  function getPlayer() {
    // YouTube exposes the player instance on the <video> element's parent.
    const video = document.querySelector('video.html5-main-video');
    if (!video) return null;
    const player = video; // the API methods live on the video element in modern YT
    if (typeof player.getPlayerResponse !== 'function') return null;
    return player;
  }

  async function loadSettings() {
    const defs = {
      [K.AUTO_CAPTIONS]: true,
      [K.SOURCE_LANG]: 'en',
      [K.TARGET_LANG]: 'zh-CN',
      [K.REMEMBER_LANG]: true,
      [K.AUTO_ON_YT]: true,
    };
    const data = await chrome.storage.sync.get(defs);
    settings = data;
  }

  function applyCaptions() {
    if (!settings) return;
    if (!settings[K.AUTO_CAPTIONS] || !settings[K.AUTO_ON_YT]) return;
    const player = getPlayer();
    if (!player) return;

    try {
      // Enable captions.
      if (typeof player.updateSubtitleUserConfig === 'function') {
        player.updateSubtitleUserConfig({ kind: 'PLAYBACK', enable: true });
      }
      if (typeof player.setOption === 'function') {
        try { player.setOption('captions', 'track', {}); } catch (_) {}
      }

      // Set translation: YouTube stores the preferred translation code.
      const target = settings[K.TARGET_LANG];
      if (typeof player.updateTranslateLanguage === 'function') {
        player.updateTranslateLanguage(target);
      }
      if (typeof player.setOption === 'function') {
        try { player.setOption('captions', 'translationLang', target); } catch (_) {}
      }

      // Turn on auto-translate by selecting the translated track when available.
      if (typeof player.getAvailableCaptionTracks === 'function') {
        const tracks = player.getAvailableCaptionTracks();
        if (Array.isArray(tracks) && tracks.length) {
          const native = tracks.find((tr) => tr.langCode === settings[K.SOURCE_LANG]) || tracks[0];
          const translated = tracks.find((tr) =>
            tr.langCode === target && (tr.kind === 'translation' || tr.isTranslation));
          const chosen = translated || native;
          if (chosen) player.setOption('captions', 'track', chosen);
        }
      }

      applied = true;
    } catch (e) {
      // Player API shape varies; retry on next tick.
    }
  }

  function tryApply() {
    if (applied) return;
    applyCaptions();
    if (!applied) setTimeout(tryApply, 1200);
  }

  // React to SPA navigation (yt-navigate-finish) and settings changes.
  function observeNavigation() {
    window.addEventListener('yt-navigate-finish', () => {
      applied = false;
      tryApply();
    });
    if (document.querySelector('ytd-watch-flexy')) {
      applied = false;
      tryApply();
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'SM_SETTINGS_CHANGED') {
      settings = msg.settings;
      applied = false;
      tryApply();
    }
  });

  async function start() {
    await loadSettings();
    observeNavigation();
    tryApply();
  }

  start();
})();
