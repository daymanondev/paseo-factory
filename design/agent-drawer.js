'use strict';
/* Contextual inspector. Agent selection never replaces or scrolls the canvas. */
state.drawerAgent=null;state.drawerProject=null;state.drawerScrollTop=0;
state.workspaceReturnContext=null;state.skillRole=null;
let drawerTrigger=null;
const drawerRoleNames={supervisor:'Supervisor',lead:'Lead',pm:'PM',ux:'UX',architect:'Architect',dev:'Dev',qa:'QA',watch:'Watch'};
function drawerRole(id){return id?.startsWith('peer-')?'Peer':drawerRoleNames[id]||null;}
function drawerLane(id){return id?.startsWith('peer-')?'dev':['supervisor','lead','pm','ux','architect','dev','qa','watch'].includes(id)?id:null;}
function isTaskPeer(id){return Boolean(id)&&!['owner','supervisor','lead','gate','watch'].includes(id);}
function drawerSkills(id){const role=drawerRole(id);return role?state.skills.filter(skill=>skill.installed&&skillMatchesRole(skill,role)):[];}
function drawerServers(id){if(!isTaskPeer(id))return [];const provider=agent(id).provider;return state.mcps.filter(server=>server.synced&&server.targets.includes(provider));}
const recentBeforeDrawer=renderRecent;
renderRecent=function(){return state.page==='flow'?'':recentBeforeDrawer();};
function drawerSelection(){
 $$('[data-agent]').forEach(el=>{
  const selected=state.inspector&&el.dataset.agent===state.drawerAgent;
  if(el.matches?.('.flow-node,.node'))el.classList.toggle('selected',selected);
  if(el.matches?.('.slp-seat-hit'))el.closest('.slp-seat,.slp-peer')?.classList.toggle('selected',selected);
  if(el.matches?.('.roster-agent'))el.classList.toggle('active',selected);
  el.setAttribute('aria-pressed',String(Boolean(selected)));
 });
}
state.drawerExpanded={};
function drawerDisclosureAttrs(name){const key=scopeKey()+':'+(state.drawerAgent||state.selected)+':'+name;return `data-drawer-disclosure="${esc(key)}"${state.drawerExpanded[key]?' open':''}`;}
function drawerAgentStatus(id){
 const a=agent(id);
 if(id==='lead'){
  const handoff=leadHandoffState();
  if(handoff.rotation==='handing_over')return {label:'Handoff',tone:'cyan'};
  if(handoff.rotation==='rotation_pending')return {label:'Handoff pending',tone:'amber'};
 }
 return {label:({running:'Working',idle:'Idle',attention:'Needs you',waiting:'Waiting',queued:'Waiting',completed:'Done',error:'Error'})[a.status]||statusLabel(a.status),tone:statusTone(a.status)};
}
function drawerTaskState(task){
 const tone=({running:'cyan',ready:'green',accepted:'green',attention:'amber',queued:'muted'})[task.status]||'muted';
 const glyph=({running:'activity',ready:'check',accepted:'check',attention:'alert',queued:'clock'})[task.status]||'clock';
 return `<span class="drawer-task-state ${tone}">${icon(glyph)}<span>${statusLabel(task.status)}</span></span>`;
}
function drawerWork(id){
 const a=agent(id),task=scopedTasks().find(item=>item.id===a.task);
 if(task)return `<section class="drawer-work"><h3 class="drawer-section-label">${icon('tasks')}<span>Current work</span></h3><button class="drawer-task-link" data-action="task" data-task="${task.id}" data-drawer-focus="task"><span class="drawer-task-code"><span>${esc(task.id)}</span>${drawerTaskState(task)}</span><strong>${esc(task.title)} ${icon('chevron')}</strong></button><div class="drawer-work-meta"><span class="${task.attempts.at(-1)==='green'?'green':task.attempts.at(-1)==='red'?'red':'muted'}">${icon(task.attempts.at(-1)==='green'?'check':task.attempts.at(-1)==='red'?'alert':'clock')}${task.attempts.at(-1)==='green'?'Gate green':task.attempts.at(-1)==='red'?'Gate red':'Gate pending'}</span><span>${task.attempts.length} attempts</span><span>${money(task.cost)}</span></div>${task.blocker?`<p class="drawer-blocker">${icon('alert')}<span>${esc(task.blocker)}</span></p>`:''}</section>`;
 if(['lead','supervisor'].includes(id)){
  const tasks=scopedTasks(),running=tasks.filter(item=>item.status==='running'),held=tasks.filter(item=>item.status==='queued');
  return `<section class="drawer-work"><div class="drawer-work-counts"><span class="drawer-count-running"><span class="status-mark running">${icon('activity')}</span><strong>${running.length}</strong> running</span><span class="drawer-count-queued"><span class="status-mark queued">${icon('clock')}</span><strong>${held.length}</strong> queued</span><span class="drawer-count-ready"><span class="status-mark ready">${icon('check')}</span><strong>${tasks.filter(item=>item.status==='ready').length}</strong> ready</span></div>${running.slice(0,3).map(item=>`<button class="drawer-work-row" data-action="task" data-task="${item.id}" data-drawer-focus="task-${item.id}"><span class="drawer-running-symbol">${icon('activity')}</span><span class="od-fill od-clamp-2">${esc(item.title)}</span>${icon('chevron')}</button>`).join('')||'<p class="drawer-muted">No Tasks are running.</p>'}${mode()==='scrum'&&!state.designDecision?'<p class="drawer-hold">Delivery is waiting for UI approval.</p>':''}</section>`;
 }
 return `<section class="drawer-work"><h3 class="drawer-section-label">${icon(id==='owner'?'user':id==='gate'?'shield':'tasks')}<span>${id==='owner'?'Your role':id==='gate'?'Readiness':'Current work'}</span></h3><p class="drawer-copy">${id==='owner'?'Resolve questions and accept verified work.':id==='gate'?'Delivery requires cross-artifact readiness and your design decision.':'No Task is assigned.'}</p>${id==='gate'?button('Review design','review','','ghost','design'):''}</section>`;
}
function drawerModel(id){
 const lane=drawerLane(id);if(!lane)return '';
 const a=agent(id),next=laneConfig(lane),hasDraft=Boolean(state.nextModels[scopeKey()+':'+mode()+':'+lane]);
 return `<div class="drawer-model-inline"><button class="drawer-model-edit" data-action="configure" data-role="${lane}" data-drawer-focus="configure" aria-label="Configure ${esc(a.name)} model: ${esc(a.provider)} ${esc(a.model)}" ${readonly()?'disabled':''}><span class="od-truncate">${esc(a.model)}<span class="drawer-model-thinking"> · ${esc(a.thinking||'High')}</span></span>${icon('settings')}</button></div>${hasDraft?`<div class="drawer-model-change"><span>${mode()==='scrum'?'Next run':'Configured lane'}:</span> ${esc(next.model)} · ${esc(next.thinking)}</div>`:''}`;
}
function drawerCapabilities(id){
 const role=drawerRole(id);if(!role)return '';
 const skills=drawerSkills(id),servers=drawerServers(id);
 const manage=(destination,label)=>`<button class="drawer-inline-action" data-workspace-destination="${destination}" data-context-agent="${id}" data-drawer-focus="${destination}" aria-label="Manage ${label} for ${esc(agent(id).name)}">Manage ${icon('chevron')}</button>`;
 return `<div class="drawer-resources"><div class="drawer-resource-row"><details class="drawer-disclosure" ${drawerDisclosureAttrs('skills')}><summary><span class="drawer-section-label drawer-skills-label">${icon('code')}<span>Skills</span></span><span class="drawer-resource-count">${skills.length}</span>${icon('chevron')}</summary><div class="drawer-disclosure-content">${skills.length?`<div class="drawer-skill-list">${skills.map(skill=>`<button data-ui="skill-detail" data-skill="${esc(skill.name)}">${esc(skill.name)}</button>`).join('')}</div>`:'<p class="drawer-muted">No role-wide skills. Task skills stay with their Contract.</p>'}</div></details>${manage('skills','Skills')}</div><div class="drawer-resource-row">${isTaskPeer(id)?`<details class="drawer-disclosure" ${drawerDisclosureAttrs('mcps')}><summary><span class="drawer-section-label drawer-mcp-label">${icon('plug')}<span>MCP</span></span><span class="drawer-resource-count">${servers.length}</span>${icon('chevron')}</summary><div class="drawer-disclosure-content">${servers.length?servers.map(server=>`<div class="drawer-server-row"><span class="dot ${server.health==='Sample connected'?'green':'muted'}"></span><strong>${esc(server.name)}</strong><span>${esc(server.health)}</span></div>`).join(''):'<p class="drawer-muted">No server synced to this Peer.</p>'}</div></details>`:`<div class="drawer-resource-static"><span class="drawer-section-label drawer-mcp-label">${icon('plug')}<span>MCP</span></span><small>Peer only</small></div>`}${manage('mcps','MCP')}</div></div>`;
}
function drawerMarkup(id){
 const a=agent(id),status=drawerAgentStatus(id);
 const latest=state.events.find(event=>(!event.project||event.project===state.project)&&event.task&&(event.task===a.task||['supervisor','lead'].includes(id)&&scopedTasks().some(item=>item.id===event.task)));
 return `<button class="agent-drawer-scrim" data-drawer-close aria-label="Close agent details" tabindex="-1"></button><aside class="agent-drawer" id="agent-drawer" role="dialog" aria-modal="false" aria-labelledby="agent-drawer-title" tabindex="-1"><header class="agent-drawer-header" data-agent-working="${agentIsWorking(id,a.status)}">${botAvatar(id)}<div class="drawer-header-identity"><div class="drawer-name-row"><h2 id="agent-drawer-title">${esc(a.name)}</h2><span class="drawer-status-inline ${status.tone}">${agentActivityMark(id,a.status)}${esc(status.label)}</span></div>${drawerModel(id)}</div><button class="icon-btn" data-drawer-close data-drawer-focus="close" aria-label="Close agent details">${icon('close')}</button></header><div class="agent-drawer-body">${drawerWork(id)}${id==='lead'?leadHandoffDetails():''}${drawerCapabilities(id)}<details class="drawer-disclosure drawer-technical" ${drawerDisclosureAttrs('session')}><summary><span class="drawer-section-label drawer-session-label">${icon('activity')}<span>Session & activity</span></span>${icon('chevron')}</summary><div class="drawer-disclosure-content"><dl class="data-list"><div><dt>Session</dt><dd>${id==='owner'?'You':id==='lead'?esc(leadHandoffState().session||'Unavailable'):'sample-'+esc(id)+'-03'}</dd></div><div><dt>Provider</dt><dd>${esc(a.provider)}</dd></div><div><dt>Data</dt><dd>Sample</dd></div></dl>${latest?`<div class="drawer-latest"><p>${esc(latest.text)}</p><small>${esc(latest.time)}</small></div>`:''}</div></details></div><footer class="agent-drawer-footer">${id==='owner'?button('Close details','drawer-close','','ghost'):id==='gate'?button('Review design','review','','primary','design'):`<button class="btn primary" data-action="open-agent" data-agent-id="${id}" data-drawer-focus="paseo">${icon('external')}${id==='supervisor'&&paseoSupervisorVacant()?'Start Supervisor in Paseo':'Open in Paseo'}</button>`}</footer></aside>`;
}
function mountAgentDrawer({resetScroll=false,focus=false}={}){
 const root=$('#agent-drawer-root');if(!root)return;
 if(!state.inspector||!state.drawerAgent||state.page!=='flow'){
  root.hidden=true;root.innerHTML='';$('#app').inert=false;return;
 }
 const oldBody=$('.agent-drawer-body',root),inside=root.contains?.(document.activeElement);
 const focusKey=inside?document.activeElement?.dataset?.drawerFocus:null;
 const scrollTop=resetScroll?0:Number(oldBody?.scrollTop??state.drawerScrollTop??0);
 root.hidden=false;root.innerHTML=drawerMarkup(state.drawerAgent);
 const mobile=window.matchMedia('(max-width:767px)').matches;
 $('#app').inert=mobile;$('#agent-drawer').setAttribute('aria-modal',String(mobile));
 const body=$('.agent-drawer-body',root);if(body)body.scrollTop=scrollTop;
 state.drawerScrollTop=scrollTop;
 if(focusKey)$(`[data-drawer-focus="${focusKey}"]`,root)?.focus({preventScroll:true});
 else if(focus)$('[data-drawer-close]',root)?.focus({preventScroll:true});
 drawerSelection();
}
function openAgentDrawer(id,trigger){
 if(readonly()){notify('Select a project to inspect its agents.');return;}
 const changed=id!==state.drawerAgent;drawerTrigger=trigger||document.activeElement;
 state.selected=id;state.drawerAgent=id;state.drawerProject=scopeKey();state.inspector=true;
 if(changed)state.drawerScrollTop=0;
 if(state.page!=='flow')navigate('flow');
 mountAgentDrawer({resetScroll:changed,focus:true});
}
function closeAgentDrawer({restoreFocus=true}={}){
 const body=$('.agent-drawer-body');if(body)state.drawerScrollTop=Number(body.scrollTop||0);
 state.inspector=false;
 const root=$('#agent-drawer-root');if(root){root.hidden=true;root.innerHTML='';}
 $('#app').inert=false;drawerSelection();
 if(restoreFocus){const trigger=drawerTrigger?.isConnected?drawerTrigger:$(`.connected-canvas [data-agent="${state.selected}"]`)||$(`[data-agent="${state.selected}"]`)||$('.nav-item.active');trigger?.focus({preventScroll:true});}
}
function workspaceSettings(destination,contextAgent=null){
 const agentId=contextAgent||(state.inspector?state.drawerAgent:null);
 state.workspaceReturnContext={project:state.project,hostId:activeHostId(),scope:scopeKey(),graphTab:state.graphTab,selected:state.selected,drawerAgent:state.drawerAgent,drawerOpen:Boolean(state.inspector),drawerScroll:Number($('.agent-drawer-body')?.scrollTop||0),top:Number(window.scrollY||0),left:Number(window.scrollX||0)};
 closeAgentDrawer({restoreFocus:false});
 if(destination==='models'){
  navigate('models');const lane=drawerLane(agentId);
  if(lane){const control=$(`[data-action="configure"][data-role="${lane}"]`);control?.focus({preventScroll:true});control?.scrollIntoView?.({block:'center',behavior:'instant'});}
 }else{
  state.integrationTab=destination==='skills'?'skills':'mcps';state.search='';
  if(destination==='skills'){state.skillRole=drawerRole(agentId);state.skillPack='All';state.skillTab='installed';}
  if(destination==='mcps'){state.mcpFilter='all';state.mcpSearch='';state.expandedMcp=null;}
  navigate('integrations');
 }
}
function returnToWorkspace(){
 const context=state.workspaceReturnContext;if(!context)return;
 state.workspaceReturnContext=null;
 if(context.project!==state.project||context.hostId!==activeHostId()){navigate('flow');return;}
 state.page='flow';state.graphTab='workflow';state.selected=context.selected;
 state.drawerAgent=context.drawerAgent;state.drawerProject=scopeKey();state.inspector=context.drawerOpen;
 state.drawerScrollTop=context.drawerScroll;render();
 window.scrollTo({top:context.top,left:context.left,behavior:'instant'});
 const target=state.inspector?$('[data-drawer-close]'):$(`.connected-canvas [data-agent="${state.selected}"]`);target?.focus({preventScroll:true});
}
const skillsBeforeContext=renderSkills;
renderSkills=function(){return (state.skillRole?`<div class="role-context-banner"><span>${icon('agents')}Skills for <strong>${esc(state.skillRole)}</strong></span><button data-skill-role-clear>Show all roles ${icon('close')}</button></div>`:'')+skillsBeforeContext();};
const renderBeforeDrawer=render;
render=function(){
 renderBeforeDrawer();
 if(state.workspaceReturnContext&&state.workspaceReturnContext.scope!==scopeKey())state.workspaceReturnContext=null;
 if(state.drawerProject&&state.drawerProject!==scopeKey()){closeAgentDrawer({restoreFocus:false});state.drawerAgent=null;state.drawerProject=null;}
 if(state.page!=='flow'&&state.inspector)closeAgentDrawer({restoreFocus:false});
 if(state.workspaceReturnContext&&['models','integrations'].includes(state.page)){
  const role=drawerRole(state.workspaceReturnContext.drawerAgent);
  const bar=`<div class="workspace-return-bar"><button data-workspace-return>${icon('chevron')}Back to workspace</button><span>${esc(state.project)}${role?' · '+esc(role):''}</span></div>`;
  $('#view').innerHTML=bar+$('#view').innerHTML;
 }
 mountAgentDrawer();
};
document.addEventListener('click',event=>{
 const buttonElement=event.target.closest('button');if(!buttonElement||buttonElement.disabled)return;
 if(buttonElement.hasAttribute('data-drawer-close')||buttonElement.dataset.action==='drawer-close')closeAgentDrawer();
 if(buttonElement.dataset.workspaceDestination)workspaceSettings(buttonElement.dataset.workspaceDestination,buttonElement.dataset.contextAgent||null);
 if(buttonElement.hasAttribute('data-workspace-return'))returnToWorkspace();
 if(buttonElement.hasAttribute('data-skill-role-clear')){state.skillRole=null;render();$('.catalog-search input')?.focus({preventScroll:true});}
});
document.addEventListener('toggle',event=>{const key=event.target.dataset?.drawerDisclosure;if(key)state.drawerExpanded[key]=event.target.open;},true);
document.addEventListener('keydown',event=>{
 if(!state.inspector||state.page!=='flow'||$('#modal').open)return;
 if(event.key==='Escape'){event.preventDefault();closeAgentDrawer();return;}
 if(event.key==='Tab'&&window.matchMedia('(max-width:767px)').matches){
  const controls=$$('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],summary',$('#agent-drawer'));
  if(!controls.length)return;const first=controls[0],last=controls.at(-1);
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
 }
});
window.addEventListener('resize',()=>{if(!state.inspector||state.page!=='flow')return;const mobile=window.matchMedia('(max-width:767px)').matches;$('#app').inert=mobile;$('#agent-drawer')?.setAttribute('aria-modal',String(mobile));});
render();
