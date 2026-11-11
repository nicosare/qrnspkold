
(function () {
  'use strict';
  const section = document.getElementById('qride-lucky');
  if (!section) return;

  const rail = document.getElementById('qride-lucky-rail');
  const windowNode = document.getElementById('qride-lucky-window');
  const spinButton = document.getElementById('qride-lucky-spin');
  const costNode = document.getElementById('qride-lucky-cost');
  const balanceNode = document.getElementById('qride-lucky-balance');
  const freeStatusNode = document.getElementById('qride-lucky-free-status');
  const statusNode = document.getElementById('qride-lucky-status');
  const oddsButton = document.getElementById('qride-lucky-info');
  const oddsLink = document.getElementById('qride-lucky-odds-link');
  const oddsModal = document.getElementById('qride-lucky-odds-modal');
  const oddsList = document.getElementById('qride-lucky-odds-list');
  const resultModal = document.getElementById('qride-lucky-result-modal');
  const resultIcon = document.getElementById('qride-lucky-result-icon');
  const resultTitle = document.getElementById('qride-lucky-result-title');
  const resultDetail = document.getElementById('qride-lucky-result-detail');
  const resultMeta = document.getElementById('qride-lucky-result-meta');
  const insufficientModal = document.getElementById('qride-lucky-insufficient-modal');
  const insufficientCopy = document.getElementById('qride-lucky-insufficient-copy');
  const packagesNode = document.getElementById('qride-lucky-packages');

  const launchParams = window.location.search.slice(1);
  const pathName = window.location.pathname;
  const appBase = pathName.endsWith('/') ? pathName :
    (pathName.slice(pathName.lastIndexOf('/') + 1).includes('.') ? pathName.slice(0, pathName.lastIndexOf('/') + 1) : pathName + '/');
  const storageKey = 'qrideLuckyPendingRequest';
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let state = null;
  let activeModal = null;
  let activeSpin = null;
  let spinning = false;
  let spinAnimationToken = 0;
  let idleFrame = 0;
  let idleLastTime = 0;
  let idleOffset = 0;
  let idleCycleWidth = 0;
  let isIntersecting = true;
  let lockedScrollY = 0;
  let backgroundLocked = false;
  let closeTimer = 0;
  let touchStartY = 0;
  let touchStartX = 0;

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char];
    });
  }
  function apiUrl(path) { return new URL(appBase + path.replace(/^\/+/, ''), window.location.origin); }
  async function apiPost(path, payload) {
    const response = await fetch(apiUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ launchParams: launchParams }, payload || {})),
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
  function typeLabel(type) {
    return type === 'subscription' ? 'Безлимит' : type === 'scans' ? 'Сканы' : 'Энергия';
  }
  function scanWord(value) {
    const n = Math.abs(Number(value) || 0), last = n % 10, lastTwo = n % 100;
    return lastTwo >= 11 && lastTwo <= 14 ? 'сканов' : last === 1 ? 'скан' : last >= 2 && last <= 4 ? 'скана' : 'сканов';
  }
  function typeIcon(type) {
    return type === 'subscription' ? '∞' : type === 'scans' ? '▧' : 'ϟ';
  }
  function amountDetail(prize) {
    if (prize.rewardType === 'subscription') return 'Безлимитное сканирование на ' + Number(prize.amount) + ' ' +
      (Number(prize.amount) === 1 ? 'день' : Number(prize.amount) >= 2 && Number(prize.amount) <= 4 ? 'дня' : 'дней');
    if (prize.rewardType === 'scans') return 'Сканы уже добавлены на твой баланс.';
    return 'Энергия уже начислена в QRide Arcade.';
  }
  function getPrizes() {
    return state && Array.isArray(state.prizes) ? state.prizes.filter(function (item) { return item && item.enabled !== false; }) : [];
  }
  function sortedAttractive(prizes) {
    const score = function (item) {
      if (item.rewardType === 'subscription') return 1000 + Number(item.amount || 0);
      if (item.rewardType === 'scans') return 500 + Number(item.amount || 0) * 10;
      return 100 + Number(item.amount || 0);
    };
    return prizes.slice().sort(function (a, b) { return score(b) - score(a); });
  }
  function cardMarkup(prize) {
    const type = String(prize.rewardType || 'energy');
    const className = 'qride-lucky-card qride-lucky-card--' + (['energy','scans','subscription'].includes(type) ? type : 'energy');
    return '<div class="' + className + '" data-lucky-prize="' + escapeHtml(prize.id) + '">' +
      '<span class="qride-lucky-card-icon" aria-hidden="true">' + typeIcon(type) + '</span>' +
      '<span class="qride-lucky-card-title">' + escapeHtml(prize.title) + '</span></div>';
  }
  function renderIdleRail() {
    const prizes = sortedAttractive(getPrizes());
    if (!prizes.length) { rail.innerHTML = ''; return; }
    const items = prizes.concat(prizes, prizes);
    rail.innerHTML = items.map(cardMarkup).join('');
    idleCycleWidth = prizes.length > 1 ? rail.children[prizes.length].offsetLeft - rail.children[0].offsetLeft
      : (rail.children[0].offsetWidth + 8);
    idleOffset = idleCycleWidth ? idleOffset % idleCycleWidth : 0;
    rail.style.transition = 'none';
    rail.style.transform = 'translate3d(' + (-idleOffset) + 'px,0,0)';
  }
  function stopIdle() {
    if (idleFrame) cancelAnimationFrame(idleFrame);
    idleFrame = 0;
    idleLastTime = 0;
  }
  function idleTick(time) {
    idleFrame = 0;
    if (spinning || document.visibilityState === 'hidden' || !isIntersecting || reduceMotion || !idleCycleWidth) return;
    if (idleLastTime) idleOffset = (idleOffset + Math.min(40, time - idleLastTime) * 0.018) % idleCycleWidth;
    idleLastTime = time;
    rail.style.transform = 'translate3d(' + (-idleOffset) + 'px,0,0)';
    idleFrame = requestAnimationFrame(idleTick);
  }
  function startIdle() {
    stopIdle();
    if (spinning || activeModal || document.visibilityState === 'hidden' || !isIntersecting || reduceMotion) return;
    idleFrame = requestAnimationFrame(idleTick);
  }
  function setStatus(message, isError) {
    statusNode.textContent = message || '';
    statusNode.classList.toggle('is-error', Boolean(isError));
  }
  function updateControls() {
    if (!state) return;
    const free = Number(state.freeSpinsRemaining || 0) > 0;
    const cost = Number(state.spinCostScans || 1);
    spinButton.querySelector('span').textContent = 'Испытать удачу';
    costNode.textContent = free ? 'Бесплатно' : cost + ' ' + scanWord(cost);
    balanceNode.textContent = 'Баланс: ' + Number(state.scanBalance || 0) + ' ' + scanWord(state.scanBalance || 0) +
      (state.subscriptionActive ? '\nБезлимит активен' : '');
    balanceNode.style.whiteSpace = 'pre-line';
    const freeRemaining = Number(state.freeSpinsRemaining || 0);
    freeStatusNode.textContent = free
      ? (freeRemaining === 1 ? 'Бесплатная попытка доступна' : 'Бесплатных попыток: ' + freeRemaining)
      : Number(state.freeSpinsPerDay || 0) > 0 ? 'Следующая бесплатная попытка — завтра' : 'Бесплатные попытки отключены';
    spinButton.disabled = spinning || Boolean(state.pendingResult);
    if (state.pendingResult) setStatus('У тебя есть неоткрытая награда. Забери её, чтобы продолжить.', false);
  }
  function openModal(modal) {
    if (!modal) return;
    stopIdle();
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = 0;
    if (!backgroundLocked) {
      lockedScrollY = window.scrollY || window.pageYOffset || 0;
      document.body.classList.add('qride-lucky-open');
      document.body.style.position = 'fixed';
      document.body.style.top = '-' + lockedScrollY + 'px';
      document.body.style.left = '0';
      document.body.style.right = '0';
      document.body.style.width = '100%';
      backgroundLocked = true;
    }
    if (activeModal && activeModal !== modal) activeModal.hidden = true;
    activeModal = modal;
    modal.classList.remove('is-opening', 'is-closing');
    modal.hidden = false;
    void modal.offsetWidth;
    modal.classList.add('is-opening');
    requestAnimationFrame(function () {
      if (activeModal === modal && !modal.hidden) modal.classList.remove('is-opening');
    });
  }
  function unlockBackground() {
    if (!backgroundLocked) return;
    backgroundLocked = false;
    document.body.classList.remove('qride-lucky-open');
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.left = '';
    document.body.style.right = '';
    document.body.style.width = '';
    window.scrollTo(0, lockedScrollY);
  }
  function closeModal(modal, acknowledge) {
    const target = modal || activeModal;
    if (!target || target.hidden || target.classList.contains('is-closing')) return;
    target.classList.remove('is-opening');
    target.classList.add('is-closing');
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = window.setTimeout(function () {
      target.hidden = true;
      target.classList.remove('is-opening', 'is-closing');
      closeTimer = 0;
      if (activeModal === target) activeModal = null;
      if (!activeModal) unlockBackground();
      if (acknowledge && activeSpin) acknowledgeSpin(activeSpin.id);
      else if (!activeModal) startIdle();
    }, 220);
  }
  async function acknowledgeSpin(spinId) {
    const completedSpin = activeSpin;
    try {
      await apiPost('api/lucky/ack', { spinId: spinId });
    } catch (error) {
      console.warn('[QRide lucky acknowledgement]', error.message);
      activeSpin = null;
      if (state && completedSpin) state.pendingResult = completedSpin;
      if (completedSpin) showResult(completedSpin, true);
      return;
    }
    activeSpin = null;
    try { sessionStorage.removeItem(storageKey); } catch (_) {}
    if (state) state.pendingResult = null;
    updateControls();
    setStatus('', false);
    renderIdleRail();
    startIdle();
  }
  function iconForResult(type) { return typeIcon(type); }
  function showResult(spin, restored) {
    if (!spin || (activeSpin && Number(activeSpin.id) === Number(spin.id))) return;
    activeSpin = spin;
    resultIcon.textContent = iconForResult(spin.rewardType);
    resultIcon.classList.toggle('is-subscription', spin.rewardType === 'subscription');
    resultTitle.textContent = spin.title || 'Награда получена';
    resultDetail.textContent = amountDetail(spin);
    resultMeta.textContent = (spin.isFree ? 'Бесплатная попытка' : 'Потрачено: ' + Number(spin.scanCost || 0) + ' ' + scanWord(spin.scanCost || 0)) +
      ' · Шанс этой награды: ' + Number(spin.probability || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + '%';
    if (restored) setStatus('Прокрутка завершилась, пока приложение было закрыто. Награда уже начислена.', false);
    openModal(resultModal);
  }
  function openOdds() {
    const prizes = sortedAttractive(getPrizes());
    oddsList.innerHTML = prizes.map(function (prize) {
      const rare = prize.rewardType === 'subscription' || Number(prize.probability || 0) <= 1;
      return '<div class="qride-lucky-odds-row' + (rare ? ' is-rare' : '') + '">' +
        '<div class="qride-lucky-odds-main"><span class="qride-lucky-odds-icon">' + typeIcon(prize.rewardType) + '</span>' +
        '<span class="qride-lucky-odds-title">' + escapeHtml(prize.title) + '</span></div>' +
        '<span class="qride-lucky-odds-probability">' + Number(prize.probability).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%</span></div>';
    }).join('');
    openModal(oddsModal);
  }
  function weightedPrize() {
    const prizes = getPrizes();
    const total = prizes.reduce(function (sum, prize) { return sum + Number(prize.probability || 0); }, 0);
    let point = Math.random() * total;
    for (let i = 0; i < prizes.length; i += 1) {
      point -= Number(prizes[i].probability || 0);
      if (point < 0) return prizes[i];
    }
    return prizes[prizes.length - 1];
  }
  function nearestVisiblePrize() {
    const cards = Array.from(rail.children);
    if (!cards.length) return sortedAttractive(getPrizes())[0];
    const marker = windowNode.getBoundingClientRect().left + windowNode.clientWidth / 2;
    let nearest = cards[0], distance = Infinity;
    cards.forEach(function (card) {
      const rect = card.getBoundingClientRect();
      const current = Math.abs(rect.left + rect.width / 2 - marker);
      if (current < distance) { distance = current; nearest = card; }
    });
    return getPrizes().find(function (item) { return item.id === nearest.dataset.luckyPrize; }) || sortedAttractive(getPrizes())[0];
  }
  function triggerHaptic(style) {
    try {
      if (window.vkBridge && typeof window.vkBridge.send === 'function') {
        Promise.resolve(window.vkBridge.send('VKWebAppTapticImpactOccurred', { style: style || 'light' })).catch(function () {
          if (navigator.vibrate) navigator.vibrate(style === 'medium' ? 24 : 8);
        });
      } else if (navigator.vibrate) navigator.vibrate(style === 'medium' ? 24 : 8);
    } catch (_) {}
  }
  function centerOffset(index) {
    const card = rail.children[index];
    return card.offsetLeft + card.offsetWidth / 2 - windowNode.clientWidth / 2;
  }
  function animateToPrize(prize) {
    const animationToken = ++spinAnimationToken;
    return new Promise(function (resolve) {
      const startPrize = nearestVisiblePrize();
      const sequence = [startPrize];
      for (let i = 0; i < 29; i += 1) sequence.push(weightedPrize());
      sequence.push(prize);
      rail.innerHTML = sequence.map(cardMarkup).join('');
      rail.style.transition = 'none';
      const startOffset = centerOffset(0);
      const targetIndex = sequence.length - 1;
      const targetOffset = centerOffset(targetIndex);
      rail.style.transform = 'translate3d(' + (-startOffset) + 'px,0,0)';
      void rail.offsetWidth;
      const duration = reduceMotion ? 450 : 4650;
      const startedAt = performance.now();
      let lastPassed = 0;
      let tickCount = 0;
      function frame(now) {
        if (animationToken !== spinAnimationToken) { resolve(false); return; }
        const progress = Math.min(1, (now - startedAt) / duration);
        const eased = progress < 0.5
          ? 4 * progress * progress * progress
          : 1 - Math.pow(-2 * progress + 2, 3) / 2;
        const offset = startOffset + (targetOffset - startOffset) * eased;
        rail.style.transform = 'translate3d(' + (-offset) + 'px,0,0)';
        const passed = Math.max(0, Math.floor((offset - startOffset) / 124));
        if (passed > lastPassed) {
          tickCount += passed - lastPassed;
          lastPassed = passed;
          if (tickCount % 3 === 0) triggerHaptic('light');
        }
        if (progress < 1) requestAnimationFrame(frame);
        else {
          rail.style.transform = 'translate3d(' + (-targetOffset) + 'px,0,0)';
          triggerHaptic('medium');
          resolve(true);
        }
      }
      requestAnimationFrame(frame);
    });
  }
  function renderPackages() {
    const offers = ['scans_9', 'scans_29', 'scans_49'];
    packagesNode.innerHTML = offers.map(function (id) {
      const card = document.querySelector('.start-offer[data-offer-id="' + id + '"]');
      const count = card && card.querySelector('.start-offer-count');
      const price = card && card.querySelector('.start-offer-current-price');
      return '<button class="qride-lucky-package" type="button" data-lucky-package="' + id + '">' +
        '<strong>' + escapeHtml(count ? count.textContent.trim() : (id === 'scans_9' ? '9' : id === 'scans_29' ? '29' : '49')) + '</strong>' +
        '<span>сканов</span><small>' + escapeHtml(price ? price.textContent.trim() : 'Выбрать пакет') + '</small></button>';
    }).join('');
  }
  function openInsufficient(data) {
    const required = Number(data && data.requiredScans || state && state.spinCostScans || 1);
    const balance = Number(data && data.scanBalance != null ? data.scanBalance : state && state.scanBalance || 0);
    insufficientCopy.textContent = 'Для следующей прокрутки нужен ' + required + ' ' +
      (required === 1 ? 'скан' : required >= 2 && required <= 4 ? 'скана' : 'сканов') +
      '. Сейчас доступно: ' + balance + '. Выбери пакет, чтобы продолжить.';
    renderPackages();
    openModal(insufficientModal);
  }
  async function runSpin() {
    if (spinning || !state || state.pendingResult) return;
    spinning = true;
    stopIdle();
    spinButton.disabled = true;
    setStatus('Определяем награду…', false);
    let requestId = '';
    try {
      requestId = sessionStorage.getItem(storageKey) || '';
      if (!requestId) {
        requestId = (window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(16).slice(2));
        sessionStorage.setItem(storageKey, requestId);
      }
    } catch (_) {
      requestId = String(Date.now()) + '-' + Math.random().toString(16).slice(2);
    }
    try {
      const data = await apiPost('api/lucky/spin', { requestId: requestId });
      state = data;
      updateControls();
      setStatus('', false);
      if (data.spin) {
        const animationCompleted = await animateToPrize(data.spin);
        if (animationCompleted) showResult(data.spin, false);
      }
    } catch (error) {
      if (error.status === 402 && error.data && error.data.code === 'INSUFFICIENT_SCANS') {
        if (error.data.prizes) state = error.data;
        updateControls();
        try { sessionStorage.removeItem(storageKey); } catch (_) {}
        openInsufficient(error.data);
      } else {
        setStatus(error.message || 'Не удалось выполнить прокрутку.', true);
        try {
          const refreshed = await apiPost('api/lucky/state', {});
          state = refreshed;
          if (refreshed.pendingResult) showResult(refreshed.pendingResult, true);
          else updateControls();
        } catch (_) {}
      }
    } finally {
      spinning = false;
      if (state && !state.pendingResult && !activeSpin) spinButton.disabled = false;
      if (!activeModal) startIdle();
    }
  }
  async function refreshState() {
    if (!launchParams || document.visibilityState === 'hidden') return;
    try {
      const next = await apiPost('api/lucky/state', {});
      state = next;
      if (!next.pendingResult) {
        try { sessionStorage.removeItem(storageKey); } catch (_) {}
      }
      if (!state.enabled || !Array.isArray(state.prizes) || !state.prizes.length) {
        section.hidden = true;
        stopIdle();
        return;
      }
      section.hidden = false;
      renderIdleRail();
      updateControls();
      if (next.pendingResult && !activeSpin) showResult(next.pendingResult, true);
      else startIdle();
      setStatus('', false);
    } catch (error) {
      console.warn('[QRide lucky state]', error.message);
    }
  }

  spinButton.addEventListener('click', runSpin);
  oddsButton.addEventListener('click', openOdds);
  oddsLink.addEventListener('click', openOdds);
  packagesNode.addEventListener('click', function (event) {
    const button = event.target.closest('[data-lucky-package]');
    if (!button) return;
    const offer = document.querySelector('.start-offer[data-offer-id="' + button.dataset.luckyPackage + '"] .start-offer-details');
    if (!offer) return;
    closeModal(insufficientModal, false);
    window.setTimeout(function () { offer.click(); }, 240);
  });
  document.addEventListener('click', function (event) {
    const closeButton = event.target.closest('[data-lucky-close]');
    if (closeButton) { closeModal(closeButton.closest('.qride-lucky-modal'), false); return; }
    if (event.target.closest('[data-lucky-result-close]')) {
      closeModal(resultModal, true);
      return;
    }
  });
  [oddsModal, resultModal, insufficientModal].forEach(function (modal) {
    const sheet = modal.querySelector('.qride-lucky-sheet');
    if (sheet) {
      sheet.addEventListener('touchstart', function (event) {
        if (!event.touches || event.touches.length !== 1) return;
        touchStartY = event.touches[0].clientY;
        touchStartX = event.touches[0].clientX;
      }, { passive: true });
      sheet.addEventListener('touchend', function (event) {
        if (!event.changedTouches || event.changedTouches.length !== 1 || modal.hidden) return;
        const dy = event.changedTouches[0].clientY - touchStartY;
        const dx = event.changedTouches[0].clientX - touchStartX;
        if (dy > 90 && Math.abs(dx) < 70 && sheet.scrollTop <= 0) closeModal(modal, modal === resultModal);
      }, { passive: true });
    }
    modal.addEventListener('click', function (event) {
      if (event.target === modal) closeModal(modal, modal === resultModal);
    });
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && activeModal) closeModal(activeModal, activeModal === resultModal);
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      stopIdle();
      if (spinning) spinAnimationToken += 1;
    } else { refreshState(); if (!activeModal) startIdle(); }
  });
  window.addEventListener('focus', refreshState);
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(function (entries) {
      isIntersecting = Boolean(entries[0] && entries[0].isIntersecting);
      if (isIntersecting) startIdle(); else stopIdle();
    }, { rootMargin: '80px' });
    observer.observe(section);
  }
  refreshState();
})();
