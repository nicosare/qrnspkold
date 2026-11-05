(function () {
  'use strict';

  const root = document.getElementById('qride-collect');
  if (!root) return;

  const track = document.getElementById('qride-collect-track');
  const totalNode = document.getElementById('qride-collect-total');
  const statusNode = document.getElementById('qride-collect-status');
  const infoLayer = document.getElementById('qride-collect-info');
  const infoTrigger = document.getElementById('qride-collect-unknown');
  const closeButtons = infoLayer ? infoLayer.querySelectorAll('[data-collect-close]') : [];
  if (!track || !totalNode) return;

  const transportConfig = {
    'трамвай': { className: 'tram', image: 'qride-collect-tram.svg' },
    'автобус': { className: 'bus', image: 'qride-collect-bus.svg' },
    'троллейбус': { className: 'trolley', image: 'qride-collect-trolleybus.svg' }
  };

  let activeController = null;
  let requestSequence = 0;
  let previousBodyOverflow = '';

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (char) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char];
    });
  }

  function getApiUrl() {
    const pathname = window.location.pathname;
    const appBase = pathname.endsWith('/')
      ? pathname
      : (pathname.slice(pathname.lastIndexOf('/') + 1).includes('.')
        ? pathname.slice(0, pathname.lastIndexOf('/') + 1)
        : pathname + '/');
    return new URL(appBase + 'api/collect', window.location.origin);
  }

  function getVkAuthorizationHeader() {
    const launchParams = window.location.search.slice(1);
    if (!launchParams) throw new Error('VK launch parameters are missing');
    const encoded = btoa(unescape(encodeURIComponent(launchParams)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
    return 'VK ' + encoded;
  }

  function normalizeRoute(value) {
    return String(value == null ? '' : value)
      .replace(/^\s*№\s*/i, '')
      .replace(/[\s\u00a0]+/g, '')
      .slice(0, 12);
  }

  function pluralizeTrips(value) {
    const number = Math.abs(Number(value) || 0);
    const mod100 = number % 100;
    const mod10 = number % 10;
    if (mod100 >= 11 && mod100 <= 14) return 'поездок';
    if (mod10 === 1) return 'поездка';
    if (mod10 >= 2 && mod10 <= 4) return 'поездки';
    return 'поездок';
  }

  function pluralizeRoutes(value) {
    const number = Math.abs(Number(value) || 0);
    const mod100 = number % 100;
    const mod10 = number % 10;
    if (mod100 >= 11 && mod100 <= 14) return 'маршрутов';
    if (mod10 === 1) return 'маршрут';
    if (mod10 >= 2 && mod10 <= 4) return 'маршрута';
    return 'маршрутов';
  }

  function makeVehicleCard(card, index) {
    const typeKey = String(card.transportType || '').trim().toLowerCase();
    const config = transportConfig[typeKey];
    const route = normalizeRoute(card.routeNumber);
    if (!config || !route) return '';

    const trips = Math.max(1, Math.trunc(Number(card.trips) || 0));
    const label = typeKey + ' №' + route + ', ' + trips + ' ' + pluralizeTrips(trips);
    return '<article class="qride-collect-card qride-collect-card--' + config.className + '" ' +
      'aria-label="' + escapeHtml(label) + '" style="animation-delay:' + Math.min(index * 35, 210) + 'ms">' +
        '<div class="qride-collect-card-art">' +
          '<img class="qride-collect-vehicle" src="' + config.image + '" alt="" loading="lazy" decoding="async">' +
          '<span class="qride-collect-route-board">' + escapeHtml(route) + '</span>' +
        '</div>' +
        '<div class="qride-collect-card-rides"><strong>' + trips + '</strong><span>' + pluralizeTrips(trips) + '</span></div>' +
      '</article>';
  }

  function makeUnknownCard() {
    return '<button class="qride-collect-unknown" id="qride-collect-unknown" type="button" ' +
      'aria-label="Узнать, как собирать транспорт">' +
        '<span class="qride-collect-unknown-mark" aria-hidden="true">?</span>' +
      '</button>';
  }

  function renderCards(cards) {
    const safeCards = Array.isArray(cards) ? cards : [];
    const normalized = safeCards
      .filter(function (card) {
        return card && transportConfig[String(card.transportType || '').trim().toLowerCase()] && normalizeRoute(card.routeNumber);
      })
      .sort(function (a, b) {
        return String(b.lastScannedAt || '').localeCompare(String(a.lastScannedAt || ''));
      });

    const cardsHtml = normalized.map(makeVehicleCard).join('');
    track.innerHTML = cardsHtml + makeUnknownCard();
    totalNode.textContent = String(normalized.length);
    root.dataset.loaded = 'true';
    if (statusNode) statusNode.textContent = '';
    bindUnknownCard();
  }

  function bindUnknownCard() {
    const button = document.getElementById('qride-collect-unknown');
    if (button) button.addEventListener('click', openInfo);
  }

  async function refreshCollection() {
    if (document.visibilityState === 'hidden') return;
    if (activeController) activeController.abort();

    const controller = new AbortController();
    activeController = controller;
    const currentSequence = ++requestSequence;

    try {
      const response = await fetch(getApiUrl().toString(), {
        method: 'GET',
        headers: { 'Authorization': getVkAuthorizationHeader() },
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal
      });
      const payload = await response.json().catch(function () { return {}; });
      if (!response.ok || payload.ok !== true) {
        throw new Error(payload.error || 'Не удалось загрузить коллекцию');
      }
      if (currentSequence !== requestSequence) return;
      renderCards(payload.cards);
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      if (currentSequence !== requestSequence) return;
      if (statusNode) statusNode.textContent = 'Не удалось обновить коллекцию';
      console.warn('[QRide Collect] Collection refresh failed:', error && error.message ? error.message : error);
    } finally {
      if (currentSequence === requestSequence) activeController = null;
    }
  }

  function openInfo() {
    if (!infoLayer || infoLayer.hidden === false) return;
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    infoLayer.hidden = false;
    const closeButton = infoLayer.querySelector('.qride-collect-info-close');
    if (closeButton) closeButton.focus({ preventScroll: true });
  }

  function closeInfo() {
    if (!infoLayer || infoLayer.hidden) return;
    infoLayer.hidden = true;
    document.body.style.overflow = previousBodyOverflow;
    if (infoTrigger && infoTrigger.isConnected) infoTrigger.focus({ preventScroll: true });
  }

  if (infoLayer) {
    closeButtons.forEach(function (button) {
      button.addEventListener('click', closeInfo);
    });
    infoLayer.addEventListener('click', function (event) {
      if (event.target === infoLayer) closeInfo();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !infoLayer.hidden) closeInfo();
    });
  }

  window.addEventListener('roadnote:scan-success', refreshCollection);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') refreshCollection();
  });

  refreshCollection();
})();