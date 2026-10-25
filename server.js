import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = Number(process.env.PORT || 3000);
const appId = String(process.env.VK_APP_ID || '54843054');
const appSecret = process.env.VK_APP_SECRET || '';
const adminVkId = String(process.env.ADMIN_VK_ID || '');
const databasePath = process.env.DATABASE_PATH || '/data/roadnote.sqlite';
const paytagBrowserTimeoutMs = Math.max(8000, Number(process.env.PAYTAG_BROWSER_TIMEOUT_MS || 25000));
const paytagFetchesInFlight = new Map();

if (!appSecret) console.warn('VK_APP_SECRET is not configured: VK-authenticated endpoints will reject requests.');
if (!adminVkId) console.warn('ADMIN_VK_ID is not configured: admin users page will remain locked.');

fs.mkdirSync(path.dirname(databasePath), { recursive: true });
const db = new Database(databasePath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    vk_id TEXT PRIMARY KEY,
    first_name TEXT NOT NULL DEFAULT '',
    last_name TEXT NOT NULL DEFAULT '',
    photo_url TEXT NOT NULL DEFAULT '',
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    visit_count INTEGER NOT NULL DEFAULT 1
  );
`);

const upsertUser = db.prepare(`
  INSERT INTO users (vk_id, first_name, last_name, photo_url, first_seen, last_seen, visit_count)
  VALUES (@vk_id, @first_name, @last_name, @photo_url, @now, @now, 1)
  ON CONFLICT(vk_id) DO UPDATE SET
    first_name = CASE WHEN excluded.first_name <> '' THEN excluded.first_name ELSE users.first_name END,
    last_name = CASE WHEN excluded.last_name <> '' THEN excluded.last_name ELSE users.last_name END,
    photo_url = CASE WHEN excluded.photo_url <> '' THEN excluded.photo_url ELSE users.photo_url END,
    last_seen = excluded.last_seen,
    visit_count = users.visit_count + 1
`);
const listUsers = db.prepare(`
  SELECT vk_id, first_name, last_name, photo_url, first_seen, last_seen, visit_count
  FROM users
  ORDER BY last_seen DESC
