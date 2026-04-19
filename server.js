import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;
const upstreamTimeoutMs = Number(process.env.UPSTREAM_TIMEOUT_MS || 15000);
const browserTimeoutMs = Number(process.env.PAYTAG_BROWSER_TIMEOUT_MS || 25000);
const directApiTimeoutMs = Number(process.env.PAYTAG_DIRECT_TIMEOUT_MS || 12000);
const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const playwrightPackageJsonPath = require.resolve('playwright/package.json');
const playwrightCliPath = path.join(path.dirname(playwrightPackageJsonPath), 'cli.js');
let playwrightInstallPromise = null;

function shortErrorText(error) {
  const stderr = String(error?.stderr || '').trim();
  const stdout = String(error?.stdout || '').trim();
  const message = String(error?.message || error || '').trim();
  return stderr || stdout || message;
}

async function runPlaywrightInstall() {
  const attempts = [
    { args: ['install', 'chromium'], env: {} },
    { args: ['install', 'chromium'], env: { PLAYWRIGHT_BROWSERS_PATH: '0' } }
  ];
  const errors = [];

  for (const attempt of attempts) {
    try {
      await execFileAsync(process.execPath, [playwrightCliPath, ...attempt.args], {
        env: { ...process.env, ...attempt.env },
        timeout: 180000,
        maxBuffer: 1024 * 1024 * 10
      });
      return;
    } catch (error) {
      errors.push(`playwright ${attempt.args.join(' ')}: ${shortErrorText(error)}`);
    }
  }

  throw new Error(errors.join(' | '));
}

app.use(express.json({ limit: '100kb' }));

function isAllowedUrl(raw) {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' && parsed.hostname === 'qr.bilet.nspk.ru';
  } catch {
    return false;
  }
}

function normalizePaytagPayload(payload = {}) {
  const candidates = [
    payload?.vehicleTypeName,
    payload?.transportType,
    payload?.vehicleType,
    payload?.transport_name,
    payload?.transport,
    payload?.type
  ];

  const routeCandidates = [
    payload?.routeNumber,
    payload?.route,
    payload?.line,
    payload?.lineNumber,
    payload?.route_no
  ];

  const vehicleCandidates = [
    payload?.vehicleNumber,
    payload?.vehicle_no,
    payload?.transportNumber,
    payload?.ts,
    payload?.carNumber
  ];

  const pick = (items) => items.find(value => typeof value === 'string' && value.trim().length > 0)?.trim() || '';

  return {
    transportType: pick(candidates),
    routeNumber: pick(routeCandidates),
    vehicleNumber: pick(vehicleCandidates)
  };
}

function normalizePaytagId(raw = '') {
  return String(raw).replace(/\s+/g, '').replace(/[^0-9A-Za-z_-]/g, '').trim();
}

function normalizeShortParam(raw = '', fallback = '') {
  const normalized = String(raw).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return normalized || fallback;
}

function normalizeTransportType(value = '') {
  const cleaned = String(value).trim().toLowerCase();
  const dictionary = {
    'трамвай': 'Трамвай',
    'автобус': 'Автобус',
    'троллейбус': 'Троллейбус',
    'электробус': 'Электробус',
    'маршрутка': 'Маршрутка',
    'метро': 'Метро'
  };

  return dictionary[cleaned] || String(value).trim();
}

function extractTransportFromPageText(text = '') {
  const source = String(text).replace(/\s+/g, ' ');
  const match = (patterns) => {
    for (const pattern of patterns) {
      const found = source.match(pattern);
      if (found?.[1]) {
        return found[1].trim();
      }
    }
    return '';
  };

  const typeRaw = match([
    /\b(Трамвай|Автобус|Троллейбус|Электробус|Маршрутка|Метро)\b/i,
    /(?:тип\s*транспорта|вид\s*транспорта)\s*[:№]?\s*([А-Яа-яA-Za-z-]{3,30})/i
  ]);

  const routeNumber = match([
    /маршрут[^№\d]{0,20}№\s*([0-9A-Za-zА-Яа-я-]{1,8})/i,
    /(?:номер\s*маршрута|маршрут)\s*[:№]?\s*([0-9A-Za-zА-Яа-я-]{1,8})/i,
    /№\s*([0-9A-Za-zА-Яа-я-]{1,8})/
  ]);

  const vehicleNumber = match([
    /Т\s*\/\s*С\s*[:№]?\s*([0-9A-Za-zА-Яа-я-]{1,12})/i,
    /ТС\s*[:№]?\s*([0-9A-Za-zА-Яа-я-]{1,12})/i,
    /(?:борт(?:овой)?\s*номер|номер\s*тс)\s*[:№]?\s*([0-9A-Za-zА-Яа-я-]{1,12})/i
  ]);

  return {
    transportType: normalizeTransportType(typeRaw),
    routeNumber,
    vehicleNumber
  };
}

