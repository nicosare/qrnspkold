const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { HttpsProxyAgent } = require('https-proxy-agent');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// 🔁 Функция запроса к НСПК с прокси и ретраями
async function fetchNSPK(payTagId, s, m, attempt = 1) {
  const url = `https://qr.bilet.nspk.ru/api/v1/pay-tags/tariff`;
  
  const config = {
    params: { payTagId, s: s || 'qr', m: m || 't' },
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Referer': 'https://qr.bilet.nspk.ru/',
      'Origin': 'https://qr.bilet.nspk.ru',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin'
    },
    timeout: 15000,
    validateStatus: () => true
  };

  // 🇷🇺 Если задан прокси — используем его
  if (process.env.PROXY_URL) {
    config.httpsAgent = new HttpsProxyAgent(process.env.PROXY_URL);
    console.log(`[qrnspk] 🔄 Using proxy: ${process.env.PROXY_URL.replace(/:[^:@]+@/, ':***@')}`);
  }

  try {
    const response = await axios.get(url, config);
    
    if (response.status >= 400) {
      throw new Error(`NSPK API returned ${response.status}: ${JSON.stringify(response.data).slice(0, 100)}`);
    }
    
    return response.data;
  } catch (error) {
    // 🔄 Повторные попытки при таймауте/сетевой ошибке    if (attempt < 3 && (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED' || error.code === 'ECONNRESET')) {
      const delay = attempt * 2000;
      console.log(`[qrnspk] ⏳ Retry ${attempt}/3 after ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
      return fetchNSPK(payTagId, s, m, attempt + 1);
    }
    throw error;
  }
}

app.get('/api/proxy', async (req, res) => {
  const { payTagId, s, m } = req.query;
  
  if (!payTagId) {
    return res.status(400).json({ error: 'payTagId is required' });
  }

  console.log(`[qrnspk] 📡 Request: payTagId=${payTagId}, proxy=${!!process.env.PROXY_URL}`);

  try {
    const data = await fetchNSPK(payTagId, s, m);
    
    if (data?.responseStatus !== 'OK') {
      throw new Error(`Invalid response: ${data?.responseStatus}`);
    }
    
    res.json(data);
  } catch (error) {
    console.error('[qrnspk] ❌ Error:', {
      code: error.code,
      message: error.message,
      proxy: !!process.env.PROXY_URL
    });
    
    // Понятные сообщения об ошибках
    let userMsg = 'Ошибка соединения с НСПК';
    if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
      userMsg = !process.env.PROXY_URL 
        ? '⏱️ Таймаут. Возможно, НСПК блокирует иностранные IP. Добавьте российский прокси.' 
        : '⏱️ Таймаут даже через прокси. Проверьте, работает ли прокси.';
    } else if (error.code === 'ECONNREFUSED') {
      userMsg = '🚫 Соединение отклонено. Проверьте прокси или попробуйте позже.';
    } else if (error.message?.includes('403') || error.message?.includes('401')) {
      userMsg = '🔐 Доступ запрещён. Возможно, требуется авторизация или сессия.';
    }
    
    res.status(502).json({ 
      error: userMsg,
      debug: process.env.NODE_ENV === 'development' ? error.message : undefined
    });  }
});

app.get('/api/status', (req, res) => {
  res.json({
    service: 'qrnspk',
    proxy: process.env.PROXY_URL ? 'configured' : 'none',
    node_env: process.env.NODE_ENV || 'production',
    uptime: process.uptime()
  });
});

app.listen(PORT, () => {
  console.log(`🚌 qrnspk listening on port ${PORT}`);
  if (process.env.PROXY_URL) {
    console.log(`🇷🇺 Using Russian proxy for NSPK requests`);
  }
});
