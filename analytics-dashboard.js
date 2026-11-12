(function () {
  'use strict';

  const analyticsView = document.getElementById('analytics-view');
  if (!analyticsView) return;

  const query = window.location.search.slice(1);
  let auth = '';
  try {
    auth = 'VK ' + btoa(unescape(encodeURIComponent(query)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  } catch (_) {}

  const fromInput = document.getElementById('analytics-from');
  const toInput = document.getElementById('analytics-to');
  const applyButton = document.getElementById('analytics-apply');
  const statusNode = document.getElementById('analytics-status');
  const quickButtons = Array.from(document.querySelectorAll('[data-analytics-days]'));
  const countNode = document.getElementById('count');
  const titleNode = document.querySelector('h1');
  const subtitleNode = document.querySelector('.top .sub');

  const number = value => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Number(value) || 0);
  const money = value => new Intl.NumberFormat('ru-RU', {
    style: 'currency', currency: 'RUB', maximumFractionDigits: 0
  }).format(Number(value) || 0);
  const percent = value => (Number(value) || 0).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + '%';
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));

  function isoDay(date) {
    return date.toISOString().slice(0, 10);
  }
  function setQuickRange(days) {
    const end = new Date();
    const start = new Date(end.getTime() - (days - 1) * 86400000);
    fromInput.value = isoDay(start);
    toInput.value = isoDay(end);
    quickButtons.forEach(button => button.classList.toggle('active', Number(button.dataset.analyticsDays) === days));
    loadAnalytics();
  }

  function showStatus(message, isError) {
    statusNode.textContent = message || '';
    statusNode.classList.toggle('error', Boolean(isError));
  }

  async function loadAnalytics() {
    const from = fromInput.value;
    const to = toInput.value;
    if (!from || !to) {
      showStatus('Укажи начало и конец периода.', true);
      return;
    }
    if (from > to) {
      showStatus('Начало периода не может быть позже конца.', true);
      return;
    }
    if (!query) {
      showStatus('Не найдены параметры VK. Открой админку из QRide внутри VK.', true);
      return;
    }

    applyButton.disabled = true;
    showStatus('Загружаю статистику…', false);
    try {
      const url = new URL('../api/admin/analytics', window.location.href);
      url.searchParams.set('from', from);
      url.searchParams.set('to', to);
      const response = await fetch(url.toString(), {
        headers: { Authorization: auth },
        cache: 'no-store',
        credentials: 'omit'
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Не удалось загрузить аналитику.');
      render(data);
      showStatus('Период: ' + from + ' — ' + to + '. Показаны только подтверждённые покупки.', false);
      if (countNode) countNode.textContent = 'Сводка';
    } catch (error) {
      showStatus(error.message || 'Ошибка загрузки аналитики.', true);
    } finally {
      applyButton.disabled = false;
    }
  }

  function metric(label, value, detail) {
    return '<div class="analytics-metric"><span>' + esc(label) + '</span><strong>' +
      esc(value) + (detail ? '<small style="display:block;color:#8a94a1;font-size:10px;font-weight:500;margin-top:3px;">' + esc(detail) + '</small>' : '') +
      '</strong></div>';
  }

  function render(data) {
    const summary = data.summary || {};
    const scans = data.scans || {};
    const referrals = data.referrals || {};
    const lucky = data.lucky || {};
    const retention = data.retention || {};

    document.getElementById('analytics-active-users').textContent = number(summary.activeUsers);
    document.getElementById('analytics-revenue').textContent = money(summary.revenueRub);
    document.getElementById('analytics-purchases').textContent = number(summary.purchases);
    document.getElementById('analytics-scans').textContent = number(scans.total);
    document.getElementById('analytics-repeat-buyers').textContent = number(summary.repeatBuyers);
    document.getElementById('analytics-requests').textContent = number(summary.requests);

    const funnel = Array.isArray(data.funnel) ? data.funnel : [];
    const maxUsers = Math.max(1, ...funnel.map(item => Number(item.users) || 0));
    document.getElementById('analytics-funnel').innerHTML = funnel.length
      ? funnel.map((item, index) => {
          const users = Number(item.users) || 0;
          const width = Math.max(0, Math.min(100, users / maxUsers * 100));
          const conv = index === 0 ? 'база' : percent(item.conversion);
          return '<div class="analytics-funnel-row">' +
            '<span class="analytics-funnel-name">' + esc(item.label) + '</span>' +
            '<span class="analytics-funnel-value">' + number(users) + ' · ' + conv + '</span>' +
            '<div class="analytics-funnel-track"><div class="analytics-funnel-fill" style="width:' + width.toFixed(1) + '%"></div></div>' +
          '</div>';
        }).join('')
      : '<div class="analytics-empty">Пока нет данных по воронке.</div>';

    document.getElementById('analytics-scan-sources').innerHTML =
      metric('Всего поездок', number(scans.total)) +
      metric('Пакетные сканы', number(scans.package)) +
      metric('Дневные бесплатные', number(scans.daily)) +
      metric('Подписка', number(scans.subscription)) +
      metric('Постоянный безлимит', number(scans.unlimited)) +
      metric('Источник не определён', number(scans.unknown));

    document.getElementById('analytics-referrals').innerHTML =
      metric('Новые привязки по ссылке', number(referrals.opened)) +
      metric('Приглашённые дошли до скана', number(referrals.rewarded)) +
      metric('Конверсия приглашений', percent(referrals.rewardConversion));
    document.getElementById('analytics-lucky').innerHTML =
      metric('Прокрутки «Билета удачи»', number(lucky.spins)) +
      metric('Бесплатные попытки', number(lucky.freeSpins)) +
      metric('Оплаченные сканами', number(lucky.paidSpins)) +
      metric('Списано сканов', number(lucky.scansSpent));

    const retentionRows = [
      ['D1', retention.day1, retention.day1Eligible],
      ['D7', retention.day7, retention.day7Eligible],
      ['D30', retention.day30, retention.day30Eligible]
    ];
    document.getElementById('analytics-retention').innerHTML =
      metric('Когорт в периоде', number(retention.cohortUsers)) +
      retentionRows.map(([label, returned, eligible]) => {
        const rate = Number(eligible) > 0 ? Number(returned) / Number(eligible) * 100 : 0;
        const value = Number(eligible) > 0 ? percent(rate) : '—';
        return metric('Возврат ' + label, value, number(returned) + ' из ' + number(eligible) + ' зрелых пользователей');
      }).join('');

    const offers = Array.isArray(data.offers) ? data.offers : [];
    document.getElementById('analytics-offers').innerHTML = offers.length
      ? '<table class="analytics-table"><thead><tr><th>Тариф</th><th class="num">Покупки</th><th class="num">Выручка</th></tr></thead><tbody>' +
        offers.map(item => '<tr><td>' + esc(item.offerName) + '</td><td class="num">' +
          number(item.purchases) + '</td><td class="num">' + money(item.revenueRub) + '</td></tr>').join('') +
        '</tbody></table>'
      : '<div class="analytics-empty">Подтверждённых покупок за период пока нет.</div>';

    const trend = Array.isArray(data.trend) ? data.trend.slice().reverse() : [];
    document.getElementById('analytics-trend').innerHTML = trend.length
      ? '<table class="analytics-table"><thead><tr><th>Дата</th><th class="num">Поездки</th><th class="num">Покупки</th><th class="num">Выручка</th></tr></thead><tbody>' +
        trend.map(item => '<tr><td>' + esc(item.day) + '</td><td class="num">' + number(item.scans) +
          '</td><td class="num">' + number(item.purchases) + '</td><td class="num">' + money(item.revenueRub) + '</td></tr>').join('') +
        '</tbody></table>'
      : '<div class="analytics-empty">Пока нет событий за выбранный период.</div>';
  }

  document.querySelectorAll('[data-admin-view]').forEach(link => {
    link.addEventListener('click', () => {
      const isAnalytics = link.dataset.adminView === 'analytics';
      analyticsView.hidden = !isAnalytics;
      if (!isAnalytics) return;
      if (titleNode) titleNode.textContent = 'Аналитика QRide';
      if (subtitleNode) subtitleNode.textContent = 'Воронка, покупки, сканирования и возвращаемость';
      if (countNode) countNode.textContent = 'Загрузка…';
      if (history.replaceState) {
        history.replaceState(null, '', window.location.pathname + window.location.search + '#analytics');
      }
      loadAnalytics();
    });
  });

  applyButton.addEventListener('click', () => {
    quickButtons.forEach(button => button.classList.remove('active'));
    loadAnalytics();
  });
  quickButtons.forEach(button => button.addEventListener('click', () => {
    const days = Number(button.dataset.analyticsDays) || 30;
    setQuickRange(days);
  }));

  const today = new Date();
  toInput.value = isoDay(today);
  fromInput.value = isoDay(new Date(today.getTime() - 29 * 86400000));
  if (window.location.hash === '#analytics') {
    const link = document.querySelector('[data-admin-view="analytics"]');
    if (link) link.click();
  }
})();