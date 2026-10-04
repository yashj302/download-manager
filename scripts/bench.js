const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const DownloadManager = require('../src/download-manager');

const url = process.argv[2];
const connections = Number(process.argv[3] || 8);
const seconds = Number(process.argv[4] || 20);

async function main() {
  if (!url) throw new Error('Usage: node scripts/bench.js <url> [connections] [seconds]');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'idm-bench-'));
  const manager = new DownloadManager({ dataDir: path.join(root, 'data'), downloadDir: path.join(root, 'out') });
  try {
    await manager.load();
    const task = await manager.add({ url, connections });
    const started = Date.now();
    let firstByteAt = null;
    let lastBytes = 0;
    while (Date.now() - started < seconds * 1000) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const snap = manager.snapshot().tasks.find((item) => item.id === task.id);
      if (!snap) break;
      if (snap.downloadedBytes > 0 && !firstByteAt) firstByteAt = Date.now();
      const delta = snap.downloadedBytes - lastBytes;
      lastBytes = snap.downloadedBytes;
      console.log(`${Math.round((Date.now() - started) / 1000)}s ${snap.status} conns=${snap.connections} ${(delta / 2 / 1048576).toFixed(1)} MB/s total=${(snap.downloadedBytes / 1048576).toFixed(0)} MB ${snap.error || ''}`);
      if (snap.status === 'error' || snap.status === 'completed') break;
    }
    const elapsed = (Date.now() - (firstByteAt || started)) / 1000;
    console.log(`average ${(lastBytes / Math.max(1, elapsed) / 1048576).toFixed(1)} MB/s`);
    manager.pause(task.id);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await manager.shutdown();
  } finally {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().then(() => process.exit(0), (err) => {
  console.error(err);
  process.exit(1);
});
