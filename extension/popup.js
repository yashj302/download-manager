const status = document.getElementById('status');
const message = document.getElementById('message');

function paint(health) {
  status.classList.remove('ok', 'bad');
  if (health?.auth) {
    status.textContent = 'Connected to IDM Clone';
    status.classList.add('ok');
    return;
  }
  status.classList.add('bad');
  if (health?.app) status.textContent = 'App is open, but the token does not match';
  else status.textContent = 'App is not running';
}

chrome.runtime.sendMessage({ type: 'status' }, (response) => {
  const cfg = response?.cfg || {};
  document.getElementById('enabled').checked = cfg.enabled !== false;
  document.getElementById('port').value = cfg.port || 28473;
  document.getElementById('token').value = cfg.token || '';
  document.getElementById('minBytes').value = String(cfg.minBytes || 0);
  paint(response?.health);
});

document.getElementById('save').addEventListener('click', () => {
  const settings = {
    enabled: document.getElementById('enabled').checked,
    port: Number(document.getElementById('port').value) || 28473,
    token: document.getElementById('token').value.trim(),
    minBytes: Number(document.getElementById('minBytes').value) || 0,
  };
  chrome.runtime.sendMessage({ type: 'save', settings }, (response) => {
    paint(response?.health);
    if (response?.health?.auth) message.textContent = 'Downloads will be sent to the app.';
    else if (!settings.token) message.textContent = 'Paste the token from IDM Clone settings.';
    else if (response?.health?.app) message.textContent = 'Check that the token and port match the app.';
    else message.textContent = 'Start IDM Clone, then test again.';
  });
});
