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
    // Long multilingual videos render the "Subtitles/CC" entry after a delay;
    // scroll through the panel to force all items into the DOM before matching.
    const scroller = panel.querySelector('.ytp-panel-menu') || panel;
    for (let i = 0; i < 4; i++) {
      scroller.scrollTop = scroller.scrollHeight;
      await sleep(150);
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

  // Scroll the panel so that any lazily-rendered menu items (auto-translate
  // often sits at the very bottom of a long multilingual list) become part of
  // the DOM, then look for the target item.
  async function selectSubtitlesMenuItem(patterns, maxMs = 3000) {
    const panel = await waitForSettingsPanel(maxMs);
    if (!panel) {
      console.log('[SubtitleMate] ui: subtitles panel did not appear');
      return false;
    }
    // The scrollable container is the panel itself or an inner .ytp-panel-menu.
    const scroller = panel.querySelector('.ytp-panel-menu') || panel;
    const deadline = Date.now() + maxMs;
    let item = findMenuItem(panel, patterns);
    while (!item && Date.now() < deadline) {
      // Nudge the scroll position to force YouTube to render more items.
      const before = scroller.scrollTop;
      scroller.scrollTop = scroller.scrollHeight; // jump to bottom first
      await sleep(200);
      if (scroller.scrollTop === before && scroller.scrollTop === 0 &&
          scroller.scrollHeight <= scroller.clientHeight) {
        // Nothing to scroll; bail out of the loop to avoid spinning forever.
        break;
      }
      // Also try stepping down to trigger mid-list rendering.
      scroller.scrollTop = before + scroller.clientHeight;
      await sleep(200);
      item = findMenuItem(panel, patterns);
    }
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
        exact:    ['chinese simplified', 'chinese china', 'chinese s', '中文简体', '中文中国', '中文（简体）', '中文（中国）', '简体中文', '简体'],
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
        // The target-language list can also be long; selectSubtitlesMenuItem
        // already scrolls, but nudge once more so the Chinese entry is present.
        const scroller2 = (panel2 && panel2.querySelector('.ytp-panel-menu')) || panel2;
        if (scroller2) {
          for (let i = 0; i < 4; i++) {
            scroller2.scrollTop = scroller2.scrollHeight;
            await sleep(150);
          }
        }
        const patterns = targetLanguageLabels(targetLang);
        if (await selectSubtitlesMenuItem(patterns, 4000)) {
          await sleep(800);
          const on = document.querySelectorAll('.ytp-caption-segment').length > 0;
          console.log('[SubtitleMate] ui: translate result segments=' + on);
          return on;
        }
        // If the Chinese entry still wasn't found, log what IS available so the
        // user can see the exact label YouTube uses for their locale.
        if (panel2) {
          console.log('[SubtitleMate] ui: target lang not found. labels=' +
            Array.from(panel2.querySelectorAll('.ytp-menuitem-label')).map((el) => el.textContent).join(' | '));
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

  // Full current state used by content script to decide whether to re-apply.
  function getCurrentState(payload) {
    const p = payload || {};
    const mode = p.mode || 'translate';
    const targetLang = p.targetLang || 'zh-CN';
    const panel = readPanelSatisfied(mode, targetLang);
    const player = getPlayer();
    if (!player || !canUseApi(player)) {
      return {
        ok: false,
        hasPlayer: false,
        panelSatisfied: panel.satisfied,
        panelText: panel.text,
      };
    }
    try {
      const cur = player.getOption('captions', 'track');
      const video = getVideo();
      const state = {
        ok: true,
        hasPlayer: true,
        hasTrack: !!(cur && (cur.languageCode || cur.langCode || cur.code)),
        baseLang: (cur && (cur.languageCode || cur.langCode || cur.code) || '').toLowerCase(),
        translationLanguage: readTranslationLanguage(cur).toLowerCase(),
        isTranslation: !!(cur && cur.translationLanguage),
        captionSegments: document.querySelectorAll('.ytp-caption-segment').length,
        panelSatisfied: panel.satisfied,
        panelText: panel.text,
      };
      if (video) state.playbackRate = Number(video.playbackRate) || 1;
      return state;
    } catch (e) {
      return {
        ok: false,
        hasPlayer: true,
        error: (e && e.message) || 'read failed',
        panelSatisfied: panel.satisfied,
        panelText: panel.text,
      };
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

  // Read the right-side text of the top-level "Subtitles/CC / 字幕" row in the
  // open settings menu. YouTube shows the current caption choice there (e.g.
  // "英语（自动生成）>> 中文（简体）"), so we can treat that as success.
  function readSubtitlesRowContent(panel) {
    if (!panel) return '';
    const items = Array.from(panel.querySelectorAll('.ytp-menuitem'));
    for (const item of items) {
      const labelEl = item.querySelector('.ytp-menuitem-label') || item;
      const labelText = normalizeMenuText(labelEl.textContent);
      if (/subtitles|cc|caption|字幕/.test(labelText)) {
        const contentEl = item.querySelector('.ytp-menuitem-content');
        return contentEl ? contentEl.textContent : item.textContent;
      }
    }
    return '';
  }

  function panelContentMatchesTarget(text, mode, targetLang) {
    const t = normalizeMenuText(text || '');
    if (!t || /off|关闭/.test(t)) return false;
    if (mode === 'auto-generated') {
      return /english|英语/.test(t) && /auto|自动|asr/.test(t) && !/>>|→|translat|翻译/.test(t);
    }
    const want = targetLanguageLabels(targetLang);
    const exact = (want.exact || []).map(normalizeMenuText);
    const fallback = (want.fallback || []).map(normalizeMenuText);
    const exclude = (want.exclude || []).map(normalizeMenuText);
    if (exclude.some((e) => t.includes(e))) return false;
    return exact.some((p) => t.includes(p)) || fallback.some((p) => t.includes(p));
  }

  function readPanelSatisfied(mode, targetLang) {
    const panel = getSettingsPanel();
    if (!panel) return { satisfied: false, text: '' };
    if (panelHasSelectedMatch(panel, mode, targetLang)) {
      return { satisfied: true, text: 'selected menu item matches target' };
    }
    const text = readSubtitlesRowContent(panel);
    if (panelContentMatchesTarget(text, mode, targetLang)) {
      return { satisfied: true, text: text };
    }
    return { satisfied: false, text: text };
  }

  // Verify via DOM that the requested state is actually on screen.
  function isAlreadySatisfiedDom(mode, targetLang) {
    const panelResult = readPanelSatisfied(mode, targetLang);
    if (panelResult.satisfied) return true;
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

  // ---------- player-API caption helpers ----------

  function listCaptionTracks(player) {
    if (!player || typeof player.getOption !== 'function') return [];
    try {
      const list = player.getOption('captions', 'tracklist');
      if (Array.isArray(list) && list.length) return list;
    } catch (e) {
      console.log('[SubtitleMate] api: getOption(tracklist) threw -> ' + (e && e.message));
    }
    return [];
  }

  function pickBaseTrack(tracks) {
    if (!tracks || !tracks.length) return null;
    const norm = (tr) => (tr.languageCode || tr.langCode || tr.code || '').toLowerCase();
    const isTranslation = (tr) => !!tr.translationLanguage;

    // Log the full tracklist so failures are diagnosable from the console.
    console.log('[SubtitleMate] tracklist (' + tracks.length + '): ' +
      tracks.map((tr) => norm(tr) + (tr.kind ? '/' + (tr.kind || '') : '') +
        (isTranslation(tr) ? '/translation-of-' + ((tr.translationLanguage && (tr.translationLanguage.languageCode || tr.translationLanguage.langCode)) || '?') : '')).join(', '));

    // 1) Preferred: English ASR (auto-generated) — exists on nearly all videos.
    let t = tracks.find((tr) =>
      norm(tr) === 'en' && (tr.kind || '').toLowerCase() === 'asr');
    if (t) return t;
    // 2) Any English base track (manual or ASR).
    t = tracks.find((tr) => norm(tr) === 'en');
    if (t) return t;
    // 3) On multilingual videos the UI "auto-translate" needs a non-translation
    //    base track.  Prefer any ASR track regardless of language.
    t = tracks.find((tr) => (tr.kind || '').toLowerCase() === 'asr' && !isTranslation(tr));
    if (t) return t;
    // 4) Any non-translation track (the base tier, not an already-translated one).
    t = tracks.find((tr) => !isTranslation(tr));
    if (t) return t;
    // 5) Last resort: first available.
    return tracks[0];
  }

  function buildTrackForMode(baseTrack, mode, targetLang) {
    if (!baseTrack) return null;
    const track = { ...baseTrack };
    if (mode === 'translate') {
      track.translationLanguage = { languageCode: targetLang || 'zh-CN' };
    } else {
      delete track.translationLanguage;
    }
    return track;
  }

  async function applyViaApi(mode, targetLang) {
    const player = await waitForPlayer(10000);
    if (!player) {
      console.log('[SubtitleMate] api: no player found');
      return false;
    }
    const tracks = listCaptionTracks(player);
    if (!tracks.length) {
      console.log('[SubtitleMate] api: no caption tracks available yet');
      return false;
    }
    const baseTrack = pickBaseTrack(tracks);
    if (!baseTrack) {
      console.log('[SubtitleMate] api: could not pick a base track');
      return false;
    }
    const track = buildTrackForMode(baseTrack, mode, targetLang);
    if (!track) return false;

    const applySetOption = async () => {
      try {
        player.setOption('captions', 'track', track);
        console.log('[SubtitleMate] api: setOption track -> ' +
          (track.languageCode || '?') + ' translation=' + (track.translationLanguage?.languageCode || 'none'));
        return true;
      } catch (e) {
        console.log('[SubtitleMate] api: setOption threw -> ' + (e && e.message));
        return false;
      }
    };

    // Some YouTube builds silently discard the first setOption call (the caption
    // module is still initializing).  Issue it, verify, and if the read-back
    // doesn't reflect our request, retry once before giving up.
    if (!(await applySetOption())) return false;

    const verify = () => {
      try {
        const cur = player.getOption('captions', 'track');
        const curTl = readTranslationLanguage(cur).toLowerCase();
        const curBase = (cur && (cur.languageCode || cur.langCode || cur.code || '')).toLowerCase();
        const domSegments = document.querySelectorAll('.ytp-caption-segment').length;
        const apiOk =
          (mode === 'translate' && curTl === (targetLang || 'zh-CN').toLowerCase()) ||
          (mode === 'auto-generated' && /en/.test(curBase) && !curTl);
        return { apiOk, domSegments, curBase, curTl };
      } catch (e) {
        console.log('[SubtitleMate] api: verify threw -> ' + (e && e.message));
        return { apiOk: false, domSegments: 0, curBase: '', curTl: '' };
      }
    };

    // YouTube requests the translated subtitle stream from the server after the
    // track is set; that network round-trip takes time.  Give it room to settle
    // before verifying, otherwise we falsely report failure and retry forever.
    const settleMs = (mode === 'translate') ? 2800 : 1000;
    await sleep(settleMs);

    let v = verify();
    if (!v.apiOk) {
      // First attempt didn't stick — retry the setOption once and re-verify.
      console.log('[SubtitleMate] api: first verify not satisfied (base=' + v.curBase +
        ' tl=' + v.curTl + '), retrying setOption once');
      await applySetOption();
      await sleep(settleMs);
      v = verify();
    }

    const ok = v.apiOk || v.domSegments > 0;
    console.log('[SubtitleMate] api: verify segments=' + v.domSegments + ' base=' + v.curBase +
      ' tl=' + v.curTl + ' apiOk=' + v.apiOk + ' ok=' + ok);
    return ok;
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

    // 1) Try the player API first (non-invasive, most reliable).
    const apiOk = await applyViaApi(mode, targetLang);
    if (apiOk) {
      return {
        ok: true,
        info: (mode === 'auto-generated' ? 'English (auto-generated)' : 'translated to ' + targetLang) + ' via API',
      };
    }

    // 2) Fallback to UI simulation if the API path is unavailable.
    console.log('[SubtitleMate] api failed, falling back to UI');
    const uiOk = await applyViaUi(mode, targetLang);
    if (uiOk) {
      return {
        ok: true,
        info: (mode === 'auto-generated' ? 'English (auto-generated)' : 'translated to ' + targetLang) + ' via UI',
      };
    }

    return { ok: false, info: 'API and UI approaches both failed' };
  }

  // Set the video playback rate. Tries the player API first (so the YouTube
  // speed menu stays in sync), then falls back to the raw <video> element.
  async function handleSetPlaybackRate(payload) {
    const rate = Number(payload && payload.rate);
    if (!rate || rate <= 0) {
      return { ok: false, info: 'invalid rate: ' + rate };
    }

    const video = getVideo();
    if (!video) {
      return { ok: false, info: 'no <video> element found' };
    }

    // Primary: drive through the player API when available so YouTube's own
    // speed menu reflects the change.
    const player = getPlayer();
    if (player && canUseApi(player)) {
      try {
        if (typeof player.setPlaybackRate === 'function') {
          player.setPlaybackRate(rate);
        }
      } catch (e) {
        console.log('[SubtitleMate] setPlaybackRate via API threw -> ' + (e && e.message));
      }
    }

    // Always also set it directly on the element; this is what actually
    // changes playback and works even when the API path is unavailable.
    try {
      video.playbackRate = rate;
    } catch (e) {
      return { ok: false, info: 'failed to set video.playbackRate: ' + (e && e.message) };
    }

    // Wait a tick and read back to verify.
    await sleep(150);
    const actual = video.playbackRate;
    const ok = Math.abs(actual - rate) < 0.01;
    console.log('[SubtitleMate] playbackRate set -> requested=' + rate + ' actual=' + actual + ' ok=' + ok);
    return {
      ok,
      info: ok ? ('playbackRate set to ' + rate) : ('requested ' + rate + ' but actual ' + actual),
    };
  }

  window.addEventListener('message', async (event) => {
    const data = event.data;
    if (!data || data.source !== 'subtitlemate-content') return;

    if (data.type === 'PING') {
      window.postMessage({ source: 'subtitlemate-bridge', type: 'PONG', id: data.id }, '*');
      return;
    }

    if (data.type === 'SET_PLAYBACK_RATE') {
      const result = await handleSetPlaybackRate(data.payload || {});
      window.postMessage({
        source: 'subtitlemate-bridge',
        type: 'RESULT',
        id: data.id,
        payload: result,
      }, '*');
      return;
    }

    if (data.type === 'GET_STATE') {
      const result = getCurrentState(data.payload || {});
      window.postMessage({
        source: 'subtitlemate-bridge',
        type: 'RESULT',
        id: data.id,
        payload: result,
      }, '*');
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
