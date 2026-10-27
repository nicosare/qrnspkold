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
      if (button) button.textContent = state.activeTariffRequest ? 'Открыть заявку' : 'Оставить заявку';
    });
  }

  function renderRequestRow(request, status) {
    const label = status === 'active' ? statusLabel(request) : status === 'approved' ? 'Одобрена' : 'Отклонена';
    const pillClass = status === 'approved' ? 'approved' : status === 'rejected' ? 'rejected' : request.status === 'awaiting_review' ? 'review' : '';
    const meta = [request.kind === 'pack' ? request.quantity + ' сканов' : request.quantity + ' мес. безлимита', dateLabel(request.createdAt)].filter(Boolean).join(' · ');
    return '<button class="tariff-application-row" type="button" data-open-tariff-request="' + esc(request.id) + '">' +
      '<span class="tariff-application-main"><span class="tariff-application-name">' + esc(request.name) + '</span>' +
      '<span class="tariff-application-meta">' + esc(meta) + '</span>' +
      '<span class="tariff-status-pill ' + pillClass + '">' + esc(label) + '</span></span>' +
      '<span class="tariff-application-price">' + esc(rubles(request.priceRub)) + '</span></button>';
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
      if (status !== 'active') {
        const row = renderRequestRow(request, status);
        return row.replace('<button class="tariff-application-row"', '<div class="tariff-application-row"').replace('data-open-tariff-request="' + esc(request.id) + '"', '').replace('</button>', '</div>');
      }
      return renderRequestRow(request, status);
    }).join('');
  }

  function renderState(next) {
    state = {
      hasPurchased: Boolean(next && next.hasPurchased),
      activeTariffRequest: next && next.activeTariffRequest ? next.activeTariffRequest : null,
      tariffRequestHistory: next && Array.isArray(next.tariffRequestHistory) ? next.tariffRequestHistory : []
    };
    updatePrices();
    renderListGroup(activeNode, 'Активная заявка', state.activeTariffRequest ? [state.activeTariffRequest] : [], 'active');
    renderListGroup(approvedNode, 'Одобренные', state.tariffRequestHistory.filter(function (item) { return item.status === 'approved'; }), 'approved');
    renderListGroup(rejectedNode, 'Отклонённые', state.tariffRequestHistory.filter(function (item) { return item.status === 'rejected'; }), 'rejected');
    if (tariffStatus) {
      tariffStatus.textContent = state.activeTariffRequest
        ? (state.activeTariffRequest.status === 'awaiting_review' ? 'Скриншот получен. Заявка ожидает проверки.' : 'Заявка сохранена. Скриншот оплаты можно отправить в блоке «Заявки».')
        : '';
      tariffStatus.classList.remove('is-error');
    }
    if (modal && !modal.hidden && state.activeTariffRequest && activeModalRequest && Number(activeModalRequest.id) === Number(state.activeTariffRequest.id)) {
      activeModalRequest = state.activeTariffRequest;
      renderModal();
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
      '<p>Ссылка на оплату появится позже (пока заглушка).</p>' +
      '<p>После оплаты прикрепи сюда скриншот или фотографию подтверждения. После проверки администратор подключит тариф.</p></div></div>';
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
    content += '<div class="tariff-modal-actions"><button class="tariff-modal-danger" id="tariff-request-cancel" type="button">Отозвать активную заявку</button></div>';
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
    if (state.activeTariffRequest) { openModal(state.activeTariffRequest); return; }
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
        openModal(error.data.activeTariffRequest);
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
    if (!window.confirm('Отозвать активную заявку? После этого можно будет выбрать другой тариф.')) return;
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
      if (button) { button.disabled = false; button.textContent = 'Отозвать активную заявку'; }
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
    if (row && state.activeTariffRequest && Number(row.dataset.openTariffRequest) === Number(state.activeTariffRequest.id)) {
      openModal(state.activeTariffRequest);
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
