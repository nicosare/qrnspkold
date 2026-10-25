import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = Number(process.env.PORT || 3000);
const appId = String(process.env.VK_APP_ID || '54843054');
const appSecret = process.env.VK_APP_SECRET || '';
const adminVkId = String(process.env.ADMIN_VK_ID || '');
const databasePath = process.env.DATABASE_PATH || '/data/roadnote.sqlite';
const paytagDirectTimeoutMs = Math.max(3000, Number(process.env.PAYTAG_DIRECT_TIMEOUT_MS || 12000));
const paytagFetchesInFlight = new Map();
const liveStreams = new Map();
const liveTokens = new Map();
function makeLiveToken(userId) {
  const now = Date.now();
  for (const [token, record] of liveTokens) {
    if (record.expiresAt <= now) liveTokens.delete(token);
  }
  const token = crypto.randomBytes(32).toString('hex');
  liveTokens.set(token, { userId: String(userId), expiresAt: now + 86400000 });
  return token;
}
function getLiveEntitlement(userId) {
  const row = getUserEntitlements.get(String(userId));
  return {
    scanBalance: row && row.scan_balance !== null ? Number(row.scan_balance) : null,
    subscriptionUntil: row?.subscription_until || null,
    subscriptionActive: Boolean(row?.subscription_until && Date.parse(row.subscription_until) > Date.now()),
    unlimited: Number(row?.unlimited || 0) === 1
  };
}
function sendLiveEntitlement(userId) {
  const stream = liveStreams.get(String(userId));
  if (stream) stream.write('event: entitlement\ndata: ' + JSON.stringify(getLiveEntitlement(userId)) + '\n\n');
}


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
    visit_count INTEGER NOT NULL DEFAULT 1,
    scan_balance INTEGER DEFAULT NULL,
    subscription_until TEXT DEFAULT NULL,
    unlimited INTEGER NOT NULL DEFAULT 0,
    last_scan_at TEXT DEFAULT NULL,
    last_transport_number TEXT DEFAULT NULL
  );
`);

// Existing databases predate per-user scan balances. NULL means the balance
// has not been assigned yet; once configured, zero blocks scanning and each
// successful scan consumes one unit.
const userColumns = db.pragma('table_info(users)');
if (!userColumns.some(column => column.name === 'scan_balance')) {
  db.exec('ALTER TABLE users ADD COLUMN scan_balance INTEGER DEFAULT NULL');
}
if (!userColumns.some(column => column.name === 'subscription_until')) {
  db.exec('ALTER TABLE users ADD COLUMN subscription_until TEXT DEFAULT NULL');
}
if (!userColumns.some(column => column.name === 'unlimited')) {
  db.exec('ALTER TABLE users ADD COLUMN unlimited INTEGER NOT NULL DEFAULT 0');
}
if (!userColumns.some(column => column.name === 'last_scan_at')) {
  db.exec('ALTER TABLE users ADD COLUMN last_scan_at TEXT DEFAULT NULL');
}
if (!userColumns.some(column => column.name === 'last_transport_number')) {
  db.exec('ALTER TABLE users ADD COLUMN last_transport_number TEXT DEFAULT NULL');
}

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
  SELECT vk_id, first_name, last_name, photo_url, first_seen, last_seen, visit_count,
         scan_balance, subscription_until, unlimited, last_scan_at, last_transport_number
  FROM users
  ORDER BY last_seen DESC
`);
const userCount = db.prepare('SELECT COUNT(*) AS count FROM users');
const getUserScanBalance = db.prepare('SELECT scan_balance, subscription_until, unlimited FROM users WHERE vk_id = ?');
const grantPack = db.prepare('UPDATE users SET scan_balance = COALESCE(scan_balance, 0) + ? WHERE vk_id = ?');
const setUnlimited = db.prepare('UPDATE users SET unlimited = ?, scan_balance = CASE WHEN ? = 0 THEN COALESCE(scan_balance, 0) ELSE scan_balance END WHERE vk_id = ?');
const updateSubscription = db.prepare('UPDATE users SET subscription_until = ?, scan_balance = COALESCE(scan_balance, 0) WHERE vk_id = ?');
const getUserEntitlements = db.prepare('SELECT scan_balance, subscription_until, unlimited FROM users WHERE vk_id = ?');
const spendUserScan = db.prepare(
  'UPDATE users SET scan_balance = scan_balance - 1 WHERE vk_id = ? AND scan_balance IS NOT NULL AND scan_balance > 0'
);
const ensureUserForScan = db.prepare(`
  INSERT INTO users (vk_id, first_name, last_name, photo_url, first_seen, last_seen, visit_count, scan_balance)
  VALUES (?, '', '', '', ?, ?, 1, NULL)
  ON CONFLICT(vk_id) DO NOTHING
`);

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
    'transportType', 'vehicleTypeName', 'vehicleType', 'transport_name',
    'vehicle_type', 'transport_type', 'transportName', 'transport'
  ]);

  if (!transportType) {
    const genericType = pick(['type']);
    if (/^(трамвай|автобус|троллейбус|электробус|маршрутка|метро)$/i.test(genericType)) {
      transportType = genericType;
    }
  }

  const rawPrice = pick(['price']);
  const priceKopecks = rawPrice === '' ? NaN : Number(rawPrice);

  return {
    transportType: normalizeTransportType(transportType),
    routeNumber: pick(['routeNumber', 'route_no', 'route_number', 'lineNumber', 'line_number', 'route', 'line']),
    vehicleNumber: pick(['vehicleNumber', 'vehicle_no', 'vehicle_number', 'transportNumber', 'transport_number', 'carNumber', 'ts']),
    // The NSPK API represents prices in kopecks; the UI shows rubles.
    price: Number.isFinite(priceKopecks) && priceKopecks >= 0 ? priceKopecks / 100 : null
  };
}