`);
const userCount = db.prepare('SELECT COUNT(*) AS count FROM users');

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

function parseLaunchParams(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 12000) {
    throw new Error('Missing or oversized VK launch parameters');
  }
  const query = raw.startsWith('?') ? raw.slice(1) : raw;
  const params = new URLSearchParams(query);
  const sign = params.get('sign');
  const vkParams = [...params.entries()]
    .filter(([key]) => key.startsWith('vk_'))
    .sort(([a], [b]) => a.localeCompare(b));
  if (!sign || !vkParams.length) throw new Error('Missing VK signature');

  const receivedAppId = params.get('vk_app_id');
  const userId = params.get('vk_user_id');
  if (receivedAppId !== appId || !userId || !/^\d+$/.test(userId)) {
    throw new Error('Unexpected VK app or user');
  }
  if (!appSecret) throw new Error('VK auth is not configured');

  const canonical = new URLSearchParams();
  for (const [key, value] of vkParams) canonical.append(key, value);
  const expected = crypto.createHmac('sha256', appSecret)
    .update(canonical.toString())
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  const a = Buffer.from(sign);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('Invalid VK launch signature');
  }
  return { userId, params };
}

function launchParamsFromRequest(req) {
  const auth = req.get('authorization') || '';
  if (!auth.startsWith('VK ')) throw new Error('Missing VK authorization');
  let raw;
  try {
    raw = Buffer.from(auth.slice(3), 'base64url').toString('utf8');
  } catch {
    throw new Error('Invalid VK authorization');
  }
  return parseLaunchParams(raw);
}

function requireAdmin(req, res, next) {
  try {
    if (!adminVkId) return res.status(503).json({ error: 'Admin access is not configured on the server' });
    const { userId } = launchParamsFromRequest(req);
    if (userId !== adminVkId) return res.status(403).json({ error: 'Access denied' });
    req.vkUserId = userId;
    next();
  } catch {
    return res.status(401).json({ error: 'VK authentication failed. Open this page from the VK Mini App.' });
  }
}

function cleanText(value, maxLength = 120) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}


function collectObjects(value, depth = 0, result = []) {
  if (!value || typeof value !== 'object' || depth > 6) return result;
  if (Array.isArray(value)) {
    for (const item of value) collectObjects(item, depth + 1, result);
    return result;
  }
  result.push(value);
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === 'object') collectObjects(nested, depth + 1, result);
  }
  return result;
}

function normalizeTransportType(value = '') {
  const cleaned = String(value).trim();
  const dictionary = {
    'трамвай': 'Трамвай',
    'автобус': 'Автобус',
    'троллейбус': 'Троллейбус',
    'электробус': 'Электробус',
    'маршрутка': 'Маршрутка',
    'метро': 'Метро'
  };
  return dictionary[cleaned.toLowerCase()] || cleaned;
}

function normalizePaytagPayload(payload = {}) {
  const objects = collectObjects(payload);
  const pick = (keys) => {
    for (const object of objects) {
      for (const key of keys) {
        const value = object?.[key];
        if ((typeof value === 'string' || typeof value === 'number') && String(value).trim()) {
          return String(value).trim();
        }
      }
    }
    return '';
  };

  let transportType = pick([
    'transportType', 'vehicleType', 'transport_name', 'vehicle_type',
    'transport_type', 'transportName', 'transport'
  ]);
  if (!transportType) {
    const genericType = pick(['type']);
    if (/^(трамвай|автобус|троллейбус|электробус|маршрутка|метро)$/i.test(genericType)) {
      transportType = genericType;
    }
  }

  return {
    transportType: normalizeTransportType(transportType),
    routeNumber: pick(['routeNumber', 'route_no', 'route_number', 'lineNumber', 'line_number', 'route', 'line']),
    vehicleNumber: pick(['vehicleNumber', 'vehicle_no', 'vehicle_number', 'transportNumber', 'transport_number', 'carNumber', 'ts'])
  };
}

function extractTransportFromPageText(text = '') {
  const source = String(text).replace(/\\s+/g, ' ');
  const match = (patterns) => {
    for (const pattern of patterns) {
      const found = source.match(pattern);
      if (found?.[1]) return found[1].trim();
    }
    return '';
  };

  const transportType = normalizeTransportType(match([
    /\\b(Трамвай|Автобус|Троллейбус|Электробус|Маршрутка|Метро)\\b/i,
    /(?:тип\\s*транспорта|вид\\s*транспорта)\\s*[:№]?\\s*([А-Яа-яA-Za-z-]{3,30})/i
  ]));
  const routeNumber = match([
    /маршрут[^№\\d]{0,20}№\\s*([0-9A-Za-zА-Яа-я-]{1,8})/i,
    /(?:номер\\s*маршрута|маршрут)\\s*[:№]?\\s*([0-9A-Za-zА-Яа-я-]{1,8})/i,
    /№\\s*([0-9A-Za-zА-Яа-я-]{1,8})/
  ]);
  const vehicleNumber = match([
    /Т\\s*\\/\\s*С\\s*[:№]?\\s*([0-9A-Za-zА-Яа-я-]{1,12})/i,
    /ТС\\s*[:№]?\\s*([0-9A-Za-zА-Яа-я-]{1,12})/i,
    /(?:борт(?:овой)?\\s*номер|номер\\s*тс)\\s*[:№]?\\s*([0-9A-Za-zА-Яа-я-]{1,12})/i
  ]);

  return { transportType, routeNumber, vehicleNumber };
}

async function fetchPaytagViaHeadlessBrowser(paytagid) {
  const targetUrl = `https://qr.bilet.nspk.ru/?paytagid=${encodeURIComponent(paytagid)}&s=qr&m=t`;
  let browser;
  let capturedData = null;
  let lastJsonPayload = null;
  const startedAt = Date.now();

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'ru-RU'
    });
    const page = await context.newPage();

    page.on('response', async (response) => {
      try {
        if (!response.ok()) return;
        const responseUrl = new URL(response.url());
        if (responseUrl.hostname !== 'nspk.ru' && !responseUrl.hostname.endsWith('.nspk.ru')) return;
        const contentType = String(response.headers()['content-type'] || '').toLowerCase();
        if (!contentType.includes('json')) return;

        const payload = await response.json();
        lastJsonPayload = payload;
        const normalized = normalizePaytagPayload(payload);
        if (normalized.transportType && normalized.routeNumber && normalized.vehicleNumber) {
          capturedData = normalized;
        }
      } catch {
        // Другие JSON-ответы страницы не являются данными билета — пропускаем.
      }
    });

    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: Math.min(paytagBrowserTimeoutMs, 15000)
    });

    while (!capturedData && Date.now() - startedAt < paytagBrowserTimeoutMs) {
      const pageText = await page.locator('body').innerText({ timeout: 1000 }).catch(() => '');
      const pageData = extractTransportFromPageText(pageText);
      if (pageData.transportType && pageData.routeNumber && pageData.vehicleNumber) {
        capturedData = pageData;
        break;
      }

      if (lastJsonPayload) {
        const jsonData = normalizePaytagPayload(lastJsonPayload);
        if (jsonData.transportType && jsonData.routeNumber && jsonData.vehicleNumber) {
          capturedData = jsonData;
          break;
        }
      }
      await page.waitForTimeout(250);
    }

    if (capturedData) return capturedData;

    const finalText = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
    const extracted = extractTransportFromPageText(finalText);
    if (extracted.transportType && extracted.routeNumber && extracted.vehicleNumber) {
      return extracted;
    }

    throw new Error('Страница НСПК открылась, но тип транспорта, маршрут и номер Т/С не удалось извлечь. Проверьте доступность QR и повторите сканирование.');
  } catch (error) {
    throw new Error(`Не удалось обработать QR на сервере: ${error?.message || error}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}


app.get('/health', (_req, res) => {
  res.json({ ok: true, database: 'connected' });
});


app.post('/api/paytag', async (req, res) => {
  const paytagid = String(req.body?.paytagid || '').trim();
  if (!/^[0-9A-Za-z_-]{6,64}$/.test(paytagid)) {
    return res.status(400).json({ error: 'Некорректный идентификатор paytagid в QR-коде.' });
  }

  let task = paytagFetchesInFlight.get(paytagid);
  if (!task) {
    task = fetchPaytagViaHeadlessBrowser(paytagid);
    paytagFetchesInFlight.set(paytagid, task);
    task.finally(() => {
      if (paytagFetchesInFlight.get(paytagid) === task) paytagFetchesInFlight.delete(paytagid);
    }).catch(() => {});
  }

  try {
    const data = await task;
    return res.json({ ok: true, data });
  } catch (error) {
    console.error(`[api/paytag] ${paytagid}: ${error?.message || error}`);
    return res.status(502).json({ error: error?.message || 'Не удалось получить данные QR-кода с сервера.' });
  }
});

// The client-supplied profile fields are display metadata only. Identity is always
// taken from the VK launch parameters after the server verifies their signature.
app.post('/api/session', (req, res) => {
  try {
    const { userId } = parseLaunchParams(req.body?.launchParams);
    const profile = req.body?.profile || {};
    const now = new Date().toISOString();
    upsertUser.run({
      vk_id: userId,
      first_name: cleanText(profile.first_name),
      last_name: cleanText(profile.last_name),
      photo_url: cleanText(profile.photo_url, 1000),
      now
    });
    return res.json({ ok: true, isAdmin: userId === adminVkId });
  } catch (error) {
    return res.status(401).json({ error: 'VK authentication failed' });
  }
});

app.get('/api/admin/users', requireAdmin, (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ users: listUsers.all(), total: userCount.get().count });
});

app.get('/admin/users', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'admin-users.html'));
});

app.get('/proxy', async (req, res) => {
  const rawUrl = req.query.url;
  let parsed;
  try { parsed = new URL(rawUrl); } catch { parsed = null; }
  if (!parsed || parsed.protocol !== 'https:' || parsed.hostname !== 'qr.bilet.nspk.ru') {
    return res.status(400).json({ error: 'Only https://qr.bilet.nspk.ru URLs are allowed' });
  }

  try {
    const upstream = await fetch(parsed.toString(), {
      method: 'GET',
      headers: { 'User-Agent': 'qrnspk-proxy/1.0 (+roadnote)' }
    });
    const contentType = upstream.headers.get('content-type') || 'text/html; charset=utf-8';
    const body = await upstream.text();
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(upstream.status).send(body);
  } catch (error) {
    return res.status(502).json({ error: `Proxy request failed: ${error.message}` });
  }
});

app.use(express.static(__dirname, { index: 'index.html' }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(port, () => console.log(`Roadnote server listening on port ${port}`));
