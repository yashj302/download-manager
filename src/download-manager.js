const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const {
  DEFAULT_UA,
  clamp,
  sanitizeFilename,
  filenameFromDisposition,
  filenameFromUrl,
  categoryFor,
  applyMimeExtension,
  describeError,
  delay,
} = require('./util');

const MIN_SEGMENT_BYTES = 1024 * 1024;
const MIN_SPLIT_BYTES = 4 * 1024 * 1024;
const WRITE_BUFFER_BYTES = 1024 * 1024;
const RAISE_AFTER_MS = 15000;
const RAISE_MAX_MS = 5 * 60 * 1000;
const STALL_MS = 45000;

class DownloadManager extends EventEmitter {
  constructor({ dataDir, downloadDir }) {
    super();
    this.dataDir = dataDir;
    this.partialsDir = path.join(dataDir, 'partials');
    this.statePath = path.join(dataDir, 'state.json');
    this.extensionPath = '';
    this.tasks = [];
    this.settings = {
      downloadDir,
      connections: 8,
      maxConcurrent: 3,
      port: 28473,
      token: crypto.randomBytes(24).toString('hex'),
      resumeOnLaunch: true,
      notifyOnComplete: true,
      closeToTray: false,
    };
    this.serverStatus = { running: false, port: this.settings.port, error: null };
    this.controllers = new Map();
    this.activeConnections = new Map();
    this.samples = new Map();
    this.persistTimer = null;
    this.emitTimer = null;
    this.persistTail = Promise.resolve();
    this.pathLock = Promise.resolve();
    this.quitting = false;
  }

