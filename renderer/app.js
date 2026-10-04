const TITLES = {
  all: 'All downloads',
  downloading: 'Downloading',
  queued: 'Queued',
  paused: 'Paused',
  completed: 'Completed',
  error: 'Failed',
  video: 'Video',
  music: 'Music',
  programs: 'Programs',
  archives: 'Archives',
  documents: 'Documents',
  images: 'Images',
  other: 'Other',
  settings: 'Settings',
};

const CATEGORIES = ['video', 'music', 'programs', 'archives', 'documents', 'images', 'other'];

let state = { tasks: [], settings: {}, server: {}, extensionPath: '', version: '1.0.0' };
let filter = 'all';
let selectedId = null;
let toastTimer = null;

const $ = (id) => document.getElementById(id);

document.querySelectorAll('[data-filter]').forEach((button) => {
  button.addEventListener('click', () => setFilter(button.dataset.filter));
});

$('addBtn').addEventListener('click', openAdd);
$('pauseAllBtn').addEventListener('click', () => run(() => window.idm.pauseAll()));
$('resumeAllBtn').addEventListener('click', () => run(() => window.idm.resumeAll()));
$('clearBtn').addEventListener('click', () => run(() => window.idm.clearCompleted()));
$('search').addEventListener('input', render);
$('addForm').addEventListener('submit', submitAdd);
$('settingsForm').addEventListener('submit', saveSettings);
$('browseBtn').addEventListener('click', browseFolder);
$('copyPathBtn').addEventListener('click', () => copyText($('extensionPath').value));
$('copyTokenBtn').addEventListener('click', () => copyText($('token').value));
$('openExtBtn').addEventListener('click', () => window.idm.openExtension());
$('regenBtn').addEventListener('click', regenerateToken);
$('list').addEventListener('click', onListClick);
$('list').addEventListener('dblclick', onListDoubleClick);
$('detail').addEventListener('click', onDetailClick);

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
    event.preventDefault();
    openAdd();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    setFilter('all');
    $('search').focus();
  }
});

window.idm.onUpdate((next) => {
  state = next;
  render();
});

window.idm.getState().then((next) => {
  state = next;
  fillSettings();
  render();
});

function setFilter(next) {
  filter = next;
  document.querySelectorAll('[data-filter]').forEach((button) => {
    button.classList.toggle('active', button.dataset.filter === filter);
  });
  const settings = filter === 'settings';
  $('app').classList.toggle('settings-open', settings);
  $('listView').hidden = settings;
  $('settingsView').hidden = !settings;
  if (settings) fillSettings();
  render();
}

function visibleTasks() {
  const q = $('search').value.trim().toLowerCase();
  return state.tasks
    .filter((task) => {
      if (filter === 'settings') return false;
      if (CATEGORIES.includes(filter)) return task.category === filter;
      if (filter !== 'all' && task.status !== filter) return false;
      if (!q) return true;
      return `${task.filename} ${task.url}`.toLowerCase().includes(q);
    })
    .sort((a, b) => rank(a) - rank(b) || b.createdAt - a.createdAt);
}

function rank(task) {
  return { downloading: 0, queued: 1, paused: 2, error: 3, completed: 4, cancelled: 5 }[task.status] ?? 6;
}

function render() {
  renderNavCounts();
  renderServer();
  if (filter === 'settings') {
    const hint = $('serverHint');
    if (document.activeElement !== $('port')) hint.textContent = serverText();
    return;
  }
  const tasks = visibleTasks();
  const active = state.tasks.filter((task) => task.status === 'downloading');
  const speed = active.reduce((sum, task) => sum + (task.speed || 0), 0);
  $('viewTitle').textContent = TITLES[filter] || 'Downloads';
  $('viewStats').textContent = active.length
    ? `${active.length} active · ${formatSpeed(speed)}`
    : `${state.tasks.length} in the list`;

  if (!tasks.length) {
    $('list').innerHTML = `<div class="empty"><strong>${state.tasks.length ? 'Nothing in this view' : 'No downloads yet'}</strong>${state.tasks.length ? 'Try another filter or clear the search.' : 'Add a URL, or load the browser extension and download a file.'}</div>`;
  } else {
    $('list').innerHTML = tasks.map(renderRow).join('');
  }
  renderDetail();
}

function renderNavCounts() {
  document.querySelectorAll('[data-filter]').forEach((button) => {
    const key = button.dataset.filter;
    if (key === 'settings') return;
    const count = state.tasks.filter((task) => {
      if (CATEGORIES.includes(key)) return task.category === key;
      if (key === 'all') return true;
      return task.status === key;
    }).length;
    const label = TITLES[key];
    button.textContent = count ? `${label}  ${count}` : label;
  });
}

