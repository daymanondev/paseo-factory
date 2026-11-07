'use strict';
/* Scrum presentation state is scoped to the Host, Project and run. All seeded data is illustrative. */
const scrumStageDefs=[
 {id:'planning',number:1,title:'PM / Analyst',roles:['pm'],artifacts:['prd.md','sprint-backlog.md']},
 {id:'design',number:2,title:'UX ∥ Architect',roles:['ux','architect'],artifacts:['ux-spec.md','DESIGN.md','EXPERIENCE.md','mockups/index.html','mockups/screens.html','mockups/design-manifest.json','architecture.md']},
 {id:'readiness',number:3,title:'Readiness & UI Gate',roles:[],artifacts:[]},
 {id:'implementation',number:4,title:'Senior Dev',roles:['dev'],artifacts:[]},
 {id:'qa',number:5,title:'QA Audit & Fix Loop',roles:['qa'],artifacts:['qa-report.json','qa-report.md']}
];
const scrumRoleLabels={pm:'PM',ux:'UX',architect:'ARCH',dev:'DEV',qa:'QA',supervisor:'Supervisor',lead:'Scrum Lead / PO',watch:'Watch & Retro'};
const scrumFrozenExample=Object.fromEntries(['supervisor','lead','pm','ux','architect','dev','qa','watch'].map(id=>[id,{provider:agent(id).provider,model:agent(id).model,thinking:agent(id).thinking||null}]));
const scrumExample={runId:'example-scrum-03',track:'ui',trackReason:'Example UI initiative uses all five specialist stages.',configRevision:3,requireUIApproval:true,frozenRoster:scrumFrozenExample,design:{revision:3,digest:'sample-digest-03',screens:[],captures:[]},readiness:{status:'pending',missingCoverage:['Architecture Task SCR-03 has not completed.']},roleResults:{},createdAt:null};
const scrumExampleUsage=usageAggregate(state.usageExamples.filter(r=>r.hostId==='mac-local'&&r.project==='research-slp'));
const scrumExampleSummary={tokens:usageValue(scrumExampleUsage),cost:state.tasks.filter(t=>t.hostId==='mac-local'&&t.project==='research-slp').reduce((sum,t)=>sum+(Number.isFinite(t.cost)?t.cost:0),0)};
state.scrumUi={};state.scrumPanel=null;
function scrumTasks(){return state.emptyProjects?.has(scopeKey())?[]:scopedTasks().filter(task=>task.mode==='scrum');}
function scrumTaskKey(task){return 'scrum-task-'+encodeURIComponent(task.id);}
function scrumTaskForKey(id){return typeof id==='string'&&id.startsWith('scrum-task-')?scrumTasks().find(task=>scrumTaskKey(task)===id):null;}
function scrumRole(task){return ({PM:'pm',UX:'ux',Arch:'architect',Architect:'architect',Dev:'dev',QA:'qa'})[task?.role]||(['pm','ux','architect','dev','qa'].includes(task?.role)?task.role:task?.agent);}
function scrumSource(){return state.scrumTelemetry?.[scopeKey()]||(scopeKey()==='mac-local::research-slp'?scrumExample:{});}
function scrumRun(){return state.emptyProjects?.has(scopeKey())?{}:scrumSource();}
function scrumUi(){const run=scrumRun(),key=scopeKey()+'|'+(run.runId||'no-run');return state.scrumUi[key]||(state.scrumUi[key]={tabs:{},files:[],drafts:{},decisions:{},answers:{},screenReviews:{},viewport:'desktop',screen:null,screenState:null,allowanceTasks:8,allowanceReason:'',legacyContinued:false});}
function scrumDesignKey(){const d=scrumRun().design||{};return String(d.revision??'—')+'|'+String(d.digest||'—');}
function scrumDecision(){const run=scrumRun(),saved=scrumUi().decisions[scrumDesignKey()];return saved?.decision||run.design?.decision||(run===scrumExample?state.designDecision:null);}
function scrumDecisionLabel(){return ({approve:'Approved',approved:'Approved',changes:'Changes requested',waive:'Waived',waived:'Waived'})[scrumDecision()]||(scrumRun().requireUIApproval===false?'Not required':'Awaiting UI Approval');}
function scrumReadiness(){const data=scrumRun().readiness;return data?.passed===true||data?.status==='pass'||data?.status==='passed'?{label:'Pass',tone:'green'}:data?.status==='blocked'?{label:'Blocked',tone:'red'}:{label:'Pending',tone:'muted'};}
function scrumSkipped(stage){const skipped=scrumRun().skippedPhases;return Array.isArray(skipped)?skipped.find(value=>typeof value==='string'?value===stage:value.phase===stage||value.id===stage):skipped?.[stage];}
function scrumPhase(){
 const run=scrumRun();if(!run.runId)return 'No run started';if(run.phase)return run.phase;
 if(scrumDecision()==='changes')return 'design';
 if(scrumTasks().some(task=>['ux','architect'].includes(scrumRole(task))&&task.status==='running'))return 'design';
 if(scrumReadiness().label!=='Pass')return 'readiness';
 if(run.requireUIApproval!==false&&!['approve','approved','waive','waived'].includes(scrumDecision()))return 'awaiting-ui-approval';
 if(scrumTasks().some(task=>scrumRole(task)==='qa'&&task.status==='running'))return 'qa';
 return 'implementation';
}
function scrumStageState(stage){
 const skip=scrumSkipped(stage.id);if(skip)return {label:'Skipped',tone:'muted',skipped:true};
 const run=scrumRun(),reported=run.stages?.[stage.id];if(reported?.status)return {label:reported.status,tone:reported.status==='Completed'?'green':reported.status==='Blocked'?'amber':'cyan'};
 if(!run.runId)return {label:'Waiting',tone:'muted'};
 const tasks=scrumTasks().filter(task=>stage.roles.includes(scrumRole(task)));
 if(stage.id==='readiness')return {label:scrumReadiness().label==='Pass'&&(run.requireUIApproval===false||['approve','approved','waive','waived'].includes(scrumDecision()))?'Completed':scrumDecisionLabel()==='Awaiting UI Approval'?'Needs you':'Waiting',tone:scrumDecisionLabel()==='Awaiting UI Approval'?'amber':'muted'};
 if(stage.id==='design'&&scrumDecision()==='changes')return {label:'Changes requested',tone:'amber'};
 if(tasks.length&&tasks.every(task=>['accepted','completed'].includes(task.status)))return {label:'Completed',tone:'green'};
 if(tasks.some(task=>task.status==='running'))return {label:stage.id==='design'?'Designing':stage.id==='qa'?(scrumPhase()==='fixing'?'Fixing':'Auditing'):'Running',tone:'cyan'};
 if(tasks.some(task=>task.status==='attention'))return {label:'Blocked',tone:'amber'};
 if(tasks.some(task=>task.status==='ready'))return {label:'Review ready',tone:'green'};
 return {label:'Waiting',tone:'muted'};
}
function scrumTaskSession(task,index=task.attempts.length-1){return index===task.attempts.length-1?task.peerSession||scrumRun().taskResults?.[task.id]?.currentSession||task.attemptDetails?.[index]||{}:task.attemptDetails?.[index]||{};}
function scrumTaskRuntime(task){return scrumRun().taskResults?.[task.id]||{};}
function scrumModel(role,task=null){const session=task?scrumTaskSession(task):{},frozen=scrumRun().frozenRoster?.[role],base=agentDefinitions[role]||{};return {provider:session.provider||frozen?.provider||base.provider,model:session.model||frozen?.model||base.model,thinking:session.thinking||frozen?.thinking||base.thinking};}
function scrumVacant(id){return Boolean(state.emptyProjects?.has(scopeKey())||state.retiredSeats?.has(scopeKey()+':'+id)||scrumRun().seats?.[id]?.vacant);}
function scrumSeatStatus(id){
 if(id==='owner')return {label:'Human',tone:'muted'};if(scrumVacant(id))return {label:'Vacant',tone:'muted'};
 if(id==='lead'){const rotation=leadHandoffState().rotation;if(rotation==='handing_over')return {label:'Handoff',tone:'cyan'};if(rotation==='rotation_pending')return {label:'Rotation pending',tone:'amber'};}
 const status=scrumRun().seats?.[id]?.status||agent(id).status;
 return {label:({running:'Running',idle:'Idle',initializing:'Initializing',error:'Error',attention:'Needs you',transitioning:'Transitioning',closed:'Dormant'})[status]||statusLabel(status),tone:statusTone(status)||'muted'};
}
function scrumModelLine(model){return `<span class="sc-model">${esc(model.provider||'Provider —')}<span aria-hidden="true"> · </span><strong>${esc(model.model||'Model —')}</strong>${model.thinking?`<small>${esc(model.thinking)}</small>`:''}</span>`;}
function scrumOwnerRequests(){const run=scrumRun();return Array.isArray(run.ownerWaits)?run.ownerWaits:run===scrumExample?[{id:'REQ-02',origin:{role:'Architect'},question:'Should completed agents stay visible?',holds:['Retention-policy decision in architecture.md']}]:[];}
function scrumAnswer(request){return scrumUi().answers[request.id]||(scrumRun()===scrumExample&&request.id==='REQ-02'&&state.questionAnswer?{status:state.cancelledQuestion?'cancelled':'answered',text:state.questionAnswer}:null);}
function scrumPending(){return scrumOwnerRequests().filter(request=>!scrumAnswer(request)).length+Number(Boolean(scrumRun().runId)&&scrumRun().requireUIApproval!==false&&!scrumDecision());}
function scrumSeatCard(id){
 const status=scrumSeatStatus(id),vacant=id!=='owner'&&scrumVacant(id),model=vacant?laneConfig(id):scrumModel(id),name=id==='lead'?'Scrum Lead / PO':id==='owner'?'Owner':'Supervisor';
 const tasks=scrumTasks(),summary=scrumRun().usageSummary||(scrumRun()===scrumExample?scrumExampleSummary:{}),cost=Number.isFinite(summary.cost)?'$'+summary.cost.toFixed(2)+' metered':'cost —',tokens=summary.tokens??'—';
 return `<button type="button" class="sc-seat ${vacant?'vacant':''} ${status.tone}" data-agent="${id}" data-flow-id="${id}" aria-label="${name}: ${esc(status.label)}"><span class="sc-seat-top">${id==='owner'?`<span class="sc-human">${icon('user')}</span>`:vacant?`<span class="sc-human">${icon('seat')}</span>`:botAvatar(id)}<strong>${name}</strong></span><span class="sc-seat-status">${id!=='owner'&&!vacant&&status.label==='Running'?agentActivityMark(id):`<span class="dot ${status.tone}"></span>`}${id==='owner'?scrumPending()+' waiting for you':esc(status.label)}</span>${id==='owner'?`<span class="sc-owner-totals">${cost}<span>${esc(String(tokens))} tok</span></span>`:scrumModelLine(model)}</button>`;
}
function scrumMailbox(id){const source=id==='lead'?state.leadTelemetry:scrumRun().seats?.supervisor,count=Number.isInteger(source?.queuedMailCount)?source.queuedMailCount:null,locked=id==='lead'&&!scrumVacant('lead')&&leadHandoffState().rotation==='handing_over';return `<button type="button" class="sc-mail ${locked?'amber':''}" data-scrum-panel="${id}-mailbox" data-flow-id="${id}-mailbox">${icon(locked?'lock':'inbox')}<span>${id==='lead'?'Lead':'Supervisor'} Mailbox</span><small>${locked?'Locked':count===null?'—':count+' queued'}</small></button>`;}
function scrumTaskCard(task){
 const role=scrumRole(task),runtime=scrumTaskRuntime(task),last=task.attempts.at(-1),status=runtime.handoffState==='handing_over'?'Handoff':task.status==='accepted'?'Done':task.status==='ready'?'GREEN':statusLabel(task.status),tone=task.status==='accepted'||last==='green'?'green':last==='red'?'red':statusTone(task.status)||'muted';
 return `<button type="button" class="sc-task ${tone}" data-agent="${scrumTaskKey(task)}" data-flow-id="${scrumTaskKey(task)}" data-agent-working="${task.status==='running'}" aria-label="${scrumRoleLabels[role]} ${esc(task.id)}: ${esc(status)}. ${esc(task.title)}" title="${esc(task.title)}"><span class="sc-task-avatar">${botAvatar(role)}</span><span class="sc-task-heading"><strong>${scrumRoleLabels[role]} · ${esc(task.id)}</strong><span class="sc-task-status">${task.status==='running'?agentActivityMark(scrumTaskKey(task),'running'):icon(last==='green'?'check':last==='red'?'close':task.status==='attention'?'alert':'clock')}${esc(status)}</span></span>${scrumModelLine(scrumModel(role,task))}${runtime.respawnCount?`<span class="sc-task-recovery" aria-label="Respawned">${icon('refresh')}</span>`:''}</button>`;
}
function scrumStagePreview(stage){
 const rank={running:0,attention:1,ready:2,queued:3,accepted:4,completed:4};
 const tasks=scrumTasks().filter(task=>stage.roles.includes(scrumRole(task))).sort((a,b)=>(rank[a.status]??5)-(rank[b.status]??5));
 return stage.id==='design'?['ux','architect'].map(role=>tasks.find(task=>scrumRole(task)===role)).filter(Boolean):tasks.slice(0,1);
}
function scrumEmptyRole(role,stage){return `<button type="button" class="sc-role-empty" data-scrum-panel="stage:${stage}"><span class="sc-task-avatar">${botAvatar(role)}</span><strong>${scrumRoleLabels[role]}</strong><small>No Tasks yet</small></button>`;}
function scrumStageCard(stage){
 const status=scrumStageState(stage),tasks=scrumTasks().filter(task=>stage.roles.includes(scrumRole(task))),visible=scrumStagePreview(stage),shortTitle=({planning:'PM / Analyst',design:'UX ∥ Architect',readiness:'Readiness & UI',implementation:'Senior Dev',qa:'QA & Fix'})[stage.id];
 let body='';
 if(status.skipped)body=`<button type="button" class="sc-skipped-note" data-scrum-panel="stage:${stage.id}">Skipped by ${esc(scrumRun().track||'selected')} track ${icon('chevron')}</button>`;
 else if(stage.id==='readiness')body=`<button type="button" class="sc-gate" data-scrum-panel="stage:readiness" data-flow-id="gate"><span><strong>Readiness</strong><span class="${scrumReadiness().tone}">${scrumReadiness().label}</span></span><span><strong>UI · ${scrumRun().design?.revision!=null?'r'+scrumRun().design.revision:'—'}</strong><span class="${scrumDecision()&&scrumDecision()!=='changes'?'green':'amber'}">${scrumDecisionLabel()==='Awaiting UI Approval'?'Awaiting Owner':scrumDecisionLabel()}</span></span></button>`;
 else if(stage.id==='design')body=`<div class="sc-parallel">${['ux','architect'].map(role=>`<div>${visible.filter(task=>scrumRole(task)===role).map(scrumTaskCard).join('')||scrumEmptyRole(role,'design')}</div>`).join('')}</div>`;
 else body=`<div class="sc-stage-task-list" data-flow-id="${stage.id==='planning'?'planning-block':stage.id==='implementation'?'delivery-block':'qa-block'}">${visible.map(scrumTaskCard).join('')||scrumEmptyRole(stage.roles[0],stage.id)}</div>`;
 const more=tasks.length>visible.length?`<button type="button" class="sc-more-tasks" data-scrum-panel="stage:${stage.id}" data-scrum-tab-open="tasks">+${tasks.length-visible.length} Tasks ${icon('chevron')}</button>`:'';
 const fix=stage.id==='qa'&&!status.skipped?`<button type="button" class="sc-fix-summary" data-scrum-panel="stage:qa"><span>${icon('refresh')}Fix ${state.fixRounds}/${state.qaAllowance}</span>${Number.isInteger(scrumRun().qa?.confirmedDefects)?`<span>${scrumRun().qa.confirmedDefects} defects</span>`:''}</button>`:'';
 return `<section class="sc-stage ${status.skipped?'skipped':''}" data-stage="${stage.id}" data-flow-id="phase-${stage.id}"><button type="button" class="sc-stage-heading" data-scrum-panel="stage:${stage.id}" aria-label="${stage.number}. ${stage.title}: ${status.label}"><span class="sc-stage-number ${status.tone}">${stage.number}</span><h3>${shortTitle}</h3><span class="sc-stage-state ${status.tone}">${status.label}</span></button>${body}${more||fix?`<div class="sc-stage-aside">${more}${fix}</div>`:''}</section>`;
}
function renderScrumWorkflow(){
 const run=scrumRun(),phase=scrumPhase();
 return `<div class="connected-canvas graph-canvas sc-canvas" id="graph-canvas" data-flow-mode="scrum"><svg class="workflow-wires" aria-hidden="true"></svg><button type="button" class="sc-run-summary" data-scrum-panel="run"><span>${icon('flow')}<strong>${esc(run.runId||'No run started')}</strong></span><span class="${['blocked','cancelled'].includes(phase)?'amber':'cyan'}">${esc(phase)}</span><span>${esc(run.track||'Track —')}</span><small>${run.configRevision!=null?'Roster r'+run.configRevision+' · frozen':'Roster —'}</small>${icon('chevron')}</button><div class="sc-authority">${scrumSeatCard('owner')}${scrumMailbox('supervisor')}${scrumSeatCard('supervisor')}${scrumMailbox('lead')}${scrumSeatCard('lead')}</div>${run.blockers?.length||run.cancellationReason?`<button type="button" class="sc-run-blocker" data-scrum-panel="run">${icon('alert')}${esc(run.cancellationReason||run.blockers.length+' blockers')}${icon('chevron')}</button>`:''}<div class="sc-pipeline">${scrumStageDefs.map(scrumStageCard).join('')}</div><div class="sc-side-tools"><button type="button" data-scrum-panel="resources">${icon('plug')}Resources</button><button type="button" data-scrum-panel="memory">${icon('refresh')}Memory</button><button type="button" data-workspace-destination="models">${icon('agents')}Roster</button></div></div>`;
}
connectedScrum=renderScrumWorkflow;
const scrumAgentBefore=agent;
agent=function(id){
 const task=scrumTaskForKey(id);if(!task)return scrumAgentBefore(id);
 const role=scrumRole(task),model=scrumModel(role,task),session=scrumTaskSession(task);
 return {name:scrumRoleLabels[role]+' · '+task.id,short:scrumRoleLabels[role]+' · '+task.id,initials:scrumRoleLabels[role],subtitle:task.title,task:task.id,status:({accepted:'completed',ready:'completed'})[task.status]||task.status,...model,agentId:session.agentId||null,sessionId:session.sessionId||null,sessionUrl:session.sessionUrl||null};
};
const scrumDrawerRoleBefore=drawerRole, scrumDrawerLaneBefore=drawerLane;
drawerRole=function(id){const task=scrumTaskForKey(id);return task?({pm:'PM',ux:'UX',architect:'Architect',dev:'Dev',qa:'QA'})[scrumRole(task)]:scrumDrawerRoleBefore(id);};
drawerLane=function(id){const task=scrumTaskForKey(id);return task?scrumRole(task):scrumDrawerLaneBefore(id);};
const scrumOpenAgentBefore=openAgent;
openAgent=function(id){const task=scrumTaskForKey(id);if(!task){scrumOpenAgentBefore(id);return;}const url=paseoSafeUrl(scrumTaskSession(task).sessionUrl)||paseoAttemptLinks(task,task.attempts.length-1).sessionUrl;if(url)paseoOpenUrl(url);else notify('This Task has no reported Paseo session link.',true);};
function drawScrumWorkflow(canvas,svg){
 const b=canvas.getBoundingClientRect(),u=b.width/(canvas.offsetWidth||b.width);if(!b.width)return;
 const point=(id,side)=>{const element=canvas.querySelector(`[data-flow-id="${id}"]`);if(!element)return null;const r=element.getBoundingClientRect();return {x:(side==='left'?r.left:side==='right'?r.right:r.left+r.width/2)-b.left,y:(side==='top'?r.top:side==='bottom'?r.bottom:r.top+r.height/2)-b.top};};
 const colors={muted:'#6d7c92',cyan:'#66d7ee',green:'#b8dc86',amber:'#efc47c'},paths=[];
 const add=(from,to,points,tone='muted',dashed=false,both=false)=>{if(points.some(p=>!p))return;const d=points.map((p,i)=>(i?'L':'M')+p.x+','+p.y).join(' ');paths.push(`<path class="edge" data-wire-from="${from}" data-wire-to="${to}" d="${d}" stroke="${colors[tone]}"${dashed?' stroke-dasharray="4 5"':''} marker-end="url(#scrum-arrow-${tone})"${both?` marker-start="url(#scrum-arrow-${tone})"`:''}/>`);};
 const vertical=(from,to,tone='muted',both=false)=>{const a=point(from,'bottom'),z=point(to,'top');if(a&&z)add(from,to,[a,{x:a.x,y:(a.y+z.y)/2},{x:z.x,y:(a.y+z.y)/2},z],tone,false,both);};
 vertical('owner','supervisor-mailbox','muted',true);vertical('supervisor-mailbox','supervisor','muted',true);vertical('supervisor','lead-mailbox','cyan',true);vertical('lead-mailbox','lead','cyan',true);
 const stages=scrumStageDefs,ports=stages.map(stage=>stage.id==='design'?'phase-design':stage.id==='readiness'?'gate':stage.id==='planning'?'planning-block':stage.id==='implementation'?'delivery-block':'qa-block');
 vertical('lead',scrumSkipped('planning')?'phase-planning':ports[0],'cyan');
 for(let i=0;i<stages.length-1;i++){
  const from=scrumSkipped(stages[i].id)?'phase-'+stages[i].id:ports[i],to=scrumSkipped(stages[i+1].id)?'phase-'+stages[i+1].id:ports[i+1];
  if(i===0&&!scrumSkipped('design')){
   const a=point(from,'bottom'),tasks=scrumTasks().filter(t=>['ux','architect'].includes(scrumRole(t)));
   if(!tasks.length)vertical(from,to,'muted');
   for(const task of tasks){const z=point(scrumTaskKey(task),'top');if(a&&z){const y=(a.y+z.y)/2;add(from,scrumTaskKey(task),[a,{x:a.x,y},{x:z.x,y},z],'green');}}
  }else if(i===1&&!scrumSkipped('design')){
   if(!scrumTasks().some(t=>['ux','architect'].includes(scrumRole(t))))vertical(from,to,'muted');
   for(const task of scrumTasks().filter(t=>['ux','architect'].includes(scrumRole(t)))){
    const a=point(scrumTaskKey(task),'bottom'),z=point(to,'top');if(a&&z){const y=z.y-8*u;add(scrumTaskKey(task),to,[a,{x:a.x,y},{x:z.x,y},z],task.status==='running'?'cyan':'green');}
   }
  }else vertical(from,to,scrumStageState(stages[i]).tone==='green'?'green':'muted');
 }
 // Keep the fix loop local to Delivery and QA; it never circles the authority tier.
 const qa=point('qa-block','right'),dev=point('delivery-block','right');if(qa&&dev){const x=Math.min(b.width-16*u,Math.max(qa.x,dev.x)+32*u);add('qa-block','delivery-block',[qa,{x,y:qa.y},{x,y:dev.y},dev],scrumPhase()==='fixing'?'amber':'muted',true);}
 // Geometry-only aliases preserve task transfer cues without duplicating visible wires.
 for(const task of scrumTasks()){
  const role=scrumRole(task),key=scrumTaskKey(task),a=point(role==='pm'?'lead':role==='ux'||role==='architect'?'planning-block':role==='dev'?'gate':'delivery-block','bottom'),z=point(key,'top');
  if(a&&z)paths.push(`<path class="edge sc-motion-route" data-wire-from="${role==='pm'?'lead':role==='ux'||role==='architect'?'planning-block':role==='dev'?'gate':'delivery-block'}" data-wire-to="${key}" d="M${a.x},${a.y} L${a.x},${z.y-12*u} L${z.x},${z.y-12*u} L${z.x},${z.y}"/>`);
 }
 svg.setAttribute('viewBox',`0 0 ${b.width} ${b.height}`);svg.setAttribute('preserveAspectRatio','none');svg.innerHTML=`<defs>${Object.entries(colors).map(([name,color])=>`<marker id="scrum-arrow-${name}" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="8" refY="4" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="M0 0L8 4L0 8Z" fill="${color}"/></marker>`).join('')}</defs>${paths.join('')}`;
}
const scrumMotionBefore=workflowTaskTransfers;
workflowTaskTransfers=function(task,before){if(task.mode!=='scrum'){scrumMotionBefore(task,before);return;}if(before.status!=='running'&&task.status==='running'){const role=scrumRole(task),source=role==='pm'?'lead':['ux','architect'].includes(role)?'planning-block':role==='dev'?'gate':'delivery-block';queueWorkflowTransfer(source,scrumTaskKey(task));}};
const scrumShellBefore=syncShell;
syncShell=function(){
 scrumShellBefore();if(mode()!=='scrum'||readonly()||state.page==='daemon')return;
 const roster=$('#team-roster'),tasks=scrumTasks().filter(task=>!['queued','accepted'].includes(task.status));if(!roster)return;
 const ids=['supervisor','lead',...tasks.map(scrumTaskKey)],key=scopeKey();
 roster.innerHTML=`<details class="fleet-team" id="team-disclosure" data-team-scope="${esc(key)}" ${state.teamExpanded[key]?'open':''}><summary><span class="fleet-team-title">The team<span>${ids.length}</span></span><span class="fleet-team-counts">${tasks.filter(t=>t.status==='running').length} working</span></summary><div class="fleet-team-content">${ids.map(id=>{const a=agent(id);return `<button type="button" class="roster-agent" data-agent="${id}">${botAvatar(scrumTaskForKey(id)?scrumRole(scrumTaskForKey(id)):id)}<span class="od-field od-fill"><strong>${esc(a.name)}</strong><small>${esc(statusLabel(a.status))}</small></span>${agentActivityMark(id,a.status)}</button>`;}).join('')}</div></details>`;
};
