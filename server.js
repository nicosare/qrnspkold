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

app.get('/health', (_req, res) => {
  res.json({ ok: true, database: 'connected' });
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
