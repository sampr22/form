import express from 'express';
import Redis from 'ioredis';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '../public');

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) throw new Error('REDIS_URL is required.');

const REVIEW_USER = process.env.REVIEW_USER;
const REVIEW_PASSWORD = process.env.REVIEW_PASSWORD;
if (!REVIEW_USER || !REVIEW_PASSWORD) {
  throw new Error('REVIEW_USER and REVIEW_PASSWORD are required.');
}

const redis = new Redis(REDIS_URL);
const app = express();
const port = Number(process.env.PORT || 10000);
const timezone = process.env.TIMEZONE || 'Asia/Kolkata';

app.disable('x-powered-by');
app.use(express.json({ limit: '50kb' }));

const sessions = new Map();

function todayIST() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

function dateTimeIST(date = new Date()) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    dateStyle: 'medium',
    timeStyle: 'medium'
  }).format(date);
}

function keyFor(date) {
  return `daily-report:state:${date}`;
}

function historyKey() {
  return 'daily-report:history';
}

function constantTimeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function requireBasicAuth(req, res, next) {
  const header = req.get('authorization') || '';
  if (!header.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Daily Report Dashboard"');
    return res.status(401).send('Authentication required.');
  }

  let decoded = '';
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return res.status(401).send('Invalid authentication.');
  }

  const split = decoded.indexOf(':');
  const user = split >= 0 ? decoded.slice(0, split) : '';
  const pass = split >= 0 ? decoded.slice(split + 1) : '';

  if (!constantTimeEqual(user, REVIEW_USER) || !constantTimeEqual(pass, REVIEW_PASSWORD)) {
    res.set('WWW-Authenticate', 'Basic realm="Daily Report Dashboard"');
    return res.status(401).send('Invalid credentials.');
  }

  return next();
}

function sameOrigin(req) {
  const origin = req.get('origin');
  if (!origin) return true;
  const host = req.get('host');
  return origin === `https://${host}` || origin === `http://${host}`;
}

async function getState(date = todayIST()) {
  const raw = await redis.get(keyFor(date));
  return raw ? JSON.parse(raw) : null;
}

async function updateState(date, patch) {
  const key = keyFor(date);
  const raw = await redis.get(key);
  const current = raw ? JSON.parse(raw) : {};
  const next = {
    ...current,
    ...patch,
    date,
    updatedAt: new Date().toISOString(),
    updatedAtIST: dateTimeIST()
  };
  await redis.set(key, JSON.stringify(next), 'EX', Number(process.env.STATE_TTL_SECONDS || 604800));
  await redis.zadd(historyKey(), Date.now(), date);
  await redis.expire(historyKey(), Number(process.env.HISTORY_TTL_SECONDS || 7776000));
  return next;
}

function newCsrfToken() {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + 60 * 60 * 1000);
  return token;
}

function requireCsrf(req, res) {
  if (!sameOrigin(req)) {
    res.status(403).json({ error: 'Origin check failed.' });
    return false;
  }
  const token = req.get('x-csrf-token') || '';
  const expires = sessions.get(token);
  if (!expires || expires < Date.now()) {
    sessions.delete(token);
    res.status(403).json({ error: 'CSRF token expired. Refresh the page.' });
    return false;
  }
  return true;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'daily-report-review', time: new Date().toISOString() });
});

app.get('/api/status', requireBasicAuth, async (_req, res) => {
  const today = todayIST();
  const state = await getState(today);
  const dates = await redis.zrevrange(historyKey(), 0, 14);
  const history = [];

  for (const date of dates) {
    const item = await getState(date);
    if (item) history.push(item);
  }

  const allowSubmit = String(process.env.ALLOW_SUBMIT || 'false').toLowerCase() === 'true';

  res.json({
    ok: true,
    today,
    timezone,
    allowSubmit,
    state,
    history
  });
});

app.post('/api/approve', requireBasicAuth, async (req, res) => {
  if (!requireCsrf(req, res)) return;

  const date = todayIST();
  const state = await getState(date);

  if (!state || state.status !== 'AWAITING_REVIEW') {
    return res.status(409).json({ error: `Cannot approve while status is ${state?.status || 'NO_REPORT'}.` });
  }

  if (String(process.env.ALLOW_SUBMIT || 'false').toLowerCase() !== 'true') {
    return res.status(409).json({
      error: 'Submission is safety-disabled. Set ALLOW_SUBMIT=true in Render after testing.'
    });
  }

  const next = await updateState(date, {
    status: 'APPROVED',
    approvedAt: new Date().toISOString(),
    approvedBy: REVIEW_USER
  });

  res.json({ ok: true, state: next });
});

app.post('/api/reject', requireBasicAuth, async (req, res) => {
  if (!requireCsrf(req, res)) return;

  const date = todayIST();
  const state = await getState(date);

  if (!state || !['RUNNING', 'AWAITING_REVIEW'].includes(state.status)) {
    return res.status(409).json({ error: `Cannot reject while status is ${state?.status || 'NO_REPORT'}.` });
  }

  const next = await updateState(date, {
    status: 'REJECTED',
    rejectedAt: new Date().toISOString(),
    rejectedBy: REVIEW_USER,
    message: 'Rejected from review dashboard. Nothing was submitted.'
  });

  res.json({ ok: true, state: next });
});

app.get('/', requireBasicAuth, async (_req, res) => {
  const csrf = newCsrfToken();
  let html = await fs.readFile(path.join(publicDir, 'index.html'), 'utf8');
  html = html.replace('__CSRF_TOKEN__', csrf);
  return res.type('html').send(html);
});

app.use(requireBasicAuth, express.static(publicDir, { index: false }));

app.listen(port, '0.0.0.0', () => {
  console.log(`[WEB] Daily Report Dashboard running on port ${port}`);
});
