const http = require('http');
const crypto = require('crypto');

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-IDM-Token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function authorized(req, token) {
  const header = req.headers['x-idm-token'];
  const given = Array.isArray(header) ? header[0] : header;
  const expected = String(token || '');
  if (!given || !expected) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function handle(req, res, manager) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-IDM-Token',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Max-Age': '600',
    });
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://127.0.0.1');

  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, name: 'IDM Clone' });
    return;
  }

  if (!authorized(req, manager.settings.token)) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/auth-check') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/downloads') {
    sendJson(res, 200, { tasks: manager.snapshot().tasks });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/downloads') {
    const body = await readBody(req);
    const downloadUrl = String(body.url || '').trim();
    if (!downloadUrl) {
      sendJson(res, 400, { error: 'Missing url' });
      return;
    }
    const task = await manager.add({
      url: downloadUrl,
      filename: body.filename || '',
      referrer: body.referrer || '',
      cookie: body.cookie || '',
      userAgent: body.userAgent || '',
      source: body.source === 'extension' ? 'extension' : 'manual',
    });
    sendJson(res, 201, { ok: true, id: task.id, filename: task.filename });
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

function startApiServer(manager) {
  return new Promise((resolve) => {
    let settled = false;
    const server = http.createServer((req, res) => {
      handle(req, res, manager).catch((err) => {
        if (res.headersSent) return;
        sendJson(res, 500, { error: err.message || 'Internal error' });
      });
    });

    const finish = (status) => {
      if (settled) return;
      settled = true;
      resolve({
        status,
        close() {
          return new Promise((done) => {
            if (!status.running) {
              done();
              return;
            }
            server.close(() => done());
          });
        },
      });
    };

    server.on('error', (err) => {
      const message = err.code === 'EADDRINUSE'
        ? `Port ${manager.settings.port} is already in use`
        : err.message;
      finish({ running: false, port: manager.settings.port, error: message });
    });

    server.listen(manager.settings.port, '127.0.0.1', () => {
      finish({ running: true, port: manager.settings.port, error: null });
    });
  });
}

module.exports = { startApiServer };
