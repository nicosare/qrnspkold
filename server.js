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
  CREATE TABLE IF NOT EXISTS offer_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    draft_json TEXT NOT NULL,
    published_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    published_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS offer_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vk_id TEXT NOT NULL,
    offer_id TEXT NOT NULL,
    offer_title TEXT NOT NULL,
    offer_type TEXT NOT NULL,
    offer_quantity INTEGER NOT NULL DEFAULT 1,
    offer_unit_label TEXT NOT NULL DEFAULT '',
    offer_description TEXT NOT NULL DEFAULT '',
    offer_price REAL DEFAULT NULL,
    offer_old_price REAL DEFAULT NULL,
    requested_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
  );
  CREATE INDEX IF NOT EXISTS idx_offer_requests_status_date
    ON offer_requests(status, requested_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_offer_requests_user
    ON offer_requests(vk_id, requested_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_offer_requests_one_pending
    ON offer_requests(vk_id, offer_id) WHERE status = 'pending';
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
app.use(express.json({ limit: '256kb' }));

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

const DEFAULT_OFFER_CONFIG = {
  version: 1,
  headline: 'Предложения',
  lead: 'Выбери тариф и отправь запрос — оформление происходит вручную.',
  topBadge: 'Ручное оформление',
  note: 'Запрос не означает автоматическую оплату или начисление — тариф оформляется вручную.',
  showNote: true,
  sections: [
    { id: 'scan-packs', title: 'Пакеты сканирований', icon: '↗', description: '', sortOrder: 10, visible: true },
    { id: 'subscription', title: 'Подписка', icon: '✦', description: '', sortOrder: 20, visible: true }
  ],
  offers: [
    { id: 'scan-9', sectionId: 'scan-packs', type: 'scan_pack', title: 'Старт', description: 'Попробовать и пользоваться время от времени', quantity: 9, unitLabel: 'сканов', price: 69, oldPrice: 99, showPrice: false, badge: 'Запрос доступен', style: 'default', sortOrder: 10, visible: true },
    { id: 'scan-29', sectionId: 'scan-packs', type: 'scan_pack', title: 'Оптимальный', description: 'Запас сканирований на каждый день', quantity: 29, unitLabel: 'сканов', price: 179, oldPrice: 249, showPrice: false, badge: 'Запрос доступен', style: 'default', sortOrder: 20, visible: true },
    { id: 'scan-49', sectionId: 'scan-packs', type: 'scan_pack', title: 'Большой запас', description: 'Реже пополнять баланс и не отвлекаться', quantity: 49, unitLabel: 'сканов', price: 279, oldPrice: 369, showPrice: false, badge: 'Запрос доступен', style: 'default', sortOrder: 30, visible: true },
    { id: 'sub-1', sectionId: 'subscription', type: 'subscription', title: '', description: 'Для регулярного использования', quantity: 1, unitLabel: 'месяц', price: 179, oldPrice: 249, showPrice: false, badge: 'Запрос доступен', style: 'featured', sortOrder: 10, visible: true },
    { id: 'sub-3', sectionId: 'subscription', type: 'subscription', title: '', description: 'Удобный вариант на сезон', quantity: 3, unitLabel: 'месяца', price: 439, oldPrice: 549, showPrice: false, badge: 'Запрос доступен', style: 'default', sortOrder: 20, visible: true },
    { id: 'sub-6', sectionId: 'subscription', type: 'subscription', title: '', description: 'Подключить надолго и забыть о пополнении', quantity: 6, unitLabel: 'месяцев', price: 699, oldPrice: 849, showPrice: false, badge: 'Запрос доступен', style: 'default', sortOrder: 30, visible: true }
  ]
};

const nowForOfferSeed = new Date().toISOString();
const defaultOfferJson = JSON.stringify(DEFAULT_OFFER_CONFIG);
db.prepare(`
  INSERT OR IGNORE INTO offer_config (id, draft_json, published_json, updated_at, published_at)
  VALUES (1, ?, ?, ?, ?)
`).run(defaultOfferJson, defaultOfferJson, nowForOfferSeed, nowForOfferSeed);

function normalizeOfferConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Переданы некорректные настройки предложений.');
  }
  if (!Array.isArray(input.sections) || !Array.isArray(input.offers)) {
    throw new Error('В настройках должны быть разделы и карточки.');
  }
  if (input.sections.length < 1 || input.sections.length > 20) {
    throw new Error('Добавь от 1 до 20 разделов.');
  }
  if (input.offers.length > 100) {
    throw new Error('Можно настроить не более 100 карточек.');
  }

  const safeId = (value, label) => {
    const id = String(value || '').trim();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error('Некорректный идентификатор: ' + label + '.');
    return id;
  };
  const priceValue = (value, label) => {
    if (value === null || value === undefined || value === '') return null;
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0 || num > 10000000) {
      throw new Error('Проверь поле «' + label + '»: цена должна быть от 0 до 10 000 000 ₽.');
    }
    return Math.round(num * 100) / 100;
  };
  const orderValue = value => {
    const num = Number(value);
    return Number.isSafeInteger(num) ? Math.max(0, Math.min(10000, num)) : 0;
  };

  const sectionIds = new Set();
  const sections = input.sections.map((section, index) => {
    const id = safeId(section?.id, 'раздел');
    if (sectionIds.has(id)) throw new Error('Идентификаторы разделов должны отличаться.');
    sectionIds.add(id);
    const title = cleanText(section?.title, 80);
    if (!title) throw new Error('Укажи название каждого раздела.');
    return {
      id,
      title,
      icon: cleanText(section?.icon, 8),
      description: cleanText(section?.description, 180),
      sortOrder: orderValue(section?.sortOrder ?? (index + 1) * 10),
      visible: section?.visible !== false
    };
  });

  const offerIds = new Set();
  const offers = input.offers.map((offer, index) => {
    const id = safeId(offer?.id, 'карточка');
    if (offerIds.has(id)) throw new Error('Идентификаторы карточек должны отличаться.');
    offerIds.add(id);
    const sectionId = safeId(offer?.sectionId, 'раздел карточки');
    if (!sectionIds.has(sectionId)) throw new Error('У карточки «' + cleanText(offer?.title, 80) + '» выбран несуществующий раздел.');
    const type = ['scan_pack', 'subscription', 'custom'].includes(offer?.type) ? offer.type : 'custom';
    const title = cleanText(offer?.title, 80);
    if (type !== 'subscription' && !title) throw new Error('Укажи название карточки.');
    const quantity = Number(offer?.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 1000000) {
      throw new Error('Количество в карточке должно быть целым числом от 0 до 1 000 000.');
    }
    const style = offer?.style === 'featured' ? 'featured' : 'default';
    const price = priceValue(offer?.price, 'Цена');
    const oldPrice = priceValue(offer?.oldPrice, 'Прежняя цена');
    return {
      id,
      sectionId,
      type,
      title,
      description: cleanText(offer?.description, 240),
      quantity,
      unitLabel: cleanText(offer?.unitLabel, 32),
      price,
      oldPrice,
      showPrice: offer?.showPrice === true,
      badge: cleanText(offer?.badge, 32),
      style,
      sortOrder: orderValue(offer?.sortOrder ?? (index + 1) * 10),
      visible: offer?.visible !== false
    };
  });

  return {
    version: 1,
    headline: cleanText(input.headline, 60) || 'Предложения',
    lead: cleanText(input.lead, 240),
    topBadge: cleanText(input.topBadge, 32),
    note: cleanText(input.note, 180),
    showNote: input.showNote === true,
    sections,
    offers
  };
}

