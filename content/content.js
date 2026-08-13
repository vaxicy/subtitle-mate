// SubtitleMate content script (isolated world).
// Orchestrates caption/translation by delegating player-API work to
// content/bridge.js, which runs in the page's main world and can access
// YouTube's internal window.yt.player API.  Communication is done via
// window.postMessage.

(function () {
  'use strict';

  console.log('[SubtitleMate] content script loaded v' +
    (chrome.runtime && chrome.runtime.getManifest && chrome.runtime.getManifest().version || '?'));

  const K = {
    AUTO_CAPTIONS: 'sm_autoCaptions',
    CAPTION_MODE: 'sm_captionMode',
    TARGET_LANG: 'sm_targetLang',
    AUTO_ON_YT: 'sm_autoOnYt',
    AUTO_PLAYBACK_SPEED: 'sm_autoPlaybackSpeed',
    PLAYBACK_RATE: 'sm_playbackRate',
  };

  const MODE = {
    TRANSLATE: 'translate',
    AUTO_GENERATED: 'auto-generated',
  };

  let settings = null;
  let applied = false;
  let running = false;
  let bridgeReady = false;
  let navigateDebounceTimer = null;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function loadSettings() {
    const defs = {
      [K.AUTO_CAPTIONS]: true,
      [K.CAPTION_MODE]: MODE.TRANSLATE,
      [K.TARGET_LANG]: 'zh-CN',
      [K.AUTO_ON_YT]: true,
      [K.AUTO_PLAYBACK_SPEED]: false,
      [K.PLAYBACK_RATE]: 1.5,
    };
    settings = await chrome.storage.sync.get(defs);
  }

  function isEnabled() {
    return !!settings && settings[K.AUTO_CAPTIONS] && settings[K.AUTO_ON_YT];
  }

  // ---------- bridge injection ----------

  function injectBridge() {
    if (document.getElementById('subtitlemate-bridge-script')) return true;
    if (!chrome.runtime || !chrome.runtime.getURL) return false;
    const s = document.createElement('script');
    s.id = 'subtitlemate-bridge-script';
    s.src = chrome.runtime.getURL('content/bridge.js');
    s.async = true;
    s.onload = () => console.log('[SubtitleMate] bridge script injected');
    s.onerror = () => console.log('[SubtitleMate] bridge script failed to load');
    const root = document.head || document.documentElement;
    if (!root) return false;
    root.appendChild(s);
    return true;
  }

  async function waitForBridge(maxMs = 3000) {
    if (bridgeReady) return true;
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      if (bridgeReady) return true;
      await sleep(100);
    }
    return false;
  }

  function sendBridgeCommand(type, payload, timeout = 8000) {
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2) + Date.now();
      const handler = (event) => {
        const data = event.data;
        if (!data || data.source !== 'subtitlemate-bridge') return;
        if (data.type === 'RESULT' && data.id === id) {
          window.removeEventListener('message', handler);
          resolve(data.payload || { ok: false, info: 'empty result' });
        }
      };
      window.addEventListener('message', handler);
      window.postMessage({ source: 'subtitlemate-content', type, id, payload }, '*');
      setTimeout(() => {
        window.removeEventListener('message', handler);
        resolve({ ok: false, info: 'bridge command timeout' });
      }, timeout);
    });
  }

  // ---------- state comparison ----------

  function stateMatchesTarget(st, mode, targetCode) {
    if (!st || !st.ok) return !!st.panelSatisfied;
    if (st.panelSatisfied) return true;
    if (mode === MODE.AUTO_GENERATED) {
      // Expect an English base track with no translation.
      if (!st.baseLang || st.baseLang.indexOf('en') !== 0) return false;
      if (st.isTranslation) return false;
    } else {
      // Expect a track translated into the chosen language.
      if (!st.isTranslation) return false;
      if (st.translationLanguage !== (targetCode || 'zh-CN').toLowerCase()) return false;
    }
    return true;
  }

  function speedMatchesTarget(st) {
    if (!st || !st.ok || !settings[K.AUTO_PLAYBACK_SPEED]) return true;
    const targetRate = Number(settings[K.PLAYBACK_RATE]) || 1.5;
    if (typeof st.playbackRate !== 'number') return false;
    return Math.abs(st.playbackRate - targetRate) < 0.01;
  }

  // ---------- main flow ----------

  async function applyOnce() {
    if (applied) return;
    if (!isEnabled()) {
      console.log('[SubtitleMate] skipped: disabled');
      return;
    }

    injectBridge();
    const bridgeOk = await waitForBridge(3000);
    if (!bridgeOk) {
      console.log('[SubtitleMate] bridge not ready, will retry');
      return;
    }

    const mode = settings[K.CAPTION_MODE];
    const targetCode = settings[K.TARGET_LANG] || 'zh-CN';
    console.log('[SubtitleMate] applyOnce mode=' + mode + ' target=' + targetCode);

    // First: read the actual state. If YouTube already shows the right
    // captions/translation (via API or via the open settings panel), just mark
    // success and do nothing more.
    const currentState = await sendBridgeCommand('GET_STATE', { mode: mode, targetLang: targetCode }, 5000);
    console.log('[SubtitleMate] current state -> ' + JSON.stringify(currentState));
    if (stateMatchesTarget(currentState, mode, targetCode)) {
      const speedOk = speedMatchesTarget(currentState);
      if (speedOk) {
        applied = true;
        try { observer.disconnect(); } catch (_) {}
        console.log('[SubtitleMate] success: captions already satisfy target; no action needed');
        return;
      }
      // Captions are right but speed is wrong: skip APPLY, just set speed below.
      console.log('[SubtitleMate] captions already correct, only speed needs adjustment');
    }

    const result = await sendBridgeCommand('APPLY', {
      mode: mode,
      targetLang: targetCode,
    }, 30000);

    console.log('[SubtitleMate] bridge result -> ' + JSON.stringify(result));
    if (result && result.ok) {
      applied = true;
      // Stop further automatic triggers once successfully applied.
      try { observer.disconnect(); } catch (_) {}
      console.log('[SubtitleMate] success: ' + result.info);
    } else {
      const info = (result && result.info) || 'unknown';
      console.log('[SubtitleMate] failed: ' + info);
      // Surface a hint for the user when the multilingual-auto-translate path
      // didn't take: it usually means either (a) the video has no caption
      // tracks yet, or (b) the "auto-translate → Chinese" menu entry needs a
      // manual first click.  Check the console for "[SubtitleMate] tracklist".
      if (!applied) {
        console.log('[SubtitleMate] hint: open DevTools console and look for "[SubtitleMate] tracklist" + "[SubtitleMate] api: verify" lines to diagnose. If tracklist is empty, captions are not available for this video.');
      }
    }

    // Auto-set playback speed (independent of caption success), but only if
    // it is not already correct.
    if (settings && settings[K.AUTO_PLAYBACK_SPEED] && !speedMatchesTarget(currentState)) {
      const rate = Number(settings[K.PLAYBACK_RATE]) || 1.5;
      const sr = await sendBridgeCommand('SET_PLAYBACK_RATE', { rate }, 8000);
      console.log('[SubtitleMate] playback rate result -> ' + JSON.stringify(sr));
    }
  }

  function reset() {
    applied = false;
    // Re-enable observer in case it was disconnected after a previous success.
    try { observer.observe(document.documentElement, { childList: true, subtree: true }); } catch (_) {}
  }



  function currentVideoId() {
    const m = location.href.match(/[?&]v=([^&]+)/);
    return m ? m[1] : location.pathname;
  }

  async function runWithRetries() {
    if (running || applied || !isEnabled()) return;
    running = true;
    try {
      // Fewer, gentler retries with exponential back-off so we don't keep
      // hammering YouTube (which would reset the translation stream and make
      // the Chinese captions never finish loading).
      for (let i = 0; i < 5; i++) {
        await applyOnce();
        if (applied) return;
        await sleep(2000 + i * 2000);
      }
      // Exhausted retries without success -> definitive failure.
      console.log('[SubtitleMate] failed after retries; applied=' + applied);
    } finally {
      running = false;
    }
  }

  // ---------- listeners ----------

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.source !== 'subtitlemate-bridge') return;
    if (data.type === 'READY') {
      bridgeReady = true;
      console.log('[SubtitleMate] bridge reported ready');
    }
  });

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
    clearTimeout(navigateDebounceTimer);
    navigateDebounceTimer = setTimeout(() => {
      reset();
      runWithRetries();
    }, 300);
  });

  // Watch for the video element being injected (run_at: document_start).
  function getVideo() {
    return document.querySelector('video.html5-main-video') ||
           document.querySelector('#movie_player video') ||
           document.querySelector('video');
  }

  let observerCooldownUntil = 0;
  const observer = new MutationObserver(() => {
    if (applied || !isEnabled() || !getVideo()) return;
    const now = Date.now();
    // Throttle DOM-triggered runs: at most one every 2s, so a burst of
    // YouTube DOM mutations can't spam runWithRetries.
    if (now < observerCooldownUntil) return;
    observerCooldownUntil = now + 2000;
    runWithRetries();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  async function init() {
    await loadSettings();
    injectBridge();
    runWithRetries();
  }

  init();
})();