function renderRow(task) {
  const pct = percent(task);
  const barClass = task.status === 'downloading' && pct == null ? 'bar indeterminate' : 'bar';
  const width = pct == null ? 0 : pct;
  return `<article class="row ${task.id === selectedId ? 'selected' : ''}" data-id="${esc(task.id)}">
    <div class="file-badge">${esc(extLabel(task.filename))}</div>
    <div>
      <div class="name-line">
        <div class="name" title="${esc(task.filename)}">${esc(task.filename)}</div>
        <span class="pill ${esc(task.status)}">${esc(labelStatus(task.status))}</span>
      </div>
      <div class="meta">${esc(meta(task))}</div>
      <div class="${barClass}"><span style="width:${width}%"></span></div>
    </div>
    <div class="row-actions">${rowButtons(task)}</div>
  </article>`;
}

function rowButtons(task) {
  if (task.status === 'downloading' || task.status === 'queued') {
    return `${iconBtn('pause', 'Pause')}${iconBtn('cancel', 'Stop')}`;
  }
  if (task.status === 'paused' || task.status === 'error' || task.status === 'cancelled') {
    return `${iconBtn('resume', 'Resume')}${iconBtn('remove', 'Remove')}`;
  }
  if (task.status === 'completed') {
    return `${iconBtn('open', 'Open')}${iconBtn('show', 'Folder')}${iconBtn('remove', 'Remove')}`;
  }
  return iconBtn('remove', 'Remove');
}

function iconBtn(action, title) {
  return `<button class="btn icon" data-action="${action}" title="${esc(title)}" type="button">${esc(title)}</button>`;
}

function renderDetail() {
  const task = state.tasks.find((item) => item.id === selectedId);
  if (!task || filter === 'settings') {
    $('detail').innerHTML = '<div class="detail-empty">Select a download to see its details.</div>';
    return;
  }
  $('detail').innerHTML = `
    <div class="file-badge">${esc(extLabel(task.filename))}</div>
    <h3>${esc(task.filename)}</h3>
    <dl>
      <dt>Status</dt><dd>${esc(labelStatus(task.status))}</dd>
      <dt>Progress</dt><dd>${esc(progressText(task))}</dd>
      <dt>Speed</dt><dd>${task.status === 'downloading' ? esc(formatSpeed(task.speed)) : '—'}</dd>
      <dt>Time left</dt><dd>${task.eta == null ? '—' : esc(formatEta(task.eta))}</dd>
      <dt>Connections</dt><dd>${esc(task.connections)}</dd>
      <dt>Source</dt><dd>${task.source === 'extension' ? 'Browser' : 'Added in app'}</dd>
      <dt>Saved to</dt><dd>${esc(task.savePath || 'Waiting to start')}</dd>
      <dt>Address</dt><dd>${esc(task.url)}</dd>
      ${task.error ? `<dt>Error</dt><dd>${esc(task.error)}</dd>` : ''}
    </dl>
    <div class="detail-actions">
      ${task.status === 'completed' ? '<button class="btn primary" data-action="open" type="button">Open</button><button class="btn" data-action="show" type="button">Show in folder</button>' : ''}
      ${task.status === 'downloading' || task.status === 'queued' ? '<button class="btn" data-action="pause" type="button">Pause</button>' : ''}
      ${task.status === 'paused' || task.status === 'error' || task.status === 'cancelled' ? '<button class="btn primary" data-action="resume" type="button">Resume</button>' : ''}
      ${task.status === 'downloading' || task.status === 'queued' || task.status === 'paused' ? '<button class="btn" data-action="cancel" type="button">Cancel</button>' : ''}
      <button class="btn" data-action="copy" type="button">Copy URL</button>
      ${task.status === 'completed' ? '<button class="btn danger" data-action="deleteFile" type="button">Delete file</button>' : ''}
      <button class="btn" data-action="remove" type="button">Remove</button>
    </div>`;
}

function renderServer() {
  const pill = $('serverPill');
  pill.textContent = serverText();
  pill.classList.toggle('ok', Boolean(state.server?.running));
  pill.classList.toggle('bad', Boolean(state.server && !state.server.running));
}

function serverText() {
  if (!state.server) return 'Starting…';
  if (state.server.running) return `Extension port ${state.server.port} is open`;
  return state.server.error || 'Extension port is not open';
}

function onListClick(event) {
  const row = event.target.closest('.row');
  if (!row) return;
  selectedId = row.dataset.id;
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action) act(action, selectedId);
  else render();
}

function onListDoubleClick(event) {
  const row = event.target.closest('.row');
  if (!row) return;
  const task = state.tasks.find((item) => item.id === row.dataset.id);
  if (task?.status === 'completed') window.idm.open(task.id).then(showResult);
}

function onDetailClick(event) {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!action || !selectedId) return;
  if (action === 'copy') {
    const task = state.tasks.find((item) => item.id === selectedId);
    if (task) copyText(task.url);
    return;
  }
  act(action, selectedId);
}

function act(action, id) {
  if (action === 'remove' && !confirm('Remove this download from the list? The file stays on disk unless you delete it.')) return;
  if (action === 'cancel' && !confirm('Stop this download and delete the partial file?')) return;
  if (action === 'deleteFile' && !confirm('Delete the finished file from disk?')) return;
  const fns = {
    pause: () => window.idm.pause(id),
    resume: () => window.idm.resume(id),
    cancel: () => window.idm.cancel(id),
    remove: () => window.idm.remove(id),
    open: () => window.idm.open(id),
    show: () => window.idm.show(id),
    deleteFile: () => window.idm.deleteFile(id),
  };
  if (fns[action]) run(fns[action]);
}

