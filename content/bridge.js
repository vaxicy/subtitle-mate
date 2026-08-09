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

  async function waitForPlayer(maxMs = 8000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const p = getPlayer();
      if (p) return p;
      await sleep(400);
    }
    return null;
  }

  function getTracklist(player) {
    try {
      const list = player.getOption('captions', 'tracklist');
      return Array.isArray(list) ? list : [];
    } catch (_) {
      return [];
    }
  }

  function trackId(t) {
    return t.languageCode || t.langCode || t.code;
  }

  function pickBaseTracks(player) {
    const list = getTracklist(player);
    if (!list.length) return [];

    const score = (t) => {
      const isTranslation = !!t.translationLanguage ||
        /翻译|translat/i.test(t.displayName || t.name || '');
      let s = isTranslation ? -100 : 0;
      const lc = (t.languageCode || t.langCode || t.code || '').toLowerCase();
      if (lc === 'en') s += 50;
      if (t.kind === 'asr' || /auto|asr/i.test(t.displayName || t.name || '')) s += 20;
      return s;
    };

    return list
      .filter((t) => !t.translationLanguage)
      .slice()
      .sort((a, b) => score(b) - score(a));
  }

  function enableCaptionsApi(player) {
    if (!player) return;
    try {
      if (typeof player.updateSubtitleUserConfig === 'function') {
        player.updateSubtitleUserConfig({ kind: 'PLAYBACK', enable: true });
      }
    } catch (_) {}
  }

  function verifyCaptionsOn(player) {
    try {
      const cur = player.getOption('captions', 'track');
      if (cur) return true;
    } catch (_) {}
    return document.querySelectorAll('.ytp-caption-segment').length > 0;
  }

  function verifyTranslateApplied(player, targetCode) {
    try {
      const cur = player.getOption('captions', 'track');
      const tl = cur && cur.translationLanguage;
      const got = (tl && (tl.languageCode || tl.langCode || '') || '').toLowerCase();
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
    const bases = pickBaseTracks(player);
    if (!bases.length) {
      console.log('[SubtitleMate] translate: no base track available');
      return false;
    }

    console.log('[SubtitleMate] translate: tracklist = ' +
      JSON.stringify(getTracklist(player).map((t) => ({
        lc: t.languageCode || t.langCode || t.code,
        kind: t.kind,
        name: t.displayName || t.name,
        isTl: !!t.translationLanguage,
      }))));

    for (const base of bases) {
      try {
        const id = trackId(base);
        if (!id) continue;
        const select = { ...base, translationLanguage: { languageCode: targetCode } };
        console.log('[SubtitleMate] translate: setOption track = ' +
          JSON.stringify({ lc: id, kind: base.kind, target: targetCode }));
        player.setOption('captions', 'track', select);
        await sleep(300);
        if (verifyTranslateApplied(player, targetCode)) {
          console.log('[SubtitleMate] translate: confirmed base=' + id + ' -> ' + targetCode);
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
    const bases = pickBaseTracks(player);
    const en = bases.find((b) => {
      const lc = (trackId(b) || '').toLowerCase();
      return lc === 'en' || /english/i.test(b.displayName || b.name || '');
    }) || bases[0];
    if (!en) return false;
    try {
      const id = trackId(en);
      if (!id) return false;
      // Use the full original track object to keep required fields.
      player.setOption('captions', 'track', { ...en });
      await sleep(300);
      return verifyCaptionsOn(player);
    } catch (e) {
      console.log('[SubtitleMate] auto-generated: setOption threw -> ' + (e && e.message));
      return false;
    }
  }

  async function handleApply(payload) {
    const mode = payload.mode;
    const targetLang = payload.targetLang || 'zh-CN';

    const player = getPlayer() || (await waitForPlayer(8000));
    if (!player) {
      return { ok: false, info: 'player not found after wait' };
    }

    enableCaptionsApi(player);

    if (mode === 'auto-generated') {
      const ok = await applyAutoGeneratedViaApi(player);
      return { ok, info: ok ? 'English (auto-generated) enabled' : 'auto-generated API failed' };
    }

    const ok = await applyTranslateViaApi(player, targetLang);
    return { ok, info: ok ? 'translated to ' + targetLang : 'translate API failed' };
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
