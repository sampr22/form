import { chromium } from 'playwright';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS_PATH = path.join(__dirname, '../config/reportAnswers.json');
const APP_PATH = path.join(__dirname, '../config/app.json');

export const FIELD_ORDER = [
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

export function todayIST() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.TIMEZONE || 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

export function dateTimeIST(date = new Date()) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: process.env.TIMEZONE || 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'medium'
  }).format(date);
}

export function isFridayIST() {
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone: process.env.TIMEZONE || 'Asia/Kolkata',
    weekday: 'short'
  }).format(new Date());
  return day === 'Fri';
}

export async function loadAnswers() {
  const [answersRaw, appRaw] = await Promise.all([
    readFile(ANSWERS_PATH, 'utf8'),
    readFile(APP_PATH, 'utf8')
  ]);

  const data = JSON.parse(answersRaw);
  const app = JSON.parse(appRaw);
  const dailyBucket = isFridayIST() ? data.friday : data.weekday;

  const answers = FIELD_ORDER.map(({ key, bucket }) => ({
    key,
    value: String(bucket === 'constants' ? data.constants[key] : dailyBucket[key] ?? '')
  }));

  const missing = answers.filter((item) => !item.value.trim()).map((item) => item.key);

  return {
    answers,
    missing,
    bucket: isFridayIST() ? 'friday' : 'weekday',
    timezone: process.env.TIMEZONE || app.timezone || 'Asia/Kolkata',
    formUrl:
      process.env.FORM_URL ||
      'https://forms.cloud.microsoft/pages/responsepage.aspx?id=0AXnVXRck0GwwTa-4NQ-bvGJJtgnRZ5Fseet11Dp2IdUNDM3UUNaSVQySjBDSzc5WExJUzVOM0lLNS4u&origin=lprLink&route=shorturl'
  };
}

export async function fillAndVerify(page, answers) {
  const textboxes = await page.getByRole('textbox').all();

  if (textboxes.length !== answers.length) {
    throw new Error(`Expected ${answers.length} form textboxes, found ${textboxes.length}. The form may have changed.`);
  }

  const results = [];
  for (let i = 0; i < textboxes.length; i++) {
    const { key, value } = answers[i];
    await textboxes[i].fill(value);
    const confirmed = await textboxes[i].inputValue();
    const ok = confirmed === value;
    results.push({ index: i + 1, key, expected: value, actual: confirmed, ok });
    if (!ok) throw new Error(`Field verification failed for ${key}.`);
  }

  return results;
}

export async function createBrowser() {
  return chromium.launch({ headless: true });
}
