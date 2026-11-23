'use strict';

const { RESOLUTIONS, FPS_OPTIONS, computeAutoBitrate } = require('./config');

const MIME_TYPES = new Set([
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8',
  'video/webm;codecs=vp9'
]);

const ERROR_CODES = {
  VALIDATION: 'VALIDATION',
  STATE: 'STATE',
  NOT_FOUND: 'NOT_FOUND',
  LIMIT: 'LIMIT',
  UNAUTHORIZED: 'UNAUTHORIZED',
  UNSUPPORTED: 'UNSUPPORTED',
  RATE_LIMIT: 'RATE_LIMIT'
};

class AppError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AppError';
    this.code = code;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function isValidLiveId(value) {
  return typeof value === 'string' && /^[a-z0-9]{8,16}$/i.test(value);
}

function isValidToken(value) {
  return typeof value === 'string' && value.length >= 20 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
}

function normalizeMime(mimeType) {
  if (typeof mimeType !== 'string' || !MIME_TYPES.has(mimeType)) return '';
  if (mimeType.includes('vp9')) {
    return mimeType.includes('opus') ? 'video/webm; codecs="vp9,opus"' : 'video/webm; codecs="vp9"';
  }
  return mimeType.includes('opus') ? 'video/webm; codecs="vp8,opus"' : 'video/webm; codecs="vp8"';
}

function normalizeBitrate(value, resolution, fps) {
  if (value === 0 || value === '0' || value === 'auto' || value === '' || value === undefined || value === null) {
    return { ok: true, value: computeAutoBitrate(resolution, fps) };
  }
  const bitrate = Number(value);
  if (!Number.isFinite(bitrate) || bitrate < 500_000 || bitrate > 20_000_000) {
    return { ok: false, error: 'Bitrate invalide (500 kbps a 20 Mbps attendu).' };
  }
  return { ok: true, value: Math.round(bitrate) };
}

function validateCreate(message) {
  if (!isPlainObject(message)) {
    return { ok: false, error: 'Message create invalide.' };
  }
  const title = sanitizeText(message.title, 120);
  const host = sanitizeText(message.host, 40);
  if (!title) return { ok: false, error: 'Le titre du live est obligatoire.' };
  if (!host) return { ok: false, error: 'Le pseudo est obligatoire.' };
  if (!Object.prototype.hasOwnProperty.call(RESOLUTIONS, message.resolution)) {
    return { ok: false, error: 'Résolution invalide (480p, 720p, 1080p, 1440p).' };
  }
  const fps = Number(message.fps);
  if (!FPS_OPTIONS.includes(fps)) {
    return { ok: false, error: 'FPS invalide (15, 24, 30, 60).' };
  }
  const bitrate = normalizeBitrate(message.bitrate, message.resolution, fps);
  if (!bitrate.ok) return bitrate;
  return {
    ok: true,
    value: {
      title,
      host,
      resolution: message.resolution,
      fps,
      bitrate: bitrate.value
    }
  };
}

function validateHostAuth(message) {
  if (!isPlainObject(message)) {
    return { ok: false, error: 'Message host_auth invalide.' };
  }
  if (!isValidToken(message.token)) {
    return { ok: false, error: 'Token hôte invalide.' };
  }
  const mimeType = normalizeMime(message.mimeType);
  if (!mimeType) {
    return { ok: false, error: 'Codec WebM invalide ou non supporté.' };
  }
  const width = Number(message.width);
  const height = Number(message.height);
  const fps = Number(message.fps);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 7680 || height > 7680) {
    return { ok: false, error: 'Dimensions invalides.' };
  }
  if (!Number.isFinite(fps) || fps < 1 || fps > 120) {
    return { ok: false, error: 'FPS invalides.' };
  }
  if (typeof message.hasAudio !== 'boolean') {
    return { ok: false, error: 'hasAudio doit être un booléen.' };
  }
  const sourceWidth = Number.isFinite(Number(message.sourceWidth)) ? Math.max(0, Math.round(Number(message.sourceWidth))) : 0;
  const sourceHeight = Number.isFinite(Number(message.sourceHeight)) ? Math.max(0, Math.round(Number(message.sourceHeight))) : 0;
  const sourceFps = Number.isFinite(Number(message.sourceFps)) ? Math.max(0, Number(message.sourceFps)) : 0;
  const bitrate = message.bitrate === undefined || message.bitrate === null ? null : Number(message.bitrate);
  if (bitrate !== null && (!Number.isFinite(bitrate) || bitrate < 500_000 || bitrate > 20_000_000)) {
    return { ok: false, error: 'Bitrate invalide (500 kbps a 20 Mbps attendu).' };
  }
  return {
    ok: true,
    value: {
      mimeType,
      width,
      height,
      fps,
      bitrate: bitrate === null ? null : Math.round(bitrate),
      hasAudio: message.hasAudio,
      sourceWidth,
      sourceHeight,
      sourceFps,
      canvas: message.canvas === true
    }
  };
}

function validateHostResume(message) {
  if (!isPlainObject(message)) {
    return { ok: false, error: 'Message host_resume invalide.' };
  }
  if (!isValidLiveId(message.liveId)) {
    return { ok: false, error: 'Identifiant de live invalide.' };
  }
  if (!isValidToken(message.token)) {
    return { ok: false, error: 'Token hôte invalide.' };
  }
  return { ok: true, value: { liveId: message.liveId.toLowerCase(), token: message.token } };
}

function validateWatch(message) {
  if (!isPlainObject(message)) {
    return { ok: false, error: 'Message watch invalide.' };
  }
  if (!isValidLiveId(message.liveId)) {
    return { ok: false, error: 'Identifiant de live invalide.' };
  }
  return { ok: true, value: { liveId: message.liveId.toLowerCase() } };
}

function sendJSON(socket, payload) {
  if (!socket || socket.readyState !== 1) return false;
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function closeWith(socket, code, reason) {
  if (!socket) return;
  try {
    if (socket.readyState === 1) socket.close(code, reason);
    else socket.terminate();
  } catch {
    try { socket.terminate(); } catch { /* ignore */ }
  }
}

module.exports = {
  AppError,
  ERROR_CODES,
  MIME_TYPES,
  isPlainObject,
  sanitizeText,
  isValidLiveId,
  isValidToken,
  normalizeMime,
  normalizeBitrate,
  validateCreate,
  validateHostAuth,
  validateHostResume,
  validateWatch,
  sendJSON,
  closeWith
};