  async load() {
    await fsp.mkdir(this.partialsDir, { recursive: true });
    await fsp.mkdir(this.settings.downloadDir, { recursive: true });
    try {
      const raw = (await fsp.readFile(this.statePath, 'utf8')).replace(/^\uFEFF/, '');
      const data = JSON.parse(raw);
      if (data.settings && typeof data.settings === 'object') {
        this.settings = { ...this.settings, ...data.settings };
      }
      if (Array.isArray(data.tasks)) {
        this.tasks = data.tasks.filter((task) => task && task.id && task.url && task.status !== 'removed');
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    for (const task of this.tasks) {
      if (task.status === 'downloading') {
        task.status = this.settings.resumeOnLaunch ? 'queued' : 'paused';
      }
    }
    await this.persist();
    this.emitSoon(true);
    this.pump();
  }

  setServerStatus(status) {
    this.serverStatus = status;
    this.emitSoon(true);
  }

  getTask(id) {
    return this.tasks.find((task) => task.id === id) || null;
  }

  snapshot() {
    return {
      tasks: this.tasks.map((task) => this.toPublic(task)),
      settings: { ...this.settings },
      server: { ...this.serverStatus },
      extensionPath: this.extensionPath,
      version: '1.0.0',
    };
  }

  toPublic(task) {
    const speed = task.status === 'downloading' ? this.speedOf(task.id) : 0;
    let eta = null;
    if (speed > 0 && task.totalBytes != null && task.status === 'downloading') {
      eta = Math.max(0, (task.totalBytes - task.downloadedBytes) / speed);
    }
    return {
      id: task.id,
      url: task.url,
      filename: task.filename,
      savePath: task.savePath,
      status: task.status,
      totalBytes: task.totalBytes,
      downloadedBytes: task.downloadedBytes || 0,
      error: task.error || '',
      category: task.category || 'other',
      connections: this.activeConnections.get(task.id)
        || Math.min(task.segments?.length || task.connections || 1, task.connectionLimit || Infinity),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      completedAt: task.completedAt,
      source: task.source || 'manual',
      speed,
      eta,
    };
  }

  async add(input) {
    const rawUrl = String(input.url || '').trim();
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error('Enter a valid http or https URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only http and https URLs can be downloaded');
    }

    const requestedName = String(input.filename || '').trim();
    const task = {
      id: crypto.randomUUID(),
      url: parsed.href,
      finalUrl: null,
      filename: requestedName ? sanitizeFilename(requestedName) : 'download',
      filenameLocked: Boolean(requestedName),
      savePath: null,
      status: 'queued',
      totalBytes: null,
      downloadedBytes: 0,
      error: null,
      category: 'other',
      connections: clamp(input.connections || this.settings.connections, 1, 32),
      segments: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      completedAt: null,
      source: input.source === 'extension' ? 'extension' : 'manual',
      referrer: String(input.referrer || ''),
      cookie: String(input.cookie || ''),
      userAgent: String(input.userAgent || '') || DEFAULT_UA,
      rangeFallback: false,
    };
    this.tasks.unshift(task);
    await this.persist();
    this.emitSoon(true);
    this.emit('added', this.toPublic(task));
    this.pump();
    return this.toPublic(task);
  }

  pause(id) {
    const task = this.getTask(id);
    if (!task || (task.status !== 'downloading' && task.status !== 'queued')) return;
    task.status = 'paused';
    task.updatedAt = Date.now();
    this.samples.delete(task.id);
    this.controllers.get(task.id)?.abort();
    this.emitSoon(true);
    this.schedulePersist();
  }

  resume(id) {
    const task = this.getTask(id);
    if (!task || !['paused', 'error', 'cancelled'].includes(task.status)) return;
    task.status = 'queued';
    task.error = null;
    task.updatedAt = Date.now();
    this.emitSoon(true);
    this.schedulePersist();
    this.pump();
  }

  async cancel(id) {
    const task = this.getTask(id);
    if (!task || task.status === 'completed' || task.status === 'cancelled') return;
    task.status = 'cancelled';
    task.updatedAt = Date.now();
    task.downloadedBytes = 0;
    task.segments = null;
    task.totalBytes = task.savePath ? task.totalBytes : null;
    this.samples.delete(task.id);
    this.controllers.get(task.id)?.abort();
    await this.removePartials(task);
    await this.persist();
    this.emitSoon(true);
    this.pump();
  }

  async remove(id) {
    const task = this.getTask(id);
    if (!task) return;
    task.status = 'removed';
    this.samples.delete(task.id);
    this.controllers.get(task.id)?.abort();
    await this.removePartials(task);
    this.tasks = this.tasks.filter((item) => item.id !== id);
    await this.persist();
    this.emitSoon(true);
    this.pump();
  }

  async deleteFile(id) {
    const task = this.getTask(id);
    if (!task || task.status !== 'completed' || !task.savePath) {
      throw new Error('There is no finished file to delete');
    }
    await fsp.rm(task.savePath, { force: true });
    await this.remove(id);
  }

  pauseAll() {
    for (const task of this.tasks) {
      if (task.status === 'downloading' || task.status === 'queued') this.pause(task.id);
    }
  }

  resumeAll() {
    for (const task of [...this.tasks].reverse()) {
      if (task.status === 'paused' || task.status === 'error') this.resume(task.id);
    }
  }

  async clearCompleted() {
    const finished = this.tasks.filter((task) => task.status === 'completed' || task.status === 'cancelled');
    for (const task of finished) {
      this.samples.delete(task.id);
      await this.removePartials(task);
    }
    this.tasks = this.tasks.filter((task) => task.status !== 'completed' && task.status !== 'cancelled');
    await this.persist();
    this.emitSoon(true);
  }

  async updateSettings(partial) {
    const next = { ...this.settings };
    if (partial.downloadDir) {
      const dir = path.resolve(String(partial.downloadDir));
      await fsp.mkdir(dir, { recursive: true });
      next.downloadDir = dir;
    }
    if (partial.connections != null) next.connections = clamp(partial.connections, 1, 32);
    if (partial.maxConcurrent != null) next.maxConcurrent = clamp(partial.maxConcurrent, 1, 8);
    if (partial.port != null) next.port = clamp(partial.port, 1024, 65535);
    if (partial.token) next.token = String(partial.token);
    if (typeof partial.resumeOnLaunch === 'boolean') next.resumeOnLaunch = partial.resumeOnLaunch;
    if (typeof partial.notifyOnComplete === 'boolean') next.notifyOnComplete = partial.notifyOnComplete;
    if (typeof partial.closeToTray === 'boolean') next.closeToTray = partial.closeToTray;

    const portChanged = next.port !== this.settings.port;
    this.settings = next;
    await this.persist();
    this.emitSoon(true);
    if (portChanged) this.emit('server-restart');
    this.pump();
  }

  async shutdown() {
    this.quitting = true;
    for (const task of this.tasks) {
      if (task.status === 'downloading') {
        task.status = this.settings.resumeOnLaunch ? 'queued' : 'paused';
        this.controllers.get(task.id)?.abort();
      }
    }
    if (this.persistTimer) clearTimeout(this.persistTimer);
    await this.persist();
  }

  pump() {
    if (this.quitting) return;
    const active = this.tasks.filter((task) => task.status === 'downloading').length;
    let slots = this.settings.maxConcurrent - active;
    if (slots <= 0) return;
    const queued = this.tasks
      .filter((task) => task.status === 'queued')
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const task of queued) {
      if (slots <= 0) break;
      slots -= 1;
      this.run(task);
    }
  }

