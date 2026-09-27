import { createBrowser, fillAndVerify, loadAnswers, todayIST } from './reportCore.js';

const STATE_TTL = Number(process.env.STATE_TTL_SECONDS || 604800);
const HISTORY_TTL = Number(process.env.HISTORY_TTL_SECONDS || 7776000);

function key(date = todayIST()) { return `daily-report:state:${date}`; }

async function readState(redis, date = todayIST()) {
  const raw = await redis.get(key(date));
  return raw ? JSON.parse(raw) : null;
}

async function writeState(redis, patch, date = todayIST()) {
  const raw = await redis.get(key(date));
  const current = raw ? JSON.parse(raw) : {};
  const next = {
    ...current,
    ...patch,
    date,
    updatedAt: new Date().toISOString(),
    updatedAtIST: new Intl.DateTimeFormat('en-GB', {
      timeZone: process.env.TIMEZONE || 'Asia/Kolkata',
      dateStyle: 'medium',
      timeStyle: 'medium'
    }).format(new Date())
  };
  await redis.set(key(date), JSON.stringify(next), 'EX', STATE_TTL);
  await redis.zadd('daily-report:history', Date.now(), date);
  await redis.expire('daily-report:history', HISTORY_TTL);
  return next;
}

export async function prepareReport(redis, { trigger = 'manual' } = {}) {
  const date = todayIST();
  const existing = await readState(redis, date);
  if (['RUNNING', 'AWAITING_REVIEW', 'SUBMITTING', 'SUBMITTED'].includes(existing?.status)) return existing;

  const runLock = `daily-report:run-lock:${date}`;
  if (await redis.set(runLock, '1', 'EX', 300, 'NX') !== 'OK') return await readState(redis, date);

  const report = await loadAnswers();
  await writeState(redis, {
    status: 'RUNNING',
    trigger,
    bucket: report.bucket,
    missing: report.missing,
    answers: report.answers,
    formUrl: report.formUrl,
    approvalRequired: true,
    startedAt: new Date().toISOString(),
    progress: { stage: 'loading', percent: 5, completed: 0, total: report.answers.length, current: "Loading today's report…" }
  }, date);

  let browser;
  try {
    browser = await createBrowser();
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);

    await writeState(redis, {
      progress: { stage: 'opening', percent: 15, completed: 0, total: report.answers.length, current: 'Opening Microsoft Forms…' }
    }, date);

    await page.goto(report.formUrl, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);

    const results = await fillAndVerify(page, report.answers, async ({ index, total, key: fieldKey }) => {
      await writeState(redis, {
        progress: {
          stage: 'filling',
          percent: 20 + Math.round((index / total) * 65),
          completed: index,
          total,
          current: `Filled and verified Q${index}: ${fieldKey}`
        }
      }, date);
    });

    return await writeState(redis, {
      status: 'AWAITING_REVIEW',
      fieldResults: results,
      progress: { stage: 'review', percent: 100, completed: report.answers.length, total: report.answers.length, current: 'All 23 fields are filled and verified. Review before submitting.' },
      lastRunCompletedAt: new Date().toISOString()
    }, date);
  } catch (error) {
    await writeState(redis, {
      status: 'FAILED',
      error: error?.message || String(error),
      progress: { stage: 'failed', percent: 100, completed: 0, total: report.answers.length, current: error?.message || String(error) }
    }, date);
    throw error;
  } finally {
    if (browser?.isConnected()) await browser.close();
    await redis.del(runLock);
  }
}

export async function submitApprovedReport(redis) {
  const date = todayIST();
  const state = await readState(redis, date);
  if (!state || state.status !== 'AWAITING_REVIEW') throw new Error(`Cannot submit while status is ${state?.status || 'NO_REPORT'}.`);
  if (String(process.env.ALLOW_SUBMIT || 'false').toLowerCase() !== 'true') throw new Error('Submission is safety-disabled. Set ALLOW_SUBMIT=true in Render after testing.');

  const lock = `daily-report:submit-lock:${date}`;
  if (await redis.set(lock, '1', 'EX', 300, 'NX') !== 'OK') throw new Error('A submission is already in progress.');

  let browser;
  try {
    await writeState(redis, {
      status: 'SUBMITTING',
      progress: { stage: 'submitting', percent: 92, completed: state.answers.length, total: state.answers.length, current: 'Re-opening the form for final submission…' }
    }, date);

    browser = await createBrowser();
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    await page.goto(state.formUrl, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    await fillAndVerify(page, state.answers);

    const submit = page.getByRole('button', { name: /submit/i });
    if (await submit.count() === 0) throw new Error('Submit button was not found.');
    await submit.first().click();
    await page.waitForTimeout(3500);

    const bodyText = await page.locator('body').innerText();
    const confirmed = /submitted|response has been recorded|thank/i.test(bodyText);

    return await writeState(redis, {
      status: confirmed ? 'SUBMITTED' : 'SUBMITTED_UNCONFIRMED',
      progress: { stage: 'complete', percent: 100, completed: state.answers.length, total: state.answers.length, current: confirmed ? 'Report submitted successfully.' : 'Submit was clicked; confirmation text was not detected.' },
      submittedAt: new Date().toISOString(),
      confirmationDetected: confirmed
    }, date);
  } catch (error) {
    await writeState(redis, {
      status: 'FAILED',
      error: error?.message || String(error),
      progress: { stage: 'failed', percent: 100, completed: state.answers.length, total: state.answers.length, current: error?.message || String(error) }
    }, date);
    throw error;
  } finally {
    if (browser?.isConnected()) await browser.close();
    await redis.del(lock);
  }
}

export async function rejectReport(redis) {
  const date = todayIST();
  const state = await readState(redis, date);
  if (!state || !['RUNNING', 'AWAITING_REVIEW'].includes(state.status)) throw new Error(`Cannot reject while status is ${state?.status || 'NO_REPORT'}.`);
  return await writeState(redis, {
    status: 'REJECTED',
    progress: { stage: 'rejected', percent: 100, completed: state.progress?.completed || 0, total: state.answers?.length || 23, current: 'Rejected. Nothing was submitted.' },
    rejectedAt: new Date().toISOString()
  }, date);
}
