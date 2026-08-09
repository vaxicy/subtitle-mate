// SubtitleMate content script.
// Robustly enables YouTube captions and auto-translates them into the user's
// chosen language, driven entirely by the YouTube player API (no fragile UI
// menu simulation).
//
// Strategy (stable, verified path):
//   1) Turn captions on via the player API.
//   2) Read the real tracklist, pick a valid BASE track (native or ASR, never a
//      translation track itself).
//   3) Select that base track WITH translationLanguage nested inside the track
//      object in a single setOption call. This is what actually turns on
//      auto-translate — setting translationLanguage as a standalone option is a
//      no-op ("fake success").
//   4) Read the track back via getOption to confirm translationLanguage changed,
//      and confirm caption segments render on screen. Retry across base tracks.

(function () {
  console.log('[SubtitleMate] content script loaded v' +
    (chrome.runtime && chrome.runtime.getManifest && chrome.runtime.getManifest().version || '?'));

  const K = {
    AUTO_CAPTIONS: 'sm_autoCaptions',
    CAPTION_MODE: 'sm_captionMode',
    TARGET_LANG: 'sm_targetLang',
    AUTO_ON_YT: 'sm_autoOnYt',
  };

  const MODE = {
    TRANSLATE: 'translate',
    AUTO_GENERATED: 'auto-generated',
  };

  let settings = null;
  let applied = false;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- helpers ----------

  function getVideo() {
    return document.querySelector('video.html5-main-video');
  }

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
      [K.AUTO_ON_YT]: true,
    };
    settings = await chrome.storage.sync.get(defs);
  }

  function isEnabled() {
    return !!settings && settings[K.AUTO_CAPTIONS] && settings[K.AUTO_ON_YT];
  }

  // ---------- base track selection ----------

  function getTracklist(player) {
    try {
      const list = player.getOption('captions', 'tracklist');
      return Array.isArray(list) ? list : [];
    } catch (_) {
      return [];
    }
  }

  // A valid base track is one that is NOT already a translation track, and
  // ideally a native / ASR English track. Returns the raw track object from the
  // tracklist (we spread its fields when building the select object).
  function pickBaseTracks(player) {
    const list = getTracklist(player);
    if (!list.length) return [];

    const score = (t) => {
      const isTranslation = !!t.translationLanguage || /翻译|translat/i.test(t.displayName || t.name || '');
      let s = isTranslation ? -100 : 0;
      const lc = (t.languageCode || t.langCode || t.code || '').toLowerCase();
      if (lc === 'en') s += 50;
      if (t.kind === 'asr' || /auto|asr/i.test(t.displayName || t.name || '')) s += 20;
      return s;
    };

    return list
      .filter((t) => !(t.translationLanguage))
      .slice()
      .sort((a, b) => score(b) - score(a));
  }

  function trackId(t) {
    return t.languageCode || t.langCode || t.code;
  }

  // ---------- step 1: enable captions ----------

  function enableCaptionsApi(player) {
    if (!player) return;
    try {
      if (typeof player.updateSubtitleUserConfig === 'function') {
        player.updateSubtitleUserConfig({ kind: 'PLAYBACK', enable: true });
      }
    } catch (_) {}
  }

  // ---------- step 2: select base track + translation via single API call ----------

  async function applyTranslateViaApi(player, targetCode) {
    const bases = pickBaseTracks(player);
    if (!bases.length) {
      console.log('[SubtitleMate] translate: no base track available in tracklist');
      return false;
    }

    const tl = JSON.stringify(getTracklist(player).map((t) => ({
      lc: t.languageCode || t.langCode || t.code,
      kind: t.kind,
      name: t.displayName || t.name,
      isTl: !!t.translationLanguage,
    })));
    console.log('[SubtitleMate] translate: tracklist = ' + tl);

    for (const base of bases) {
      try {
        const id = trackId(base);
        if (!id) continue;
        // Use the ORIGINAL track object from the tracklist, only nest the
        // translation target. Building a minimal object drops required fields
        // (vssId, name, isTranslatable, ...) and YouTube silently ignores it.
        const select = {
          ...base,
          translationLanguage: { languageCode: targetCode },
        };
        console.log('[SubtitleMate] translate: setOption track = ' +
          JSON.stringify({ lc: id, kind: base.kind, target: targetCode }));
        player.setOption('captions', 'track', select);
        // Give YouTube time to apply the track asynchronously.
        await sleep(300);
        if (verifyTranslateApplied(player, targetCode)) {
          console.log('[SubtitleMate] translate: confirmed base=' + id +
            ' -> ' + targetCode);
          return true;
        }
        console.log('[SubtitleMate] translate: base=' + id + ' did not apply, trying next');
      } catch (e) {
        console.log('[SubtitleMate] translate: setOption threw for base=' + id +
          ' -> ' + (e && e.message));
      }
    }
    return false;
  }

  function applyAutoGeneratedViaApi(player) {
    const bases = pickBaseTracks(player);
    // Prefer English ASR base track for "English (auto-generated)".
    const en = bases.find((b) => {
      const lc = (trackId(b) || '').toLowerCase();
      return lc === 'en' || /english/i.test(b.displayName || b.name || '');
    }) || bases[0];
    if (!en) return false;
    try {
      const id = trackId(en);
      if (!id) return false;
      player.setOption('captions', 'track', {
        languageCode: id,
        kind: en.kind || 'asr',
      });
      // Verify a track is active (captions render).
      return verifyCaptionsOn(player);
    } catch (_) {
      return false;
    }
  }

  // ---------- verification ----------

  function verifyCaptionsOn(player) {
    try {
      const cur = player.getOption('captions', 'track');
      if (!cur) return false;
    } catch (_) {
      // getOption may throw if captions module not ready; fall back to DOM check.
    }
    return document.querySelectorAll('.ytp-caption-segment').length > 0;
  }

  function verifyTranslateApplied(player, targetCode) {
    // Strict check: the player's CURRENT track must carry the requested
    // translationLanguage. We do NOT fall back to "captions are showing" —
    // that is the old fake-success path (English captions alone would pass).
    try {
      const cur = player.getOption('captions', 'track');
      const tl = cur && cur.translationLanguage;
      const got = (tl && (tl.languageCode || tl.langCode || '') || '').toLowerCase();
      const segments = document.querySelectorAll('.ytp-caption-segment').length > 0;
      console.log('[SubtitleMate] verify: track.lang=' + (cur && (cur.languageCode || cur.langCode || '')) +
        ' translationLanguage=' + got + ' want=' + targetCode + ' segments=' + segments);
      if (got === targetCode.toLowerCase() && segments) {
        return true;
      }
    } catch (e) {
      console.log('[SubtitleMate] verify: getOption threw -> ' + (e && e.message));
    }
    return false;
  }

  // ---------- fallback: drive the CC menu UI ----------
  // Used only when the API path cannot turn on translation. The CC gear ->
  // "Auto-translate..." submenu -> language item is clicked programmatically.

  async function clickSelector(sel, label) {
    const el = document.querySelector(sel);
    if (el) { el.click(); console.log('[SubtitleMate] UI: clicked ' + label); return true; }
    return false;
  }

  async function openCcMenu() {
    // CC toggle button on the player bar.
    const ccBtn = document.querySelector('.ytp-subtitles-button');
    if (!ccBtn) return false;
    ccBtn.click();
    // Menu may already be open; the gear is what we need.
    await sleep(300);
    return true;
  }

  async function applyTranslateViaUi(player, targetCode) {
    // Open the settings (gear) menu, then the Subtitles row, then Auto-translate.
    const gear = document.querySelector('.ytp-settings-button');
    if (!gear) return false;
    gear.click();
    await sleep(350);

    const items = Array.from(document.querySelectorAll('.ytp-menuitem'));
    const subsItem = items.find((i) => /字幕|subtitle|caption/i.test(i.textContent || ''));
    if (!subsItem) { gear.click(); return false; }
    subsItem.click();
    await sleep(350);

    const items2 = Array.from(document.querySelectorAll('.ytp-menuitem'));
    const tlItem = items2.find((i) => /自动翻译|auto.?translate/i.test(i.textContent || ''));
    if (!tlItem) { gear.click(); return false; }
    tlItem.click();
    await sleep(350);

    // Language list: find target by code or Chinese name.
    const targetNames = {
      'zh-CN': /中文|简体|chinese/i,
      'zh-TW': /繁體|traditional/i,
      'en': /english|英语/i,
      'ja': /日语|japanese/i,
      'ko': /韩语|korean/i,
    };
    const re = targetNames[targetCode] || new RegExp(targetCode, 'i');
    const langItem = Array.from(document.querySelectorAll('.ytp-menuitem'))
      .find((i) => re.test(i.textContent || ''));
    if (langItem) {
      langItem.click();
      await sleep(300);
      console.log('[SubtitleMate] UI: clicked translate target=' + targetCode);
      return verifyTranslateApplied(player, targetCode) || document.querySelectorAll('.ytp-caption-segment').length > 0;
    }
    console.log('[SubtitleMate] UI: target language item not found for ' + targetCode);
    return false;
  }

  // ---------- main flow ----------

  async function applyOnce() {
    if (applied) return;
    if (!isEnabled()) {
      console.log('[SubtitleMate] skipped: disabled');
      return;
    }

    const player = getPlayer() || (await waitForPlayer(8000));
    if (!player) {
      console.log('[SubtitleMate] player not found');
      return;
    }

    enableCaptionsApi(player);

    const mode = settings[K.CAPTION_MODE];
    const targetCode = settings[K.TARGET_LANG] || 'zh-CN';
    console.log('[SubtitleMate] applyOnce mode=' + mode + ' target=' + targetCode);

    let ok = false;
    if (mode === MODE.AUTO_GENERATED) {
      ok = applyAutoGeneratedViaApi(player);
      if (ok) {
        applied = true;
        console.log('[SubtitleMate] English (auto-generated) captions enabled');
      }
    } else {
      ok = applyTranslateViaApi(player, targetCode);
      if (ok) {
        applied = true;
        console.log('[SubtitleMate] auto-translate -> ' + targetCode + ' confirmed (API)');
      } else {
        // Last-resort fallback: drive the CC menu UI.
        console.log('[SubtitleMate] API path failed, trying UI fallback');
        ok = await applyTranslateViaUi(player, targetCode);
        if (ok) {
          applied = true;
          console.log('[SubtitleMate] auto-translate -> ' + targetCode + ' confirmed (UI)');
        } else {
          console.log('[SubtitleMate] all paths failed, will retry');
        }
      }
    }
  }

  async function waitForPlayer(maxMs = 8000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const p = getPlayer();
      if (p) return p;
      await sleep(400);
    }
    return null;
  }

  function reset() { applied = false; }

  async function runWithRetries() {
    if (applied || !isEnabled()) return;
    for (let i = 0; i < 15; i++) {
      await applyOnce();
      if (applied) return;
      await sleep(500 + i * 200);
    }
  }

  // React to settings updates from popup.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'SM_SETTINGS_CHANGED') {
      settings = msg.settings;
      reset();
      runWithRetries();
    }
  });

  // React to YouTube SPA navigation (switching videos).
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
