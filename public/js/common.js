'use strict';

(function () {
  const LIVERelay = {};

  LIVERelay.qs = function (selector, root) {
    return (root || document).querySelector(selector);
  };

  LIVERelay.qsa = function (selector, root) {
    return Array.from((root || document).querySelectorAll(selector));
  };

  LIVERelay.el = function (tag, props, children) {
    const node = document.createElement(tag);
    const attributes = props || {};
    for (const key of Object.keys(attributes)) {
      const value = attributes[key];
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = String(value);
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (value === true) {
        node.setAttribute(key, '');
      } else {
        node.setAttribute(key, String(value));
      }
    }
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) {
      if (child === null || child === undefined || child === false) continue;
      if (child instanceof Node) node.appendChild(child);
      else node.appendChild(document.createTextNode(String(child)));
    }
    return node;
  };

  LIVERelay.formatDuration = function (milliseconds) {
    let value = Number(milliseconds);
    if (!Number.isFinite(value) || value < 0) value = 0;
    const totalSeconds = Math.floor(value / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const pad = (number) => String(number).padStart(2, '0');
    if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
    return `${pad(minutes)}:${pad(seconds)}`;
  };

  LIVERelay.formatBitrate = function (bitsPerSecond) {
    const value = Number(bitsPerSecond);
    if (!Number.isFinite(value) || value <= 0) return '—';
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} Mbps`;
    return `${Math.round(value / 1000)} kbps`;
  };

  LIVERelay.formatResolution = function (width, height) {
    if (!width || !height) return '—';
    return `${width}×${height}`;
  };

  LIVERelay.wsUrl = function (path) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}${path || '/ws'}`;
  };

  LIVERelay.setStatus = function (element, text, state) {
    if (!element) return;
    element.textContent = text;
    if (state) element.dataset.state = state;
    else delete element.dataset.state;
  };

  LIVERelay.setBusy = function (button, busy, busyText) {
    if (!button) return;
    if (busy) {
      button.dataset.originalText = button.textContent;
      button.textContent = busyText || 'Patientez…';
      button.disabled = true;
      button.classList.add('is-busy');
    } else {
      button.textContent = button.dataset.originalText || button.textContent;
      button.disabled = false;
      button.classList.remove('is-busy');
    }
  };

  LIVERelay.showToast = function (container, message, type) {
    if (!container) return;
    const toast = LIVERelay.el('div', {
      class: `toast ${type || 'error'}`,
      text: message
    });
    container.appendChild(toast);
    window.setTimeout(() => toast.remove(), 5000);
  };

  LIVERelay.getLiveId = function () {
    return new URLSearchParams(window.location.search).get('live');
  };

  LIVERelay.redirectHome = function (delay) {
    window.setTimeout(() => {
      window.location.href = 'index.html';
    }, delay || 0);
  };

  window.LIVERelay = LIVERelay;
})();