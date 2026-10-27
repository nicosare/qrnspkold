(function () {
  const launchParams = window.location.search.slice(1);
  const cards = Array.from(document.querySelectorAll('.start-offer[data-offer-id]'));
  const modal = document.getElementById('tariff-application-modal');
  const modalContent = document.getElementById('tariff-modal-content');
  const modalStatus = document.getElementById('tariff-modal-status');
  const tariffStatus = document.getElementById('start-tariff-status');
  const tariffNote = document.getElementById('start-offers-note');
  let state = { hasPurchased: false, activeTariffRequests: [], activeTariffRequest: null, tariffRequestHistory: [] };
  let busy = false;
  let activePurchase = null;
  let lockedScrollY = 0;
  let touchStartY = 0;
  let touchStartX = 0;

  function apiUrl(path) {
    const pathname = window.location.pathname;
    const appBase = pathname.endsWith('/') ? pathname :
      (pathname.slice(pathname.lastIndexOf('/') + 1).includes('.') ? pathname.slice(0, pathname.lastIndexOf('/') + 1) : pathname + '/');
    return new URL(appBase + path, window.location.origin);
  }
  function authBody(extra) { return Object.assign({ launchParams: launchParams }, extra || {}); }
  async function apiPost(path, body) {
    const response = await fetch(apiUrl(path), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(authBody(body)), cache: 'no-store', credentials: 'omit'
    });
    const data = await response.json().catch(function () { return {}; });
    if (!response.ok || data.ok === false) {
      const error = new Error(data.error || 'Не удалось выполнить действие.');
      error.status = response.status; error.data = data; throw error;
    }
    return data;
  }
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char];
    });
  }
  function rubles(value) { return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Number(value) || 0) + ' ₽'; }

  function updatePrices() {
    cards.forEach(function (card) {
      const regular = Number(card.dataset.regularPrice);
      const promo = Number(card.dataset.promoPrice);
      const price = state.hasPurchased ? regular : promo;
      const oldPrice = card.querySelector('.start-offer-old-price');
      const currentPrice = card.querySelector('.start-offer-current-price');
      const discount = card.querySelector('.start-offer-discount');
      const unitPrice = card.querySelector('.start-offer-unit-price');
      if (oldPrice) oldPrice.hidden = state.hasPurchased || regular === price;
      if (currentPrice) currentPrice.textContent = rubles(price);
      if (discount) discount.hidden = state.hasPurchased || regular === price;
      if (unitPrice) {
        const quantity = Math.max(1, Number(card.dataset.quantity) || 1);
        unitPrice.textContent = card.dataset.offerKind === 'subscription'
          ? '≈ ' + rubles(Math.round(price / quantity)) + ' / мес.'
          : new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(price / quantity) + ' ₽ / поездка';
      }
      const button = card.querySelector('.start-offer-details');
      if (button) {
        button.textContent = 'Купить';
        button.classList.remove('is-requested');
        button.setAttribute('aria-label', 'Купить ' + (card.querySelector('.start-offer-name')?.textContent || card.dataset.offerId));
      }
    });
  }
  function renderState(next) {
    state = {
      hasPurchased: Boolean(next && next.hasPurchased),
      activeTariffRequests: next && Array.isArray(next.activeTariffRequests) ? next.activeTariffRequests :
        (next && next.activeTariffRequest ? [next.activeTariffRequest] : []),
      activeTariffRequest: next && next.activeTariffRequest || null,
      tariffRequestHistory: next && Array.isArray(next.tariffRequestHistory) ? next.tariffRequestHistory : []
    };
    window.roadnoteHasPurchased = state.hasPurchased;
    if (tariffNote) tariffNote.textContent = state.hasPurchased
      ? 'Все тарифы доступны по указанным ценам. Выбирай то, что подходит именно тебе.'
      : 'Скидка действует только на первую покупку.';
    updatePrices();
    if (tariffStatus && next && next.notice) {
      tariffStatus.textContent = next.notice;
      tariffStatus.classList.remove('is-error');
    }
    if (activePurchase && next && /Оплата подтверждена/.test(String(next.notice || ''))) {
      activePurchase.status = 'approved';
      renderModal();
      setModalStatus('Оплата подтверждена. Покупка начислена.', false);
    }
    if (typeof window.refreshRoadnoteMoodMessage === 'function') window.refreshRoadnoteMoodMessage();
  }
  async function refreshState() {
    if (!launchParams || document.visibilityState === 'hidden') return;
    try { renderState(await apiPost('api/tariffs/state')); }
    catch (error) {
      if (tariffStatus) { tariffStatus.textContent = error.message; tariffStatus.classList.add('is-error'); }
    }
  }
  function setModalStatus(message, isError) {
    if (!modalStatus) return;
    modalStatus.textContent = message || '';
    modalStatus.classList.toggle('is-error', Boolean(isError));
  }
  function lockBackgroundScroll() {
    lockedScrollY = window.scrollY || window.pageYOffset || 0;
    document.body.classList.add('start-overlay-open');
    document.body.style.position = 'fixed'; document.body.style.top = '-' + lockedScrollY + 'px';
    document.body.style.left = '0'; document.body.style.right = '0'; document.body.style.width = '100%';
  }
  function unlockBackgroundScroll() {
    document.body.classList.remove('start-overlay-open');
    document.body.style.position = ''; document.body.style.top = ''; document.body.style.left = '';
    document.body.style.right = ''; document.body.style.width = '';
    window.scrollTo(0, lockedScrollY);
  }
  function closeModal() {
    if (!modal) return;
    modal.hidden = true;
    unlockBackgroundScroll();
    activePurchase = null;
    setModalStatus('', false);
  }
  function renderModal() {
    if (!activePurchase || !modalContent) return;
    const purchase = activePurchase;
    const isPaid = purchase.status === 'approved';
    const label = purchase.paymentLabel || ('roadnote-request-' + purchase.id);
    let content = '<div class="tariff-modal-card"><div class="tariff-modal-offer">' + esc(purchase.name || 'Выбранный тариф') + '</div>' +
      '<div class="tariff-modal-price">' + esc(rubles(purchase.priceRub)) + '</div><div class="tariff-modal-note">';
    if (isPaid) {
      content += '<p><strong>Покупка подтверждена.</strong></p><p>Тариф уже начислен. Баланс обновлён автоматически.</p>';
    } else {
      content += '<p>Оплата проходит через ЮMoney. После подтверждения платежа тариф начислится автоматически.</p>' +
        '<p class="tariff-payment-warning">Закрытие этой шторки ничего не отменяет. Если платёж уже отправлен, сервер обработает его после подтверждения ЮMoney.</p>' +
        '<form class="tariff-payment-button" method="POST" action="https://yoomoney.ru/quickpay/confirm" style="margin:12px auto;max-width:330px;display:grid;gap:10px;">' +
        '<input type="hidden" name="receiver" value="4100119368734043">' +
        '<input type="hidden" name="quickpay-form" value="button">' +
        '<input type="hidden" name="sum" value="' + esc(Number(purchase.priceRub).toFixed(2)) + '" data-type="number">' +
        '<input type="hidden" name="label" value="' + esc(label) + '">' +
        '<div style="font-size:13px;font-weight:600;">Способ оплаты</div>' +
        '<label style="display:flex;align-items:center;gap:8px;"><input type="radio" name="paymentType" value="AC" checked> Банковской картой</label>' +
        '<label style="display:flex;align-items:center;gap:8px;"><input type="radio" name="paymentType" value="PC"> Из кошелька ЮMoney</label>' +
        '<button type="submit" class="tariff-modal-primary">Оплатить ' + esc(rubles(purchase.priceRub)) + '</button></form>';
    }
    content += '</div></div>';
    modalContent.innerHTML = content;
  }
  function openModal(purchase) {
    if (!modal || !purchase) return;
    activePurchase = purchase;
    setModalStatus('', false);
    renderModal();
    modal.hidden = false;
    lockBackgroundScroll();
  }
  async function createPurchase(card) {
    if (busy) return;
    if (!launchParams) {
      if (tariffStatus) { tariffStatus.textContent = 'Не найдены параметры VK. Закрой и заново открой Mini App.'; tariffStatus.classList.add('is-error'); }
      return;
    }
    const offerId = card.dataset.offerId;
    const matching = state.activeTariffRequests.find(function (item) { return item.offerId === offerId && item.status === 'awaiting_payment'; });
    if (matching) { openModal(matching); return; }
    busy = true;
    const button = card.querySelector('.start-offer-details');
    if (button) { button.disabled = true; button.textContent = 'Загрузка…'; }
    try {
      const data = await apiPost('api/tariffs/request', { offerId: offerId });
      renderState(data);
      const purchase = (data.activeTariffRequests || []).find(function (item) { return Number(item.id) === Number(data.requestId); }) ||
        data.activeTariffRequest || state.activeTariffRequests.find(function (item) { return item.offerId === offerId; });
      if (purchase) openModal(purchase);
    } catch (error) {
      if (tariffStatus) { tariffStatus.textContent = error.message; tariffStatus.classList.add('is-error'); }
      if (error.data) renderState(error.data);
    } finally {
      busy = false; updatePrices();
      if (button) button.disabled = false;
    }
  }
  cards.forEach(function (card) {
    const button = card.querySelector('.start-offer-details');
    if (!button) return;
    card.setAttribute('tabindex', '0');
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', 'Выбрать тариф: ' + (card.querySelector('.start-offer-count, .start-offer-duration')?.textContent.trim() || card.dataset.offerId));
    card.addEventListener('click', function (event) {
      if (event.target.closest('button')) return;
      event.preventDefault();
      createPurchase(card);
    });
    card.addEventListener('keydown', function (event) {
      if (event.target !== card || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      createPurchase(card);
    });
    button.addEventListener('click', function (event) {
      event.preventDefault();
      createPurchase(card);
    });
  });
  document.addEventListener('click', function (event) {
    if (event.target.closest('[data-tariff-modal-close]')) closeModal();
  });
  if (modal) {
    const sheet = modal.querySelector('.tariff-modal-sheet');
    if (sheet) {
      sheet.addEventListener('touchstart', function (event) {
        if (!event.touches || event.touches.length !== 1) return;
        touchStartY = event.touches[0].clientY; touchStartX = event.touches[0].clientX;
      }, { passive: true });
      sheet.addEventListener('touchend', function (event) {
        if (!event.changedTouches || event.changedTouches.length !== 1 || modal.hidden) return;
        const dy = event.changedTouches[0].clientY - touchStartY;
        const dx = event.changedTouches[0].clientX - touchStartX;
        if (dy > 95 && Math.abs(dx) < 75 && sheet.scrollTop <= 0) closeModal();
      }, { passive: true });
    }
    modal.addEventListener('click', function (event) { if (event.target === modal) closeModal(); });
  }
  window.setRoadnoteTariffState = function (next) {
    if (!next || typeof next !== 'object') return;
    renderState(next);
    if (next.notice && tariffStatus) { tariffStatus.textContent = next.notice; tariffStatus.classList.remove('is-error'); }
  };
  window.addEventListener('roadnote:tariff-state', function (event) { window.setRoadnoteTariffState(event.detail); });
  window.addEventListener('focus', refreshState);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') refreshState(); });
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape' && modal && !modal.hidden) closeModal(); });
  refreshState();
})();