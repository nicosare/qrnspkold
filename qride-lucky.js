
(function () {
  'use strict';
  const section = document.getElementById('qride-lucky');
  if (!section) return;

  const rail = document.getElementById('qride-lucky-rail');
  const windowNode = document.getElementById('qride-lucky-window');
  const spinButton = document.getElementById('qride-lucky-spin');
  const costNode = document.getElementById('qride-lucky-cost');
  const freeStatusNode = document.getElementById('qride-lucky-free-status');
  const statusNode = document.getElementById('qride-lucky-status');
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
  let activeRevealPromise = null;
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
  let freeCountdownTimer = 0;

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
  // Reuse the exact SVGs already used by QRide Plus and QRide Arcade.
  const rewardIconNodes = {
    scans: document.querySelector('.start-offer-group:not(.start-subscription-group) .start-offer-group-icon svg'),
    subscription: document.querySelector('.start-subscription-group .start-offer-group-icon svg'),
    energy: document.querySelector('.roadnote-game-energy svg')
  };
  function typeIcon(type) {
    const icon = rewardIconNodes[type] || rewardIconNodes.energy;
    return icon ? icon.outerHTML : '';
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
      '<span class="qride-lucky-card-top"><span class="qride-lucky-card-icon" aria-hidden="true">' + typeIcon(type) + '</span>' +
      '<span class="qride-lucky-card-type">' + escapeHtml(typeLabel(type)) + '</span></span>' +
      '<strong class="qride-lucky-card-title">' + escapeHtml(prize.title) + '</strong></div>';
  }
  let railPrizeSignature = '';
  function renderIdleRail() {
    const prizes = sortedAttractive(getPrizes());
    if (!prizes.length) {
      rail.innerHTML = '';
      railPrizeSignature = '';
      idleCycleWidth = 0;
      idleOffset = 0;
      return;
    }
    const signature = prizes.map(function (item) {
      return [item.id, item.rewardType, item.amount, item.title].join(':');
    }).join('|');
    // Keep the same physical cards for idle motion, spinning and the stopped result.
    // Only rebuild when the actual prize set changes.
    if (signature !== railPrizeSignature || !rail.children.length) {
      const copies = 12;
      const items = [];
      for (let i = 0; i < copies; i += 1) items.push.apply(items, prizes);
      rail.innerHTML = items.map(cardMarkup).join('');
      railPrizeSignature = signature;
      idleCycleWidth = rail.children[prizes.length].offsetLeft - rail.children[0].offsetLeft;
      idleOffset = idleCycleWidth ? idleOffset % idleCycleWidth : 0;
    } else {
      idleCycleWidth = rail.children.length > prizes.length
        ? rail.children[prizes.length].offsetLeft - rail.children[0].offsetLeft
        : (rail.children[0].offsetWidth + 9);
    }
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
  function freeSpinAvailable() {
    if (!state) return false;
    const availableAt = Date.parse(state.freeSpinAvailableAt || '');
    return Number.isFinite(availableAt)
      ? Date.now() >= availableAt
      : Number(state.freeSpinsRemaining || 0) > 0;
  }
  function formatRemainingTime(milliseconds) {
    const totalSeconds = Math.max(0, Math.ceil(Number(milliseconds || 0) / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return hours + ' ч ' + minutes + ' мин';
    if (minutes > 0) return minutes + ' мин ' + seconds + ' сек';
    return seconds + ' сек';
  }
  function updateFreeSpinStatus() {
    if (!state) return;
    const free = freeSpinAvailable();
    const availableAt = Date.parse(state.freeSpinAvailableAt || '');
    const cost = Number(state.spinCostScans || 1);
    costNode.textContent = free ? 'Бесплатно' : cost + ' ' + scanWord(cost);
    freeStatusNode.textContent = free
      ? 'Бесплатная попытка доступна'
      : Number.isFinite(availableAt)
        ? 'Следующая бесплатная попытка через ' + formatRemainingTime(availableAt - Date.now())
        : 'Бесплатная попытка доступна';
  }
  function updateControls() {
    if (!state) return;
    spinButton.querySelector('span').textContent = 'Испытать удачу';
    updateFreeSpinStatus();
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
  async function revealSpin(spin) {
    const data = await apiPost('api/lucky/reveal', { spinId: spin.id });
    if (data.entitlement) window.dispatchEvent(new CustomEvent('qride:entitlement-state', { detail: data.entitlement }));
    if (data.gameState) window.dispatchEvent(new CustomEvent('qride:game-state', { detail: data.gameState }));
    resultDetail.textContent = amountDetail(spin);
    return true;
  }
  async function acknowledgeSpin(spinId) {
    const completedSpin = activeSpin;
    try {
      if (!completedSpin || Number(completedSpin.id) !== Number(spinId)) {
        throw new Error('Не удалось определить награду. Закрой и снова открой «Билет удачи».');
      }
      // Never acknowledge a spin until its reward is durably credited.
      let revealed = activeRevealPromise ? await activeRevealPromise : false;
      if (!revealed) revealed = await revealSpin(completedSpin);
      if (!revealed) throw new Error('Награда ещё не начислена.');
      await apiPost('api/lucky/ack', { spinId: spinId });
    } catch (error) {
      console.warn('[QRide lucky acknowledgement]', error.message);
      if (state && completedSpin) state.pendingResult = completedSpin;
      setStatus('Не удалось подтвердить начисление. Награда сохранена — попробуй закрыть это окно ещё раз.', true);
      openModal(resultModal);
      activeRevealPromise = Promise.resolve(false);
      return;
    }
    activeSpin = null;
    activeRevealPromise = null;
    try { sessionStorage.removeItem(storageKey); } catch (_) {}
    if (state) state.pendingResult = null;
    updateControls();
    setStatus('', false);
    // The winning card and the cards after it stay in the same continuous rail.
    startIdle();
  }
  function iconForResult(type) { return typeIcon(type); }
  function showResult(spin, restored) {
    if (!spin || (activeSpin && Number(activeSpin.id) === Number(spin.id))) return;
    activeSpin = spin;
    resultIcon.innerHTML = iconForResult(spin.rewardType);
    resultIcon.classList.toggle('is-subscription', spin.rewardType === 'subscription');
    resultTitle.textContent = spin.title || 'Награда получена';
    resultDetail.textContent = 'Начисляем награду…';
    resultMeta.textContent = '';
    resultMeta.hidden = true;
    if (restored) setStatus('Прокрутка завершилась. Сейчас завершим начисление награды.', false);
    openModal(resultModal);
    activeRevealPromise = revealSpin(spin).catch(function (error) {
      console.warn('[QRide lucky reveal]', error.message);
      setStatus('Не удалось начислить награду. Она сохранена — попробуй закрыть это окно ещё раз.', true);
      return false;
    });
  }
  function renderFaqPrizes() {
    const faqNode = document.getElementById('qride-lucky-faq-prizes');
    if (!faqNode) return;
    const prizes = sortedAttractive(getPrizes());
    faqNode.innerHTML = prizes.map(function (prize) {
      const probability = Number(prize.probability || 0).toLocaleString('ru-RU', {
        minimumFractionDigits: 2, maximumFractionDigits: 2
      });
      return '<div class="qride-lucky-faq-prize"><span>' + escapeHtml(prize.title) +
        '</span><strong>' + probability + '%</strong></div>';
    }).join('');
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
      renderIdleRail();
      if (!rail.children.length || !idleCycleWidth) { resolve(false); return; }

      // Continue from the exact offset where the idle rail was moving.
      const startOffset = idleOffset;
      const startCenter = startOffset + windowNode.clientWidth / 2;
      const minimumTravel = idleCycleWidth * 5;
      const targetIndex = Array.from(rail.children).findIndex(function (card, index) {
        return card.dataset.luckyPrize === String(prize.id) &&
          card.offsetLeft + card.offsetWidth / 2 >= startCenter + minimumTravel;
      });
      if (targetIndex < 0) { resolve(false); return; }

      const targetOffset = centerOffset(targetIndex);
      const firstAfterTarget = rail.children[targetIndex + 1];
      if (!firstAfterTarget) { resolve(false); return; }

      rail.style.transition = 'none';
      void rail.offsetWidth;
      const duration = reduceMotion ? 650 : 7800;
      const startedAt = performance.now();
      let centeredIndex = Array.from(rail.children).findIndex(function (card) {
        return card.offsetLeft + card.offsetWidth / 2 >= startCenter;
      });
      if (centeredIndex < 0) centeredIndex = 0;

      function frame(now) {
        if (animationToken !== spinAnimationToken) { resolve(false); return; }
        const progress = Math.min(1, (now - startedAt) / duration);
        const eased = 1 - Math.pow(1 - progress, 4);
        const offset = startOffset + (targetOffset - startOffset) * eased;
        rail.style.transform = 'translate3d(' + (-offset) + 'px,0,0)';

        while (centeredIndex < targetIndex &&
          rail.children[centeredIndex + 1] &&
          offset + windowNode.clientWidth / 2 >= rail.children[centeredIndex + 1].offsetLeft + rail.children[centeredIndex + 1].offsetWidth / 2) {
          centeredIndex += 1;
          if (!reduceMotion) triggerHaptic(centeredIndex === targetIndex ? 'medium' : 'light');
        }

        if (progress < 1) requestAnimationFrame(frame);
        else {
          // Normalize by whole cycles. Since the rail is periodic, this is visually
          // identical and lets idle motion continue without a jump or rebuilding cards.
          idleOffset = targetOffset % idleCycleWidth;
          rail.style.transform = 'translate3d(' + (-idleOffset) + 'px,0,0)';
          resolve(true);
        }
      }
      requestAnimationFrame(frame);
    });
  }
  function renderPackages() {
    const offers = ['scans_9', 'scans_29', 'scans_49'];
    packagesNode.innerHTML = offers.map(function (id) {
      const original = document.querySelector('.start-offer[data-offer-id="' + id + '"]');
      return original ? original.outerHTML : '';
    }).join('');
  }
  function openInsufficient(data) {
    const required = Number(data && data.requiredScans || state && state.spinCostScans || 1);
    insufficientCopy.textContent = 'Для прокрутки нужно ' + required + ' ' +
      scanWord(required) + '. Выбери пакет сканирований, чтобы продолжить.';
    renderPackages();
    openModal(insufficientModal);
  }
  async function runSpin() {
    if (spinning || !state || state.pendingResult) return;
    spinning = true;
    stopIdle();
    spinButton.disabled = true;
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
      window.dispatchEvent(new CustomEvent('qride:entitlement-state', { detail: data }));
      updateControls();
      setStatus('', false);
      if (data.spin) {
        const animationCompleted = await animateToPrize(data.spin);
        // If the WebView suspends or interrupts requestAnimationFrame, do not
        // leave the user with a disabled button and a hidden pending reward.
        showResult(data.spin, !animationCompleted);
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
      renderFaqPrizes();
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
  packagesNode.addEventListener('click', function (event) {
    const card = event.target.closest('.start-offer[data-offer-id]');
    if (!card || !packagesNode.contains(card)) return;
    event.preventDefault();
    event.stopPropagation();
    const offerId = card.dataset.offerId;
    closeModal(insufficientModal, false);
    window.setTimeout(function () {
      if (typeof window.qrideOpenTariffById === 'function') window.qrideOpenTariffById(offerId);
    }, 240);
  });
  document.addEventListener('click', function (event) {
    const closeButton = event.target.closest('[data-lucky-close]');
    if (closeButton) { closeModal(closeButton.closest('.qride-collect-info'), false); return; }
    if (event.target.closest('[data-lucky-result-close]')) {
      closeModal(resultModal, true);
      return;
    }
  });
  [resultModal, insufficientModal].forEach(function (modal) {
    const sheet = modal.querySelector('.qride-collect-info-sheet');
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
  if (!freeCountdownTimer) freeCountdownTimer = window.setInterval(updateFreeSpinStatus, 1000);
  refreshState();
})();
