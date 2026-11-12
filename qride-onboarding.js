/* QRide onboarding: the original mascot and speech bubble become the guide. */
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
  // v2 intentionally offers the updated, visually corrected tour once to users
  // who completed the first draft of the introduction.
  const storageRoot = 'qride:onboarding:v2:' + viewerId + ':';
  const seenKey = storageRoot + 'main-seen';
  const luckySeenKey = storageRoot + 'lucky-seen';
  const reduceMotion = Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const svgNs = 'http://www.w3.org/2000/svg';

  let tour = null;
  let firstRunTimer = 0;
  let luckyReady = false;
  let luckyAvailable = Boolean(luckySection && !luckySection.hidden);
  let luckyHintTimer = 0;

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
        compactSelectors: ['.start-card-eyebrow', '.scan-balance-status'],
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
        compactSelectors: ['.qride-lucky-heading', '.qride-lucky-lead'],
        title: 'Билет удачи',
        copy: 'Здесь можно прокрутить рулетку и получить одну из наград. Доступность бесплатной попытки и стоимость следующей указаны под рулеткой.',
        reaction: 'curious'
      });
    }

    steps.push(
      {
        id: 'collect',
        selector: '#qride-collect',
        compactSelectors: ['.qride-collect-heading', '.qride-collect-lead'],
        title: 'Коллекция',
        copy: 'Здесь собираются карточки транспорта по маршрутам. После поездок с подходящим QR-кодом новые карточки появляются в коллекции.',
        reaction: 'happy'
      },
      {
        id: 'plus',
        selector: '.start-offers-section',
        compactSelectors: ['.start-offers-section-heading', '.start-offers-lead'],
        title: 'QRide Plus',
        copy: 'В этом блоке собраны пакеты сканирований и подписки. Выбирай подходящий вариант — условия и срок указаны на карточках.',
        reaction: 'wink'
      },
      {
        id: 'arcade',
        selector: '#roadnote-game',
        compactSelectors: ['#roadnote-game-title', '.arcade-section-lead'],
        title: 'QRide Arcade',
        copy: 'Здесь находятся игры QRide. За достижения можно получать дополнительные сканы, а рекорды сохраняются.',
        reaction: 'happy'
      },
      {
        id: 'q-run',
        selector: '#roadnote-game .roadnote-game-stage',
        title: 'Q Run',
        copy: 'Перепрыгивай препятствия, набирай очки и постарайся побить свой рекорд. За нужное количество очков можно получить скан.',
        reaction: 'wink'
      },
      {
        id: 'q-break',
        selector: '#qride-breaker-card',
        title: 'Q Break',
        copy: 'Отбивай мяч платформой и разбивай блоки. Чем дольше продержишься, тем выше будет результат.',
        reaction: 'curious'
      },
      {
        id: 'q-stack',
        selector: '#qride-stack-card',
        title: 'Q Stack',
        copy: 'Останавливай движущиеся блоки точно друг на друге и строй башню. Следи за темпом — со временем игра ускоряется.',
        reaction: 'happy'
      },
      {
        id: 'referral',
        selector: '.start-referral',
        compactSelectors: ['.start-referral-title', '.start-referral-description'],
        title: 'Пригласи друга',
        copy: 'Нажми «Поделиться», чтобы отправить приглашение. Рядом можно скопировать ссылку или открыть её QR-код. За первое успешное сканирование друга начислят бонусные сканы.',
        reaction: 'wink'
      },
      {
        id: 'promo',
        selector: '.start-promo',
        compactSelectors: ['.start-promo-title', '.start-promo-description'],
        title: 'Промокод',
        copy: 'Если у тебя есть промокод, введи его в это поле и нажми «Применить».',
        reaction: 'curious'
      },
      {
        id: 'help',
        selector: '#start-faq-button',
        title: 'Частые вопросы',
        copy: 'В FAQ собраны ответы на частые вопросы. Там же можно в любой момент заново пройти это знакомство.',
        reaction: 'happy'
      },
      {
        id: 'support',
        selector: '#start-support-button',
        title: 'Поддержка',
        copy: 'Если возникнет вопрос или что-то пойдёт не так, нажми сюда — откроется чат поддержки QRide.',
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
      compactSelectors: ['.qride-lucky-heading', '.qride-lucky-lead'],
      title: 'Билет удачи',
      copy: 'Рулетка уже доступна. Здесь можно прокрутить ленту и получить одну из наград. Условия попытки указаны прямо под ней.',
      reaction: 'curious'
    }];
  }

  function createSvgNode(name, attributes) {
    const node = document.createElementNS(svgNs, name);
    Object.keys(attributes || {}).forEach(function (key) {
      node.setAttribute(key, String(attributes[key]));
    });
    return node;
  }

  function createLayer() {
    const layer = document.createElement('div');
    layer.className = 'qride-tour-layer';
    layer.hidden = true;
    layer.setAttribute('aria-label', 'Знакомство с QRide');

    const blocker = document.createElement('div');
    blocker.className = 'qride-tour-blocker';
    blocker.setAttribute('aria-hidden', 'true');
    layer.appendChild(blocker);

    const svg = createSvgNode('svg', {
      class: 'qride-tour-mask',
      'aria-hidden': 'true',
      focusable: 'false',
      preserveAspectRatio: 'none'
    });
    const shade = createSvgNode('path', {
      class: 'qride-tour-shade',
      'fill-rule': 'evenodd',
      'clip-rule': 'evenodd'
    });
    const blueFrame = createSvgNode('path', { class: 'qride-tour-frame-blue' });
    const whiteFrame = createSvgNode('path', { class: 'qride-tour-frame-white' });
    svg.appendChild(shade);
    svg.appendChild(blueFrame);
    svg.appendChild(whiteFrame);
    layer.appendChild(svg);

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

    return {
      layer: layer,
      svg: svg,
      shade: shade,
      blueFrame: blueFrame,
      whiteFrame: whiteFrame,
      hole: hole,
      guide: guide
    };
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

  function roundedRectPath(left, top, width, height, radius) {
    const right = left + width;
    const bottom = top + height;
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));
    return [
      'M', left + r, top,
      'H', right - r,
      'Q', right, top, right, top + r,
      'V', bottom - r,
      'Q', right, bottom, right - r, bottom,
      'H', left + r,
      'Q', left, bottom, left, bottom - r,
      'V', top + r,
      'Q', left, top, left + r, top,
      'Z'
    ].join(' ');
  }

  function renderHighlight(state, rect) {
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    const viewport = 'M 0 0 H ' + width + ' V ' + height + ' H 0 Z ';
    state.svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    state.svg.setAttribute('width', width);
    state.svg.setAttribute('height', height);
    if (!rect) {
      state.shade.setAttribute('d', viewport);
      state.blueFrame.setAttribute('d', '');
      state.whiteFrame.setAttribute('d', '');
      state.hole.style.display = 'none';
      return;
    }
    const pad = 5;
    const left = Math.max(1, Math.min(width - 1, rect.left - pad));
    const top = Math.max(1, Math.min(height - 1, rect.top - pad));
    const right = Math.max(left + 1, Math.min(width - 1, rect.right + pad));
    const bottom = Math.max(top + 1, Math.min(height - 1, rect.bottom + pad));
    const boxWidth = right - left;
    const boxHeight = bottom - top;
    const radius = Math.min(19, boxHeight / 2, boxWidth / 2);
    const path = roundedRectPath(left, top, boxWidth, boxHeight, radius);
    state.shade.setAttribute('d', viewport + path);
    state.blueFrame.setAttribute('d', path);
    state.whiteFrame.setAttribute('d', path);
    Object.assign(state.hole.style, {
      display: 'block',
      left: left + 'px', top: top + 'px', width: boxWidth + 'px',
      height: boxHeight + 'px', borderRadius: radius + 'px'
    });
  }

  function clearHighlight(state) {
    if (state.highlightFrame) cancelAnimationFrame(state.highlightFrame);
    state.highlightFrame = 0;
    state.highlightRect = null;
    renderHighlight(state, null);
  }

  function setHighlight(state, rect) {
    if (!rect) {
      clearHighlight(state);
      return;
    }
    if (state.highlightFrame) cancelAnimationFrame(state.highlightFrame);
    const target = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    const from = state.highlightRect || target;
    const startedAt = performance.now();
    const duration = reduceMotion ? 0 : 380;
    function tick(now) {
      if (!tour || tour !== state || state.closing) return;
      const raw = duration ? Math.min(1, (now - startedAt) / duration) : 1;
      const eased = 1 - Math.pow(1 - raw, 3);
      const current = {};
      ['left', 'top', 'right', 'bottom'].forEach(function (key) {
        current[key] = from[key] + (target[key] - from[key]) * eased;
      });
      renderHighlight(state, current);
      state.highlightRect = current;
      if (raw < 1) state.highlightFrame = requestAnimationFrame(tick);
      else { state.highlightFrame = 0; state.highlightRect = target; }
    }
    state.highlightFrame = requestAnimationFrame(tick);
  }
  function getStepFocusRect(step, target, guideHeight, bounds) {
    if (!target) return null;
    const fullRect = target.getBoundingClientRect();
    const gap = 14;
    if (fullRect.height + guideHeight + gap <= bounds.height - 20) return fullRect;
    const selectors = step && step.compactSelectors;
    if (selectors && selectors.length) {
      const parts = selectors.map(function (selector) {
        return target.querySelector(selector);
      }).filter(isVisible);
      if (parts.length) {
        const rects = parts.map(function (part) { return part.getBoundingClientRect(); });
        // Keep the spotlight as wide as the real card, but limit its height
        // to the heading and subtitle when the whole card cannot fit.
        return {
          left: fullRect.left,
          // Arcade's spotlight follows the card's own top edge (including
          // its kicker), while its bottom stops exactly after the subtitle.
          top: step.id === 'arcade'
            ? fullRect.top
            : Math.min.apply(null, rects.map(function (r) { return r.top; })),
          right: fullRect.right,
          bottom: Math.max.apply(null, rects.map(function (r) { return r.bottom; }))
        };
      }
    }
    return fullRect;
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

  function viewportBounds() {
    const vv = window.visualViewport;
    const top = vv ? Math.max(0, vv.offsetTop) : 0;
    const height = vv && vv.height ? vv.height : window.innerHeight;
    return {
      top: top + 10,
      bottom: top + height - 10,
      height: height
    };
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function scrollTargetForGuide(state, target, rect, guideHeight, bounds) {
    if (!target || rect.height > bounds.height - guideHeight - 42) return false;

    const gap = 14;
    const candidates = [
      { guideTop: bounds.top, targetTop: bounds.top + guideHeight + gap, side: 'above' },
      { guideTop: bounds.bottom - guideHeight, targetTop: bounds.bottom - guideHeight - gap - rect.height, side: 'below' }
    ];
    candidates.sort(function (a, b) {
      return Math.abs(a.targetTop - rect.top) - Math.abs(b.targetTop - rect.top);
    });

    const maxScroll = Math.max(0, startOverlay.scrollHeight - startOverlay.clientHeight);
    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      const delta = candidate.targetTop - rect.top;
      const nextScroll = clamp(startOverlay.scrollTop - delta, 0, maxScroll);
      const scrollDelta = nextScroll - startOverlay.scrollTop;
      const resultingTop = rect.top - scrollDelta;
      const resultingBottom = resultingTop + rect.height;
      const guideFits = candidate.side === 'above'
        ? resultingTop >= bounds.top + guideHeight + gap - 2
        : resultingBottom <= bounds.bottom - guideHeight - gap + 2;
      if (guideFits && Math.abs(scrollDelta) > 2) {
        startOverlay.scrollTo({
          top: nextScroll,
          behavior: reduceMotion ? 'auto' : 'smooth'
        });
        return true;
      }
    }
    return false;
  }

  function positionGuide(state, target, isWelcome, attempt) {
    if (!tour || tour !== state || state.closing) return;
    const screenRect = startScreen.getBoundingClientRect();
    const width = Math.min(screenRect.width, window.innerWidth - 24);
    state.guide.style.width = width + 'px';
    const left = clamp(screenRect.left, 12, window.innerWidth - width - 12);
    const retry = Number(attempt || 0);

    requestAnimationFrame(function () {
      if (!tour || tour !== state || state.closing) return;
      const guideHeight = state.guide.getBoundingClientRect().height;
      const bounds = viewportBounds();
      const gap = 14;
      let rect = isWelcome ? rectForWelcome(state) : getStepFocusRect(state.currentStep, target, guideHeight, bounds);
      let top;

      if (isWelcome) {
        top = clamp(rect.top, bounds.top, Math.max(bounds.top, bounds.bottom - guideHeight));
      } else {
        const canPlaceAbove = rect.top - guideHeight - gap >= bounds.top;
        const canPlaceBelow = rect.bottom + gap + guideHeight <= bounds.bottom;

        if (canPlaceAbove && canPlaceBelow) {
          // Keep the guide on the side with more spare room.
          const roomAbove = rect.top - bounds.top;
          const roomBelow = bounds.bottom - rect.bottom;
          top = roomBelow >= roomAbove ? rect.bottom + gap : rect.top - guideHeight - gap;
        } else if (canPlaceAbove) {
          top = rect.top - guideHeight - gap;
        } else if (canPlaceBelow) {
          top = rect.bottom + gap;
        } else {
          // Do not initiate a second corrective scroll here. Keep the page
          // stationary and place Q on the side with the greater free area.
          const roomAbove = rect.top - bounds.top;
          const roomBelow = bounds.bottom - rect.bottom;
          top = roomBelow >= roomAbove
            ? bounds.bottom - guideHeight
            : bounds.top;
        }
      }

      top = clamp(top, bounds.top, Math.max(bounds.top, bounds.bottom - guideHeight));
      state.guide.style.transform = 'translate3d(' + Math.round(left) + 'px,' + Math.round(top) + 'px,0)';
      if (isWelcome) {
        clearHighlight(state);
        // The welcome is a full-screen introduction: dim everything, with no
        // spotlight cutout around the mascot placeholder.
        state.svg.style.opacity = '1';
        state.hole.style.opacity = '0';
      } else {
        setHighlight(state, rect);
        state.svg.style.opacity = '1';
        state.hole.style.opacity = '1';
      }
      if (state.revealTimer) clearTimeout(state.revealTimer);
      state.revealTimer = window.setTimeout(function () {
        state.revealTimer = 0;
        if (!tour || tour !== state || state.closing) return;
        state.guide.style.opacity = '1';
      }, reduceMotion ? 0 : 430);
    });
  }

  function getTarget(step) {
    if (!step || step.top) return null;
    return document.querySelector(step.selector);
  }

  function waitForTargetScroll(target, callback) {
    let settled = false;
    let fallbackTimer = 0;
    let settleTimer = 0;
    function cleanup() {
      startOverlay.removeEventListener('scrollend', onScrollEnd);
      startOverlay.removeEventListener('scroll', onScroll, { passive: true });
      if (fallbackTimer) clearTimeout(fallbackTimer);
      if (settleTimer) clearTimeout(settleTimer);
    }
    function finish() {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    }
    function onScroll() {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = window.setTimeout(finish, 140);
    }
    function onScrollEnd() {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = window.setTimeout(finish, 70);
    }
    startOverlay.addEventListener('scroll', onScroll, { passive: true });
    startOverlay.addEventListener('scrollend', onScrollEnd, { passive: true });
    // Fallback for older VK WebViews; allow the smooth scroll to finish first.
    fallbackTimer = window.setTimeout(finish, reduceMotion ? 50 : 1050);
    if (reduceMotion) finish();
  }

  function showStep(state, index) {
    if (!tour || tour !== state || state.finishing) return;
    const step = state.steps[index];
    if (!step) return;
    state.index = index;
    state.currentStep = step;
    state.guide.style.opacity = '0';
    if (state.revealTimer) {
      clearTimeout(state.revealTimer);
      state.revealTimer = 0;
    }
    // Keep the previous spotlight geometry during the scroll, but fade it
    // out. The next spotlight will animate from the previous position.
    state.svg.style.opacity = '0';
    state.hole.style.opacity = '0';
    setMessage(step.title, step.copy);

    const progress = state.controls.querySelector('.qride-tour-progress');
    const nextButton = state.controls.querySelector('.qride-tour-next');
    progress.textContent = 'Знакомство · ' + (index + 1) + ' из ' + state.steps.length;
    nextButton.textContent = index === state.steps.length - 1 ? 'Завершить' : 'Далее';

    if (step.id === 'lucky') {
      state.sawLucky = true;
      storageSet(luckySeenKey);
    }
    if (typeof window.qrideMascotReact === 'function') window.qrideMascotReact(step.reaction || 'wink');

    if (step.top) {
      startOverlay.scrollTo({ top: 0, behavior: 'auto' });
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          if (!tour || tour !== state) return;
          positionGuide(state, null, true, 0);
        });
      });
      return;
    }

    const target = getTarget(step);
    if (!isVisible(target)) {
      if (index < state.steps.length - 1) showStep(state, index + 1);
      else finishTour(state, true);
      return;
    }

    // The start overlay is the page's only intended scroller. Center the
    // target when the guide and spotlight can share the viewport; otherwise
    // keep the target near the top so its heading is not hidden.
    // Avoid scrollIntoView: WebViews may scroll both the overlay and window.
    const targetRect = target.getBoundingClientRect();
    const bounds = viewportBounds();
    const guideHeight = state.guide.getBoundingClientRect().height;
    const gap = 14;
    const canCenter = targetRect.height + guideHeight + gap <= bounds.height - 20;
    const desiredTargetTop = canCenter
      ? bounds.top + (bounds.height - targetRect.height) / 2
      : bounds.top + 18;
    const desiredTop = startOverlay.scrollTop + targetRect.top - desiredTargetTop;
    const maxScroll = Math.max(0, startOverlay.scrollHeight - startOverlay.clientHeight);
    const nextScrollTop = clamp(desiredTop, 0, maxScroll);
    if (Math.abs(nextScrollTop - startOverlay.scrollTop) < 2) {
      positionGuide(state, target, false, 0);
      return;
    }
    startOverlay.scrollTo({
      top: nextScrollTop,
      behavior: reduceMotion ? 'auto' : 'smooth'
    });

    waitForTargetScroll(target, function () {
      if (!tour || tour !== state || state.finishing) return;
      positionGuide(state, target, false, 0);
    });
  }

  function restoreOriginalElements(state) {
    if (state.controls && state.controls.parentNode) state.controls.remove();
    state.brandPlaceholder.replaceWith(brand);
    state.introPlaceholder.replaceWith(intro);
    moodMessage.innerHTML = state.originalMessage;
    state.layer.remove();
    document.body.classList.remove('qride-tour-open');
    window.qrideOnboardingActive = false;
    tour = null;

    if (state.mode === 'auto' || state.mode === 'replay') storageSet(seenKey);
    if (state.sawLucky) storageSet(luckySeenKey);
    startOverlay.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
    maybeShowLuckyHint();
  }

  function closeLayer(state) {
    if (!tour || tour !== state || state.closing) return;
    state.closing = true;
    if (state.goodbyeTimer) {
      clearTimeout(state.goodbyeTimer);
      state.goodbyeTimer = 0;
    }
    state.layer.style.opacity = '0';
    window.setTimeout(function () {
      if (tour !== state) return;
      restoreOriginalElements(state);
    }, reduceMotion ? 0 : 190);
  }

  function finishTour(state, completed) {
    if (!tour || tour !== state || state.finishing) return;
    state.finishing = true;
    if (state.revealTimer) {
      clearTimeout(state.revealTimer);
      state.revealTimer = 0;
    }
    state.guide.classList.add('is-finishing');

    const skipButton = state.controls.querySelector('.qride-tour-skip');
    const nextButton = state.controls.querySelector('.qride-tour-next');
    const progress = state.controls.querySelector('.qride-tour-progress');
    if (skipButton) skipButton.hidden = true;
    if (progress) progress.textContent = 'Знакомство завершено';
    if (nextButton) {
      nextButton.disabled = false;
      nextButton.textContent = 'Понятно';
    }

    // Skipping the whole tour should not immediately trigger a second hint
    // for a roulette that was already available during the skipped tour.
    if (!completed && state.mode !== 'lucky' && luckyAvailable) storageSet(luckySeenKey);

    const title = completed ? 'На этом всё!' : 'Хорошего дня!';
    const copy = completed
      ? 'Теперь ты знаешь, где что находится. Если что-то забудется, знакомство всегда можно повторить в FAQ. Приятных поездок!'
      : 'Не буду задерживать. Если захочешь, знакомство можно повторить в FAQ. Хорошего дня!';

    setMessage(title, copy);
    if (typeof window.qrideMascotReact === 'function') window.qrideMascotReact('happy');

    // Keep Q where the user last saw him. The farewell stays readable before
    // the original header is restored; no rushed trip back to the top.
    // Keep the farewell beside the last explained section; do not recalculate
    // the target or move the guide while replacing the message.
    state.guide.style.opacity = '1';
    state.goodbyeTimer = window.setTimeout(function () {
      closeLayer(state);
    }, 5200);
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
      closing: false,
      goodbyeTimer: 0,
      sawLucky: false,
      originalMessage: moodMessage.innerHTML,
      brandPlaceholder: createPlaceholder(brand, 'qride-tour-placeholder-brand'),
      introPlaceholder: createPlaceholder(intro, 'qride-tour-placeholder-intro'),
      layer: null,
      svg: null,
      shade: null,
      blueFrame: null,
      whiteFrame: null,
      hole: null,
      guide: null,
      controls: null,
      highlightFrame: 0,
      highlightRect: null,
      revealTimer: 0
    };

    const ui = createLayer();
    Object.assign(state, ui);
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
      if (state.finishing) {
        closeLayer(state);
        return;
      }
      if (state.mode === 'lucky' || state.index >= state.steps.length - 1) finishTour(state, true);
      else showStep(state, state.index + 1);
    });

    state.layer.hidden = false;
    state.layer.style.opacity = '1';
    document.body.classList.add('qride-tour-open');
    window.qrideOnboardingActive = true;
    tour = state;
    state.guide.style.transition = 'none';
    showStep(state, 0);
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        if (tour === state) state.guide.style.transition = '';
      });
    });
    return true;
  }

  function scheduleFirstRun() {
    if (firstRunTimer || tour || !luckyReady || storageHas(seenKey)) return;
    firstRunTimer = window.setTimeout(function () {
      firstRunTimer = 0;
      if (tour || storageHas(seenKey) || !luckyReady) return;
      if (!isVisible(startOverlay) || !document.body.classList.contains('app-ready') || document.visibilityState === 'hidden') return;
      if (hasOtherDialogOpen()) {
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
      if (!isVisible(startOverlay) || document.visibilityState === 'hidden') return;
      if (hasOtherDialogOpen()) {
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
    } else if (event.key === 'Escape' && tour && tour.finishing) {
      event.preventDefault();
      closeLayer(tour);
    }
  });

  function repositionCurrentStep() {
    if (!tour || tour.finishing || tour.closing) return;
    if (tour.currentStep && tour.currentStep.top) {
      positionGuide(tour, null, true, 0);
    } else {
      const target = getTarget(tour.currentStep);
      if (target && isVisible(target)) positionGuide(tour, target, false, 0);
    }
  }

  if (window.MutationObserver) {
    const startObserver = new MutationObserver(function () {
      if (isVisible(startOverlay)) {
        scheduleFirstRun();
        maybeShowLuckyHint();
      }
    });
    startObserver.observe(startOverlay, { attributes: true, attributeFilter: ['hidden', 'class', 'style'] });
  }

  window.addEventListener('resize', repositionCurrentStep);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', repositionCurrentStep);
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      scheduleFirstRun();
      maybeShowLuckyHint();
      repositionCurrentStep();
    }
  });
  window.addEventListener('focus', function () {
    scheduleFirstRun();
    maybeShowLuckyHint();
  });

  installFaqReplay();
})();