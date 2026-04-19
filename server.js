const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 🔁 Прокси к API НСПК
app.get('/api/proxy', async (req, res) => {
  try {
    const { payTagId, s, m } = req.query;
    
    if (!payTagId) {
      return res.status(400).json({ error: 'payTagId is required' });
    }

    const response = await axios.get('https://qr.bilet.nspk.ru/api/v1/pay-tags/tariff', {
      params: { payTagId, s: s || 'qr', m: m || 't' },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
      },
      timeout: 10000
    });

    res.json(response.data);
    
  } catch (error) {
    console.error('[qrnspk] Proxy error:', error.message);
    
    if (error.response) {
      res.status(error.response.status).json(error.response.data);
    } else if (error.request) {
      res.status(502).json({ error: 'No response from NSPK API' });
    } else {
      res.status(500).json({ error: 'Proxy error: ' + error.message });
    }
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'qrnspk',
    timestamp: new Date().toISOString() 
  });
});

app.listen(PORT, () => {
  console.log(`🚌 qrnspk server running on port ${PORT}`);
});
