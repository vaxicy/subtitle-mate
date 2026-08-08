// SubtitleMate content script.
// Robustly enables YouTube captions and auto-translates them into the user's
// chosen language by driving the player's INTERNAL object (window.yt.player /
// #movie_player) through its setOption('captions', ...) API — no simulated UI
// clicks, no reliance on YouTube's DOM being stable across SPA navigations.
//
// Method (verified against working community implementations):
//   - get the player instance that exposes getOption/setOption
//   - read the available caption tracks
//   - pick a BASE track (an original, non-translation track)
//   - enable captions + auto-translate by calling
//       player.setOption('captions', 'track', { ...baseTrack, translationLanguage: { languageCode } })
//     i.e. the translation target is NESTED inside the track object, NOT a
//     separate setOption call. A bare { languageCode } only selects an original
//     track and never triggers translation — that is the bug that made the old
//     code "fake succeed" but never show Chinese.

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

  // Map our storage language codes to what YouTube expects.
  // YouTube uses BCP-47-ish codes like "zh-Hans", "zh-Hant", "en", "ja", etc.
  // We normalise on the fly but keep a small overridable table.
  const LANG_CODE_MAP = {
    'zh-CN': 'zh-Hans',
    'zh-TW': 'zh-Hant',
    'zh-HK': 'zh-Hant',
  };

  let settings = null;
  let applied = false;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function normalizeLang(code) {
    if (!code) return null;
    return LANG_CODE_MAP[code] || code;
  }

  function getVideo() {
    return document.querySelector('video.html5-main-video');
  }

  // The internal player instance. window.yt.player.getPlayerByElement(video)
  // is the most reliable handle; #movie_player is the public fallback.
  function getPlayer() {
    const video = getVideo();
    if (video && window.yt && window.yt.player &&
        typeof window.yt.player.getPlayerByElement === 'function') {
      try {
        const p = window.yt.player.getPlayerByElement(video);
        if (p && typeof p.getOption === 'function' &&
            typeof p.setOption === 'function') return p;
      } catch (_) {}
    }
    const mp = document.getElementById('movie_player');
    if (mp && typeof mp.getOption === 'function' &&
        typeof mp.setOption === 'function') return mp;
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
    return !!settings && settings[K.AUTO_CAPTIONS] && settings[K.AUTO_ON_YT];
  }

  // Read available caption tracks from the player's live tracklist option.
  // Returns an array of track descriptors (each may carry languageCode,
  // languageName, kind, vss_id, is_translateable, etc.) or [].
  function getTrackList(player) {
    try {
      const list = player.getOption('captions', 'tracklist');
      if (Array.isArray(list) && list.length) return list;
    } catch (_) {}
    // Older/alternative accessor.
    try {
      if (typeof player.getAvailableCaptionTracks === 'function') {
        const t = player.getAvailableCaptionTracks();
        if (Array.isArray(t) && t.length) return t;
      }
    } catch (_) {}
    return [];
  }

  function trackLangCode(t) {
    return t && (t.languageCode || t.langCode || t.code || '');
  }

  function isTranslationTrack(t) {
    const lc = String(trackLangCode(t) || '');
    const name = String(t.languageName || t.name || t.displayName || '');
    return t.kind === 'translation' || t.isTranslation === true ||
      lc.startsWith('translate') || /translat/i.test(name);
  }

  // Choose the BASE (original) track to translate FROM.
  // Priority: an English original track, otherwise the first non-translation
  // track, otherwise the first track available. Returns a minimal descriptor
  // the player accepts, or null.
  function pickBaseTrack(tracks) {
    if (!tracks.length) return null;
    const nonTranslation = tracks.filter((t) => !isTranslationTrack(t));
    const pool = nonTranslation.length ? nonTranslation : tracks;
    const english = pool.find((t) => {
      const lc = trackLangCode(t).toLowerCase();
      return lc === 'en' || lc === 'en-us' || lc === 'en-gb' || t.kind === 'asr';
    });
    const chosen = english || pool[0];
    // Build a minimal track object the player will accept. We copy the fields
    // that matter and drop anything undefined so the object stays clean.
    const track = {
      languageCode: trackLangCode(chosen),
    };
    if (chosen.languageName) track.languageName = chosen.languageName;
    if (chosen.displayName) track.displayName = chosen.displayName;
    if (chosen.name) track.name = chosen.name;
    if (chosen.kind) track.kind = chosen.kind;
    if (chosen.vss_id) track.vss_id = chosen.vss_id;
    if (chosen.id) track.id = chosen.id;
    if (chosen.is_translateable !== undefined)
      track.is_translateable = chosen.is_translateable;
    if (chosen.isTranslateable !== undefined)
      track.isTranslateable = chosen.isTranslateable;
    return track;
  }

  // Apply captions + auto-translate programmatically via the player API.
  // Returns true if the calls were accepted (does NOT guarantee on-screen
  // captions — verification is done separately so we never lock a false win).
  function applyApi(player) {
    if (!player || !isEnabled()) return false;
    try {
      // 1) Make sure captions are turned on.
      if (typeof player.updateSubtitleUserConfig === 'function') {
        try {
          player.updateSubtitleUserConfig({ kind: 'PLAYBACK', enable: true });
        } catch (_) {}
      }

      if (settings[K.CAPTION_MODE] === MODE.AUTO_GENERATED) {
        // Pure "English (auto-generated)" captions, no translation.
        const enTrack = {
          languageCode: 'en',
          kind: 'asr',
          languageName: 'English',
          displayName: 'English',
        };
        try { player.setOption('captions', 'track', enTrack); } catch (_) {}
        // Clear any lingering translation target.
        try { player.setOption('captions', 'translationLanguage', {}); } catch (_) {}
        return true;
      }

      // Auto-translate path.
      const targetCode = normalizeLang(settings[K.TARGET_LANG]) || 'zh-Hans';
      const tracks = getTrackList(player);
      if (!tracks.length) {
        // No tracklist yet — try forcing a known base track + translation.
        // Some players accept this even before the tracklist populates.
        try {
          player.setOption('captions', 'track', {
            languageCode: 'en',
            kind: 'asr',
            translationLanguage: { languageCode: targetCode, languageName: targetCode },
          });
        } catch (_) {}
        return true;
      }

      const base = pickBaseTrack(tracks);
      if (!base) return false;

      // THE KEY STEP: nest translationLanguage INSIDE the track object so the
      // player selects the base track AND turns on auto-translate to target.
      const trackWithTranslation = Object.assign({}, base, {
        translationLanguage: {
          languageCode: targetCode,
          languageName: targetCode,
        },
      });
      try {
        player.setOption('captions', 'track', trackWithTranslation);
      } catch (_) {
        // Fallback: set track and translation target separately in the exact
        // order the player expects (track first, then translation language).
        try { player.setOption('captions', 'track', base); } catch (_) {}
        try {
          player.setOption('captions', 'translationLanguage',
            { languageCode: targetCode, languageName: targetCode });
        } catch (_) {}
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function isTargetLang(current) {
    if (!current) return false;
    const target = normalizeLang(settings[K.TARGET_LANG]) || 'zh-Hans';
    const cur = String(current).toLowerCase();
    const tgt = target.toLowerCase();
    if (cur === tgt) return true;
    // zh-Hans / zh-Hant / zh-CN all match each other loosely.
    if (tgt.startsWith('zh') && cur.includes('zh')) return true;
    return cur.startsWith(tgt.split('-')[0]);
  }

  // Confirm the translation actually took effect by reading the player's live
  // track option. This is the guard that prevents locking in a "fake success".
  function verifyApplied(player) {
    if (!player || typeof player.getOption !== 'function') return false;
    try {
      const track = player.getOption('captions', 'track');
      if (!track) return false;
      if (!document.querySelectorAll('.ytp-caption-segment').length) return false;

      if (settings[K.CAPTION_MODE] === MODE.AUTO_GENERATED) {
        const lc = String(trackLangCode(track) || '').toLowerCase();
        return track.kind === 'asr' || lc.startsWith('en');
      }
      const tl = track.translationLanguage || track.translationLang;
      return !!(tl && isTargetLang(tl.languageCode || tl));
    } catch (_) {
      return false;
    }
  }

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
    if (applied) return;
    if (!isEnabled()) {
      console.log('[SubtitleMate] skipped: disabled');
      return;
    }

    const player = await waitForPlayer(12000);
    if (!player) {
      console.log('[SubtitleMate] player not ready, will retry via observer');
      return;
    }

    const ok = applyApi(player);
    console.log('[SubtitleMate] applyApi returned =', ok);

    if (ok && verifyApplied(player)) {
      applied = true;
      console.log('[SubtitleMate] captions + translation confirmed applied');
    } else if (ok) {
      console.log('[SubtitleMate] applied but not yet confirmed, will retry');
    } else {
      console.log('[SubtitleMate] applyApi failed, will retry');
    }
  }

  function reset() {
    applied = false;
  }

  async function runWithRetries() {
    if (applied || !isEnabled()) return;
    for (let i = 0; i < 20; i++) {
      await applyOnce();
      if (applied) return;
      await sleep(500 + i * 250);
    }
  }

  // React to settings updates from popup.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'SM_SETTINGS_CHANGED') {
      settings = msg.settings;
      reset();
      runWithRetries();
    } else if (msg && msg.type === 'SM_APPLY_SUBTITLES') {
      if (!settings) { loadSettings().then(() => { reset(); runWithRetries(); }); return; }
      reset();
      runWithRetries();
    }
  });

  // React to YouTube SPA navigation (switching videos, going watch -> watch).
  window.addEventListener('yt-navigate-finish', () => {
    reset();
    runWithRetries();
  });

  // Watch for the video element being injected (run_at: document_start).
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
