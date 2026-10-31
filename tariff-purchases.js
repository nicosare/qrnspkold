(function () {
  const launchParams = window.location.search.slice(1);
  const cards = Array.from(document.querySelectorAll('.start-offer[data-offer-id]'));
  const modal = document.getElementById('tariff-application-modal');
  const modalContent = document.getElementById('tariff-modal-content');
  const modalStatus = document.getElementById('tariff-modal-status');
  const tariffStatus = document.getElementById('start-tariff-status');
  const tariffNote = document.getElementById('start-offers-note');
  const promoForm = document.getElementById('start-promo-form');
  const promoInput = document.getElementById('start-promo-input');
  const promoApplyButton = document.getElementById('start-promo-apply');
  const promoRemoveButton = document.getElementById('start-promo-remove');
  const promoCurrent = document.getElementById('start-promo-current');
  const promoCurrentTitle = document.getElementById('start-promo-current-title');
  const promoCurrentDescription = document.getElementById('start-promo-current-description');
  const promoStatus = document.getElementById('start-promo-status');
  let state = { hasPurchased: false, activePromoCode: null, activeTariffRequests: [], activeTariffRequest: null, tariffRequestHistory: [] };
  let busy = false;
  let activePurchase = null;
  let lockedScrollY = 0;
  let touchStartY = 0;
  let touchStartX = 0;
  const statusTimers = new WeakMap();

  function setTransientStatus(element, message, isError) {
    if (!element) return;
    const previous = statusTimers.get(element);
    if (previous) clearTimeout(previous);
    element.textContent = message || '';
    element.classList.toggle('is-error', Boolean(isError));
    if (!message) { statusTimers.delete(element); return; }
    statusTimers.set(element, setTimeout(function () {
      element.textContent = '';
      element.classList.remove('is-error');
      statusTimers.delete(element);
    }, 5000));
  }

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
      const firstPurchasePrice = Number(card.dataset.promoPrice);
      const activePromo = state.activePromoCode;
      const promoApplies = Boolean(activePromo && Array.isArray(activePromo.offerIds) && activePromo.offerIds.includes(card.dataset.offerId));
      const basePrice = promoApplies || state.hasPurchased ? regular : firstPurchasePrice;
      const price = promoApplies ? Math.max(1, Math.round(basePrice * (100 - Number(activePromo.discountPercent)) / 100)) : basePrice;
      const oldPrice = card.querySelector('.start-offer-old-price');
      const currentPrice = card.querySelector('.start-offer-current-price');
      const discount = card.querySelector('.start-offer-discount');
      const unitPrice = card.querySelector('.start-offer-unit-price');
      if (oldPrice) oldPrice.hidden = promoApplies ? regular === price : (state.hasPurchased || regular === basePrice);
      const nextPriceText = rubles(price);
      if (currentPrice && currentPrice.textContent !== nextPriceText) {
        currentPrice.textContent = nextPriceText;
        if (typeof window.qrideAnimateStartValue === 'function') window.qrideAnimateStartValue(currentPrice);
      }
      if (discount) {
        if (!discount.dataset.defaultText) discount.dataset.defaultText = discount.textContent;
        discount.hidden = promoApplies ? regular === price : (state.hasPurchased || regular === basePrice);
        discount.textContent = promoApplies ? '−' + Number(activePromo.discountPercent) + '% по коду' : discount.dataset.defaultText;
      }
      const quantity = Math.max(1, Number(card.dataset.quantity) || 1);
      const nextUnitPriceText = card.dataset.offerKind === 'subscription'
        ? '≈ ' + rubles(Math.round(price / quantity)) + ' / мес.'
        : new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(price / quantity) + ' ₽ / скан';
      if (unitPrice && unitPrice.textContent !== nextUnitPriceText) {
        unitPrice.textContent = nextUnitPriceText;
        if (typeof window.qrideAnimateStartValue === 'function') window.qrideAnimateStartValue(unitPrice);
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
      activePromoCode: next && next.activePromoCode && typeof next.activePromoCode === 'object' ? next.activePromoCode : null,
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
    renderPromoState();
    window.dispatchEvent(new CustomEvent('qride:tariff-state-ready', { detail: { hasPurchased: state.hasPurchased } }));
    if (tariffStatus && next && next.notice) setTransientStatus(tariffStatus, next.notice, false);
    if (activePurchase && next && /Оплата подтверждена/.test(String(next.notice || ''))) {
      activePurchase.status = 'approved';
      renderModal();
      setModalStatus('Оплата подтверждена. Покупка начислена.', false);
    }
    // Mood message is chosen once by initializePage(); tariff state updates must not reroll it.
  }
  function setPromoStatus(message, isError) {
    setTransientStatus(promoStatus, message, isError);
  }
  function renderPromoState() {
    if (!promoCurrent) return;
    const promo = state.activePromoCode;
    promoCurrent.hidden = !promo;
    if (promo) {
      if (promoCurrentTitle) promoCurrentTitle.textContent = String(promo.code || '') + ' · скидка ' + Number(promo.discountPercent || 0) + '%';
      if (promoCurrentDescription) promoCurrentDescription.textContent = 'Действует на ' + (Array.isArray(promo.offerIds) ? promo.offerIds.length : 0) + ' тариф(а/ов). Промокод будет использован после успешной оплаты.';
      if (promoApplyButton) promoApplyButton.textContent = 'Заменить';
      if (promoInput && !promoInput.value) promoInput.placeholder = 'Введи другой код';
    } else {
      if (promoApplyButton) promoApplyButton.textContent = 'Применить';
      if (promoInput) promoInput.placeholder = 'Введи промокод';
    }
  }
  async function applyPromo(event) {
    if (event) event.preventDefault();
    if (busy) return;
    const code = String(promoInput && promoInput.value || '').trim().toUpperCase();
    if (!code) { setPromoStatus('Введи промокод.', true); return; }
    busy = true;
    if (promoApplyButton) { promoApplyButton.disabled = true; promoApplyButton.textContent = 'Проверяем…'; }
    try {
      const data = await apiPost('api/promocodes/apply', { code: code });
      if (modal && !modal.hidden) closeModal();
      renderState(data);
      if (data.rewardType === 'scans') {
        window.dispatchEvent(new CustomEvent('qride:entitlement-state', { detail: {
          scanBalance: data.scanBalance,
          subscriptionUntil: data.subscriptionUntil,
          unlimited: data.unlimited,
          subscriptionActive: data.subscriptionActive
        }}));
      } else if (data.rewardType === 'energy') {
        window.dispatchEvent(new CustomEvent('qride:game-state', { detail: { attempts: data.energy }}));
      }
      if (promoInput) promoInput.value = '';
      setPromoStatus(data.notice || (data.rewardType ? 'Баланс пополнен.' : 'Промокод применён. Скидка будет закреплена после успешной оплаты.'), false);
    } catch (error) {
      if (error.data) renderState(error.data);
      setPromoStatus(error.message || 'Не удалось применить промокод.', true);
    } finally {
      busy = false;
      if (promoApplyButton) { promoApplyButton.disabled = false; promoApplyButton.textContent = state.activePromoCode ? 'Заменить' : 'Применить'; }
    }
  }
  async function removePromo() {
    if (busy) return;
    busy = true;
    if (promoRemoveButton) { promoRemoveButton.disabled = true; promoRemoveButton.textContent = 'Отменяем…'; }
    try {
      const data = await apiPost('api/promocodes/remove', {});
      if (modal && !modal.hidden) closeModal();
      renderState(data);
      setPromoStatus(data.notice || 'Промокод отменён.', false);
    } catch (error) {
      if (error.data) renderState(error.data);
      setPromoStatus(error.message || 'Не удалось отменить промокод.', true);
    } finally {
      busy = false;
      if (promoRemoveButton) { promoRemoveButton.disabled = false; promoRemoveButton.textContent = 'Отменить'; }
    }
  }
  if (promoForm) promoForm.addEventListener('submit', applyPromo);
  if (promoRemoveButton) promoRemoveButton.addEventListener('click', removePromo);
  if (promoInput) promoInput.addEventListener('input', function () { promoInput.value = promoInput.value.toUpperCase().replace(/[^A-Z0-9_-]/g, ''); });

  async function refreshState() {
    if (!launchParams || document.visibilityState === 'hidden') return;
    try { renderState(await apiPost('api/tariffs/state')); }
    catch (error) {
      setTransientStatus(tariffStatus, error.message, true);
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
      (purchase.promoCode ? '<div class="tariff-modal-note" style="margin-top:6px;color:#16804a;font-weight:700;">Промокод ' + esc(purchase.promoCode) + ' · скидка ' + esc(purchase.promoDiscountPercent || 0) + '%</div>' : '') +
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
      setTransientStatus(tariffStatus, 'Не найдены параметры VK. Закрой и заново открой Mini App.', true);
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
      setTransientStatus(tariffStatus, error.message, true);
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
    if (next.notice && tariffStatus) setTransientStatus(tariffStatus, next.notice, false);
  };
  window.addEventListener('roadnote:tariff-state', function (event) { window.setRoadnoteTariffState(event.detail); });
  window.addEventListener('focus', refreshState);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') refreshState(); });
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape' && modal && !modal.hidden) closeModal(); });
  refreshState();
})();