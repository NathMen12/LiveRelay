'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { once } = require('events');
const ffmpegPath = require('ffmpeg-static');
const { HLS } = require('./config');

const MAX_QUEUE_BYTES = 32 * 1024 * 1024;

class HlsTranscoder {
  constructor({ liveId, root = HLS.root, instance = '' }) {
    this.liveId = liveId;
    this.root = root;
    this.instance = instance ? String(instance) : '';
    this.dirName = this.instance ? `${liveId}-${this.instance}` : liveId;
    this.dir = path.join(root, this.dirName);
    this.playlistPath = path.join(this.dir, 'index.m3u8');
    this.url = `/hls/${this.dirName}/index.m3u8`;
    this.proc = null;
    this.queue = [];
    this.queueBytes = 0;
    this.writing = false;
    this.started = false;
    this.stopped = false;
    this.failed = false;
    this.ready = false;
    this.lastError = '';
    this.stderr = '';
    this.spawnPromise = this._spawn();
    this.readyPromise = this._waitForPlaylist();
    this.spawnPromise.catch(() => {});
    this.readyPromise.catch(() => {});
  }

  _spawn() {
    return (async () => {
      if (this.stopped) throw new Error('Transcodage arrêté.');
      await fsp.mkdir(this.dir, { recursive: true });
      if (this.stopped) throw new Error('Transcodage arrêté.');
      if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
        throw new Error('ffmpeg-static introuvable.');
      }

      const scale = `scale=${HLS.width}:${HLS.height}:force_original_aspect_ratio=decrease,pad=${HLS.width}:${HLS.height}:(ow-iw)/2:(oh-ih)/2`;
      const args = [
        '-hide_banner',
        '-loglevel', 'error',
        '-i', 'pipe:0',
        '-map', '0:v:0',
        '-map', '0:a:0?',
        '-vf', scale,
        '-r', String(HLS.fps),
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-profile:v', 'main',
        '-pix_fmt', 'yuv420p',
        '-b:v', String(HLS.videoBitrate),
        '-maxrate', String(HLS.videoBitrate),
        '-bufsize', String(HLS.videoBitrate * 2),
        '-g', String(HLS.fps),
        '-keyint_min', String(HLS.fps),
        '-sc_threshold', '0',
        '-c:a', 'aac',
        '-b:a', String(HLS.audioBitrate),
        '-ar', '48000',
        '-ac', '2',
        '-threads', '2',
        '-f', 'hls',
        '-hls_time', String(HLS.segmentSeconds),
        '-hls_list_size', String(HLS.playlistSize),
        '-hls_flags', 'delete_segments+append_list+omit_endlist+independent_segments+temp_file',
        '-hls_segment_filename', path.join(this.dir, 'segment%05d.ts'),
        this.playlistPath
      ];

      this.proc = spawn(ffmpegPath, args, {
        stdio: ['pipe', 'ignore', 'pipe']
      });

      this.proc.stderr.on('data', (chunk) => {
        this.stderr = (this.stderr + chunk.toString()).slice(-8192);
      });

      this.proc.on('error', (error) => {
        this._fail(error.message || 'Erreur ffmpeg.');
      });

      this.proc.on('close', (code) => {
        if (!this.stopped && !this.failed) {
          this._fail(`ffmpeg a quitté avec le code ${code}. ${this.stderr.trim()}`);
        }
      });
    })();
  }

  async _waitForPlaylist() {
    const startedAt = Date.now();
    while (Date.now() - startedAt < HLS.startTimeoutMs) {
      if (this.stopped) throw new Error('Transcodage arrêté.');
      if (this.failed) throw new Error(this.lastError || 'Échec du transcodage.');
      try {
        await fsp.access(this.playlistPath, fs.constants.R_OK);
        this.started = true;
        this.ready = true;
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    const message = 'Délai de préparation HLS dépassé.';
    this._fail(message);
    throw new Error(message);
  }

  write(chunk) {
    if (this.stopped || this.failed) return;
    if (!chunk || !chunk.length) return;
    if (this.queueBytes + chunk.length > MAX_QUEUE_BYTES) {
      this._fail('File HLS saturée.');
      return;
    }
    this.queue.push(chunk);
    this.queueBytes += chunk.length;
    this._drain();
  }

  _drain() {
    if (this.writing) return;
    this.writing = true;
    (async () => {
      try {
        await this.spawnPromise;
        while (this.queue.length && !this.stopped && !this.failed) {
          const chunk = this.queue.shift();
          this.queueBytes -= chunk.length;
          if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) break;
          if (!this.proc.stdin.write(chunk)) {
            await once(this.proc.stdin, 'drain');
          }
        }
      } catch (error) {
        this._fail(error.message || 'Erreur d’écriture ffmpeg.');
      } finally {
        this.writing = false;
        if (this.queue.length && !this.stopped && !this.failed) {
          this._drain();
        }
      }
    })();
  }

  _fail(message) {
    if (this.failed || this.stopped) return;
    this.failed = true;
    this.lastError = message;
    this.queue = [];
    this.queueBytes = 0;
    if (this.proc && !this.proc.killed) {
      try { this.proc.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }

  isReady() {
    return this.ready && !this.failed && !this.stopped;
  }

  getStatus() {
    return {
      url: this.url,
      ready: this.isReady(),
      failed: this.failed,
      error: this.lastError
    };
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.queue = [];
    this.queueBytes = 0;

    const proc = this.proc;
    if (proc) {
      try {
        if (proc.stdin && !proc.stdin.destroyed) proc.stdin.end();
      } catch { /* ignore */ }
      try { proc.kill(); } catch { /* ignore */ }
      if (proc.exitCode === null && proc.signalCode === null) {
        await Promise.race([
          once(proc, 'close').catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 1500))
        ]);
      }
    }

    try {
      await fsp.rm(this.dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

module.exports = { HlsTranscoder };