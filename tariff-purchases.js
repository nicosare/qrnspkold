(function () {
  const launchParams = window.location.search.slice(1);
  const cards = Array.from(document.querySelectorAll('.start-offer[data-offer-id]'));
  const modal = document.getElementById('tariff-application-modal');
  const modalContent = document.getElementById('tariff-modal-content');
  const modalStatus = document.getElementById('tariff-modal-status');
  const activeNode = document.getElementById('tariff-applications-active');
  const approvedNode = document.getElementById('tariff-applications-approved');
  const rejectedNode = document.getElementById('tariff-applications-rejected');
  const listStatus = document.getElementById('tariff-applications-status');
  const applicationsSection = document.querySelector('.start-applications-section');
  const applicationsToggle = document.getElementById('tariff-applications-toggle');
  const tariffStatus = document.getElementById('start-tariff-status');
  let state = { hasPurchased: false, activeTariffRequest: null, tariffRequestHistory: [] };
  let busy = false;
  let activeModalRequest = null;
  let selectedFile = null;
  let previewUrl = '';
  let lockedScrollY = 0;
  let touchStartY = 0;
  let touchStartX = 0;

  function apiUrl(path) {
    const pathname = window.location.pathname;
    const appBase = pathname.endsWith('/')
      ? pathname
      : (pathname.slice(pathname.lastIndexOf('/') + 1).includes('.')
          ? pathname.slice(0, pathname.lastIndexOf('/') + 1)
          : pathname + '/');
    return new URL(appBase + path, window.location.origin);
  }

  function authBody(extra) {
    return Object.assign({ launchParams: launchParams }, extra || {});
  }

  async function apiPost(path, body) {
    const response = await fetch(apiUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(authBody(body)),
      cache: 'no-store',
      credentials: 'omit'
    });
    const data = await response.json().catch(function () { return {}; });
    if (!response.ok || data.ok === false) {
      const error = new Error(data.error || 'Не удалось выполнить действие.');
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char];
    });
  }

  function rubles(value) {
    return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Number(value) || 0) + ' ₽';
  }

  function dateLabel(value) {
    if (!value) return '';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return date.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function statusLabel(request) {
    if (request.status === 'awaiting_review') return 'Скриншот отправлен · на проверке';
    if (request.status === 'approved') return 'Одобрена';
    if (request.status === 'rejected') return 'Отклонена';
    return 'Ожидает скриншот оплаты';
  }

  function updatePrices() {
    cards.forEach(function (card) {
      const regular = Number(card.dataset.regularPrice);
      const promo = Number(card.dataset.promoPrice);
      const price = state.hasPurchased ? regular : promo;
      const oldPrice = card.querySelector('.start-offer-old-price');
      const currentPrice = card.querySelector('.start-offer-current-price');
      const discount = card.querySelector('.start-offer-discount');
      const unitPrice = card.querySelector('.start-offer-unit-price');
      if (oldPrice) oldPrice.hidden = state.hasPurchased;
      if (currentPrice) currentPrice.textContent = rubles(price);
      if (discount) discount.hidden = state.hasPurchased;
      if (unitPrice) {
        const quantity = Math.max(1, Number(card.dataset.quantity) || 1);
        unitPrice.textContent = card.dataset.offerKind === 'subscription'
          ? '≈ ' + rubles(Math.round(price / quantity)) + ' / мес.'
          : new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(price / quantity) + ' ₽ / скан';
      }
      const button = card.querySelector('.start-offer-details');
      if (button) {
        const matchingRequests = (state.activeTariffRequests || []).filter(function (item) { return item.offerId === card.dataset.offerId; });
        const isActiveOffer = matchingRequests.length > 0;
        button.textContent = isActiveOffer ? 'Открыть заявку' : 'Оставить заявку';
        button.classList.toggle('is-requested', isActiveOffer);
        const matchingRequest = matchingRequests.find(function (item) { return item.status === 'awaiting_payment'; }) || matchingRequests[0];
        button.setAttribute('aria-label', isActiveOffer ? 'Открыть активную заявку: ' + (matchingRequest.name || '') : 'Оставить заявку на ' + (card.querySelector('.start-offer-name')?.textContent || card.dataset.offerId));
      }
    });
  }

  function renderRequestRow(request, status) {
    const label = status === 'active' ? statusLabel(request) : status === 'approved' ? 'Одобрена' : 'Отклонена';
    const pillClass = status === 'approved' ? 'approved' : status === 'rejected' ? 'rejected' : request.status === 'awaiting_review' ? 'review' : '';
    const meta = 'Заявка №' + request.id + ' · ' + dateLabel(request.createdAt);
    const rowTag = status === 'active' ? 'button' : 'div';
    const rowAttrs = status === 'active' ? ' type="button" data-open-tariff-request="' + esc(request.id) + '"' : '';
    return '<' + rowTag + ' class="tariff-application-row" data-request-id="' + esc(request.id) + '"' + rowAttrs + '>' +
      '<span class="tariff-application-main"><span class="tariff-application-name">' + esc(request.name) + '</span>' +
      '<span class="tariff-application-meta">' + esc(meta) + '</span>' +
      '<span class="tariff-status-pill ' + pillClass + '">' + esc(label) + '</span></span>' +
      '<span class="tariff-application-price">' + esc(rubles(request.priceRub)) + '</span></' + rowTag + '>';
  }

  function renderListGroup(node, label, requests, status) {
    if (!node) return;
    const heading = '<div class="tariff-applications-label">' + label + '</div>';
    if (!requests.length) {
      const empty = status === 'active' ? 'Активных заявок пока нет.' : status === 'approved' ? 'Пока нет одобренных заявок.' : 'Пока нет отклонённых заявок.';
      node.innerHTML = heading + '<div class="tariff-applications-empty">' + empty + '</div>';
      return;
    }
    node.innerHTML = heading + requests.map(function (request) {
      return renderRequestRow(request, status);
    }).join('');
  }

  function updateCollapsedApplications() {
    if (!applicationsSection) return;
    const rows = Array.from(applicationsSection.querySelectorAll('.tariff-application-row'));
    rows.forEach(function (row) { row.classList.remove('is-latest'); });
    applicationsSection.querySelectorAll('.tariff-applications-group').forEach(function (group) {
      group.classList.remove('has-latest-request');
    });
    if (!rows.length) return;
    const latest = rows.reduce(function (current, row) {
      return !current || Number(row.dataset.requestId) > Number(current.dataset.requestId) ? row : current;
    }, null);
    if (latest) {
      latest.classList.add('is-latest');
      const group = latest.closest('.tariff-applications-group');
      if (group) group.classList.add('has-latest-request');
    }
  }

  if (applicationsToggle && applicationsSection) {
    applicationsToggle.addEventListener('click', function () {
      const collapsed = applicationsSection.classList.toggle('is-collapsed');
      applicationsToggle.setAttribute('aria-expanded', String(!collapsed));
      applicationsToggle.setAttribute('aria-label', collapsed ? 'Развернуть заявки' : 'Свернуть заявки');
      /* Direction is styled from the section's collapsed state. */
    });
  }

  function renderState(next) {
    const activeRequests = next && Array.isArray(next.activeTariffRequests)
      ? next.activeTariffRequests
      : (next && next.activeTariffRequest ? [next.activeTariffRequest] : []);
    state = {
      hasPurchased: Boolean(next && next.hasPurchased),
      activeTariffRequests: activeRequests,
      activeTariffRequest: activeRequests.find(function (item) { return item.status === 'awaiting_payment'; }) || activeRequests[0] || null,
      tariffRequestHistory: next && Array.isArray(next.tariffRequestHistory) ? next.tariffRequestHistory : []
    };
    window.roadnoteHasPurchased = state.hasPurchased;
    updatePrices();
    renderListGroup(activeNode, 'Активные заявки', state.activeTariffRequests, 'active');
    renderListGroup(approvedNode, 'Одобренные', state.tariffRequestHistory.filter(function (item) { return item.status === 'approved'; }), 'approved');
    renderListGroup(rejectedNode, 'Отклонённые', state.tariffRequestHistory.filter(function (item) { return item.status === 'rejected'; }), 'rejected');
    updateCollapsedApplications();
    if (tariffStatus) {
      tariffStatus.textContent = state.activeTariffRequest
        ? (state.activeTariffRequest.status === 'awaiting_review' ? 'Скриншот получен. Заявка ожидает проверки.' : 'Заявка сохранена. Скриншот оплаты можно отправить в блоке «Заявки».')
        : '';
      tariffStatus.classList.remove('is-error');
    }
    if (modal && !modal.hidden && state.activeTariffRequest && activeModalRequest && Number(activeModalRequest.id) === Number(state.activeTariffRequest.id)) {
      // Preserve the selected file and its preview during routine state refreshes.
      // Rebuild the modal only when the request status actually changes.
      if (activeModalRequest.status !== state.activeTariffRequest.status) {
        activeModalRequest = state.activeTariffRequest;
        renderModal();
      } else {
        activeModalRequest = state.activeTariffRequest;
      }
    }
    if (typeof window.refreshRoadnoteMoodMessage === 'function') {
      window.refreshRoadnoteMoodMessage();
    }
  }

  async function refreshState() {
    if (!launchParams || document.visibilityState === 'hidden') return;
    try {
      const data = await apiPost('api/tariffs/state');
      renderState(data);
      if (listStatus) { listStatus.textContent = ''; listStatus.classList.remove('is-error'); }
    } catch (error) {
      if (listStatus) {
        listStatus.textContent = error.message;
        listStatus.classList.add('is-error');
      }
    }
  }

  function setModalStatus(message, isError) {
    if (!modalStatus) return;
    modalStatus.textContent = message || '';
    modalStatus.classList.toggle('is-error', Boolean(isError));
  }

  function clearSelectedFile() {
    selectedFile = null;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = '';
  }

  function lockBackgroundScroll() {
    lockedScrollY = window.scrollY || window.pageYOffset || 0;
    document.body.classList.add('start-overlay-open');
    document.body.style.position = 'fixed';
    document.body.style.top = '-' + lockedScrollY + 'px';
    document.body.style.left = '0';
    document.body.style.right = '0';
    document.body.style.width = '100%';
  }

  function unlockBackgroundScroll() {
    document.body.classList.remove('start-overlay-open');
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.left = '';
    document.body.style.right = '';
    document.body.style.width = '';
    window.scrollTo(0, lockedScrollY);
  }

  function closeModal() {
    if (!modal) return;
    modal.hidden = true;
    unlockBackgroundScroll();
    clearSelectedFile();
    setModalStatus('', false);
  }

  function renderModal() {
    if (!activeModalRequest || !modalContent) return;
    const request = activeModalRequest;
    const awaitingReview = request.status === 'awaiting_review';
    const offerName = request.name || 'Выбранный тариф';
    let content = '<div class="tariff-modal-card"><div class="tariff-modal-offer">' + esc(offerName) + '</div>' +
      '<div class="tariff-modal-price">' + esc(rubles(request.priceRub)) + '</div>' +
      '<div class="tariff-modal-note"><p>Заявка №' + esc(request.id) + ' создана.</p>' +
      (awaitingReview
        ? '<p><strong>Скриншот отправлен. Заявка ожидает проверки.</strong></p>'
        : '<p class="tariff-payment-warning">Мы не храним данные банковских карт. Оплата проходит на стороне ЮMoney — защищённого стороннего платёжного сервиса.</p>' +
          '<form class="tariff-payment-button" method="POST" action="https://yoomoney.ru/quickpay/confirm" style="margin:12px auto;max-width:330px;display:grid;gap:10px;">' +
          '<input type="hidden" name="receiver" value="4100119368734043">' +
          '<input type="hidden" name="quickpay-form" value="button">' +
          '<input type="hidden" name="sum" value="' + esc(Number(request.priceRub).toFixed(2)) + '" data-type="number">' +
          '<input type="hidden" name="label" value="roadnote-request-' + esc(request.id) + '">' +
          '<div style="font-size:13px;font-weight:600;">Способ оплаты</div>' +
          '<label style="display:flex;align-items:center;gap:8px;"><input type="radio" name="paymentType" value="AC" checked> Банковской картой</label>' +
          '<label style="display:flex;align-items:center;gap:8px;"><input type="radio" name="paymentType" value="PC"> Из кошелька ЮMoney</label>' +
          '<button type="submit" class="tariff-modal-primary">Оплатить ' + esc(rubles(request.priceRub)) + '</button>' +
          '</form>' +
          '<p>После оплаты прикрепи скриншот или фотографию подтверждения.</p>') + '</div></div>';
    if (awaitingReview) {
      content += '<div class="tariff-modal-note"><strong>Скриншот получен.</strong> Заявка передана администратору и ожидает проверки.</div>';
    } else {
      content += '<div class="tariff-upload-title">Скриншот оплаты</div>' +
        '<label class="tariff-file-label">＋ Выбрать скриншот' +
        '<input class="tariff-file-input" id="tariff-payment-file" type="file" accept="image/*">' +
        '</label>' +
        '<img id="tariff-payment-preview" class="tariff-file-preview" alt="Предпросмотр скриншота" hidden>' +
        '<div class="tariff-modal-actions"><button class="tariff-modal-primary" id="tariff-payment-send" type="button" disabled>Отправить скриншот</button></div>';
    }
    if (!awaitingReview && !request.hasScreenshot) {
      content += '<div class="tariff-modal-actions"><button class="tariff-modal-danger" id="tariff-request-cancel" type="button">Отозвать неоплаченную заявку</button></div>';
    }
    modalContent.innerHTML = content;
    const input = document.getElementById('tariff-payment-file');
    const preview = document.getElementById('tariff-payment-preview');
    const send = document.getElementById('tariff-payment-send');
    if (input) input.addEventListener('change', function () {
      clearSelectedFile();
      const file = input.files && input.files[0];
      if (!file) { if (send) send.disabled = true; return; }
      if (!['image/jpeg','image/png','image/webp'].includes(file.type)) {
        input.value = '';
        setModalStatus('Выбери изображение в формате JPG, PNG или WebP.', true);
        if (send) send.disabled = true;
        return;
      }
      if (file.size > 6 * 1024 * 1024) {
        input.value = '';
        setModalStatus('Скриншот должен быть не больше 6 МБ.', true);
        if (send) send.disabled = true;
        return;
      }
      selectedFile = file;
      previewUrl = URL.createObjectURL(file);
      if (preview) { preview.src = previewUrl; preview.hidden = false; }
      if (send) send.disabled = false;
      setModalStatus('', false);
    });
    if (send) send.addEventListener('click', uploadScreenshot);
    const cancel = document.getElementById('tariff-request-cancel');
    if (cancel) cancel.addEventListener('click', cancelRequest);
  }

  function openModal(request) {
    if (!modal || !request) return;
    activeModalRequest = request;
    clearSelectedFile();
    setModalStatus('', false);
    renderModal();
    modal.hidden = false;
    lockBackgroundScroll();
  }

  async function createRequest(card) {
    if (busy) return;
    const matchingRequest = (state.activeTariffRequests || []).filter(function (item) { return item.offerId === card.dataset.offerId; })
      .sort(function (a, b) { return (a.status === 'awaiting_payment' ? -1 : 0) - (b.status === 'awaiting_payment' ? -1 : 0); })[0];
    if (matchingRequest) {
      openModal(matchingRequest);
      return;
    }
    if (!launchParams) {
      if (tariffStatus) { tariffStatus.textContent = 'Не найдены параметры VK. Закрой и заново открой Mini App.'; tariffStatus.classList.add('is-error'); }
      return;
    }
    const offerId = card.dataset.offerId;
    busy = true;
    const button = card.querySelector('.start-offer-details');
    if (button) { button.disabled = true; button.textContent = 'Создаём…'; }
    try {
      const data = await apiPost('api/tariffs/request', { offerId: offerId });
      renderState(data);
      if (data.activeTariffRequest) openModal(data.activeTariffRequest);
    } catch (error) {
      if (error.data && error.data.activeTariffRequest) {
        renderState(error.data);
        if (error.data.lockedByReview) {
          if (tariffStatus) {
            tariffStatus.textContent = error.message;
            tariffStatus.classList.add('is-error');
          }
        } else {
          openModal(error.data.activeTariffRequest);
        }
      } else if (tariffStatus) {
        tariffStatus.textContent = error.message;
        tariffStatus.classList.add('is-error');
      }
      await refreshState();
    } finally {
      busy = false;
      updatePrices();
      if (button) button.disabled = false;
    }
  }

  function fileAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { reject(new Error('Не удалось прочитать изображение.')); };
      reader.readAsDataURL(file);
    });
  }

  async function uploadScreenshot() {
    if (busy || !selectedFile || !activeModalRequest) return;
    busy = true;
    const button = document.getElementById('tariff-payment-send');
    if (button) { button.disabled = true; button.textContent = 'Отправляем…'; }
    setModalStatus('Загружаем скриншот и передаём заявку администратору…', false);
    try {
      const imageData = await fileAsDataUrl(selectedFile);
      const data = await apiPost('api/tariffs/screenshot', {
        requestId: activeModalRequest.id,
        mimeType: selectedFile.type,
        imageData: imageData
      });
      renderState(data);
      if (state.activeTariffRequest) activeModalRequest = state.activeTariffRequest;
      clearSelectedFile();
      renderModal();
      setModalStatus('Скриншот отправлен. Заявка ожидает проверки.', false);
    } catch (error) {
      if (error.data) renderState(error.data);
      setModalStatus(error.message, true);
      if (button) { button.disabled = false; button.textContent = 'Отправить скриншот'; }
    } finally {
      busy = false;
    }
  }

  async function cancelRequest() {
    if (busy || !activeModalRequest) return;
    const requestId = activeModalRequest.id;
    if (activeModalRequest.status !== 'awaiting_payment' || activeModalRequest.hasScreenshot) {
      setModalStatus('Оплаченную заявку со скриншотом отменить нельзя.', true);
      return;
    }
    if (!window.confirm('Отозвать неоплаченную заявку? После этого можно будет выбрать другой тариф.')) return;
    busy = true;
    const button = document.getElementById('tariff-request-cancel');
    if (button) { button.disabled = true; button.textContent = 'Отзываем…'; }
    setModalStatus('Отзываем заявку…', false);
    try {
      const data = await apiPost('api/tariffs/cancel', { requestId: requestId });
      renderState(data);
      closeModal();
    } catch (error) {
      if (error.data) renderState(error.data);
      setModalStatus(error.message, true);
      if (button) { button.disabled = false; button.textContent = 'Отозвать неоплаченную заявку'; }
    } finally {
      busy = false;
    }
  }

  cards.forEach(function (card) {
    const button = card.querySelector('.start-offer-details');
    if (!button) return;
    button.addEventListener('click', function (event) {
      event.preventDefault();
      createRequest(card);
    });
  });

  document.addEventListener('click', function (event) {
    const row = event.target.closest('[data-open-tariff-request]');
    if (row) {
      const request = (state.activeTariffRequests || []).find(function (item) { return Number(item.id) === Number(row.dataset.openTariffRequest); });
      if (request) openModal(request);
      return;
    }
    if (event.target.closest('[data-tariff-modal-close]')) closeModal();
  });

  if (modal) {
    const sheet = modal.querySelector('.tariff-modal-sheet');
    if (sheet) {
      sheet.addEventListener('touchstart', function (event) {
        if (!event.touches || event.touches.length !== 1) return;
        touchStartY = event.touches[0].clientY;
        touchStartX = event.touches[0].clientX;
      }, { passive: true });
      sheet.addEventListener('touchend', function (event) {
        if (!event.changedTouches || event.changedTouches.length !== 1 || modal.hidden) return;
        const deltaY = event.changedTouches[0].clientY - touchStartY;
        const deltaX = event.changedTouches[0].clientX - touchStartX;
        if (deltaY > 95 && Math.abs(deltaX) < 75 && sheet.scrollTop <= 0) closeModal();
      }, { passive: true });
    }
    modal.addEventListener('click', function (event) {
      if (event.target === modal) closeModal();
    });
  }

  // Shared SSE stream pushes tariff status changes without requiring a Mini App restart.
  window.setRoadnoteTariffState = function (next) {
    if (!next || typeof next !== 'object') return;
    renderState(next);
    if (next.notice && tariffStatus) {
      tariffStatus.textContent = next.notice;
      tariffStatus.classList.remove('is-error');
    }
  };

  window.addEventListener('roadnote:tariff-state', function (event) {
    window.setRoadnoteTariffState(event.detail);
  });

  document.getElementById('tariff-applications-refresh')?.addEventListener('click', refreshState);
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && modal && !modal.hidden) closeModal();
  });
  window.addEventListener('focus', refreshState);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') refreshState();
  });

  refreshState();
})();
