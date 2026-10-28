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
const yoomoneyNotificationSecret = String(process.env.YOOMONEY_NOTIFICATION_SECRET || '');

const communityId = String(process.env.VK_GROUP_ID || '242494208');
const communityToken = String(process.env.VK_GROUP_TOKEN || '');
const callbackSecret = String(process.env.VK_CALLBACK_SECRET || '');
const callbackConfirmation = String(process.env.VK_CALLBACK_CONFIRMATION || '');
const vkApiVersion = '5.199';
console.info('[Roadnote VK config]', JSON.stringify({ appId, communityId, communityIdSource: process.env.VK_GROUP_ID ? 'VK_GROUP_ID' : 'default', hasCommunityToken: Boolean(communityToken) }));

const tariffOffers = Object.freeze({
  scans_9: { id: 'scans_9', name: 'Пакет «Старт» — 9 сканов', kind: 'pack', quantity: 9, regularPrice: 99, promoPrice: 69 },
  scans_29: { id: 'scans_29', name: 'Пакет «Оптимальный» — 29 сканов', kind: 'pack', quantity: 29, regularPrice: 249, promoPrice: 179 },
  scans_49: { id: 'scans_49', name: 'Пакет «Большой запас» — 49 сканов', kind: 'pack', quantity: 49, regularPrice: 369, promoPrice: 279 },
  subscription_1m: { id: 'subscription_1m', name: 'Безлимит на 1 месяц', kind: 'subscription', quantity: 1, regularPrice: 349, promoPrice: 249 },
  subscription_3m: { id: 'subscription_3m', name: 'Безлимит на 3 месяца', kind: 'subscription', quantity: 3, regularPrice: 799, promoPrice: 599 },
  subscription_6m: { id: 'subscription_6m', name: 'Безлимит на 6 месяцев', kind: 'subscription', quantity: 6, regularPrice: 1299, promoPrice: 949 }
});
const databasePath = process.env.DATABASE_PATH || '/data/roadnote.sqlite';
const paytagDirectTimeoutMs = Math.max(3000, Number(process.env.PAYTAG_DIRECT_TIMEOUT_MS || 12000));
const paytagFetchesInFlight = new Map();
const liveStreams = new Map();
const liveTokens = new Map();
const avatarUploadAwaiting = new Set();
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
  ensureDailyScan(userId);
  const row = getUserEntitlements.get(String(userId));
  const subscriptionActive = Boolean(row?.subscription_until && Date.parse(row.subscription_until) > Date.now());
  const unlimited = Number(row?.unlimited || 0) === 1;
  const paidBalance = row && row.scan_balance !== null ? Number(row.scan_balance) : 0;
  const dailyAvailable = row?.daily_scan_date === yekaterinburgDayKey() && Number(row?.daily_scan_available || 0) === 1;
  return {
    scanBalance: paidBalance > 0 ? paidBalance : dailyAvailable ? 1 : 0,
    subscriptionUntil: row?.subscription_until || null,
    subscriptionActive,
    unlimited
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
    last_transport_number TEXT DEFAULT NULL,
    welcome_bonus_granted INTEGER NOT NULL DEFAULT 0,
    daily_scan_date TEXT DEFAULT NULL,
    daily_scan_available INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS scan_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vk_id TEXT NOT NULL,
    scanned_at TEXT NOT NULL,
    paytag_id TEXT,
    transport_type TEXT NOT NULL DEFAULT '',
    route_number TEXT NOT NULL DEFAULT '',
    vehicle_number TEXT NOT NULL DEFAULT '',
    price REAL DEFAULT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_scan_history_user_time
    ON scan_history(vk_id, scanned_at DESC);
  CREATE TABLE IF NOT EXISTS scan_credit_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vk_id TEXT NOT NULL,
    credited_at TEXT NOT NULL,
    amount INTEGER NOT NULL,
    source TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_scan_credit_history_user_time
    ON scan_credit_history(vk_id, credited_at DESC, id DESC);
  CREATE TABLE IF NOT EXISTS referrals (
    invitee_vk_id TEXT PRIMARY KEY,
    inviter_vk_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    rewarded_at TEXT DEFAULT NULL,
    CHECK (invitee_vk_id <> inviter_vk_id)
  );
  CREATE INDEX IF NOT EXISTS idx_referrals_inviter
    ON referrals(inviter_vk_id, created_at DESC);
`);
// Keep legacy data untouched and persist tariff requests independently of app restarts.
db.exec(
  "CREATE TABLE IF NOT EXISTS tariff_requests (" +
  "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
  "vk_id TEXT NOT NULL, " +
  "offer_id TEXT NOT NULL, " +
  "offer_name TEXT NOT NULL, " +
  "offer_kind TEXT NOT NULL CHECK(offer_kind IN ('pack','subscription')), " +
  "quantity INTEGER NOT NULL, " +
  "price_rub INTEGER NOT NULL, " +
  "regular_price_rub INTEGER NOT NULL, " +
  "is_discounted INTEGER NOT NULL DEFAULT 0, " +
  "status TEXT NOT NULL CHECK(status IN ('awaiting_payment','awaiting_review','approved','rejected','replaced','delivery_failed')), " +
  "created_at TEXT NOT NULL, " +
  "updated_at TEXT NOT NULL, " +
  "completed_at TEXT DEFAULT NULL, " +
  "bot_message_id TEXT DEFAULT NULL, " +
  "admin_message_id TEXT DEFAULT NULL, " +
  "screenshot_attachment TEXT DEFAULT NULL, " +
  "screenshot_message_id TEXT DEFAULT NULL, " +
  "payment_label TEXT DEFAULT NULL, " +
  "payment_operation_id TEXT DEFAULT NULL, " +
  "payment_confirmed_at TEXT DEFAULT NULL" +
  "); " +
  "CREATE INDEX IF NOT EXISTS idx_tariff_requests_user_time ON tariff_requests(vk_id, created_at DESC); " +
  "DROP INDEX IF EXISTS idx_tariff_requests_one_active_per_user; " +
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_tariff_requests_one_unpaid_per_user ON tariff_requests(vk_id) WHERE status = 'awaiting_payment';"
);

const tariffRequestColumns = db.pragma('table_info(tariff_requests)');
if (!tariffRequestColumns.some(column => column.name === 'payment_label')) db.exec('ALTER TABLE tariff_requests ADD COLUMN payment_label TEXT DEFAULT NULL');
if (!tariffRequestColumns.some(column => column.name === 'payment_operation_id')) db.exec('ALTER TABLE tariff_requests ADD COLUMN payment_operation_id TEXT DEFAULT NULL');
if (!tariffRequestColumns.some(column => column.name === 'payment_confirmed_at')) db.exec('ALTER TABLE tariff_requests ADD COLUMN payment_confirmed_at TEXT DEFAULT NULL');
if (!tariffRequestColumns.some(column => column.name === 'promo_application_id')) db.exec('ALTER TABLE tariff_requests ADD COLUMN promo_application_id INTEGER DEFAULT NULL');
if (!tariffRequestColumns.some(column => column.name === 'promo_code_id')) db.exec('ALTER TABLE tariff_requests ADD COLUMN promo_code_id INTEGER DEFAULT NULL');
if (!tariffRequestColumns.some(column => column.name === 'promo_code')) db.exec('ALTER TABLE tariff_requests ADD COLUMN promo_code TEXT DEFAULT NULL');
if (!tariffRequestColumns.some(column => column.name === 'promo_discount_percent')) db.exec('ALTER TABLE tariff_requests ADD COLUMN promo_discount_percent INTEGER DEFAULT NULL');
if (!tariffRequestColumns.some(column => column.name === 'promo_discount_rub')) db.exec('ALTER TABLE tariff_requests ADD COLUMN promo_discount_rub INTEGER DEFAULT NULL');
db.exec(`
  CREATE TABLE IF NOT EXISTS promo_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    discount_percent INTEGER NOT NULL CHECK(discount_percent BETWEEN 1 AND 100),
    offer_ids_json TEXT NOT NULL,
    starts_at TEXT DEFAULT NULL,
    expires_at TEXT DEFAULT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_promo_codes_active ON promo_codes(is_active, expires_at);
  CREATE TABLE IF NOT EXISTS promo_code_applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vk_id TEXT NOT NULL,
    promo_code_id INTEGER NOT NULL,
    promo_code TEXT NOT NULL,
    discount_percent INTEGER NOT NULL,
    offer_ids_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('selected','used','cancelled')),
    selected_at TEXT NOT NULL,
    used_at TEXT DEFAULT NULL,
    tariff_request_id INTEGER DEFAULT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_promo_app_user_status ON promo_code_applications(vk_id, status, id DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_promo_app_one_selected_per_user ON promo_code_applications(vk_id) WHERE status = 'selected';
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS yoomoney_operations (
    operation_id TEXT PRIMARY KEY, request_id INTEGER DEFAULT NULL, label TEXT NOT NULL DEFAULT '',
    amount_rub REAL DEFAULT NULL, currency TEXT NOT NULL DEFAULT '', notification_type TEXT NOT NULL DEFAULT '',
    sender TEXT NOT NULL DEFAULT '', state TEXT NOT NULL CHECK(state IN ('credited','needs_review')),
    payload_json TEXT NOT NULL, received_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_yoomoney_operations_request ON yoomoney_operations(request_id, received_at DESC);
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
if (!userColumns.some(column => column.name === 'welcome_bonus_granted')) {
  db.exec('ALTER TABLE users ADD COLUMN welcome_bonus_granted INTEGER NOT NULL DEFAULT 0');
}
if (!userColumns.some(column => column.name === 'daily_scan_date')) {
  db.exec('ALTER TABLE users ADD COLUMN daily_scan_date TEXT DEFAULT NULL');
}
if (!userColumns.some(column => column.name === 'daily_scan_available')) {
  db.exec('ALTER TABLE users ADD COLUMN daily_scan_available INTEGER NOT NULL DEFAULT 0');
}

// Older accounts with an unassigned balance receive the welcome scans once.
// Accounts that already had an assigned balance are treated as previously onboarded.
db.prepare(`
  UPDATE users
  SET scan_balance = 3, welcome_bonus_granted = 1
  WHERE welcome_bonus_granted = 0
    AND scan_balance IS NULL
    AND COALESCE(unlimited, 0) = 0
    AND (subscription_until IS NULL OR subscription_until <= ?)
`).run(new Date().toISOString());
db.prepare('UPDATE users SET welcome_bonus_granted = 1 WHERE welcome_bonus_granted = 0').run();

const upsertUser = db.prepare(`
  INSERT INTO users (vk_id, first_name, last_name, photo_url, first_seen, last_seen, visit_count, scan_balance, welcome_bonus_granted)
  VALUES (@vk_id, @first_name, @last_name, @photo_url, @now, @now, 1, 3, 1)
  ON CONFLICT(vk_id) DO UPDATE SET
    first_name = CASE WHEN excluded.first_name <> '' THEN excluded.first_name ELSE users.first_name END,
    last_name = CASE WHEN excluded.last_name <> '' THEN excluded.last_name ELSE users.last_name END,
    photo_url = CASE WHEN excluded.photo_url <> '' THEN excluded.photo_url ELSE users.photo_url END,
    last_seen = excluded.last_seen,
    visit_count = users.visit_count + 1
`);
const listUsers = db.prepare(`
  SELECT u.vk_id, u.first_name, u.last_name, u.photo_url, u.first_seen, u.last_seen, u.visit_count,
         u.scan_balance, u.subscription_until, u.unlimited, u.last_scan_at, u.last_transport_number,
         u.welcome_bonus_granted, u.daily_scan_date, u.daily_scan_available,
         (SELECT COUNT(*) FROM scan_history sh WHERE sh.vk_id = u.vk_id) AS scan_count,
         (SELECT sh.transport_type FROM scan_history sh WHERE sh.vk_id = u.vk_id ORDER BY sh.scanned_at DESC, sh.id DESC LIMIT 1) AS last_transport_type,
         (SELECT sh.route_number FROM scan_history sh WHERE sh.vk_id = u.vk_id ORDER BY sh.scanned_at DESC, sh.id DESC LIMIT 1) AS last_route_number
  FROM users u
  ORDER BY u.last_seen DESC
`);
const listUserScans = db.prepare(`
  SELECT id, scanned_at, transport_type, route_number, vehicle_number, price
  FROM scan_history
  WHERE vk_id = ?
  ORDER BY scanned_at DESC, id DESC
  LIMIT 500
`);
const listUserCredits = db.prepare(`
  SELECT id, credited_at, amount, source, note
  FROM scan_credit_history
  WHERE vk_id = ?
  ORDER BY credited_at DESC, id DESC
  LIMIT 500
`);
const recordScanCredit = db.prepare(`
  INSERT INTO scan_credit_history (vk_id, credited_at, amount, source, note)
  VALUES (?, ?, ?, ?, ?)
`);
const recordScan = db.prepare(`
  INSERT INTO scan_history
    (vk_id, scanned_at, paytag_id, transport_type, route_number, vehicle_number, price)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const getReferralForInvitee = db.prepare(
  'SELECT inviter_vk_id, rewarded_at FROM referrals WHERE invitee_vk_id = ?'
);
const insertReferral = db.prepare(
  'INSERT OR IGNORE INTO referrals (invitee_vk_id, inviter_vk_id, created_at) VALUES (?, ?, ?)'
);
const rewardReferralOnce = db.prepare(
  'UPDATE referrals SET rewarded_at = ? WHERE invitee_vk_id = ? AND rewarded_at IS NULL'
);
const grantReferralScans = db.prepare(
  'UPDATE users SET scan_balance = COALESCE(scan_balance, 0) + 3 WHERE vk_id = ?'
);
const getUserExists = db.prepare('SELECT 1 FROM users WHERE vk_id = ?');
const userCount = db.prepare('SELECT COUNT(*) AS count FROM users');
const getUserScanBalance = db.prepare('SELECT scan_balance, subscription_until, unlimited, daily_scan_date, daily_scan_available FROM users WHERE vk_id = ?');
const grantPack = db.prepare('UPDATE users SET scan_balance = COALESCE(scan_balance, 0) + ? WHERE vk_id = ?');
const setUnlimited = db.prepare('UPDATE users SET unlimited = ?, scan_balance = CASE WHEN ? = 0 THEN COALESCE(scan_balance, 0) ELSE scan_balance END WHERE vk_id = ?');
const updateSubscription = db.prepare('UPDATE users SET subscription_until = ?, scan_balance = COALESCE(scan_balance, 0) WHERE vk_id = ?');
const getUserEntitlements = db.prepare('SELECT scan_balance, subscription_until, unlimited, daily_scan_date, daily_scan_available FROM users WHERE vk_id = ?');
const spendUserScan = db.prepare(
  'UPDATE users SET scan_balance = scan_balance - 1 WHERE vk_id = ? AND scan_balance IS NOT NULL AND scan_balance > 0'
);
const spendDailyScan = db.prepare(
  'UPDATE users SET daily_scan_available = 0 WHERE vk_id = ? AND daily_scan_date = ? AND daily_scan_available = 1 AND COALESCE(scan_balance, 0) <= 0'
);
const ensureUserForScan = db.prepare(`
  INSERT INTO users (vk_id, first_name, last_name, photo_url, first_seen, last_seen, visit_count, scan_balance, welcome_bonus_granted)
  VALUES (?, '', '', '', ?, ?, 1, 3, 1)
  ON CONFLICT(vk_id) DO NOTHING
`);

function yekaterinburgDayKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Yekaterinburg',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return values.year + '-' + values.month + '-' + values.day;
}

// The daily bonus is a regular scan added to the ordinary balance.
// It is granted at most once per Yekaterinburg calendar day, only when the
// user's ordinary balance is empty and they have no active subscription.
const grantDailyScan = db.prepare(`
  UPDATE users
  SET scan_balance = 1, daily_scan_date = ?, daily_scan_available = 0
  WHERE vk_id = ?
    AND COALESCE(scan_balance, 0) <= 0
    AND COALESCE(unlimited, 0) = 0
    AND (subscription_until IS NULL OR subscription_until <= ?)
    AND (daily_scan_date IS NULL OR daily_scan_date <> ?)
`);

function ensureDailyScan(userId, now = new Date()) {
  const dayKey = yekaterinburgDayKey(now);
  const nowIso = now.toISOString();
  grantDailyScan.run(dayKey, String(userId), nowIso, dayKey);
  return dayKey;
}

function getDisplayedScanBalance(row) {
  if (!row || row.scan_balance === null || row.scan_balance === undefined) return 0;
  return Math.max(0, Number(row.scan_balance) || 0);
}

app.disable('x-powered-by');
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use(express.json({ limit: '12mb' }));

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



function formatRubles(value) {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Number(value) || 0) + ' ₽';
}

function getActivePromoSelection(userId) {
  const row = db.prepare("SELECT id, promo_code_id, promo_code, discount_percent, offer_ids_json, selected_at, tariff_request_id FROM promo_code_applications WHERE vk_id = ? AND status = 'selected' ORDER BY id DESC LIMIT 1").get(String(userId));
  if (!row) return null;
  let offerIds = [];
  try { offerIds = JSON.parse(row.offer_ids_json); } catch (_) {}
  return {
    applicationId: Number(row.id),
    promoCodeId: Number(row.promo_code_id),
    code: String(row.promo_code),
    discountPercent: Number(row.discount_percent),
    offerIds: Array.isArray(offerIds) ? offerIds.filter(id => Object.prototype.hasOwnProperty.call(tariffOffers, id)) : [],
    selectedAt: row.selected_at,
    tariffRequestId: row.tariff_request_id == null ? null : Number(row.tariff_request_id)
  };
}

function getTariffState(userId) {
  const id = String(userId);
  const completed = db.prepare("SELECT EXISTS(SELECT 1 FROM tariff_requests WHERE vk_id = ? AND status = 'approved') AS value").get(id);
  const activeRequests = db.prepare(
    "SELECT id, offer_id, offer_name, offer_kind, quantity, price_rub, status, created_at, updated_at, completed_at, screenshot_attachment, promo_code, promo_discount_percent " +
    "FROM tariff_requests WHERE vk_id = ? AND status IN ('awaiting_payment','awaiting_review') ORDER BY CASE status WHEN 'awaiting_payment' THEN 0 ELSE 1 END, id DESC LIMIT 20"
  ).all(id);
  const active = activeRequests.find(request => request.status === 'awaiting_payment') || activeRequests[0] || null;
  const history = db.prepare(
    "SELECT id, offer_id, offer_name, offer_kind, quantity, price_rub, status, created_at, completed_at " +
    "FROM tariff_requests WHERE vk_id = ? AND status IN ('approved','rejected') ORDER BY COALESCE(completed_at, updated_at) DESC, id DESC LIMIT 20"
  ).all(id);
  const mapRequest = request => ({
    id: Number(request.id),
    offerId: request.offer_id,
    name: request.offer_name,
    kind: request.offer_kind,
    promoCode: request.promo_code || null,
    promoDiscountPercent: request.promo_discount_percent == null ? null : Number(request.promo_discount_percent),
    quantity: Number(request.quantity),
    priceRub: Number(request.price_rub),
    status: request.status,
    createdAt: request.created_at,
    completedAt: request.completed_at || null,
    hasScreenshot: Boolean(request.screenshot_attachment),
    paymentLabel: request.payment_label || ('roadnote-request-' + request.id)
  });
  return {
    hasPurchased: Number(completed?.value || 0) === 1,
    activePromoCode: getActivePromoSelection(id),
    activeTariffRequest: active ? mapRequest(active) : null,
    activeTariffRequests: activeRequests.map(mapRequest),
    tariffRequestHistory: history.map(mapRequest)
  };
}

function sendLiveTariffState(userId, notice = '') {
  const stream = liveStreams.get(String(userId));
  if (!stream) return;
  try {
    const state = getTariffState(userId);
    stream.write('event: tariff\ndata: ' + JSON.stringify({ ...state, notice: cleanText(notice, 400) }) + '\n\n');
  } catch (error) {
    console.warn('[tariff state event]', error?.message || error);
  }
}

async function vkApi(method, parameters) {
  if (!communityToken) throw new Error('VK_GROUP_TOKEN не настроен на сервере.');
  const body = new URLSearchParams();
  body.set('access_token', communityToken);
  body.set('v', vkApiVersion);
  for (const [key, value] of Object.entries(parameters || {})) {
    if (value === undefined || value === null) continue;
    body.set(key, typeof value === 'string' ? value : String(value));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch('https://api.vk.com/method/' + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || payload.error) {
      const vkError = payload?.error;
      const message = vkError?.error_msg || ('VK API HTTP ' + response.status);
      const error = new Error(message);
      error.vkCode = vkError?.error_code;
      throw error;
    }
    return payload.response;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('VK API не ответил за 10 секунд.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function vkMessageId(response) {
  if (Number.isSafeInteger(response) && response > 0) return String(response);
  if (Array.isArray(response) && response.length) {
    const first = response[0];
    if (Number.isSafeInteger(first)) return String(first);
    if (first && first.message_id) return String(first.message_id);
  }
  if (response && response.message_id) return String(response.message_id);
  return '';
}

async function sendCommunityMessage(peerId, message, options = {}) {
  const parameters = {
    peer_id: String(peerId),
    random_id: String(crypto.randomInt(1, 2147483647)),
    message: String(message)
  };
  if (options.attachment) parameters.attachment = options.attachment;
  if (options.keyboard) parameters.keyboard = options.keyboard;
  return vkApi('messages.send', parameters);
}

async function deleteCommunityMessage(messageId) {
  if (!messageId || !communityToken) return;
  try {
    await vkApi('messages.delete', { message_ids: String(messageId), delete_for_all: 1 });
  } catch (error) {
    console.warn('[tariff message delete]', String(messageId), error?.message || error);
  }
}

function addUtcMonths(baseDate, months) {
  const expiry = new Date(baseDate);
  const originalDay = expiry.getUTCDate();
  expiry.setUTCDate(1);
  expiry.setUTCMonth(expiry.getUTCMonth() + months);
  const lastDayOfMonth = new Date(Date.UTC(expiry.getUTCFullYear(), expiry.getUTCMonth() + 1, 0)).getUTCDate();
  expiry.setUTCDate(Math.min(originalDay, lastDayOfMonth));
  return expiry;
}

function buildAdminMenuKeyboard() {
  return JSON.stringify({
    one_time: false,
    inline: false,
    buttons: [[{
      action: { type: 'text', label: 'Обновить иконку', payload: JSON.stringify({ action: 'update_community_avatar' }) },
      color: 'primary'
    }]]
  });
}

async function sendAdminMenu(message = 'Меню администратора Roadnote.') {
  if (!adminVkId) return;
  await sendCommunityMessage(adminVkId, message, { keyboard: buildAdminMenuKeyboard() });
}

async function getPhotoUrlFromMessage(message) {
  const messageId = String(message?.id || message?.conversation_message_id || '');
  if (!messageId) throw new Error('Не удалось определить сообщение с фотографией.');
  const response = await vkApi('messages.getById', { message_ids: messageId });
  const item = response?.items?.[0];
  const attachments = Array.isArray(item?.attachments) ? item.attachments : [];
  const photoAttachment = attachments.find(item => item?.type === 'photo' && item.photo);
  const sizes = Array.isArray(photoAttachment?.photo?.sizes) ? photoAttachment.photo.sizes : [];
  const best = sizes.filter(size => size?.url).sort((a, b) => (Number(b.width) * Number(b.height)) - (Number(a.width) * Number(a.height)))[0];
  if (!best?.url) throw new Error('VK не вернул ссылку на загруженную фотографию.');
  return best.url;
}

async function setCommunityAvatarFromMessage(message) {
  const sourceUrl = await getPhotoUrlFromMessage(message);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let imageResponse;
  try {
    imageResponse = await fetch(sourceUrl, { signal: controller.signal, redirect: 'follow' });
    if (!imageResponse.ok) throw new Error('Не удалось скачать фотографию из VK (HTTP ' + imageResponse.status + ').');
    const contentType = (imageResponse.headers.get('content-type') || '').split(';')[0].toLowerCase();
    if (!contentType.startsWith('image/')) throw new Error('Вложение не распознано как изображение.');
    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
    if (!imageBuffer.length || imageBuffer.length > 15 * 1024 * 1024) throw new Error('Размер изображения пустой или превышает 15 МБ.');

    const uploadInfo = await vkApi('photos.getOwnerPhotoUploadServer', { owner_id: '-' + communityId });
    if (!uploadInfo?.upload_url) throw new Error('VK не выдал адрес загрузки аватара.');
    const form = new FormData();
    form.append('photo', new Blob([imageBuffer], { type: contentType }), 'roadnote-avatar.' + (contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg'));
    const uploadResponse = await fetch(uploadInfo.upload_url, { method: 'POST', body: form });
    const uploadResult = await uploadResponse.json().catch(() => null);
    if (!uploadResponse.ok || !uploadResult?.server || !uploadResult?.hash || !uploadResult?.photo) {
      throw new Error('VK не принял изображение для аватара сообщества.');
    }
    await vkApi('photos.saveOwnerPhoto', {
      server: uploadResult.server,
      hash: uploadResult.hash,
      photo: uploadResult.photo
    });
  } finally {
    clearTimeout(timer);
  }
}

function getIncomingPhotoAttachment(message) {
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  for (const item of attachments) {
    const photo = item?.type === 'photo' ? item.photo : (item?.photo || item?.attachment?.photo);
    if (!photo || !photo.id || !photo.owner_id) continue;
    const accessKey = photo.access_key ? '_' + String(photo.access_key) : '';
    return 'photo' + String(photo.owner_id) + '_' + String(photo.id) + accessKey;
  }
  return '';
}

function callbackSecretMatches(received) {
  if (!callbackSecret || typeof received !== 'string') return false;
  const expectedBytes = Buffer.from(callbackSecret);
  const receivedBytes = Buffer.from(received);
  return expectedBytes.length === receivedBytes.length && crypto.timingSafeEqual(expectedBytes, receivedBytes);
}

function parseCallbackPayload(payload) {
  if (payload && typeof payload === 'object') return payload;
  if (typeof payload !== 'string' || !payload) return null;
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function answerAdminButton(event, message) {
  try {
    await vkApi('messages.sendMessageEventAnswer', {
      event_id: String(event.event_id || ''),
      user_id: String(event.user_id || ''),
      peer_id: String(event.peer_id || event.user_id || ''),
      event_data: JSON.stringify({ type: 'show_snackbar', text: String(message).slice(0, 200) })
    });
  } catch (error) {
    console.warn('[tariff button answer]', error?.message || error);
  }
}

function decideTariffRequest(requestId, decision) {
  const now = new Date();
  const nowIso = now.toISOString();
  const transaction = db.transaction(() => {
    const request = db.prepare('SELECT * FROM tariff_requests WHERE id = ?').get(requestId);
    if (!request || request.status !== 'awaiting_review') return { ok: false, request: request || null };

    const nextStatus = decision === 'approve' ? 'approved' : 'rejected';
    const marked = db.prepare(
      "UPDATE tariff_requests SET status = ?, updated_at = ?, completed_at = ? WHERE id = ? AND status = 'awaiting_review'"
    ).run(nextStatus, nowIso, nowIso, requestId);
    if (marked.changes !== 1) return { ok: false, request: request };

    let subscriptionUntil = null;
    if (decision === 'approve') {
      if (request.offer_kind === 'pack') {
        const grant = grantPack.run(Number(request.quantity), String(request.vk_id));
        if (grant.changes !== 1) throw new Error('Не удалось начислить пакет сканов: пользователь не найден.');
        recordScanCredit.run(
          String(request.vk_id),
          nowIso,
          Number(request.quantity),
          'purchase',
          'Покупка тарифа «' + request.offer_name + '», заявка №' + request.id
        );
      } else if (request.offer_kind === 'subscription') {
        const user = getUserEntitlements.get(String(request.vk_id));
        if (!user) throw new Error('Не удалось подключить подписку: пользователь не найден.');
        const currentExpiry = user.subscription_until && Date.parse(user.subscription_until) > now.getTime()
          ? new Date(user.subscription_until)
          : now;
        subscriptionUntil = addUtcMonths(currentExpiry, Number(request.quantity)).toISOString();
        const result = updateSubscription.run(subscriptionUntil, String(request.vk_id));
        if (result.changes !== 1) throw new Error('Не удалось сохранить срок подписки.');
      } else {
        throw new Error('У заявки неизвестный тип тарифа.');
      }
    }

    return { ok: true, request: { ...request, status: nextStatus }, subscriptionUntil };
  });
  return transaction();
}

async function handleIncomingCommunityMessage(message) {
  const userId = String(message?.from_id || '');
  if (!/^\d{1,20}$/.test(userId) || Number(userId) <= 0) return;
  if (String(message?.peer_id || userId) !== userId) return;

  if (adminVkId && userId === adminVkId) {
    const text = String(message?.text || '').trim().toLowerCase();
    const photoAttachment = getIncomingPhotoAttachment(message);
    const buttonPayload = (() => {
      try { return JSON.parse(String(message?.payload || '{}')); } catch { return {}; }
    })();
    if (text === 'обновить иконку' || buttonPayload.action === 'update_community_avatar') {
      avatarUploadAwaiting.add(userId);
      await sendAdminMenu('Пришли следующим сообщением фотографию — она станет аватаром сообщества и иконкой Roadnote в миниаппе.');
      return;
    }
    if (avatarUploadAwaiting.has(userId) && photoAttachment) {
      try {
        await setCommunityAvatarFromMessage(message);
        avatarUploadAwaiting.delete(userId);
        await sendAdminMenu('Готово! Аватар сообщества обновлён. Иконка на стартовой странице миниаппа будет загружать его автоматически.');
      } catch (error) {
        console.error('[Roadnote community avatar update]', error?.message || error);
        await sendAdminMenu('Не получилось обновить аватар: ' + String(error?.message || 'неизвестная ошибка').slice(0, 250) + '. Попробуй отправить фото ещё раз.');
      }
      return;
    }
    if (avatarUploadAwaiting.has(userId) && text) {
      await sendAdminMenu('Жду фотографию. Пришли её сообщением в этот диалог.');
      return;
    }
    if (!photoAttachment && (text === 'меню' || text === 'начать' || text === 'start')) {
      await sendAdminMenu();
      return;
    }
  }

  const active = db.prepare(
    "SELECT * FROM tariff_requests WHERE vk_id = ? AND status IN ('awaiting_payment','awaiting_review') ORDER BY id DESC LIMIT 1"
  ).get(userId);
  if (!active) return;

  const photoAttachment = getIncomingPhotoAttachment(message);
  if (active.status === 'awaiting_review') {
    if (photoAttachment) {
      try {
        await sendCommunityMessage(userId, 'Скриншот по этой заявке уже получен. Она ожидает проверки.');
      } catch (error) {
        console.warn('[tariff duplicate screenshot reply]', error?.message || error);
      }
    }
    return;
  }

  if (!photoAttachment) {
    if (String(message?.text || '').trim()) {
      try {
        await sendCommunityMessage(userId, 'Чтобы отправить заявку на проверку, пришли скриншот оплаты именно фотографией в этот диалог с Roadnote.');
      } catch (error) {
        console.warn('[tariff screenshot reminder]', error?.message || error);
      }
    }
    return;
  }

  const messageId = String(message?.id || message?.conversation_message_id || '');
  const nowIso = new Date().toISOString();
  const moved = db.prepare(
    "UPDATE tariff_requests SET status = 'awaiting_review', screenshot_attachment = ?, screenshot_message_id = ?, updated_at = ? " +
    "WHERE id = ? AND status = 'awaiting_payment'"
  ).run(photoAttachment, messageId, nowIso, Number(active.id));
  if (moved.changes !== 1) return;

  const user = db.prepare('SELECT first_name, last_name FROM users WHERE vk_id = ?').get(userId);
  const displayName = [user?.first_name, user?.last_name].filter(Boolean).join(' ').trim() || 'Пользователь VK';
  const adminText = [
    'Заявка на тариф №' + active.id,
    'Пользователь: ' + displayName + ' (VK ID ' + userId + ')',
    'Профиль: https://vk.com/id' + userId,
    'Тариф: ' + active.offer_name,
    'Стоимость: ' + formatRubles(active.price_rub),
    'Скриншот оплаты приложен. Подтверди начисление или отклони заявку.'
  ].join('\n');

  let adminMessageId = '';
  try {
    const response = await sendCommunityMessage(adminVkId, adminText, {
      attachment: photoAttachment,
    });
    adminMessageId = vkMessageId(response);
    if (!adminMessageId) throw new Error('VK не вернул ID сообщения с заявкой.');
  } catch (error) {
    console.error('[tariff admin notification]', error?.message || error);
    db.prepare(
      "UPDATE tariff_requests SET status = 'awaiting_payment', screenshot_attachment = NULL, screenshot_message_id = NULL, updated_at = ? " +
      "WHERE id = ? AND status = 'awaiting_review' AND screenshot_message_id = ?"
    ).run(new Date().toISOString(), Number(active.id), messageId);
    try {
      await sendCommunityMessage(userId, 'Не удалось передать скриншот администратору. Заявка сохранена — проверь, что сообщения Roadnote разрешены, и отправь скриншот ещё раз.');
    } catch (replyError) {
      console.warn('[tariff admin delivery failure reply]', replyError?.message || replyError);
    }
    sendLiveTariffState(userId);
    return;
  }

  const saved = db.prepare(
    "UPDATE tariff_requests SET admin_message_id = ?, updated_at = ? WHERE id = ? AND status = 'awaiting_review' AND screenshot_message_id = ?"
  ).run(adminMessageId, new Date().toISOString(), Number(active.id), messageId);
  if (saved.changes !== 1) {
    await deleteCommunityMessage(adminMessageId);
    return;
  }

  try {
    await sendCommunityMessage(userId, 'Скриншот получен и передан администратору. Заявка ожидает проверки.');
  } catch (error) {
    console.warn('[tariff screenshot confirmation]', error?.message || error);
  }
  sendLiveTariffState(userId, 'Скриншот получен. Заявка ожидает проверки.');
}

async function handleAdminMessageEvent(event) {
  const userId = String(event?.user_id || '');
  if (!adminVkId || userId !== adminVkId) {
    await answerAdminButton(event || {}, 'Действие доступно только администратору.');
    return;
  }
  const payload = parseCallbackPayload(event?.payload);
  const requestId = Number(payload?.request_id);
  const decision = payload?.action === 'approve_tariff' ? 'approve'
    : payload?.action === 'reject_tariff' ? 'reject'
    : '';
  if (!Number.isSafeInteger(requestId) || requestId < 1 || !decision) {
    await answerAdminButton(event, 'Не удалось распознать действие.');
    return;
  }

  let result;
  try {
    result = decideTariffRequest(requestId, decision);
  } catch (error) {
    console.error('[tariff decision]', error?.message || error);
    await answerAdminButton(event, 'Не удалось обработать заявку. Попробуй ещё раз.');
    return;
  }
  if (!result.ok) {
    await answerAdminButton(event, 'Заявка уже закрыта или заменена. Эти кнопки неактуальны.');
    return;
  }

  const request = result.request;
  await deleteCommunityMessage(request.admin_message_id);
  await deleteCommunityMessage(request.bot_message_id);

  let notice;
  if (decision === 'approve') {
    if (request.offer_kind === 'pack') {
      notice = 'Тариф «' + request.offer_name + '» подключён. Начислено ' + request.quantity + ' сканов.';
    } else {
      const until = result.subscriptionUntil
        ? new Date(result.subscriptionUntil).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' })
        : '';
      notice = 'Тариф «' + request.offer_name + '» подключён.' + (until ? ' Безлимит действует до ' + until + '.' : '');
    }
  } else {
    notice = 'Заявка на тариф «' + request.offer_name + '» отклонена. Тариф не начислен.';
  }

  try {
    await sendCommunityMessage(request.vk_id, notice);
  } catch (error) {
    console.error('[tariff decision user notification]', error?.message || error);
  }
  // Push both the request status and the updated balance to the open Mini App immediately.
  sendLiveEntitlement(request.vk_id);
  sendLiveTariffState(request.vk_id, notice);
  await answerAdminButton(event, decision === 'approve' ? 'Тариф начислен.' : 'Заявка отклонена.');
}


app.post('/api/tariffs/permission', async (req, res) => {
  let userId;
  let launchUserId = '';
  try {
    const parsed = parseLaunchParams(req.body?.launchParams);
    userId = parsed.userId;
    launchUserId = parsed.params.get('vk_user_id') || '';
    console.info('[tariff identity diagnostic]', JSON.stringify({
      endpoint: 'permission',
      launchUserId,
      verifiedUserId: userId,
      idsMatch: launchUserId === userId,
      appId: parsed.params.get('vk_app_id') || null
    }));
  } catch {
    return res.status(401).json({ error: 'Открой Roadnote внутри VK и попробуй ещё раз.' });
  }
  if (!communityToken) {
    return res.status(503).json({ error: 'Сообщения сообщества не настроены на сервере.' });
  }
  try {
    const result = await vkApi('messages.isMessagesFromGroupAllowed', {
      group_id: communityId,
      user_id: userId
    });
    const value = typeof result === 'object' && result !== null
      ? (result.is_allowed ?? result.allowed ?? result.result)
      : result;
    const allowed = Number(value) === 1 || value === true;
    console.info('[Roadnote permission API result]', JSON.stringify({
      userId,
      groupId: communityId,
      resultType: typeof result,
      resultKeys: result && typeof result === 'object' ? Object.keys(result) : [],
      is_allowed: result && typeof result === 'object' ? (result.is_allowed ?? null) : null,
      allowedField: result && typeof result === 'object' ? (result.allowed ?? null) : null,
      resultField: result && typeof result === 'object' ? (result.result ?? null) : null,
      scalarValue: typeof result === 'number' || typeof result === 'boolean' ? result : null,
      normalizedAllowed: allowed
    }));
    return res.json({ ok: true, allowed });
  } catch (error) {
    console.warn('[tariff permission check]', error?.message || error);
    return res.status(502).json({ error: 'Не удалось проверить разрешение VK.' });
  }
});

app.post('/api/tariffs/state', (req, res) => {
  try {
    const { userId } = parseLaunchParams(req.body?.launchParams);
    return res.json({ ok: true, ...getTariffState(userId) });
  } catch {
    return res.status(401).json({ error: 'Открой Roadnote внутри VK и попробуй ещё раз.' });
  }
});

app.post('/api/promocodes/apply', (req, res) => {
  let userId;
  try { ({ userId } = parseLaunchParams(req.body?.launchParams)); }
  catch { return res.status(401).json({ error: 'Не удалось подтвердить аккаунт VK. Перезапусти Mini App.' }); }
  const code = String(req.body?.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) return res.status(400).json({ error: 'Проверь код: допустимы латинские буквы, цифры, дефис и подчёркивание.' });
  const promo = db.prepare('SELECT * FROM promo_codes WHERE code = ? AND is_active = 1').get(code);
  const now = Date.now();
  if (!promo) return res.status(404).json({ error: 'Такой промокод не найден или уже отключён.' });
  if (promo.starts_at && Date.parse(promo.starts_at) > now) return res.status(400).json({ error: 'Срок действия этого промокода ещё не начался.' });
  if (promo.expires_at && Date.parse(promo.expires_at) < now) return res.status(400).json({ error: 'Срок действия этого промокода истёк.' });
  let offerIds;
  try { offerIds = JSON.parse(promo.offer_ids_json); } catch (_) { offerIds = []; }
  offerIds = Array.isArray(offerIds) ? offerIds.filter(id => Object.prototype.hasOwnProperty.call(tariffOffers, id)) : [];
  if (!offerIds.length) return res.status(409).json({ error: 'Промокод не привязан ни к одному доступному тарифу.' });
  const nowIso = new Date().toISOString();
  try {
    db.transaction(() => {
      const activeRequest = db.prepare("SELECT id, status, promo_application_id FROM tariff_requests WHERE vk_id = ? AND status IN ('awaiting_payment','awaiting_review') ORDER BY id DESC LIMIT 1").get(userId);
      if (activeRequest && activeRequest.status === 'awaiting_review') {
        const error = new Error('Сначала заверши текущую заявку на тариф или отмени её.'); error.statusCode = 409; throw error;
      }
      if (activeRequest && activeRequest.status === 'awaiting_payment') {
        db.prepare("UPDATE tariff_requests SET status = 'replaced', updated_at = ?, completed_at = ? WHERE id = ? AND status = 'awaiting_payment'").run(nowIso, nowIso, activeRequest.id);
        if (activeRequest.promo_application_id) db.prepare("UPDATE promo_code_applications SET tariff_request_id = NULL WHERE id = ? AND status = 'selected'").run(activeRequest.promo_application_id);
      }
      db.prepare("UPDATE promo_code_applications SET status = 'cancelled', tariff_request_id = NULL WHERE vk_id = ? AND status = 'selected'").run(userId);
      db.prepare("INSERT INTO promo_code_applications (vk_id, promo_code_id, promo_code, discount_percent, offer_ids_json, status, selected_at) VALUES (?, ?, ?, ?, ?, 'selected', ?)")
        .run(userId, Number(promo.id), promo.code, Number(promo.discount_percent), JSON.stringify(offerIds), nowIso);
    })();
  } catch (error) {
    return res.status(error.statusCode || 409).json({ error: error.message || 'Не удалось применить промокод.', ...getTariffState(userId) });
  }
  const state = getTariffState(userId);
  sendLiveTariffState(userId, 'Промокод ' + code + ' выбран. Скидка будет зафиксирована при успешной оплате подходящего тарифа.');
  return res.json({ ok: true, ...state, notice: 'Промокод ' + code + ' применён. Скидка будет зафиксирована после успешной оплаты.' });
});

app.post('/api/promocodes/remove', (req, res) => {
  let userId;
  try { ({ userId } = parseLaunchParams(req.body?.launchParams)); }
  catch { return res.status(401).json({ error: 'Не удалось подтвердить аккаунт VK. Перезапусти Mini App.' }); }
  const nowIso = new Date().toISOString();
  const active = db.prepare("SELECT id, tariff_request_id FROM promo_code_applications WHERE vk_id = ? AND status = 'selected' ORDER BY id DESC LIMIT 1").get(userId);
  if (!active) return res.json({ ok: true, ...getTariffState(userId), notice: 'Активного промокода нет.' });
  if (active.tariff_request_id) {
    const request = db.prepare("SELECT id, status FROM tariff_requests WHERE id = ? AND vk_id = ?").get(active.tariff_request_id, userId);
    if (request && request.status === 'awaiting_review') return res.status(409).json({ error: 'Промокод уже связан с заявкой на проверке. Сначала отмени заявку.' });
    if (request && request.status === 'awaiting_payment') {
      db.prepare("UPDATE tariff_requests SET status = 'replaced', updated_at = ?, completed_at = ? WHERE id = ? AND status = 'awaiting_payment'").run(nowIso, nowIso, request.id);
    }
  }
  db.prepare("UPDATE promo_code_applications SET status = 'cancelled', tariff_request_id = NULL WHERE id = ? AND status = 'selected'").run(active.id);
  const state = getTariffState(userId);
  sendLiveTariffState(userId, 'Промокод отменён.');
  return res.json({ ok: true, ...state, notice: 'Промокод отменён.' });
});

async function uploadTariffScreenshotToVk(userId, imageBuffer, mimeType) {
  if (!communityToken) throw new Error('VK_GROUP_TOKEN не настроен на сервере.');
  const uploadServer = await vkApi('photos.getMessagesUploadServer', { peer_id: String(userId) });
  if (!uploadServer?.upload_url) throw new Error('VK не вернул адрес загрузки фотографии.');
  const form = new FormData();
  const extension = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
  form.append('photo', new Blob([imageBuffer], { type: mimeType }), 'payment.' + extension);
  const uploadResponse = await fetch(uploadServer.upload_url, { method: 'POST', body: form });
  const uploadData = await uploadResponse.json().catch(() => null);
  if (!uploadResponse.ok || !uploadData?.photo || !uploadData?.server || !uploadData?.hash) {
    throw new Error('VK не принял скриншот оплаты.');
  }
  const saved = await vkApi('photos.saveMessagesPhoto', {
    photo: uploadData.photo,
    server: uploadData.server,
    hash: uploadData.hash
  });
  const photo = Array.isArray(saved) ? saved[0] : saved;
  if (!photo?.owner_id || !photo?.id) throw new Error('VK не сохранил скриншот оплаты.');
  return 'photo' + String(photo.owner_id) + '_' + String(photo.id) + (photo.access_key ? '_' + String(photo.access_key) : '');
}

app.post('/api/tariffs/request', async (req, res) => {
  let userId;
  try {
    ({ userId } = parseLaunchParams(req.body?.launchParams));
  } catch {
    return res.status(401).json({ error: 'Не удалось подтвердить аккаунт VK. Перезапусти Mini App.' });
  }
  const offerId = String(req.body?.offerId || '');
  const offer = tariffOffers[offerId];
  if (!offer) return res.status(400).json({ error: 'Выбран неизвестный тариф.' });
  const user = db.prepare('SELECT vk_id FROM users WHERE vk_id = ?').get(userId);
  if (!user) return res.status(409).json({ error: 'Сначала дождись загрузки баланса и попробуй снова.' });

  const stateBefore = getTariffState(userId);
  const discounted = !stateBefore.hasPurchased;
  const basePriceRub = discounted ? offer.promoPrice : offer.regularPrice;
  const selectedPromo = stateBefore.activePromoCode && stateBefore.activePromoCode.offerIds.includes(offerId)
    ? stateBefore.activePromoCode : null;
  const priceRub = selectedPromo
    ? Math.max(1, Math.round(basePriceRub * (100 - selectedPromo.discountPercent) / 100))
    : basePriceRub;
  const promoDiscountRub = selectedPromo ? Math.max(0, basePriceRub - priceRub) : 0;
  const nowIso = new Date().toISOString();
  let requestId;
  let replacedRequest = null;
  try {
    const replaceAndCreate = db.transaction(() => {
      replacedRequest = db.prepare(
        "SELECT id, status, screenshot_attachment, admin_message_id, bot_message_id, promo_application_id FROM tariff_requests WHERE vk_id = ? AND status = 'awaiting_payment' ORDER BY id DESC LIMIT 1"
      ).get(userId) || null;

      // Only the unpaid request is replaceable; screenshot-submitted requests remain untouched.
      if (replacedRequest) {
        const replaced = db.prepare(
          "UPDATE tariff_requests SET status = 'replaced', updated_at = ?, completed_at = ? " +
          "WHERE id = ? AND vk_id = ? AND status IN ('awaiting_payment','awaiting_review')"
        ).run(nowIso, nowIso, replacedRequest.id, userId);
        if (replaced.changes !== 1) throw new Error('Активная заявка уже изменилась. Обнови страницу и попробуй ещё раз.');
        if (replacedRequest.promo_application_id) db.prepare("UPDATE promo_code_applications SET status = CASE WHEN EXISTS (SELECT 1 FROM promo_codes WHERE id = promo_code_id AND is_active = 1) THEN status ELSE 'cancelled' END, tariff_request_id = NULL WHERE id = ? AND status = 'selected'").run(replacedRequest.promo_application_id);
      }

      const created = db.prepare(
        "INSERT INTO tariff_requests (vk_id, offer_id, offer_name, offer_kind, quantity, price_rub, regular_price_rub, is_discounted, promo_application_id, promo_code_id, promo_code, promo_discount_percent, promo_discount_rub, status, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_payment', ?, ?)"
      ).run(
        userId, offer.id, offer.name, offer.kind, offer.quantity, priceRub, offer.regularPrice,
        discounted ? 1 : 0, selectedPromo ? selectedPromo.applicationId : null,
        selectedPromo ? selectedPromo.promoCodeId : null, selectedPromo ? selectedPromo.code : null,
        selectedPromo ? selectedPromo.discountPercent : null, selectedPromo ? promoDiscountRub : null, nowIso, nowIso
      );
      requestId = Number(created.lastInsertRowid);
      db.prepare('UPDATE tariff_requests SET payment_label = ? WHERE id = ?').run('roadnote-request-' + requestId, requestId);
      if (selectedPromo) db.prepare("UPDATE promo_code_applications SET tariff_request_id = ? WHERE id = ? AND vk_id = ? AND status = 'selected'").run(requestId, selectedPromo.applicationId, userId);
    })();
  } catch (error) {
    if (error?.lockedByReview) {
      return res.status(409).json({
        error: error.message,
        lockedByReview: true,
        ...getTariffState(userId)
      });
    }
    console.error('[tariff request create/switch]', error?.message || error);
    return res.status(409).json({ error: 'Не удалось переключить заявку. Обнови страницу и попробуй ещё раз.', ...getTariffState(userId) });
  }

  if (replacedRequest?.admin_message_id) await deleteCommunityMessage(replacedRequest.admin_message_id);
  if (replacedRequest?.bot_message_id) await deleteCommunityMessage(replacedRequest.bot_message_id);
  const notice = replacedRequest
    ? ''
    : 'Заявка создана. Открой её в Mini App и прикрепи скриншот оплаты.';
  sendLiveTariffState(userId, notice);
  return res.json({ ok: true, requestId, ...getTariffState(userId) });
});

app.post('/api/tariffs/cancel', async (req, res) => {
  let userId;
  try {
    ({ userId } = parseLaunchParams(req.body?.launchParams));
  } catch {
    return res.status(401).json({ error: 'Не удалось подтвердить аккаунт VK. Перезапусти Mini App.' });
  }
  const requestId = Number(req.body?.requestId);
  if (!Number.isSafeInteger(requestId) || requestId < 1) {
    return res.status(400).json({ error: 'Не удалось определить заявку.' });
  }
  const request = db.prepare(
    "SELECT admin_message_id, bot_message_id, status, screenshot_attachment FROM tariff_requests WHERE id = ? AND vk_id = ? AND status IN ('awaiting_payment','awaiting_review')"
  ).get(requestId, userId);
  if (!request) {
    return res.status(409).json({ error: 'Эта заявка уже закрыта или заменена.', ...getTariffState(userId) });
  }
  if (request.status === 'awaiting_review' || request.screenshot_attachment) {
    return res.status(409).json({ error: 'Эту заявку нельзя отменить: скриншот оплаты уже отправлен, заявка ожидает проверки.', ...getTariffState(userId) });
  }
  const nowIso = new Date().toISOString();
  const result = db.prepare(
    "UPDATE tariff_requests SET status = 'replaced', updated_at = ?, completed_at = ? " +
    "WHERE id = ? AND vk_id = ? AND status = 'awaiting_payment' AND screenshot_attachment IS NULL"
  ).run(nowIso, nowIso, requestId, userId);
  if (result.changes !== 1) {
    return res.status(409).json({ error: 'Эта заявка уже закрыта или заменена.', ...getTariffState(userId) });
  }
  if (request.admin_message_id) await deleteCommunityMessage(request.admin_message_id);
  if (request.bot_message_id) await deleteCommunityMessage(request.bot_message_id);
  sendLiveTariffState(userId, 'Активная заявка отозвана.');
  return res.json({ ok: true, ...getTariffState(userId) });
});

app.post('/api/tariffs/screenshot', async (req, res) => {
  let userId;
  try {
    ({ userId } = parseLaunchParams(req.body?.launchParams));
  } catch {
    return res.status(401).json({ error: 'Не удалось подтвердить аккаунт VK. Перезапусти Mini App.' });
  }
  const requestId = Number(req.body?.requestId);
  const mimeType = String(req.body?.mimeType || '');
  const imageData = String(req.body?.imageData || '');
  if (!Number.isSafeInteger(requestId) || requestId < 1) {
    return res.status(400).json({ error: 'Не удалось определить заявку.' });
  }
  if (!['image/jpeg','image/png','image/webp'].includes(mimeType)) {
    return res.status(400).json({ error: 'Прикрепи скриншот в формате JPG, PNG или WebP.' });
  }
  const base64 = imageData.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
  if (!base64 || base64.length > 9500000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    return res.status(413).json({ error: 'Изображение пустое или слишком большое. Выбери скриншот до 6 МБ.' });
  }
  const imageBuffer = Buffer.from(base64, 'base64');
  if (!imageBuffer.length || imageBuffer.length > 6 * 1024 * 1024) {
    return res.status(413).json({ error: 'Выбери скриншот размером не больше 6 МБ.' });
  }
  const request = db.prepare(
    "SELECT * FROM tariff_requests WHERE id = ? AND vk_id = ? AND status IN ('awaiting_payment','awaiting_review')"
  ).get(requestId, userId);
  if (!request) return res.status(409).json({ error: 'Активная заявка не найдена. Обнови список заявок.' });
  if (request.status === 'awaiting_review' && request.screenshot_attachment) {
    return res.status(409).json({ error: 'Скриншот уже отправлен. Заявка ожидает проверки.', ...getTariffState(userId) });
  }
  if (!adminVkId) return res.status(503).json({ error: 'На сервере не настроен администратор. Скриншот пока не отправлен.' });

  let attachment;
  try {
    attachment = await uploadTariffScreenshotToVk(userId, imageBuffer, mimeType);
  } catch (error) {
    console.error('[tariff screenshot upload]', error?.message || error);
    return res.status(502).json({ error: 'Не удалось загрузить скриншот в VK. Попробуй отправить его ещё раз.' });
  }

  const nowIso = new Date().toISOString();
  const updated = db.prepare(
    "UPDATE tariff_requests SET status = 'awaiting_review', screenshot_attachment = ?, screenshot_message_id = 'miniapp', updated_at = ? " +
    "WHERE id = ? AND vk_id = ? AND status = 'awaiting_payment'"
  ).run(attachment, nowIso, requestId, userId);
  if (updated.changes !== 1) {
    return res.status(409).json({ error: 'Статус заявки изменился. Обнови блок заявок.', ...getTariffState(userId) });
  }

  const user = db.prepare('SELECT first_name, last_name FROM users WHERE vk_id = ?').get(userId);
  const displayName = [user?.first_name, user?.last_name].filter(Boolean).join(' ').trim() || 'Пользователь VK';
  const adminText = [
    'Заявка на тариф №' + requestId,
    'Пользователь: ' + displayName + ' (VK ID ' + userId + ')',
    'Профиль: https://vk.com/id' + userId,
    'Тариф: ' + request.offer_name,
    'Стоимость: ' + formatRubles(request.price_rub),
    'Скриншот оплаты приложен из Mini App. Подтверди начисление или отклони заявку.'
  ].join('\n');

  let adminMessageId = '';
  try {
    const response = await sendCommunityMessage(adminVkId, adminText, {
      attachment,
    });
    adminMessageId = vkMessageId(response);
    if (!adminMessageId) throw new Error('VK не вернул ID сообщения с заявкой.');
  } catch (error) {
    console.error('[tariff admin notification]', error?.message || error);
    db.prepare(
      "UPDATE tariff_requests SET status = 'awaiting_payment', screenshot_attachment = NULL, screenshot_message_id = NULL, updated_at = ? " +
      "WHERE id = ? AND status = 'awaiting_review'"
    ).run(new Date().toISOString(), requestId);
    return res.status(502).json({ error: 'Скриншот загружен, но не удалось передать заявку администратору. Попробуй отправить ещё раз.', ...getTariffState(userId) });
  }

  db.prepare(
    "UPDATE tariff_requests SET admin_message_id = ?, updated_at = ? WHERE id = ? AND status = 'awaiting_review'"
  ).run(adminMessageId, new Date().toISOString(), requestId);
  sendLiveTariffState(userId, 'Скриншот получен. Заявка ожидает проверки.');
  return res.json({ ok: true, ...getTariffState(userId) });
});

app.post('/api/vk/callback', (req, res) => {
  const event = req.body || {};
  const groupMatches = String(event.group_id || '') === communityId;
  const secretMatches = callbackSecretMatches(event.secret);
  if (!groupMatches || !secretMatches) {
    console.warn('[VK callback rejected]', JSON.stringify({
      type: event.type || null,
      groupMatches,
      secretMatches
    }));
    return res.status(403).send('forbidden');
  }
  console.info('[VK callback received]', JSON.stringify({
    type: event.type || null,
    groupMatches,
    secretMatches
  }));
  if (event.type === 'confirmation') {
    if (!callbackConfirmation) return res.status(503).send('VK_CALLBACK_CONFIRMATION is not configured');
    return res.type('text/plain').send(callbackConfirmation);
  }

  res.status(200).type('text/plain').send('ok');
  if (event.type === 'message_allow') {
    const permissionEvent = event.object || {};
    const allowedUserId = String(permissionEvent.user_id || '');
    console.info('[VK community message permission granted]', JSON.stringify({
      user_id: permissionEvent.user_id || null,
      group_id: event.group_id || null,
      key: permissionEvent.key || null
    }));
    if (adminVkId && allowedUserId === adminVkId) {
      Promise.resolve().then(() => sendAdminMenu('Меню администратора Roadnote готово.'))
        .catch(error => console.error('[Roadnote admin menu]', error?.message || error));
    }
  } else if (event.type === 'message_deny') {
    const permissionEvent = event.object || {};
    console.warn('[VK community message permission denied]', JSON.stringify({
      user_id: permissionEvent.user_id || null
    }));
  } else if (event.type === 'message_new') {
    const message = event.object?.message || event.object;
    Promise.resolve().then(() => handleIncomingCommunityMessage(message))
      .catch(error => console.error('[VK message_new tariff handler]', error?.message || error));
  }
});


app.post('/api/yoomoney/notification', (req, res) => {
  if (!yoomoneyNotificationSecret) {
    console.error('[YooMoney notification] YOOMONEY_NOTIFICATION_SECRET is not configured');
    return res.status(503).send('not configured');
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const receivedSign = String(body.sign || '');
  if (!receivedSign || !/^[a-f0-9]{64}$/i.test(receivedSign)) return res.status(400).send('invalid signature');
  const rfc3986 = value => encodeURIComponent(String(value == null ? '' : value)).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
  const canonical = Object.keys(body).filter(key => key !== 'sign').sort()
    .map(key => rfc3986(key) + '=' + rfc3986(body[key])).join('&');
  const expectedSign = crypto.createHmac('sha256', yoomoneyNotificationSecret).update(canonical, 'utf8').digest('hex');
  const receivedBytes = Buffer.from(receivedSign.toLowerCase(), 'hex');
  const expectedBytes = Buffer.from(expectedSign, 'hex');
  if (receivedBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(receivedBytes, expectedBytes)) {
    console.warn('[YooMoney notification] signature mismatch');
    return res.status(403).send('invalid signature');
  }

  // YooMoney's settings-page test uses a synthetic operation. Acknowledge it
  // after validating its signature, without recording it as a real payment or
  // notifying the administrator about a payment that needs review.
  const testNotification = String(body.test_notification || '').toLowerCase() === 'true' ||
    (String(body.operation_id || '').trim() === 'test-notification' && !String(body.label || '').trim());
  if (testNotification) {
    console.info('[YooMoney notification] test notification accepted');
    return res.status(200).send('ok');
  }

  const operationId = String(body.operation_id || '').trim();
  const label = String(body.label || '').trim();
  const amount = Number(body.amount); // Amount credited to the wallet after YooMoney's fee.
  const withdrawAmount = Number(body.withdraw_amount); // Amount actually charged to the buyer.
  const currency = String(body.currency || '');
  const notificationType = String(body.notification_type || '');
  const sender = String(body.sender || '');
  const unaccepted = String(body.unaccepted || '').toLowerCase() === 'true';
  if (!operationId || operationId.length > 128 || !Number.isFinite(amount) || amount <= 0) return res.status(400).send('invalid operation');
  const labelMatch = /^roadnote-request-(\d+)$/.exec(label);
  const requestId = labelMatch ? Number(labelMatch[1]) : null;
  const nowIso = new Date().toISOString();
  let outcome;
  try {
    outcome = db.transaction(() => {
      const previous = db.prepare('SELECT state FROM yoomoney_operations WHERE operation_id = ?').get(operationId);
      // Already credited operations are idempotent. A prior needs_review operation
      // must be re-evaluated when YooMoney retries its notification after a fix.
      if (previous?.state === 'credited') return { duplicate: true, state: previous.state, userId: null };
      const request = requestId ? db.prepare('SELECT * FROM tariff_requests WHERE id = ?').get(requestId) : null;
      // Compare the buyer's charged amount, not the net amount received after YooMoney's fee.
      const exactAmount = request && Number.isFinite(withdrawAmount) &&
        Math.round(withdrawAmount * 100) === Number(request.price_rub) * 100;
      const acceptedType = notificationType === 'p2p-incoming' || notificationType === 'card-incoming';
      const canCredit = Boolean(request && request.status === 'awaiting_payment' && exactAmount &&
        currency === '643' && !unaccepted && acceptedType && request.vk_id);
      const state = canCredit ? 'credited' : 'needs_review';
      if (canCredit) {
        const marked = db.prepare(
          "UPDATE tariff_requests SET status = 'approved', payment_operation_id = ?, payment_confirmed_at = ?, updated_at = ?, completed_at = ? WHERE id = ? AND status = 'awaiting_payment'"
        ).run(operationId, nowIso, nowIso, nowIso, requestId);
        if (marked.changes !== 1) throw new Error('Purchase state changed during YooMoney processing');
        if (request.promo_application_id) {
          db.prepare("UPDATE promo_code_applications SET status = 'used', used_at = ?, tariff_request_id = ? WHERE id = ? AND vk_id = ? AND status = 'selected'")
            .run(nowIso, requestId, Number(request.promo_application_id), String(request.vk_id));
        }
        if (request.offer_kind === 'pack') {
          const grant = grantPack.run(Number(request.quantity), String(request.vk_id));
          if (grant.changes !== 1) throw new Error('Purchase user not found');
          recordScanCredit.run(String(request.vk_id), nowIso, Number(request.quantity), 'purchase',
            'Покупка «' + request.offer_name + '», платёж ЮMoney ' + operationId);
        } else if (request.offer_kind === 'subscription') {
          const user = getUserEntitlements.get(String(request.vk_id));
          if (!user) throw new Error('Subscription user not found');
          const currentExpiry = user.subscription_until && Date.parse(user.subscription_until) > Date.now()
            ? new Date(user.subscription_until) : new Date();
          const until = addUtcMonths(currentExpiry, Number(request.quantity)).toISOString();
          const updated = updateSubscription.run(until, String(request.vk_id));
          if (updated.changes !== 1) throw new Error('Could not extend subscription');
        } else {
          throw new Error('Unknown purchase type');
        }
      }
      db.prepare(
        'INSERT INTO yoomoney_operations (operation_id, request_id, label, amount_rub, currency, notification_type, sender, state, payload_json, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(operation_id) DO UPDATE SET request_id = excluded.request_id, label = excluded.label, amount_rub = excluded.amount_rub, currency = excluded.currency, notification_type = excluded.notification_type, sender = excluded.sender, state = excluded.state, payload_json = excluded.payload_json, received_at = excluded.received_at'
      ).run(operationId, requestId, label, amount, currency, notificationType, sender, state, JSON.stringify(body), nowIso);
      return { duplicate: false, state, userId: request?.vk_id || null, requestId };
    })();
  } catch (error) {
    console.error('[YooMoney notification processing]', error?.message || error);
    return res.status(500).send('processing failed');
  }
  if (outcome.duplicate) return res.status(200).send('ok');
  if (outcome.state === 'credited' && outcome.userId) {
    // Update the buyer's open Mini App session silently; never send a VK message to the buyer.
    sendLiveEntitlement(outcome.userId);
    sendLiveTariffState(outcome.userId);
    const buyer = db.prepare('SELECT first_name, last_name FROM users WHERE vk_id = ?').get(outcome.userId);
    const buyerName = [buyer?.first_name, buyer?.last_name].filter(Boolean).join(' ').trim() || 'Пользователь VK';
    const purchasedOffer = requestId ? db.prepare('SELECT offer_name FROM tariff_requests WHERE id = ?').get(requestId) : null;
    const adminText = [
      'Новая покупка Roadnote',
      'Пользователь: ' + buyerName + ' (VK ID ' + outcome.userId + ')',
      'Профиль: https://vk.com/id' + outcome.userId,
      'Тариф: ' + (purchasedOffer?.offer_name || 'неизвестен'),
      ...(requestId ? (() => { const paidRequest = db.prepare('SELECT promo_code, promo_discount_percent, promo_discount_rub FROM tariff_requests WHERE id = ?').get(requestId); return paidRequest?.promo_code ? ['Промокод: ' + paidRequest.promo_code, 'Скидка промокода: ' + Number(paidRequest.promo_discount_percent || 0) + '% (' + formatRubles(paidRequest.promo_discount_rub || 0) + ')'] : []; })() : []),
      'Стоимость: ' + formatRubles(withdrawAmount),
      'Получено после комиссии: ' + formatRubles(amount),
      'Операция ЮMoney: ' + operationId
    ].join('\n');
    if (adminVkId) Promise.resolve().then(() => sendCommunityMessage(adminVkId, adminText))
      .catch(error => console.warn('[YooMoney admin purchase notice]', error?.message || error));
  } else {
    console.warn('[YooMoney payment needs review]', JSON.stringify({
      operationId, requestId, label, amount, withdrawAmount, currency, notificationType, unaccepted
    }));
    if (adminVkId) Promise.resolve().then(() => sendCommunityMessage(adminVkId,
      'Платёж ЮMoney требует проверки.\nОперация: ' + operationId + '\nМетка: ' + (label || 'не указана') +
      '\nСписано с покупателя: ' + (Number.isFinite(withdrawAmount) ? withdrawAmount : 'неизвестно') + ' RUB' +
      '\nЗачислено: ' + amount + ' RUB\nПричина: тариф не найден, сумма/валюта не совпала или платёж не принят.'))
      .catch(error => console.warn('[YooMoney admin notice]', error?.message || error));
  }
  return res.status(200).send('ok');
});

app.get('/api/community/avatar', async (_req, res) => {
  try {
    const groups = await vkApi('groups.getById', { group_ids: communityId });
    const avatarUrl = Array.isArray(groups) ? groups[0]?.photo_200 || groups[0]?.photo_100 : '';
    if (!avatarUrl || !/^https:\/\//i.test(avatarUrl)) {
      return res.status(502).send('Community avatar unavailable');
    }
    res.setHeader('Cache-Control', 'public, max-age=900');
    return res.redirect(302, avatarUrl);
  } catch (error) {
    console.warn('[Roadnote community avatar]', error?.message || error);
    return res.status(502).send('Community avatar unavailable');
  }
});
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
  const insertedUser = ensureUserForScan.run(userId, now, now);
  if (insertedUser.changes === 1) {
    recordScanCredit.run(userId, now, 3, 'welcome', 'Приветственные сканы');
  }
  ensureDailyScan(userId);
  const balanceRow = getUserScanBalance.get(userId);
  const balanceBefore = balanceRow?.scan_balance === null || balanceRow?.scan_balance === undefined
    ? 0
    : Number(balanceRow.scan_balance);
  const subscriptionActive = Boolean(balanceRow?.subscription_until && Date.parse(balanceRow.subscription_until) > Date.now());
  const hasUnlimited = Number(balanceRow?.unlimited || 0) === 1 || subscriptionActive;
  const dayKey = yekaterinburgDayKey();

  if (!hasUnlimited && (!Number.isSafeInteger(balanceBefore) || balanceBefore <= 0)) {
    return res.status(402).json({
      ok: false,
      code: 'SCAN_BALANCE_EMPTY',
      scanBalance: 0,
      error: 'Бесплатный скан на сегодня уже использован. Пополните баланс или возвращайтесь завтра.'
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
    // Re-read entitlements after the upstream request: another tab or request
    // may have consumed a scan while this QR was being resolved.
    const currentBeforeCharge = getUserScanBalance.get(userId);
    const currentSubscriptionActive = Boolean(
      currentBeforeCharge?.subscription_until &&
      Date.parse(currentBeforeCharge.subscription_until) > Date.now()
    );
    const currentUnlimited = Number(currentBeforeCharge?.unlimited || 0) === 1 || currentSubscriptionActive;

    // Paid/package scans are consumed first. The daily scan is separate and
    // only consumed when the paid balance is empty. Charge only after valid data.
    if (!currentUnlimited) {
      const currentPaidBalance = Number(currentBeforeCharge?.scan_balance || 0);
      if (currentPaidBalance > 0) {
        const spent = spendUserScan.run(userId);
        if (spent.changes !== 1) {
          return res.status(402).json({
            ok: false,
            code: 'SCAN_BALANCE_EMPTY',
            scanBalance: getDisplayedScanBalance(getUserScanBalance.get(userId)),
            error: 'Баланс сканов изменился. Повторите попытку.'
          });
        }
      } else {
        return res.status(402).json({
          ok: false,
          code: 'SCAN_BALANCE_EMPTY',
          scanBalance: getDisplayedScanBalance(getUserScanBalance.get(userId)),
          error: 'Бесплатный скан на сегодня уже использован. Пополните баланс или возвращайтесь завтра.'
        });
      }
      ensureDailyScan(userId);
      sendLiveEntitlement(userId);
    }
    const currentEntitlement = getUserEntitlements.get(userId);
    const scanBalance = getDisplayedScanBalance(currentEntitlement);

    const scannedAt = new Date().toISOString();
    db.prepare('UPDATE users SET last_scan_at = ?, last_transport_number = ? WHERE vk_id = ?')
      .run(scannedAt, String(data.vehicleNumber || '').trim() || null, userId);
    let referralRewarded = false;
    db.transaction(() => {
      recordScan.run(
        userId, scannedAt, paytagid, String(data.transportType || ''),
        String(data.routeNumber || ''), String(data.vehicleNumber || ''),
        Number.isFinite(data.price) ? data.price : null
      );

      const referral = getReferralForInvitee.get(userId);
      if (referral && !referral.rewarded_at && getUserExists.get(referral.inviter_vk_id)) {
        const granted = grantReferralScans.run(referral.inviter_vk_id);
        if (granted.changes === 1) {
          const marked = rewardReferralOnce.run(scannedAt, userId);
          if (marked.changes === 1) {
            recordScanCredit.run(referral.inviter_vk_id, scannedAt, 3, 'referral', 'Бонус за приглашённого пользователя ' + userId);
            referralRewarded = true;
          }
        }
      }
    })();
    if (referralRewarded) sendLiveEntitlement(getReferralForInvitee.get(userId)?.inviter_vk_id);

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
      const existed = Boolean(db.prepare('SELECT 1 FROM users WHERE vk_id = ?').get(userId));
      const referralCode = String(req.body?.referralCode || '').trim();
      db.transaction(() => {
        upsertUser.run({
          vk_id: userId,
          first_name: cleanText(profile.first_name),
          last_name: cleanText(profile.last_name),
          photo_url: cleanText(profile.photo_url, 1000),
          now
        });
        if (!existed) {
          recordScanCredit.run(userId, now, 3, 'welcome', 'Приветственные сканы');
          if (/^\\d{1,20}$/.test(referralCode) && referralCode !== userId && getUserExists.get(referralCode)) {
            insertReferral.run(userId, referralCode, now);
          }
        }
      })();
    }
    ensureDailyScan(userId);
    const balanceRow = getUserScanBalance.get(userId);
    const scanBalance = getDisplayedScanBalance(balanceRow);
    const subscriptionUntil = balanceRow?.subscription_until || null;
    const subscriptionActive = Boolean(subscriptionUntil && Date.parse(subscriptionUntil) > Date.now());
    const unlimited = Number(balanceRow?.unlimited || 0) === 1;
    const scanCount = Number(db.prepare('SELECT COUNT(*) AS count FROM scan_history WHERE vk_id = ?').get(userId)?.count || 0);
    return res.json({
      ok: true,
      ...getTariffState(userId),
      isAdmin: userId === adminVkId,
      scanBalance,
      scanCount,
      subscriptionUntil,
      subscriptionActive,
      unlimited,
      referralLink: 'https://vk.com/app' + appId + '?ref=' + encodeURIComponent(userId),
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

app.get('/api/admin/promocodes', requireAdmin, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const now = Date.now();
  const promos = db.prepare(
    "SELECT p.*, (SELECT COUNT(*) FROM promo_code_applications a WHERE a.promo_code_id = p.id AND a.status = 'used') AS redemptions, " +
    "(SELECT COUNT(*) FROM promo_code_applications a WHERE a.promo_code_id = p.id AND a.status = 'selected') AS selected_count " +
    "FROM promo_codes p WHERE p.is_active = 1 ORDER BY p.created_at DESC, p.id DESC"
  ).all().map(promo => {
    let offerIds = [];
    try { offerIds = JSON.parse(promo.offer_ids_json); } catch (_) {}
    return {
      id: Number(promo.id), code: promo.code, discountPercent: Number(promo.discount_percent),
      offerIds: Array.isArray(offerIds) ? offerIds : [], startsAt: promo.starts_at || null,
      expiresAt: promo.expires_at || null, createdAt: promo.created_at,
      redemptions: Number(promo.redemptions || 0), selectedCount: Number(promo.selected_count || 0),
      status: (promo.starts_at && Date.parse(promo.starts_at) > now) ? 'scheduled' : (promo.expires_at && Date.parse(promo.expires_at) < now ? 'expired' : 'active')
    };
  });
  return res.json({ promos, offers: Object.values(tariffOffers).map(offer => ({ id: offer.id, name: offer.name, kind: offer.kind })) });
});

app.post('/api/admin/promocodes', requireAdmin, (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  const discountPercent = Number(req.body?.discountPercent);
  const offerIds = Array.isArray(req.body?.offerIds) ? [...new Set(req.body.offerIds.map(String))] : [];
  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) return res.status(400).json({ error: 'Код: 3–32 символа, латинские буквы, цифры, дефис или подчёркивание.' });
  if (!Number.isInteger(discountPercent) || discountPercent < 1 || discountPercent > 99) return res.status(400).json({ error: 'Скидка должна быть от 1 до 99%.' });
  if (!offerIds.length || offerIds.some(id => !Object.prototype.hasOwnProperty.call(tariffOffers, id))) return res.status(400).json({ error: 'Выбери хотя бы один тариф.' });
  const parseDate = (value, label) => {
    if (value == null || value === '') return null;
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error('Некорректная дата: ' + label + '.');
    return date.toISOString();
  };
  let startsAt, expiresAt;
  try { startsAt = parseDate(req.body?.startsAt, 'начала'); expiresAt = parseDate(req.body?.expiresAt, 'окончания'); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  if (startsAt && expiresAt && Date.parse(startsAt) >= Date.parse(expiresAt)) return res.status(400).json({ error: 'Окончание срока должно быть позже начала.' });
  const nowIso = new Date().toISOString();
  try {
    const result = db.prepare('INSERT INTO promo_codes (code, discount_percent, offer_ids_json, starts_at, expires_at, is_active, created_at, created_by) VALUES (?, ?, ?, ?, ?, 1, ?, ?)')
      .run(code, discountPercent, JSON.stringify(offerIds), startsAt, expiresAt, nowIso, req.vkUserId);
    return res.status(201).json({ ok: true, id: Number(result.lastInsertRowid) });
  } catch (error) {
    if (String(error?.code || '').includes('CONSTRAINT') || /UNIQUE/i.test(String(error?.message || ''))) return res.status(409).json({ error: 'Промокод с таким названием уже существует.' });
    console.error('[admin promo create]', error?.message || error);
    return res.status(500).json({ error: 'Не удалось создать промокод.' });
  }
});

app.delete('/api/admin/promocodes/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Некорректный ID промокода.' });
  const promo = db.prepare('SELECT id FROM promo_codes WHERE id = ? AND is_active = 1').get(id);
  if (!promo) return res.status(404).json({ error: 'Промокод уже удалён или не найден.' });
  const nowIso = new Date().toISOString();
  db.transaction(() => {
    db.prepare("UPDATE promo_codes SET is_active = 0, code = 'DELETED_' || id || '_' || code WHERE id = ?").run(id);
    db.prepare("UPDATE promo_code_applications SET status = 'cancelled', tariff_request_id = NULL WHERE promo_code_id = ? AND status = 'selected' AND tariff_request_id IS NULL").run(id);
    // Any already-created payment keeps its snapshotted price and code; only new uses are disabled.
    db.prepare("UPDATE promo_code_applications SET status = 'cancelled', tariff_request_id = NULL WHERE promo_code_id = ? AND status = 'selected' AND tariff_request_id IN (SELECT id FROM tariff_requests WHERE status = 'replaced')").run(id);
  })();
  return res.json({ ok: true });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const now = Date.now();
  const users = listUsers.all().map(user => ({
    ...user,
    unlimited: Number(user.unlimited || 0) === 1,
    subscriptionActive: Boolean(user.subscription_until && Date.parse(user.subscription_until) > now)
  }));
  res.json({ users, total: userCount.get().count, adminUserId: req.vkUserId });
});

app.get('/api/admin/users/:vkId/scans', requireAdmin, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const vkId = String(req.params.vkId || '');
  if (!/^[0-9]+$/.test(vkId)) return res.status(400).json({ error: 'Некорректный VK ID.' });
  if (!db.prepare('SELECT 1 FROM users WHERE vk_id = ?').get(vkId)) {
    return res.status(404).json({ error: 'Пользователь не найден.' });
  }
  const scans = listUserScans.all(vkId).map(scan => ({
    ...scan,
    price: scan.price === null ? null : Number(scan.price)
  }));
  return res.json({ scans, total: scans.length });
});

app.get('/api/admin/users/:vkId/credits', requireAdmin, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const vkId = String(req.params.vkId || '');
  if (!/^[0-9]+$/.test(vkId)) return res.status(400).json({ error: 'Некорректный VK ID.' });
  if (!db.prepare('SELECT 1 FROM users WHERE vk_id = ?').get(vkId)) {
    return res.status(404).json({ error: 'Пользователь не найден.' });
  }
  const credits = listUserCredits.all(vkId);
  return res.json({ credits, total: credits.length });
});

app.post('/api/admin/users/:vkId/entitlement', requireAdmin, (req, res) => {
  const vkId = String(req.params.vkId || '');
  if (!/^[0-9]+$/.test(vkId)) return res.status(400).json({ error: 'Некорректный VK ID.' });
  const user = getUserEntitlements.get(vkId);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден.' });

  const action = req.body?.action;
  const now = new Date();
  try {
    if (action === 'reset_account') {
      if (vkId !== req.vkUserId) {
        return res.status(403).json({ error: 'Можно обнулить только собственный аккаунт администратора.' });
      }
      const resetAccount = db.transaction(() => {
        db.prepare(
          'UPDATE users SET scan_balance = 0, subscription_until = NULL, unlimited = 0, welcome_bonus_granted = 1 WHERE vk_id = ?'
        ).run(vkId);
        db.prepare("DELETE FROM scan_credit_history WHERE vk_id = ? AND source = 'purchase'").run(vkId);
        db.prepare('DELETE FROM tariff_requests WHERE vk_id = ?').run(vkId);
      });
      resetAccount();
      sendLiveTariffState(vkId);
    } else if (action === 'grant_pack') {
      const amount = Number(req.body?.amount);
      if (!Number.isSafeInteger(amount) || amount < 1 || amount > 100000) {
        return res.status(400).json({ error: 'Укажите количество сканов от 1 до 100000.' });
      }
      const creditedAt = new Date().toISOString();
      const grant = db.transaction(() => {
        grantPack.run(amount, vkId);
        recordScanCredit.run(vkId, creditedAt, amount, 'admin', 'Ручное начисление администратором');
      });
      grant();
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

// Do not expose the Mini App UI when the URL is opened outside VK.
function isRoadnoteVkLaunch(req) {
  const params = req.query || {};
  return String(params.vk_app_id || '') === String(appId)
    && Boolean(params.vk_platform)
    && (Boolean(params.sign) || Boolean(params.vk_user_id));
}

function serveRoadnoteEntry(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  if (!isRoadnoteVkLaunch(req)) {
    res.status(200).type('html').send('');
    return;
  }
  res.sendFile(path.join(__dirname, 'index.html'));
}

app.get('/', serveRoadnoteEntry);
app.get('/index.html', serveRoadnoteEntry);

app.use(express.static(__dirname, { index: 'index.html' }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(port, () => console.log(`Roadnote server listening on port ${port}`));
