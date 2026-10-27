(function () {
  const communityId = 242494208;
  const statusNode = document.getElementById('start-tariff-status');
  const cards = Array.from(document.querySelectorAll('.start-offer[data-offer-id]'));
  const buttons = cards.map(function (card) { return card.querySelector('.start-offer-details'); }).filter(Boolean);
  const launchParams = window.location.search.slice(1);
  let activeRequest = null;
  let hasPurchased = false;
  let busyOfferId = '';

  function apiUrl(path) {
    const pathname = window.location.pathname;
    const appBase = pathname.endsWith('/')
      ? pathname
      : (pathname.slice(pathname.lastIndexOf('/') + 1).includes('.')
          ? pathname.slice(0, pathname.lastIndexOf('/') + 1)
          : pathname + '/');
    return new URL(appBase + path, window.location.origin);
  }

  function setStatus(message, isError) {
    if (!statusNode) return;
    statusNode.textContent = String(message || '');
    statusNode.classList.toggle('is-error', Boolean(isError));
  }

  function formatRubles(value) {
    return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Number(value) || 0) + ' ₽';
  }

  function formatUnitPrice(value, quantity, kind) {
    const unit = Number(value) / Math.max(1, Number(quantity) || 1);
    if (kind === 'subscription') {
      return '≈ ' + new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(unit)) + ' ₽ / мес.';
    }
    return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(unit) + ' ₽ / скан';
  }

  function updatePrices() {
    cards.forEach(function (card) {
      const regular = Number(card.dataset.regularPrice);
      const promo = Number(card.dataset.promoPrice);
      const price = hasPurchased ? regular : promo;
      const oldPrice = card.querySelector('.start-offer-old-price');
      const currentPrice = card.querySelector('.start-offer-current-price');
      const discount = card.querySelector('.start-offer-discount');
      const unitPrice = card.querySelector('.start-offer-unit-price');
      if (oldPrice) oldPrice.hidden = hasPurchased;
      if (currentPrice) currentPrice.textContent = formatRubles(price);
      if (discount) discount.hidden = hasPurchased;
      if (unitPrice) unitPrice.textContent = formatUnitPrice(price, card.dataset.quantity, card.dataset.offerKind);
    });
  }

  function renderState(next) {
    if (!next || typeof next !== 'object') return;
    if (typeof next.hasPurchased === 'boolean') hasPurchased = next.hasPurchased;
    activeRequest = next.activeTariffRequest || null;
    updatePrices();
    cards.forEach(function (card) {
      const button = card.querySelector('.start-offer-details');
      if (!button) return;
      const isRequested = Boolean(activeRequest && activeRequest.offerId === card.dataset.offerId);
      button.classList.toggle('is-requested', isRequested);
      button.textContent = isRequested ? 'Запрошено' : (busyOfferId === card.dataset.offerId ? 'Отправляем…' : 'Оставить заявку');
      button.disabled = Boolean(busyOfferId) || isRequested;
      button.setAttribute('aria-pressed', isRequested ? 'true' : 'false');
    });
    if (next.notice) {
      setStatus(next.notice, false);
    } else if (activeRequest) {
      setStatus(
        activeRequest.status === 'awaiting_review'
          ? 'Скриншот получен. Заявка ожидает подтверждения.'
          : 'Заявка отправлена. Пришли скриншот оплаты в сообщения Roadnote.',
        false
      );
    } else {
      setStatus('');
    }
  }

  async function requestTariff(card) {
    if (!card || busyOfferId) return;
    const offerId = card.dataset.offerId;
    if (activeRequest && activeRequest.offerId === offerId) {
      setStatus('Эта заявка уже отправлена. Для выбора другого тарифа нажми другую синюю кнопку.', false);
      return;
    }
    if (!window.vkBridge || typeof window.vkBridge.send !== 'function') {
      setStatus('Открой Roadnote внутри VK Mini App, чтобы оставить заявку.', true);
      return;
    }
    if (!launchParams) {
      setStatus('Не найдены параметры VK. Закрой и заново открой Mini App.', true);
      return;
    }

    busyOfferId = offerId;
    renderState({ hasPurchased: hasPurchased, activeTariffRequest: activeRequest });
    setStatus('Проверяю разрешение на сообщения…', false);
    async function checkCommunityPermission() {
      const response = await fetch(apiUrl('api/tariffs/permission'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ launchParams: launchParams }),
        cache: 'no-store',
        credentials: 'omit'
      });
      const data = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(data.error || 'Не удалось проверить разрешение VK.');
      return data.ok === true && data.allowed === true;
    }

    try {
      let permissionAlreadyGranted = false;
      try {
        permissionAlreadyGranted = await checkCommunityPermission();
      } catch (checkError) {
        console.warn('[Roadnote tariff permission pre-check]', checkError);
      }

      if (!permissionAlreadyGranted) {
        setStatus('Запрашиваю разрешение на сообщения от сообщества…', false);
        let bridgeError = null;
        try {
          await window.vkBridge.send('VKWebAppAllowMessagesFromGroup', { group_id: communityId });
        } catch (error) {
          // Some VK clients reject the bridge promise even after the user
          // accepts the native dialog. Verify the actual permission with VK API
          // before deciding whether the request should be stopped.
          bridgeError = error;
          console.warn('[Roadnote tariff permission dialog result]', error);
        }

        let permissionGranted = false;
        try {
          permissionGranted = await checkCommunityPermission();
        } catch (checkError) {
          console.warn('[Roadnote tariff permission post-check]', checkError);
        }

        if (!permissionGranted) {
          throw new Error(
            bridgeError
              ? 'VK закрыл окно, но сервер пока не видит разрешение. Проверь, что разрешаешь сообщения именно от сообщества Roadnote (ID ' + communityId + '), затем закрой и заново открой Mini App.'
              : 'VK не подтвердил разрешение на сообщения. Проверь разрешение для сообщества Roadnote и попробуй ещё раз.'
          );
        }
      }
    } catch (error) {
      console.info('[Roadnote tariff] Community messages permission was not confirmed:', error);
      busyOfferId = '';
      renderState({ hasPurchased: hasPurchased, activeTariffRequest: activeRequest });
      setStatus(error && error.message ? error.message : 'Не удалось проверить разрешение на сообщения.', true);
      return;
    }

    setStatus('Отправляю заявку…', false);
    try {
      const response = await fetch(apiUrl('api/tariffs/request'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ launchParams: launchParams, offerId: offerId }),
        cache: 'no-store',
        credentials: 'omit'
      });
      const data = await response.json().catch(function () { return {}; });
      if (!response.ok || !data.ok) throw new Error(data.error || 'Не удалось отправить заявку.');
      renderState(data);
      setStatus('Сообщение от Roadnote отправлено. Пришли скриншот оплаты в этот диалог.', false);
    } catch (error) {
      console.error('[Roadnote tariff request]', error);
      setStatus(error && error.message ? error.message : 'Не удалось оставить заявку. Попробуй ещё раз.', true);
    } finally {
      const lastStatus = statusNode ? statusNode.textContent : '';
      const wasError = Boolean(statusNode && statusNode.classList.contains('is-error'));
      busyOfferId = '';
      renderState({ hasPurchased: hasPurchased, activeTariffRequest: activeRequest });
      if (wasError) setStatus(lastStatus, true);
    }
  }

  buttons.forEach(function (button) {
    button.addEventListener('click', function (event) {
      event.preventDefault();
      requestTariff(button.closest('.start-offer'));
    });
  });

  window.setRoadnoteTariffState = renderState;

  async function refreshState() {
    if (!launchParams || document.visibilityState === 'hidden') return;
    try {
      const response = await fetch(apiUrl('api/tariffs/state'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ launchParams: launchParams }),
        cache: 'no-store',
        credentials: 'omit'
      });
      if (!response.ok) return;
      const data = await response.json();
      renderState(data);
    } catch (error) {
      console.warn('[Roadnote tariff state refresh]', error);
    }
  }

  let lastRefreshAt = 0;
  function refreshIfDue() {
    if (Date.now() - lastRefreshAt < 1200) return;
    lastRefreshAt = Date.now();
    refreshState();
  }
  window.addEventListener('focus', refreshIfDue);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') refreshIfDue();
  });
})();