'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const { PORT, LIMITS, HLS } = require('./lib/config');
const { LiveRegistry } = require('./lib/registry');
const { RelayHandler } = require('./lib/ws-handler');

function createApp(registry) {
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  app.get('/api/lives', (req, res) => {
    res.json({
      lives: registry.list(Date.now()),
      serverNow: Date.now()
    });
  });

  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      uptime: Math.round(process.uptime()),
      lives: registry.size,
      connections: app.locals.wss ? app.locals.wss.clients.size : 0,
      hls: HLS.enabled
    });
  });

  if (HLS.enabled) {
    app.use('/hls', express.static(HLS.root, {
      maxAge: 0,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.m3u8')) {
          res.setHeader('Cache-Control', 'no-store');
        } else if (filePath.endsWith('.ts')) {
          res.setHeader('Cache-Control', 'public, max-age=1');
        }
      }
    }));
  }

  app.use(express.static(path.join(__dirname, 'public'), {
    extensions: ['html'],
    maxAge: 0
  }));

  app.use((req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  return app;
}

function createLiveRelay() {
  if (HLS.enabled) {
    try {
      fs.rmSync(HLS.root, { recursive: true, force: true });
      fs.mkdirSync(HLS.root, { recursive: true });
    } catch (error) {
      console.error('[hls] impossible de preparer le dossier:', error.message);
    }
  }

  const registry = new LiveRegistry(LIMITS);
  const app = createApp(registry);
  const server = http.createServer(app);

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: LIMITS.maxChunkBytes,
    perMessageDeflate: false,
    clientTracking: true,
    maxBufferedChunks: LIMITS.maxBufferedChunks
  });

  app.locals.wss = wss;
  app.locals.registry = registry;
  app.locals.hls = HLS;

  const handler = new RelayHandler(wss, registry);
  handler.attach(server);

  let started = false;

  function start(port = PORT) {
    if (started) return Promise.resolve(server.address().port);
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const onListening = () => {
        cleanup();
        started = true;
        handler.start();
        resolve(server.address().port);
      };
      function cleanup() {
        server.off('error', onError);
        server.off('listening', onListening);
      }
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port);
    });
  }

  async function close() {
    await handler.close();
    if (!started) return;
    await new Promise((resolve) => {
      server.close(() => resolve());
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
    });
    started = false;
  }

  return { app, server, wss, registry, handler, start, close };
}

if (require.main === module) {
  const relay = createLiveRelay();
  let shuttingDown = false;

  relay.start()
    .then((port) => {
      console.log('');
      console.log('  LiveRelay demarre');
      console.log(`  HTTP      http://localhost:${port}`);
      console.log(`  WebSocket ws://localhost:${port}/ws`);
      if (HLS.enabled) console.log(`  HLS       http://localhost:${port}/hls/<liveId>/index.m3u8`);
      console.log('');
    })
    .catch((error) => {
      console.error('Impossible de demarrer LiveRelay:', error.message);
      process.exitCode = 1;
    });

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nArret de LiveRelay...');
    try {
      await relay.close();
    } catch (error) {
      console.error(error);
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createLiveRelay, createApp };