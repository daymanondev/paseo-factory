'use strict';
/* Original role characters are drawn as editable SVG; no external imagery. */
const botKinds={supervisor:'supervisor',lead:'lead',pm:'pm',ux:'ux',architect:'architect',gate:'gate',dev:'dev',qa:'qa',watch:'watch','peer-1':'dev','peer-2':'qa','peer-3':'architect'};
function botAvatar(id){
 if(id==='owner')return '<span class="avatar owner-avatar" aria-hidden="true">AP</span>';
 const kind=botKinds[id]||'dev';
 const heads={
  supervisor:'<rect class="bot-face" x="16" y="25" width="64" height="48" rx="20"/><rect class="bot-face" x="10" y="42" width="8" height="16" rx="4"/><rect class="bot-face" x="78" y="42" width="8" height="16" rx="4"/>',
  lead:'<rect class="bot-face" x="17" y="27" width="62" height="47" rx="21"/><path class="bot-face" d="M25 31V20l11 6 12-12 12 12 11-6v15Z"/>',
  pm:'<path class="bot-face" d="M17 52c0-22 12-36 31-36s31 14 31 36c0 18-13 26-31 26s-31-8-31-26Z"/>',
  ux:'<rect class="bot-face" x="17" y="28" width="62" height="48" rx="23"/><path class="bot-face" d="M13 30c2-13 28-22 45-15 13 5 19 10 22 17-24 7-45 8-67-2Z"/><path class="bot-stroke" d="m48 14 4-5"/>',
  architect:'<rect class="bot-face" x="16" y="23" width="64" height="53" rx="17"/><path class="bot-face" d="M24 27 31 15h34l7 12Z"/>',
  gate:'<path class="bot-face" d="M48 15 78 28v22c0 19-30 31-30 31S18 69 18 50V28Z"/>',
  dev:'<rect class="bot-face" x="15" y="26" width="66" height="48" rx="18"/><path class="bot-face" d="m34 29 3-15 10 9 11-9 5 17Z"/><rect class="bot-face" x="8" y="42" width="9" height="15" rx="4"/><rect class="bot-face" x="79" y="42" width="9" height="15" rx="4"/>',
  qa:'<circle class="bot-face" cx="48" cy="48" r="31"/><path class="bot-stroke" d="M29 33h13m12 0h12"/>',
  watch:'<path class="bot-face" d="M19 41V18l19 13h20l19-13v23c9 22-8 37-29 37S10 63 19 41Z"/>'
 };
 const eyes=kind==='architect'?'<rect class="bot-stroke" x="25" y="40" width="20" height="17" rx="6"/><rect class="bot-stroke" x="51" y="40" width="20" height="17" rx="6"/><path class="bot-stroke" d="M45 46h6"/><circle class="bot-eye" cx="36" cy="48" r="3"/><circle class="bot-eye" cx="61" cy="48" r="3"/>':kind==='gate'?'<path class="bot-stroke" d="m35 47 9 9 18-20"/>':kind==='pm'?'<path class="bot-stroke" d="M29 43q5-5 10 0m18 0q5-5 10 0"/><ellipse class="bot-eye" cx="35" cy="50" rx="3" ry="4"/><ellipse class="bot-eye" cx="61" cy="50" rx="3" ry="4"/>':'<ellipse class="bot-eye" cx="35" cy="48" rx="4" ry="5"/><ellipse class="bot-eye" cx="61" cy="48" rx="4" ry="5"/>';
 const mouth=kind==='gate'?'':kind==='qa'?'<path class="bot-stroke" d="M42 63h12"/>':'<path class="bot-stroke" d="M42 62q6 5 12 0"/>';
 return `<svg class="bot-avatar bot-${kind}" viewBox="0 0 96 96" width="96" height="96" aria-hidden="true">${heads[kind]}${eyes}${mouth}</svg>`;
}
function friendlyStatus(id){
 const a=agent(id);
 if(state.emptyProjects?.has(scopeKey()))return id==='owner'?'You set the direction':'Ready when you are';
 if(state.retiredSeats?.has(scopeKey()+':'+id))return 'Seat archived';
 if(id==='owner')return 'You set the direction';
 if(id==='supervisor')return 'Looking after the big picture';
 if(id==='lead')return 'Keeping things moving';
 if(id==='gate')return state.designDecision&&state.designDecision!=='changes'?'Owner decision recorded':'Your call comes here';
 if(a.status==='completed')return id==='pm'?'Backlog is ready':'All done for now';
 if(a.status==='attention')return id==='ux'?'Ready for a look':'Could use your help';
 if(a.status==='running')return id==='architect'?'Working on architecture':id==='ux'?'Refining the design':'Making progress';
 if(a.status==='queued')return id==='dev'?'After the UI gate':'Up next';
 return 'Here when needed';
}
state.inspector=false;
const originalTeamSync=syncShell;
syncShell=function(){
 originalTeamSync();
 if(state.page==='flow'){
  const noRun=state.emptyProjects?.has(scopeKey());
  const active=scopedTasks().filter(t=>t.status==='running').length;
  const subtitle=readonly()?'A little room for every project.':noRun?'A fresh space, ready for your next idea.':active?(inboxCount()?`Work is moving along. ${inboxCount()} things are waiting for you.`:'Work is moving along. You’re all caught up.'):'Your team is here. Check in whenever you like.';
  $('.page-heading').outerHTML=heading('Your team, at a glance.',subtitle,modeControls());
 }
 const roster=$('#team-roster');
 if(roster){
  const ids=readonly()?['supervisor','lead']:mode()==='scrum'?['supervisor','lead','pm','ux','architect','dev','qa']:['supervisor','lead','peer-1','peer-2','peer-3'];
  const agentRows=ids.map(id=>{
   const a=agent(id);
   return `<button class="roster-agent ${state.selected===id&&state.inspector?'active':''}" data-agent="${id}" aria-label="Check in with ${esc(a.name)}">${botAvatar(id)}<span class="od-field od-fill"><strong>${esc(id==='lead'&&mode()==='scrum'?'Scrum Lead':a.short||a.name)}</strong><small class="od-truncate">${esc(friendlyStatus(id))}</small></span><i class="dot ${statusTone(a.status)}"></i></button>`;
  }).join('');
  roster.innerHTML=`<div class="roster-heading"><span>The team</span><span class="spacer"></span><span>${ids.length}</span></div>${agentRows}`;
 }
 const manageMenu=$('#manage-menu');if(manageMenu&&['models','integrations','design','vault','settings'].includes(state.page))manageMenu.open=true;
 const theme=$('meta[name="theme-color"]');if(theme)theme.content='#1b1d20';
};
const previousTeamStats=stats;
stats=function(){const tasks=scopedTasks();const active=new Set(tasks.filter(t=>t.status==='running').map(t=>t.agent));if(active.size)active.add('lead');return `<div class="team-summary"><span><i class="dot green"></i><strong>${state.emptyProjects?.has(scopeKey())?0:active.size}</strong> working</span><span><strong>${tasks.length}</strong> tasks</span><button class="summary-inbox" data-nav="inbox"><i class="dot amber"></i>${inboxCount()} ${inboxCount()===1?'thing':'things'} need you</button><span class="summary-note">${money(tasks.reduce((sum,t)=>sum+t.cost,0))} sample usage</span></div>`;};
node=function(id,authority=false){const a=agent(id);return `<button class="node ${a.status==='running'?'running':''} ${['queued','waiting'].includes(a.status)?'locked':''} ${a.status==='attention'?'waiting':''} ${state.selected===id&&state.inspector?'selected':''}" data-agent="${id}" aria-label="${esc(a.name)}: ${esc(friendlyStatus(id))}" aria-pressed="${state.selected===id&&state.inspector}"><span class="node-top">${botAvatar(id)}</span><span class="od-field"><strong>${esc(id==='lead'&&mode()==='scrum'?'Scrum Lead':a.short||a.name)}</strong>${authority?`<span class="model">${id==='owner'?'Product direction':id==='supervisor'?'Team oversight':'Coordination'}</span>`:''}</span><span class="node-foot ${statusTone(a.status)}"><i class="dot"></i><span>${esc(friendlyStatus(id))}</span></span></button>`;};
authorityGraph=function(){return `<div class="authority">${node('owner',true)}<div class="arrow" aria-hidden="true"></div>${node('supervisor',true)}<div class="arrow" aria-hidden="true"></div>${node('lead',true)}</div>`;};
scrumGraph=function(){return `${authorityGraph()}<div class="graph-divider"><span>${icon('git')} A handoff, not a handbrake</span></div><div class="journey-labels"><span><b>1</b> Make a plan</span><span><b>2</b> Shape the idea</span><span><b>3</b> Your review</span><span><b>4</b> Build it</span><span><b>5</b> Check the work</span></div><div class="journey"><svg class="journey-wires" viewBox="0 0 1000 320" preserveAspectRatio="none" aria-hidden="true"><path class="done-path" d="M154 160C200 160 200 80 246 80M154 160C200 160 200 240 246 240"/><path class="wait-path" d="M354 80C400 80 400 160 446 160"/><path d="M354 240C400 240 400 160 446 160"/><path class="future-path" d="M554 160C580 160 620 160 646 160M754 160C780 160 820 160 846 160"/><path class="future-path" d="M900 230v50q0 16-16 16H716q-16 0-16-16v-50"/></svg><div class="stage"><span class="mobile-stage-label">1 · Make a plan</span>${node('pm')}</div><div class="stage duet"><span class="mobile-stage-label">2 · Shape the idea, together</span>${node('ux')}${node('architect')}</div><div class="stage"><span class="mobile-stage-label">3 · Your review</span>${node('gate')}</div><div class="stage"><span class="mobile-stage-label">4 · Build it</span>${node('dev')}</div><div class="stage"><span class="mobile-stage-label">5 · Check the work</span>${node('qa')}</div></div><div class="journey-note"><span>UX and architecture can move together.</span><span class="loop-note"><span class="loop-rule" aria-hidden="true"></span>QA can send a fix back · ${state.fixRounds}/${state.qaAllowance} rounds</span></div>`;};
slpGraph=function(){return `${authorityGraph()}<div class="graph-divider"><span>${icon('git')} A clear task for every teammate</span></div><div class="slp-workers">${['peer-1','peer-2','peer-3'].map(id=>node(id)).join('')}</div><div class="slp-gate">${badge('Contract')}${icon('chevron')}${badge('Attempt')}${icon('chevron')}${badge('Gate','green')}${icon('chevron')}${badge('Your acceptance','amber')}</div>`;};
function teamCheckIn(){
 if(inboxCount()===0)return `<section class="check-in">${botAvatar('watch')}<div class="od-field od-fill"><strong>Nothing waiting on you.</strong><p>You can check in with the team whenever you’re ready.</p></div>${button('See the work','tasks','','ghost')}</section>`;
 const design=mode()==='scrum'&&!state.designDecision;
 return `<section class="check-in">${botAvatar(design?'ux':'watch')}<div class="od-field od-fill"><strong>${design?'The new workspace is ready for a look.':`${inboxCount()} things could use your attention.`}</strong><p>${design?'UX Designer has design revision 3 ready for your review.':'Questions, blockers, and verified work are all in your inbox.'}</p></div><span class="hint">${design?'No rush. Your review stays open.':''}</span>${button(design?'Take a look':'Check inbox',design?'review':'inbox','','primary')}</section>`;
}
const previousTeamFlow=renderFlow;
renderFlow=function(){
 if(readonly()||state.emptyProjects?.has(scopeKey()))return previousTeamFlow();
 const showInspector=state.inspector;
 return `${stats()}<div class="workspace-grid ${showInspector?'with-inspector':''}"><div><section class="journey-panel"><div class="journey-head"><div><h2>${state.graphTab==='agents'?'Who’s looking after what':'The team is on it'}</h2><p>Follow the handoffs. Tap anyone to check in.</p></div><div class="journey-tools"><div class="mode-switch"><button data-graph-tab="workflow" class="${state.graphTab==='workflow'?'selected':''}">The flow</button><button data-graph-tab="agents" class="${state.graphTab==='agents'?'selected':''}">Who’s who</button></div><button class="icon-btn" data-action="compact" aria-label="${state.compact?'Expand the team':'Compact the team'}" title="Compact view">${icon('agents')}</button></div></div><div class="graph-canvas ${state.compact?'compact':''} ${state.graphTab==='agents'?'agent-only':''}" id="graph-canvas">${state.graphTab==='agents'?authorityGraph():mode()==='scrum'?scrumGraph():slpGraph()}</div><div class="graph-footer"><div class="legend"><span><i class="dot cyan"></i>Working</span><span><i class="dot green"></i>Done</span><span><i class="dot amber"></i>Your turn</span><span><i class="dot muted"></i>Up next</span></div><div class="graph-controls"><button data-action="zoom-out" aria-label="Zoom out">${icon('minus')}</button><span class="zoom">${state.zoom}%</span><button data-action="zoom-in" aria-label="Zoom in">${icon('plus')}</button><button data-action="fit" aria-label="Fit the team in view">${icon('fit')}</button></div></div></section>${teamCheckIn()}${renderRecent()}</div>${showInspector?renderInspector():''}</div>`;
};
renderInspector=function(){
 const id=state.selected||'ux',a=agent(id),t=scopedTasks().find(t=>t.id===a.task);
 return `<aside class="panel inspector" aria-label="Check in with ${esc(a.name)}"><div class="inspector-head"><span class="eyebrow">A quick check-in</span><button class="icon-btn" data-action="toggle-inspector" aria-label="Close check-in">${icon('close')}</button></div><div class="agent-title">${botAvatar(id)}<div><h2>${esc(a.name)}</h2><p>${esc(a.subtitle)}</p></div></div><div class="status-line ${statusTone(a.status)}"><i class="dot"></i>${esc(friendlyStatus(id))}</div><div class="section-title">${t?'On their desk':'Their role'}</div><div class="task-preview">${t?`<span class="task-id">${t.id}</span><h3>${esc(t.title)}</h3><p>${t.attempts.includes('green')?'The latest attempt passed its gate.':t.attempts.length?'Work is in progress. Verification comes next.':'Waiting for the earlier steps.'}</p>`:`<h3>${esc(a.subtitle)}</h3><p>${id==='owner'?'Set direction, make decisions, and accept work you’re happy with.':'Keeps the work clear, bounded, and moving through the team.'}</p>`}</div><div class="section-title">${t?'What they’re making':'Workspace'}</div><div class="artifact-list">${(t?t.artifact.split(' · '):['Project overview']).map(file=>`<button class="artifact" data-action="artifact" data-file="${esc(file)}">${icon('file')}<span class="od-fill">${esc(file)}</span>${icon('chevron')}</button>`).join('')}</div><details class="technical-details"><summary>The technical bits</summary><dl class="data-list"><div><dt>Provider</dt><dd>${esc(a.provider)}</dd></div><div><dt>Model</dt><dd>${esc(a.model)}</dd></div><div><dt>Thinking</dt><dd>${id==='owner'?'—':'High'}</dd></div><div><dt>Session</dt><dd>${id==='owner'?'You':`sample-${id}-03`}</dd></div>${t?`<div><dt>Attempt</dt><dd>${Math.max(1,t.attempts.length)} of 3</dd></div><div><dt>Gate</dt><dd>${t.attempts.includes('green')?'Green':'Pending'}</dd></div>`:''}${id==='lead'?'<div><dt>Context</dt><dd>42k / 128k</dd></div><div><dt>Handoff</dt><dd>Normal · 2 queued</dd></div>':''}</dl></details>${id==='ux'&&!state.designDecision?button('Take a look','review','','primary'):t?button('See task details','task',`data-task="${t.id}"`,'primary'):button('See the work','tasks','','primary')}<button class="text-btn" data-action="open-agent" data-agent-id="${id}">Open in Paseo ${icon('external')}</button></aside>`;
};
const renderBeforeTeamFinish=render;
render=function(){
 renderBeforeTeamFinish();
 if(state.page==='models'){
  const ids=mode()==='scrum'?['supervisor','lead','pm','ux','architect','dev','qa','watch']:['supervisor','lead','dev','watch'];
  $$('.list-grid .content-card .role-avatar').forEach((el,i)=>{if(ids[i])el.outerHTML=botAvatar(ids[i]);});
 }
 const sentenceCase={'UI APPROVAL':'UI approval','QUESTION':'Question','READY TO ACCEPT':'Ready to accept','BLOCKER':'Blocker','CORE':'Core','COMPANION':'Companion','REQUIRED TOOL':'Required tool','PRIVATE VAULT':'Private vault','PEER ONLY':'Peer only','PROJECT DESIGN CONNECTION':'Project design connection','WORK ALLOWANCE':'Work allowance','PREREQUISITE SETUP GATE':'Setup required'};
 $$('.badge,.eyebrow').forEach(el=>{const s=el.textContent.trim();if(sentenceCase[s])el.textContent=sentenceCase[s];});
};
document.addEventListener('click',event=>{
 const el=event.target.closest('button[data-agent]');
 if(el?.closest('#team-roster')&&state.page!=='flow'&&typeof openAgentDrawer!=='function')state.page='flow';
},true);
render();
