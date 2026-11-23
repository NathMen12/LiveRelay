'use strict';

const os = require('os');
const path = require('path');

function parsePort(value) {
  const port = Number.parseInt(value, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) return 3000;
  return port;
}

const RESOLUTIONS = {
  '480p': { width: 854, height: 480, label: '480p (854x480)', baseBitrate: 1_200_000 },
  '720p': { width: 1280, height: 720, label: '720p (1280x720)', baseBitrate: 2_500_000 },
  '1080p': { width: 1920, height: 1080, label: '1080p (1920x1080)', baseBitrate: 4_500_000 },
  '1440p': { width: 2560, height: 1440, label: '1440p (2560x1440)', baseBitrate: 8_000_000 }
};

const FPS_OPTIONS = [15, 24, 30, 60];
const BITRATE_PRESETS = [1_500_000, 2_500_000, 4_000_000, 6_000_000, 8_000_000, 12_000_000];

const HOST_RESUME_GRACE_MS = Number.parseInt(process.env.HOST_RESUME_GRACE_MS, 10) || 15_000;
const HOST_NO_DATA_TIMEOUT_MS = Number.parseInt(process.env.HOST_NO_DATA_TIMEOUT_MS, 10) || 120_000;

const LIMITS = {
  maxLives: 20,
  maxViewersPerLive: 100,
  maxConnections: 300,
  maxChunkBytes: 4 * 1024 * 1024,
  maxMessageBytes: 64 * 1024,
  maxTitleLength: 120,
  maxHostLength: 40,
  rateWindowMs: 10_000,
  rateMaxMessages: 180,
  viewerBufferHighWater: 4 * 1024 * 1024,
  hostBufferHighWater: 8 * 1024 * 1024,
  maxBufferedChunks: 128,
  heartbeatIntervalMs: 30_000,
  listBroadcastIntervalMs: 1_000
};

const HLS = {
  enabled: process.env.HLS_DISABLED !== '1',
  root: process.env.HLS_ROOT
    ? path.resolve(process.env.HLS_ROOT)
    : path.join(os.tmpdir(), 'liverelay-hls'),
  width: 1280,
  height: 720,
  fps: 30,
  videoBitrate: 2_500_000,
  audioBitrate: 128_000,
  segmentSeconds: 1,
  playlistSize: 6,
  maxTranscoders: 8,
  startTimeoutMs: 15_000
};

function computeAutoBitrate(resolution, fps) {
  const preset = RESOLUTIONS[resolution];
  if (!preset || !FPS_OPTIONS.includes(fps)) return 2_500_000;
  const raw = preset.baseBitrate * (fps / 30);
  return Math.min(12_000_000, Math.max(500_000, Math.round(raw / 100_000) * 100_000));
}

module.exports = {
  PORT: parsePort(process.env.PORT),
  RESOLUTIONS,
  FPS_OPTIONS,
  BITRATE_PRESETS,
  LIMITS,
  HLS,
  HOST_RESUME_GRACE_MS,
  HOST_NO_DATA_TIMEOUT_MS,
  computeAutoBitrate
};