  run(task) {
    if (this.controllers.has(task.id)) return;
    task.status = 'downloading';
    task.error = null;
    task.updatedAt = Date.now();
    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    this.emitSoon(true);
    this.execute(task, controller).catch((err) => {
      console.error('Download crashed', err);
    });
  }

  async execute(task, controller) {
    try {
      await this.ensurePlan(task, controller.signal);
      if (task.status !== 'downloading') return;
      await this.downloadAll(task, controller.signal);
      if (task.status !== 'downloading') return;
      await this.finalize(task);
      if (task.status !== 'downloading') return;
      task.status = 'completed';
      task.completedAt = Date.now();
      task.error = null;
      this.samples.delete(task.id);
      await this.removePartials(task);
      if (this.settings.notifyOnComplete) {
        this.emit('notify', { title: 'Download complete', body: task.filename });
      }
    } catch (err) {
      const stillCurrent = this.controllers.get(task.id) === controller;
      if (this.quitting || !stillCurrent) return;
      if (controller.signal.aborted || err?.name === 'AbortError') {
        if (task.status === 'downloading') {
          task.status = 'error';
          task.error = 'Download was interrupted';
          this.samples.delete(task.id);
        }
        return;
      }
      if (task.status !== 'downloading') return;
      task.status = 'error';
      task.error = describeError(err);
      this.samples.delete(task.id);
    } finally {
      if (this.controllers.get(task.id) === controller) this.controllers.delete(task.id);
      task.updatedAt = Date.now();
      await this.persist();
      this.emitSoon(true);
      this.pump();
    }
  }

  async ensurePlan(task, signal) {
    if (task.segments && task.savePath) {
      await this.syncSegmentProgress(task);
      return;
    }

    const probe = await this.probe(task, signal);
    if (task.status !== 'downloading') return;

    task.finalUrl = probe.finalUrl;
    task.totalBytes = probe.totalBytes;
    if (!task.filenameLocked) {
      const named = applyMimeExtension(
        probe.filename || filenameFromUrl(probe.finalUrl || task.url),
        probe.mime,
      );
      task.filename = sanitizeFilename(named);
    } else {
      task.filename = sanitizeFilename(task.filename);
    }

    const unique = await this.allocatePath(task);
    task.filename = unique.filename;
    task.savePath = unique.savePath;
    task.category = categoryFor(task.filename);

    if (probe.totalBytes === 0) {
      task.segments = [];
      task.downloadedBytes = 0;
      await this.persist();
      return;
    }

    const canSplit = probe.acceptRanges && probe.totalBytes != null && !task.rangeFallback;
    const connections = canSplit
      ? chooseConnections(probe.totalBytes, task.connections || this.settings.connections)
      : 1;
    task.segments = buildSegments(probe.totalBytes, connections);
    task.splittable = canSplit;
    task.downloadedBytes = 0;
    await this.persist();
  }

  async downloadAll(task, signal) {
    if (!task.segments || task.segments.length === 0) return;
    try {
      await this.runSegments(task, signal);
    } catch (err) {
      if (err.code !== 'NO_RANGE' || task.rangeFallback) throw err;
      task.rangeFallback = true;
      await delay(120);
      await this.removePartials(task);
      task.downloadedBytes = 0;
      task.segments = buildSegments(task.totalBytes, 1);
      task.splittable = false;
      await this.runSegments(task, signal);
    }
  }

