import express from 'express';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { redisFromEnv, getSettings, saveSettings, heartbeat } from '../automation/scheduler.js';
import { prepareReport, submitApprovedReport, rejectReport } from '../automation/runReport.js';
import { todayIST } from '../automation/reportCore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '../public');
const redis = redisFromEnv();
const app = express();
const port = Number(process.env.PORT || 10000);
const timezone = process.env.TIMEZONE || 'Asia/Kolkata';
const REVIEW_USER = process.env.REVIEW_USER;
const REVIEW_PASSWORD = process.env.REVIEW_PASSWORD;

if (!REVIEW_USER || !REVIEW_PASSWORD) throw new Error('REVIEW_USER and REVIEW_PASSWORD are required.');

app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
const sessions = new Map();

function keyFor(date = todayIST()) { return `daily-report:state:${date}`; }
function historyKey() { return 'daily-report:history'; }
function nowIST() {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'medium' }).format(new Date());
}
function constantTimeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function requireBasicAuth(req, res, next) {
  const header = req.get('authorization') || '';
  if (!header.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Daily Report Control Center"');
    return res.status(401).send('Authentication required.');
  }
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const split = decoded.indexOf(':');
  const user = split >= 0 ? decoded.slice(0, split) : '';
  const pass = split >= 0 ? decoded.slice(split + 1) : '';
  if (!constantTimeEqual(user, REVIEW_USER) || !constantTimeEqual(pass, REVIEW_PASSWORD)) {
    res.set('WWW-Authenticate', 'Basic realm="Daily Report Control Center"');
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
function issueCsrf() {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + 60 * 60 * 1000);
  return token;
}
function requireCsrf(req, res) {
  if (!sameOrigin(req)) { res.status(403).json({ error: 'Origin check failed.' }); return false; }
  const token = req.get('x-csrf-token') || '';
  const expires = sessions.get(token);
  if (!expires || expires < Date.now()) {
    sessions.delete(token);
    res.status(403).json({ error: 'CSRF token expired. Refresh the page.' });
    return false;
  }
  return true;
}
async function getState(date = todayIST()) {
  const raw = await redis.get(keyFor(date));
  return raw ? JSON.parse(raw) : null;
}
async function getHistory() {
  const dates = await redis.zrevrange(historyKey(), 0, 14);
  const items = [];
  for (const date of dates) {
    const state = await getState(date);
    if (state) items.push(state);
  }
  return items;
}
function cutoffPassed(cutoffTime) {
  const [h, m] = cutoffTime.split(':').map(Number);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date()).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
  return Number(parts.hour) * 60 + Number(parts.minute) >= h * 60 + m;
}

app.get('/health', async (_req, res) => {
  try { await redis.ping(); res.json({ ok: true, service: 'daily-report-control-center', time: new Date().toISOString() }); }
  catch (error) { res.status(503).json({ ok: false, error: error?.message || String(error) }); }
});

app.get('/api/status', requireBasicAuth, async (_req, res) => {
  const settings = await getSettings(redis);
  const state = await getState();
  res.json({
    ok: true,
    today: todayIST(),
    timezone,
    serverTime: nowIST(),
    allowSubmit: String(process.env.ALLOW_SUBMIT || 'false').toLowerCase() === 'true',
    settings,
    state,
    history: await getHistory()
  });
});

app.post('/api/run', requireBasicAuth, async (_req, res) => {
  if (!requireCsrf(_req, res)) return;
  const current = await getState();
  if (current && ['RUNNING', 'AWAITING_REVIEW', 'SUBMITTING', 'SUBMITTED'].includes(current.status)) {
    return res.json({ ok: true, state: current, started: false });
  }

  res.status(202).json({ ok: true, started: true, message: 'Report preparation started.' });
  prepareReport(redis, { trigger: 'manual' }).catch((error) => console.error('[MANUAL RUN]', error?.stack || error));
});

app.post('/api/scheduler/run-now', requireBasicAuth, async (_req, res) => {
  if (!requireCsrf(_req, res)) return;
  try {
    const result = await heartbeat(redis);
    res.json({ ok: true, dueSchedules: result.dueSchedules });
  } catch (error) {
    res.status(500).json({ error: error?.message || String(error) });
  }
});

app.get('/api/settings', requireBasicAuth, async (_req, res) => {
  res.json({ ok: true, settings: await getSettings(redis) });
});

app.post('/api/settings', requireBasicAuth, async (req, res) => {
  if (!requireCsrf(req, res)) return;
  try {
    res.json({ ok: true, settings: await saveSettings(redis, req.body?.settings || {}) });
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/approve', requireBasicAuth, async (req, res) => {
  if (!requireCsrf(req, res)) return;
  if (String(process.env.ALLOW_SUBMIT || 'false').toLowerCase() !== 'true') {
    return res.status(409).json({ error: 'Submission is safety-disabled. Set ALLOW_SUBMIT=true in Render after testing.' });
  }
  const settings = await getSettings(redis);
  if (cutoffPassed(settings.cutoffTime)) return res.status(409).json({ error: `Approval cutoff ${settings.cutoffTime} IST has passed.` });

  res.status(202).json({ ok: true, message: 'Submission started.' });
  submitApprovedReport(redis).catch((error) => console.error('[SUBMIT]', error?.stack || error));
});

app.post('/api/reject', requireBasicAuth, async (req, res) => {
  if (!requireCsrf(req, res)) return;
  try {
    res.json({ ok: true, state: await rejectReport(redis) });
  } catch (error) {
    res.status(409).json({ error: error?.message || String(error) });
  }
});

app.get('/', requireBasicAuth, async (_req, res) => {
  const csrf = issueCsrf();
  let html = await fs.readFile(path.join(publicDir, 'index.html'), 'utf8');
  html = html.replace('__CSRF_TOKEN__', csrf);
  res.type('html').send(html);
});

app.get('/sw.js', requireBasicAuth, async (_req, res) => res.sendFile(path.join(publicDir, 'sw.js')));
app.get('/manifest.json', requireBasicAuth, async (_req, res) => res.sendFile(path.join(publicDir, 'manifest.json')));
app.use(requireBasicAuth, express.static(publicDir, { index: false }));

app.listen(port, '0.0.0.0', () => {
  console.log(`[WEB] Daily Report Control Center listening on ${port}`);
});
