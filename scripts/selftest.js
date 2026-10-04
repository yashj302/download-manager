const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');
const DownloadManager = require('../src/download-manager');
const { startApiServer } = require('../src/api-server');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function createServer(data) {
  const stats = { ranged: 0, hostileFull: 0, throttled: 0, limitedActive: 0, limitedPeak: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const hostile = url.pathname === '/hostile.bin';
    const limited = url.pathname === '/limited.bin';
    const range = req.headers.range || '';
    const uneven = url.pathname === '/uneven.bin' && !/^bytes=0-/.test(range);
    const slow = url.pathname === '/slow.bin' || limited || uneven;

    if (limited && range !== 'bytes=0-0') {
      if (stats.limitedActive >= 2) {
        stats.throttled += 1;
        res.writeHead(429, { 'Retry-After': '0' });
        res.end();
        return;
      }
      stats.limitedActive += 1;
      stats.limitedPeak = Math.max(stats.limitedPeak, stats.limitedActive);
      res.on('close', () => { stats.limitedActive -= 1; });
    }

    if (hostile && range !== 'bytes=0-0') {
      stats.hostileFull += 1;
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': data.length,
        'Accept-Ranges': 'none',
      });
      res.end(data);
      return;
    }

    if (!range) {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': data.length,
        'Accept-Ranges': 'bytes',
        'Content-Disposition': 'attachment; filename="sample.bin"',
      });
      res.end(data);
      return;
    }

    const match = /bytes=(\d+)-(\d*)/.exec(range);
    if (!match) {
      res.writeHead(416);
      res.end();
      return;
    }
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : data.length - 1;
    if (range !== 'bytes=0-0') stats.ranged += 1;
    const chunk = data.subarray(start, Math.min(data.length, end + 1));
    res.writeHead(206, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': chunk.length,
      'Content-Range': `bytes ${start}-${end}/${data.length}`,
      'Accept-Ranges': 'bytes',
      'Content-Disposition': 'attachment; filename="sample.bin"',
    });
    if (!slow || chunk.length < 64 * 1024) {
      res.end(chunk);
      return;
    }
    const piece = 64 * 1024;
    let offset = 0;
    const write = () => {
      if (res.destroyed || offset >= chunk.length) {
        res.end();
        return;
      }
      const next = chunk.subarray(offset, Math.min(chunk.length, offset + piece));
      offset += next.length;
      const ok = res.write(next);
      if (ok) setTimeout(write, 20);
      else res.once('drain', () => setTimeout(write, 20));
    };
    write();
  });
  server.stats = stats;
  return server;
}

function waitFor(manager, id, status, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      const task = manager.snapshot().tasks.find((item) => item.id === id);
      reject(new Error(`Timed out waiting for ${status}. Last state: ${task?.status} ${task?.error || ''} (${task?.downloadedBytes || 0} bytes)`));
    }, timeoutMs);
    const onUpdate = (snapshot) => {
      const task = snapshot.tasks.find((item) => item.id === id);
      if (!task) return;
      if (task.status === status) {
        cleanup();
        resolve(task);
      } else if (status !== 'error' && task.status === 'error') {
        cleanup();
        reject(new Error(task.error || 'download failed'));
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      manager.off('update', onUpdate);
    };
    manager.on('update', onUpdate);
    onUpdate(manager.snapshot());
  });
}

