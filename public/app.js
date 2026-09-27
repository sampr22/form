const csrf = document.querySelector('meta[name="csrf-token"]').content;
const approveBtn = document.getElementById('approveBtn');
const rejectBtn = document.getElementById('rejectBtn');
const statusBadge = document.getElementById('statusBadge');
const countdown = document.getElementById('countdown');
const todayEl = document.getElementById('today');
const timezoneEl = document.getElementById('timezone');
const updatedAtEl = document.getElementById('updatedAt');
const answersEl = document.getElementById('answers');
const historyEl = document.getElementById('history');
const warningEl = document.getElementById('warning');

let lastState = null;

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function statusClass(status) {
  const map = {
    SUBMITTED: 'success',
    SUBMITTED_UNCONFIRMED: 'success',
    AWAITING_REVIEW: 'warning',
    APPROVED: 'warning',
    SUBMITTING: 'warning',
    RUNNING: 'info',
    REJECTED: 'danger',
    EXPIRED: 'danger',
    FAILED: 'danger',
    READY_BUT_SUBMISSION_DISABLED: 'danger'
  };
  return map[status] || 'neutral';
}

function prettyStatus(status) {
  return String(status || 'NO REPORT').replaceAll('_', ' ');
}

function renderAnswers(state) {
  if (!state?.answers?.length) {
    answersEl.innerHTML = '<div class="empty">No report is prepared yet.</div>';
    return;
  }

  answersEl.innerHTML = state.answers.map((item, i) => {
    const missing = !String(item.value ?? '').trim();
    return `
      <article class="answer ${missing ? 'missing' : ''}">
        <div class="answer-no">${i + 1}</div>
        <div class="answer-body">
          <div class="answer-key">${esc(item.key)}</div>
          <div class="answer-value">${missing ? '<span class="blank">BLANK</span>' : esc(item.value)}</div>
        </div>
      </article>`;
  }).join('');
}

function renderState(data) {
  todayEl.textContent = data.today || '—';
  timezoneEl.textContent = data.timezone || '—';

  const state = data.state;
  lastState = state;

  statusBadge.className = `status ${statusClass(state?.status)}`;
  statusBadge.textContent = prettyStatus(state?.status);

  updatedAtEl.textContent = state?.updatedAtIST ? `Updated ${state.updatedAtIST}` : 'No update yet';

  renderAnswers(state);

  const missing = state?.missing || [];
  if (missing.length) {
    warningEl.classList.remove('hidden');
    warningEl.innerHTML = `<strong>${missing.length} field(s) are blank.</strong> Review them carefully before approving: ${missing.map(esc).join(', ')}`;
  } else if (data.allowSubmit === false) {
    warningEl.classList.remove('hidden');
    warningEl.innerHTML = '<strong>Safety lock is ON.</strong> ALLOW_SUBMIT is false, so Approve & Submit is intentionally disabled until you enable submission in Render.';
  } else {
    warningEl.classList.add('hidden');
  }

  const canReview = state?.status === 'AWAITING_REVIEW' && data.allowSubmit === true;
  approveBtn.disabled = !canReview;
  rejectBtn.disabled = !['RUNNING', 'AWAITING_REVIEW'].includes(state?.status);

  if (!state?.cutoffAt) {
    countdown.textContent = 'No cutoff scheduled';
  }

  renderHistory(data.history || []);
}

function renderHistory(items) {
  if (!items.length) {
    historyEl.innerHTML = '<tr><td colspan="4">No previous runs recorded.</td></tr>';
    return;
  }

  historyEl.innerHTML = items.map((item) => `
    <tr>
      <td>${esc(item.date)}</td>
      <td><span class="pill ${statusClass(item.status)}">${esc(prettyStatus(item.status))}</span></td>
      <td>${esc(item.updatedAtIST || '—')}</td>
      <td>${esc(item.message || item.error || (item.missing?.length ? `Missing: ${item.missing.length}` : '—'))}</td>
    </tr>
  `).join('');
}

async function refresh() {
  try {
    const response = await fetch('/api/status', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to load status.');
    renderState(data);
  } catch (error) {
    warningEl.classList.remove('hidden');
    warningEl.textContent = `Dashboard error: ${error.message}`;
  }
}

async function action(endpoint, confirmText) {
  if (!confirm(confirmText)) return;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf
    },
    body: '{}'
  });

  const data = await response.json();
  if (!response.ok) {
    alert(data.error || 'Action failed.');
    return;
  }

  await refresh();
}

approveBtn.addEventListener('click', () =>
  action('/api/approve', 'I have reviewed all 23 fields and want the automation to submit this report now.')
);

rejectBtn.addEventListener('click', () =>
  action('/api/reject', 'Reject today’s report? Nothing will be submitted.')
);

document.getElementById('refreshBtn').addEventListener('click', refresh);

function tickCountdown() {
  if (!lastState?.cutoffAt) return;
  const diff = new Date(lastState.cutoffAt).getTime() - Date.now();
  if (diff <= 0) {
    countdown.textContent = 'Cutoff reached';
    return;
  }
  const total = Math.floor(diff / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  countdown.textContent = `Cutoff in ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

refresh();
setInterval(refresh, 5000);
setInterval(tickCountdown, 1000);
