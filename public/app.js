const csrf = document.querySelector('meta[name="csrf-token"]').content;
const $ = (id) => document.getElementById(id);
const el = {
  startBtn:$('startBtn'), runNowBtn:$('runNowBtn'), refreshBtn:$('refreshBtn'), today:$('today'), timezone:$('timezone'),
  serverTime:$('serverTime'), statusBadge:$('statusBadge'), statusTitle:$('statusTitle'), progressBar:$('progressBar'),
  progressPercent:$('progressPercent'), progressCount:$('progressCount'), progressMessage:$('progressMessage'),
  cutoff:$('cutoff'), answers:$('answers'), answerCount:$('answerCount'), approveBtn:$('approveBtn'), rejectBtn:$('rejectBtn'),
  notice:$('notice'), lockText:$('lockText'), lockHint:$('lockHint'), nextSchedule:$('nextSchedule'),
  cutoffInput:$('cutoffInput'), scheduleList:$('scheduleList'), saveSettingsBtn:$('saveSettingsBtn'), saveStatus:$('saveStatus'),
  history:$('history')
};
let state=null, settings=null, lastAllowSubmit=false;

function esc(v){return String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'","&#039;");}
function statusClass(s){return({SUBMITTED:'success',SUBMITTED_UNCONFIRMED:'success',AWAITING_REVIEW:'review',RUNNING:'running',SUBMITTING:'running',REJECTED:'danger',FAILED:'danger',EXPIRED:'danger'})[s]||'neutral';}
function statusTitle(s){return({AWAITING_REVIEW:'Ready for your review',RUNNING:'Preparing your report',SUBMITTING:'Submitting safely',SUBMITTED:'Report submitted',SUBMITTED_UNCONFIRMED:'Submitted — confirmation unclear',REJECTED:'Run rejected',FAILED:'Something needs attention',EXPIRED:'Approval window expired'})[s]||'Waiting for a report run';}
function post(url,body={}){return fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(body)}).then(async r=>{const d=await r.json();if(!r.ok)throw new Error(d.error||'Request failed.');return d;});}
function renderSteps(s){
  const stage=s==='SUBMITTED'||s==='SUBMITTED_UNCONFIRMED'?'submit':s==='AWAITING_REVIEW'?'review':s==='RUNNING'?'fill':s==='SUBMITTING'?'submit':'prepare';
  const map={prepare:1,fill:2,review:3,submit:4}; const active=map[stage]||1;
  for(let i=1;i<=4;i++) $('step'+i).classList.toggle('active',i<=active);
}
function renderAnswers(s){
  if(!s?.answers?.length){el.answers.innerHTML='<div class="empty">No report prepared yet.</div>';el.answerCount.textContent='0 / 23 verified';return;}
  const verified=s.fieldResults?.filter(x=>x.ok)?.length||0;
  const done=s.status==='AWAITING_REVIEW'||s.status?.startsWith('SUBMITTED')?s.answers.length:verified;
  el.answerCount.textContent=`${done} / ${s.answers.length} verified`;
  el.answers.innerHTML=s.answers.map((item,i)=>{const result=s.fieldResults?.find(x=>x.index===i+1);const ok=result?.ok||done===s.answers.length&&s.status==='AWAITING_REVIEW';const blank=!String(item.value??'').trim();return `<article class="answer ${blank?'missing':''}"><div class="qno">${String(i+1).padStart(2,'0')}</div><div><div class="qkey">${esc(item.key)}</div><div class="qvalue">${blank?'<span class="blank">Blank</span>':esc(item.value)}</div></div><div class="check ${ok?'ok':''}">${ok?'✓':'·'}</div></article>`;}).join('');
}
function renderSchedules(list){
  el.scheduleList.innerHTML=list.map(s=>`<div class="schedule-row" data-id="${esc(s.id)}"><label class="switch"><input class="enabled" type="checkbox" ${s.enabled?'checked':''}><span></span></label><input class="label-input" value="${esc(s.label)}" maxlength="80"><input class="time-input" type="time" step="300" value="${esc(s.time)}"><select class="mode-input"><option value="prepare" ${s.mode==='prepare'?'selected':''}>Prepare report</option><option value="reminder" ${s.mode==='reminder'?'selected':''}>Reminder</option></select><button class="remove-btn" title="Remove timing">×</button></div>`).join('');
  el.scheduleList.querySelectorAll('.remove-btn').forEach(btn=>btn.onclick=()=>btn.closest('.schedule-row').remove());
}
function collectSettings(){
  return {timezone:'Asia/Kolkata',cutoffTime:el.cutoffInput.value,schedules:[...el.scheduleList.querySelectorAll('.schedule-row')].map((row,i)=>({id:row.dataset.id||`schedule-${Date.now()}-${i}`,label:row.querySelector('.label-input').value.trim()||`Timing ${i+1}`,time:row.querySelector('.time-input').value,enabled:row.querySelector('.enabled').checked,mode:row.querySelector('.mode-input').value}))};
}
function nextSchedule(list){
  const now=new Date();const current=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit',hour12:false}).format(now).replace(':',''));return list.filter(s=>s.enabled).sort((a,b)=>{const am=Number(a.time.replace(':','')),bm=Number(b.time.replace(':',''));const ad=am>=current?am-current:2400-current+am;const bd=bm>=current?bm-current:2400-current+bm;return ad-bd;})[0];
}
function render(data){
  state=data.state;settings=data.settings;lastAllowSubmit=data.allowSubmit;
  el.today.textContent=data.today;el.timezone.textContent=data.timezone;el.serverTime.textContent=data.serverTime;
  const s=state?.status;el.statusBadge.className=`status ${statusClass(s)}`;el.statusBadge.textContent=String(s||'IDLE').replaceAll('_',' ');
  el.statusTitle.textContent=statusTitle(s);
  const p=state?.progress||{percent:0,completed:0,total:23,current:'Press “Start today’s report” to begin.'};
  el.progressBar.style.width=`${p.percent||0}%`;el.progressPercent.textContent=`${p.percent||0}%`;el.progressCount.textContent=`${p.completed||0} / ${p.total||23}`;el.progressMessage.textContent=p.current||'';
  renderSteps(s);renderAnswers(state);
  el.cutoff.textContent=`${settings.cutoffTime} IST`;
  const active=['RUNNING','SUBMITTING'].includes(s),review=s==='AWAITING_REVIEW',finished=['SUBMITTED','SUBMITTED_UNCONFIRMED','REJECTED'].includes(s);
  el.startBtn.disabled=active||review||finished;el.startBtn.textContent=active?'Run in progress…':review?'Review below ↓':finished?'Run complete':'Start today’s report  →';
  el.approveBtn.disabled=!(review&&data.allowSubmit);el.rejectBtn.disabled=!['RUNNING','AWAITING_REVIEW'].includes(s);
  el.lockText.textContent=data.allowSubmit?'SUBMISSION ENABLED':'SUBMISSION BLOCKED';
  el.lockHint.textContent=data.allowSubmit?'Final approval can submit the form.':'Set ALLOW_SUBMIT=true in Render only after testing.';
  const n=nextSchedule(settings.schedules);el.nextSchedule.innerHTML=n?`<strong>${esc(n.time)} IST</strong><span>${esc(n.label)}</span>`:'<span>No enabled timings</span>';
  el.cutoffInput.value=settings.cutoffTime;renderSchedules(settings.schedules);
  const missing=state?.missing||[];if(missing.length){el.notice.className='notice';el.notice.innerHTML=`<strong>${missing.length} blank field(s)</strong> — check them before approval.`;}else if(data.allowSubmit===false){el.notice.className='notice';el.notice.innerHTML='<strong>Safety lock is ON.</strong> The Submit action is intentionally blocked.';}else el.notice.className='notice hidden';
  el.history.innerHTML=(data.history||[]).map(item=>`<tr><td>${esc(item.date)}</td><td><span class="pill ${statusClass(item.status)}">${esc(String(item.status||'').replaceAll('_',' '))}</span></td><td>${esc(item.updatedAtIST||'—')}</td><td>${esc(item.message||item.error||(item.progress?.current||'—'))}</td></tr>`).join('')||'<tr><td colspan="4">No previous runs.</td></tr>';
}
async function refresh(){try{const r=await fetch('/api/status',{cache:'no-store'});const d=await r.json();if(!r.ok)throw new Error(d.error||'Dashboard error');render(d);}catch(e){el.notice.className='notice';el.notice.textContent=e.message;}}
async function start(){try{el.startBtn.disabled=true;await post('/api/run');await refresh();}catch(e){alert(e.message);await refresh();}}
async function approve(){if(!confirm('Review all 23 answers and submit this report?'))return;try{await post('/api/approve');await refresh();}catch(e){alert(e.message);}}
async function reject(){if(!confirm('Reject this run? Nothing will be submitted.'))return;try{await post('/api/reject');await refresh();}catch(e){alert(e.message);}}
async function saveSettings(){try{el.saveSettingsBtn.disabled=true;const d=await post('/api/settings',{settings:collectSettings()});settings=d.settings;el.saveStatus.textContent='Saved';setTimeout(()=>el.saveStatus.textContent='',1800);await refresh();}catch(e){alert(e.message);}finally{el.saveSettingsBtn.disabled=false;}}
el.startBtn.onclick=start;el.approveBtn.onclick=approve;el.rejectBtn.onclick=reject;el.refreshBtn.onclick=refresh;
el.runNowBtn.onclick=async()=>{try{await post('/api/scheduler/run-now');await refresh();}catch(e){alert(e.message);}};
$('addTimingBtn').onclick=()=>{const current=collectSettings().schedules;current.push({id:`schedule-${Date.now()}`,label:'New timing',time:'20:30',enabled:true,mode:'reminder'});renderSchedules(current);};
el.saveSettingsBtn.onclick=saveSettings;$('scrollSettings').onclick=()=>document.getElementById('settingsSection').scrollIntoView({behavior:'smooth'});
refresh();setInterval(refresh,2000);