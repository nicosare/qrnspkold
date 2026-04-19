(function () {
  const SCANNER_STYLE = `
    .scanner-modal{position:fixed;inset:0;background:rgba(0,0,0,.65);display:none;align-items:center;justify-content:center;z-index:9999;padding:16px}
    .scanner-modal.active{display:flex}
    .scanner-content{width:100%;max-width:420px;background:#f5f1e8;border-radius:10px;padding:16px;box-shadow:0 6px 20px rgba(0,0,0,.35)}
    .scanner-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;color:#1d1346;font-weight:700;font-size:18px}
    .scanner-close{border:none;background:transparent;color:#1d1346;font-size:28px;line-height:1;cursor:pointer;padding:0 4px}
    #qr-reader{width:100%;border-radius:8px;overflow:hidden}
    .scanner-hint{margin-top:10px;color:#1d1346;font-size:15px;text-align:center}
    .scanner-controls{margin-top:12px;display:grid;gap:8px}
    .scanner-manual-row{display:flex;gap:8px}
    .scanner-input{flex:1;border:1px solid #d2cbbd;border-radius:6px;padding:10px;font-size:14px;font-family:'Circe',sans-serif;color:#1d1346;background:#fff}
    .scanner-btn{border:none;border-radius:6px;background:#1d1346;color:#fff;padding:10px 12px;cursor:pointer;font-size:14px;font-family:'Circe',sans-serif;white-space:nowrap}
    .scanner-btn:disabled{opacity:.6;cursor:default}
  `;

  let qrScanner = null;
  let scannerIsRunning = false;
  let flashEnabled = false;

  function resetPaymentTimer() {
    const now = new Date();
    startTime = now;
    localStorage.setItem('timerStartTime', now.getTime().toString());
    dateElement.textContent = getCurrentDateTimeString(now);
    ticketNumber = generateTicketNumber(now);
    ticketNumberElement.textContent = ticketNumber;
    localStorage.setItem('ticketNumber', ticketNumber);
    updateTimer();
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(updateTimer, 1000);
  }

  function normalizeTransportType(value = '') {
    const cleaned = value.trim().toLowerCase();
    const dictionary = {
      'трамвай': 'Трамвай',
      'автобус': 'Автобус',
      'троллейбус': 'Троллейбус',
      'электробус': 'Электробус',
      'маршрутка': 'Маршрутка',
      'метро': 'Метро'
    };
    return dictionary[cleaned] || (value ? value[0].toUpperCase() + value.slice(1).toLowerCase() : '');
  }

  function applyTransportData(data) {
    if (data.vehicleType) {
      vehicleTypeElement.textContent = data.vehicleType;
      localStorage.setItem('vehicleType', data.vehicleType);
    }
    if (data.routeNumber) {
      const normalizedRoute = data.routeNumber.startsWith('№') ? data.routeNumber : `№${data.routeNumber}`;
      routeNumberElement.textContent = normalizedRoute;
      localStorage.setItem('routeNumber', normalizedRoute);
    }
    if (data.vehicleNumber) {
      vehicleNumberElement.textContent = data.vehicleNumber;
      localStorage.setItem('vehicleNumber', data.vehicleNumber);
    }
    resetPaymentTimer();
    generateQR();
  }

  function isValidNspkQrUrl(rawValue) {
    try {
      const parsed = new URL(rawValue);
      return parsed.protocol === 'https:' && parsed.hostname === 'qr.bilet.nspk.ru' && parsed.searchParams.has('paytagid');
    } catch {
      return false;
    }
  }

  function extractTransportDataFromHtml(htmlText) {
    const doc = new DOMParser().parseFromString(htmlText, 'text/html');
    const pageText = (doc.body?.innerText || htmlText || '').replace(/\s+/g, ' ');
    const scriptText = Array.from(doc.querySelectorAll('script')).map(s => s.textContent || '').join(' ');

    const typeTextMatch = pageText.match(/\b(Трамвай|Автобус|Троллейбус|Электробус|Маршрутка|Метро)\b/i);
    const typeScriptMatch = scriptText.match(/(?:vehicleType|transportType|transport_name|type)"?\s*[:=]\s*"([^"]{3,30})"/i);
    const routeTextMatch = pageText.match(/(?:маршрут(?:а)?|номер\s*маршрута|route|№)\s*[:№]?\s*([0-9A-Za-zА-Яа-я-]{1,8})/i);
    const routeScriptMatch = scriptText.match(/(?:routeNumber|route_no|route|line|lineNumber)"?\s*[:=]\s*"?([0-9A-Za-zА-Яа-я-]{1,8})"?/i);
    const vehicleTextMatch = pageText.match(/(?:Т\s*\/\s*С|ТС|транспортн(?:ое|ого)\s*средств[ао]|vehicle)\s*[:№]?\s*([0-9A-Za-zА-Яа-я-]{1,12})/i);
    const vehicleScriptMatch = scriptText.match(/(?:vehicleNumber|vehicle_no|ts|transportNumber|carNumber)"?\s*[:=]\s*"?([0-9A-Za-zА-Яа-я-]{1,12})"?/i);

    const vehicleTypeRaw = (typeTextMatch && typeTextMatch[1]) || (typeScriptMatch && typeScriptMatch[1]) || '';
    return {
      vehicleType: normalizeTransportType(vehicleTypeRaw),
      routeNumber: (routeTextMatch && routeTextMatch[1]) || (routeScriptMatch && routeScriptMatch[1]) || '',
      vehicleNumber: (vehicleTextMatch && vehicleTextMatch[1]) || (vehicleScriptMatch && vehicleScriptMatch[1]) || ''
    };
  }

  async function fetchTicketPageHtml(url) {
    const directResponse = await fetch(url, { method: 'GET', credentials: 'omit' });
    if (!directResponse.ok) throw new Error(`HTTP ${directResponse.status}`);
    return directResponse.text();
  }

  async function fetchTicketPageHtmlWithFallback(url) {
    try {
      return await fetchTicketPageHtml(url);
    } catch (directError) {
      const proxyUrls = [
        `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
        `https://r.jina.ai/http://${url.replace(/^https?:\/\//, '')}`
      ];
      for (const proxyUrl of proxyUrls) {
        try {
          const proxyResponse = await fetch(proxyUrl, { method: 'GET' });
          if (proxyResponse.ok) {
            const proxyHtml = await proxyResponse.text();
            if (proxyHtml && proxyHtml.trim().length > 100) return proxyHtml;
          }
        } catch (proxyError) {
          console.warn('Прокси недоступен:', proxyError);
        }
      }
      throw directError;
    }
  }

  async function handleScannedText(decodedText) {
    if (!isValidNspkQrUrl(decodedText)) {
      alert('Ссылка в QR не подходит. Нужна ссылка с домена qr.bilet.nspk.ru и параметром paytagid.');
      return false;
    }
    try {
      const htmlText = await fetchTicketPageHtmlWithFallback(decodedText);
      const data = extractTransportDataFromHtml(htmlText);
      if (!data.vehicleType || !data.routeNumber || !data.vehicleNumber) {
        throw new Error('Не удалось извлечь все поля из страницы НСПК');
      }
      applyTransportData(data);
      return true;
    } catch (error) {
      console.error(error);
      alert('Не удалось получить данные по ссылке из QR. Проверьте интернет, доступ к странице и CORS/прокси.');
      return false;
    }
  }

  function createModal() {
    const style = document.createElement('style');
    style.textContent = SCANNER_STYLE;
    document.head.appendChild(style);

    const modal = document.createElement('div');
    modal.className = 'scanner-modal';
    modal.id = 'scanner-modal';
    modal.innerHTML = `
      <div class="scanner-content">
        <div class="scanner-header">
          <span>Сканирование QR</span>
          <button class="scanner-close" id="scanner-close" aria-label="Закрыть">×</button>
        </div>
        <div id="qr-reader"></div>
        <div class="scanner-hint">Наведите камеру на QR-код с сайта НСПК.</div>
        <div class="scanner-controls">
          <button class="scanner-btn" id="scanner-flash-btn" type="button">Включить вспышку</button>
          <div class="scanner-manual-row">
            <input id="scanner-manual-input" class="scanner-input" type="url" placeholder="Вставьте ссылку с qr.bilet.nspk.ru для теста">
            <button class="scanner-btn" id="scanner-manual-submit" type="button">Применить</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);
    return modal;
  }

  document.addEventListener('DOMContentLoaded', () => {
    const downloadBtn = document.querySelector('.btn-download');
    if (!downloadBtn) return;

    const modal = createModal();
    const closeBtn = modal.querySelector('#scanner-close');
    const flashBtn = modal.querySelector('#scanner-flash-btn');
    const manualInput = modal.querySelector('#scanner-manual-input');
    const manualSubmit = modal.querySelector('#scanner-manual-submit');

    function resetScannerControls() {
      flashEnabled = false;
      flashBtn.textContent = 'Включить вспышку';
      flashBtn.disabled = false;
      manualSubmit.disabled = false;
    }

    async function stopScanner() {
      if (qrScanner && scannerIsRunning) {
        try { await qrScanner.stop(); } catch (e) { console.warn(e); }
        scannerIsRunning = false;
      }
      flashEnabled = false;
      if (qrScanner) {
        try { qrScanner.clear(); } catch (e) { console.warn(e); }
      }
    }

    async function closeScanner() {
      await stopScanner();
      modal.classList.remove('active');
      resetScannerControls();
      manualInput.value = '';
    }

    async function openScanner() {
      if (typeof Html5Qrcode === 'undefined') {
        alert('Библиотека сканера не загрузилась. Попробуйте обновить страницу.');
        return;
      }
      modal.classList.add('active');
      resetScannerControls();
      if (!qrScanner) qrScanner = new Html5Qrcode('qr-reader');
      try {
        scannerIsRunning = true;
        await qrScanner.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 220, height: 220 } },
          async (decodedText) => {
            if (await handleScannedText(decodedText)) await closeScanner();
          },
          () => {}
        );
      } catch (error) {
        scannerIsRunning = false;
        console.error(error);
        alert('Не удалось запустить сканер. Разрешите доступ к камере и повторите попытку.');
        await closeScanner();
      }
    }

    async function toggleFlash() {
      if (!qrScanner || !scannerIsRunning) return alert('Сначала запустите сканер.');
      try {
        flashEnabled = !flashEnabled;
        await qrScanner.applyVideoConstraints({ advanced: [{ torch: flashEnabled }] });
        flashBtn.textContent = flashEnabled ? 'Выключить вспышку' : 'Включить вспышку';
      } catch {
        flashEnabled = false;
        flashBtn.textContent = 'Включить вспышку';
        alert('Вспышка недоступна на этом устройстве или в этом браузере.');
      }
    }

    // Перехватываем старый обработчик "скачать" без правки старого кода.
    downloadBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      openScanner();
    }, true);

    closeBtn.addEventListener('click', () => { closeScanner(); });
    modal.addEventListener('click', (event) => {
      if (event.target === modal) closeScanner();
    });

    flashBtn.addEventListener('click', () => { toggleFlash(); });
    manualSubmit.addEventListener('click', async () => {
      const manualUrl = manualInput.value.trim();
      if (!manualUrl) return alert('Введите ссылку для теста.');
      manualSubmit.disabled = true;
      const ok = await handleScannedText(manualUrl);
      manualSubmit.disabled = false;
      if (ok) await closeScanner();
    });

    manualInput.addEventListener('keypress', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        manualSubmit.click();
      }
    });
  });
})();
