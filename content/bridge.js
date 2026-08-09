// SubtitleMate bridge script.
// Runs in the page's MAIN world so it can access YouTube's internal
// window.yt.player API.  It listens for commands from the isolated content
// script via window.postMessage and reports results back.

(function () {
  'use strict';

  if (window.__subtitleMateBridgeLoaded) return;
  window.__subtitleMateBridgeLoaded = true;

  console.log('[SubtitleMate] bridge loaded in main world');

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function getVideo() {
    return document.querySelector('video.html5-main-video') ||
           document.querySelector('#movie_player video') ||
           document.querySelector('video');
  }

  function isValidPlayer(p) {
    return p && typeof p.getOption === 'function' && typeof p.setOption === 'function';
  }

  function getPlayer() {
    const video = getVideo();

    // 1) canonical: pass the <video> element to the yt player registry
    if (video && window.yt && window.yt.player &&
        typeof window.yt.player.getPlayerByElement === 'function') {
      try {
        const p = window.yt.player.getPlayerByElement(video);
        if (isValidPlayer(p)) {
          console.log('[SubtitleMate] player found via getPlayerByElement(video)');
          return p;
        }
      } catch (e) {
        console.log('[SubtitleMate] getPlayerByElement(video) threw -> ' + (e && e.message));
      }
    }

    // 2) use the #movie_player container with the yt player registry
    const mp = document.getElementById('movie_player') || document.querySelector('#movie_player');
    if (mp && window.yt && window.yt.player &&
        typeof window.yt.player.getPlayerByElement === 'function') {
      try {
        const p = window.yt.player.getPlayerByElement(mp);
        if (isValidPlayer(p)) {
          console.log('[SubtitleMate] player found via getPlayerByElement(movie_player)');
          return p;
        }
      } catch (e) {
        console.log('[SubtitleMate] getPlayerByElement(movie_player) threw -> ' + (e && e.message));
      }
    }

    // 3) movie_player DOM element sometimes exposes .getPlayer()
    if (mp && typeof mp.getPlayer === 'function') {
      try {
        const p = mp.getPlayer();
        if (isValidPlayer(p)) {
          console.log('[SubtitleMate] player found via movie_player.getPlayer()');
          return p;
        }
      } catch (e) {
        console.log('[SubtitleMate] movie_player.getPlayer() threw -> ' + (e && e.message));
      }
    }

    // 4) some builds attach player methods directly to the container
    if (isValidPlayer(mp)) {
      console.log('[SubtitleMate] player found as movie_player element');
      return mp;
    }

    // 5) scan known yt player registries
    if (window.yt && window.yt.player) {
      const regs = [
        window.yt.player.instances,
        window.yt.player.players_,
        window.yt.player.playerByElement,
      ];
      for (const reg of regs) {
        if (!reg) continue;
        if (typeof reg === 'function') {
          try {
            const targets = [video, mp].filter(Boolean);
            for (const el of targets) {
              const p = reg(el);
              if (isValidPlayer(p)) {
                console.log('[SubtitleMate] player found via yt.player registry function');
                return p;
              }
            }
          } catch (_) {}
        } else if (typeof reg === 'object') {
          for (const key of Object.keys(reg)) {
            const p = reg[key];
            if (isValidPlayer(p)) {
              console.log('[SubtitleMate] player found via yt.player registry object');
              return p;
            }
          }
        }
      }
    }

    console.log('[SubtitleMate] player not found: video=' + !!video +
      ' movie_player=' + !!mp + ' yt.player=' + !!(window.yt && window.yt.player));
    return null;
  }

  // Returns true if the player object can accept the captions API directly,
  // regardless of whether it is also a DOM element (some builds expose
  // getOption/setOption on the #movie_player element itself).
  function canUseApi(p) {
    return isValidPlayer(p);
  }

  async function waitForPlayer(maxMs = 15000) {
    // YouTube player injection usually finishes after a short delay; give it
    // one initial pause so the first attempt doesn't hit a not-yet-ready DOM.
    await sleep(800);
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const p = getPlayer();
      if (p) return p;
      await sleep(400);
    }
    return null;
  }

  function readTranslationLanguage(cur) {
    if (!cur || !cur.translationLanguage) return '';
    const tl = cur.translationLanguage;
    if (typeof tl === 'string') return tl;
    return tl.languageCode || tl.langCode || tl.code || '';
  }

  function clickCcButtonIfPresent() {
    try {
      const btn = document.querySelector('.ytp-subtitles-button.ytp-button') ||
                  document.querySelector('button[title*="字幕"]') ||
                  document.querySelector('button[aria-label*="字幕"]') ||
                  document.querySelector('button[title*="subtitles"]') ||
                  document.querySelector('button[aria-label*="subtitles"]');
      if (btn && !btn.classList.contains('ytp-active')) {
        console.log('[SubtitleMate] fallback: clicking CC button to load captions module');
        btn.click();
        return true;
      }
    } catch (_) {}
    return false;
  }

  // ---------- UI fallback: simulate settings-menu clicks ----------

  function getSettingsPanel() {
    return document.querySelector('.ytp-settings-menu') ||
           document.querySelector('.ytp-popup.ytp-settings-menu') ||
           document.querySelector('.ytp-panel-menu') ||
           document.querySelector('.ytp-panel');
  }

  async function waitForSettingsPanel(maxMs = 3000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const panel = getSettingsPanel();
      if (panel && panel.querySelector('.ytp-menuitem')) return panel;
      await sleep(100);
    }
    return null;
  }

  function normalizeMenuText(text) {
    return (text || '').toLowerCase().replace(/[()（）\[\]]/g, '').replace(/\s+/g, ' ').trim();
  }

  function findMenuItem(panel, patternsOrSpec) {
    if (!panel) return null;
    const items = Array.from(panel.querySelectorAll('.ytp-menuitem'));
    const spec = Array.isArray(patternsOrSpec)
      ? { exact: patternsOrSpec, fallback: [], exclude: [] }
      : patternsOrSpec;
    const exact = (spec.exact || []).map(normalizeMenuText);
    const fallback = (spec.fallback || []).map(normalizeMenuText);
    const exclude = (spec.exclude || []).map(normalizeMenuText);

    // 1) exact matches first
    for (const item of items) {
      const labelEl = item.querySelector('.ytp-menuitem-label') || item;
      const text = normalizeMenuText(labelEl.textContent);
      if (exclude.some((e) => text.includes(e))) continue;
      if (exact.some((p) => text.includes(p))) return item;
    }
    // 2) fallback matches
    for (const item of items) {
      const labelEl = item.querySelector('.ytp-menuitem-label') || item;
      const text = normalizeMenuText(labelEl.textContent);
      if (exclude.some((e) => text.includes(e))) continue;
      if (fallback.some((p) => text.includes(p))) return item;
    }
    return null;
  }

  function clickSettingsButton() {
    const btn = document.querySelector('.ytp-settings-button.ytp-button') ||
                document.querySelector('button[data-tooltip-target-id="ytp-settings-button"]') ||
                document.querySelector('button[aria-label*="设置"]') ||
                document.querySelector('button[title*="settings"]') ||
                document.querySelector('button[aria-label*="settings"]');
    if (btn) {
      console.log('[SubtitleMate] ui: clicking settings button');
      btn.click();
      return true;
    }
    console.log('[SubtitleMate] ui: settings button not found');
    return false;
  }

  function closeSettingsPanel() {
    const btn = document.querySelector('.ytp-settings-button.ytp-button');
    if (btn) btn.click();
  }

  async function openSubtitlesMenu() {
    if (!clickSettingsButton()) return false;
    const panel = await waitForSettingsPanel(3000);
    if (!panel) {
      console.log('[SubtitleMate] ui: settings panel did not appear');
      return false;
    }
    const item = findMenuItem(panel, ['subtitles/cc', 'subtitles', 'cc', '字幕', 'caption']);
    if (!item) {
      console.log('[SubtitleMate] ui: subtitles menu item not found. labels=' +
        Array.from(panel.querySelectorAll('.ytp-menuitem-label')).map((el) => el.textContent).join(' | '));
      closeSettingsPanel();
      return false;
    }
    console.log('[SubtitleMate] ui: clicking subtitles menu item: ' +
      (item.querySelector('.ytp-menuitem-label') || item).textContent);
    item.click();
    await sleep(600);
    return true;
  }

  async function selectSubtitlesMenuItem(patterns, maxMs = 3000) {
    const panel = await waitForSettingsPanel(maxMs);
    if (!panel) {
      console.log('[SubtitleMate] ui: subtitles panel did not appear');
      return false;
    }
    const item = findMenuItem(panel, patterns);
    if (!item) {
      console.log('[SubtitleMate] ui: menu item not found. patterns=' + JSON.stringify(patterns) +
        ' labels=' + Array.from(panel.querySelectorAll('.ytp-menuitem-label')).map((el) => el.textContent).join(' | '));
      return false;
    }
    console.log('[SubtitleMate] ui: clicking menu item: ' +
      (item.querySelector('.ytp-menuitem-label') || item).textContent);
    item.click();
    await sleep(600);
    return true;
  }

  function targetLanguageLabels(code) {
    const map = {
      'zh-CN': {
        exact:    ['chinese simplified', 'chinese china', '中文简体', '中文中国', '简体中文'],
        fallback: ['中文'],
        exclude:  ['traditional', '繁体', '繁體'],
      },
      'zh-TW': {
        exact:    ['chinese traditional', '中文繁體', '繁体中文', '繁體中文'],
        fallback: ['中文'],
        exclude:  ['simplified', '简体', '簡體'],
      },
      'ja': {
        exact:    ['japanese', '日语', '日本語'],
        fallback: [],
        exclude:  [],
      },
      'ko': {
        exact:    ['korean', '韩语', '韓語', '한국어'],
        fallback: [],
        exclude:  [],
      },
      'es': {
        exact:    ['spanish', '西班牙语', '西班牙文'],
        fallback: [],
        exclude:  [],
      },
      'fr': {
        exact:    ['french', '法语', '法文', 'français'],
        fallback: [],
        exclude:  [],
      },
      'de': {
        exact:    ['german', '德语', '德文', 'deutsch'],
        fallback: [],
        exclude:  [],
      },
      'ru': {
        exact:    ['russian', '俄语', '俄文', 'русский'],
        fallback: [],
        exclude:  [],
      },
      'pt': {
        exact:    ['portuguese', '葡萄牙语', 'português'],
        fallback: [],
        exclude:  [],
      },
      'en': {
        exact:    ['english', '英语', '英文'],
        fallback: [],
        exclude:  [],
      },
    };
    return map[code] || { exact: [code], fallback: [], exclude: [] };
  }

  async function openSubtitlesMenuWithRetry(maxAttempts = 3) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const ok = await openSubtitlesMenu();
      if (ok) return true;
      // Menu items are asynchronously filled; close and retry after a pause.
      await sleep(500);
    }
    return false;
  }

  async function applyViaUi(mode, targetLang) {
    const opened = await openSubtitlesMenuWithRetry(3);
    if (!opened) {
      // If settings menu didn't open, try direct CC button as last resort.
      if (clickCcButtonIfPresent()) {
        await sleep(1000);
        const on = document.querySelectorAll('.ytp-caption-segment').length > 0;
        return on;
      }
      return false;
    }

    try {
      const panel = getSettingsPanel();

      // If the current selected item already matches target, do not click.
      if (panelHasSelectedMatch(panel, mode, targetLang)) {
        console.log('[SubtitleMate] ui: target already selected in menu, skip');
        return document.querySelectorAll('.ytp-caption-segment').length > 0;
      }

      if (mode === 'auto-generated') {
        const patterns = ['english auto-generated', 'english auto generated', 'english', '英语自动生成', '英语', '英文'];
        if (await selectSubtitlesMenuItem(patterns, 3000)) {
          await sleep(800);
          const on = document.querySelectorAll('.ytp-caption-segment').length > 0;
          console.log('[SubtitleMate] ui: auto-generated result segments=' + on);
          return on;
        }
        return false;
      }

      // translate mode: settings -> subtitles -> auto-translate -> target language
      if (await selectSubtitlesMenuItem(['auto-translate', 'auto translate', '自动翻译', '翻译'], 3000)) {
        // Re-open menu context is preserved; re-fetch panel and check again.
        const panel2 = getSettingsPanel();
        if (panelHasSelectedMatch(panel2, 'translate', targetLang)) {
          console.log('[SubtitleMate] ui: target already selected after auto-translate, skip');
          return document.querySelectorAll('.ytp-caption-segment').length > 0;
        }
        const patterns = targetLanguageLabels(targetLang);
        if (await selectSubtitlesMenuItem(patterns, 3000)) {
          await sleep(800);
          const on = document.querySelectorAll('.ytp-caption-segment').length > 0;
          console.log('[SubtitleMate] ui: translate result segments=' + on);
          return on;
        }
      }
      return false;
    } finally {
      // Always leave the settings panel closed for a clean state.
      closeSettingsPanel();
    }
  }

  // ---------- read current state (early stop) ----------

  // Read the currently selected track + translation language via the API
  // (used only to short-circuit when YouTube already has the desired state).
  function readCurrentState() {
    const player = getPlayer();
    if (!player || !canUseApi(player)) return null;
    try {
      const cur = player.getOption('captions', 'track');
      if (!cur) return { hasTrack: false };
      return {
        hasTrack: true,
        baseLang: (cur.languageCode || cur.langCode || cur.code || '').toLowerCase(),
        translationLanguage: readTranslationLanguage(cur).toLowerCase(),
        isTranslation: !!(cur.translationLanguage),
      };
    } catch (e) {
      console.log('[SubtitleMate] readCurrentState threw -> ' + (e && e.message));
      return null;
    }
  }

  // Scan the currently open subtitles panel for a selected (aria-checked) item
  // whose label matches the target language / mode. Used to avoid re-clicking.
  function panelHasSelectedMatch(panel, mode, targetLang) {
    if (!panel) return false;
    const items = Array.from(panel.querySelectorAll('.ytp-menuitem'));
    const want = (mode === 'translate') ? targetLanguageLabels(targetLang) : null;
    for (const item of items) {
      const checked = item.getAttribute('aria-checked') === 'true' ||
                      item.classList.contains('ytp-menuitem-active') ||
                      item.classList.contains('ytp-menuitem-checked');
      if (!checked) continue;
      const labelEl = item.querySelector('.ytp-menuitem-label') || item;
      const text = normalizeMenuText(labelEl.textContent);
      if (mode === 'auto-generated') {
        if (/english/.test(text) && /auto|asr/.test(text)) return true;
      } else if (want) {
        const exact = (want.exact || []).map(normalizeMenuText);
        const fallback = (want.fallback || []).map(normalizeMenuText);
        const exclude = (want.exclude || []).map(normalizeMenuText);
        if (exclude.some((e) => text.includes(e))) continue;
        if (exact.some((p) => text.includes(p)) || fallback.some((p) => text.includes(p))) {
          return true;
        }
      }
    }
    return false;
  }

  // Verify via DOM that the requested state is actually on screen.
  function isAlreadySatisfiedDom(mode, targetLang) {
    if (document.querySelectorAll('.ytp-caption-segment').length === 0) return false;
    // We can't read the translation language purely from DOM; open the panel
    // only to check is too costly, so rely on a quick API read instead.
    const st = readCurrentState();
    if (!st || !st.hasTrack) return false;
    if (mode === 'auto-generated') {
      return /english/.test(st.baseLang) && !st.isTranslation;
    }
    return st.translationLanguage === (targetLang || 'zh-CN').toLowerCase();
  }

  // ---------- main handler ----------

  async function handleApply(payload) {
    const mode = payload.mode;
    const targetLang = payload.targetLang || 'zh-CN';

    // 0) Early stop: if YouTube already satisfies the target, do nothing.
    if (isAlreadySatisfiedDom(mode, targetLang)) {
      console.log('[SubtitleMate] target already satisfied, skip applying');
      return { ok: true, info: 'already satisfied, no action needed' };
    }

    // Pure UI-based approach: simulate settings-button clicks. This is the
    // most stable method across YouTube builds (API paths change often).
    const uiOk = await applyViaUi(mode, targetLang);
    if (uiOk) {
      // Re-check: if target was already selected, the panel may have been
      // closed without changes but captions are still on — report success.
      return {
        ok: true,
        info: (mode === 'auto-generated' ? 'English (auto-generated)' : 'translated to ' + targetLang) + ' via UI',
      };
    }

    return { ok: false, info: 'UI approach failed' };
  }

  window.addEventListener('message', async (event) => {
    const data = event.data;
    if (!data || data.source !== 'subtitlemate-content') return;

    if (data.type === 'PING') {
      window.postMessage({ source: 'subtitlemate-bridge', type: 'PONG', id: data.id }, '*');
      return;
    }

    if (data.type === 'APPLY') {
      const result = await handleApply(data.payload || {});
      window.postMessage({
        source: 'subtitlemate-bridge',
        type: 'RESULT',
        id: data.id,
        payload: result,
      }, '*');
    }
  });

  // Notify the content script that the bridge is ready.
  window.postMessage({ source: 'subtitlemate-bridge', type: 'READY' }, '*');
})();
