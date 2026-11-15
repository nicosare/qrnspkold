(function () {
  const JSQR_URL = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
  let jsQrPromise = null;

  function loadJsQr() {
    if (window.jsQR) return Promise.resolve(window.jsQR);
    if (jsQrPromise) return jsQrPromise;
    jsQrPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = JSQR_URL;
      script.async = true;
      script.onload = () => window.jsQR
        ? resolve(window.jsQR)
        : reject(new Error('Не удалось загрузить модуль распознавания QR-кодов.'));
      script.onerror = () => reject(new Error('Не удалось загрузить модуль сканера. Проверьте интернет-соединение.'));
      document.head.appendChild(script);
    });
    return jsQrPromise;
  }

  function isNativeVkWebView() {
    const bridge = window.vkBridge;
    try {
      return !!(bridge && typeof bridge.isWebView === 'function' && bridge.isWebView());
    } catch (_) {
      return false;
    }
  }

  function normalizeError(error) {
    if (typeof error === 'string' && error.trim()) return error.trim();
    const text = error && (error.error_data || error.message || error.error_type);
    return typeof text === 'string' && text.trim() ? text.trim() : 'Не удалось открыть сканер QR-кодов.';
  }

  function openNativeReader() {
    const bridge = window.vkBridge;
    if (!bridge || typeof bridge.send !== 'function' || typeof bridge.subscribe !== 'function') {
      return Promise.reject(new Error('VK Bridge не загружен. Закройте и заново откройте мини-приложение в VK.'));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let timeoutId = null;

      function finish(error, code) {
        if (settled) return;
        settled = true;
        if (timeoutId !== null) clearTimeout(timeoutId);
        try { bridge.unsubscribe(onBridgeEvent); } catch (_) {}
        if (error) {
          reject(new Error(normalizeError(error)));
          return;
        }
        if (typeof code !== 'string' || !code.trim()) {
          reject(new Error('VK не вернул данные QR-кода. Попробуйте ещё раз.'));
          return;
        }
        resolve(code.trim());
      }

      function onBridgeEvent(event) {
        const detail = event && event.detail;
        if (!detail) return;
        if (detail.type === 'VKWebAppOpenCodeReaderResult') {
          finish(null, detail.data && detail.data.code_data);
        } else if (detail.type === 'VKWebAppOpenCodeReaderFailed') {
          finish(detail.data || new Error('VK не смог открыть сканер QR-кодов.'));
        }
      }

      bridge.subscribe(onBridgeEvent);
      timeoutId = setTimeout(() => finish(new Error('Сканирование не завершилось. Попробуйте ещё раз.')), 120000);
      try {
        Promise.resolve(bridge.send('VKWebAppOpenCodeReader', {})).then((data) => {
          if (data && typeof data.code_data === 'string') finish(null, data.code_data);
          else finish(new Error('Сканирование отменено.'));
        }).catch(finish);
      } catch (error) {
        finish(error);
      }
    });
  }

  function openCameraReader() {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      return Promise.reject(new Error('В этой версии VK нет доступа к камере. Откройте QRide в приложении VK или обновите браузер.'));
    }

    return new Promise(async (resolve, reject) => {
      let stream = null;
      let rafId = 0;
      let settled = false;
      let video = null;
      let canvas = null;
      let overlay = null;

      function cleanup() {
        if (rafId) cancelAnimationFrame(rafId);
        if (stream) stream.getTracks().forEach(track => track.stop());
        if (overlay) overlay.remove();
      }

      function finish(error, code) {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(code);
      }

      try {
        const jsQR = await loadJsQr();
        overlay = document.createElement('div');
        overlay.className = 'qride-camera-scanner';
        overlay.innerHTML = `
          <style>
            .qride-camera-scanner{position:fixed;inset:0;z-index:30000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:calc(20px + env(safe-area-inset-top)) 20px calc(24px + env(safe-area-inset-bottom));background:#101820;color:#fff;font-family:inherit}
            .qride-camera-scanner__top{width:100%;max-width:440px;display:flex;align-items:center;justify-content:space-between;gap:12px}
            .qride-camera-scanner__title{font-size:19px;font-weight:700}
            .qride-camera-scanner__close{width:42px;height:42px;border:0;border-radius:14px;background:#ffffff20;color:#fff;font-size:26px;line-height:1}
            .qride-camera-scanner__frame{position:relative;width:min(82vw,360px);aspect-ratio:1;border:2px solid #fff;border-radius:24px;overflow:hidden;box-shadow:0 0 0 999px #0005}
            .qride-camera-scanner video{width:100%;height:100%;object-fit:cover}
            .qride-camera-scanner__frame:after{content:"";position:absolute;inset:12%;border:2px solid #55a5ff;border-radius:12px;pointer-events:none}
            .qride-camera-scanner__hint{max-width:320px;text-align:center;color:#d5dfeb;font-size:14px;line-height:1.45}
            .qride-camera-scanner__status{min-height:20px;color:#b8d8ff;font-size:13px;text-align:center}
          </style>
          <div class="qride-camera-scanner__top"><div class="qride-camera-scanner__title">Сканирование QR-кода</div><button class="qride-camera-scanner__close" type="button" aria-label="Закрыть">×</button></div>
          <div class="qride-camera-scanner__frame"><video autoplay muted playsinline></video></div>
          <div class="qride-camera-scanner__hint">Наведите камеру на QR-код транспорта. Держите его внутри рамки.</div>
          <div class="qride-camera-scanner__status" role="status">Запускаем камеру…</div>
        `;
        document.body.appendChild(overlay);
        video = overlay.querySelector('video');
        canvas = document.createElement('canvas');
        const context = canvas.getContext('2d', { willReadFrequently: true });
        const status = overlay.querySelector('.qride-camera-scanner__status');
        overlay.querySelector('.qride-camera-scanner__close').addEventListener('click', () => {
          const error = new Error('Сканирование отменено.');
          error.code = 'SCAN_CANCELLED';
          finish(error);
        });

        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
        });
        if (settled) return;
        video.srcObject = stream;
        await video.play();
        status.textContent = 'Наведите камеру на QR-код';

        let lastFrameAt = 0;
        function tick(now) {
          if (settled) return;
          if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && now - lastFrameAt > 100) {
            lastFrameAt = now;
            const width = video.videoWidth;
            const height = video.videoHeight;
            if (width && height) {
              canvas.width = width;
              canvas.height = height;
              context.drawImage(video, 0, 0, width, height);
              const image = context.getImageData(0, 0, width, height);
              const result = jsQR(image.data, width, height, { inversionAttempts: 'attemptBoth' });
              if (result && result.data) {
                finish(null, result.data);
                return;
              }
            }
          }
          rafId = requestAnimationFrame(tick);
        }
        rafId = requestAnimationFrame(tick);
      } catch (error) {
        let message = normalizeError(error);
        if (error && error.name === 'NotAllowedError') {
          message = 'VK не разрешил доступ к камере. Проверьте разрешение камеры для сайта VK в настройках iPhone.';
        } else if (error && error.name === 'NotFoundError') {
          message = 'Камера на устройстве не найдена.';
        } else if (error && error.name === 'NotReadableError') {
          message = 'Камера уже используется другим приложением. Закройте его и попробуйте снова.';
        } else if (error && error.name === 'OverconstrainedError') {
          message = 'Не удалось выбрать камеру устройства. Попробуйте ещё раз.';
        }
        finish(new Error(message));
      }
    });
  }

  window.roadnoteScanQr = function () {
    // VK's native reader is available in the iOS/Android VK apps only.
    // The mobile VK website runs as a browser and must use the camera API.
    return isNativeVkWebView() ? openNativeReader() : openCameraReader();
  };

  window.qrideTaptic = function (style) {
    const bridge = window.vkBridge;
    if (!isNativeVkWebView() || !bridge || typeof bridge.send !== 'function') return false;
    try {
      Promise.resolve(bridge.send('VKWebAppTapticImpactOccurred', { style: style || 'light' }))
        .catch(() => {});
      return true;
    } catch (_) {
      return false;
    }
  };
})();