async function fetchPaytagViaHeadlessBrowser(paytagid) {
  const targetUrl = `https://qr.bilet.nspk.ru/?paytagid=${encodeURIComponent(paytagid)}&s=qr&m=t`;
  let browser;
  const { chromium } = await import('playwright');

  async function launchBrowser() {
    return chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
  }

  async function ensureChromiumInstalled() {
    if (!playwrightInstallPromise) {
      playwrightInstallPromise = runPlaywrightInstall()
        .finally(() => {
          playwrightInstallPromise = null;
        });
    }

    await playwrightInstallPromise;
  }

  try {
    try {
      browser = await launchBrowser();
    } catch (launchError) {
      const launchMessage = String(launchError?.message || launchError);
      const browserMissing = launchMessage.includes("Executable doesn't exist");

      if (!browserMissing) {
        throw launchError;
      }

      await ensureChromiumInstalled();
      browser = await launchBrowser();
    }

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      locale: 'ru-RU'
    });

    const page = await context.newPage();
    let capturedJson = null;
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'media', 'font'].includes(type)) {
        return route.abort();
      }
      return route.continue();
    });

    page.on('response', async (response) => {
      try {
        const responseUrl = response.url();
        if (!responseUrl.includes('/api/paytag') || !responseUrl.includes(`paytagid=${paytagid}`)) {
          return;
        }

        const contentType = (response.headers()['content-type'] || '').toLowerCase();
        if (!contentType.includes('application/json')) {
          return;
        }

        const json = await response.json();
        capturedJson = json;
      } catch {
        // ignore broken/partial responses
      }
    });

    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: Math.max(8000, Math.min(browserTimeoutMs, 20000)) });
    } catch (gotoError) {
      await page.goto(targetUrl, { waitUntil: 'commit', timeout: Math.max(6000, Math.min(browserTimeoutMs, 12000)) });
    }
    await page.waitForLoadState('networkidle', { timeout: Math.max(5000, Math.min(browserTimeoutMs, 15000)) }).catch(() => {});

    const deadline = Date.now() + browserTimeoutMs;
    while (!capturedJson && Date.now() < deadline) {
      await page.waitForTimeout(200);
    }

    if (capturedJson) {
      const normalized = normalizePaytagPayload(capturedJson);
      if (normalized.transportType && normalized.routeNumber && normalized.vehicleNumber) {
        return normalized;
      }
    }

    const pageText = await page.evaluate(() => document.body?.innerText || '');
    const extractedFromPage = extractTransportFromPageText(pageText);
    if (extractedFromPage.transportType && extractedFromPage.routeNumber && extractedFromPage.vehicleNumber) {
      return extractedFromPage;
    }

    throw new Error('Не удалось извлечь транспортные данные из внутреннего браузера (ни из API, ни из страницы)');
  } catch (error) {
    throw new Error(`Headless paytag fetch failed: ${error?.message || error}`);
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = directApiTimeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function extractFromUnknownJson(payload = {}) {
  const normalized = normalizePaytagPayload(payload);
  if (normalized.transportType && normalized.routeNumber && normalized.vehicleNumber) {
    return normalized;
  }

  const raw = JSON.stringify(payload);
  const pick = (patterns) => {
    for (const pattern of patterns) {
      const found = raw.match(pattern);
      if (found?.[1]) {
        return found[1].trim();
      }
    }
    return '';
  };

  return {
    transportType: normalizeTransportType(pick([
      /"(?:vehicleType|transportType|transport_name|type|vehicle_type|transport_type)"\s*:\s*"([^"\n]{3,30})"/i,
      /"(?:vehicle|transport)"\s*:\s*"(трамвай|автобус|троллейбус|электробус|маршрутка|метро)"/i
    ])),
    routeNumber: pick([
      /"(?:routeNumber|route_no|route|line|lineNumber|route_number|line_number)"\s*:\s*"?([0-9A-Za-zА-Яа-я-]{1,8})"?/i
    ]),
    vehicleNumber: pick([
      /"(?:vehicleNumber|vehicle_no|transportNumber|carNumber|ts|vehicle_number)"\s*:\s*"?([0-9A-Za-zА-Яа-я-]{1,12})"?/i
    ])
  };
}

