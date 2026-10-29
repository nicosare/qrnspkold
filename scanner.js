(function () {
  function normalizeError(error) {
    if (typeof error === 'string' && error.trim()) return error.trim();
    const text = error && (error.error_data || error.message || error.error_type);
    return typeof text === 'string' && text.trim() ? text.trim() : 'Сканирование отменено или недоступно.';
  }

  window.qrideScanQr = function () {
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
        try {
          bridge.unsubscribe(onBridgeEvent);
        } catch (_) {}

        if (error) {
          reject(new Error(normalizeError(error)));
          return;
        }
        if (typeof code !== 'string' || !code.trim()) {
          reject(new Error('VK не вернул данные QR-кода. Попробуйте отсканировать ещё раз.'));
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
      timeoutId = setTimeout(() => {
        finish(new Error('Сканирование не завершилось. Попробуйте ещё раз.'));
      }, 120000);

      try {
        Promise.resolve(bridge.send('VKWebAppOpenCodeReader', {})).then((data) => {
          // Some VK clients return the scan result directly through the Promise.
          // Others deliver it as a VKWebAppOpenCodeReaderResult event.
          if (data && typeof data.code_data === 'string') {
            finish(null, data.code_data);
          }
        }).catch((error) => finish(error));
      } catch (error) {
        finish(error);
      }
    });
  };
})();