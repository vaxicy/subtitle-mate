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
      console.log('[SubtitleMate] failed: ' + (result && result.info || 'unknown'));
    }

    // Auto-set playback speed (independent of caption success).
    if (settings && settings[K.AUTO_PLAYBACK_SPEED]) {
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
      for (let i = 0; i < 15; i++) {
        await applyOnce();
        if (applied) return;
        await sleep(500 + i * 200);
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

  const observer = new MutationObserver(() => {
    if (!applied && isEnabled() && getVideo()) {
      runWithRetries();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  async function init() {
    await loadSettings();
    injectBridge();
    runWithRetries();
  }

  init();
})();
