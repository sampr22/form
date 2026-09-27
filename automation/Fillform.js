// Local/manual fill-only script.
// Fills the Microsoft Form but NEVER clicks Submit.

import { chromium } from 'playwright';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS_PATH = path.join(__dirname, '../config/reportAnswers.json');
const FORM_URL =
  process.env.FORM_URL ||
  'https://forms.cloud.microsoft/pages/responsepage.aspx?id=0AXnVXRck0GwwTa-4NQ-bvGJJtgnRZ5Fseet11Dp2IdUNDM3UUNaSVQySjBDSzc5WExJUzVOM0lLNS4u&origin=lprLink&route=shorturl';

const FIELD_ORDER = [
  { key: 'q1_employeeName', bucket: 'constants' },
  { key: 'q2_reportingPeriod', bucket: 'daily' },
  { key: 'q3_designation', bucket: 'constants' },
  { key: 'q4_reportingTo', bucket: 'constants' },
  { key: 'q5_projectsExperimentsCompleted', bucket: 'daily' },
  { key: 'q6_metWeeklyDailyTargets', bucket: 'constants' },
  { key: 'q7_experimentsAnalysesTestsPerformed', bucket: 'daily' },
  { key: 'q8_samplesReportsCompleted', bucket: 'daily' },
  { key: 'q9_newMethodDevOrValidation', bucket: 'constants' },
  { key: 'q10_methodProjectDescription', bucket: 'daily' },
  { key: 'q11_preparedOrReviewedSOPs', bucket: 'constants' },
  { key: 'q12_submittedReportsToOtherDepts', bucket: 'constants' },
  { key: 'q13_departmentsCollaboratedWith', bucket: 'constants' },
  { key: 'q14_meetingsTrainingAttended', bucket: 'daily' },
  { key: 'q15_meetingTrainingTopic', bucket: 'daily' },
  { key: 'q16_trainingProvidedToJuniors', bucket: 'constants' },
  { key: 'q17_tasksPendingFromLastWeek', bucket: 'constants' },
  { key: 'q18_carriedForwardTasks', bucket: 'daily' },
  { key: 'q19_completedUrgentAssignments', bucket: 'constants' },
  { key: 'q20_processImprovementWork', bucket: 'constants' },
  { key: 'q21_challengesFaced', bucket: 'constants' },
  { key: 'q22_supportResourcesNeeded', bucket: 'constants' },
  { key: 'q23_timeConsumptionPerActivity', bucket: 'constants' }
];

function isFriday() {
  return new Date().getDay() === 5;
}

async function buildAnswerList() {
  const raw = await readFile(ANSWERS_PATH, 'utf8');
  const data = JSON.parse(raw);
  const dailyBucket = isFriday() ? data.friday : data.weekday;

  return FIELD_ORDER.map(({ key, bucket }) => {
    const value = bucket === 'constants' ? data.constants[key] : dailyBucket[key];
    return { key, value: value ?? '' };
  });
}

async function fillForm() {
  const answers = await buildAnswerList();
  const missing = answers.filter((a) => !String(a.value).trim());

  if (missing.length) {
    console.log('[REPORT] Empty fields:');
    missing.forEach((m) => console.log(`  - ${m.key}`));
  }

  console.log('[FORM] Launching browser (headed)');
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  try {
    console.log('[FORM] Opening Microsoft Forms');
    await page.goto(FORM_URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);

    const textboxes = await page.getByRole('textbox').all();
    if (textboxes.length !== answers.length) {
      throw new Error(`Expected ${answers.length} textboxes, found ${textboxes.length}. Form may have changed.`);
    }

    console.log(`[FORM] Filling ${textboxes.length} fields...`);
    for (let i = 0; i < textboxes.length; i++) {
      const { key, value } = answers[i];
      await textboxes[i].fill(String(value));
      const confirmed = await textboxes[i].inputValue();
      const ok = confirmed === String(value);
      console.log(`  [${i + 1}/${textboxes.length}] ${key}: ${ok ? 'OK' : 'MISMATCH'}`);
      if (!ok) throw new Error(`Verification failed for ${key}.`);
    }

    console.log('[FORM] All fields filled.');
    console.log('[FORM] Submit was NOT clicked.');
    console.log('[FORM] Review the browser manually, then close it.');
    await new Promise((resolve) => browser.on('disconnected', resolve));
  } finally {
    if (browser.isConnected()) await browser.close();
  }
}

fillForm().catch((err) => {
  console.error('[ERROR]', err.message || err);
  process.exit(1);
});