async function run(fn) {
  const result = await fn();
  showResult(result);
}

function showResult(result) {
  if (result && result.ok === false && result.error) toast(result.error);
}

function openAdd() {
  $('addError').hidden = true;
  $('urls').value = '';
  $('filename').value = '';
  $('addDialog').showModal();
  $('urls').focus();
}

async function submitAdd(event) {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  const result = await window.idm.add({
    urls: $('urls').value,
    filename: $('filename').value.trim(),
  });
  if (!result.ok) {
    const error = $('addError');
    error.hidden = false;
    error.textContent = result.error;
    return;
  }
  $('addDialog').close();
  if (result.tasks?.[0]) selectedId = result.tasks[0].id;
  toast('Download added');
}

function fillSettings() {
  const settings = state.settings || {};
  if (document.activeElement && document.activeElement.closest('#settingsForm, #settingsView') && document.activeElement.id !== 'downloadDir') {
    $('serverHint').textContent = serverText();
    return;
  }
  $('downloadDir').value = settings.downloadDir || '';
  $('connections').value = settings.connections ?? 8;
  $('maxConcurrent').value = settings.maxConcurrent ?? 3;
  $('port').value = settings.port ?? 28473;
  $('token').value = settings.token || '';
  $('extensionPath').value = state.extensionPath || '';
  $('resumeOnLaunch').checked = Boolean(settings.resumeOnLaunch);
  $('notifyOnComplete').checked = settings.notifyOnComplete !== false;
  $('closeToTray').checked = Boolean(settings.closeToTray);
  $('serverHint').textContent = serverText();
}

async function saveSettings(event) {
  event.preventDefault();
  const result = await window.idm.updateSettings({
    downloadDir: $('downloadDir').value,
    connections: Number($('connections').value),
    maxConcurrent: Number($('maxConcurrent').value),
    port: Number($('port').value),
    resumeOnLaunch: $('resumeOnLaunch').checked,
    notifyOnComplete: $('notifyOnComplete').checked,
    closeToTray: $('closeToTray').checked,
  });
  if (!result.ok) toast(result.error);
  else toast('Settings saved');
}

async function browseFolder() {
  const result = await window.idm.pickFolder();
  if (result?.path) $('downloadDir').value = result.path;
}

async function regenerateToken() {
  if (!confirm('Replace the integration token? The browser extension will need the new one.')) return;
  const result = await window.idm.regenerateToken();
  if (!result.ok) {
    toast(result.error);
    return;
  }
  $('token').value = result.token;
  toast('New token ready to paste into the extension');
}

function copyText(value) {
  if (!value) return;
  const area = document.createElement('textarea');
  area.value = value;
  document.body.appendChild(area);
  area.select();
  document.execCommand('copy');
  area.remove();
  toast('Copied');
}

function toast(message) {
  const el = $('toast');
  el.hidden = false;
  el.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 2400);
}

function percent(task) {
  if (task.status === 'completed') return 100;
  if (!task.totalBytes) return null;
  return Math.max(0, Math.min(100, (task.downloadedBytes / task.totalBytes) * 100));
}

function meta(task) {
  if (task.status === 'error') return task.error || 'Failed';
  if (task.status === 'queued') return 'Waiting for a free slot';
  if (task.status === 'cancelled') return 'Cancelled';
  if (task.status === 'completed') return `${formatBytes(task.totalBytes)} · Finished`;
  if (task.status === 'downloading' && task.downloadedBytes === 0) return 'Connecting...';
  return progressText(task);
}

function progressText(task) {
  const done = formatBytes(task.downloadedBytes || 0);
  if (task.totalBytes == null) {
    return task.status === 'downloading' && task.speed ? `${done} downloaded · ${formatSpeed(task.speed)}` : `${done} downloaded`;
  }
  const base = `${done} of ${formatBytes(task.totalBytes)}`;
  if (task.status === 'downloading' && task.speed) {
    return `${base} · ${formatSpeed(task.speed)} · ${formatEta(task.eta)} left`;
  }
  return base;
}

function labelStatus(status) {
  return { downloading: 'Downloading', queued: 'Queued', paused: 'Paused', completed: 'Completed', error: 'Failed', cancelled: 'Cancelled' }[status] || status;
}

function extLabel(filename) {
  const ext = (filename.split('.').pop() || '').slice(0, 4).toUpperCase();
  return ext && ext !== filename.toUpperCase() ? ext : 'FILE';
}

function formatBytes(bytes) {
  if (bytes == null || !Number.isFinite(Number(bytes)) || bytes < 0) return 'Unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes);
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const digits = value >= 10 || index === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[index]}`;
}

function formatSpeed(bytes) {
  if (!bytes) return '0 B/s';
  return `${formatBytes(bytes)}/s`;
}

function formatEta(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const whole = Math.max(0, Math.ceil(seconds));
  if (whole < 60) return `${whole}s`;
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  if (minutes < 60) return `${minutes}m ${rest}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}