async function fetchPaytagViaDirectApi(paytagid) {
  const target = new URL('https://qr.bilet.nspk.ru/api/v1/pay-tags/tariff');
  target.searchParams.set('payTagId', paytagid);
  target.searchParams.set('s', 'qr');
  target.searchParams.set('m', 't');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), paytagDirectTimeoutMs);

  try {
    const response = await fetch(target, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        Accept: 'application/json,text/plain,*/*',
        'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
        Referer: 'https://qr.bilet.nspk.ru/'
      }
    });

    const responseText = await response.text();
    let payload;
    try {
      payload = JSON.parse(responseText);
    } catch {
      throw new Error('НСПК вернул не JSON (HTTP ' + response.status + ').');
    }

    if (!response.ok) {
      throw new Error('НСПК вернул HTTP ' + response.status + '.');
    }
    if (payload?.responseStatus && payload.responseStatus !== 'OK') {
      throw new Error('НСПК сообщил статус: ' + payload.responseStatus + '.');
    }

    const data = normalizePaytagPayload(payload);
    if (!data.transportType || !data.routeNumber || !data.vehicleNumber) {
      throw new Error('Ответ НСПК получен, но в нём нет типа транспорта, маршрута или номера Т/С.');
    }

    return data;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('НСПК не ответил за ' + paytagDirectTimeoutMs + ' мс.');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
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

  let userId;
  try {
    ({ userId } = launchParamsFromRequest(req));
  } catch (error) {
    return res.status(401).json({
      code: 'VK_AUTH_REQUIRED',
      error: 'Откройте Roadnote внутри VK, чтобы подтвердить пользователя.'
    });
  }

  const now = new Date().toISOString();
  ensureUserForScan.run(userId, now, now);
  const balanceRow = getUserScanBalance.get(userId);
  const balanceBefore = balanceRow?.scan_balance === null || balanceRow?.scan_balance === undefined
    ? null
    : Number(balanceRow.scan_balance);
  const subscriptionActive = Boolean(balanceRow?.subscription_until && Date.parse(balanceRow.subscription_until) > Date.now());
  const hasUnlimited = Number(balanceRow?.unlimited || 0) === 1 || subscriptionActive;

  if (!hasUnlimited && balanceBefore !== null && (!Number.isSafeInteger(balanceBefore) || balanceBefore <= 0)) {
    return res.status(402).json({
      ok: false,
      code: 'SCAN_BALANCE_EMPTY',
      scanBalance: 0,
      error: 'Баланс сканов исчерпан. Пополните баланс, чтобы продолжить.'
    });
  }

  let task = paytagFetchesInFlight.get(paytagid);
  if (!task && paytagFetchesInFlight.size >= 5) {
    return res.status(429).json({ error: 'Сервер уже обрабатывает другие QR-коды. Повторите попытку через несколько секунд.' });
  }
  if (!task) {
    task = fetchPaytagViaDirectApi(paytagid);
    paytagFetchesInFlight.set(paytagid, task);
    task.finally(() => {
      if (paytagFetchesInFlight.get(paytagid) === task) paytagFetchesInFlight.delete(paytagid);
    }).catch(() => {});
  }

  res.setHeader('Cache-Control', 'no-store');
  try {
    const data = await task;
    let scanBalance = balanceBefore;

    // Active subscriptions and explicit unlimited access do not consume pack scans.
    // Charge only after valid transport data was fetched.
    if (!hasUnlimited && balanceBefore !== null) {
      const spent = spendUserScan.run(userId);
      if (spent.changes !== 1) {
        return res.status(402).json({
          ok: false,
          code: 'SCAN_BALANCE_EMPTY',
          scanBalance: 0,
          error: 'Баланс сканов исчерпан. Пополните баланс, чтобы продолжить.'
        });
      }
      scanBalance = Number(getUserScanBalance.get(userId).scan_balance);
      sendLiveEntitlement(userId);
    }

    db.prepare('UPDATE users SET last_scan_at = ?, last_transport_number = ? WHERE vk_id = ?')
      .run(new Date().toISOString(), String(data.vehicleNumber || '').trim() || null, userId);

    return res.json({
      ok: true,
      data,
      source: 'direct-api',
      scanBalance,
      subscriptionUntil: balanceRow?.subscription_until || null,
      unlimited: Number(balanceRow?.unlimited || 0) === 1,
      subscriptionActive
    });
  } catch (error) {
    console.error('[api/paytag] ' + paytagid + ': ' + (error?.message || error));
    return res.status(502).json({ error: error?.message || 'Не удалось получить данные QR-кода с НСПК.' });
  }
});

