'use strict';

(function () {
  const { qs, el, formatDuration, formatBitrate, wsUrl, setStatus } = window.LIVERelay;

  document.addEventListener('DOMContentLoaded', () => {
    const grid = qs('#livesGrid');
    const empty = qs('#emptyState');
    const status = qs('#connStatus');
    const refresh = qs('#refreshBtn');

    let socket = null;
    let connectionId = 0;
    let retry = 0;
    let reconnectTimer = null;
    let serverOffset = 0;
    let lives = [];

    function setConnection(text, state) {
      setStatus(status, text, state);
    }

  function connect() {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const thisConnection = ++connectionId;
    socket = new WebSocket(wsUrl('/ws'));

    socket.addEventListener('open', () => {
      if (thisConnection !== connectionId) return;
      retry = 0;
      setConnection('En direct', 'live');
      sendList();
    });

    socket.addEventListener('message', (event) => {
      if (thisConnection !== connectionId) return;
      if (typeof event.data !== 'string') return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === 'lives') {
        lives = Array.isArray(message.lives) ? message.lives : [];
        serverOffset = (Number(message.serverNow) || Date.now()) - Date.now();
        render();
      }
    });

    socket.addEventListener('close', () => {
      if (thisConnection !== connectionId) return;
      socket = null;
      setConnection('Hors ligne', 'offline');
      scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      if (thisConnection !== connectionId) return;
      try { socket.close(); } catch {
        /* ignore */
      }
    });
  }

    function sendList() {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'list' }));
      }
    }

    function scheduleReconnect() {
      window.clearTimeout(reconnectTimer);
      retry += 1;
      const delay = Math.min(500 * Math.pow(2, Math.min(retry - 1, 5)), 10_000);
      setConnection(`Reconnexion dans ${Math.ceil(delay / 1000)} s…`, 'connecting');
      reconnectTimer = window.setTimeout(connect, delay);
    }

    function render() {
      grid.replaceChildren();
      if (!lives.length) {
        empty.hidden = false;
        return;
      }
      empty.hidden = true;
      const fragment = document.createDocumentFragment();
      for (const live of lives) {
        fragment.appendChild(createCard(live));
      }
      grid.appendChild(fragment);
    }

    function createCard(live) {
      const card = el('article', { class: 'live-card' });

      const top = el('div', { class: 'live-card-top' });
      top.appendChild(el('span', { class: 'live-badge' }, ['EN DIRECT']));
      const viewers = Number(live.viewers) || 0;
      top.appendChild(el('span', { class: 'live-viewers' }, [
        `${viewers} spectateur${viewers > 1 ? 's' : ''}`
      ]));

      const title = el('h2', { class: 'live-title', text: live.title || 'Sans titre' });
      const host = el('p', { class: 'live-host' }, [`par ${live.host || 'hôte inconnu'}`]);

      const meta = el('div', { class: 'live-meta' });
      meta.appendChild(el('span', { class: 'chip' }, [
        live.width && live.height ? `${live.width}×${live.height}` : (live.resolution || '—')
      ]));
      meta.appendChild(el('span', { class: 'chip' }, [`${live.fps || '—'} fps`]));
      meta.appendChild(el('span', { class: 'chip' }, [formatBitrate(live.bitrate)]));

      const footer = el('div', { class: 'live-card-footer' });
      footer.appendChild(el('span', {
        class: 'live-elapsed',
        dataset: { started: String(live.startedAt || '') }
      }, [formatDuration(Date.now() + serverOffset - Number(live.startedAt || Date.now()))]));
      footer.appendChild(el('a', {
        class: 'btn primary',
        href: `watch.html?live=${encodeURIComponent(live.id)}`
      }, ['Rejoindre']));

      card.appendChild(top);
      card.appendChild(title);
      card.appendChild(host);
      card.appendChild(meta);
      card.appendChild(footer);
      return card;
    }

    function tick() {
      const now = Date.now() + serverOffset;
      for (const node of window.LIVERelay.qsa('.live-elapsed')) {
        const started = Number(node.dataset.started);
        if (Number.isFinite(started) && started > 0) {
          node.textContent = formatDuration(now - started);
        }
      }
    }

    if (refresh) {
      refresh.addEventListener('click', () => {
        if (socket && socket.readyState === WebSocket.OPEN) sendList();
        else connect();
      });
    }

    fetch('/api/lives')
      .then((response) => response.json())
      .then((data) => {
        lives = Array.isArray(data.lives) ? data.lives : [];
        serverOffset = (Number(data.serverNow) || Date.now()) - Date.now();
        render();
      })
      .catch(() => {
        /* the WebSocket will fill the list */
      });

    window.setInterval(tick, 1000);
    connect();
  });
})();