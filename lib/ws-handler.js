'use strict';

const crypto = require('crypto');
const {
  LIMITS,
  HLS,
  HOST_RESUME_GRACE_MS,
  HOST_NO_DATA_TIMEOUT_MS
} = require('./config');
const {
  AppError,
  ERROR_CODES,
  validateCreate,
  validateHostAuth,
  validateHostResume,
  validateWatch,
  sendJSON,
  closeWith
} = require('./protocol');
const { HlsTranscoder } = require('./hls-transcoder');

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function hlsUrlFor(liveId, instance) {
  const dirName = instance ? `${liveId}-${instance}` : liveId;
  return `/hls/${dirName}/index.m3u8`;
}

class RelayHandler {
  constructor(wss, registry) {
    this.wss = wss;
    this.registry = registry;
    this.listTimer = null;
    this.heartbeatTimer = null;
    this.closed = false;
  }

  attach(server) {
    server.on('upgrade', (req, socket, head) => {
      let pathname = req.url;
      try {
        pathname = new URL(req.url, 'http://localhost').pathname;
      } catch {
        socket.destroy();
        return;
      }
      if (pathname !== '/ws') {
        socket.destroy();
        return;
      }

      const origin = req.headers.origin;
      if (origin) {
        try {
          if (new URL(origin).host !== req.headers.host) {
            socket.destroy();
            return;
          }
        } catch {
          socket.destroy();
          return;
        }
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
      });
    });