// The client-supplied profile fields are display metadata only. Identity is always
// taken from the VK launch parameters after the server verifies their signature.
app.post('/api/session', (req, res) => {
  try {
    const { userId } = parseLaunchParams(req.body?.launchParams);
    const profile = req.body?.profile || {};
    if (req.body?.refreshOnly !== true) {
      const now = new Date().toISOString();
      upsertUser.run({
        vk_id: userId,
        first_name: cleanText(profile.first_name),
        last_name: cleanText(profile.last_name),
        photo_url: cleanText(profile.photo_url, 1000),
        now
      });
    }
    const balanceRow = getUserScanBalance.get(userId);
    const scanBalance = balanceRow && balanceRow.scan_balance !== null
      ? Number(balanceRow.scan_balance)
      : null;
    const subscriptionUntil = balanceRow?.subscription_until || null;
    const subscriptionActive = Boolean(subscriptionUntil && Date.parse(subscriptionUntil) > Date.now());
    const unlimited = Number(balanceRow?.unlimited || 0) === 1;
    return res.json({
      ok: true,
      isAdmin: userId === adminVkId,
      scanBalance,
      subscriptionUntil,
      subscriptionActive,
      unlimited,
      eventsToken: makeLiveToken(userId)
    });
  } catch (error) {
    return res.status(401).json({ error: 'VK authentication failed' });
  }
});

