(function () {
  'use strict';

  const root = document.getElementById('qride-collect');
  if (!root) return;

  const track = document.getElementById('qride-collect-track');
  const totalNode = document.getElementById('qride-collect-total');
  const totalLabelNode = document.getElementById('qride-collect-total-label');
  const statusNode = document.getElementById('qride-collect-status');
  const infoLayer = document.getElementById('qride-collect-info');
  let infoTrigger = document.getElementById('qride-collect-unknown');
  const closeButtons = infoLayer ? infoLayer.querySelectorAll('[data-collect-close]') : [];
  if (!track || !totalNode) return;

  const transportConfig = {
    'трамвай': { className: 'tram', label: 'ТРАМВАЙ', image: '8953-cutout.png?v=20261105-3' },
    'автобус': { className: 'bus', label: 'АВТОБУС', image: '8949-cutout.png?v=20261105-3' },
    'троллейбус': { className: 'trolley', label: 'ТРОЛЛЕЙБУС', image: '8954-cutout.png?v=20261105-3' }
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
    const tripLabel = pluralizeTrips(trips);
    const label = typeKey + ' №' + route + ', ' + trips + ' ' + tripLabel;
    const longCaptionClass = route.length > 5 ? ' qride-collect-card-route--long' : '';

    return '<article class="qride-collect-card qride-collect-card--' + config.className + '" ' +
      'aria-label="' + escapeHtml(label) + '" style="animation-delay:' + Math.min(index * 25, 150) + 'ms">' +
        '<div class="qride-collect-card-art">' +
          '<img class="qride-collect-vehicle" src="' + config.image + '" alt="" loading="lazy" decoding="async">' +
        '</div>' +
        '<div class="qride-collect-card-footer">' +
          '<strong class="qride-collect-card-route' + longCaptionClass + '">№ ' + escapeHtml(route) + '</strong>' +
          '<span class="qride-collect-card-rides">' + trips + ' ' + tripLabel + '</span>' +
        '</div>' +
      '</article>';
  }

  function makeUnknownCard(typeKey) {
    const config = transportConfig[typeKey];
    return '<button class="qride-collect-unknown" type="button" data-collect-unknown="' + typeKey + '" ' +
      'aria-label="Как открыть карточки: ' + config.label.toLowerCase() + '">' +
        '<span class="qride-collect-unknown-mark" aria-hidden="true">?</span>' +
        '<span class="qride-collect-unknown-label">Как открыть</span>' +
      '</button>';
  }

  function renderCards(cards) {
    const safeCards = Array.isArray(cards) ? cards : [];
    const normalized = safeCards
      .filter(function (card) {
        return card && transportConfig[String(card.transportType || '').trim().toLowerCase()] && normalizeRoute(card.routeNumber);
      });

    const groups = Object.keys(transportConfig).map(function (typeKey) {
      const items = normalized
        .filter(function (card) {
          return String(card.transportType || '').trim().toLowerCase() === typeKey;
        })
        .sort(function (a, b) {
          const tripsDiff = (Number(b.trips) || 0) - (Number(a.trips) || 0);
          return tripsDiff || String(b.lastScannedAt || '').localeCompare(String(a.lastScannedAt || ''));
        });
      const totalTrips = items.reduce(function (sum, card) {
        return sum + Math.max(0, Math.trunc(Number(card.trips) || 0));
      }, 0);
      return { typeKey: typeKey, items: items, totalTrips: totalTrips };
    }).sort(function (a, b) {
      return b.totalTrips - a.totalTrips ||
        Object.keys(transportConfig).indexOf(a.typeKey) - Object.keys(transportConfig).indexOf(b.typeKey);
    });

    track.innerHTML = groups.map(function (group) {
      const config = transportConfig[group.typeKey];
      const tripCount = group.totalTrips;
      const tripText = tripCount + ' ' + pluralizeTrips(tripCount);
      return '<section class="qride-collect-row qride-collect-row--' + config.className + '" aria-label="' + config.label + '">' +
        '<div class="qride-collect-row-heading">' +
          '<span class="qride-collect-row-title">' + config.label + '</span>' +
          '<span class="qride-collect-row-total">' + tripText + '</span>' +
        '</div>' +
        '<div class="qride-collect-row-track" role="group" aria-label="Маршруты: ' + config.label.toLowerCase() + '">' +
          group.items.map(makeVehicleCard).join('') + makeUnknownCard(group.typeKey) +
        '</div>' +
      '</section>';
    }).join('');

    totalNode.textContent = String(normalized.length);
    if (totalLabelNode) totalLabelNode.textContent = pluralizeRoutes(normalized.length);
    root.dataset.loaded = 'true';
    if (statusNode) statusNode.textContent = '';
    bindUnknownCard();
  }

  function bindUnknownCard() {
    const buttons = track.querySelectorAll('[data-collect-unknown]');
    infoTrigger = buttons.length ? buttons[0] : null;
    buttons.forEach(function (button) {
      button.addEventListener('click', openInfo);
    });
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

  bindUnknownCard();
  refreshCollection();
})();