async function main() {
  const data = Buffer.alloc(16 * 1024 * 1024);
  for (let i = 0; i < data.length; i += 1) data[i] = (i * 31) % 256;
  const server = createServer(data);
  const port = await listen(server);
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'idm-clone-'));
  const manager = new DownloadManager({
    dataDir: path.join(root, 'data'),
    downloadDir: path.join(root, 'out'),
  });

  try {
    await manager.load();
    manager.settings.port = 20000 + Math.floor(Math.random() * 20000);
    const api = await startApiServer(manager);
    assert(api.status.running, api.status.error || 'API did not start');

    const denied = await fetch(`http://127.0.0.1:${manager.settings.port}/api/downloads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-IDM-Token': 'wrong' },
      body: JSON.stringify({ url: `http://127.0.0.1:${port}/file.bin` }),
    });
    assert(denied.status === 401, `expected 401, got ${denied.status}`);

    const multi = await manager.add({
      url: `http://127.0.0.1:${port}/file.bin`,
      connections: 4,
    });
    const multiDone = await waitFor(manager, multi.id, 'completed', 20000);
    assert(multiDone.filename === 'sample.bin', `filename was ${multiDone.filename}`);
    assert(multiDone.connections >= 2, `expected multiple connections, got ${multiDone.connections}`);
    const multiBytes = await fsp.readFile(multiDone.savePath);
    assert(multiBytes.equals(data), 'multi-connection file does not match');
    assert(server.stats.ranged >= 2, 'server did not receive split range requests');

    const slow = await manager.add({
      url: `http://127.0.0.1:${port}/slow.bin`,
      connections: 1,
      filename: 'slow.bin',
    });
    const paused = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('download finished before it could be paused'));
      }, 20000);
      const onUpdate = (snapshot) => {
        const task = snapshot.tasks.find((item) => item.id === slow.id);
        if (!task) return;
        if (task.status === 'downloading' && task.downloadedBytes > 200000) manager.pause(slow.id);
        if (task.status === 'paused' && task.downloadedBytes > 0) {
          cleanup();
          resolve(task);
        }
        if (task.status === 'error' || task.status === 'completed') {
          cleanup();
          reject(new Error(`pause test ended as ${task.status}: ${task.error || ''}`));
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        manager.off('update', onUpdate);
      };
      manager.on('update', onUpdate);
    });
    assert(paused.downloadedBytes < data.length, 'pause happened after the file was already complete');
    manager.resume(slow.id);
    const slowDone = await waitFor(manager, slow.id, 'completed', 30000);
    const slowBytes = await fsp.readFile(slowDone.savePath);
    assert(slowBytes.equals(data), 'resumed file does not match');

    const hostile = await manager.add({
      url: `http://127.0.0.1:${port}/hostile.bin`,
      connections: 4,
      filename: 'hostile.bin',
    });
    const hostileDone = await waitFor(manager, hostile.id, 'completed', 20000);
    const hostileBytes = await fsp.readFile(hostileDone.savePath);
    assert(hostileBytes.equals(data), 'fallback download does not match');
    assert(server.stats.hostileFull > 0, 'fallback path was not exercised');

    const limited = await manager.add({
      url: `http://127.0.0.1:${port}/limited.bin`,
      connections: 8,
      filename: 'limited.bin',
    });
    const limitedDone = await waitFor(manager, limited.id, 'completed', 60000);
    const limitedBytes = await fsp.readFile(limitedDone.savePath);
    assert(limitedBytes.equals(data), 'throttled download does not match');
    assert(server.stats.throttled > 0, 'throttling path was not exercised');
    assert(limitedDone.connections <= 2, `expected connections to drop to 2, got ${limitedDone.connections}`);

    const uneven = await manager.add({
      url: `http://127.0.0.1:${port}/uneven.bin`,
      connections: 2,
      filename: 'uneven.bin',
    });
    const unevenDone = await waitFor(manager, uneven.id, 'completed', 60000);
    const unevenBytes = await fsp.readFile(unevenDone.savePath);
    assert(unevenBytes.equals(data), 'split download does not match');
    const unevenSegments = manager.getTask(uneven.id).segments.length;
    assert(unevenSegments > 2, `expected the slow part to be split, got ${unevenSegments} parts`);

    const created = await fetch(`http://127.0.0.1:${manager.settings.port}/api/downloads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-IDM-Token': manager.settings.token,
      },
      body: JSON.stringify({
        url: `http://127.0.0.1:${port}/file.bin`,
        source: 'extension',
      }),
    });
    assert(created.status === 201, `expected 201, got ${created.status}`);
    const body = await created.json();
    const apiDone = await waitFor(manager, body.id, 'completed', 20000);
    const apiBytes = await fsp.readFile(apiDone.savePath);
    assert(apiBytes.equals(data), 'API download does not match');

    await api.close();
    console.log('All download engine checks passed.');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
