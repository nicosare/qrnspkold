const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// 🔒 Очередь запросов (Render free tier не потянет параллельные браузеры)
let isProcessing = false;
let browser = null;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    console.log('[qrnspk] 🚀 Launching headless browser...');
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--single-process',
        '--no-zygote',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor'
      ],
      // Ограничиваем память (если ОС поддерживает)
      ignoreDefaultArgs: ['--disable-extensions'],
      timeout: 30000
    });
  }
  return browser;
}

app.get('/api/proxy', async (req, res) => {
  const { payTagId, s, m } = req.query;
  if (!payTagId) return res.status(400).json({ error: 'payTagId is required' });

  // Блокируем параллельные запросы, чтобы не уронить контейнер
  if (isProcessing) {
    return res.status(429).json({ error: '⏳ Server is busy. Try again in 2-3 seconds.' });
  }
  isProcessing = true;

  const url = `https://qr.bilet.nspk.ru/api/v1/pay-tags/tariff?payTagId=${payTagId}&s=${s||'qr'}&m=${m||'t'}`;
  console.log(`[qrnspk] 🌐 Browser request: ${url}`);
  try {
    const br = await getBrowser();
    const page = await br.newPage();

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'ru-RU,ru;q=0.9',
      'Accept': 'application/json, text/plain, */*'
    });

    // ⏱ waitUntil: 'load' быстрее и легче для памяти, чем 'networkidle0'
    const response = await page.goto(url, {
      waitUntil: 'load',
      timeout: 20000
    });

    if (!response || !response.ok()) {
      throw new Error(`NSPK returned ${response?.status() || 'unknown'} status`);
    }

    const data = await response.json();
    await page.close();

    res.json(data);
  } catch (error) {
    console.error('[qrnspk] ❌ Puppeteer error:', error.message);
    res.status(502).json({ 
      error: 'Browser request failed', 
      debug: error.message.slice(0, 200) 
    });
  } finally {
    isProcessing = false;
  }
});

app.get('/api/status', async (req, res) => {
  res.json({
    status: 'ok',
    service: 'qrnspk',
    puppeteer: browser ? (browser.isConnected() ? 'connected' : 'disconnected') : 'not launched',
    queue: isProcessing ? 'busy' : 'ready',
    node_env: process.env.NODE_ENV || 'production'
  });
});

// 🔌 Корректное завершение при деплое/рестарте
process.on('SIGTERM', async () => {
  console.log('[qrnspk] 🛑 SIGTERM received. Closing browser...');
  if (browser) await browser.close();  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`🚌 qrnspk server running on port ${PORT}`);
});
