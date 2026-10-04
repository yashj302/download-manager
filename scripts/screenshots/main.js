// Renders the real UI with sample data and saves README screenshots to docs/screenshots.
// Run with: npx electron scripts/screenshots/main.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const outDir = path.join(root, 'docs', 'screenshots');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'idm-shots-')));
app.on('window-all-closed', () => {});

function open(file, width, height) {
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    useContentSize: true,
    backgroundColor: '#0c1222',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      sandbox: false,
    },
  });
  return win.loadFile(file).then(() => win);
}

async function shoot(win, name, script) {
  if (script) await win.webContents.executeJavaScript(script);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, name), image.toPNG());
  console.log(`saved ${name}`);
}

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const main = await open(path.join(root, 'renderer', 'index.html'), 1280, 760);
  await shoot(main, 'downloads.png', `document.querySelector('.row[data-id="t1"]').click()`);
  await shoot(main, 'settings.png', `document.getElementById('settingsNav').click()`);
  await shoot(main, 'add-url.png', `
    document.querySelector('[data-filter="all"]').click();
    document.getElementById('addBtn').click();
    document.getElementById('urls').value = 'https://example.com/files/big-archive.zip';
    document.activeElement.blur();
  `);
  main.destroy();

  const popup = await open(path.join(root, 'extension', 'popup.html'), 348, 400);
  const height = await popup.webContents.executeJavaScript(`
    document.documentElement.style.overflow = 'hidden';
    document.body.getBoundingClientRect().height
  `);
  popup.setContentSize(348, Math.ceil(height));
  await shoot(popup, 'extension-popup.png');
  app.quit();
}).catch((err) => {
  console.error(err);
  app.exit(1);
});