    this.wss.on('connection', (ws) => this.onConnection(ws));
    this.wss.on('error', (error) => {
      console.error('[ws] server error:', error.message);
    });
  }

  start() {
    if (this.listTimer) return;
    this.listTimer = setInterval(() => this.broadcastLives(), LIMITS.listBroadcastIntervalMs);

    this.heartbeatTimer = setInterval(() => {
      for (const client of this.wss.clients) {
        if (client.role === 'host') continue;
        if (client.isAlive === false) {
          try { client.terminate(); } catch { /* ignore */ }
          continue;
        }
        client.isAlive = false;
        try { client.ping(); } catch { /* ignore */ }
      }
    }, LIMITS.heartbeatIntervalMs);

    if (this.listTimer.unref) this.listTimer.unref();
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
  }

  stopTimers() {
    if (this.listTimer) clearInterval(this.listTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.listTimer = null;
    this.heartbeatTimer = null;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.stopTimers();
    for (const client of Array.from(this.wss.clients)) {
      try { client.terminate(); } catch { /* ignore */ }
    }
    await new Promise((resolve) => {
      try { this.wss.close(() => resolve()); } catch { resolve(); }
    });
    this.registry.clear();
  }

  onConnection(ws) {
    if (this.wss.clients.size > LIMITS.maxConnections) {
      closeWith(ws, 1013, 'too many connections');
      return;
    }

    ws.isAlive = true;
    ws.role = null;
    ws.liveId = null;
    ws.isHost = false;
    ws.hostAuthed = false;
    ws.rateStart = Date.now();
    ws.rateCount = 0;
    ws.errorCount = 0;
    ws.slow = false;

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data, isBinary) => this.onMessage(ws, data, isBinary));
    ws.on('close', () => this.onClose(ws));
    ws.on('error', () => { /* close will follow */ });

    sendJSON(ws, {
      type: 'lives',
      lives: this.registry.list(Date.now()),
      serverNow: Date.now()
    });
  }

  onMessage(ws, data, isBinary) {
    if (!this.allowMessage(ws)) return;

    if (isBinary) {
      this.onBinary(ws, data);
      return;
    }

    const text = typeof data === 'string' ? data : data.toString();
    if (text.length > LIMITS.maxMessageBytes) {
      closeWith(ws, 1009, 'message too large');
      return;
    }

    let message;
    try {
      message = JSON.parse(text);
    } catch {
      ws.errorCount = (ws.errorCount || 0) + 1;
      sendJSON(ws, { type: 'error', code: ERROR_CODES.VALIDATION, message: 'JSON invalide.' });
      if (ws.errorCount >= 3) closeWith(ws, 1007, 'invalid payload');
      return;
    }

    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      sendJSON(ws, { type: 'error', code: ERROR_CODES.VALIDATION, message: 'Message invalide.' });
      return;
    }

    switch (message.type) {
      case 'create':
        this.handleCreate(ws, message);
        break;
      case 'host_auth':
        this.handleHostAuth(ws, message);
        break;
      case 'host_resume':
        this.handleHostResume(ws, message);
        break;
      case 'restart':
        this.handleRestart(ws);
        break;
      case 'watch':
        this.handleWatch(ws, message);
        break;
      case 'stop':
        this.handleStop(ws);
        break;
      case 'list':
        sendJSON(ws, {
          type: 'lives',
          lives: this.registry.list(Date.now()),
          serverNow: Date.now()
        });
        break;
      case 'ping':
        sendJSON(ws, { type: 'pong', serverNow: Date.now() });
        break;
      default:
        sendJSON(ws, {
          type: 'error',
          code: ERROR_CODES.VALIDATION,
          message: `Type de message inconnu: ${String(message.type).slice(0, 40)}`
        });
    }
  }

  allowMessage(ws) {
    const now = Date.now();
    if (now - ws.rateStart > LIMITS.rateWindowMs) {
      ws.rateStart = now;
      ws.rateCount = 0;
    }
    ws.rateCount += 1;
    if (ws.rateCount > LIMITS.rateMaxMessages) {
      closeWith(ws, 1008, 'rate limit exceeded');
      return false;
    }
    return true;
  }

  onBinary(ws, data) {
    if (!ws.isHost || !ws.hostAuthed) {
      closeWith(ws, 1008, 'host authentication required');
      return;
    }
    const live = this.registry.get(ws.liveId);
    if (!live || live.ended) {
      closeWith(ws, 1008, 'live is not active');
      return;
    }

    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (chunk.length > LIMITS.maxChunkBytes) {
      closeWith(ws, 1009, 'chunk too large');
      return;
    }
    if (chunk.length === 0) return;

    const isInit = !live.initSegment;
    if (isInit) live.initSegment = Buffer.from(chunk);
    live.lastChunkAt = Date.now();
    this.resetNoDataTimer(live);
    this.writeHls(live, chunk);

    for (const viewer of Array.from(live.viewers)) {
      if (viewer.readyState !== 1) {
        live.viewers.delete(viewer);
        continue;
      }
      if (viewer.slow) continue;
      if (viewer.bufferedAmount > LIMITS.viewerBufferHighWater) {
        viewer.slow = true;
        live.viewers.delete(viewer);
        closeWith(viewer, 1013, 'viewer too slow');
        continue;
      }
      this.sendMedia(viewer, chunk, isInit);
    }
  }

  countActiveHls() {
    let count = 0;
    for (const live of this.registry.lives.values()) {
      if (live.hls && !live.hls.stopped && !live.hls.failed) count += 1;
    }
    return count;
  }

  writeHls(live, chunk) {
    if (!HLS.enabled || live.hlsFailed) return;

    if (!live.hls) {
      if (this.countActiveHls() >= HLS.maxTranscoders) {
        live.hlsFailed = true;
        live.hlsError = 'Limite de transcodages HLS atteinte.';
        return;
      }
      live.hls = new HlsTranscoder({
        liveId: live.id,
        instance: live.restartCount > 0 ? String(live.restartCount) : ''
      });
      live.hlsUrl = live.hls.url;
      live.hls.write(chunk);
      return;
    }

    if (!live.hls.stopped && !live.hls.failed) {
      live.hls.write(chunk);
    } else if (live.hls.failed) {
      live.hlsFailed = true;
      live.hlsError = live.hls.lastError || 'Échec du transcodage HLS.';
    }
  }

  handleCreate(ws, message) {
    if (ws.role) {
      sendJSON(ws, { type: 'error', code: ERROR_CODES.STATE, message: 'Cette connexion a déjà un rôle.' });
      return;
    }

    const parsed = validateCreate(message);
    if (!parsed.ok) {
      sendJSON(ws, { type: 'error', code: ERROR_CODES.VALIDATION, message: parsed.error });
      return;
    }

    let live;
    try {
      live = this.registry.create(parsed.value);
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError(ERROR_CODES.LIMIT, error.message);
      sendJSON(ws, { type: 'error', code: appError.code, message: appError.message });
      return;
    }

    ws.role = 'host';
    ws.isHost = true;
    ws.hostAuthed = false;
    ws.liveId = live.id;
    live.hostSocket = ws;
    live.hlsUrl = HLS.enabled ? hlsUrlFor(live.id) : '';
    live.authTimer = setTimeout(() => {
      if (!live.ended && !live.hostAuthed) {
        this.endLive(live, 'host-auth-timeout');
      }
    }, 30_000);
    if (live.authTimer.unref) live.authTimer.unref();

    sendJSON(ws, {
      type: 'created',
      liveId: live.id,
      token: live.token,
      startedAt: live.startedAt,
      hlsUrl: live.hlsUrl
    });
    this.broadcastLives();
  }

  handleHostAuth(ws, message) {
    if (!ws.isHost || !ws.liveId) {
      sendJSON(ws, { type: 'error', code: ERROR_CODES.UNAUTHORIZED, message: 'Connexion hôte requise.' });
      return;
    }
    const live = this.registry.get(ws.liveId);
    if (!live || live.ended) {
      closeWith(ws, 1008, 'live is not active');
      return;
    }
    if (ws.hostAuthed) {
      sendJSON(ws, { type: 'error', code: ERROR_CODES.STATE, message: 'Hôte déjà authentifié.' });
      return;
    }

    const parsed = validateHostAuth(message);
    if (!parsed.ok) {
      sendJSON(ws, { type: 'error', code: ERROR_CODES.VALIDATION, message: parsed.error });
      return;
    }
    if (!safeEqual(message.token, live.token)) {
      closeWith(ws, 1008, 'invalid host token');
      return;
    }

    live.applyMetadata(parsed.value);
    live.hostAuthed = true;
    live.markHostConnected();
    ws.hostAuthed = true;
    if (live.authTimer) {
      clearTimeout(live.authTimer);
      live.authTimer = null;
    }
    this.resetNoDataTimer(live);

    sendJSON(ws, {
      type: 'host_ready',
      liveId: live.id,
      resumed: false,
      hlsUrl: live.hlsUrl,
      restartCount: live.restartCount
    });
    this.broadcastLives();
  }

  handleHostResume(ws, message) {
    if (ws.role) {
      sendJSON(ws, { type: 'error', code: ERROR_CODES.STATE, message: 'Cette connexion a déjà un rôle.' });
      return;
    }

    const parsed = validateHostResume(message);
    if (!parsed.ok) {
      sendJSON(ws, { type: 'error', code: ERROR_CODES.VALIDATION, message: parsed.error });
      return;
    }

    const live = this.registry.get(parsed.value.liveId);
    if (!live || live.ended) {
      sendJSON(ws, {
        type: 'error',
        code: ERROR_CODES.NOT_FOUND,
        message: 'Ce live est terminé.'
      });
      return;
    }
    if (!live.hostAuthed) {
      sendJSON(ws, {
        type: 'error',
        code: ERROR_CODES.STATE,
        message: 'Le live n’est pas encore prêt.'
      });
      return;
    }
    if (!safeEqual(parsed.value.token, live.token)) {
      closeWith(ws, 1008, 'invalid host token');
      return;
    }
    if (live.hostSocket && live.hostSocket !== ws && live.hostSocket.readyState === 1) {
      sendJSON(ws, {
        type: 'error',
        code: ERROR_CODES.STATE,
        message: 'Un hôte est déjà connecté.'
      });
      return;
    }

    ws.role = 'host';
    ws.isHost = true;
    ws.hostAuthed = true;
    ws.liveId = live.id;
    live.hostSocket = ws;
    live.markHostConnected();

    if (live.hostResumeTimer) {
      clearTimeout(live.hostResumeTimer);
      live.hostResumeTimer = null;
    }
    this.resetNoDataTimer(live);

    sendJSON(ws, {
      type: 'host_ready',
      liveId: live.id,
      resumed: true,
      hlsUrl: live.hlsUrl,
      restartCount: live.restartCount
    });

    for (const viewer of live.viewers) {
      sendJSON(viewer, { type: 'host_resumed' });
    }

    this.broadcastStats(live);
    this.broadcastLives();
  }

  handleWatch(ws, message) {
    if (ws.role) {
      sendJSON(ws, { type: 'error', code: ERROR_CODES.STATE, message: 'Cette connexion a déjà un rôle.' });
      return;
    }

    const parsed = validateWatch(message);
    if (!parsed.ok) {
      sendJSON(ws, { type: 'error', code: ERROR_CODES.VALIDATION, message: parsed.error });
      return;
    }

    const live = this.registry.get(parsed.value.liveId);
    if (!live || live.ended) {
      sendJSON(ws, {
        type: 'error',
        code: ERROR_CODES.NOT_FOUND,
        message: 'Ce live n’existe pas ou est terminé.'
      });
      return;
    }

    if (!live.hostAuthed) {
      sendJSON(ws, {
        type: 'error',
        code: ERROR_CODES.STATE,
        message: 'Le live démarre. Réessayez dans un instant.'
      });
      return;
    }

    if (!live.hostConnected) {
      sendJSON(ws, {
        type: 'error',
        code: ERROR_CODES.STATE,
        message: 'L’hôte est déconnecté. Reconnexion en cours…'
      });
      return;
    }

    if (live.viewers.size >= LIMITS.maxViewersPerLive) {
      sendJSON(ws, {
        type: 'error',
        code: ERROR_CODES.LIMIT,
        message: `Ce live a atteint la limite de ${LIMITS.maxViewersPerLive} spectateurs.`
      });
      return;
    }

    ws.role = 'viewer';
    ws.liveId = live.id;
    live.viewers.add(ws);

    sendJSON(ws, {
      type: 'welcome',
      live: live.toPublic(Date.now()),
      hlsReady: Boolean(live.hls && live.hls.isReady()),
      serverNow: Date.now()
    });

    if (live.initSegment) {
      this.sendMedia(ws, live.initSegment, true);
    }

    this.broadcastStats(live);
    this.broadcastLives();
  }

  handleStop(ws) {
    if (!ws.isHost || !ws.liveId) {
      sendJSON(ws, { type: 'error', code: ERROR_CODES.UNAUTHORIZED, message: 'Connexion hôte requise.' });
      return;
    }
    const live = this.registry.get(ws.liveId);
    if (!live || live.ended) {
      sendJSON(ws, { type: 'error', code: ERROR_CODES.NOT_FOUND, message: 'Live déjà terminé.' });
      return;
    }

    const liveId = live.id;
    this.endLive(live, 'host-stopped');
    sendJSON(ws, { type: 'stopped', liveId });
    setTimeout(() => {
      if (ws.readyState === 1) ws.close(1000, 'host stopped');
    }, 300);
  }

  handleRestart(ws) {
    if (!ws.isHost || !ws.liveId) {
      sendJSON(ws, { type: 'error', code: ERROR_CODES.UNAUTHORIZED, message: 'Connexion hôte requise.' });
      return;
    }
    const live = this.registry.get(ws.liveId);
    if (!live || live.ended) {
      sendJSON(ws, { type: 'error', code: ERROR_CODES.NOT_FOUND, message: 'Live déjà terminé.' });
      return;
    }

    live.initSegment = null;
    live.restartCount += 1;
    if (live.hls) {
      const previous = live.hls;
      live.hls = null;
      live.hlsFailed = false;
      live.hlsError = '';
      (async () => {
        try { await previous.stop(); } catch { /* ignore */ }
      })();
    }
    live.hlsUrl = HLS.enabled ? hlsUrlFor(live.id, live.restartCount) : '';

    for (const viewer of live.viewers) {
      sendJSON(viewer, {
        type: 'restart',
        restartCount: live.restartCount,
        hlsUrl: live.hlsUrl
      });
    }
    this.resetNoDataTimer(live);
    this.broadcastLives();
  }

  sendMedia(ws, buffer, isInit) {
    if (!ws || ws.readyState !== 1) return;
    if (ws.bufferedAmount > LIMITS.viewerBufferHighWater) {
      ws.slow = true;
      closeWith(ws, 1013, 'viewer too slow');
      return;
    }
    if (!sendJSON(ws, { type: 'media', init: isInit, size: buffer.length })) {
      ws.slow = true;
      closeWith(ws, 1013, 'viewer send failed');
      return;
    }
    try {
      ws.send(buffer);
    } catch {
      ws.slow = true;
      closeWith(ws, 1013, 'viewer send failed');
    }
  }

  broadcastStats(live) {
    if (!live || live.ended) return;
    const viewers = live.viewers.size;
    if (live.hostSocket && live.hostSocket.readyState === 1) {
      sendJSON(live.hostSocket, { type: 'stats', viewers });
    }
    for (const viewer of live.viewers) {
      sendJSON(viewer, { type: 'stats', viewers });
    }
  }

  broadcastLives() {
    if (this.closed) return;
    const payload = JSON.stringify({
      type: 'lives',
      lives: this.registry.list(Date.now()),
      serverNow: Date.now()
    });
    for (const client of this.wss.clients) {
      if (client.readyState !== 1) continue;
      try { client.send(payload); } catch { /* ignore */ }
    }
  }

  beginHostDisconnect(live) {
    if (this.closed || !live || live.ended || !live.hostConnected) return;
    live.markHostDisconnected();
    if (live.noDataTimer) {
      clearTimeout(live.noDataTimer);
      live.noDataTimer = null;
    }
    live.hostSocket = null;

    for (const viewer of live.viewers) {
      sendJSON(viewer, { type: 'host_disconnected', graceMs: HOST_RESUME_GRACE_MS });
    }

    if (live.hostResumeTimer) clearTimeout(live.hostResumeTimer);
    live.hostResumeTimer = setTimeout(() => {
      if (!live.ended && !live.hostConnected) {
        this.endLive(live, 'host-disconnected');
      }
    }, HOST_RESUME_GRACE_MS);
    if (live.hostResumeTimer.unref) live.hostResumeTimer.unref();

    this.broadcastLives();
  }

  resetNoDataTimer(live) {
    if (live.noDataTimer) {
      clearTimeout(live.noDataTimer);
      live.noDataTimer = null;
    }
    if (!live.hostAuthed || !live.hostConnected || live.ended) return;
    live.noDataTimer = setTimeout(() => {
      if (!live.ended && live.hostAuthed && live.hostConnected) {
        this.endLive(live, 'host-no-data');
      }
    }, HOST_NO_DATA_TIMEOUT_MS);
    if (live.noDataTimer.unref) live.noDataTimer.unref();
  }

  endLive(live, reason) {
    if (!live || live.ended) return;
    live.ended = true;
    live.endedAt = Date.now();
    live.hostConnected = false;

    const viewers = Array.from(live.viewers);
    live.viewers.clear();
    const host = live.hostSocket;
    live.hostSocket = null;
    live.initSegment = null;

    const hls = live.hls;
    live.hls = null;
    if (hls) {
      const timer = setTimeout(() => {
        (async () => {
          try { await hls.stop(); } catch { /* ignore */ }
        })();
      }, 1000);
      if (timer.unref) timer.unref();
    }

    this.registry.delete(live.id);

    for (const viewer of viewers) {
      if (viewer.readyState !== 1) continue;
      sendJSON(viewer, { type: 'ended', reason });
      const timer = setTimeout(() => {
        if (viewer.readyState === 1) viewer.close(1000, 'live ended');
      }, 1000);
      if (timer.unref) timer.unref();
    }

    if (host && host.readyState === 1) {
      sendJSON(host, { type: 'ended', reason });
    }

    this.broadcastLives();
  }

  onClose(ws) {
    if (this.closed) {
      ws.role = null;
      ws.liveId = null;
      ws.isHost = false;
      ws.hostAuthed = false;
      return;
    }

    const live = ws.liveId ? this.registry.get(ws.liveId) : null;

    if (ws.isHost && live && !live.ended) {
      if (live.hostSocket && live.hostSocket !== ws) {
        ws.role = null;
        ws.liveId = null;
        ws.isHost = false;
        ws.hostAuthed = false;
        return;
      }
      if (!live.hostAuthed) {
        this.endLive(live, 'host-disconnected');
      } else {
        this.beginHostDisconnect(live);
      }
    } else if (ws.role === 'viewer' && live && !live.ended) {
      live.viewers.delete(ws);
      this.broadcastStats(live);
      this.broadcastLives();
    }

    ws.role = null;
    ws.liveId = null;
    ws.isHost = false;
    ws.hostAuthed = false;
  }
}

module.exports = { RelayHandler };