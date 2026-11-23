'use strict';

(function () {
  const { qs, formatDuration, formatBitrate, wsUrl, setStatus, redirectHome } = window.LIVERelay;

  const TARGET_LATENCY = 2;
  const CATCHUP_THRESHOLD = 6;
  const MAX_HLS_RETRIES = 30;
  const transportParam = new URLSearchParams(window.location.search).get('transport');

  let els = {};
  let liveId = null;
  let socket = null;
  let connectionId = 0;
  let mediaSource = null;
  let sourceBuffer = null;
  let pending = [];
  let pendingKind = 'chunk';
  let ended = false;
  let reconnectTimer = null;
  let hlsRetryTimer = null;
  let hlsRetryAttempts = 0;
  let attempts = 0;
  let serverOffset = 0;
  let startedAt = 0;
  let viewers = 0;
  let playStarted = false;
  let lastEdgeCheck = 0;
  let lastEvict = 0;
  let objectUrl = null;
  let currentLive = null;
  let overlayAction = null;
  let durationTimer = null;
  let useHls = false;
  let hostConnected = true;
  let mediaErrorCount = 0;
  let mediaErrorResetTimer = null;

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    els = {
      video: qs('#video'),
      overlay: qs('#overlay'),
      overlayText: qs('#overlayText'),
      overlayBtn: qs('#overlayBtn'),
      status: qs('#watchStatus'),
      title: qs('#watchTitle'),
      host: qs('#watchHost'),
      quality: qs('#watchQuality'),
      viewers: qs('#watchViewers'),
      duration: qs('#watchDuration'),
      fullscreenBtn: qs('#fullscreenBtn'),
      playPauseBtn: qs('#playPauseBtn'),
      muteBtn: qs('#muteBtn'),
      bufferingBadge: qs('#bufferingBadge'),
      hostBanner: qs('#hostBanner')
    };

    liveId = new URLSearchParams(window.location.search).get('live');
    if (!liveId) {
      showFatal('Identifiant de live manquant.');
      return;
    }

    els.overlayBtn.addEventListener('click', () => {
      if (typeof overlayAction === 'function') overlayAction();
    });

    if (els.fullscreenBtn) {
      els.fullscreenBtn.addEventListener('click', () => {
        if (document.fullscreenElement) {
          document.exitFullscreen().catch(() => {});
        } else if (els.video.requestFullscreen) {
          els.video.requestFullscreen().catch(() => {});
        }
      });
    }

    if (els.playPauseBtn) els.playPauseBtn.addEventListener('click', togglePlay);
    if (els.muteBtn) els.muteBtn.addEventListener('click', toggleMute);

    els.video.addEventListener('click', togglePlay);
    els.video.addEventListener('play', updatePlayButton);
    els.video.addEventListener('pause', updatePlayButton);
    els.video.addEventListener('volumechange', updateMuteButton);
    els.video.addEventListener('playing', () => {
      hideOverlay();
      setBuffering(false);
      if (!ended && hostConnected) {
        setStatus(els.status, useHls ? 'En direct (HLS)' : 'En direct', 'live');
      }
      if (mediaErrorResetTimer) window.clearTimeout(mediaErrorResetTimer);
      mediaErrorResetTimer = window.setTimeout(() => {
        mediaErrorCount = 0;
      }, 10_000);
    });
    els.video.addEventListener('waiting', () => setBuffering(true));
    els.video.addEventListener('canplay', () => setBuffering(false));
    els.video.addEventListener('loadedmetadata', handleLoadedMetadata);
    els.video.addEventListener('error', handleMediaError);
    els.video.addEventListener('progress', updateLiveEdge);
    els.video.addEventListener('timeupdate', updateLiveEdge);

    updatePlayButton();
    updateMuteButton();

    window.addEventListener('pagehide', () => {
      if (hlsRetryTimer) window.clearTimeout(hlsRetryTimer);
      try { if (socket) socket.close(); } catch { /* ignore */ }
      teardownMSE();
    });

    durationTimer = window.setInterval(() => {
      if (!startedAt) return;
      els.duration.textContent = formatDuration(Date.now() + serverOffset - startedAt);
    }, 1000);

    connect();
  }

  function shouldUseHls() {
    if (!currentLive || !currentLive.hlsUrl) return false;
    if (transportParam === 'mse') return false;
    if (transportParam === 'hls') return true;
    const canNativeHls = els.video.canPlayType('application/vnd.apple.mpegurl') !== '';
    const isApple = /iPad|iPhone|iPod|Macintosh/.test(navigator.userAgent);
    const canWebm = Boolean(
      window.MediaSource &&
      typeof MediaSource.isTypeSupported === 'function' &&
      MediaSource.isTypeSupported('video/webm; codecs="vp8,opus"')
    );
    return canNativeHls || isApple || !canWebm;
  }

  function connect() {
    if (ended) return;
    const thisConnection = ++connectionId;
    if (socket) {
      try { socket.close(); } catch { /* ignore */ }
    }

    setStatus(els.status, 'Connexion…', 'connecting');
    socket = new WebSocket(wsUrl('/ws'));
    socket.binaryType = 'arraybuffer';

    socket.addEventListener('open', () => {
      if (thisConnection !== connectionId) return;
      attempts = 0;
      socket.send(JSON.stringify({ type: 'watch', liveId }));
    });

    socket.addEventListener('message', (event) => {
      if (thisConnection !== connectionId) return;
      handleMessage(event);
    });

    socket.addEventListener('close', () => {
      if (thisConnection !== connectionId) return;
      socket = null;
      if (ended) return;
      if (!useHls) teardownMSE();
      setStatus(els.status, 'Reconnexion…', 'reconnecting');
      scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      if (thisConnection !== connectionId) return;
      try { socket.close(); } catch { /* ignore */ }
    });
  }

  async function handleMessage(event) {
    if (typeof event.data === 'string') {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      switch (message.type) {
        case 'welcome':
          handleWelcome(message);
          return;
        case 'media':
          if (!useHls) pendingKind = message.init ? 'init' : 'chunk';
          return;
        case 'stats':
          viewers = Number(message.viewers) || 0;
          updateViewers();
          return;
        case 'host_disconnected':
          hostConnected = false;
          if (els.hostBanner) els.hostBanner.hidden = false;
          setStatus(els.status, 'Hôte déconnecté…', 'reconnecting');
          return;
        case 'host_resumed':
          hostConnected = true;
          if (els.hostBanner) els.hostBanner.hidden = true;
          setStatus(els.status, useHls ? 'En direct (HLS)' : 'En direct', 'live');
          return;
        case 'restart':
          handleRestart(message);
          return;
        case 'ended':
          handleEnded();
          return;
        case 'error':
          handleServerError(message);
          return;
        default:
          return;
      }
    }

    if (useHls) return;

    const kind = pendingKind;
    let buffer = event.data;
    if (buffer instanceof Blob) {
      buffer = await buffer.arrayBuffer();
    }
    if (!buffer || !buffer.byteLength) return;

    if (!sourceBuffer) {
      pending.push({ buffer, kind });
      return;
    }
    appendChunk(buffer, kind);
  }

  function handleWelcome(message) {
    currentLive = message.live;
    startedAt = Number(currentLive.startedAt) || Date.now();
    viewers = Number(currentLive.viewers) || 0;
    hostConnected = currentLive.hostConnected !== false;
    serverOffset = (Number(message.serverNow) || Date.now()) - Date.now();
    if (els.hostBanner) els.hostBanner.hidden = hostConnected;
    updateMeta();

    if (shouldUseHls()) {
      if (!useHls || !els.video.src || !els.video.src.includes(currentLive.hlsUrl)) {
        setupHlsPlayer();
      } else {
        setStatus(els.status, 'En direct (HLS)', 'live');
        attemptPlay();
      }
      return;
    }

    setStatus(els.status, 'En direct', 'live');
    setupMSE(currentLive.mimeType);
  }

  function setupHlsPlayer() {
    teardownMSE();
    useHls = true;
    hlsRetryAttempts = 0;
    loadHls();
  }

  function loadHls() {
    if (ended) return;
    if (!currentLive || !currentLive.hlsUrl) {
      showFatal('Flux HLS indisponible.');
      return;
    }
    const base = currentLive.hlsUrl;
    const url = hlsRetryAttempts > 0 ? `${base}?retry=${Date.now()}` : base;
    els.video.src = url;
    els.video.load();
    if (hlsRetryAttempts > 0) {
      setStatus(els.status, 'Préparation du flux HLS…', 'reconnecting');
    } else {
      setStatus(els.status, 'En direct (HLS)', 'live');
    }
    attemptPlay();
  }

  function handleLoadedMetadata() {
    if (useHls) {
      hlsRetryAttempts = 0;
      setStatus(els.status, 'En direct (HLS)', 'live');
      attemptPlay();
      return;
    }
    updateLiveEdge();
  }

  function handleMediaError() {
    if (ended) return;
    if (useHls) {
      if (hlsRetryAttempts >= MAX_HLS_RETRIES) {
        showFatal('Flux HLS indisponible. Le serveur n’a pas pu préparer la vidéo.');
        return;
      }
      hlsRetryAttempts += 1;
      setStatus(els.status, `Préparation du flux HLS… (${hlsRetryAttempts})`, 'reconnecting');
      if (hlsRetryTimer) window.clearTimeout(hlsRetryTimer);
      hlsRetryTimer = window.setTimeout(loadHls, 1000);
      return;
    }
    if (!els.video.error) return;
    const code = els.video.error.code;
    console.warn('video error', code, els.video.error.message);
    if (code === 3 || code === 4) {
      mediaErrorCount += 1;
      if (mediaErrorCount > 10) {
        showFatal('Erreur de lecture du flux.');
        return;
      }
      setStatus(els.status, 'Reconnexion…', 'reconnecting');
      try { if (socket) socket.close(); } catch { /* ignore */ }
      return;
    }
    showFatal('Erreur de lecture du flux.');
  }

  function handleRestart(message) {
    if (ended) return;
    if (message && message.hlsUrl && currentLive) {
      currentLive.hlsUrl = message.hlsUrl;
    }
    if (useHls) {
      hlsRetryAttempts = 1;
      if (hlsRetryTimer) window.clearTimeout(hlsRetryTimer);
      loadHls();
      return;
    }
    teardownMSE();
    playStarted = false;
    pending = [];
    pendingKind = 'chunk';
    setStatus(els.status, 'Reconnexion…', 'reconnecting');
    setupMSE(currentLive && currentLive.mimeType);
  }

  function setupMSE(mimeType) {
    teardownMSE();
    const mime = mimeType || 'video/webm;codecs=vp8,opus';

    if (!window.MediaSource || typeof MediaSource.isTypeSupported !== 'function' || !MediaSource.isTypeSupported(mime)) {
      showFatal(`Ce navigateur ne supporte pas le codec ${mime}. Essayez Chrome ou Edge.`);
      return;
    }

    mediaSource = new MediaSource();
    mediaSource.addEventListener('sourceopen', () => {
      if (!mediaSource) return;
      try {
        sourceBuffer = mediaSource.addSourceBuffer(mime);
        try { sourceBuffer.mode = 'sequence'; } catch { /* segments restera le mode par defaut */ }
        sourceBuffer.addEventListener('updateend', onUpdateEnd);
        sourceBuffer.addEventListener('error', onSourceBufferError);
        drain();
      } catch (error) {
        showFatal(`Impossible d’initialiser le lecteur: ${error.message}`);
      }
    });

    objectUrl = URL.createObjectURL(mediaSource);
    els.video.src = objectUrl;
    els.video.load();
  }

  function teardownMSE() {
    if (sourceBuffer) {
      try { sourceBuffer.removeEventListener('updateend', onUpdateEnd); } catch { /* ignore */ }
      try { sourceBuffer.removeEventListener('error', onSourceBufferError); } catch { /* ignore */ }
    }
    try {
      if (mediaSource && mediaSource.readyState === 'open') mediaSource.endOfStream();
    } catch {
      /* ignore */
    }
    try {
      els.video.removeAttribute('src');
      els.video.load();
    } catch {
      /* ignore */
    }
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
    if (hlsRetryTimer) {
      window.clearTimeout(hlsRetryTimer);
      hlsRetryTimer = null;
    }
    mediaSource = null;
    sourceBuffer = null;
    pending = [];
    pendingKind = 'chunk';
    playStarted = false;
    lastEvict = 0;
    useHls = false;
  }

  function appendChunk(buffer, kind) {
    pending.push({ buffer, kind });
    drain();
  }

  function drain() {
    if (!sourceBuffer || sourceBuffer.updating || !pending.length) return;
    const item = pending.shift();
    try {
      sourceBuffer.appendBuffer(item.buffer);
    } catch (error) {
      handleAppendError(error, item);
    }
  }

  function onUpdateEnd() {
    evictIfNeeded();
    drain();
    updateLiveEdge();
  }

  function onSourceBufferError() {
    if (ended) return;
    console.error('SourceBuffer error');
  }

  function handleAppendError(error, item) {
    if (!sourceBuffer) return;
    if (error && error.name === 'QuotaExceededError') {
      try {
        const buffered = sourceBuffer.buffered;
        const end = buffered.length ? buffered.end(buffered.length - 1) : 0;
        sourceBuffer.remove(0, Math.max(0, end - 20));
      } catch {
        showFatal('Mémoire vidéo saturée. Rechargez la page.');
        return;
      }
      pending.unshift(item);
      return;
    }
    if (error && error.name === 'InvalidStateError') {
      teardownMSE();
      return;
    }
    console.error('appendBuffer error:', error);
    showFatal(`Erreur de lecture: ${error.message || 'flux invalide'}`);
  }

  function evictIfNeeded() {
    if (!sourceBuffer || sourceBuffer.updating) return;
    const now = performance.now();
    if (now - lastEvict < 5000) return;
    const buffered = sourceBuffer.buffered;
    if (!buffered.length) return;
    const end = buffered.end(buffered.length - 1);
    if (end <= 90) return;
    const removeTo = Math.max(0, Math.min(els.video.currentTime - 20, end - 60));
    if (removeTo > 0) {
      lastEvict = now;
      try { sourceBuffer.remove(0, removeTo); } catch { /* ignore */ }
    }
  }

  function updateLiveEdge() {
    if (useHls) return;
    const buffered = els.video.buffered;
    if (!buffered.length) return;
    const lastEnd = buffered.end(buffered.length - 1);
    const lastStart = buffered.start(buffered.length - 1);

    if (!playStarted) {
      if (lastEnd - lastStart < 0.2) return;
      playStarted = true;
      const target = Math.max(lastStart + 0.05, lastEnd - TARGET_LATENCY);
      try { els.video.currentTime = target; } catch { /* ignore */ }
      attemptPlay();
      return;
    }

    const now = performance.now();
    if (now - lastEdgeCheck < 1000) return;
    lastEdgeCheck = now;

    const currentTime = els.video.currentTime;
    const inBuffered = isTimeInRanges(currentTime, buffered);
    if (!inBuffered || currentTime < lastEnd - CATCHUP_THRESHOLD) {
      const target = Math.max(lastStart + 0.05, lastEnd - TARGET_LATENCY);
      try { els.video.currentTime = target; } catch { /* ignore */ }
      if (els.video.paused) attemptPlay();
    }
  }

  function isTimeInRanges(time, ranges) {
    for (let index = 0; index < ranges.length; index += 1) {
      if (time >= ranges.start(index) - 0.05 && time <= ranges.end(index) + 0.05) return true;
    }
    return false;
  }

  function attemptPlay() {
    if (ended) return;
    const promise = els.video.play();
    if (!promise || typeof promise.catch !== 'function') return;

    promise.catch(() => {
      els.video.muted = true;
      els.video.play().then(() => {
        if (!currentLive || !currentLive.hasAudio) {
          hideOverlay();
          return;
        }
        showOverlay('Lecture silencieuse.', 'Activer le son', () => {
          els.video.muted = false;
          els.video.play().catch(() => {});
          hideOverlay();
        });
      }).catch(() => {
        showOverlay('Cliquez pour lire le direct.', 'Lire', () => {
          els.video.muted = false;
          els.video.play().catch(() => {});
          hideOverlay();
        });
      });
    });
  }

  function togglePlay() {
    if (ended) return;
    if (els.video.paused) attemptPlay();
    else els.video.pause();
  }

  function toggleMute() {
    els.video.muted = !els.video.muted;
    updateMuteButton();
    if (!els.video.muted && els.video.paused) attemptPlay();
  }

  function updatePlayButton() {
    if (!els.playPauseBtn) return;
    els.playPauseBtn.textContent = els.video.paused ? 'Lecture' : 'Pause';
  }

  function updateMuteButton() {
    if (!els.muteBtn) return;
    els.muteBtn.textContent = els.video.muted ? 'Activer le son' : 'Couper le son';
  }

  function setBuffering(on) {
    if (!els.bufferingBadge) return;
    els.bufferingBadge.hidden = !on || ended;
  }

  function showOverlay(text, buttonText, action) {
    els.overlayText.textContent = text;
    els.overlayBtn.textContent = buttonText || 'OK';
    els.overlay.hidden = false;
    overlayAction = action || null;
  }

  function hideOverlay() {
    els.overlay.hidden = true;
    overlayAction = null;
  }

  function handleEnded() {
    if (ended) return;
    ended = true;
    window.clearTimeout(reconnectTimer);
    if (hlsRetryTimer) window.clearTimeout(hlsRetryTimer);
    try { if (socket) socket.close(); } catch { /* ignore */ }
    try { els.video.pause(); } catch { /* ignore */ }
    teardownMSE();
    if (els.hostBanner) els.hostBanner.hidden = true;
    viewers = 0;
    updateViewers();
    setStatus(els.status, 'Terminé', 'ended');
    showOverlay('Le live est terminé.', 'Retour à la liste', () => redirectHome());
    window.setTimeout(() => {
      if (ended) redirectHome();
    }, 4000);
  }

  function handleServerError(message) {
    if (ended) return;
    if (message.code === 'STATE') {
      if (!useHls) teardownMSE();
      scheduleReconnect();
      return;
    }
    if (message.code === 'NOT_FOUND') {
      ended = true;
      window.clearTimeout(reconnectTimer);
      if (hlsRetryTimer) window.clearTimeout(hlsRetryTimer);
      try { if (socket) socket.close(); } catch { /* ignore */ }
      try { els.video.pause(); } catch { /* ignore */ }
      teardownMSE();
      setStatus(els.status, 'Terminé', 'ended');
      showOverlay('Ce live n’existe plus.', 'Retour à la liste', () => redirectHome());
      window.setTimeout(() => redirectHome(), 4000);
      return;
    }
    if (message.code === 'LIMIT') {
      ended = true;
      window.clearTimeout(reconnectTimer);
      if (hlsRetryTimer) window.clearTimeout(hlsRetryTimer);
      try { if (socket) socket.close(); } catch { /* ignore */ }
      try { els.video.pause(); } catch { /* ignore */ }
      teardownMSE();
      setStatus(els.status, 'Complet', 'error');
      showOverlay('Ce live est complet.', 'Retour à la liste', () => redirectHome());
      window.setTimeout(() => redirectHome(), 4000);
      return;
    }
    showFatal(message.message || 'Erreur du serveur.');
  }

  function showFatal(text) {
    if (ended) return;
    ended = true;
    window.clearTimeout(reconnectTimer);
    if (hlsRetryTimer) window.clearTimeout(hlsRetryTimer);
    try { if (socket) socket.close(); } catch { /* ignore */ }
    try { els.video.pause(); } catch { /* ignore */ }
    teardownMSE();
    if (els.hostBanner) els.hostBanner.hidden = true;
    setStatus(els.status, 'Erreur', 'error');
    showOverlay(text, 'Retour à la liste', () => redirectHome());
    window.setTimeout(() => {
      if (ended) redirectHome();
    }, 5000);
  }

  function scheduleReconnect() {
    if (ended) return;
    window.clearTimeout(reconnectTimer);
    attempts += 1;
    if (attempts > 20) {
      setStatus(els.status, 'Serveur injoignable', 'error');
      if (!useHls) {
        showOverlay('Serveur injoignable.', 'Réessayer', () => {
          hideOverlay();
          attempts = 0;
          connect();
        });
      }
      return;
    }
    const delay = Math.min(500 * Math.pow(2, Math.min(attempts - 1, 5)), 5000);
    setStatus(els.status, `Reconnexion dans ${Math.ceil(delay / 1000)} s…`, 'reconnecting');
    reconnectTimer = window.setTimeout(connect, delay);
  }

  function updateMeta() {
    if (!currentLive) return;
    els.title.textContent = currentLive.title || 'Live';
    els.host.textContent = `par ${currentLive.host || 'hôte inconnu'}`;
    const hlsLabel = shouldUseHls() ? ' · HLS' : '';
    els.quality.textContent = `${currentLive.width || '—'}×${currentLive.height || '—'} · ${currentLive.fps || '—'} fps · ${formatBitrate(currentLive.bitrate)}${hlsLabel}`;
    updateViewers();
    els.duration.textContent = formatDuration(Date.now() + serverOffset - startedAt);
  }

  function updateViewers() {
    els.viewers.textContent = `${viewers} spectateur${viewers > 1 ? 's' : ''}`;
  }
})();