app.get('/api/events', (req, res) => {
  const token = String(req.query?.token || '');
  const record = liveTokens.get(token);
  if (!record || record.expiresAt <= Date.now()) return res.status(401).end();
  const userId = record.userId;
  res.status(200).setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  liveStreams.set(userId, res);
  res.write('event: entitlement\ndata: ' + JSON.stringify(getLiveEntitlement(userId)) + '\n\n');
  const heartbeat = setInterval(() => { try { res.write(': keep-alive\n\n'); } catch (_) {} }, 25000);
  res.on('close', () => {
    clearInterval(heartbeat);
    if (liveStreams.get(userId) === res) liveStreams.delete(userId);
  });
});

app.get('/api/admin/users', requireAdmin, (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const now = Date.now();
  const users = listUsers.all().map(user => ({
    ...user,
    unlimited: Number(user.unlimited || 0) === 1,
    subscriptionActive: Boolean(user.subscription_until && Date.parse(user.subscription_until) > now)
  }));
  res.json({ users, total: userCount.get().count });
});

app.post('/api/admin/users/:vkId/entitlement', requireAdmin, (req, res) => {
  const vkId = String(req.params.vkId || '');
  if (!/^[0-9]+$/.test(vkId)) return res.status(400).json({ error: 'Некорректный VK ID.' });
  const user = getUserEntitlements.get(vkId);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден.' });

  const action = req.body?.action;
  const now = new Date();
  try {
    if (action === 'grant_pack') {
      const amount = Number(req.body?.amount);
      if (!Number.isSafeInteger(amount) || amount < 1 || amount > 100000) {
        return res.status(400).json({ error: 'Укажите количество сканов от 1 до 100000.' });
      }
      grantPack.run(amount, vkId);
    } else if (action === 'grant_months') {
      const months = Number(req.body?.months);
      if (!Number.isSafeInteger(months) || months < 1 || months > 120) {
        return res.status(400).json({ error: 'Укажите количество месяцев от 1 до 120.' });
      }
      const currentExpiry = user.subscription_until && Date.parse(user.subscription_until) > now.getTime()
        ? new Date(user.subscription_until)
        : now;
      const expiry = new Date(currentExpiry);
      const originalDay = expiry.getUTCDate();
      expiry.setUTCDate(1);
      expiry.setUTCMonth(expiry.getUTCMonth() + months);
      const lastDayOfMonth = new Date(Date.UTC(expiry.getUTCFullYear(), expiry.getUTCMonth() + 1, 0)).getUTCDate();
      expiry.setUTCDate(Math.min(originalDay, lastDayOfMonth));
      updateSubscription.run(expiry.toISOString(), vkId);
    } else if (action === 'set_unlimited') {
      if (typeof req.body?.enabled !== 'boolean') {
        return res.status(400).json({ error: 'Не задано состояние безлимита.' });
      }
      const enabled = req.body.enabled ? 1 : 0;
      setUnlimited.run(enabled, enabled, vkId);
    } else {
      return res.status(400).json({ error: 'Неизвестное действие.' });
    }
    const updated = getUserEntitlements.get(vkId);
    sendLiveEntitlement(vkId);
    return res.json({
      ok: true,
      user: {
        vk_id: vkId,
        scan_balance: updated.scan_balance,
        subscription_until: updated.subscription_until,
        unlimited: Number(updated.unlimited || 0) === 1,
        subscriptionActive: Boolean(updated.subscription_until && Date.parse(updated.subscription_until) > Date.now())
      }
    });
  } catch (error) {
    console.error('[admin entitlement]', error);
    return res.status(500).json({ error: 'Не удалось изменить доступ пользователя.' });
  }
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

app.use((req, res, next) => {
  // VK's webview may keep HTML/JS cached aggressively. Always serve the app entry
  // document and executable scripts with explicit no-cache headers.
  if (req.path === '/' || /\.(html|js)$/i.test(req.path)) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

app.use(express.static(__dirname, { index: 'index.html' }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(port, () => console.log(`Roadnote server listening on port ${port}`));
