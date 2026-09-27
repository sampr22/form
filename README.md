# Daily Report Link — Render Edition

This project automates the daily Microsoft Forms report while keeping one hard safety gate:

> **The report is never submitted until you open the dashboard and explicitly approve it.**

## What is included

- Local fill-only automation (`automation/Fillform.js`)
- Form inspection utility (`automation/inspectForm.js`)
- Headless Render runner (`automation/dailyRunner.js`)
- Shared form/answer logic (`automation/reportCore.js`)
- Review dashboard (`review/server.js` + `public/`)
- Current report answer data (`config/reportAnswers.json`)
- Render Blueprint (`render.yaml`)
- Config validation (`scripts/validate-config.js`)
- Git-safe environment template (`.env.example`)

## Daily workflow

1. Render Cron starts at **20:00 IST** (14:30 UTC).
2. Chromium opens the Microsoft Form in headless mode.
3. All 23 discovered textboxes are filled and verified.
4. Status becomes `AWAITING_REVIEW`.
5. The dashboard shows all 23 values, blank-field warnings, current status, countdown and recent run history.
6. You review the report and choose **Approve & Submit** or **Reject / Do Not Submit**.
7. If approved before **20:58 IST**, the runner clicks Submit.
8. If you do nothing until 20:58 IST, status becomes `EXPIRED` and nothing is submitted.

## First deployment safety

`ALLOW_SUBMIT=false` is intentionally configured in `render.yaml`.

Deploy and test the dashboard first. Once you have verified that:
- the cron fills the form,
- the dashboard displays the values,
- approval/rejection changes the status,
- no unwanted Submit click occurs,

set `ALLOW_SUBMIT=true` for **both** the web and cron services in Render.

## Local setup

```powershell
npm install
npx playwright install chromium
npm run validate
npm run inspect
npm run fill
```

The local `fill` script never submits.

## Render setup

1. Push the folder to a Git repository.
2. In Render, choose **New → Blueprint** and connect the repo.
3. Render will create:
   - `daily-report-dashboard` web service
   - `daily-report-runner` cron job
   - `daily-report-kv` Key Value
4. Enter `REVIEW_USER` and `REVIEW_PASSWORD` when prompted.
5. Keep `ALLOW_SUBMIT=false` for the first test.
6. Open the generated dashboard URL and check the live status.
7. After testing, set `ALLOW_SUBMIT=true` on both services.

Render cron schedules use UTC. The bundled schedule `30 14 * * *` corresponds to 20:00 in India Standard Time (UTC+05:30).

## Dashboard

The web service shows:
- today's report status
- live countdown to the daily cutoff
- all 23 answer values
- highlighted blank fields
- recent status history
- explicit approve/reject controls
- safety-lock state

The dashboard is protected with HTTP Basic Authentication using `REVIEW_USER` and `REVIEW_PASSWORD`.

## Important deployment notes

- Render Cron jobs run in an ephemeral environment and cannot use persistent disks. This project therefore stores the cross-service approval state in Render Key Value.
- The bundled Key Value is configured as free + non-persistent. That is fine for current-day approval state, but long-term history can be lost if the Key Value instance is upgraded/recreated.
- The Cron job intentionally stays alive while waiting for approval. Render currently allows a cron run to stay active for up to 12 hours, so the roughly one-hour approval window is well inside that limit.
- If Microsoft Forms changes its field structure, the runner stops before submission and marks the run `FAILED`.

## Security

- Do not commit `.env` files or credentials.
- Change the dashboard password before production use.
- Keep `ALLOW_SUBMIT=false` while validating a new deployment.
- Treat the Microsoft Forms URL as application configuration and rotate it if the form changes.
