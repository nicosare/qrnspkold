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
    'трамвай': { className: 'tram', label: 'ТРАМВАЙ', image: '/roadnote/assets/collect/8953-cutout.png?v=20261105-5' },
    'автобус': { className: 'bus', label: 'АВТОБУС', image: '/roadnote/assets/collect/8949-cutout.png?v=20261105-5' },
    'троллейбус': { className: 'trolley', label: 'ТРОЛЛЕЙБУС', image: '/roadnote/assets/collect/8954-cutout.png?v=20261105-5' }
  };

  let activeController = null;
  let requestSequence = 0;
  let previousBodyOverflow = '';
  let previousBodyPosition = '';
  let previousBodyTop = '';
  let previousBodyLeft = '';
  let previousBodyRight = '';
  let previousBodyWidth = '';
  let pageScrollY = 0;

  let historyLayer = null;
  let historySubtitle = null;
  let historyList = null;
  let historyStatus = null;
  let historyTrigger = null;
  let historyRides = [];
  let historyController = null;
  let historyRequestSequence = 0;
  let historyPageScrollY = 0;
  let historyPreviousBodyOverflow = '';
  let historyPreviousBodyPosition = '';
  let historyPreviousBodyTop = '';
  let historyPreviousBodyLeft = '';
  let historyPreviousBodyRight = '';
  let historyPreviousBodyWidth = '';

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (char) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char];
    });
  }

  function getApiUrl(endpoint = 'api/collect') {
    const pathname = window.location.pathname;
    const appBase = pathname.endsWith('/')
      ? pathname
      : (pathname.slice(pathname.lastIndexOf('/') + 1).includes('.')
        ? pathname.slice(0, pathname.lastIndexOf('/') + 1)
        : pathname + '/');
    return new URL(appBase + endpoint, window.location.origin);
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

    return '<button type="button" class="qride-collect-card qride-collect-card--' + config.className + '" ' +
      'data-collect-history="true" data-transport-type="' + escapeHtml(typeKey) + '" ' +
      'data-route-number="' + escapeHtml(route) + '" ' +
      'aria-label="' + escapeHtml(label) + '" style="animation-delay:' + Math.min(index * 25, 150) + 'ms">' +
        '<span class="qride-collect-card-art">' +
          '<img class="qride-collect-vehicle" src="' + config.image + '" alt="" loading="lazy" decoding="async">' +
        '</span>' +
        '<span class="qride-collect-card-footer">' +
          '<strong class="qride-collect-card-route' + longCaptionClass + '">№ ' + escapeHtml(route) + '</strong>' +
          '<span class="qride-collect-card-rides">' + trips + ' ' + tripLabel + '</span>' +
        '</span>' +
      '</button>';
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

  function initializeHistoryModal() {
    if (historyLayer) return;

    historyLayer = document.createElement('div');
    historyLayer.className = 'qride-collect-info qride-collect-history';
    historyLayer.id = 'qride-collect-history';
    historyLayer.hidden = true;
    historyLayer.innerHTML =
      '<button class="qride-collect-info-backdrop" type="button" data-collect-history-close aria-label="Закрыть историю"></button>' +
      '<section class="qride-collect-info-sheet qride-collect-history-sheet" role="dialog" aria-modal="true" aria-labelledby="qride-collect-history-title">' +
        '<div class="qride-collect-info-grabber"></div>' +
        '<div class="qride-collect-history-heading">' +
          '<div class="qride-collect-history-heading-copy">' +
            '<span class="qride-collect-history-kicker">QRIDE COLLECT</span>' +
            '<h4 id="qride-collect-history-title">История поездок</h4>' +
            '<p class="qride-collect-history-subtitle" id="qride-collect-history-subtitle"></p>' +
          '</div>' +
          '<button class="qride-collect-info-close" type="button" data-collect-history-close aria-label="Закрыть">×</button>' +
        '</div>' +
        '<div class="qride-collect-history-scroll">' +
          '<p class="qride-collect-history-status" id="qride-collect-history-status" role="status" aria-live="polite"></p>' +
          '<div class="qride-collect-history-list" id="qride-collect-history-list"></div>' +
        '</div>' +
      '</section>';

    document.body.appendChild(historyLayer);
    historySubtitle = historyLayer.querySelector('#qride-collect-history-subtitle');
    historyList = historyLayer.querySelector('#qride-collect-history-list');
    historyStatus = historyLayer.querySelector('#qride-collect-history-status');

    historyLayer.addEventListener('click', function (event) {
      const ticketButton = event.target.closest('[data-collect-ticket]');
      if (ticketButton) {
        event.preventDefault();
        const selectedRide = historyRides.find(function (ride) {
          return String(ride.id) === String(ticketButton.getAttribute('data-collect-ticket'));
        });
        if (!selectedRide) return;
        if (typeof window.restoreRoadnoteTicketFromHistory !== 'function') {
          historyStatus.textContent = 'Не удалось открыть билет. Перезапусти QRide и попробуй ещё раз.';
          return;
        }
        closeHistory();
        window.restoreRoadnoteTicketFromHistory(selectedRide);
        return;
      }

      if (event.target === historyLayer || event.target.closest('[data-collect-history-close]')) {
        closeHistory();
      }
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && historyLayer && !historyLayer.hidden) closeHistory();
    });

    const sheet = historyLayer.querySelector('.qride-collect-history-sheet');
    if (sheet) {
      let startX = 0;
      let startY = 0;
      let startScrollTop = 0;
      let startInList = false;
      let trackingTouch = false;

      // Match the FAQ drawer: normal list scrolling never dismisses the modal.
      // Only a deliberate long pull from the very top of the list may close it.
      sheet.addEventListener('touchstart', function (event) {
        if (historyLayer.hidden || !event.touches || event.touches.length !== 1) {
          trackingTouch = false;
          return;
        }
        const target = event.target;
        if (target && target.closest && target.closest('[data-collect-history-close], [data-collect-ticket]')) {
          trackingTouch = false;
          return;
        }
        const touch = event.touches[0];
        startX = touch.clientX;
        startY = touch.clientY;
        const scrollArea = target && target.closest ? target.closest('.qride-collect-history-scroll') : null;
        startInList = Boolean(scrollArea);
        startScrollTop = scrollArea ? scrollArea.scrollTop : -1;
        trackingTouch = true;
      }, { passive: true });

      sheet.addEventListener('touchend', function (event) {
        if (!trackingTouch || !event.changedTouches || !event.changedTouches.length) return;
        const touch = event.changedTouches[0];
        const dx = touch.clientX - startX;
        const dy = touch.clientY - startY;
        trackingTouch = false;

        const threshold = startInList ? 150 : 65;
        const canClose = !startInList || startScrollTop <= 1;
        if (canClose && dy >= threshold && dy > Math.abs(dx) * 1.25) closeHistory();
      }, { passive: true });

      sheet.addEventListener('touchcancel', function () {
        trackingTouch = false;
      }, { passive: true });
    }
  }

  function formatRideDate(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return 'Дата неизвестна';
    const dateText = new Intl.DateTimeFormat('ru-RU', {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    }).format(date);
    const timeText = new Intl.DateTimeFormat('ru-RU', {
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
    return dateText + ', ' + timeText;
  }

  function formatRidePrice(value) {
    if (value === null || value === undefined || value === '') return 'Стоимость не указана';
    const amount = Number(value);
    if (!Number.isFinite(amount)) return 'Стоимость не указана';
    return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(amount) + ' ₽';
  }

  function renderHistory(rides, typeLabel, routeNumber) {
    historyRides = Array.isArray(rides) ? rides : [];
    historySubtitle.textContent = typeLabel + ' №' + routeNumber + ' · ' +
      historyRides.length + ' ' + pluralizeTrips(historyRides.length);

    historyList.innerHTML = historyRides.map(function (ride) {
      const rideId = Number(ride.id);
      if (!Number.isSafeInteger(rideId) || rideId < 1) return '';
      const vehicleNumber = String(ride.vehicle_number || '').trim() || '—';
      return '<article class="qride-collect-history-item">' +
        '<div class="qride-collect-history-details">' +
          '<strong class="qride-collect-history-date">' + escapeHtml(formatRideDate(ride.scanned_at)) + '</strong>' +
          '<span class="qride-collect-history-vehicle">Т/С ' + escapeHtml(vehicleNumber) + '</span>' +
          '<small class="qride-collect-history-price">' + escapeHtml(formatRidePrice(ride.price)) + '</small>' +
        '</div>' +
        '<button class="qride-collect-history-ticket" type="button" data-collect-ticket="' + rideId + '">К билету</button>' +
      '</article>';
    }).join('');

    historyStatus.textContent = historyRides.length ? '' : 'Пока нет поездок на этом маршруте.';
  }

  async function openHistory(card) {
    initializeHistoryModal();
    if (historyController) historyController.abort();

    historyTrigger = card;
    historyPageScrollY = window.scrollY || window.pageYOffset || 0;
    historyPreviousBodyOverflow = document.body.style.overflow;
    historyPreviousBodyPosition = document.body.style.position;
    historyPreviousBodyTop = document.body.style.top;
    historyPreviousBodyLeft = document.body.style.left;
    historyPreviousBodyRight = document.body.style.right;
    historyPreviousBodyWidth = document.body.style.width;
    document.body.style.overflow = 'hidden';
    document.body.style.position = 'fixed';
    document.body.style.top = '-' + historyPageScrollY + 'px';
    document.body.style.left = '0';
    document.body.style.right = '0';
    document.body.style.width = '100%';

    const typeKey = String(card.getAttribute('data-transport-type') || '').trim().toLowerCase();
    const routeNumber = normalizeRoute(card.getAttribute('data-route-number'));
    const typeLabel = typeKey.charAt(0).toUpperCase() + typeKey.slice(1);
    historyLayer.hidden = false;
    historySubtitle.textContent = typeLabel + ' №' + routeNumber;
    historyList.innerHTML = '';
    historyStatus.textContent = 'Загружаем историю поездок…';

    const controller = new AbortController();
    historyController = controller;
    const currentSequence = ++historyRequestSequence;

    try {
      const url = getApiUrl('api/collect/history');
      url.searchParams.set('transportType', typeKey);
      url.searchParams.set('routeNumber', routeNumber);
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: { 'Authorization': getVkAuthorizationHeader() },
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal
      });
      const payload = await response.json().catch(function () { return {}; });
      if (!response.ok || payload.ok !== true) {
        throw new Error(payload.error || 'Не удалось загрузить историю поездок');
      }
      if (currentSequence !== historyRequestSequence || historyLayer.hidden) return;
      renderHistory(payload.rides, typeLabel, routeNumber);
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      if (currentSequence !== historyRequestSequence || historyLayer.hidden) return;
      historyStatus.textContent = error && error.message
        ? error.message
        : 'Не удалось загрузить историю поездок.';
    } finally {
      if (currentSequence === historyRequestSequence) historyController = null;
    }
  }

  function closeHistory() {
    if (!historyLayer || historyLayer.hidden) return;
    historyLayer.hidden = true;
    if (historyController) {
      historyController.abort();
      historyController = null;
    }
    document.body.style.overflow = historyPreviousBodyOverflow;
    document.body.style.position = historyPreviousBodyPosition;
    document.body.style.top = historyPreviousBodyTop;
    document.body.style.left = historyPreviousBodyLeft;
    document.body.style.right = historyPreviousBodyRight;
    document.body.style.width = historyPreviousBodyWidth;
    window.scrollTo(0, historyPageScrollY);
    if (historyTrigger && historyTrigger.isConnected) historyTrigger.focus({ preventScroll: true });
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
    pageScrollY = window.scrollY || window.pageYOffset || 0;
    previousBodyOverflow = document.body.style.overflow;
    previousBodyPosition = document.body.style.position;
    previousBodyTop = document.body.style.top;
    previousBodyLeft = document.body.style.left;
    previousBodyRight = document.body.style.right;
    previousBodyWidth = document.body.style.width;
    document.body.style.overflow = 'hidden';
    document.body.style.position = 'fixed';
    document.body.style.top = '-' + pageScrollY + 'px';
    document.body.style.left = '0';
    document.body.style.right = '0';
    document.body.style.width = '100%';
    infoLayer.hidden = false;
    const closeButton = infoLayer.querySelector('.qride-collect-info-close');
    if (closeButton) closeButton.focus({ preventScroll: true });
  }

  function closeInfo() {
    if (!infoLayer || infoLayer.hidden) return;
    infoLayer.hidden = true;
    document.body.style.overflow = previousBodyOverflow;
    document.body.style.position = previousBodyPosition;
    document.body.style.top = previousBodyTop;
    document.body.style.left = previousBodyLeft;
    document.body.style.right = previousBodyRight;
    document.body.style.width = previousBodyWidth;
    window.scrollTo(0, pageScrollY);
    if (infoTrigger && infoTrigger.isConnected) infoTrigger.focus({ preventScroll: true });
  }

  if (infoLayer) {
    // Keep the fixed sheet outside the scrollable start-screen overlay so it
    // is anchored to the viewport rather than to that scrolling container.
    document.body.appendChild(infoLayer);

    closeButtons.forEach(function (button) {
      button.addEventListener('click', closeInfo);
    });
    infoLayer.addEventListener('click', function (event) {
      if (event.target === infoLayer || event.target.closest('[data-collect-close]')) closeInfo();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !infoLayer.hidden) closeInfo();
    });

    const sheet = infoLayer.querySelector('.qride-collect-info-sheet');
    if (sheet) {
      let startX = 0;
      let startY = 0;
      let trackingTouch = false;
      sheet.addEventListener('touchstart', function (event) {
        if (infoLayer.hidden || !event.touches || event.touches.length !== 1) {
          trackingTouch = false;
          return;
        }
        const target = event.target;
        if (target && target.closest && target.closest('button')) {
          trackingTouch = false;
          return;
        }
        startX = event.touches[0].clientX;
        startY = event.touches[0].clientY;
        trackingTouch = true;
      }, { passive: true });
      sheet.addEventListener('touchend', function (event) {
        if (!trackingTouch || !event.changedTouches || !event.changedTouches.length) return;
        const dx = event.changedTouches[0].clientX - startX;
        const dy = event.changedTouches[0].clientY - startY;
        trackingTouch = false;
        if (dy > 65 && dy > Math.abs(dx) * 1.2) closeInfo();
      }, { passive: true });
      sheet.addEventListener('touchcancel', function () { trackingTouch = false; }, { passive: true });
    }
  }

  window.addEventListener('roadnote:scan-success', refreshCollection);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') refreshCollection();
  });

  initializeHistoryModal();
  track.addEventListener('click', function (event) {
    const card = event.target.closest('[data-collect-history]');
    if (card && track.contains(card)) openHistory(card);
  });
  bindUnknownCard();
  refreshCollection();
})();