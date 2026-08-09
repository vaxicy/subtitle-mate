(function () {
  const I18N = {
    en: {
      title: 'Support SubtitleMate',
      wechatNote: 'Scan with WeChat to send a reward.',
      paypalBtn: 'Pay with PayPal',
    },
    zh: {
      title: '支持 SubtitleMate',
      wechatNote: '用微信扫一扫，赞赏开发者。',
      paypalBtn: '用 PayPal 付款',
    },
  };

  async function detectLang() {
    try {
      const res = await chrome.storage.sync.get('sm_uiLang');
      const fromSync = res && res.sm_uiLang;
      if (fromSync === 'en' || fromSync === 'zh') return fromSync;
    } catch (e) {}
    try {
      const params = new URL(window.location.href).searchParams;
      const fromUrl = params.get('lang');
      if (fromUrl === 'en' || fromUrl === 'zh') return fromUrl;
    } catch (e) {}
    const stored = localStorage.getItem('sm_uiLang');
    if (stored === 'en' || stored === 'zh') return stored;
    const nav = (navigator.language || 'en').toLowerCase();
    return nav.startsWith('zh') ? 'zh' : 'en';
  }

  (async function () {
    const lang = await detectLang();
    const t = I18N[lang];
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    document.getElementById('title').textContent = t.title;
    document.getElementById('wechatNote').textContent = t.wechatNote;
    document.getElementById('paypalBtn').textContent = t.paypalBtn;
  })();
})();
