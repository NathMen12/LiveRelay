'use strict';

const crypto = require('crypto');
const { RESOLUTIONS } = require('./config');
const { AppError, ERROR_CODES } = require('./protocol');

function generateLiveId(exists) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const id = crypto.randomBytes(5).toString('hex');
    if (!exists(id)) return id;
  }
  throw new AppError(ERROR_CODES.STATE, 'Impossible de générer un identifiant de live.');
}

function clearLiveTimers(live) {
  if (live.authTimer) {
    clearTimeout(live.authTimer);
    live.authTimer = null;
  }
  if (live.hostResumeTimer) {
    clearTimeout(live.hostResumeTimer);
    live.hostResumeTimer = null;
  }
  if (live.noDataTimer) {
    clearTimeout(live.noDataTimer);
    live.noDataTimer = null;
  }
}

function stopLiveHls(live) {
  if (live.hls && typeof live.hls.stop === 'function') {
    try { live.hls.stop(); } catch { /* ignore */ }
  }
}

class Live {
  constructor({ id, token, title, host, resolution, fps, bitrate, startedAt }) {
    const preset = RESOLUTIONS[resolution];
    this.id = id;
    this.token = token;
    this.title = title;
    this.host = host;
    this.resolution = resolution;
    this.fps = fps;
    this.bitrate = bitrate;
    this.width = preset.width;
    this.height = preset.height;
    this.startedAt = startedAt || Date.now();
    this.mimeType = '';
    this.hasAudio = false;
    this.sourceWidth = 0;
    this.sourceHeight = 0;
    this.sourceFps = 0;
    this.canvas = false;
    this.hostSocket = null;
    this.hostAuthed = false;
    this.hostConnected = true;
    this.hostDisconnectedAt = null;
    this.viewers = new Set();
    this.initSegment = null;
    this.lastChunkAt = 0;
    this.ended = false;
    this.endedAt = null;
    this.authTimer = null;
    this.hostResumeTimer = null;
    this.noDataTimer = null;
    this.hls = null;
    this.hlsUrl = '';
    this.restartCount = 0;
  }

  applyMetadata(metadata) {
    this.mimeType = metadata.mimeType;
    this.hasAudio = metadata.hasAudio;
    this.width = metadata.width || this.width;
    this.height = metadata.height || this.height;
    this.fps = metadata.fps || this.fps;
    if (metadata.bitrate) this.bitrate = metadata.bitrate;
    this.sourceWidth = metadata.sourceWidth;
    this.sourceHeight = metadata.sourceHeight;
    this.sourceFps = metadata.sourceFps;
    this.canvas = metadata.canvas;
  }

  markHostDisconnected() {
    this.hostConnected = false;
    this.hostDisconnectedAt = Date.now();
  }

  markHostConnected() {
    this.hostConnected = true;
    this.hostDisconnectedAt = null;
  }

  toPublic(now) {
    return {
      id: this.id,
      title: this.title,
      host: this.host,
      resolution: this.resolution,
      fps: this.fps,
      bitrate: this.bitrate,
      width: this.width,
      height: this.height,
      viewers: this.viewers.size,
      startedAt: this.startedAt,
      elapsed: Math.max(0, now - this.startedAt),
      mimeType: this.mimeType,
      hasAudio: this.hasAudio,
      sourceWidth: this.sourceWidth,
      sourceHeight: this.sourceHeight,
      sourceFps: this.sourceFps,
      canvas: this.canvas,
      hostConnected: this.hostConnected,
      hlsUrl: this.hlsUrl
    };
  }
}

class LiveRegistry {
  constructor(limits) {
    this.limits = limits;
    this.lives = new Map();
  }

  get size() {
    return this.lives.size;
  }

  get(id) {
    if (typeof id !== 'string') return null;
    return this.lives.get(id.toLowerCase()) || null;
  }

  create({ title, host, resolution, fps, bitrate }) {
    if (this.lives.size >= this.limits.maxLives) {
      throw new AppError(
        ERROR_CODES.LIMIT,
        `Limite de ${this.limits.maxLives} lives simultanes atteinte.`
      );
    }
    const id = generateLiveId((candidate) => this.lives.has(candidate));
    const token = crypto.randomBytes(24).toString('base64url');
    const live = new Live({ id, token, title, host, resolution, fps, bitrate });
    this.lives.set(id, live);
    return live;
  }

  list(now = Date.now()) {
    return Array.from(this.lives.values())
      .filter((live) => !live.ended && live.hostAuthed && live.hostConnected)
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((live) => live.toPublic(now));
  }

  delete(id) {
    const live = this.lives.get(id);
    if (live) {
      clearLiveTimers(live);
      stopLiveHls(live);
      live.hls = null;
      live.viewers.clear();
      live.initSegment = null;
      live.hostSocket = null;
    }
    return this.lives.delete(id);
  }

  clear() {
    for (const live of this.lives.values()) {
      clearLiveTimers(live);
      stopLiveHls(live);
    }
    this.lives.clear();
  }

  totals() {
    let viewers = 0;
    for (const live of this.lives.values()) {
      if (!live.ended) viewers += live.viewers.size;
    }
    return { lives: this.size, viewers };
  }
}

module.exports = { Live, LiveRegistry, generateLiveId, clearLiveTimers, stopLiveHls };