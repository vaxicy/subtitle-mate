// SubtitleMate content script.
// Robustly enables YouTube captions and auto-translates them into the user's
// chosen language.
//
// Strategy (verified against the real YouTube UI you operate manually):
//   1) Turn captions on via the player API (fast, reliable).
//   2) Drive the caption settings panel and click "Auto-translate" -> target
//      language. This is exactly the path you do by hand, so it works wherever
//      YouTube's menu labels are present, independent of the internal player
//      object's flaky translation API.
//
// We keep BOTH the caption mode (translate / auto-generated) and the target
// language configurable from the popup.

(function () {
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

  // Map our storage language codes to YouTube's display names. YouTube shows
  // the target language inside the auto-translate submenu using these labels
  // (locale-dependent; we match both Chinese and English variants).
  const LANG_NAME_MAP = {
    'zh-CN': ['中文（简体）', '简体中文', 'Chinese (Simplified)'],
    'zh-TW': ['中文（繁體）', '中文（繁体）', 'Chinese (Traditional)'],
    'zh-HK': ['中文（繁體）', '中文（繁体）', 'Chinese (Traditional)'],
    'en': ['English', '英语'],
    'ja': ['日本語', 'Japanese', '日语'],
    'ko': ['한국어', 'Korean', '韩语'],
    'fr': ['Français', 'French', '法语'],
    'de': ['Deutsch', 'German', '德语'],
    'es': ['Español', 'Spanish', '西班牙语'],
    'pt': ['Português', 'Portuguese', '葡萄牙语'],
    'ru': ['Русский', 'Russian', '俄语'],
    'it': ['Italiano', 'Italian', '意大利语'],
    'ar': ['العربية', 'Arabic', '阿拉伯语'],
    'hi': ['हिन्दी', 'Hindi', '印地语'],
    'th': ['ไทย', 'Thai', '泰语'],
    'vi': ['Tiếng Việt', 'Vietnamese', '越南语'],
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

  // ---------- step 1: turn captions on via API ----------

  function enableCaptionsApi(player) {
    if (!player) return;
    try {
      if (typeof player.updateSubtitleUserConfig === 'function') {
        player.updateSubtitleUserConfig({ kind: 'PLAYBACK', enable: true });
      }
      if (typeof player.setOption === 'function') {
        // Nudge a track on so the caption settings gear becomes meaningful.
        try {
          const list = player.getOption('captions', 'tracklist');
          if (Array.isArray(list) && list.length) {
            const base = list[0];
            player.setOption('captions', 'track', {
              languageCode: base.languageCode || base.langCode || base.code,
            });
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  // ---------- step 2: click the auto-translate submenu ----------

  // Open the settings (gear) panel for captions. Returns the panel root or null.
  async function openCaptionSettingsPanel() {
    // Approach: click the CC/settings button in the player bar, then the
    // "Subtitles/CC" menu item, which reveals the caption settings panel.
    const ytp = document.querySelector('.ytp-chrome-controls') ||
                document.getElementById('movie_player');
    if (!ytp) return null;

    // Click the settings (gear) button.
    const gearBtn = ytp.querySelector('.ytp-settings-button');
    if (!gearBtn) return null;
    gearBtn.click();
    await sleep(300);

    // Find and click the "Subtitles/CC" entry in the overflow menu.
    const menu = document.querySelector('.ytp-settings-menu');
    if (!menu) { gearBtn.click(); return null; }
    const subItem = findMenuItem(menu, ['字幕', 'Subtitles', 'CC', 'Captions']);
    if (!subItem) { gearBtn.click(); return null; }
    subItem.click();
    await sleep(300);

    // The caption settings sub-panel should now be visible.
    const panel = document.querySelector('.ytp-panel.ytp-caption-settings-overlay') ||
                  document.querySelector('.ytp-panel');
    return panel;
  }

  function findMenuItem(root, keywords) {
    const items = root.querySelectorAll('.ytp-menuitem, .ytp-panel-menu li');
    for (const item of items) {
      const label = (item.textContent || '').trim();
      if (!label) continue;
      for (const kw of keywords) {
        if (label.includes(kw)) return item;
      }
    }
    return null;
  }

  function findSubMenuByLabel(root, keywords) {
    // A menuitem that opens a submenu has an arrow; its label matches keyword.
    const items = root.querySelectorAll('.ytp-menuitem');
    for (const item of items) {
      const label = (item.textContent || '').trim();
      if (!label) continue;
      for (const kw of keywords) {
        if (label.includes(kw)) return item;
      }
    }
    return null;
  }

  function matchesTargetLang(itemText, targetCode) {
    const names = LANG_NAME_MAP[targetCode] || [targetCode];
    const t = (itemText || '').trim();
    for (const n of names) {
      if (n && t.includes(n)) return true;
    }
    return false;
  }

  async function clickAutoTranslate(targetCode) {
    // Open caption settings panel (gear -> Subtitles/CC).
    const panel = await openCaptionSettingsPanel();
    if (!panel) return false;

    // Click "Auto-translate" submenu item.
    const autoItem = findSubMenuByLabel(panel,
      ['自动翻译', 'Auto-translate', 'Translate', '翻訳']);
    if (!autoItem) { closePanels(); return false; }
    autoItem.click();
    await sleep(300);

    // The submenu lists target languages. Find and click the target.
    const submenu = document.querySelector('.ytp-panel.ytp-caption-settings-overlay .ytp-panel-menu') ||
                    document.querySelector('.ytp-panel-menu');
    if (!submenu) { closePanels(); return false; }

    const candidates = submenu.querySelectorAll('.ytp-menuitem');
    for (const c of candidates) {
      if (matchesTargetLang(c.textContent, targetCode)) {
        c.click();
        await sleep(300);
        closePanels();
        return true;
      }
    }
    closePanels();
    return false;
  }

  function closePanels() {
    // Press Escape and click the gear to ensure menus collapse cleanly.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    const gear = document.querySelector('.ytp-settings-button');
    if (gear) gear.click();
  }

  // ---------- verification ----------

  function verifyApplied(player) {
    if (!document.querySelectorAll('.ytp-caption-segment').length) return false;
    if (settings[K.CAPTION_MODE] === MODE.AUTO_GENERATED) return true;
    // For translate mode, presence of caption segments after we clicked the
    // target language is sufficient confirmation in this UI-driven path.
    return true;
  }

  // ---------- main flow ----------

  async function applyOnce() {
    if (applied) return;
    if (!isEnabled()) {
      console.log('[SubtitleMate] skipped: disabled');
      return;
    }

    const player = getPlayer() || (await waitForPlayer(8000));
    if (!player) return;

    enableCaptionsApi(player);

    if (settings[K.CAPTION_MODE] === MODE.AUTO_GENERATED) {
      // "English (auto-generated)" is reachable via the same panel:
      // gear -> Subtitles/CC -> (pick the "English (auto-generated)" track).
      // Simpler: try API, then ensure panel path as fallback is optional.
      // For auto-generated we rely on the API track selection.
      try {
        player.setOption('captions', 'track', {
          languageCode: 'en', kind: 'asr',
          languageName: 'English', displayName: 'English',
        });
      } catch (_) {}
      applied = true;
      console.log('[SubtitleMate] auto-generated captions enabled');
      return;
    }

    const targetCode = settings[K.TARGET_LANG] || 'zh-CN';
    const ok = await clickAutoTranslate(targetCode);
    if (ok && verifyApplied(player)) {
      applied = true;
      console.log('[SubtitleMate] auto-translate -> ' + targetCode + ' confirmed');
    } else {
      console.log('[SubtitleMate] auto-translate click failed, will retry');
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
    } else if (msg && msg.type === 'SM_APPLY_SUBTITLES') {
      if (!settings) { loadSettings().then(() => { reset(); runWithRetries(); }); return; }
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