function parseStoredOfferConfig(value) {
  try {
    return normalizeOfferConfig(JSON.parse(value));
  } catch (error) {
    console.error('[offers config] Stored configuration is invalid:', error?.message || error);
    return DEFAULT_OFFER_CONFIG;
  }
}

function getStoredOfferConfig() {
  const row = db.prepare('SELECT draft_json, published_json, updated_at, published_at FROM offer_config WHERE id = 1').get();
  if (!row) return {
    draft: DEFAULT_OFFER_CONFIG,
    published: DEFAULT_OFFER_CONFIG,
    updatedAt: null,
    publishedAt: null
  };
  return {
    draft: parseStoredOfferConfig(row.draft_json),
    published: parseStoredOfferConfig(row.published_json),
    updatedAt: row.updated_at,
    publishedAt: row.published_at
  };
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
    return res.json({
      ok: true,
      isAdmin: userId === adminVkId,
      scanBalance,
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

app.get('/api/offers', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const config = getStoredOfferConfig().published;
  const visibleSections = config.sections
    .filter(section => section.visible)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const visibleSectionIds = new Set(visibleSections.map(section => section.id));
  const visibleOffers = config.offers
    .filter(offer => offer.visible && visibleSectionIds.has(offer.sectionId))
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const sectionsWithOffers = visibleSections.filter(section =>
    visibleOffers.some(offer => offer.sectionId === section.id)
  );
  const sectionIdsWithOffers = new Set(sectionsWithOffers.map(section => section.id));
  return res.json({
    headline: config.headline,
    lead: config.lead,
    topBadge: config.topBadge,
    note: config.note,
    showNote: config.showNote,
    supportUrl: adminVkId ? 'https://vk.com/im?sel=' + encodeURIComponent(adminVkId) : '',
    sections: sectionsWithOffers,
    offers: visibleOffers.filter(offer => sectionIdsWithOffers.has(offer.sectionId))
  });
});


app.post('/api/offer-requests', (req, res) => {
  let userId;
  let params;
  try {
    ({ userId, params } = launchParamsFromRequest(req));
  } catch {
    return res.status(401).json({ error: 'Открой приложение внутри VK, чтобы отправить запрос.' });
  }

  const offerId = String(req.body?.offerId || '').trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(offerId)) {
    return res.status(400).json({ error: 'Не удалось определить выбранный тариф.' });
  }

  const config = getStoredOfferConfig().published;
  const offer = config.offers.find(item => item.id === offerId && item.visible);
  const section = offer && config.sections.find(item => item.id === offer.sectionId && item.visible);
  if (!offer || !section) {
    return res.status(404).json({ error: 'Этот тариф больше не доступен. Обнови приложение и попробуй снова.' });
  }

  const now = new Date().toISOString();
  if (!getUserExists.get(userId)) {
    const profile = {
      vk_id: userId,
      first_name: cleanText(params.get('vk_first_name'), 80),
      last_name: cleanText(params.get('vk_last_name'), 80),
      photo_url: cleanText(params.get('vk_photo_100') || params.get('vk_photo_200'), 1000),
      now
    };
    db.transaction(() => {
      upsertUser.run(profile);
      recordScanCredit.run(userId, now, 3, 'welcome', 'Приветственные сканы');
    })();
  }

  try {
    const saveRequest = db.transaction(() => {
      const existing = db.prepare(
        "SELECT id FROM offer_requests WHERE vk_id = ? AND offer_id = ? AND status = 'pending'"
      ).get(userId, offer.id);
      if (existing) return { id: Number(existing.id), alreadyRequested: true };

      const result = db.prepare(`
        INSERT INTO offer_requests
          (vk_id, offer_id, offer_title, offer_type, offer_quantity, offer_unit_label,
           offer_description, offer_price, offer_old_price, requested_at, updated_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
      `).run(
        userId, offer.id, offer.title || (offer.type === 'subscription' ? 'Подписка' : 'Пакет сканирований'),
        offer.type, Number(offer.quantity) || 1, offer.unitLabel || '', offer.description || '',
        offer.price === '' || offer.price === undefined ? null : offer.price,
        offer.oldPrice === '' || offer.oldPrice === undefined ? null : offer.oldPrice,
        now, now
      );
      return { id: Number(result.lastInsertRowid), alreadyRequested: false };
    });
    const saved = saveRequest();
    return res.status(saved.alreadyRequested ? 200 : 201).json({
      ok: true,
      ...saved,
      message: saved.alreadyRequested
        ? 'У тебя уже есть активный запрос на этот тариф.'
        : 'Запрос отправлен. Администратор оформит тариф вручную.'
    });
  } catch (error) {
    if (String(error?.code || '').startsWith('SQLITE_CONSTRAINT')) {
      return res.status(409).json({ error: 'У тебя уже есть активный запрос на этот тариф.' });
    }
    console.error('[offer request]', error);
    return res.status(500).json({ error: 'Не удалось сохранить запрос. Попробуй ещё раз.' });
  }
});

app.get('/api/admin/offers', requireAdmin, (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const config = getStoredOfferConfig();
  return res.json(config);
});

app.put('/api/admin/offers/draft', requireAdmin, (req, res) => {
  try {
    const normalized = normalizeOfferConfig(req.body);
    const updatedAt = new Date().toISOString();
    db.prepare('UPDATE offer_config SET draft_json = ?, updated_at = ? WHERE id = 1')
      .run(JSON.stringify(normalized), updatedAt);
    return res.json({ ok: true, draft: normalized, updatedAt });
  } catch (error) {
    return res.status(400).json({ error: error?.message || 'Не удалось сохранить черновик.' });
  }
});

app.post('/api/admin/offers/publish', requireAdmin, (_req, res) => {
  const row = db.prepare('SELECT draft_json FROM offer_config WHERE id = 1').get();
  if (!row) return res.status(500).json({ error: 'Настройки предложений не найдены.' });
  const publishedAt = new Date().toISOString();
  db.prepare('UPDATE offer_config SET published_json = draft_json, published_at = ? WHERE id = 1').run(publishedAt);
  return res.json({ ok: true, published: parseStoredOfferConfig(row.draft_json), publishedAt });
});

app.post('/api/admin/offers/reset-draft', requireAdmin, (_req, res) => {
  const row = db.prepare('SELECT published_json FROM offer_config WHERE id = 1').get();
  if (!row) return res.status(500).json({ error: 'Настройки предложений не найдены.' });
  const updatedAt = new Date().toISOString();
  db.prepare('UPDATE offer_config SET draft_json = published_json, updated_at = ? WHERE id = 1').run(updatedAt);
  return res.json({ ok: true, draft: parseStoredOfferConfig(row.published_json), updatedAt });
});


app.get('/api/admin/offer-requests', requireAdmin, (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const requests = db.prepare(`
    SELECT r.id, r.vk_id, r.offer_id, r.offer_title, r.offer_type, r.offer_quantity,
           r.offer_unit_label, r.offer_description, r.offer_price, r.offer_old_price,
           r.requested_at, r.updated_at, r.status,
           u.first_name, u.last_name, u.photo_url
    FROM offer_requests r
    LEFT JOIN users u ON u.vk_id = r.vk_id
    ORDER BY CASE WHEN r.status = 'pending' THEN 0 ELSE 1 END,
             r.requested_at DESC, r.id DESC
  `).all();
  return res.json({
    requests,
    total: requests.length,
    pending: requests.filter(item => item.status === 'pending').length
  });
});

app.patch('/api/admin/offer-requests/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const status = String(req.body?.status || '');
  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Некорректный номер запроса.' });
  }
  if (!['processed', 'declined', 'pending'].includes(status)) {
    return res.status(400).json({ error: 'Неизвестный статус запроса.' });
  }
  const result = db.prepare('UPDATE offer_requests SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, new Date().toISOString(), id);
  if (!result.changes) return res.status(404).json({ error: 'Запрос не найден.' });
  return res.json({ ok: true, id, status });
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
    if (action === 'grant_pack') {
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

app.get('/admin/requests', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'admin-requests.html'));
});

app.get('/admin/offers', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'admin-offers.html'));
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
