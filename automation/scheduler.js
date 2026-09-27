import Redis from 'ioredis';
import { prepareReport } from './runReport.js';

export const SETTINGS_KEY = 'daily-report:settings';

const DEFAULT_SETTINGS = {
  timezone: 'Asia/Kolkata',
  cutoffTime: '20:58',
  schedules: [
    { id: 'prepare-2000', label: 'Prepare daily report', time: '20:00', enabled: true, mode: 'prepare' },
    { id: 'reminder-2030', label: 'Approval reminder', time: '20:30', enabled: false, mode: 'reminder' }
  ]
};

export function redisFromEnv() {
  if (!process.env.REDIS_URL) throw new Error('REDIS_URL is required.');
  return new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 3 });
}

export function normalizeSettings(input = {}) {
  const schedules = Array.isArray(input.schedules) ? input.schedules : DEFAULT_SETTINGS.schedules;
  return {
    timezone: 'Asia/Kolkata',
    cutoffTime: /^\d{2}:\d{2}$/.test(String(input.cutoffTime || '')) ? String(input.cutoffTime) : DEFAULT_SETTINGS.cutoffTime,
    schedules: schedules.slice(0, 12).map((s, i) => ({
      id: String(s.id || `schedule-${i + 1}`),
      label: String(s.label || `Schedule ${i + 1}`).slice(0, 80),
      time: /^\d{2}:\d{2}$/.test(String(s.time || '')) ? String(s.time) : '20:00',
      enabled: s.enabled !== false,
      mode: s.mode === 'reminder' ? 'reminder' : 'prepare'
    }))
  };
}

export async function getSettings(redis) {
  const raw = await redis.get(SETTINGS_KEY);
  if (!raw) return DEFAULT_SETTINGS;
  try { return normalizeSettings(JSON.parse(raw)); } catch { return DEFAULT_SETTINGS; }
}

export async function saveSettings(redis, input) {
  const settings = normalizeSettings(input);
  for (const s of settings.schedules) {
    const [h, m] = s.time.split(':').map(Number);
    if (h > 23 || m > 59 || m % 5 !== 0) throw new Error(`Invalid timing for ${s.label}. Use 5-minute intervals.`);
  }
  const [ch, cm] = settings.cutoffTime.split(':').map(Number);
  if (ch > 23 || cm > 59) throw new Error('Invalid cutoff time.');
  await redis.set(SETTINGS_KEY, JSON.stringify(settings));
  return settings;
}

function localClock(timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date()).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
  return { hour: Number(parts.hour), minute: Number(parts.minute) };
}

function minuteStamp(timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date()).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export async function heartbeat(redis) {
  const settings = await getSettings(redis);
  const clock = localClock(settings.timezone);
  const stamp = minuteStamp(settings.timezone);
  const due = settings.schedules.filter((s) => s.enabled && s.time === `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`);

  for (const schedule of due) {
    const lock = `daily-report:schedule:${schedule.id}:${stamp}`;
    if (await redis.set(lock, '1', 'EX', 360, 'NX') !== 'OK') continue;
    if (schedule.mode === 'prepare') {
      await prepareReport(redis, { trigger: `scheduled:${schedule.id}` });
    }
  }

  return { settings, dueSchedules: due };
}

if (process.argv[1]?.endsWith('scheduler.js')) {
  const redis = redisFromEnv();
  heartbeat(redis).finally(() => redis.quit());
}
