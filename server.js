import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;
const upstreamTimeoutMs = Number(process.env.UPSTREAM_TIMEOUT_MS || 12000);

function normalizePayTagId(raw = '') {
  return String(raw).replace(/\s+/g, '').replace(/[^0-9A-Za-z_-]/g, '').trim();
}

async function fetchWithTimeout(url, options = {}, timeoutMs = upstreamTimeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/transport', async (req, res) => {
  const payTagId = normalizePayTagId(req.query?.payTagId || '');

  if (!payTagId) {
    return res.status(400).json({ error: 'payTagId is required' });
  }

  const upstreamUrl = `https://qr.bilet.nspk.ru/api/v1/pay-tags/tariff?payTagId=${encodeURIComponent(payTagId)}&s=qr&m=t`;

  try {
    const response = await fetchWithTimeout(upstreamUrl, {
      method: 'GET',
      headers: {
        accept: 'application/json'
      }
    });

    if (!response.ok) {
      return res.status(502).json({ error: `External API error: HTTP ${response.status}` });
    }

    const data = await response.json();

    return res.json({
      vehicleTypeName: data?.vehicleTypeName || '',
      routeNumber: data?.routeNumber || '',
      vehicleNumber: data?.vehicleNumber || ''
    });
  } catch (error) {
    return res.status(502).json({ error: error?.message || String(error) });
  }
});

app.use(express.static(__dirname));

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, () => {
  console.log(`Proxy server listening on port ${port}`);
});
