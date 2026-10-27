(function () {
  const communityId = 242494208;
  const statusNode = document.getElementById('start-tariff-status');
  const cards = Array.from(document.querySelectorAll('.start-offer[data-offer-id]'));
  const buttons = cards.map(function (card) { return card.querySelector('.start-offer-details'); }).filter(Boolean);
  const launchParams = window.location.search.slice(1);
  let activeRequest = null;
  let hasPurchased = false;
  let busyOfferId = '';
  const launchUserId = new URLSearchParams(launchParams).get('vk_user_id') || '';
  const permissionStorageKey = 'roadnote:community-messages-allowed:' + communityId + ':' + launchUserId;
  let communityPermissionKnown = readSavedPermission();

  function readSavedPermission() {
    try {
      return window.localStorage.getItem(permissionStorageKey) === '1' ? true : null;
    } catch (_) {
      return null;
    }
  }

  function rememberCommunityPermission(allowed) {
    communityPermissionKnown = Boolean(allowed);
    try {
      if (allowed) window.localStorage.setItem(permissionStorageKey, '1');
      else window.localStorage.removeItem(permissionStorageKey);
    } catch (_) {
      // Permission is still verified by actual message delivery if storage is unavailable.
    }
  }

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
    } else if (!busyOfferId) {
      // A focus/visibility refresh must not erase the active permission or
      // delivery status while a tariff request is in progress.
      setStatus('');
    }
  }

  async function readCommunityMessagePermission() {
    const response = await fetch(apiUrl('api/tariffs/permission'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ launchParams: launchParams }),
      cache: 'no-store',
      credentials: 'omit'
    });
    const data = await response.json().catch(function () { return {}; });
    if (!response.ok || data.ok !== true || typeof data.allowed !== 'boolean') {
      throw new Error(data.error || 'Не удалось проверить разрешение VK.');
    }
    return data.allowed;
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

    // Invoke the native permission dialog directly from the tariff-button action.
    // VK Bridge documents this call as Promise<void>; its resolved value is not
    // required to contain { result: true }. Never gate delivery on that payload.
    if (communityPermissionKnown !== true) {
      setStatus('Запрашиваю разрешение на сообщения от Roadnote…', false);
      try {
        const permissionResult = await window.vkBridge.send('VKWebAppAllowMessagesFromGroup', {
          group_id: communityId,
          key: 'roadnote_tariff_' + launchUserId
        });
        console.info('[Roadnote permission dialog resolved]', JSON.stringify({
          userId: launchUserId,
          groupId: communityId,
          result: permissionResult && permissionResult.result
        }));
        if (!permissionResult || permissionResult.result !== true) {
          throw new Error('VK не подтвердил выдачу разрешения.');
        }

        // Do not trust the dialog closing alone: ask VK API whether permission
        // is actually active before attempting to create/send the tariff request.
        const permissionAllowed = await readCommunityMessagePermission();
        console.info('[Roadnote permission verified after dialog]', JSON.stringify({
          userId: launchUserId,
          groupId: communityId,
          allowed: permissionAllowed
        }));
        if (!permissionAllowed) {
          rememberCommunityPermission(false);
          setStatus('VK закрыл окно, но разрешение на сообщения не применилось. Попробуй открыть диалог Roadnote в VK и включить сообщения сообщества, затем вернись сюда.', true);
          return;
        }
        rememberCommunityPermission(true);
      } catch (error) {
        // Some VK clients reject the Bridge promise despite closing the consent
        // window. Try the real delivery anyway; messages.send is authoritative.
        console.warn('[Roadnote permission dialog result]', error);
      }
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
      if (!response.ok || !data.ok) {
        const requestError = new Error(data.error || 'Не удалось отправить заявку.');
        requestError.code = data.code || '';
        throw requestError;
      }
      rememberCommunityPermission(true);
      renderState(data);
      setStatus('Сообщение от Roadnote отправлено. Пришли скриншот оплаты в этот диалог.', false);
    } catch (error) {
      if (error && error.code === 'permission_denied') {
        rememberCommunityPermission(false);
      }
      console.error('[Roadnote tariff request]', error);
      const message = error && error.code === 'permission_denied'
        ? 'VK не разрешил отправить сообщение от Roadnote. Окно разрешения уже было открыто; VK не применил согласие. Проверь разрешение на сообщения у сообщества Roadnote в VK и попробуй ещё раз.'
        : (error && error.message ? error.message : 'Не удалось оставить заявку. Попробуй ещё раз.');
      setStatus(message, true);
    } finally {
      const lastStatus = statusNode ? statusNode.textContent : '';
      const wasError = Boolean(statusNode && statusNode.classList.contains('is-error'));
      busyOfferId = '';
      renderState({ hasPurchased: hasPurchased, activeTariffRequest: activeRequest });
      if (wasError) setStatus(lastStatus, true);
    }
  }

  // Check silently on launch. Permission prompts must only follow an explicit
  // tariff-button click, so they cannot race with the user's action.
  async function refreshCommunityPermissionState() {
    try {
      const allowed = await readCommunityMessagePermission();
      if (allowed) {
        rememberCommunityPermission(true);
      } else if (communityPermissionKnown !== true) {
        communityPermissionKnown = false;
      }
    } catch (error) {
      console.warn('[Roadnote permission check]', error);
    }
  }

  refreshCommunityPermissionState();

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