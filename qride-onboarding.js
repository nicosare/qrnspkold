/* QRide onboarding: temporarily moves the actual Q + speech bubble into a guided layer. */
(function () {
  'use strict';

  const startOverlay = document.getElementById('start-overlay');
  const startScreen = startOverlay && startOverlay.querySelector('.start-screen');
  const brand = startScreen && startScreen.querySelector('.start-brand');
  const intro = startScreen && startScreen.querySelector('.start-intro');
  const bubble = intro && intro.querySelector('.q-speech-bubble');
  const moodMessage = document.getElementById('start-mood-message');
  const luckySection = document.getElementById('qride-lucky');
  if (!startOverlay || !startScreen || !brand || !intro || !bubble || !moodMessage) return;

  const params = new URLSearchParams(window.location.search);
  const viewerId = params.get('vk_user_id') || params.get('viewer_id') || 'guest';
  const storageRoot = 'qride:onboarding:v1:' + viewerId + ':';
  const seenKey = storageRoot + 'main-seen';
  const luckySeenKey = storageRoot + 'lucky-seen';
  const reduceMotion = Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  let tour = null;
  let firstRunTimer = 0;
  let luckyReady = false;
  let luckyAvailable = Boolean(luckySection && !luckySection.hidden);
  let luckyHintTimer = 0;
  let startObserver = null;

  function storageHas(key) {
    try { if (window.localStorage.getItem(key) === '1') return true; } catch (_) {}
    try { if (window.sessionStorage.getItem(key) === '1') return true; } catch (_) {}
    return false;
  }

  function storageSet(key) {
    try { window.localStorage.setItem(key, '1'); } catch (_) {}
    try { window.sessionStorage.setItem(key, '1'); } catch (_) {}
  }

  function isVisible(element) {
    return Boolean(element && !element.hidden && element.getClientRects().length &&
      window.getComputedStyle(element).display !== 'none' &&
      window.getComputedStyle(element).visibility !== 'hidden');
  }

  function hasOtherDialogOpen() {
    return Array.from(document.querySelectorAll('[role="dialog"]')).some(function (element) {
      return element !== startOverlay && isVisible(element);
    });
  }

  function buildMainSteps() {
    const steps = [
      {
        id: 'welcome',
        title: 'Привет! Я Кью.',
        copy: 'Давай я коротко покажу, что где находится. Это поможет быстрее освоиться в QRide.',
        reaction: 'happy',
        top: true
      },
      {
        id: 'scan',
        selector: '#start-quickbar',
        title: 'Сканирование и билет',
        copy: 'Чтобы считать транспортный QR-код, нажми «Сканировать новый QR-код». Готовый билет можно открыть кнопкой «К текущему билету». Здесь же виден баланс сканов и доступно пополнение.',
        reaction: 'curious'
      },
      {
        id: 'streak',
        selector: '#game-streak-card',
        title: 'Ежедневная серия',
        copy: 'Здесь отмечаются дни, когда ты заходил в QRide, и награды за серию. Для продолжения достаточно открывать приложение каждый день.',
        reaction: 'wink'
      }
    ];

    if (luckySection && isVisible(luckySection)) {
      steps.push({
        id: 'lucky',
        selector: '#qride-lucky',
        title: 'Билет удачи',
        copy: 'Здесь можно прокрутить рулетку и получить одну из наград. Доступность бесплатной попытки и стоимость следующей указаны под рулеткой.',
        reaction: 'curious'
      });
    }

    steps.push(
      {
        id: 'collect',
        selector: '#qride-collect',
        title: 'Коллекция',
        copy: 'Здесь собираются карточки транспорта по маршрутам. После поездок с подходящим QR-кодом новые карточки появляются в коллекции.',
        reaction: 'happy'
      },
      {
        id: 'plus',
        selector: '.start-offers-section',
        title: 'QRide Plus',
        copy: 'В этом блоке собраны пакеты сканирований и подписки. Выбирай подходящий вариант — условия и срок указаны на карточках.',
        reaction: 'wink'
      },
      {
        id: 'arcade',
        selector: '#roadnote-game .roadnote-game-head',
        title: 'QRide Arcade',
        copy: 'Здесь находятся игры QRide. За достижения можно получать дополнительные сканы, а рекорды сохраняются.',
        reaction: 'happy'
      },
      {
        id: 'referral',
        selector: '.start-referral',
        title: 'Пригласи друга',
        copy: 'Поделись ссылкой на QRide. Когда приглашённый друг впервые успешно отсканирует QR-код, тебе начислят бонусные сканы.',
        reaction: 'wink'
      },
      {
        id: 'promo',
        selector: '.start-promo',
        title: 'Промокод',
        copy: 'Если у тебя есть промокод, введи его в это поле и нажми «Применить».',
        reaction: 'curious'
      },
      {
        id: 'help',
        selector: '#start-faq-button',
        title: 'Помощь',
        copy: 'В FAQ собраны ответы на частые вопросы. Там же можно в любой момент заново пройти это знакомство.',
        reaction: 'happy'
      }
    );

    return steps.filter(function (step) {
      return step.top || isVisible(document.querySelector(step.selector));
    });
  }

  function buildLuckyStep() {
    return [{
      id: 'lucky',
      selector: '#qride-lucky',
      title: 'Билет удачи',
      copy: 'Рулетка уже доступна. Здесь можно прокрутить ленту и получить одну из наград. Условия попытки указаны прямо под ней.',
      reaction: 'curious'
    }];
  }

  function createLayer() {
    const layer = document.createElement('div');
    layer.className = 'qride-tour-layer';
    layer.hidden = true;
    layer.setAttribute('aria-label', 'Знакомство с QRide');

    const names = ['top', 'left', 'right', 'bottom'];
    const panels = {};
    names.forEach(function (name) {
      const panel = document.createElement('div');
      panel.className = 'qride-tour-panel qride-tour-panel-' + name;
      panel.setAttribute('aria-hidden', 'true');
      layer.appendChild(panel);
      panels[name] = panel;
    });

    const hole = document.createElement('div');
    hole.className = 'qride-tour-hole';
    hole.setAttribute('aria-hidden', 'true');
    layer.appendChild(hole);

    const guide = document.createElement('div');
    guide.className = 'qride-tour-guide';
    guide.setAttribute('role', 'group');
    guide.setAttribute('aria-label', 'Подсказка от Кью');
    layer.appendChild(guide);
    document.body.appendChild(layer);
    return { layer: layer, panels: panels, hole: hole, guide: guide };
  }

  function createPlaceholder(element, className) {
    const rect = element.getBoundingClientRect();
    const placeholder = document.createElement('div');
    placeholder.className = 'qride-tour-placeholder ' + className;
    placeholder.style.width = rect.width + 'px';
    placeholder.style.height = rect.height + 'px';
    element.parentNode.replaceChild(placeholder, element);
    return placeholder;
  }

  function setMessage(title, copy) {
    moodMessage.innerHTML = '';
    const titleNode = document.createElement('span');
    titleNode.className = 'qride-tour-title';
    titleNode.textContent = title;

    const copyNode = document.createElement('span');
    copyNode.className = 'qride-tour-copy';
    copyNode.textContent = copy;

    moodMessage.appendChild(titleNode);
    moodMessage.appendChild(copyNode);
  }

  function setPanelRect(panels, hole, rect) {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const pad = 8;
    const left = Math.max(8, Math.min(width - 8, rect.left - pad));
    const top = Math.max(8, Math.min(height - 8, rect.top - pad));
    const right = Math.max(left + 1, Math.min(width - 8, rect.right + pad));
    const bottom = Math.max(top + 1, Math.min(height - 8, rect.bottom + pad));
    const holeWidth = right - left;
    const holeHeight = bottom - top;

    Object.assign(panels.top.style, { left: '0px', top: '0px', width: width + 'px', height: top + 'px' });
    Object.assign(panels.left.style, { left: '0px', top: top + 'px', width: left + 'px', height: holeHeight + 'px' });
    Object.assign(panels.right.style, { left: right + 'px', top: top + 'px', width: Math.max(0, width - right) + 'px', height: holeHeight + 'px' });
    Object.assign(panels.bottom.style, { left: '0px', top: bottom + 'px', width: width + 'px', height: Math.max(0, height - bottom) + 'px' });
    Object.assign(hole.style, { left: left + 'px', top: top + 'px', width: holeWidth + 'px', height: holeHeight + 'px' });
  }

  function rectForWelcome(state) {
    const a = state.brandPlaceholder.getBoundingClientRect();
    const b = state.introPlaceholder.getBoundingClientRect();
    return {
      left: Math.min(a.left, b.left),
      top: Math.min(a.top, b.top),
      right: Math.max(a.right, b.right),
      bottom: Math.max(a.bottom, b.bottom)
    };
  }

  function positionGuide(state, targetRect, isWelcome) {
    const screenRect = startScreen.getBoundingClientRect();
    const width = Math.min(screenRect.width, window.innerWidth - 24);
    state.guide.style.width = width + 'px';
    const left = Math.max(12, Math.min(window.innerWidth - width - 12, screenRect.left));

    requestAnimationFrame(function () {
      if (!tour || tour !== state) return;
      const guideHeight = state.guide.getBoundingClientRect().height;
      const safeTop = 8 + (window.visualViewport ? Math.max(0, window.visualViewport.offsetTop) : 0);
      const safeBottom = 12;
      let top;

      if (isWelcome) {
        top = targetRect.top;
      } else {
        const above = targetRect.top - guideHeight - 18;
        const below = targetRect.bottom + 18;
        if (above >= safeTop) top = above;
        else if (below + guideHeight <= window.innerHeight - safeBottom) top = below;
        else top = Math.max(safeTop, Math.min(above, window.innerHeight - guideHeight - safeBottom));
      }

      top = Math.max(safeTop, Math.min(top, window.innerHeight - guideHeight - safeBottom));
      state.guide.style.transform = 'translate3d(' + Math.round(left) + 'px,' + Math.round(top) + 'px,0)';
      setPanelRect(state.panels, state.hole, targetRect);
    });
  }

  function getTarget(step) {
    if (step.top) return null;
    return document.querySelector(step.selector);
  }

  function showStep(state, index) {
    if (!tour || tour !== state || state.finishing) return;
    const step = state.steps[index];
    if (!step) return;
    state.index = index;
    state.currentStep = step;
    setMessage(step.title, step.copy);

    const progress = state.controls.querySelector('.qride-tour-progress');
    const nextButton = state.controls.querySelector('.qride-tour-next');
    progress.textContent = (state.mode === 'lucky' ? 'Подсказка о рулетке' : 'Знакомство · ' + (index + 1) + ' из ' + state.steps.length);
    nextButton.textContent = state.mode === 'lucky' ? 'Понятно' : (index === state.steps.length - 1 ? 'Завершить' : 'Далее');

    if (step.id === 'lucky') {
      state.sawLucky = true;
      storageSet(luckySeenKey);
    }
    if (typeof window.qrideMascotReact === 'function') window.qrideMascotReact(step.reaction || 'wink');

    if (step.top) {
      startOverlay.scrollTo({ top: 0, behavior: 'auto' });
      requestAnimationFrame(function () {
        if (!tour || tour !== state) return;
        positionGuide(state, rectForWelcome(state), true);
      });
      return;
    }

    const target = getTarget(step);
    if (!isVisible(target)) {
      if (index < state.steps.length - 1) showStep(state, index + 1);
      else finishTour(state, true);
      return;
    }

    target.scrollIntoView({
      behavior: reduceMotion ? 'auto' : 'smooth',
      block: 'center',
      inline: 'nearest'
    });

    window.setTimeout(function () {
      if (!tour || tour !== state || state.finishing) return;
      positionGuide(state, target.getBoundingClientRect(), false);
    }, reduceMotion ? 0 : 520);
  }

  function closeLayer(state) {
    state.layer.style.opacity = '0';
    window.setTimeout(function () {
      if (state.controls && state.controls.parentNode) state.controls.remove();
      state.brandPlaceholder.replaceWith(brand);
      state.introPlaceholder.replaceWith(intro);
      moodMessage.innerHTML = state.originalMessage;
      state.layer.remove();
      document.body.classList.remove('qride-tour-open');
      window.qrideOnboardingActive = false;
      tour = null;
      startOverlay.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
      if (state.mode === 'auto' || state.mode === 'replay') storageSet(seenKey);
      if (state.sawLucky) storageSet(luckySeenKey);
      maybeShowLuckyHint();
    }, reduceMotion ? 0 : 190);
  }

  function finishTour(state, completed) {
    if (!tour || tour !== state || state.finishing) return;
    state.finishing = true;
    state.guide.classList.add('is-finishing');
    state.controls.querySelectorAll('button').forEach(function (button) { button.disabled = true; });
    const title = completed ? 'На этом всё!' : 'Хорошего дня!';
    const copy = completed
      ? 'Теперь ты знаешь, где что находится. Если что-то забудется, знакомство всегда можно повторить в FAQ. Приятных поездок!'
      : 'Не буду задерживать. Если захочешь, знакомство можно повторить в FAQ. Хорошего дня!';

    setMessage(title, copy);
    if (typeof window.qrideMascotReact === 'function') window.qrideMascotReact('happy');

    startOverlay.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
    window.setTimeout(function () {
      if (!tour || tour !== state) return;
      positionGuide(state, rectForWelcome(state), true);
      setPanelRect(state.panels, state.hole, rectForWelcome(state));
      window.setTimeout(function () {
        if (!tour || tour !== state) return;
        closeLayer(state);
      }, reduceMotion ? 0 : 620);
    }, reduceMotion ? 0 : 520);
  }

  function startTour(mode) {
    if (tour || !isVisible(startOverlay) || !document.body.classList.contains('app-ready')) return false;

    const steps = mode === 'lucky' ? buildLuckyStep() : buildMainSteps();
    if (!steps.length) return false;

    if (typeof window.qridePauseMoodMessage === 'function') window.qridePauseMoodMessage();

    const state = {
      mode: mode,
      steps: steps,
      index: 0,
      currentStep: null,
      finishing: false,
      sawLucky: false,
      originalMessage: moodMessage.innerHTML,
      brandPlaceholder: createPlaceholder(brand, 'qride-tour-placeholder-brand'),
      introPlaceholder: createPlaceholder(intro, 'qride-tour-placeholder-intro'),
      layer: null,
      panels: null,
      hole: null,
      guide: null,
      controls: null
    };

    const ui = createLayer();
    state.layer = ui.layer;
    state.panels = ui.panels;
    state.hole = ui.hole;
    state.guide = ui.guide;
    state.guide.appendChild(brand);
    state.guide.appendChild(intro);

    const controls = document.createElement('div');
    controls.className = 'qride-tour-controls';
    const progress = document.createElement('span');
    progress.className = 'qride-tour-progress';
    const actions = document.createElement('div');
    actions.className = 'qride-tour-actions';
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'qride-tour-skip';
    skip.textContent = 'Пропустить';
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'qride-tour-next';
    next.textContent = 'Далее';
    actions.appendChild(skip);
    actions.appendChild(next);
    controls.appendChild(progress);
    controls.appendChild(actions);
    bubble.appendChild(controls);
    state.controls = controls;

    skip.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      finishTour(state, false);
    });
    next.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      if (state.mode === 'lucky' || state.index >= state.steps.length - 1) finishTour(state, true);
      else showStep(state, state.index + 1);
    });

    state.layer.hidden = false;
    state.layer.style.opacity = '1';
    document.body.classList.add('qride-tour-open');
    window.qrideOnboardingActive = true;
    tour = state;
    showStep(state, 0);
    return true;
  }

  function scheduleFirstRun() {
    if (firstRunTimer || tour || !luckyReady || storageHas(seenKey)) return;
    firstRunTimer = window.setTimeout(function () {
      firstRunTimer = 0;
      if (tour || storageHas(seenKey) || !luckyReady) return;
      if (!isVisible(startOverlay) || !document.body.classList.contains('app-ready') || document.visibilityState === 'hidden' || hasOtherDialogOpen()) {
        scheduleFirstRun();
        return;
      }
      startTour('auto');
    }, 500);
  }

  function maybeShowLuckyHint() {
    if (luckyHintTimer || tour || !luckyReady || !luckyAvailable || !storageHas(seenKey) || storageHas(luckySeenKey)) return;
    luckyHintTimer = window.setTimeout(function () {
      luckyHintTimer = 0;
      if (tour || !luckyAvailable || !storageHas(seenKey) || storageHas(luckySeenKey)) return;
      if (!isVisible(startOverlay) || document.visibilityState === 'hidden' || hasOtherDialogOpen()) {
        maybeShowLuckyHint();
        return;
      }
      startTour('lucky');
    }, 420);
  }

  function installFaqReplay() {
    const faqSheet = document.querySelector('#faq-overlay .faq-sheet');
    const faqList = faqSheet && faqSheet.querySelector('.faq-list');
    if (!faqSheet || !faqList || faqSheet.querySelector('.qride-tour-faq-replay')) return;

    const replay = document.createElement('button');
    replay.type = 'button';
    replay.className = 'qride-tour-faq-replay';
    replay.textContent = 'Пройти обучение по приложению';
    replay.addEventListener('click', function () {
      const closeButton = document.getElementById('faq-close');
      if (closeButton) closeButton.click();
      window.setTimeout(function () {
        startTour('replay');
      }, 260);
    });
    faqSheet.insertBefore(replay, faqList);
  }

  window.qrideStartOnboarding = function () {
    if (tour) return false;
    if (isVisible(document.getElementById('faq-overlay'))) {
      const closeButton = document.getElementById('faq-close');
      if (closeButton) closeButton.click();
      window.setTimeout(function () { startTour('replay'); }, 260);
      return true;
    }
    return startTour('replay');
  };

  window.addEventListener('qride:lucky-state-ready', function (event) {
    luckyReady = true;
    luckyAvailable = Boolean(event.detail && event.detail.available && luckySection && !luckySection.hidden);
    scheduleFirstRun();
    maybeShowLuckyHint();
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && tour && !tour.finishing) {
      event.preventDefault();
      finishTour(tour, false);
    }
  });

  if (window.MutationObserver) {
    startObserver = new MutationObserver(function () {
      if (isVisible(startOverlay)) {
        scheduleFirstRun();
        maybeShowLuckyHint();
      }
    });
    startObserver.observe(startOverlay, { attributes: true, attributeFilter: ['hidden', 'class', 'style'] });

  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      scheduleFirstRun();
      maybeShowLuckyHint();
    }
  });
  window.addEventListener('focus', function () {
    scheduleFirstRun();
    maybeShowLuckyHint();
  });

  installFaqReplay();
  if (luckySection && isVisible(luckySection)) {
    luckyAvailable = true;
  }
})();