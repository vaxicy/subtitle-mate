(function () {
  const { STORAGE_KEYS, LANGUAGES, I18N, getSettings, setSettings, getCurrentUiLang, setCurrentUiLang } = window.SM;

  let uiLang = getCurrentUiLang();
  let settings = null;

  const $ = (id) => document.getElementById(id);

  function t(key) { return I18N[uiLang][key]; }

  function fillLangOptions(select, selectedCode) {
    select.innerHTML = '';
    for (const lang of LANGUAGES) {
      const opt = document.createElement('option');
      opt.value = lang.code;
      opt.textContent = uiLang === 'zh' ? lang.zh : lang.en;
      if (lang.code === selectedCode) opt.selected = true;
      select.appendChild(opt);
    }
  }

  function applyUI() {
    const i18n = I18N[uiLang];
    $('extName').textContent = i18n.name;
    $('lblAutoCaptions').textContent = i18n.autoCaptions;
    $('lblTranslationLang').textContent = i18n.translationLang;
    $('lblTargetLang').textContent = i18n.targetLang;
    $('lblRemember').textContent = i18n.remember;
    $('lblAutoYt').textContent = i18n.autoOnYt;
    document.documentElement.lang = uiLang === 'zh' ? 'zh-CN' : 'en';

    const toggle = $('toggleAuto');
    toggle.setAttribute('aria-checked', String(settings[STORAGE_KEYS.AUTO_CAPTIONS]));

    fillLangOptions($('sourceLang'), settings[STORAGE_KEYS.SOURCE_LANG]);
    fillLangOptions($('targetLang'), settings[STORAGE_KEYS.TARGET_LANG]);
    $('chkRemember').checked = settings[STORAGE_KEYS.REMEMBER_LANG];
    $('chkAutoYt').checked = settings[STORAGE_KEYS.AUTO_ON_YT];
  }

  async function save(patch) {
    Object.assign(settings, patch);
    await setSettings(patch);
    const hint = $('savedHint');
    hint.textContent = t('saved');
    hint.classList.add('show');
    setTimeout(() => hint.classList.remove('show'), 1400);
    // Notify content scripts about the change.
    chrome.runtime.sendMessage({ type: 'SM_SETTINGS_CHANGED', settings }).catch(() => {});
  }

  function bindEvents() {
    $('toggleAuto').addEventListener('click', () => {
      const next = !settings[STORAGE_KEYS.AUTO_CAPTIONS];
      save({ [STORAGE_KEYS.AUTO_CAPTIONS]: next });
      applyUI();
    });

    $('sourceLang').addEventListener('change', (e) =>
      save({ [STORAGE_KEYS.SOURCE_LANG]: e.target.value }));

    $('targetLang').addEventListener('change', (e) =>
      save({ [STORAGE_KEYS.TARGET_LANG]: e.target.value }));

    $('chkRemember').addEventListener('change', (e) =>
      save({ [STORAGE_KEYS.REMEMBER_LANG]: e.target.checked }));

    $('chkAutoYt').addEventListener('change', (e) =>
      save({ [STORAGE_KEYS.AUTO_ON_YT]: e.target.checked }));

    $('langSwitch').addEventListener('click', () => {
      uiLang = uiLang === 'en' ? 'zh' : 'en';
      setCurrentUiLang(uiLang);
      applyUI();
    });
  }

  async function init() {
    settings = await getSettings();
    $('logo').src = chrome.runtime.getURL('icons/icon48.png');
    bindEvents();
    applyUI();
  }

  init();
})();
