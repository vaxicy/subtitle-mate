// SubtitleMate background service worker.
// Keeps storage in sync and acts as a relay for settings changes to content scripts.

chrome.runtime.onInstalled.addListener(async () => {
  const defs = {
    sm_autoCaptions: true,
    sm_captionMode: 'translate',
    sm_targetLang: 'zh-CN',
    sm_rememberLang: true,
    sm_autoOnYt: true,
  };
  const existing = await chrome.storage.sync.get(Object.keys(defs));
  const toSet = {};
  for (const k of Object.keys(defs)) {
    if (existing[k] === undefined) toSet[k] = defs[k];
  }
  if (Object.keys(toSet).length) await chrome.storage.sync.set(toSet);
});

// Relay settings changes to all YouTube tabs so captions update instantly.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'SM_SETTINGS_CHANGED') {
    chrome.tabs.query({ url: 'https://www.youtube.com/*' }, (tabs) => {
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
      }
    });
  }
});