async function fetchPaytagViaDirectApi(paytagid, s = 'qr', m = 't') {
  const primaryUrl = `https://qr.bilet.nspk.ru/api/v1/pay-tags/tariff?payTagId=${encodeURIComponent(paytagid)}&s=${encodeURIComponent(s)}&m=${encodeURIComponent(m)}`;
  const apiCandidates = [
    primaryUrl,
    `https://qr.bilet.nspk.ru/api/paytag/${encodeURIComponent(paytagid)}`,
    `https://qr.bilet.nspk.ru/api/v1/paytag/${encodeURIComponent(paytagid)}`,
    `https://qr.bilet.nspk.ru/api/v1/paytag?paytagid=${encodeURIComponent(paytagid)}`,
    `https://qr.bilet.nspk.ru/api/ticket?paytagid=${encodeURIComponent(paytagid)}`,
    `https://qr.bilet.nspk.ru/api/v1/ticket?paytagid=${encodeURIComponent(paytagid)}`
  ];

  for (const url of apiCandidates) {
    try {
      const response = await fetchWithTimeout(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
          Accept: 'application/json,text/plain,*/*',
          'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
          Referer: 'https://qr.bilet.nspk.ru/'
        }
      });

      if (!response.ok) {
        continue;
      }

      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      if (!contentType.includes('application/json')) {
        continue;
      }

      const json = await response.json();
      const extracted = extractFromUnknownJson(json);
      if (extracted.transportType && extracted.routeNumber && extracted.vehicleNumber) {
        return extracted;
      }
    } catch {
      // пробуем следующий API endpoint
    }
  }

  return null;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/paytag', async (req, res) => {
  const paytagid = normalizePaytagId(req.body?.paytagid || '');
  const s = normalizeShortParam(req.body?.s, 'qr');
  const m = normalizeShortParam(req.body?.m, 't');

  if (!paytagid || !/^[0-9A-Za-z_-]{6,64}$/.test(paytagid)) {
    return res.status(400).json({ error: 'Invalid paytagid' });
  }

  try {
    const directApiData = await fetchPaytagViaDirectApi(paytagid, s, m);
    if (directApiData) {
      return res.json({ ok: true, data: directApiData, source: 'direct-api' });
    }

    const data = await fetchPaytagViaHeadlessBrowser(paytagid);
    return res.json({ ok: true, data, source: 'headless-browser' });
  } catch (error) {
    return res.status(502).json({ error: error?.message || String(error) });
  }
});

app.get('/proxy', async (req, res) => {
  const rawUrl = req.query.url;

  if (!rawUrl || typeof rawUrl !== 'string') {
    return res.status(400).json({ error: 'Missing url query parameter' });
  }

  if (!isAllowedUrl(rawUrl)) {
    return res.status(400).json({ error: 'Only https://qr.bilet.nspk.ru URLs are allowed' });
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), upstreamTimeoutMs);

    const upstream = await fetch(rawUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
        Referer: 'https://qr.bilet.nspk.ru/'
      }
    });

    clearTimeout(timeoutId);

    const contentType = upstream.headers.get('content-type') || 'text/html; charset=utf-8';
    const body = await upstream.text();

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(upstream.status).send(body);
  } catch (error) {
    const details = error?.name === 'AbortError' ? `timeout ${upstreamTimeoutMs}ms` : (error?.message || String(error));
    return res.status(502).json({ error: `Proxy request failed: ${details}` });
  }
});

app.use(express.static(__dirname));

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, () => {
  console.log(`Proxy server listening on port ${port}`);
});