  async runSegments(task, signal) {
    const local = new AbortController();
    const onAbort = () => local.abort();
    if (signal.aborted) local.abort();
    else signal.addEventListener('abort', onAbort, { once: true });

    const pending = task.segments.filter((segment) => segmentRemaining(segment) > 0);
    const running = new Set();
    const splittable = task.splittable ?? task.segments.length > 1;
    const target = clamp(task.connections || this.settings.connections, 1, 32);
    let limit = clamp(task.connectionLimit || target, 1, target);
    let active = 0;
    let throttles = 0;
    let soloThrottles = 0;
    let holdUntil = 0;
    let lastThrottleAt = 0;
    let lastRaiseAt = Date.now();
    let raisedAt = 0;
    let raiseEvery = RAISE_AFTER_MS;
    let wakeTimer = null;
    let tick = null;
    let failure = null;

    const splitOne = () => {
      if (!splittable) return null;
      let best = null;
      let bestLeft = MIN_SPLIT_BYTES - 1;
      for (const segment of running) {
        const left = segmentRemaining(segment);
        if (segment.end != null && left > bestLeft) {
          best = segment;
          bestLeft = left;
        }
      }
      if (!best) return null;
      const position = best.start + (best.downloaded || 0);
      const mid = position + Math.floor(bestLeft / 2);
      const next = {
        index: Math.max(...task.segments.map((segment) => segment.index)) + 1,
        start: mid,
        end: best.end,
        downloaded: 0,
      };
      best.end = mid - 1;
      task.segments.push(next);
      task.segments.sort((a, b) => a.start - b.start);
      this.schedulePersist();
      return next;
    };

    try {
      await new Promise((resolve) => {
        const finish = () => {
          clearTimeout(wakeTimer);
          clearInterval(tick);
          resolve();
        };
        const fail = (err) => {
          if (!failure) failure = err;
          local.abort();
          if (active === 0) finish();
        };
        const launch = () => {
          if (failure || local.signal.aborted) {
            if (!failure) failure = abortError();
            if (active === 0) finish();
            return;
          }
          if (!pending.length && active === 0) {
            finish();
            return;
          }
          const wait = holdUntil - Date.now();
          if (wait > 0) {
            clearTimeout(wakeTimer);
            wakeTimer = setTimeout(launch, wait);
            return;
          }
          while (active < limit) {
            const segment = pending.shift() || splitOne();
            if (!segment) break;
            active += 1;
            running.add(segment);
            this.activeConnections.set(task.id, active);
            this.downloadSegment(task, segment, local.signal).then(
              () => {
                active -= 1;
                running.delete(segment);
                this.activeConnections.set(task.id, active);
                throttles = 0;
                soloThrottles = 0;
                launch();
              },
              (err) => {
                active -= 1;
                running.delete(segment);
                this.activeConnections.set(task.id, active);
                if (err?.code === 'THROTTLED' && !local.signal.aborted && task.status === 'downloading') {
                  lastThrottleAt = Date.now();
                  throttles += 1;
                  if (limit === 1) {
                    soloThrottles += 1;
                    if (soloThrottles > 6) {
                      fail(err);
                      return;
                    }
                  }
                  limit = Math.max(1, Math.min(limit - 1, active));
                  task.connectionLimit = limit;
                  pending.unshift(segment);
                  if (raisedAt > 0) {
                    raiseEvery = Math.min(RAISE_MAX_MS, raiseEvery * 2);
                    raisedAt = 0;
                  }
                  if (active === 0) {
                    const backoff = err.retryAfter ?? Math.min(30000, 1500 * 2 ** Math.min(throttles - 1, 4));
                    holdUntil = Math.max(holdUntil, Date.now() + backoff);
                  }
                  this.emitSoon(false);
                  launch();
                  return;
                }
                fail(err);
              },
            );
          }
        };
        local.signal.addEventListener('abort', () => {
          if (active === 0) finish();
        }, { once: true });
        tick = setInterval(() => {
          const now = Date.now();
          if (raisedAt > 0 && now - raisedAt > RAISE_AFTER_MS) {
            raiseEvery = RAISE_AFTER_MS;
            raisedAt = 0;
          }
          if (limit < target && now - lastThrottleAt > raiseEvery && now - lastRaiseAt > raiseEvery) {
            limit += 1;
            lastRaiseAt = now;
            raisedAt = now;
            task.connectionLimit = limit;
            launch();
          }
        }, 1000);
        launch();
      });
    } finally {
      clearTimeout(wakeTimer);
      clearInterval(tick);
      this.activeConnections.delete(task.id);
      signal.removeEventListener('abort', onAbort);
    }

    if (task.status !== 'downloading' || signal.aborted) throw abortError();
    if (failure) throw failure;
  }

