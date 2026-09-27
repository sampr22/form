import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const answersPath = path.join(here, '../config/reportAnswers.json');

const requiredConstants = [
  'q1_employeeName',
  'q3_designation',
  'q4_reportingTo',
  'q6_metWeeklyDailyTargets',
  'q9_newMethodDevOrValidation',
  'q11_preparedOrReviewedSOPs',
  'q12_submittedReportsToOtherDepts',
  'q13_departmentsCollaboratedWith',
  'q16_trainingProvidedToJuniors',
  'q17_tasksPendingFromLastWeek',
  'q19_completedUrgentAssignments',
  'q20_processImprovementWork',
  'q21_challengesFaced',
  'q22_supportResourcesNeeded',
  'q23_timeConsumptionPerActivity'
];

const requiredDaily = [
  'q2_reportingPeriod',
  'q5_projectsExperimentsCompleted',
  'q7_experimentsAnalysesTestsPerformed',
  'q8_samplesReportsCompleted',
  'q10_methodProjectDescription',
  'q14_meetingsTrainingAttended',
  'q15_meetingTrainingTopic',
  'q18_carriedForwardTasks'
];

const raw = await readFile(answersPath, 'utf8');
const data = JSON.parse(raw);

for (const key of requiredConstants) {
  if (!(key in data.constants)) throw new Error(`Missing constants.${key}`);
}
for (const bucket of ['weekday', 'friday']) {
  for (const key of requiredDaily) {
    if (!(key in data[bucket])) throw new Error(`Missing ${bucket}.${key}`);
  }
}

console.log('Config OK.');
console.log('Constant answers:', requiredConstants.length);
console.log('Weekday fields:', requiredDaily.length);
console.log('Friday fields:', requiredDaily.length);
console.log('Blank weekday fields:', requiredDaily.filter(k => !String(data.weekday[k]).trim()));
console.log('Blank Friday fields:', requiredDaily.filter(k => !String(data.friday[k]).trim()));
