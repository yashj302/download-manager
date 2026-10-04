const path = require('path');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CATEGORIES = {
  video: ['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v', 'ts', 'mpeg'],
  music: ['mp3', 'flac', 'wav', 'aac', 'ogg', 'm4a', 'wma', 'opus'],
  programs: ['exe', 'msi', 'dmg', 'apk', 'msix', 'appx', 'deb', 'rpm'],
  archives: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'tgz'],
  documents: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'rtf', 'epub', 'md'],
  images: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'tif', 'tiff', 'ico', 'heic', 'avif'],
};

const MIME_EXT = {
  'text/html': '.html',
  'text/plain': '.txt',
  'text/css': '.css',
  'text/csv': '.csv',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/json': '.json',
  'application/gzip': '.gz',
  'application/x-7z-compressed': '.7z',
  'application/x-rar-compressed': '.rar',
  'application/vnd.rar': '.rar',
  'application/x-tar': '.tar',
  'application/x-msdownload': '.exe',
  'application/vnd.microsoft.portable-executable': '.exe',
  'application/vnd.android.package-archive': '.apk',
  'application/octet-stream': '',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/x-matroska': '.mkv',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/flac': '.flac',
  'audio/mp4': '.m4a',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
};

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function sanitizeFilename(name) {
  const base = path.basename(String(name || ''))
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  return (base || 'download').slice(0, 180);
}

function filenameFromDisposition(header) {
  if (!header) return '';
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;]+)/i.exec(header);
  if (star) {
    try {
      return sanitizeFilename(decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')));
    } catch {
      return sanitizeFilename(star[1]);
    }
  }
  const quoted = /filename\s*=\s*"([^"]+)"/i.exec(header);
  if (quoted) return sanitizeFilename(quoted[1]);
  const plain = /filename\s*=\s*([^;]+)/i.exec(header);
  if (plain) return sanitizeFilename(plain[1].trim().replace(/^"|"$/g, ''));
  return '';
}

function filenameFromUrl(raw) {
  try {
    const url = new URL(raw);
    const base = decodeURIComponent(path.basename(url.pathname));
    if (!base || base === '.' || base === '/') return sanitizeFilename(url.hostname || 'download');
    return sanitizeFilename(base);
  } catch {
    return 'download';
  }
}

function categoryFor(filename) {
  const ext = path.extname(filename || '').slice(1).toLowerCase();
  for (const [name, list] of Object.entries(CATEGORIES)) {
    if (list.includes(ext)) return name;
  }
  return 'other';
}

function applyMimeExtension(filename, mime) {
  const ext = MIME_EXT[String(mime || '').toLowerCase()];
  if (!ext || path.extname(filename)) return filename;
  return `${filename}${ext}`;
}

function describeError(err) {
  if (!err) return 'Download failed';
  const code = err.cause?.code || err.code;
  const message = err.message || 'Download failed';
  if (code && !message.includes(code)) return `${message} (${code})`;
  return message;
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

module.exports = {
  DEFAULT_UA,
  CATEGORIES,
  clamp,
  sanitizeFilename,
  filenameFromDisposition,
  filenameFromUrl,
  categoryFor,
  applyMimeExtension,
  describeError,
  delay,
};
