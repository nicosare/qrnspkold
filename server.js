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
const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const playwrightCliPath = require.resolve('playwright/cli');
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

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: browserTimeoutMs });

    const deadline = Date.now() + browserTimeoutMs;
    while (!capturedJson && Date.now() < deadline) {
      await page.waitForTimeout(200);
    }

    if (!capturedJson) {
      throw new Error('Не удалось перехватить JSON ответа /api/paytag в headless-браузере');
    }

    const normalized = normalizePaytagPayload(capturedJson);
    if (!normalized.transportType || !normalized.routeNumber || !normalized.vehicleNumber) {
      throw new Error('JSON перехвачен, но нужные поля не найдены');
    }

    return normalized;
  } catch (error) {
    throw new Error(`Headless paytag fetch failed: ${error?.message || error}`);
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/paytag', async (req, res) => {
  const paytagid = String(req.body?.paytagid || '').trim();

  if (!paytagid || !/^[0-9]{6,20}$/.test(paytagid)) {
    return res.status(400).json({ error: 'Invalid paytagid' });
  }

  try {
    const data = await fetchPaytagViaHeadlessBrowser(paytagid);
    return res.json({ ok: true, data });
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
