const DEFAULTS = {
  enabled: true,
  port: 28473,
  token: '',
  minBytes: 0,
};

const SKIP_URL = /^(blob:|data:|chrome:|chrome-extension:|edge:|about:|file:|devtools:)/i;
const handingOff = new Set();

chrome.runtime.onInstalled.addListener(() => setup());
chrome.runtime.onStartup.addListener(() => setup());
setup();

chrome.alarms.create('idm-health', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'idm-health') checkHealth(true);
});

chrome.downloads.onCreated.addListener((item) => {
  captureDownload(item.id).catch((err) => console.error(err));
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const url = info.linkUrl || info.srcUrl;
  if (!url) return;
  sendToApp({
    url,
    referrer: info.pageUrl || tab?.url || '',
    filename: '',
  }).catch((err) => console.error(err));
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'status') {
    checkHealth(true).then((health) => getConfig().then((cfg) => sendResponse({ health, cfg })));
    return true;
  }
  if (message?.type === 'save') {
    chrome.storage.local.set(message.settings || {}).then(() => {
      checkHealth(true).then((health) => sendResponse({ health }));
    });
    return true;
  }
  return false;
});

function setup() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'idm-link',
      title: 'Download link with IDM Clone',
      contexts: ['link'],
    });
    chrome.contextMenus.create({
      id: 'idm-media',
      title: 'Download with IDM Clone',
      contexts: ['image', 'video', 'audio'],
    });
  });
  checkHealth(true);
}

async function getConfig() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

async function checkHealth(force) {
  const cfg = await getConfig();
  const now = Date.now();
  if (!force && checkHealth.cache && now - checkHealth.cache.at < 4000) {
    return checkHealth.cache;
  }
  const health = { app: false, auth: false, at: now };
  try {
    const res = await fetch(`http://127.0.0.1:${cfg.port}/api/health`, { cache: 'no-store' });
    health.app = res.ok;
    if (health.app && cfg.token) {
      const auth = await fetch(`http://127.0.0.1:${cfg.port}/api/auth-check`, {
        cache: 'no-store',
        headers: { 'X-IDM-Token': cfg.token },
      });
      health.auth = auth.ok;
    }
  } catch {
    health.app = false;
  }
  checkHealth.cache = health;
  paintBadge(cfg, health);
  return health;
}

function paintBadge(cfg, health) {
  if (!cfg.enabled) {
    chrome.action.setBadgeText({ text: 'OFF' });
    chrome.action.setBadgeBackgroundColor({ color: '#667085' });
    return;
  }
  if (health.auth) {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setBadgeBackgroundColor({ color: '#12b76a' });
    return;
  }
  chrome.action.setBadgeText({ text: '!' });
  chrome.action.setBadgeBackgroundColor({ color: '#d92d20' });
}

async function captureDownload(id) {
  if (handingOff.has(id)) return;
  handingOff.add(id);
  try {
    const cfg = await getConfig();
    if (!cfg.enabled || !cfg.token) return;
    const [item] = await chrome.downloads.search({ id });
    if (!item || item.state === 'complete') return;
    if (item.byExtensionId === chrome.runtime.id) return;
    const url = item.finalUrl || item.url || '';
    if (!/^https?:/i.test(url) || SKIP_URL.test(url)) return;
    if (item.totalBytes > 0 && cfg.minBytes > 0 && item.totalBytes < Number(cfg.minBytes)) return;

    const health = await checkHealth(true);
    if (!health.auth) return;

    const filename = item.filename ? item.filename.split(/[/\\]/).pop() : '';
    let cancelled = false;
    try {
      await chrome.downloads.cancel(id);
      cancelled = true;
    } catch {
      cancelled = false;
    }
    const [after] = await chrome.downloads.search({ id });
    if (after?.state === 'complete') return;
    if (!cancelled && after && after.state !== 'interrupted') return;

    const posted = await postDownload(cfg, {
      url,
      filename,
      referrer: item.referrer || '',
    });
    if (!posted) {
      await chrome.downloads.download({
        url,
        filename: filename || undefined,
        conflictAction: 'uniquify',
      });
      return;
    }
    try {
      await chrome.downloads.erase({ id });
    } catch {
      /* the shelf entry may already be gone */
    }
  } finally {
    handingOff.delete(id);
  }
}

async function sendToApp({ url, referrer, filename }) {
  if (!/^https?:/i.test(url)) {
    notify('IDM Clone can only download http and https links');
    return;
  }
  const cfg = await getConfig();
  if (!cfg.token) {
    notify('Paste the IDM Clone token into the extension first');
    return;
  }
  const health = await checkHealth(true);
  if (!health.app) {
    notify('Open the IDM Clone app, then try the download again');
    return;
  }
  if (!health.auth) {
    notify('The extension token does not match the app');
    return;
  }
  const ok = await postDownload(cfg, { url, referrer, filename });
  if (!ok) notify('IDM Clone could not start that download');
}

async function postDownload(cfg, { url, filename, referrer }) {
  const cookies = await chrome.cookies.getAll({ url });
  const cookie = cookies.map((item) => `${item.name}=${item.value}`).join('; ');
  const res = await fetch(`http://127.0.0.1:${cfg.port}/api/downloads`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-IDM-Token': cfg.token,
    },
    body: JSON.stringify({
      url,
      filename: filename || '',
      referrer: referrer || '',
      cookie,
      userAgent: navigator.userAgent,
      source: 'extension',
    }),
  });
  return res.ok;
}

function notify(message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'IDM Clone',
    message,
  });
}
