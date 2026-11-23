'use strict';

(function () {
  const { qs, formatBitrate, formatDuration, wsUrl, setBusy, showToast } = window.LIVERelay;

  const CHUNK_TIMESLICE_MS = 250;
  const HOST_BUFFER_LIMIT = 8 * 1024 * 1024;

  const RESOLUTIONS = {
    '480p': { width: 854, height: 480, baseBitrate: 1_200_000 },
    '720p': { width: 1280, height: 720, baseBitrate: 2_500_000 },
    '1080p': { width: 1920, height: 1080, baseBitrate: 4_500_000 },
    '1440p': { width: 2560, height: 1440, baseBitrate: 8_000_000 }
  };

  let els = {};

  const state = {
    ws: null,
    liveId: null,
    token: null,
    startedAt: null,
    stopping: false,
    serverEnded: false,
    cleaned: false,
    displayStream: null,
    canvasStream: null,
    canvas: null,
    canvasCtx: null,
    canvasTimer: null,
    canvasRaf: null,
    sourceVideo: null,
    recordingStream: null,
    videoTrack: null,
    recorder: null,
    mimeType: '',
    queue: [],
    sending: false,
    drainResolve: null,
    bytesWindow: [],
    bytesTotal: 0,
    actualBitrate: 0,
    actualFps: 0,
    drawCount: 0,
    fpsWindowStart: 0,
    audio: null,
    target: null,
    captureMode: 'direct',
    sourceSettings: null,
    viewers: 0,
    bitrateTimer: null,
    durationTimer: null,
    fpsTimer: null,
    lastChunkAt: 0,
    abort: false,
    connectionId: 0,
    interrupted: false,
    reconnecting: false,
    reconnectTimer: null,
    reconnectAttempts: 0,
    bitrate: 0,
    captureStopped: false
  };

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    els = {
      form: qs('#liveForm'),
      shareBtn: qs('#shareBtn'),
      formError: qs('#formError'),
      setupView: qs('#setupView'),
      studioView: qs('#studioView'),
      title: qs('#title'),
      host: qs('#host'),
      resolution: qs('#resolution'),
      fps: qs('#fps'),
      bitrate: qs('#bitrate'),
      captureMode: qs('#captureMode'),
      micEnabled: qs('#micEnabled'),
      systemAudio: qs('#systemAudio'),
      preview: qs('#preview'),
      liveStatus: qs('#liveStatus'),
      studioTitle: qs('#studioTitle'),
      studioHost: qs('#studioHost'),
      reqRes: qs('#reqRes'),
      reqFps: qs('#reqFps'),
      targetBitrate: qs('#targetBitrate'),
      realRes: qs('#realRes'),
      realFps: qs('#realFps'),
      actualBitrate: qs('#actualBitrate'),
      viewers: qs('#viewers'),
      duration: qs('#duration'),
      micBtn: qs('#micBtn'),
      stopBtn: qs('#stopBtn'),
      studioError: qs('#studioError'),
      codecHint: qs('#codecHint'),
      toastBox: qs('#toastBox')
    };

    els.form.addEventListener('submit', startLive);
    els.micBtn.addEventListener('click', toggleMic);
    els.stopBtn.addEventListener('click', () => stopLive('host-stopped'));
    window.addEventListener('pagehide', onPageHide);
  }

  function computeAutoBitrate(resolution, fps) {
    const preset = RESOLUTIONS[resolution];
    if (!preset) return 2_500_000;
    const raw = preset.baseBitrate * (fps / 30);
    return Math.min(12_000_000, Math.max(500_000, Math.round(raw / 100_000) * 100_000));
  }

  function computeBitrateForSize(width, height, fps) {
    const pixels = Math.max(1, width * height);
    const raw = pixels * Math.max(1, fps) * 0.07;
    return Math.min(12_000_000, Math.max(500_000, Math.round(raw / 100_000) * 100_000));
  }

  function readForm() {
    const title = els.title.value.trim().replace(/\s+/g, ' ');
    const host = els.host.value.trim().replace(/\s+/g, ' ');
    const resolution = els.resolution.value;
    const fps = Number(els.fps.value);
    const preset = RESOLUTIONS[resolution] || RESOLUTIONS['720p'];
    const bitrateChoice = els.bitrate.value === '0' ? 0 : Number(els.bitrate.value);
    return {
      title,
      host,
      resolution,
      fps,
      width: preset.width,
      height: preset.height,
      bitrate: bitrateChoice || computeAutoBitrate(resolution, fps),
      bitrateAuto: els.bitrate.value === '0',
      captureMode: els.captureMode.value === 'canvas' ? 'canvas' : 'direct',
      micEnabled: els.micEnabled.checked,
      systemAudio: els.systemAudio.checked
    };
  }

  async function startLive(event) {
    event.preventDefault();
    hideFormError();
    hideStudioError();

    state.connectionId += 1;
    if (state.ws) {
      try {
        if (state.ws.readyState === WebSocket.OPEN) {
          state.ws.send(JSON.stringify({ type: 'stop' }));
        }
        state.ws.close();
      } catch {
        /* ignore */
      }
    }
    cleanupCapture();
    resetCaptureState();

    const form = readForm();
    if (!form.title) {
      showFormError('Renseignez le titre du live.');
      return;
    }
    if (!form.host) {
      showFormError('Renseignez votre pseudo.');
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      showFormError('Ce navigateur ne supporte pas getDisplayMedia. Utilisez Chrome ou Edge sur ordinateur.');
      return;
    }

    setBusy(els.shareBtn, true, 'Démarrage…');

    try {
      state.target = form;
      const capture = await setupCapture(form);
      if (state.stopping || state.interrupted) {
        cleanupCapture();
        return;
      }
      await connectHost(form, capture.meta);
      if (state.stopping || state.serverEnded) {
        cleanupCapture();
        return;
      }
      startRecording(capture.mimeType, capture.bitrate);
      showStudio(form, capture.meta);
    } catch (error) {
      console.error(error);
      handleStartError(error);
    }
  }

  async function setupCapture(form) {
    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: form.width },
        height: { ideal: form.height },
        frameRate: { ideal: form.fps }
      },
      audio: form.systemAudio,
      systemAudio: form.systemAudio ? 'include' : 'exclude'
    });
    state.displayStream = displayStream;

    const displayTrack = displayStream.getVideoTracks()[0];
    if (!displayTrack) throw new Error('Aucune piste vidéo disponible.');
    displayTrack.addEventListener('ended', handleSourceEnded, { once: true });

    let settings = displayTrack.getSettings ? displayTrack.getSettings() : {};
    state.sourceSettings = settings;

    let videoTrack;
    if (form.captureMode === 'canvas') {
      const canvasResult = await setupCanvas(displayStream, form.width, form.height, form.fps);
      videoTrack = canvasResult.track;
      state.canvas = canvasResult.canvas;
      state.canvasCtx = canvasResult.ctx;
      state.sourceVideo = canvasResult.sourceVideo;
      state.canvasStream = canvasResult.stream;
      state.captureMode = 'canvas';
      showToast(els.toastBox, 'Mode canvas actif : gardez cet onglet hôte visible.', 'error');
    } else {
      try {
        await displayTrack.applyConstraints({
          width: { ideal: form.width },
          height: { ideal: form.height },
          frameRate: { ideal: form.fps }
        });
      } catch {
        /* best effort */
      }
      settings = displayTrack.getSettings ? displayTrack.getSettings() : settings;
      state.sourceSettings = settings;
      videoTrack = displayTrack;
      state.captureMode = 'direct';
    }

    if (state.stopping || state.interrupted) {
      stopMediaResources();
      throw new Error('Capture interrompue.');
    }
    state.videoTrack = videoTrack;
    state.target = form;

    const audio = await setupAudio(displayStream, form.micEnabled);
    state.audio = audio;
    if (state.stopping || state.interrupted) {
      stopMediaResources();
      throw new Error('Capture interrompue.');
    }

    const recordingStream = new MediaStream();
    recordingStream.addTrack(videoTrack);
    if (audio.audioTrack) recordingStream.addTrack(audio.audioTrack);
    state.recordingStream = recordingStream;

    els.preview.srcObject = recordingStream;
    els.preview.muted = true;
    try { await els.preview.play(); } catch { /* aperçu local uniquement */ }

    const hasAudio = Boolean(audio.audioTrack);
    const mimeType = pickMime(hasAudio);
    if (!mimeType) {
      throw new Error('Ce navigateur ne supporte pas MediaRecorder WebM (VP8/VP9).');
    }

    const actualWidth = settings.width || form.width;
    const actualHeight = settings.height || form.height;
    const actualFps = settings.frameRate || form.fps;
    const targetWidth = form.captureMode === 'canvas' ? form.width : actualWidth;
    const targetHeight = form.captureMode === 'canvas' ? form.height : actualHeight;
    const targetFps = form.captureMode === 'canvas' ? form.fps : actualFps;
    const bitrate = form.bitrateAuto
      ? computeBitrateForSize(targetWidth, targetHeight, targetFps)
      : form.bitrate;

    const meta = {
      mimeType,
      width: targetWidth,
      height: targetHeight,
      fps: targetFps,
      bitrate,
      hasAudio,
      sourceWidth: settings.width || form.width,
      sourceHeight: settings.height || form.height,
      sourceFps: settings.frameRate || form.fps,
      canvas: form.captureMode === 'canvas'
    };

    return { mimeType, bitrate, meta };
  }

  async function setupCanvas(displayStream, width, height, fps) {
    if (typeof HTMLCanvasElement === 'undefined' || !HTMLCanvasElement.prototype.captureStream) {
      throw new Error('Ce navigateur ne permet pas le retaillage par canvas.');
    }

    const sourceVideo = document.createElement('video');
    sourceVideo.srcObject = displayStream;
    sourceVideo.muted = true;
    sourceVideo.playsInline = true;
    sourceVideo.autoplay = true;
    sourceVideo.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
    document.body.appendChild(sourceVideo);

    try {
      await sourceVideo.play();
    } catch (error) {
      sourceVideo.remove();
      throw new Error(`Impossible de prévisualiser la source: ${error.message}`);
    }
    await waitForVideo(sourceVideo);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) {
      sourceVideo.remove();
      throw new Error('Contexte canvas 2D indisponible.');
    }

    const stream = canvas.captureStream(fps);
    const track = stream.getVideoTracks()[0];
    if (!track) {
      sourceVideo.remove();
      throw new Error('Impossible de capturer le canvas.');
    }

    state.drawCount = 0;
    state.fpsWindowStart = performance.now();
    const interval = 1000 / fps;

    function loop() {
      state.canvasTimer = window.setTimeout(() => {
        drawCanvasFrame(sourceVideo, canvas, ctx, width, height);
        state.drawCount += 1;
        loop();
      }, Math.max(1, interval - 1));
    }
    loop();

    return { canvas, ctx, stream, track, sourceVideo };
  }

  function waitForVideo(video) {
    if (video.readyState >= 2) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        reject(new Error('La source vidéo ne devient pas lisible.'));
      }, 8000);
      video.addEventListener('loadeddata', () => {
        window.clearTimeout(timer);
        resolve();
      }, { once: true });
      video.addEventListener('error', () => {
        window.clearTimeout(timer);
        reject(new Error('Erreur de lecture de la source vidéo.'));
      }, { once: true });
    });
  }

  function drawCanvasFrame(source, canvas, ctx, width, height) {
    const sourceWidth = source.videoWidth || width;
    const sourceHeight = source.videoHeight || height;
    if (!sourceWidth || !sourceHeight) return;
    const scale = Math.min(width / sourceWidth, height / sourceHeight);
    const drawWidth = Math.max(1, Math.round(sourceWidth * scale));
    const drawHeight = Math.max(1, Math.round(sourceHeight * scale));
    const offsetX = Math.floor((width - drawWidth) / 2);
    const offsetY = Math.floor((height - drawHeight) / 2);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(source, offsetX, offsetY, drawWidth, drawHeight);
  }

  async function setupAudio(displayStream, wantMic) {
    const displayAudio = displayStream.getAudioTracks ? displayStream.getAudioTracks() : [];
    let micStream = null;

    if (wantMic) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });
      } catch (error) {
        showToast(els.toastBox, `Micro non disponible: ${error.message}`, 'error');
      }
    }

    if (!displayAudio.length && !micStream) {
      return {
        audioTrack: null,
        audioCtx: null,
        dest: null,
        micStream: null,
        micSource: null,
        micGain: null,
        hasAudio: false
      };
    }

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) throw new Error('Web Audio API indisponible pour le mixage audio.');

    const audioCtx = new AudioCtx();
    try { await audioCtx.resume(); } catch { /* certains navigateurs reprendront au geste suivant */ }
    const dest = audioCtx.createMediaStreamDestination();

    if (displayAudio.length) {
      const source = audioCtx.createMediaStreamSource(new MediaStream(displayAudio));
      source.connect(dest);
    }

    let micSource = null;
    let micGain = null;
    if (micStream) {
      micSource = audioCtx.createMediaStreamSource(micStream);
      micGain = audioCtx.createGain();
      micGain.gain.value = 1;
      micSource.connect(micGain);
      micGain.connect(dest);
    }

    return {
      audioTrack: dest.stream.getAudioTracks()[0],
      audioCtx,
      dest,
      micStream,
      micSource,
      micGain,
      hasAudio: true
    };
  }

  function pickMime(hasAudio) {
    if (typeof MediaRecorder === 'undefined') return '';
    const candidates = hasAudio
      ? ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus']
      : ['video/webm;codecs=vp8', 'video/webm;codecs=vp9'];
    for (const candidate of candidates) {
      if (typeof MediaRecorder.isTypeSupported !== 'function' || MediaRecorder.isTypeSupported(candidate)) {
        return candidate;
      }
    }
    return '';
  }

  function connectHost(form, meta) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const connectionId = ++state.connectionId;
      const isCurrent = () => connectionId === state.connectionId;
      const socket = new WebSocket(wsUrl('/ws'));
      state.ws = socket;

      const timer = window.setTimeout(() => {
        if (!isCurrent() || settled) return;
        settled = true;
        try { socket.close(); } catch { /* ignore */ }
        reject(new Error('Délai de connexion au serveur dépassé.'));
      }, 12_000);

      function fail(error) {
        if (!isCurrent() || settled) return;
        settled = true;
        window.clearTimeout(timer);
        try { socket.close(); } catch { /* ignore */ }
        reject(error);
      }

      socket.addEventListener('open', () => {
        if (!isCurrent()) return;
        socket.send(JSON.stringify({
          type: 'create',
          title: form.title,
          host: form.host,
          resolution: form.resolution,
          fps: form.fps,
          bitrate: form.bitrate
        }));
      });

      socket.addEventListener('message', (event) => {
        if (!isCurrent() || typeof event.data !== 'string') return;
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }

        if (message.type === 'created') {
          state.liveId = message.liveId;
          state.token = message.token;
          state.startedAt = message.startedAt;
          socket.send(JSON.stringify({
            type: 'host_auth',
            token: message.token,
            mimeType: meta.mimeType,
            width: meta.width,
            height: meta.height,
            fps: meta.fps,
            bitrate: meta.bitrate,
            hasAudio: meta.hasAudio,
            sourceWidth: meta.sourceWidth,
            sourceHeight: meta.sourceHeight,
            sourceFps: meta.sourceFps,
            canvas: meta.canvas
          }));
          return;
        }

        if (message.type === 'host_ready') {
          if (!settled) {
            settled = true;
            window.clearTimeout(timer);
            resolve();
          }
          return;
        }

        if (message.type === 'error') {
          const error = new Error(message.message || 'Erreur du serveur.');
          if (!settled) fail(error);
          else showStudioError(error.message);
          return;
        }

        if (message.type === 'stats') {
          state.viewers = Number(message.viewers) || 0;
          updateHud();
          return;
        }

        if (message.type === 'ended' || message.type === 'stopped') {
          handleServerEnded(message.reason || 'server-ended');
        }
      });

      socket.addEventListener('close', () => {
        if (!isCurrent()) return;
        window.clearTimeout(timer);
        if (!settled) {
          fail(new Error('Connexion au serveur fermée avant la création du live.'));
          return;
        }
        if (!state.stopping && !state.serverEnded) {
          state.reconnecting = true;
          showStudioError('Connexion au serveur perdue. Reconnexion…');
          scheduleHostReconnect();
        }
      });

      socket.addEventListener('error', () => {
        /* close will follow */
      });
    });
  }

  function scheduleHostReconnect() {
    if (state.stopping || state.serverEnded || !state.liveId || !state.token) return;
    if (state.reconnectTimer) return;
    state.reconnectAttempts += 1;
    const delay = Math.min(500 * Math.pow(2, Math.min(state.reconnectAttempts - 1, 4)), 5000);
    state.reconnectTimer = window.setTimeout(() => {
      state.reconnectTimer = null;
      attemptHostReconnect();
    }, delay);
  }

  function attemptHostReconnect() {
    if (state.stopping || state.serverEnded || !state.liveId || !state.token) return;

    const connectionId = ++state.connectionId;
    if (state.ws) {
      try { state.ws.close(); } catch { /* ignore */ }
    }

    const isCurrent = () => connectionId === state.connectionId;
    const socket = new WebSocket(wsUrl('/ws'));
    state.ws = socket;
    let settled = false;

    const timer = window.setTimeout(() => {
      if (!isCurrent() || settled) return;
      settled = true;
      try { socket.close(); } catch { /* ignore */ }
      scheduleHostReconnect();
    }, 10_000);

    socket.addEventListener('open', () => {
      if (!isCurrent()) return;
      socket.send(JSON.stringify({
        type: 'host_resume',
        liveId: state.liveId,
        token: state.token
      }));
    });

    socket.addEventListener('message', (event) => {
      if (!isCurrent() || typeof event.data !== 'string') return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      if (message.type === 'host_ready' && message.resumed) {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        state.reconnecting = false;
        state.reconnectAttempts = 0;
        hideStudioError();
        handleResumeReady();
        return;
      }

      if (message.type === 'error') {
        if (message.code === 'NOT_FOUND') {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          state.serverEnded = true;
          state.reconnecting = false;
          showStudioError('Le live a été terminé pendant la reconnexion.');
          window.setTimeout(() => {
            try {
              if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop();
            } catch {
              /* ignore */
            }
            cleanupCapture();
            showEnded('server-ended');
          }, 200);
          return;
        }
        if (message.code === 'STATE') {
          window.clearTimeout(timer);
          try { socket.close(); } catch { /* ignore */ }
          scheduleHostReconnect();
          return;
        }
        showStudioError(message.message);
        return;
      }

      if (message.type === 'stats') {
        state.viewers = Number(message.viewers) || 0;
        updateHud();
        return;
      }

      if (message.type === 'ended' || message.type === 'stopped') {
        if (!settled) {
          settled = true;
          window.clearTimeout(timer);
        }
        handleServerEnded(message.reason || 'server-ended');
      }
    });

    socket.addEventListener('close', () => {
      window.clearTimeout(timer);
      if (!isCurrent()) return;
      if (state.stopping || state.serverEnded) return;
      if (!settled) {
        settled = true;
        scheduleHostReconnect();
        return;
      }
      state.reconnecting = true;
      showStudioError('Connexion au serveur perdue. Reconnexion…');
      scheduleHostReconnect();
    });

    socket.addEventListener('error', () => {
      /* close will follow */
    });
  }

  function handleResumeReady() {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;

    if (state.recorder && state.recorder.state === 'recording') {
      showStudioError('Connexion rétablie. Le direct continue.');
      window.setTimeout(() => {
        if (!state.interrupted && !state.stopping) hideStudioError();
      }, 2500);
      drainQueue();
      return;
    }

    const displayTrack = state.displayStream && state.displayStream.getVideoTracks()[0];
    const trackLive = displayTrack && displayTrack.readyState === 'live';
    if (trackLive && state.recordingStream) {
      try {
        const bitrate = state.bitrate || (state.target && state.target.bitrate) || 2_500_000;
        startRecording(state.mimeType, bitrate);
        if (state.ws.readyState === WebSocket.OPEN) {
          state.ws.send(JSON.stringify({ type: 'restart' }));
        }
        showStudioError('Connexion rétablie. Le direct reprend.');
        window.setTimeout(() => {
          if (!state.interrupted && !state.stopping) hideStudioError();
        }, 2500);
      } catch (error) {
        state.interrupted = true;
        showStudioError(`Impossible de reprendre: ${error.message}`);
        addResumeButton();
      }
      return;
    }

    state.interrupted = true;
    showStudioError('Le partage d’écran a été interrompu. Cliquez sur « Reprendre le partage ».');
    addResumeButton();
  }

  function handleSourceEnded() {
    if (state.stopping || state.serverEnded || state.interrupted) return;
    state.interrupted = true;
    stopCaptureOnly();
    els.liveStatus.textContent = 'Interrompu';
    els.liveStatus.dataset.state = 'ended';
    showStudioError('Le partage d’écran a été interrompu. Cliquez sur « Reprendre le partage ».');
    addResumeButton();
  }

  function stopCaptureOnly() {
    stopTimers();
    stopMediaResources();
  }

  function addResumeButton() {
    if (qs('#resumeShareBtn')) return;
    const button = window.LIVERelay.el('button', {
      id: 'resumeShareBtn',
      class: 'btn primary',
      type: 'button',
      text: 'Reprendre le partage'
    });
    button.addEventListener('click', resumeShare);
    els.stopBtn.parentNode.insertBefore(button, els.stopBtn);
  }

  async function resumeShare() {
    if (!state.target || state.stopping || state.serverEnded) return;
    if (state.reconnecting || !state.ws || state.ws.readyState !== WebSocket.OPEN) {
      showStudioError('Connexion au serveur en cours de rétablissement…');
      return;
    }

    state.interrupted = false;
    hideStudioError();
    const resumeButton = qs('#resumeShareBtn');
    if (resumeButton) resumeButton.remove();

    try {
      stopCaptureOnly();
      const capture = await setupCapture(state.target);
      if (state.stopping || state.serverEnded) {
        cleanupCapture();
        return;
      }
      startRecording(capture.mimeType, capture.bitrate);
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: 'restart' }));
      }
      showStudio(state.target, capture.meta);
    } catch (error) {
      stopCaptureOnly();
      state.interrupted = true;
      showStudioError(`Reprise impossible: ${error.message}`);
      addResumeButton();
    }
  }

  function startRecording(mimeType, bitrate) {
    if (!state.recordingStream) throw new Error('Flux local indisponible.');
    if (state.audio && state.audio.audioCtx && state.audio.audioCtx.state === 'suspended') {
      state.audio.audioCtx.resume().catch(() => {});
    }

    const options = {
      mimeType,
      videoBitsPerSecond: bitrate
    };
    if (state.audio && state.audio.hasAudio) {
      options.audioBitsPerSecond = 128_000;
    }

    let recorder;
    try {
      recorder = new MediaRecorder(state.recordingStream, options);
    } catch (error) {
      throw new Error(`Impossible de créer MediaRecorder: ${error.message}`);
    }

    state.recorder = recorder;
    state.mimeType = mimeType;
    state.bitrate = bitrate;
    state.captureStopped = false;
    state.queue = [];
    state.sending = false;
    state.bytesWindow = [];
    state.bytesTotal = 0;
    state.actualBitrate = 0;
    state.actualFps = 0;
    state.abort = false;

    recorder.addEventListener('dataavailable', (event) => {
      if (!event.data || event.data.size === 0) return;
      state.queue.push(event.data);
      state.bytesTotal += event.data.size;
      drainQueue();
    });

    recorder.addEventListener('error', (event) => {
      console.error('MediaRecorder error:', event.error || event);
      showStudioError('Erreur MediaRecorder. Le live a été arrêté.');
      stopLive('recorder-error');
    });

    try {
      recorder.start(CHUNK_TIMESLICE_MS);
    } catch (error) {
      throw new Error(`Impossible de démarrer MediaRecorder: ${error.message}`);
    }

    startTimers();
    updateHud();
  }

  async function drainQueue() {
    if (state.sending) return;
    state.sending = true;
    try {
      while (state.queue.length && !state.captureStopped) {
        const blob = state.queue.shift();
        let buffer;
        try {
          buffer = await blob.arrayBuffer();
        } catch {
          continue;
        }
        if (state.captureStopped) break;
        if (!state.ws || state.ws.readyState !== WebSocket.OPEN) break;
        if (state.ws.bufferedAmount > HOST_BUFFER_LIMIT) {
          state.abort = true;
          break;
        }
        state.ws.send(buffer);
        const now = performance.now();
        state.bytesWindow.push({ time: now, bytes: buffer.byteLength });
        state.lastChunkAt = Date.now();
      }
    } finally {
      state.sending = false;
      const canFinish = !state.ws || state.ws.readyState !== WebSocket.OPEN || state.queue.length === 0;
      if (state.drainResolve && canFinish) {
        const resolve = state.drainResolve;
        state.drainResolve = null;
        resolve();
      }
      if (state.abort) {
        state.abort = false;
        showStudioError('Débit sortant saturé. Le live a été arrêté.');
        stopLive('host-buffer-full');
      }
    }
  }

  function waitForDrain() {
    if (!state.queue.length && !state.sending) return Promise.resolve();
    if (!state.sending) drainQueue();
    return new Promise((resolve) => {
      state.drainResolve = resolve;
    });
  }

  function stopLive(reason) {
    if (state.stopping) return;
    state.stopping = true;
    state.interrupted = false;
    state.reconnecting = false;
    if (state.reconnectTimer) {
      window.clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    const resumeButton = qs('#resumeShareBtn');
    if (resumeButton) resumeButton.remove();

    let finished = false;
    const finish = async () => {
      if (finished) return;
      finished = true;
      await waitForDrain();
      if (state.ws && state.ws.readyState === WebSocket.OPEN && !state.serverEnded) {
        try { state.ws.send(JSON.stringify({ type: 'stop' })); } catch { /* ignore */ }
        window.setTimeout(() => {
          try { state.ws.close(1000, 'host stopped'); } catch { /* ignore */ }
        }, 300);
      }
      cleanupCapture();
      showEnded(reason);
    };

    if (state.recorder && state.recorder.state !== 'inactive') {
      try {
        state.recorder.addEventListener('stop', finish, { once: true });
        state.recorder.stop();
      } catch {
        finish();
      }
    } else {
      finish();
    }
  }

  function handleServerEnded(reason) {
    if (state.serverEnded || state.stopping) return;
    state.serverEnded = true;
    state.stopping = true;
    state.interrupted = false;
    state.reconnecting = false;
    if (state.reconnectTimer) {
      window.clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    const resumeButton = qs('#resumeShareBtn');
    if (resumeButton) resumeButton.remove();
    try {
      if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop();
    } catch {
      /* ignore */
    }
    cleanupCapture();
    showEnded(reason === 'host-stopped' ? 'server-ended' : reason);
    window.setTimeout(() => {
      try { if (state.ws) state.ws.close(1000, 'ended'); } catch { /* ignore */ }
    }, 600);
  }

  function handleStartError(error) {
    const name = error && error.name;
    let message = error && error.message ? error.message : 'Erreur inconnue.';
    if (name === 'NotAllowedError') message = 'Permission refusée ou partage d’écran annulé.';
    else if (name === 'NotFoundError') message = 'Aucune source d’écran ou de micro disponible.';
    else if (name === 'NotReadableError') message = 'Capture impossible. Utilisez Chrome/Edge sur localhost ou HTTPS.';
    else if (name === 'OverconstrainedError') message = 'La résolution ou les FPS demandés ne sont pas supportés.';
    else if (name === 'InvalidStateError') message = 'Le partage d’écran n’a pas pu démarrer.';

    showFormError(message);
    state.interrupted = false;
    state.reconnecting = false;
    if (state.reconnectTimer) {
      window.clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    if (state.ws) {
      try { state.ws.close(); } catch { /* ignore */ }
      state.ws = null;
    }
    cleanupCapture();
    setBusy(els.shareBtn, false);
  }

  function resetCaptureState() {
    state.ws = null;
    state.liveId = null;
    state.token = null;
    state.startedAt = null;
    state.stopping = false;
    state.serverEnded = false;
    state.interrupted = false;
    state.reconnecting = false;
    state.reconnectTimer = null;
    state.reconnectAttempts = 0;
    state.cleaned = false;
    state.displayStream = null;
    state.canvasStream = null;
    state.canvas = null;
    state.canvasCtx = null;
    state.canvasTimer = null;
    state.canvasRaf = null;
    state.sourceVideo = null;
    state.recordingStream = null;
    state.videoTrack = null;
    state.recorder = null;
    state.mimeType = '';
    state.bitrate = 0;
    state.queue = [];
    state.sending = false;
    state.drainResolve = null;
    state.bytesWindow = [];
    state.bytesTotal = 0;
    state.actualBitrate = 0;
    state.actualFps = 0;
    state.drawCount = 0;
    state.fpsWindowStart = 0;
    state.audio = null;
    state.target = null;
    state.captureMode = 'direct';
    state.sourceSettings = null;
    state.viewers = 0;
    state.micEnabled = false;
    state.bitrateTimer = null;
    state.durationTimer = null;
    state.fpsTimer = null;
    state.lastChunkAt = 0;
    state.abort = false;
    state.captureStopped = false;
  }

  function cleanupCapture() {
    if (state.cleaned) return;
    state.cleaned = true;

    if (state.reconnectTimer) {
      window.clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    stopTimers();
    stopMediaResources();
  }

  function stopMediaResources() {
    state.captureStopped = true;
    if (state.canvasTimer) {
      window.clearTimeout(state.canvasTimer);
      state.canvasTimer = null;
    }
    if (state.canvasRaf) {
      cancelAnimationFrame(state.canvasRaf);
      state.canvasRaf = null;
    }

    if (state.recorder) {
      try {
        if (state.recorder.state !== 'inactive') state.recorder.stop();
      } catch {
        /* ignore */
      }
      state.recorder = null;
    }

    if (state.displayStream) {
      for (const track of state.displayStream.getTracks()) {
        try { track.stop(); } catch { /* ignore */ }
      }
      state.displayStream = null;
    }

    if (state.canvasStream) {
      for (const track of state.canvasStream.getTracks()) {
        try { track.stop(); } catch { /* ignore */ }
      }
      state.canvasStream = null;
    }

    if (state.audio) {
      if (state.audio.micStream) {
        for (const track of state.audio.micStream.getTracks()) {
          try { track.stop(); } catch { /* ignore */ }
        }
      }
      if (state.audio.audioCtx) {
        try { state.audio.audioCtx.close(); } catch { /* ignore */ }
      }
      state.audio = null;
    }

    if (state.sourceVideo) {
      try { state.sourceVideo.srcObject = null; } catch { /* ignore */ }
      state.sourceVideo.remove();
      state.sourceVideo = null;
    }

    if (els.preview) {
      try { els.preview.srcObject = null; } catch { /* ignore */ }
    }

    state.recordingStream = null;
    state.videoTrack = null;
    state.canvas = null;
    state.canvasCtx = null;
    state.queue = [];
    state.sending = false;
    state.drainResolve = null;
    state.bytesWindow = [];
    state.actualBitrate = 0;
  }

  function startTimers() {
    stopTimers();
    state.bitrateTimer = window.setInterval(updateBitrate, 500);
    state.durationTimer = window.setInterval(updateHud, 1000);
    state.fpsTimer = window.setInterval(updateFps, 1000);
  }

  function stopTimers() {
    if (state.bitrateTimer) window.clearInterval(state.bitrateTimer);
    if (state.durationTimer) window.clearInterval(state.durationTimer);
    if (state.fpsTimer) window.clearInterval(state.fpsTimer);
    state.bitrateTimer = null;
    state.durationTimer = null;
    state.fpsTimer = null;
  }

  function updateBitrate() {
    const now = performance.now();
    state.bytesWindow = state.bytesWindow.filter((entry) => now - entry.time <= 1000);
    const bytes = state.bytesWindow.reduce((sum, entry) => sum + entry.bytes, 0);
    state.actualBitrate = bytes * 8;
    if (els.actualBitrate) els.actualBitrate.textContent = formatBitrate(state.actualBitrate);
  }

  function updateFps() {
    if (state.captureMode === 'canvas') {
      const now = performance.now();
      const elapsed = now - state.fpsWindowStart;
      if (elapsed >= 500) {
        state.actualFps = (state.drawCount * 1000) / elapsed;
        state.drawCount = 0;
        state.fpsWindowStart = now;
      }
    } else if (state.videoTrack && state.videoTrack.getSettings) {
      const settings = state.videoTrack.getSettings();
      state.actualFps = Number(settings.frameRate) || 0;
    }
    if (els.realFps) {
      els.realFps.textContent = state.actualFps > 0 ? `${state.actualFps.toFixed(1)} fps` : '—';
    }
  }

  function updateHud() {
    if (state.videoTrack && state.videoTrack.getSettings && els.realRes) {
      const settings = state.videoTrack.getSettings();
      if (settings.width && settings.height) {
        els.realRes.textContent = `${settings.width}×${settings.height}`;
      }
    }
    if (els.actualBitrate) els.actualBitrate.textContent = formatBitrate(state.actualBitrate);
    if (els.viewers) els.viewers.textContent = String(state.viewers || 0);
    if (els.duration) {
      els.duration.textContent = state.startedAt
        ? formatDuration(Date.now() - state.startedAt)
        : '00:00';
    }
  }

  function showStudio(form, meta) {
    els.setupView.hidden = true;
    els.studioView.hidden = false;
    state.interrupted = false;
    els.studioTitle.textContent = form.title;
    els.studioHost.textContent = form.host;
    els.reqRes.textContent = `${form.width}×${form.height}`;
    els.reqFps.textContent = `${form.fps} fps`;
    els.targetBitrate.textContent = formatBitrate(meta.bitrate || form.bitrate);
    els.realRes.textContent = `${meta.width}×${meta.height}`;
    els.realFps.textContent = `${meta.fps} fps`;
    els.viewers.textContent = '0';
    els.duration.textContent = '00:00';
    els.liveStatus.textContent = 'En direct';
    els.liveStatus.dataset.state = 'live';
    els.studioError.hidden = true;

    const resumeButton = qs('#resumeShareBtn');
    if (resumeButton) resumeButton.remove();

    const hasAudio = Boolean(state.audio && state.audio.dest);
    els.micBtn.disabled = !hasAudio;
    state.micEnabled = Boolean(state.audio && state.audio.micStream && state.audio.micGain);
    if (hasAudio) {
      els.micBtn.textContent = state.micEnabled ? 'Couper le micro' : 'Activer le micro';
    } else {
      els.micBtn.textContent = 'Micro indisponible';
    }

    if (meta.canvas) {
      els.codecHint.textContent = `Source ${meta.sourceWidth}×${meta.sourceHeight} @ ${meta.sourceFps} fps → sortie ${meta.width}×${meta.height} via canvas.`;
    } else {
      els.codecHint.textContent = `Source ${meta.sourceWidth}×${meta.sourceHeight} @ ${meta.sourceFps} fps (direct).`;
    }

    setBusy(els.shareBtn, false);
    updateHud();
  }

  function toggleMic() {
    if (!state.audio || !state.audio.audioCtx || !state.audio.dest) {
      showStudioError('Aucune piste audio dans ce live. Relancez avec l’option micro activée.');
      return;
    }
    if (state.audio.audioCtx.state === 'suspended') {
      state.audio.audioCtx.resume().catch(() => {});
    }

    if (state.audio.micStream && state.audio.micGain) {
      const nextEnabled = !state.micEnabled;
      const now = state.audio.audioCtx.currentTime;
      const gain = state.audio.micGain.gain;
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(gain.value, now);
      gain.linearRampToValueAtTime(nextEnabled ? 1 : 0, now + 0.05);
      state.micEnabled = nextEnabled;
      els.micBtn.textContent = nextEnabled ? 'Couper le micro' : 'Activer le micro';
      return;
    }

    navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    }).then((stream) => {
      if (!state.audio || !state.audio.audioCtx || state.stopping) {
        for (const track of stream.getTracks()) {
          try { track.stop(); } catch { /* ignore */ }
        }
        return;
      }
      const source = state.audio.audioCtx.createMediaStreamSource(stream);
      const gain = state.audio.audioCtx.createGain();
      gain.gain.value = 1;
      source.connect(gain);
      gain.connect(state.audio.dest);
      state.audio.micStream = stream;
      state.audio.micSource = source;
      state.audio.micGain = gain;
      state.micEnabled = true;
      els.micBtn.textContent = 'Couper le micro';
    }).catch((error) => {
      showStudioError(`Micro indisponible: ${error.message}`);
    });
  }

  function showEnded(reason) {
    const messages = {
      'host-stopped': 'Vous avez arrêté le live.',
      'source-ended': 'Le partage d’écran a été arrêté.',
      'connection-lost': 'Connexion au serveur perdue. Le live est terminé.',
      'recorder-error': 'Erreur MediaRecorder. Le live est terminé.',
      'host-buffer-full': 'Débit sortant saturé. Le live est terminé.',
      'server-ended': 'Le live a été terminé par le serveur.',
      'host-disconnected': 'Le live a été terminé (hôte déconnecté).'
    };

    els.liveStatus.textContent = 'Terminé';
    els.liveStatus.dataset.state = 'ended';
    els.micBtn.disabled = true;
    els.stopBtn.disabled = true;
    state.interrupted = false;
    state.reconnecting = false;
    if (state.reconnectTimer) {
      window.clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    const resumeButton = qs('#resumeShareBtn');
    if (resumeButton) resumeButton.remove();
    els.studioError.textContent = messages[reason] || 'Le live est terminé.';
    els.studioError.hidden = false;

    if (!qs('#newLiveBtn')) {
      const button = window.LIVERelay.el('button', {
        id: 'newLiveBtn',
        class: 'btn primary',
        type: 'button',
        text: 'Créer un autre live'
      });
      button.addEventListener('click', () => window.location.reload());
      els.stopBtn.parentNode.appendChild(button);
    }
  }

  function showFormError(message) {
    els.formError.textContent = message;
    els.formError.hidden = false;
  }

  function hideFormError() {
    els.formError.hidden = true;
    els.formError.textContent = '';
  }

  function showStudioError(message) {
    els.studioError.textContent = message;
    els.studioError.hidden = false;
  }

  function hideStudioError() {
    els.studioError.hidden = true;
    els.studioError.textContent = '';
  }

  function onPageHide() {
    state.stopping = true;
    state.interrupted = false;
    state.reconnecting = false;
    if (state.reconnectTimer) {
      window.clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    try {
      if (state.ws) state.ws.close();
    } catch {
      /* ignore */
    }
    cleanupCapture();
  }
})();