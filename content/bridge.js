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

  function isRealPlayer(p) {
    return isValidPlayer(p) && !(p instanceof HTMLElement);
  }

  async function waitForPlayer(maxMs = 15000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const p = getPlayer();
      if (p) return p;
      await sleep(400);
    }
    return null;
  }

  function normalizeTrack(raw) {
    if (!raw) return null;
    const nameObj = raw.name || raw.displayName;
    const nameText = typeof nameObj === 'string' ? nameObj : (nameObj && nameObj.simpleText) || '';
    return {
      languageCode: raw.languageCode || raw.langCode || raw.code || '',
      vssId: raw.vssId || raw.vss_id || '',
      kind: raw.kind || '',
      name: { simpleText: nameText },
      displayName: nameText,
      baseUrl: raw.baseUrl || raw.base_url || '',
      isTranslatable: !!raw.isTranslatable,
      translationLanguage: raw.translationLanguage || null,
    };
  }

  function toArray(x) {
    if (Array.isArray(x)) return x;
    if (x && typeof x.length === 'number') {
      try { return Array.prototype.slice.call(x); } catch (_) {}
    }
    return [];
  }

  function getTracklist(player) {
    try {
      const raw = player.getOption('captions', 'tracklist');
      const list = toArray(raw);
      if (list.length) return list.map(normalizeTrack).filter(Boolean);
    } catch (e) {
      console.log('[SubtitleMate] getOption(captions,tracklist) threw -> ' + (e && e.message));
    }
    return [];
  }

  function getTracklistFromPlayerResponse(player) {
    try {
      let response = null;
      if (typeof player.getPlayerResponse === 'function') {
        response = player.getPlayerResponse();
      }
      if (!response && window.ytInitialPlayerResponse) {
        response = window.ytInitialPlayerResponse;
      }
      if (!response && window.ytplayer && window.ytplayer.config && window.ytplayer.config.args) {
        response = window.ytplayer.config.args.raw_player_response;
      }
      const tracks = response && response.captions && response.captions.captionTracks;
      const list = toArray(tracks);
      if (list.length) {
        console.log('[SubtitleMate] tracklist from player response: ' + list.length);
        return list.map(normalizeTrack).filter(Boolean);
      }
    } catch (e) {
      console.log('[SubtitleMate] getTracklistFromPlayerResponse threw -> ' + (e && e.message));
    }
    return [];
  }

  async function waitForTracklist(player, maxMs = 10000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const fromPlayer = getTracklist(player);
      if (fromPlayer.length) {
        console.log('[SubtitleMate] waitForTracklist: got ' + fromPlayer.length + ' from player API');
        return fromPlayer;
      }
      const fromResponse = getTracklistFromPlayerResponse(player);
      if (fromResponse.length) {
        console.log('[SubtitleMate] waitForTracklist: got ' + fromResponse.length + ' from player response');
        return fromResponse;
      }
      await sleep(400);
    }
    console.log('[SubtitleMate] waitForTracklist: timeout');
    return [];
  }

  function trackId(t) {
    return t.languageCode || t.langCode || t.code;
  }

  function pickBaseTracks(list) {
    if (!list || !list.length) return [];

    const score = (t) => {
      const isTranslation = !!t.translationLanguage ||
        /翻译|translat/i.test(t.displayName || '');
      let s = isTranslation ? -100 : 0;
      const lc = (t.languageCode || '').toLowerCase();
      if (lc === 'en') s += 50;
      if (t.kind === 'asr' || /auto|asr/i.test(t.displayName || '')) s += 20;
      return s;
    };

    return list
      .filter((t) => !t.translationLanguage)
      .slice()
      .sort((a, b) => score(b) - score(a));
  }

  function loadCaptionsModule(player) {
    if (!player) return;
    try {
      if (typeof player.loadModule === 'function') player.loadModule('captions');
    } catch (_) {}
    try {
      if (typeof player.loadModule === 'function') player.loadModule('captionsUI');
    } catch (_) {}
  }

  function enableCaptionsApi(player) {
    if (!player) return;
    loadCaptionsModule(player);
    try {
      if (typeof player.updateSubtitleUserConfig === 'function') {
        player.updateSubtitleUserConfig({ kind: 'PLAYBACK', enable: true });
      }
    } catch (_) {}
    try {
      player.setOption('captions', 'reload', true);
    } catch (_) {}
  }

  function verifyCaptionsOn(player) {
    try {
      const cur = player.getOption('captions', 'track');
      if (cur) return true;
    } catch (_) {}
    return document.querySelectorAll('.ytp-caption-segment').length > 0;
  }

  function readTranslationLanguage(cur) {
    if (!cur || !cur.translationLanguage) return '';
    const tl = cur.translationLanguage;
    if (typeof tl === 'string') return tl;
    return tl.languageCode || tl.langCode || tl.code || '';
  }

  function verifyTranslateApplied(player, targetCode) {
    try {
      const cur = player.getOption('captions', 'track');
      const got = readTranslationLanguage(cur).toLowerCase();
      const segments = document.querySelectorAll('.ytp-caption-segment').length > 0;
      console.log('[SubtitleMate] verify: track.lang=' + (cur && (cur.languageCode || cur.langCode || '')) +
        ' translationLanguage=' + got + ' want=' + targetCode + ' segments=' + segments);
      if (got === targetCode.toLowerCase() && segments) return true;
    } catch (e) {
      console.log('[SubtitleMate] verify: getOption threw -> ' + (e && e.message));
    }
    return false;
  }

  async function applyTranslateViaApi(player, targetCode) {
    const allTracks = await waitForTracklist(player, 10000);
    const bases = pickBaseTracks(allTracks);
    if (!bases.length) {
      console.log('[SubtitleMate] translate: no base track available after wait. raw count=' + allTracks.length);
      return false;
    }

    console.log('[SubtitleMate] translate: tracklist = ' +
      JSON.stringify(allTracks.map((t) => ({
        lc: t.languageCode,
        kind: t.kind,
        name: t.displayName,
        isTl: !!t.translationLanguage,
      }))));

    for (const base of bases) {
      try {
        const id = trackId(base);
        if (!id) continue;
        // YouTube expects translationLanguage as a string code on some builds,
        // and as an object on others. Try both shapes.
        const selectObj = { ...base, translationLanguage: { languageCode: targetCode } };
        const selectStr = { ...base, translationLanguage: targetCode };
        console.log('[SubtitleMate] translate: setOption track = ' +
          JSON.stringify({ lc: id, kind: base.kind, target: targetCode }));
        player.setOption('captions', 'track', selectObj);
        await sleep(400);
        if (verifyTranslateApplied(player, targetCode)) {
          console.log('[SubtitleMate] translate: confirmed (obj) base=' + id + ' -> ' + targetCode);
          return true;
        }
        player.setOption('captions', 'track', selectStr);
        await sleep(400);
        if (verifyTranslateApplied(player, targetCode)) {
          console.log('[SubtitleMate] translate: confirmed (str) base=' + id + ' -> ' + targetCode);
          return true;
        }
        console.log('[SubtitleMate] translate: base=' + id + ' did not apply, trying next');
      } catch (e) {
        console.log('[SubtitleMate] translate: setOption threw -> ' + (e && e.message));
      }
    }
    return false;
  }

  async function applyAutoGeneratedViaApi(player) {
    const allTracks = await waitForTracklist(player, 10000);
    const bases = pickBaseTracks(allTracks);
    const en = bases.find((b) => {
      const lc = (trackId(b) || '').toLowerCase();
      return lc === 'en' || /english/i.test(b.displayName || '');
    }) || bases[0];
    if (!en) {
      console.log('[SubtitleMate] auto-generated: no base track after wait. raw count=' + allTracks.length);
      return false;
    }
    try {
      const id = trackId(en);
      if (!id) return false;
      // Use the full original track object to keep required fields.
      player.setOption('captions', 'track', { ...en });
      await sleep(400);
      if (verifyCaptionsOn(player)) return true;
      // Some builds also need an explicit enable flag.
      try { player.setOption('captions', 'enable', true); } catch (_) {}
      await sleep(300);
      return verifyCaptionsOn(player);
    } catch (e) {
      console.log('[SubtitleMate] auto-generated: setOption threw -> ' + (e && e.message));
      return false;
    }
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

  function findMenuItem(panel, patterns) {
    if (!panel) return null;
    const items = panel.querySelectorAll('.ytp-menuitem');
    for (const item of items) {
      const labelEl = item.querySelector('.ytp-menuitem-label') || item;
      const text = (labelEl.textContent || '').toLowerCase().replace(/[()（）]/g, '');
      for (const pat of patterns) {
        const p = pat.toLowerCase().replace(/[()（）]/g, '');
        if (text.includes(p)) return item;
      }
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
      closeSettingsPanel();
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
      'zh-CN': ['chinese simplified', 'chinese china', '中文简体', '中文中国', '简体中文', '中文'],
      'zh-TW': ['chinese traditional', '中文繁體', '繁体中文', '中文'],
      'ja':    ['japanese', '日语', '日本語'],
      'ko':    ['korean', '韩语', '韓語', '한국어'],
      'es':    ['spanish', '西班牙语', '西班牙文'],
      'fr':    ['french', '法语', '法文', 'français'],
      'de':    ['german', '德语', '德文', 'deutsch'],
      'ru':    ['russian', '俄语', '俄文', 'русский'],
      'pt':    ['portuguese', '葡萄牙语', 'português'],
      'en':    ['english', '英语', '英文'],
    };
    return map[code] || [code];
  }

  async function applyViaUi(mode, targetLang) {
    const ok = await openSubtitlesMenu();
    if (!ok) {
      // If settings menu didn't open, try direct CC button as last resort.
      if (clickCcButtonIfPresent()) {
        await sleep(1000);
        return document.querySelectorAll('.ytp-caption-segment').length > 0;
      }
      return false;
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
      const patterns = targetLanguageLabels(targetLang);
      if (await selectSubtitlesMenuItem(patterns, 3000)) {
        await sleep(800);
        const on = document.querySelectorAll('.ytp-caption-segment').length > 0;
        console.log('[SubtitleMate] ui: translate result segments=' + on);
        return on;
      }
    }
    return false;
  }

  // ---------- main handler ----------

  async function handleApply(payload) {
    const mode = payload.mode;
    const targetLang = payload.targetLang || 'zh-CN';

    // Try real player API first.
    const player = getPlayer() || (await waitForPlayer(15000));
    if (player && isRealPlayer(player)) {
      enableCaptionsApi(player);

      if (mode === 'auto-generated') {
        const ok = await applyAutoGeneratedViaApi(player);
        if (ok) return { ok: true, info: 'English (auto-generated) enabled via API' };
      } else {
        const ok = await applyTranslateViaApi(player, targetLang);
        if (ok) return { ok: true, info: 'translated to ' + targetLang + ' via API' };
      }
      console.log('[SubtitleMate] API approach failed, trying UI fallback');
    } else if (player) {
      console.log('[SubtitleMate] player is only a DOM element, skipping API and using UI fallback');
    } else {
      console.log('[SubtitleMate] player not found after wait, trying UI fallback');
    }

    // Pure DOM-based fallback: simulate settings-button clicks.
    const uiOk = await applyViaUi(mode, targetLang);
    if (uiOk) {
      return {
        ok: true,
        info: (mode === 'auto-generated' ? 'English (auto-generated)' : 'translated to ' + targetLang) + ' via UI',
      };
    }

    return { ok: false, info: 'all approaches failed (API + UI)' };
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
