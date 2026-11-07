'use strict';
/* Role-based detail surfaces. No daemon endpoints or session URLs are inferred here. */
state.slpInspectorViews={};
const slpInspectorCache=new Map();
const slpProjectSummaries=new Map();
for(const p of state.projects){
 const records=state.usageExamples.filter(r=>r.hostId===p.hostId&&r.project===p.name),totals=usageAggregate(records),tasks=state.tasks.filter(t=>t.hostId===p.hostId&&t.project===p.name),costs=tasks.map(t=>t.cost).filter(n=>Number.isFinite(n)&&n>=0);
 slpProjectSummaries.set(scopeKey(p.name,p.hostId),{tokens:usageValue(totals),cost:costs.length?'$'+costs.reduce((a,b)=>a+b,0).toFixed(2)+(costs.length<tasks.length?'+':''):'—'});
}
Object.assign(slpPanels,{verification:{title:'Verification',glyph:'shield',agent:'lead'}});
function slpOverviewSummary(){
 if(state.emptyProjects?.has(scopeKey()))return {tokens:'—',cost:'—'};
 const live=slpData().overview;if(live)return {tokens:Number.isFinite(live.totalTokens)?usageCompact(live.totalTokens):'—',cost:Number.isFinite(live.meteredCost)?'$'+live.meteredCost.toFixed(2):'—'};
 return slpProjectSummaries.get(scopeKey())||{tokens:'—',cost:'—'};
}
const slpPreviousStatus=slpStatus;
slpStatus=function(id,task=null){
 if(!slpVacant(id)&&id==='supervisor'){
  const value=slpData().supervisor?.lifecycle||agent(id).status;
  if(value==='transitioning')return {label:'Transitioning',tone:'amber',status:'attention'};
  if(value==='initializing')return {label:'Initializing',tone:'cyan',status:'queued'};
  if(value==='closed')return {label:'Dormant',tone:'muted',status:'idle'};
 }
 return slpPreviousStatus(id,task);
};
slpCompactNode=function(id,task=null){
 const a=agent(id),s=slpStatus(id,task),vacant=id!=='owner'&&slpVacant(id),selected=state.inspector&&!slpActivePanel()&&state.drawerAgent===id;
 const name=id==='lead'?'Lead':id==='supervisor'?'Supervisor':a.name;
 const avatar=id==='owner'?`<span class="slp-human-avatar">${icon('user')}</span>`:vacant?`<span class="slp-empty-avatar">${icon('seat')}</span>`:botAvatar(id);
 const mark=s.handoff?icon('transfer'):vacant?icon('seat'):agentActivityMark(id,s.status);
 let secondary='';
 if(id!=='owner'){
  const config=vacant?laneConfig(drawerLane(id)||id):a;
  const thinking=typeof config.thinking==='string'?config.thinking.trim():'';
  const provider=typeof config.provider==='string'?config.provider.trim():'';
  const model=config.model||'Model unavailable';
  secondary=`<span class="slp-node-model" aria-label="${vacant?'Default':'Current'} model: ${esc(model)}${provider?', provider '+esc(provider):''}${thinking?', thinking '+esc(thinking):''}">${provider?`<span class="slp-node-provider">${esc(provider)}</span><span class="slp-model-separator" aria-hidden="true">·</span>`:''}<span class="slp-model-name">${esc(model)}</span>${thinking?`<span class="slp-node-thinking">${esc(thinking)}</span>`:''}</span>`;
 }
 const attention=id==='owner'?slpTasks().filter(t=>['ready','attention'].includes(t.status)).length+(state.retro||[]).filter(r=>!r.ratified).length:0;
 const fence=['supervisor','lead'].includes(id)?`<button type="button" class="slp-seat-fence" data-slp-feature="fence" aria-label="${name} write fence and permissions">${icon('shield')}</button>`:'';
 return `<div class="slp-seat-shell"><button type="button" class="flow-node slp-node ${s.status} ${vacant?'slp-node-vacant':''} ${selected?'selected':''}" data-agent="${id}" data-flow-id="${id}" data-agent-working="${!vacant&&!s.handoff&&agentIsWorking(id,s.status)}" aria-pressed="${Boolean(selected)}" aria-label="${esc(name)}: ${esc(s.label)}${task?', '+esc(task.id):''}"><span class="node-top">${avatar}<strong class="node-title">${esc(name)}</strong></span><span class="node-bottom ${s.tone}">${mark}<span>${id==='owner'&&attention?attention+' need you':esc(s.label)}</span>${task&&!id.startsWith('peer-task-')?`<span class="node-task">${esc(task.id)}</span>`:''}</span>${secondary}</button>${fence}</div>`;
};
const slpCompactMapBefore=renderSlpWorkflow;
renderSlpWorkflow=function(){
 const wave=slpData().wave,peers=slpPeers(),label=wave?.label||wave?.id||'Working Peers';
 let html=slpCompactMapBefore();
 html=html.replace(`<div class="slp-fence-slot">${slpFeature('fence','Fence')}</div>`,'');
 html=html.replace(slpFeature('capabilities','Skills / MCP'),slpFeature('capabilities','Resources'));
 html=html.replace(slpFeature('retro','Retro'),slpFeature('retro','Memory'));
 html=html.replace(slpFeature('gate','Gate','verification')+slpFeature('watch','Watch')+slpFeature('driver','Driver'),slpFeature('verification','Verification','verification'));
 html=html.replace('<div class="slp-compact-peers"',`<div class="slp-wave-heading"><span>${esc(label)}</span></div><div class="slp-compact-peers"`);
 return html;
};
const slpTabs={
 owner:[['decisions','Decisions','inbox'],['usage','Usage','activity'],['retro','Retro','refresh']],
 supervisor:[['work','Work','tasks'],['mailbox','Mailbox','inbox'],['session','Session','agents']],
 lead:[['work','Work','tasks'],['handoff','Handoff','transfer'],['session','Session','agents']],
 peer:[['task','Task','tasks'],['attempts','Attempts','shield'],['resources','Resources','plug']],
 other:[['work','Work','tasks'],['usage','Usage','activity'],['session','Session','agents']],
 verification:[['gate','Gate','shield'],['watch','Watch','eye'],['driver','Driver','activity']],
 design:[['catalog','Catalog','file'],['source','Source','code']],
 capabilities:[['skills','Skills','code'],['mcps','MCP','plug']],
 retro:[['ledger','Ledger','file'],['usage','Usage','activity'],['retro','Retro','refresh']]
};
function slpInspectorContext(id=state.drawerAgent){
 const feature=slpActivePanel(),kind=feature?'feature':'agent',entity=feature||id;
 const role=feature?entity:id==='owner'?'owner':id==='lead'?'lead':id==='supervisor'?'supervisor':id?.startsWith('peer-')?'peer':'other';
 const tabs=slpTabs[role]||[['overview','Overview','info']],key=scopeKey()+'|'+kind+'|'+entity;
 const view=state.slpInspectorViews[key]||(state.slpInspectorViews[key]={tab:tabs[0][0],attempt:null,files:[],scroll:{}});
 if(!tabs.some(tab=>tab[0]===view.tab))view.tab=tabs[0][0];
 return {id,feature,kind,entity,role,tabs,key,view,scope:scopeKey()};
}
function slpCurrentTask(id){return slpPeers().find(p=>p.id===id)?.task||slpTasks().find(t=>t.agent===id);}
function slpDetailRevision(context){
 const data=slpData(),task=slpCurrentTask(context.id);
 return JSON.stringify([data.revision,data[context.id]?.seqEnd,agent(context.id).status,state.leadTelemetry,state.linkedDesign,Boolean(state.emptyProjects?.has(scopeKey())),[...state.retiredSeats||[]].filter(k=>k.startsWith(scopeKey()+':')),slpTasks().map(t=>[t.id,t.status,t.attempts,t.cost]),(state.retro||[]).map(r=>r.ratified),state.skills.map(s=>[s.name,s.installed]),state.mcps.map(s=>[s.name,s.synced,s.targets,s.health]),task?.revision,context.view.attempt,context.view.files,context.view.usageGroup]);
}
function slpSelectedDetail(context){
 const key=context.key+'|'+context.view.tab,revision=slpDetailRevision(context),saved=slpInspectorCache.get(key);
 if(saved?.revision===revision)return saved.html;
 const html=slpInspectorContent(context);
 slpInspectorCache.set(key,{revision,html});
 if(slpInspectorCache.size>48)slpInspectorCache.delete(slpInspectorCache.keys().next().value);
 return html;
}
function slpArtifact(context,key,title,glyph='file'){
 const open=context.view.files.includes(key);
 return `<details class="slp-artifact" data-slp-artifact="${key}" data-slp-context="${esc(context.key)}" ${open?'open':''}><summary>${icon(glyph)}<span>${esc(title)}</span>${icon('chevron')}</summary><div class="slp-artifact-content">${open?slpArtifactContent(context,key):''}</div></details>`;
}
function slpArtifactText(context,key){
 const task=slpCurrentTask(context.id),index=context.view.attempt??Math.max(0,(task?.attempts.length||1)-1),detail=task?.attemptDetails?.[index]||{};
 if(key==='report')return detail.report||null;
 if(key==='gate-log')return detail.gateLog||null;
 if(key==='lead-handoff')return state.leadTelemetry?.handoffContent||null;
 if(key==='peer-handoff')return slpData().peers?.[context.id]?.handoffContent||null;
 if(key==='contract')return task?.contract?.description||null;
 return null;
}
function slpArtifactContent(context,key){
 const text=slpArtifactText(context,key);
 return text?`<div class="slp-artifact-actions"><button type="button" class="btn ghost" data-slp-copy="${key}">${icon('copy')}Copy</button></div><pre>${esc(typeof text==='string'?text:JSON.stringify(text,null,2))}</pre>`:'<p class="slp-empty-detail">No content reported in this sample.</p>';
}
function slpUsageView(context){
 const owner=context.id==='owner'||context.feature==='retro',records=state.emptyProjects?.has(scopeKey())?[]:usageUnique(state.usageExamples.filter(r=>r.hostId===activeHostId()&&r.project===state.project&&(owner||r.agentId===context.id))),a=usageAggregate(records);
 const reasoning=records.map(r=>r.reasoningTokens).filter(n=>Number.isFinite(n)&&n>=0),reasoningText=reasoning.length?usageExact(reasoning.reduce((x,y)=>x+y,0))+(reasoning.length<records.length?'+':''):'—';
 const turnIds=records.map(r=>r.turnId).filter(Boolean),turns=records.length&&turnIds.length===records.length?new Set(turnIds).size:'—';
 const cacheHit=records.length&&a.cachedKnown===a.count&&a.inputKnown===a.count&&a.input>0?(a.cached/a.input*100).toFixed(1)+'%':'—';
 const grouping=context.view.usageGroup==='model'?'model':'seat',groups=usageGroups(records,r=>grouping==='model'?r.provider+' / '+r.model:r.taskId?'task:'+r.taskId:r.agentId);
 return `<div class="slp-usage-total"><span>Total recorded</span><strong>${usageValue(a,'total',false)} <small>tokens</small></strong></div><div class="slp-token-grid">${[['Input',usageValue(a,'input',false)],['Cache read',usageValue(a,'cached',false)],['Output',usageValue(a,'output',false)],['Reasoning',reasoningText]].map(([name,value])=>`<div><span>${name}</span><strong>${value}</strong></div>`).join('')}</div>${slpRows([['Sessions',records.length?new Set(records.map(r=>r.sessionId).filter(Boolean)).size:'—'],['Turns',turns],['Cache hit',cacheHit]])}<div class="slp-usage-group" role="group" aria-label="Group usage"><button type="button" data-slp-usage-group="seat" aria-pressed="${grouping==='seat'}">By seat</button><button type="button" data-slp-usage-group="model" aria-pressed="${grouping==='model'}">By model</button></div><div class="slp-usage-rows">${groups.map(group=>{const first=group.records[0],costs=group.records.map(r=>r.cost).filter(n=>Number.isFinite(n)&&n>=0);return `<div><span><strong>${esc(grouping==='model'?first.model:first.taskId?'Peer · '+first.taskId:agent(first.agentId).name)}</strong><small>${esc(grouping==='model'?first.provider:first.taskId?'Task session':first.role||'Seat')}</small></span><span><strong>${usageValue(group.usage)}</strong><small>${costs.length?'$'+costs.reduce((x,y)=>x+y,0).toFixed(2)+(costs.length<group.records.length?'+':''):'cost —'}</small></span></div>`;}).join('')||'<p class="slp-empty-detail">No usage reported.</p>'}</div><p class="slp-detail-footnote">Cached input is included in Input. Reasoning is shown separately when reported and is not added again to the recorded total. “+” marks partial data.</p>`;
}
function slpTaskView(context){
 const task=slpCurrentTask(context.id);if(!task)return `<p class="slp-empty-detail">No Task is assigned.</p>${drawerCapabilities(context.id)}`;
 const contract=task.contract||{};
 return `${drawerWork(context.id)}${paseoAttemptActions(task,task.attempts.length-1)}<div class="slp-contract-fields">${[['Bounded outcome',contract.boundedOutcome||task.title],['Regression invariants',contract.regressionInvariants],['Exclusions',contract.exclusions],['Gate command',contract.gateCommand||task.gateCommand]].map(([name,value])=>`<section><h3>${esc(name)}</h3><p>${esc(Array.isArray(value)?value.join('\n'):value||'Not reported')}</p></section>`).join('')}</div>${slpRows([['Artifact',task.artifact],['Worktree',task.workspaceId||task.worktreePath||'factory/'+task.id]])}${slpArtifact(context,'contract','Full Contract')}`;
}
function slpAttemptView(context){
 const task=slpCurrentTask(context.id);if(!task?.attempts.length)return '<p class="slp-empty-detail">No attempts yet.</p>';
 const index=Math.min(context.view.attempt??task.attempts.length-1,task.attempts.length-1),verdict=task.attempts[index],detail=task.attemptDetails?.[index]||{},peer=slpData().peers?.[context.id]||{};
 return `<div class="slp-attempt-picker" role="group" aria-label="Choose attempt">${task.attempts.map((v,i)=>`<button type="button" data-slp-attempt="${i}" aria-pressed="${index===i}" class="${v==='green'?'green':v==='red'?'red':'cyan'}">${icon(v==='green'?'check':v==='red'?'close':'activity')}#${i+1}</button>`).join('')}<small>${task.attempts.length}/3</small></div>${slpRows([['Verdict',verdict==='open'?'Pending':verdict.toUpperCase()],['Claim SHA',detail.sha],['Context',Number.isFinite(peer.contextUsedTokens)?usageExact(peer.contextUsedTokens)+' / 160,000':'— / 160,000'],['Handoffs this epoch',peer.handoffCount],['Respawned',peer.respawnCount]])}${paseoAttemptActions(task,index)}${slpArtifact(context,'report','Report.md')}${slpArtifact(context,'gate-log','Gate log','code')}${slpArtifact(context,'peer-handoff','peer-handoff-'+task.id+'.md')}${slpDisclosure('attempt-watch','Watch & choke','eye',slpRows(['destructive-writes','test-weakened','stuck-loop','scope-creep','secret-leak'].map(name=>[name,Number.isFinite(detail.watch?.[name])?detail.watch[name].toFixed(2):null]))+slpRows([['Choke allowed',detail.choke?.allowed],['Denied',detail.choke?.denied],['Blocked',detail.choke?.blocked]]))}<p class="slp-detail-footnote">Peer handoff: 160k context, maximum 12 KB, once per epoch. A second ceiling or second substrate death escalates to Needs-human.</p>`;
}
function slpHandoffView(context){
 const data=leadHandoffState(),vacant=slpVacant('lead'),raw=state.leadTelemetry||{};
 if(vacant)return `<div class="slp-seat-empty">${icon('seat')}<strong>Lead seat is vacant</strong><p>The next Supervisor dispatch creates a fresh Lead with 0% context.</p></div>`;
 const active=data.rotation==='handing_over',pending=data.rotation==='rotation_pending';
 return `${leadHandoffMeter(data)}<p class="slp-drawer-notice ${pending?'amber':'cyan'}">${esc(pending?'Finishes this turn, then hands over.':active?(raw.handoffPhase==='pending_kickoff'?'Pending handoff kickoff · waiting for Peers.':'Lead Mailbox is locked while the successor is prepared.'):data.note)}</p><div class="slp-drawer-handoff"><span>Outgoing Lead <b>${data.tokens===null?'—':Math.round(data.tokens/1000)+'k'}</b></span>${icon('arrow')}<span>${icon('file')}lead-handoff.md <small>Max 24 KB</small></span>${icon('arrow')}<span>Successor Lead <b>${active?'0% · pending':'Not started'}</b></span></div>${slpArtifact(context,'lead-handoff','Read lead-handoff.md')}${slpRows([['Last handoff',data.lastHandoff],['Queued mail',data.queued]])}${slpDrawerLink('lead-mailbox','Open Lead Mailbox','inbox')}`;
}
function slpSessionView(context){
 const id=context.id,a=agent(id),vacant=slpVacant(id),source=slpData()[id]||{};
 return `${vacant?`<div class="slp-seat-empty">${icon('seat')}<strong>Vacant seat</strong><p>${id==='supervisor'?'Start from Supervisor (Factory) in Paseo New Chat.':'A fresh Lead is created on the next dispatch.'}</p></div>`:''}${slpRows([['Agent ID',vacant?null:a.agentId||source.agentId],['Session',vacant?null:a.sessionId||source.sessionId||(id==='lead'?leadHandoffState().session:null)],['seqEnd',vacant?null:source.seqEnd??(id==='lead'?state.leadTelemetry?.seqEnd:null)],['Workspace',project()?.path],['Provider',a.provider],['Thinking',a.thinking||'Provider default']])}${slpDrawerLink('fence','Write fence & project memory','shield')}${slpUsageDetails(id)}`;
}
function slpDecisionView(){
 const tasks=slpTasks().filter(t=>['ready','attention'].includes(t.status));
 return `<div class="slp-section-intro"><h3>Waiting for you</h3><span>${tasks.length}</span></div>${tasks.map(task=>`<section class="slp-decision-row"><span class="${task.status==='ready'?'green':'amber'}">${icon(task.status==='ready'?'check':'alert')}${esc(task.id)}</span><strong>${esc(task.title)}</strong>${task.blocker?`<p>${esc(task.blocker)}</p>`:''}<div>${button('Inspect','task',`data-task="${esc(task.id)}"`,'ghost')}${task.status==='ready'&&task.attempts.at(-1)==='green'?button('Accept #'+task.attempts.length,'accept',`data-task="${esc(task.id)}"`,'primary','check'):''}</div></section>`).join('')||'<p class="slp-empty-detail">No decisions are waiting.</p>'}`;
}
function slpResourceView(context,tab){
 if(!context.feature)return `${drawerCapabilities(context.id)}${slpDisclosure('peer-runtime','Runtime & usage','activity',slpRows([['Provider',agent(context.id).provider],['Model',agent(context.id).model]])+slpUsageDetails(context.id))}`;
 const peers=slpPeers();
 return peers.length?peers.map(({id,task})=>`<section class="slp-drawer-section"><h3>${esc(agent(id).name)}<small>${esc(task.id)}</small></h3>${tab==='skills'?drawerSkills(id).map(skill=>`<button type="button" class="slp-drawer-link" data-ui="skill-detail" data-skill="${esc(skill.name)}">${icon('code')}<span>${esc(skill.name)}</span>${icon('chevron')}</button>`).join('')||'<p>No role skills assigned.</p>':drawerServers(id).map(server=>`<div class="slp-resource-server"><span>${esc(server.name)}</span><small>${esc(server.health)}</small></div>`).join('')||'<p>No Helper MCP synced.</p>'}</section>`).join(''):'<p class="slp-empty-detail">No working Peers yet.</p>';
}
function slpInspectorContent(context){
 const tab=context.view.tab;
 if(context.feature==='verification')return slpPanelBody(tab);
 if(context.feature==='fence')return `<p class="drawer-copy">Supervisor and Lead coordinate work while product writes remain fenced.</p>${slpRows([['Layer 1','Provider tool lock'],['Layer 2','Runtime permission choke'],['Layer 3','OS PATH git/package shims'],['Writable memory','AGENTS.md · CONTEXT.md · GLOSSARY.md · docs/** · .scratch/**']])}`;
 if(context.feature?.endsWith('mailbox')||tab==='mailbox'){
  const feature=context.feature||context.id+'-mailbox',source=feature==='lead-mailbox'?state.leadTelemetry:slpData().supervisor,messages=Array.isArray(source?.messages)?source.messages:[];
  return slpPanelBody(feature)+(messages.length?messages.map(message=>`<section class="slp-drawer-section"><h3>${esc(message.status||'mail_queued')}</h3><p>${esc(message.text||message.summary||'Message content unavailable')}</p></section>`).join(''):'');
 }
 if(context.feature==='design')return `${slpRows([['Bundle',state.linkedDesign?'Linked':'Not linked'],['Recipient',tab==='catalog'?'Lead':'Working Peers']])}<section class="slp-drawer-section"><h3>${tab==='catalog'?'Design Catalog':'Design Source'}</h3>${(tab==='catalog'?['design-manifest.json','screens-data.js','app-data.js','screens.html']:['index.html','app.js','styles.css','screens.css']).map(name=>`<p class="slp-design-file">${icon(tab==='catalog'?'file':'code')}${name}</p>`).join('')}<small>${tab==='catalog'?'Lightweight structure for planning. Reference size: approximately 7k tokens.':'Full interactive source for implementation in Task worktrees.'}</small></section>`;
 if(context.feature==='capabilities'||tab==='resources')return slpResourceView(context,tab);
 if(tab==='usage')return slpUsageView(context);
 if(tab==='decisions')return slpDecisionView();
 if(tab==='handoff')return slpHandoffView(context);
 if(tab==='session')return slpSessionView(context);
 if(tab==='task')return slpTaskView(context);
 if(tab==='attempts')return slpAttemptView(context);
 if(tab==='retro')return slpPanelBody('retro');
 if(tab==='ledger')return `<p class="drawer-copy">Project Ledger · ledger.jsonl</p>${state.events.filter(event=>event.project===state.project&&(!event.hostId||event.hostId===activeHostId())).slice(0,20).map(event=>`<div class="slp-ledger-row"><span>${esc(event.task||'Project')}</span><p>${esc(event.text)}</p><small>${esc(event.time||'')}</small></div>`).join('')||'<p class="slp-empty-detail">No ledger events reported.</p>'}`;
 return `${context.id==='lead'&&['handing_over','rotation_pending'].includes(leadHandoffState().rotation)?`<div class="slp-work-hold"><span class="amber">${icon('transfer')}${esc(slpStatus('lead').label)}</span><button type="button" data-slp-tab="handoff" data-drawer-focus="handoff-shortcut">View handoff ${icon('chevron')}</button></div>`:''}${drawerWork(context.id)}${context.id==='lead'?slpRows([['Current wave',slpData().wave?.label||slpData().wave?.id],['Stable checkpoint',slpData().stableCheckpointSha]]):''}`;
}
function slpInspectorFooter(context){
 if(context.feature==='verification')return '<button type="button" class="btn primary" data-nav="tasks">'+icon('tasks')+'View Tasks</button>';
 if(context.feature)return slpPanelFooter(context.feature);
 if(context.id==='owner')return button('View all decisions','inbox','','primary','inbox');
 if(context.id.startsWith('peer-')){
  const task=slpCurrentTask(context.id);
  return button('Open Peer','open-agent',`data-agent-id="${context.id}"`,'ghost','external')+(task?.status==='ready'&&task.attempts.at(-1)==='green'?button('Accept #'+task.attempts.length,'accept',`data-task="${esc(task.id)}"`,'primary','check'):'');
 }
 const vacant=slpVacant(context.id),canRetire=['supervisor','lead'].includes(context.id)&&!vacant;
 return `${canRetire?`<details class="slp-seat-actions"><summary aria-label="Seat actions">${icon('settings')}</summary><div>${button(context.id==='lead'?'Rotate Lead':'Revoke Supervisor','retire-seat',`data-role="${context.id}"`,'ghost',context.id==='lead'?'refresh':'close')}</div></details>`:''}${vacant&&context.id==='lead'?'<button type="button" class="btn primary" disabled>Awaiting dispatch</button>':button(vacant?'Start Supervisor':'Open in Paseo','open-agent',`data-agent-id="${context.id}"`,'primary','external')}`;
}
const slpDrawerBeforeTabs=drawerMarkup;
drawerMarkup=function(id){
 if(mode()!=='slp')return slpDrawerBeforeTabs(id);
 const context=slpInspectorContext(id),feature=context.feature,panel=feature?slpPanels[feature]:null,a=agent(id),status=slpStatus(id,slpCurrentTask(id));
 const headerAvatar=feature?`<span class="slp-panel-icon">${icon(panel.glyph)}</span>`:id==='owner'?`<span class="slp-panel-icon">${icon('user')}</span>`:botAvatar(id);
 const title=feature?panel.title:id==='lead'?'Lead':a.name;
 return `<button class="agent-drawer-scrim" data-drawer-close aria-label="Close details" tabindex="-1"></button><aside class="agent-drawer slp-tabbed-drawer" id="agent-drawer" role="dialog" aria-modal="false" aria-labelledby="agent-drawer-title" tabindex="-1"><header class="agent-drawer-header">${headerAvatar}<div class="drawer-header-identity"><div class="drawer-name-row"><h2 id="agent-drawer-title">${esc(title)}</h2>${!feature?`<span class="drawer-status-inline ${status.tone}">${esc(status.label)}</span>`:''}</div>${!feature?drawerModel(id):''}</div><button type="button" class="icon-btn" data-drawer-close data-drawer-focus="close" aria-label="Close details">${icon('close')}</button></header>${context.tabs.length>1?`<div class="slp-inspector-tabs" role="tablist" aria-label="${esc(title)} details">${context.tabs.map(([tab,label])=>`<button type="button" role="tab" id="slp-tab-${tab}" data-slp-tab="${tab}" data-drawer-focus="slp-tab-${tab}" aria-controls="slp-inspector-panel" aria-selected="${context.view.tab===tab}" tabindex="${context.view.tab===tab?'0':'-1'}"><span>${label}</span></button>`).join('')}</div>`:''}<div class="agent-drawer-body" id="slp-inspector-panel" ${context.tabs.length>1?`role="tabpanel" aria-labelledby="slp-tab-${context.view.tab}"`:''} tabindex="0">${slpSelectedDetail(context)}<p class="slp-sample-note">Example data · unreported values appear as —</p></div><footer class="agent-drawer-footer">${slpInspectorFooter(context)}</footer></aside>`;
};
function slpSwitchTab(tab,focus=false){
 const context=slpInspectorContext();if(!context.tabs.some(item=>item[0]===tab))return;
 const body=$('.agent-drawer-body');context.view.scroll[context.view.tab]=body?.scrollTop||0;context.view.tab=tab;
 mountAgentDrawer();const next=$('.agent-drawer-body');if(next)next.scrollTop=context.view.scroll[tab]||0;
 if(focus)$(`[data-slp-tab="${tab}"]`)?.focus({preventScroll:true});
}
function slpFocusConnections(){
 const canvas=$('.slp-canvas');if(!canvas)return;
 const feature=slpActivePanel(),selected=state.inspector?(feature==='verification'?'verification':feature||state.drawerAgent):null;
 const peerSelected=Boolean(selected&&canvas.querySelector(`[data-flow-id="${selected}"]`)?.closest('.slp-compact-peers'));
 canvas.querySelectorAll('path.edge').forEach(edge=>{
  const shared=edge.dataset.slpSharedRoute,related=edge.dataset.wireFrom===selected||edge.dataset.wireTo===selected||(selected==='owner'&&edge.dataset.wireTo==='acceptance')||(shared==='claims'&&(peerSelected||selected==='verification'))||(shared==='dispatch'&&(peerSelected||selected==='lead'));
  edge.classList.toggle('slp-edge-muted',Boolean(selected&&!related));
 });
}
const slpDrawBeforeFocus=drawSlpWorkflow;
drawSlpWorkflow=function(canvas,svg){slpDrawBeforeFocus(canvas,svg);slpFocusConnections();};
const slpSelectionBeforeFocus=drawerSelection;
drawerSelection=function(){slpSelectionBeforeFocus();slpFocusConnections();};
document.addEventListener('click',event=>{
 const control=event.target.closest('button');if(!control||control.disabled||mode()!=='slp'||!state.inspector)return;
 if(control.dataset.slpTab)slpSwitchTab(control.dataset.slpTab);
 if(control.dataset.slpAttempt!==undefined){const context=slpInspectorContext();context.view.attempt=Number(control.dataset.slpAttempt);context.view.files=[];mountAgentDrawer();$(`[data-slp-attempt="${control.dataset.slpAttempt}"]`)?.focus({preventScroll:true});}
 if(control.dataset.slpUsageGroup){slpInspectorContext().view.usageGroup=control.dataset.slpUsageGroup;mountAgentDrawer();$(`[data-slp-usage-group="${control.dataset.slpUsageGroup}"]`)?.focus({preventScroll:true});}
 if(control.dataset.slpCopy){const text=slpArtifactText(slpInspectorContext(),control.dataset.slpCopy);if(text)copyText(typeof text==='string'?text:JSON.stringify(text,null,2));}
});
document.addEventListener('toggle',event=>{
 const node=event.target;if(!node.matches?.('[data-slp-artifact]')||!state.inspector||mode()!=='slp')return;
 const context=slpInspectorContext();if(node.dataset.slpContext!==context.key||context.scope!==scopeKey())return;
 const key=node.dataset.slpArtifact;context.view.files=node.open?[...new Set([...context.view.files,key])]:context.view.files.filter(item=>item!==key);
 const body=node.querySelector('.slp-artifact-content');if(body)body.innerHTML=node.open?slpArtifactContent(context,key):'';
},true);
document.addEventListener('keydown',event=>{
 const button=event.target.closest('[role="tab"][data-slp-tab]');if(!button||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
 event.preventDefault();const tabs=slpInspectorContext().tabs,index=tabs.findIndex(tab=>tab[0]===button.dataset.slpTab),next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;slpSwitchTab(tabs[next][0],true);
});
render();
