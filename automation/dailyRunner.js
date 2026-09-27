import Redis from 'ioredis';
import { createBrowser, loadAnswers, fillAndVerify, dateTimeIST, todayIST } from './reportCore.js';

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) throw new Error('REDIS_URL is required.');

const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });

const stateTtl = Number(process.env.STATE_TTL_SECONDS || 604800);
const historyTtl = Number(process.env.HISTORY_TTL_SECONDS || 7776000);
const pollSeconds = Number(process.env.APPROVAL_POLL_SECONDS || 5);

function stateKey(date) {
  return `daily-report:state:${date}`;
}

function historyKey() {
  return 'daily-report:history';
}

async function writeState(date, patch) {
  const key = stateKey(date);
  const existingRaw = await redis.get(key);
  const existing = existingRaw ? JSON.parse(existingRaw) : {};
  const next = {
    ...existing,
    ...patch,
    date,
    updatedAt: new Date().toISOString(),
    updatedAtIST: dateTimeIST()
  };
  await redis.set(key, JSON.stringify(next), 'EX', stateTtl);
  await redis.zadd(historyKey(), Date.now(), date);
  await redis.expire(historyKey(), historyTtl);
  return next;
}

async function readState(date) {
  const raw = await redis.get(stateKey(date));
  return raw ? JSON.parse(raw) : null;
}

function cutoffTimestampUTC() {
  const now = new Date();
  const tz = process.env.TIMEZONE || 'Asia/Kolkata';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);

  const year = Number(parts.find((p) => p.type === 'year').value);
  const month = Number(parts.find((p) => p.type === 'month').value);
  const day = Number(parts.find((p) => p.type === 'day').value);
  const hour = Number(process.env.CUTOFF_HOUR_IST || 20);
  const minute = Number(process.env.CUTOFF_MINUTE_IST || 58);

  // India is UTC+05:30. Keep this explicit because the project timezone is fixed to Asia/Kolkata.
  return Date.UTC(year, month - 1, day, hour - 5, minute - 30, 0);
}

async function main() {
  const date = todayIST();
  const existing = await readState(date);

  if (existing?.status === 'SUBMITTED') {
    console.log(`[DAILY] ${date} already submitted. Nothing to do.`);
    return;
  }

  if (existing?.status === 'RUNNING' || existing?.status === 'AWAITING_REVIEW' || existing?.status === 'APPROVED' || existing?.status === 'SUBMITTING') {
    console.log(`[DAILY] Existing active state is ${existing.status}. Exiting to avoid duplicate runs.`);
    return;
  }

  const report = await loadAnswers();
  const runStartedAt = new Date().toISOString();

  await writeState(date, {
    status: 'RUNNING',
    bucket: report.bucket,
    missing: report.missing,
    answers: report.answers,
    runStartedAt
  });

  let browser;

  try {
    const allowSubmit = String(process.env.ALLOW_SUBMIT || 'false').toLowerCase() === 'true';
    if (!allowSubmit) {
      console.warn('[DAILY] ALLOW_SUBMIT=false. The run will fill and wait, but will never submit.');
    }

    browser = await createBrowser();
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);

    console.log('[DAILY] Opening Microsoft Forms');
    await page.goto(report.formUrl, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);

    console.log('[DAILY] Filling and verifying fields');
    const results = await fillAndVerify(page, report.answers);

    await writeState(date, {
      status: 'AWAITING_REVIEW',
      fieldResults: results,
      formUrl: report.formUrl,
      approvalRequired: true,
      allowSubmit,
      cutoffAt: new Date(cutoffTimestampUTC()).toISOString()
    });

    console.log(`[DAILY] Awaiting approval until ${process.env.CUTOFF_HOUR_IST || 20}:${String(process.env.CUTOFF_MINUTE_IST || 58).padStart(2, '0')} IST.`);

    while (Date.now() < cutoffTimestampUTC()) {
      await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000));

      const state = await readState(date);
      if (!state) continue;

      if (state.status === 'REJECTED') {
        console.log('[DAILY] Review rejected. Closing without submission.');
        return;
      }

      if (state.status === 'APPROVED') {
        if (!allowSubmit) {
          await writeState(date, {
            status: 'READY_BUT_SUBMISSION_DISABLED',
            message: 'Approval was received, but ALLOW_SUBMIT is false. No submission was performed.'
          });
          console.log('[DAILY] Approval received, but submission is disabled.');
          return;
        }

        await writeState(date, { status: 'SUBMITTING' });
        console.log('[DAILY] Approval received. Clicking Submit.');

        const submit = page.getByRole('button', { name: /submit/i });
        if (await submit.count() === 0) {
          throw new Error('Submit button was not found after approval.');
        }

        await submit.first().click();
        await page.waitForTimeout(4000);

        const bodyText = await page.locator('body').innerText();
        const success = /submitted|response has been recorded|thank/i.test(bodyText);

        if (!success) {
          console.warn('[DAILY] Submit click completed, but confirmation text was not detected.');
        }

        await writeState(date, {
          status: success ? 'SUBMITTED' : 'SUBMITTED_UNCONFIRMED',
          submittedAt: new Date().toISOString(),
          confirmationDetected: success
        });

        console.log('[DAILY] Submission flow finished.');
        return;
      }
    }

    await writeState(date, {
      status: 'EXPIRED',
      message: 'No approval was received before the daily cutoff. Nothing was submitted.'
    });
    console.log('[DAILY] Cutoff reached. Nothing was submitted.');
  } catch (error) {
    await writeState(date, {
      status: 'FAILED',
      error: error?.message || String(error)
    }).catch(() => {});

    throw error;
  } finally {
    if (browser?.isConnected()) await browser.close();
    await redis.quit();
  }
}

main().catch((error) => {
  console.error('[DAILY][ERROR]', error?.stack || error);
  process.exit(1);
});
