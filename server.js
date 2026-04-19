const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const axios = require('axios');
const path = require('path');

// 🔒 Ограничиваем память Node.js (важно для Render free tier)
if (process.env.NODE_OPTIONS?.includes('max-old-space-size') === false) {
  process.env.NODE_OPTIONS = '--max-old-space-size=380';
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

let isProcessing = false;
let browser = null;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    console.log('[qrnspk] 🌐 Launching Chromium...');
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
        '--disable-features=VizDisplayCompositor',
        '--js-flags=--max-old-space-size=128' // Ограничиваем память JS-движка Chrome
      ],
      timeout: 30000,
      pipe: true // Стабильнее на ограниченных серверах
    });
  }
  return browser;
}

// 🔹 Лёгкий fallback-запрос (если Puppeteer недоступен)
async function fetchViaAxios(payTagId, s, m) {
  const url = `https://qr.bilet.nspk.ru/api/v1/pay-tags/tariff?payTagId=${payTagId}&s=${s||'qr'}&m=${m||'t'}`;
  const res = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',      'Accept-Language': 'ru-RU,ru;q=0.9',
      'Referer': 'https://qr.bilet.nspk.ru/',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin'
    },
    timeout: 10000,
    validateStatus: () => true
  });
  
  if (res.status >= 400) throw new Error(`Axios fallback: HTTP ${res.status}`);
  return res.data;
}

app.get('/api/proxy', async (req, res) => {
  const { payTagId, s, m } = req.query;
  if (!payTagId) return res.status(400).json({ error: 'payTagId is required' });

  if (isProcessing) {
    return res.status(429).json({ error: '⏳ Сервер занят. Подождите 2-3 сек.' });
  }
  isProcessing = true;

  console.log(`[qrnspk] 📡 Запрос: payTagId=${payTagId}`);

  try {
    let data;
    
    // Попытка 1: Puppeteer
    try {
      const br = await getBrowser();
      const page = await br.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'ru-RU,ru;q=0.9' });
      
      const response = await page.goto(
        `https://qr.bilet.nspk.ru/api/v1/pay-tags/tariff?payTagId=${payTagId}&s=${s||'qr'}&m=${m||'t'}`,
        { waitUntil: 'load', timeout: 15000 }
      );
      
      if (!response?.ok()) throw new Error(`NSPK returned ${response.status()}`);
      data = await response.json();
      await page.close();
      console.log('[qrnspk] ✅ Puppeteer OK');
    } catch (puppeteerErr) {
      console.warn('[qrnspk] ⚠️ Puppeteer failed, switching to Axios fallback:', puppeteerErr.message);
      // Попытка 2: Лёгкий HTTP-запрос
      data = await fetchViaAxios(payTagId, s, m);
      console.log('[qrnspk] ✅ Axios fallback OK');
    }
    if (!data?.responseStatus || data.responseStatus !== 'OK') {
      throw new Error('NSPK returned invalid response');
    }

    res.json(data);
  } catch (error) {
    console.error('[qrnspk] ❌ FINAL ERROR:', {
      name: error.name,
      message: error.message,
      stack: error.stack?.split('\n').slice(0, 3).join('\n')
    });
    res.status(502).json({ 
      error: 'Browser request failed', 
      debug: error.message.slice(0, 150) 
    });
  } finally {
    isProcessing = false;
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    service: 'qrnspk',
    puppeteer: browser ? (browser.isConnected() ? 'ready' : 'disconnected') : 'not started',
    memory: process.memoryUsage().heapUsed / 1024 / 1024,
    uptime: process.uptime()
  });
});

process.on('SIGTERM', async () => {
  if (browser) await browser.close();
  process.exit(0);
});

app.listen(PORT, () => console.log(`🚌 qrnspk listening on :${PORT}`));