  async downloadSegment(task, segment, signal) {
    const partPath = this.partPath(task, segment);
    await fsp.mkdir(path.dirname(partPath), { recursive: true });
    let attempt = 0;
    while (true) {
      try {
        await this.streamSegment(task, segment, partPath, signal);
        return;
      } catch (err) {
        if (signal.aborted || task.status !== 'downloading' || err?.name === 'AbortError' || err?.code === 'NO_RANGE' || err?.code === 'THROTTLED') {
          throw err;
        }
        attempt += 1;
        if (attempt >= 3) throw err;
        await delay(400 * attempt, signal);
      }
    }
  }

  async streamSegment(task, segment, partPath, signal) {
    let existing = 0;
    try {
      existing = (await fsp.stat(partPath)).size;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    const expected = segment.end == null ? null : segment.end - segment.start + 1;
    if (expected != null && existing > expected) {
      await fsp.truncate(partPath, expected);
      existing = expected;
    }
    if (expected != null && existing >= expected) {
      segment.downloaded = expected;
      this.recomputeDownloaded(task);
      return;
    }

    const start = segment.start + existing;
    const headers = this.requestHeaders(task, task.finalUrl || task.url);
    if (segment.end != null) headers.Range = `bytes=${start}-${segment.end}`;
    else if (start > 0) headers.Range = `bytes=${start}-`;

    const { res } = await fetchManual(task.finalUrl || task.url, {
      headers,
      signal,
      origin: new URL(task.url).origin,
    });

    if (res.status >= 400) {
      try { await res.body?.cancel(); } catch { /* ignore */ }
      throw httpError(res);
    }

    const askedRange = Boolean(headers.Range);
    if (askedRange && res.status !== 206) {
      try { await res.body?.cancel(); } catch { /* ignore */ }
      if (res.status === 200 && existing === 0 && segment.start === 0 && task.segments.length === 1) {
        return this.streamSegmentWithoutRange(task, segment, partPath, signal);
      }
      const error = new Error('Server does not support segmented downloads');
      error.code = 'NO_RANGE';
      throw error;
    }

    if (!res.body) throw new Error('Server returned an empty response');
    await this.writeBody(res, partPath, task, segment, expected, existing, signal);

    if (segment.end != null) {
      const size = (await fsp.stat(partPath)).size;
      if (size < segment.end - segment.start + 1) throw new Error('Connection closed early');
    }
  }

  async streamSegmentWithoutRange(task, segment, partPath, signal) {
    const headers = this.requestHeaders(task, task.finalUrl || task.url);
    const { res } = await fetchManual(task.finalUrl || task.url, {
      headers,
      signal,
      origin: new URL(task.url).origin,
    });
    if (res.status >= 400) {
      try { await res.body?.cancel(); } catch { /* ignore */ }
      throw httpError(res);
    }
    if (!res.body) throw new Error('Server returned an empty response');
    await fsp.rm(partPath, { force: true });
    segment.downloaded = 0;
    this.recomputeDownloaded(task);
    await this.writeBody(res, partPath, task, segment, null, 0, signal);
  }

  async writeBody(res, partPath, task, segment, expected, existing, signal) {
    const ws = fs.createWriteStream(partPath, { flags: 'a', highWaterMark: WRITE_BUFFER_BYTES });
    ws.on('error', () => {});
    const reader = res.body.getReader();
    const bounded = expected != null;
    let stallTimer = null;
    let stalled = false;
    segment.downloaded = existing;
    this.recomputeDownloaded(task);

    const bumpStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        stalled = true;
        reader.cancel().catch(() => {});
        ws.destroy();
      }, STALL_MS);
    };

    const onAbort = () => {
      reader.cancel().catch(() => {});
      ws.destroy();
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    bumpStall();

    const left = () => (bounded ? segmentRemaining(segment) : Infinity);

    try {
      while (left() > 0) {
        const { done, value } = await reader.read();
        if (done) break;
        if (signal.aborted || task.status !== 'downloading') {
          const error = new Error('aborted');
          error.name = 'AbortError';
          throw error;
        }
        const remaining = left();
        if (remaining <= 0) break;
        let buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        if (buffer.length > remaining) buffer = buffer.subarray(0, remaining);
        await writeChunk(ws, buffer);
        segment.downloaded += buffer.length;
        this.recomputeDownloaded(task);
        this.addSample(task.id, buffer.length);
        this.emitSoon(false);
        this.schedulePersist();
        bumpStall();
      }
      if (left() > 0 && bounded) throw new Error('Connection closed early');
      reader.cancel().catch(() => {});
    } catch (err) {
      if (signal.aborted || task.status !== 'downloading') {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }
      if (stalled) throw new Error('Connection stalled');
      throw err;
    } finally {
      clearTimeout(stallTimer);
      signal.removeEventListener('abort', onAbort);
      await closeStream(ws);
    }
  }

  async finalize(task) {
    await fsp.mkdir(path.dirname(task.savePath), { recursive: true });
    if (!task.segments || task.segments.length === 0) {
      await fsp.writeFile(task.savePath, Buffer.alloc(0));
      task.downloadedBytes = 0;
      return;
    }

    await this.syncSegmentProgress(task);
    if (task.totalBytes != null && task.downloadedBytes < task.totalBytes) {
      throw new Error('Download ended before all bytes were received');
    }

    if (task.segments.length === 1) {
      await moveFile(this.partPath(task, task.segments[0]), task.savePath);
    } else {
      const tempOut = path.join(
        path.dirname(task.savePath),
        `.${path.basename(task.savePath)}.${task.id}.part`,
      );
      const ordered = [...task.segments].sort((a, b) => a.start - b.start);
      for (const segment of ordered) {
        const partFile = this.partPath(task, segment);
        const expected = segment.end - segment.start + 1;
        if ((await fsp.stat(partFile)).size > expected) await fsp.truncate(partFile, expected);
      }
      const output = fs.createWriteStream(tempOut, { highWaterMark: WRITE_BUFFER_BYTES });
      try {
        for (const segment of ordered) {
          await pipeInto(this.partPath(task, segment), output);
        }
        await closeStream(output);
        await moveFile(tempOut, task.savePath);
      } catch (err) {
        output.destroy();
        await fsp.rm(tempOut, { force: true });
        throw err;
      }
    }

    const size = (await fsp.stat(task.savePath)).size;
    if (task.totalBytes != null && size !== task.totalBytes) {
      throw new Error(`Downloaded ${size} bytes, expected ${task.totalBytes}`);
    }
    if (task.totalBytes == null) task.totalBytes = size;
    task.downloadedBytes = size;
  }

  async probe(task, signal) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.probeOnce(task, signal);
      } catch (err) {
        if (err?.code !== 'THROTTLED' || attempt >= 6) throw err;
        await delay(err.retryAfter ?? Math.min(30000, 1500 * 2 ** (attempt - 1)), signal);
      }
    }
  }

  async probeOnce(task, signal) {
    const headers = this.requestHeaders(task, task.url);
    headers.Range = 'bytes=0-0';
    let res;
    let finalUrl;
    try {
      const result = await fetchManual(task.url, {
        headers,
        signal,
        origin: new URL(task.url).origin,
      });
      res = result.res;
      finalUrl = result.url;
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      throw new Error(`Could not reach the server. ${describeError(err)}`);
    }

    try {
      if (res.status >= 400) throw httpError(res);
      const mime = (res.headers.get('content-type') || '').split(';')[0].trim();
      const filename = filenameFromDisposition(res.headers.get('content-disposition'))
        || filenameFromUrl(finalUrl);
      const contentRange = res.headers.get('content-range') || '';
      const rangeMatch = /\/(\d+)\s*$/.exec(contentRange);
      let total = rangeMatch ? Number(rangeMatch[1]) : null;
      if (total == null && res.status === 200) {
        const len = res.headers.get('content-length');
        if (len && /^\d+$/.test(len)) total = Number(len);
      }
      const encoding = (res.headers.get('content-encoding') || '').toLowerCase();
      const encoded = Boolean(encoding && encoding !== 'identity');
      return {
        finalUrl,
        totalBytes: encoded ? null : total,
        acceptRanges: res.status === 206 && total != null && !encoded,
        mime,
        filename,
      };
    } finally {
      try { await res.body?.cancel(); } catch { /* ignore */ }
    }
  }

  requestHeaders(task, targetUrl) {
    const headers = {
      'User-Agent': task.userAgent || DEFAULT_UA,
      Accept: '*/*',
      'Accept-Encoding': 'identity',
    };
    try {
      if (new URL(targetUrl).origin === new URL(task.url).origin) {
        if (task.cookie) headers.Cookie = task.cookie;
        if (task.referrer) headers.Referer = task.referrer;
      }
    } catch {
      /* keep the request anonymous if the URL is malformed */
    }
    return headers;
  }

  async syncSegmentProgress(task) {
    if (!task.segments) return;
    for (const segment of task.segments) {
      const expected = segment.end == null ? null : segment.end - segment.start + 1;
      let size = 0;
      try {
        size = (await fsp.stat(this.partPath(task, segment))).size;
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      segment.downloaded = expected == null ? size : Math.min(size, expected);
    }
    this.recomputeDownloaded(task);
  }

  recomputeDownloaded(task) {
    task.downloadedBytes = (task.segments || []).reduce((sum, segment) => sum + (segment.downloaded || 0), 0);
  }

  partPath(task, segment) {
    return path.join(this.partialsDir, task.id, `seg-${segment.index}.part`);
  }

  async removePartials(task) {
    await rmRetry(path.join(this.partialsDir, task.id));
  }

  allocatePath(task) {
    const run = this.pathLock.then(() => this.createUniquePath(task));
    this.pathLock = run.catch(() => {});
    return run;
  }

  async createUniquePath(task) {
    await fsp.mkdir(this.settings.downloadDir, { recursive: true });
    const ext = path.extname(task.filename);
    const base = path.basename(task.filename, ext);
    const taken = new Set(
      this.tasks
        .filter((item) => item.id !== task.id && item.savePath)
        .map((item) => path.normalize(item.savePath).toLowerCase()),
    );
    for (let i = 0; i < 10000; i += 1) {
      const filename = i === 0 ? task.filename : `${base} (${i})${ext}`;
      const savePath = path.join(this.settings.downloadDir, filename);
      if (taken.has(path.normalize(savePath).toLowerCase())) continue;
      if (fs.existsSync(savePath)) continue;
      return { filename, savePath };
    }
    throw new Error('Could not find a free filename');
  }

  addSample(id, bytes) {
    const now = Date.now();
    const samples = this.samples.get(id) || [];
    samples.push([now, bytes]);
    const cutoff = now - 2000;
    while (samples.length && samples[0][0] < cutoff) samples.shift();
    this.samples.set(id, samples);
  }

  speedOf(id) {
    const samples = this.samples.get(id) || [];
    if (!samples.length) return 0;
    const sum = samples.reduce((total, sample) => total + sample[1], 0);
    const span = Math.max(0.4, (Date.now() - samples[0][0]) / 1000);
    return sum / span;
  }

  schedulePersist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persist().catch((err) => console.error(err));
    }, 800);
  }

  persist() {
    const job = this.persistTail.then(async () => {
      const payload = {
        settings: this.settings,
        tasks: this.tasks
          .filter((task) => task.status !== 'removed')
          .map((task) => ({
            ...task,
            segments: task.segments ? task.segments.map((segment) => ({ ...segment })) : task.segments,
          })),
      };
      await fsp.mkdir(this.dataDir, { recursive: true });
      const tmp = `${this.statePath}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(payload));
      await fsp.rename(tmp, this.statePath);
    });
    this.persistTail = job.catch((err) => {
      console.error('Failed to save downloads', err);
    });
    return job;
  }

  emitSoon(immediate) {
    if (immediate) {
      if (this.emitTimer) clearTimeout(this.emitTimer);
      this.emitTimer = null;
      this.emit('update', this.snapshot());
      return;
    }
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emit('update', this.snapshot());
    }, 200);
  }
}

function segmentRemaining(segment) {
  if (segment.end == null) return Infinity;
  return segment.end - segment.start + 1 - (segment.downloaded || 0);
}

function abortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

function httpError(res) {
  const error = new Error(`HTTP ${res.status} ${res.statusText}`.trim());
  error.status = res.status;
  if (res.status === 429 || res.status === 503) {
    error.code = 'THROTTLED';
    error.message = res.status === 429
      ? 'The server is limiting requests (HTTP 429). Try again in a few minutes.'
      : 'The server is busy (HTTP 503). Try again in a few minutes.';
    const header = res.headers.get('retry-after');
    if (header) {
      const seconds = Number(header);
      const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
      if (Number.isFinite(ms) && ms >= 0) error.retryAfter = Math.min(ms, 120000);
    }
  }
  return error;
}

function chooseConnections(total, requested) {
  const wanted = clamp(requested, 1, 32);
  return Math.min(wanted, Math.max(1, Math.floor(total / MIN_SEGMENT_BYTES)));
}

function buildSegments(total, count) {
  if (total == null) return [{ index: 0, start: 0, end: null, downloaded: 0 }];
  if (total <= 0) return [];
  const parts = Math.max(1, count);
  const base = Math.floor(total / parts);
  const segments = [];
  for (let i = 0; i < parts; i += 1) {
    const start = i * base;
    const end = i === parts - 1 ? total - 1 : (i + 1) * base - 1;
    if (start <= end) segments.push({ index: i, start, end, downloaded: 0 });
  }
  return segments;
}

async function fetchManual(rawUrl, { headers, signal, origin }) {
  let current = rawUrl;
  const seen = new Set();
  for (let hop = 0; hop < 10; hop += 1) {
    if (seen.has(current)) throw new Error('Redirect loop');
    seen.add(current);
    const nextHeaders = { ...headers };
    let hopOrigin = '';
    try {
      hopOrigin = new URL(current).origin;
    } catch {
      throw new Error('Invalid download URL');
    }
    if (hopOrigin !== origin) {
      delete nextHeaders.Cookie;
      delete nextHeaders.Referer;
    }
    const res = await fetch(current, { headers: nextHeaders, signal, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(res.status)) return { res, url: current };
    const location = res.headers.get('location');
    try { await res.body?.cancel(); } catch { /* ignore */ }
    if (!location) throw new Error('Redirect did not include a location');
    current = new URL(location, current).href;
  }
  throw new Error('Too many redirects');
}

function writeChunk(stream, buffer) {
  return new Promise((resolve, reject) => {
    if (stream.destroyed) {
      reject(new Error('File stream closed'));
      return;
    }
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('File stream closed'));
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      stream.off('error', onError);
      stream.off('close', onClose);
      stream.off('drain', onDrain);
    };
    stream.on('error', onError);
    if (stream.write(buffer)) {
      cleanup();
      resolve();
      return;
    }
    stream.on('close', onClose);
    stream.on('drain', onDrain);
  });
}

function closeStream(stream) {
  if (!stream || stream.destroyed || stream.closed || stream.writableEnded) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => resolve();
    stream.once('error', done);
    try {
      stream.end(done);
    } catch {
      resolve();
    }
  });
}

function pipeInto(file, destination) {
  return new Promise((resolve, reject) => {
    const input = fs.createReadStream(file);
    const fail = (err) => {
      input.destroy();
      reject(err);
    };
    input.on('error', fail);
    destination.on('error', fail);
    input.on('end', () => {
      destination.off('error', fail);
      resolve();
    });
    input.pipe(destination, { end: false });
  });
}

async function moveFile(source, destination) {
  try {
    await fsp.rename(source, destination);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    const input = fs.createReadStream(source);
    const output = fs.createWriteStream(destination);
    await new Promise((resolve, reject) => {
      input.on('error', reject);
      output.on('error', reject);
      output.on('finish', resolve);
      input.pipe(output);
    });
    await fsp.unlink(source);
  }
}

async function rmRetry(target) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await fsp.rm(target, { recursive: true, force: true });
      return;
    } catch (err) {
      if (err.code === 'ENOENT') return;
      if (attempt === 7) throw err;
      await delay(80 * (attempt + 1));
    }
  }
}

module.exports = DownloadManager;
