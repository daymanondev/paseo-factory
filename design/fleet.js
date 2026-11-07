'use strict';
/* Sample fleet. Host IDs are local UI identities, never Paseo session handles. */
const fleetCopy=value=>JSON.parse(JSON.stringify(value));
state.hosts=[{id:'mac-local',name:'This Mac',os:'macOS',status:'online',snapshot:true,updated:'Sample snapshot'},{id:'mac-mini',name:'Macmini',os:'macOS',status:'online',snapshot:true,updated:'Sample snapshot'},{id:'windows',name:'Windows PC',os:'Windows',status:'not-connected',snapshot:false,updated:null}];
state.projects.forEach(p=>{p.hostId=p.name==='pos-tax'?'mac-mini':'mac-local';p.snapshot=true;});
state.projects.push({name:'project-c',label:'Project C',hostId:'windows',mode:null,path:null,snapshot:false});
state.tasks.forEach(task=>{task.hostId=task.project==='pos-tax'?'mac-mini':'mac-local';});
state.events.forEach(event=>{event.hostId='mac-local';event.project='research-slp';});
const fleetProjectFields=['designDecision','decisionRationale','questionAnswer','cancelledQuestion','approval','allowance','qaAllowance','fixRounds','linkedDesign','linkedPacks','profile','graphTab','retro','leadTelemetry'];
const fleetHostFields=['plugins','mcps','skills','profiles','events','vaultStage','vaultRepo','vaultBranch','vaultImported','vaultSynced'];
const fleetDefaults=Object.fromEntries(fleetProjectFields.map(key=>[key,state[key]===undefined?null:fleetCopy(state[key])]));
const fleetHostDefaults=Object.fromEntries(fleetHostFields.map(key=>[key,state[key]===undefined?null:fleetCopy(state[key])]));
state.fleetProjectState={};state.fleetHostState={};
state.hosts.forEach(host=>{state.fleetHostState[host.id]=fleetCopy(fleetHostDefaults);if(host.id!=='mac-local')state.fleetHostState[host.id].events=[];if(!host.snapshot){state.fleetHostState[host.id].plugins=[];state.fleetHostState[host.id].mcps=[];state.fleetHostState[host.id].skills=[];}});
state.fleetHostState['mac-mini'].events=[{text:'Receipt worker is implementing delivery status',task:'SLP-01',project:'pos-tax',hostId:'mac-mini',time:'Sample · 3m ago',tone:'cyan',icon:'code'},{text:'Reprint reviewer submitted a green attempt',task:'SLP-02',project:'pos-tax',hostId:'mac-mini',time:'Sample · 8m ago',tone:'green',icon:'check'}];
state.projects.forEach(p=>{state.fleetProjectState[scopeKey(p.name,p.hostId)]=fleetCopy(fleetDefaults);if(p.mode!=='scrum')state.fleetProjectState[scopeKey(p.name,p.hostId)].linkedDesign=false;});
state.fleetProjectState['mac-mini::pos-tax'].leadTelemetry={contextUsedTokens:131000,rotationState:'handing_over',queuedMailCount:2,sessionId:'sample-lead-03',lastHandoff:null};
state.fleetProjectState['windows::project-c'].leadTelemetry=null;
state.hostId='mac-local';state.project='research-slp';state.page='flow';state.inspector=false;
state.fleetLoadedHost=null;state.fleetLoadedScope=null;state.fleetSearch='';state.fleetAttentionOnly=false;
state.pinnedProjects=['mac-local::research-slp','mac-mini::pos-tax','windows::project-c'];state.teamExpanded={};
try{const pins=JSON.parse(localStorage.getItem('factory.pinned-projects')||'null');if(Array.isArray(pins))state.pinnedProjects=[...new Set(pins.filter(key=>typeof key==='string'&&state.projects.some(p=>scopeKey(p.name,p.hostId)===key)))];}catch{}
try{state.teamExpanded=JSON.parse(localStorage.getItem('factory.team-expanded')||'{}')||{};}catch{}
shapes.host='<rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8m-4-5v5"/>';
shapes.pin='<path d="m15 3 6 6-4 1-4 7-3-3-7 7m7-7-3-3 7-4Z"/>';
function fleetHost(id=activeHostId()){return state.hosts.find(host=>host.id===id);}
function fleetProject(name=state.project,hostId=activeHostId()){return state.projects.find(p=>p.name===name&&p.hostId===hostId);}
function fleetProjectName(p){return p?.label||p?.name||'All projects';}
function fleetScopeLabel(){return state.project==='all'?(state.hostId==='all'?'All Hosts / All projects':`${fleetHost(state.hostId)?.name||'Host'} / All projects`):`${fleetHost()?.name||'Host'} / ${fleetProjectName(project())}`;}
function fleetOnline(hostId=activeHostId()){return fleetHost(hostId)?.status==='online';}
function fleetProjects(){const host=state.project==='all'?state.hostId:activeHostId();return state.projects.filter(p=>(host==='all'||p.hostId===host)&&(state.project==='all'||p.name===state.project));}
function fleetProjectTasks(p){return state.tasks.filter(task=>task.hostId===p.hostId&&task.project===p.name);}
function fleetRun(p){return state.fleetLoadedScope===scopeKey(p.name,p.hostId)?Object.fromEntries(fleetProjectFields.map(key=>[key,state[key]])):state.fleetProjectState[scopeKey(p.name,p.hostId)]||fleetDefaults;}
function fleetSaveContext(){
 if(state.fleetLoadedScope&&state.fleetLoadedScope!=='all')state.fleetProjectState[state.fleetLoadedScope]=Object.fromEntries(fleetProjectFields.map(key=>[key,state[key]===undefined?null:fleetCopy(state[key])]));
 if(state.fleetLoadedHost&&state.fleetLoadedHost!=='all')state.fleetHostState[state.fleetLoadedHost]=Object.fromEntries(fleetHostFields.map(key=>[key,state[key]===undefined?null:fleetCopy(state[key])]));
}
function fleetSyncContext(){
 const host=activeHostId(),key=state.project==='all'?'all':scopeKey();
 if(host===state.fleetLoadedHost&&key===state.fleetLoadedScope)return;
 fleetSaveContext();
 if(host!==state.fleetLoadedHost){const snapshot=state.fleetHostState[host]||fleetHostDefaults;fleetHostFields.forEach(field=>{state[field]=fleetCopy(snapshot[field]??fleetHostDefaults[field]);});if(host==='all')state.events=Object.values(state.fleetHostState).flatMap(item=>item.events||[]);}
 const run=state.fleetProjectState[key]||fleetDefaults;fleetProjectFields.forEach(field=>{state[field]=fleetCopy(Object.hasOwn(run,field)?run[field]:fleetDefaults[field]);});
 state.fleetLoadedHost=host;state.fleetLoadedScope=key;state.skillRole=null;state.expandedMcp=null;
}
function fleetInboxItems(projects=fleetProjects()){
 return projects.flatMap(p=>{
  if(!p.snapshot||!fleetOnline(p.hostId)||state.emptyProjects?.has(scopeKey(p.name,p.hostId)))return [];
  const run=fleetRun(p),items=[];
  if(p.mode==='scrum'&&!run.designDecision)items.push({kind:'design',title:'Review workspace design revision 3',detail:'UX Designer is waiting for your decision.',project:p,task:'SCR-02',tone:'amber',action:'Open review'});
  if(p.mode==='scrum'&&!run.questionAnswer&&!run.cancelledQuestion)items.push({kind:'question',title:'Should completed agents stay visible?',detail:'Architect · REQ-02 · independent work continues.',project:p,task:'SCR-03',tone:'cyan',action:'Open question'});
  for(const task of fleetProjectTasks(p).filter(task=>task.status==='attention'||task.mode==='slp'&&task.status==='ready'))items.push({kind:'task',title:task.title,detail:task.blocker||`${task.id} · green attempt ready for acceptance`,project:p,task:task.id,tone:task.status==='ready'?'green':'amber',action:'Inspect task'});
  return items;
 });
}
function fleetPhase(p){if(!p.snapshot||!fleetOnline(p.hostId))return 'No snapshot';const tasks=fleetProjectTasks(p),run=fleetRun(p);if(!tasks.length)return 'No run started';if(p.mode==='scrum')return !run.designDecision?'UI approval pending':run.designDecision==='changes'?'Design changes requested':'Readiness pending';return tasks.some(task=>task.status==='running')?'Executing Tasks':tasks.some(task=>task.status==='attention')?'Needs attention':tasks.every(task=>task.status==='accepted')?'Everything accepted':'Awaiting acceptance';}
function fleetConnection(host){return badge(host.status==='online'?'Online · sample':'Not connected',host.status==='online'?'green':'amber',true);}
function fleetProjectButton(p,label='Open workspace'){return `<button class="fleet-open-project" data-fleet-project="${esc(p.name)}" data-fleet-host="${p.hostId}">${label}${icon('chevron')}</button>`;}
function fleetHostFilter(){return `<label class="fleet-host-filter"><span>Host</span><select data-fleet-host-filter><option value="all">All Hosts</option>${state.hosts.map(host=>`<option value="${host.id}" ${state.hostId===host.id?'selected':''}>${esc(host.name)}</option>`).join('')}</select></label>`;}
function fleetOverviewState(p,tasks){
 const host=fleetHost(p.hostId),run=fleetRun(p),running=tasks.filter(task=>task.status==='running').length;
 if(!p.snapshot||!fleetOnline(p.hostId))return {label:host.status==='online'?'Awaiting snapshot':'Not connected',tone:'muted',glyph:'host',detail:'No snapshot'};
 if(!tasks.length)return {label:'No run started',tone:'muted',glyph:'clock',detail:''};
 const detail=running?`${running} running`:'';
 if(p.mode==='scrum'&&!run.designDecision)return {label:'UI approval pending',tone:'amber',glyph:'design',detail};
 if(tasks.some(task=>task.status==='attention'))return {label:'Needs attention',tone:'amber',glyph:'alert',detail};
 if(p.mode==='scrum'&&run.designDecision==='changes')return {label:'Design changes requested',tone:'amber',glyph:'design',detail};
 if(running)return {label:'Executing Tasks',tone:'cyan',glyph:'activity',detail};
 if(tasks.every(task=>task.status==='accepted'))return {label:'Everything accepted',tone:'green',glyph:'check',detail:''};
 if(p.mode==='slp'&&tasks.some(task=>task.status==='ready'))return {label:'Ready to accept',tone:'green',glyph:'check',detail:''};
 return {label:p.mode==='scrum'?'Readiness pending':'Tasks queued',tone:'muted',glyph:'clock',detail:''};
}
function renderFleetOverview(){
 const inbox=fleetInboxItems(),pendingFor=p=>inbox.filter(item=>item.project.hostId===p.hostId&&item.project.name===p.name).length;
 const visible=fleetProjects().filter(p=>!state.fleetSearch||(fleetProjectName(p)+' '+fleetHost(p.hostId).name).toLowerCase().includes(state.fleetSearch.toLowerCase())).filter(p=>!state.fleetAttentionOnly||pendingFor(p));
 return `<div class="fleet-toolbar">${fleetHostFilter()}<button class="fleet-attention-toggle ${state.fleetAttentionOnly?'selected':''}" data-fleet-action="attention-filter" aria-pressed="${state.fleetAttentionOnly}" aria-label="Filter projects with known pending decisions">${icon('inbox')}<span>Needs attention</span><span class="fleet-attention-count">${fleetProjects().filter(p=>pendingFor(p)>0).length}</span></button><span class="spacer"></span><div class="fleet-search">${icon('search')}<label class="sr-only" for="fleet-search">Find a project or Host</label><input id="fleet-search" value="${esc(state.fleetSearch)}" placeholder="Find project or Host…"></div><button class="btn ghost" data-fleet-action="add-project">${icon('plus')}Add Project</button></div><section class="fleet-project-list" aria-label="Projects"><div class="fleet-list-head" aria-hidden="true"><span>Project</span><span>Activity</span><span>Needs you</span><span></span></div><div role="list">${visible.map(p=>{
  const host=fleetHost(p.hostId),known=p.snapshot&&fleetOnline(p.hostId),tasks=fleetProjectTasks(p),pending=pendingFor(p),activity=fleetOverviewState(p,tasks);
  return `<article class="fleet-project-item ${known?'':'unknown'}" role="listitem"><div class="fleet-item-project"><span class="fleet-item-avatar" aria-hidden="true">${esc(fleetProjectName(p).slice(0,2))}</span><div class="fleet-item-name"><h2><button data-fleet-project="${esc(p.name)}" data-fleet-host="${p.hostId}" aria-label="Open ${esc(fleetProjectName(p))} on ${esc(host.name)}">${esc(fleetProjectName(p))}</button></h2><div class="fleet-item-meta"><span>${typeof hostAvatar==='function'?hostAvatar(host):icon('host')}${esc(host.name)}</span>${p.mode?`<span class="fleet-item-mode">${p.mode==='scrum'?'Scrum':'SLP'}</span>`:''}</div></div></div><div class="fleet-item-activity"><span class="fleet-item-phase ${activity.tone}">${icon(activity.glyph)}<span>${esc(activity.label)}</span></span>${activity.detail?`<small>${esc(activity.detail)}</small>`:''}</div><div class="fleet-item-attention">${!known?'<span class="fleet-item-unknown">Unknown</span>':pending?`<button class="fleet-needs-button" data-fleet-project="${esc(p.name)}" data-fleet-host="${p.hostId}" data-fleet-project-page="inbox" aria-label="${pending} decisions for ${esc(fleetProjectName(p))} on ${esc(host.name)}">${icon('alert')}<strong>${pending}</strong><span>${pending===1?'needs you':'need you'}</span></button>`:'<span class="fleet-item-clear">All clear</span>'}</div><div class="fleet-project-actions">${fleetProjectPin(p)}${fleetProjectButton(p,known?'Open':'Details')}${typeof projectRowLauncher==='function'?projectRowLauncher(p):''}</div></article>`;
 }).join('')||'<div class="empty"><h3>No projects match</h3><p>Clear the search or change the Host filter.</p></div>'}</div></section>`;
}
function renderFleetHosts(){return `<div class="fleet-toolbar"><span class="muted small">${state.hosts.length} Hosts · macOS and Windows</span><span class="spacer"></span><button class="btn primary" data-fleet-action="add-host">${icon('plus')}Add Host</button></div><section class="fleet-host-list">${state.hosts.map(host=>{const projects=state.projects.filter(p=>p.hostId===host.id);return `<article class="fleet-host-row"><span class="fleet-host-mark factory-host-mark">${typeof hostAvatar==='function'?hostAvatar(host):icon('host')}</span><div class="fleet-host-name"><h2>${esc(host.name)}</h2><p>${host.os} · ${projects.length} project${projects.length===1?'':'s'}</p></div><div>${fleetConnection(host)}<small class="fleet-last-seen">${host.updated||'No snapshot available'}</small></div><div class="fleet-host-actions"><button class="btn ghost" data-fleet-action="host-projects" data-host-id="${host.id}">View projects</button><button class="btn ghost" data-fleet-action="host-details" data-host-id="${host.id}">${host.status==='online'?'Manage':'Connect'}</button></div></article>`;}).join('')}</section><div class="fleet-host-explanation"><h3>One workspace. Several machines.</h3><p>Paseo owns Host authentication and connections. Factory keeps each Host’s projects, agents, and configuration separate. The two online Macs here are examples; this preview has no live connection to any machine.</p></div>`;}
function renderFleetInbox(){const items=fleetInboxItems();return `<div class="fleet-toolbar">${fleetHostFilter()}</div><section class="fleet-inbox-list">${items.map(item=>`<article class="fleet-inbox-row"><span class="status-mark ${item.tone==='green'?'ready':item.tone==='cyan'?'running':'attention'}">${icon(item.kind==='design'?'design':item.kind==='question'?'info':item.tone==='green'?'check':'alert')}</span><div class="fleet-inbox-copy"><div class="fleet-context-label">${esc(fleetHost(item.project.hostId).name)} <span>/</span> ${esc(fleetProjectName(item.project))}</div><h3>${esc(item.title)}</h3><p>${esc(item.detail)}</p></div><button class="btn ghost" data-fleet-inbox="${item.kind}" data-fleet-host="${item.project.hostId}" data-fleet-project="${esc(item.project.name)}" data-fleet-task="${item.task}">${item.action}${icon('chevron')}</button></article>`).join('')||'<div class="empty"><h3>No decisions in the available snapshots</h3><p>Activity on disconnected Hosts is still unknown.</p></div>'}</section><div class="fleet-footnote">Each action opens its own Host and Project first. An unavailable Host has unknown activity, not a failed agent.</div>`;}
function renderOfflineProject(){const host=fleetHost();return `<div class="fleet-offline"><span class="fleet-host-mark factory-host-mark">${typeof hostAvatar==='function'?hostAvatar(host):icon('host')}</span><h2>${esc(host?.name||'Host')} is not connected</h2><p>${esc(fleetProjectName(project()))} has no available snapshot. Agent status, Tasks, and cost are unknown.</p><div class="od-row">${fleetConnection(host)}<button class="btn primary" data-fleet-action="host-details" data-host-id="${host.id}">Connect through Paseo</button><button class="btn ghost" data-fleet-action="all-projects">All projects</button></div><small>No commands are queued or redirected to another machine.</small></div>`;}
function fleetSetAll(hostId='all'){fleetSaveContext();closeAgentDrawer({restoreFocus:false});state.hostId=hostId;state.project='all';state.drawerAgent=null;state.drawerProject=null;state.workspaceReturnContext=null;fleetSyncContext();}
function selectFleetProject(hostId,name,page='flow'){
 const p=fleetProject(name,hostId);if(!p)return notify('That Host–Project is no longer available.',true);
 fleetSaveContext();closeAgentDrawer({restoreFocus:false});if($('#modal').open)closeModal();
 state.hostId=hostId;state.project=name;state.page=page;state.filter='all';state.search='';state.workspaceReturnContext=null;state.drawerAgent=null;state.drawerProject=null;
 fleetSyncContext();state.selected=p.mode==='scrum'?'ux':'peer-1';render();window.scrollTo({top:0,behavior:'instant'});$('#main').focus({preventScroll:true});
}
selectProject=function(name,hostId){
 if(name==='all'){fleetSetAll(state.hostId);state.page='overview';closeModal();render();return;}
 const matches=state.projects.filter(p=>p.name===name&&(hostId?p.hostId===hostId:state.hostId==='all'||p.hostId===state.hostId));
 if(matches.length!==1)return showProjects();selectFleetProject(matches[0].hostId,name);
};
showProjects=function(){openModal('Switch workspace',`<div class="field"><label for="fleet-project-search">Find project or Host</label><input id="fleet-project-search" placeholder="Search workspaces…"></div><button class="fleet-switch-all" data-fleet-action="all-projects">${icon('folder')}All projects<span class="spacer"></span>${badge(state.projects.length+' projects')}</button>${state.hosts.map(host=>`<section class="fleet-switch-group"><h3>${typeof hostAvatar==='function'?hostAvatar(host):icon('host')}${esc(host.name)}<span>${host.os}</span></h3>${state.projects.filter(p=>p.hostId===host.id).map(p=>`<div class="fleet-switch-row" data-switch-match="${esc((fleetProjectName(p)+' '+host.name).toLowerCase())}"><button data-fleet-project="${esc(p.name)}" data-fleet-host="${host.id}"><span class="project-avatar">${esc(fleetProjectName(p).slice(0,2))}</span><span class="od-field od-fill"><strong>${esc(fleetProjectName(p))}</strong><small>${host.status==='online'?(p.mode==='scrum'?'Agile Scrum':'SLP'):'Not connected · no snapshot'}</small></span>${icon('chevron')}</button><button class="icon-btn ${state.pinnedProjects.includes(scopeKey(p.name,p.hostId))?'pinned':''}" data-fleet-action="pin" data-fleet-project-name="${esc(p.name)}" data-host-id="${host.id}" aria-label="Pin ${esc(fleetProjectName(p))}" aria-pressed="${state.pinnedProjects.includes(scopeKey(p.name,p.hostId))}">${icon('pin')}</button></div>`).join('')}</section>`).join('')}<div class="dialog-actions"><button class="btn ghost" data-fleet-action="add-project">${icon('plus')}Add Project</button><button class="btn ghost" data-fleet-action="add-host">${icon('host')}Add Host</button></div>`);};
function fleetHostDetails(id){const host=fleetHost(id);if(!host)return;openModal(host.name,`${fleetConnection(host)}<p style="margin-top:18px">${host.status==='online'?'This Host has an illustrative snapshot in the prototype.':'This Host has no connection or available snapshot.'} Paseo manages the real connection and authentication.</p><div class="field"><label for="host-alias">Display name</label><input id="host-alias" value="${esc(host.name)}"></div><dl class="data-list"><div><dt>System</dt><dd>${host.os}</dd></div><div><dt>Projects</dt><dd>${state.projects.filter(p=>p.hostId===id).length}</dd></div><div><dt>Live server ID</dt><dd>Not connected in this prototype</dd></div><div><dt>Last data</dt><dd>${host.updated||'Unavailable'}</dd></div></dl><div class="dialog-actions"><button class="btn ghost" data-fleet-action="host-projects" data-host-id="${id}">View projects</button><button class="btn primary" data-fleet-action="save-host-name" data-host-id="${id}">Save name</button></div><div class="fleet-modal-note">To connect a real machine, use Paseo’s Host connection flow. No login or network operation is performed by this preview.</div>`);}
function fleetAddHost(){openModal('Add Host','<p>Add a Host entry, then connect the machine through Paseo. This preview records the entry as Not connected.</p><div class="field"><label for="new-host-name">Host name</label><input id="new-host-name" placeholder="Build machine"></div><div class="field"><label for="new-host-os">Operating system</label><select id="new-host-os"><option>macOS</option><option>Windows</option><option>Linux</option></select></div><span id="new-host-error" class="error" hidden>Enter a name for the Host.</span><div class="dialog-actions"><button class="btn ghost" data-action="close-modal">Cancel</button><button class="btn primary" data-fleet-action="save-host">Add Host entry</button></div>');}
function fleetAddProject(){openModal('Add Project','<p>Add a sample Project to a specific Host. No folder is read or created.</p><div class="field"><label for="new-project-host">Host</label><select id="new-project-host">'+state.hosts.map(host=>`<option value="${host.id}" ${host.id===activeHostId()?'selected':''} ${host.status!=='online'?'disabled':''}>${esc(host.name)}${host.status!=='online'?' · connect first':''}</option>`).join('')+'</select></div><div class="field"><label for="new-project-path">Git repository path</label><input id="new-project-path" placeholder="/path/to/repo or C:\\work\\repo"></div><span class="error" id="fleet-project-error" hidden>Enter an absolute path on a connected sample Host.</span><div class="dialog-actions"><button class="btn ghost" data-action="close-modal">Cancel</button><button class="btn primary" data-fleet-action="save-project">Add Project</button></div>');}
function fleetProjectPin(p,placement='row'){
 const pinned=state.pinnedProjects.includes(scopeKey(p.name,p.hostId)),label=(pinned?'Unpin ':'Pin ')+fleetProjectName(p)+' on '+fleetHost(p.hostId).name;
 return `<button class="project-pin-button project-pin-${placement} ${pinned?'pinned':''}" data-fleet-action="pin" data-fleet-project-name="${esc(p.name)}" data-host-id="${p.hostId}" aria-label="${esc(label)}" title="${esc(label)}" aria-pressed="${pinned}">${icon('pin')}</button>`;
}
function fleetRefreshPinControls(){
 const pinned=$('#pinned-projects');if(pinned)pinned.innerHTML=fleetPinnedMarkup();
 $$('[data-fleet-action="pin"]').forEach(control=>{
  const p=fleetProject(control.dataset.fleetProjectName,control.dataset.hostId);if(!p)return;
  const isPinned=state.pinnedProjects.includes(scopeKey(p.name,p.hostId)),label=(isPinned?'Unpin ':'Pin ')+fleetProjectName(p)+' on '+fleetHost(p.hostId).name;
  control.classList.toggle('pinned',isPinned);control.setAttribute('aria-pressed',String(isPinned));control.setAttribute('aria-label',label);control.setAttribute('title',label);
 });
}
function fleetPinnedMarkup(){
 const items=state.pinnedProjects.map(key=>state.projects.find(p=>scopeKey(p.name,p.hostId)===key)).filter(Boolean);
 return `<div class="fleet-pinned-heading">${icon('pin')}<span>Pinned</span></div>${items.map(p=>{const host=fleetHost(p.hostId);return `<button class="fleet-pinned-row ${state.project===p.name&&activeHostId()===p.hostId?'selected':''}" data-fleet-project="${esc(p.name)}" data-fleet-host="${p.hostId}" title="${esc(fleetProjectName(p))} · ${esc(host?.name||'Host')}"><span class="fleet-pinned-host-icon" aria-hidden="true">${typeof hostAvatar==='function'?hostAvatar(host):icon('host')}</span><strong class="od-truncate">${esc(fleetProjectName(p))}</strong><span class="dot ${fleetOnline(p.hostId)?'green':'amber'}" aria-hidden="true"></span></button>`;}).join('')||'<p class="fleet-no-pins">No pinned projects</p>'}`;
}
function renderTopbarCrumb(){
 const crumb=$('#topbar-crumb');if(!crumb)return;
 const all=state.project==='all',host=state.page==='daemon'&&typeof daemonSettingsHost==='function'?daemonSettingsHost():fleetHost(),p=project();
 const compactTitles={overview:'All projects',tasks:'Tasks',hosts:'Hosts',inbox:'Needs you',activity:'Activity',models:'Agents & Models',integrations:'Integrations',design:'Open Design',vault:'Private Vault',settings:'Settings',daemon:'Daemon settings'};
 if(!all&&p){
  crumb.innerHTML=`<span class="crumb-host-pill">${typeof hostAvatar==='function'?hostAvatar(host):icon('host')}<span class="crumb-host-name">${esc(host?.name||'Host')}</span></span><span class="crumb-sep" aria-hidden="true">/</span><span class="crumb-project-pill"><strong id="breadcrumb">${esc(fleetProjectName(p))}</strong><span class="crumb-mode-tag">${p.mode==='scrum'?'Scrum':'SLP'}</span></span><span class="crumb-caret" aria-hidden="true">${icon('chevrons')}</span>`;
 }else{
  const hostName=state.hostId==='all'&&state.page!=='daemon'?'All Hosts':(host?.name||'All Hosts');
  const pageTitle=compactTitles[state.page]||'All projects';
  crumb.innerHTML=`<span class="crumb-host-pill">${host&&state.hostId!=='all'&&typeof hostAvatar==='function'?hostAvatar(host):icon('host')}<span class="crumb-host-name">${esc(hostName)}</span></span><span class="crumb-sep" aria-hidden="true">/</span><span class="crumb-project-pill"><strong id="breadcrumb">${esc(pageTitle)}</strong></span><span class="crumb-caret" aria-hidden="true">${icon('chevrons')}</span>`;
 }
}
const fleetShellBefore=syncShell;
syncShell=function(){
 fleetShellBefore();
 const all=state.project==='all',host=fleetHost(),p=project();
 renderTopbarCrumb();
 const globalPending=fleetInboxItems(state.projects).length;$('#nav-inbox-count').textContent=globalPending;$('#nav-inbox-count').hidden=globalPending===0;if(state.hostId!=='all'&&!fleetOnline(state.hostId))$('#nav-task-count').textContent='—';
 const compactTitles={overview:'All projects',tasks:'Tasks',hosts:'Hosts',inbox:'Needs you',activity:'Activity',models:'Agents & Models',integrations:'Integrations',design:'Open Design',vault:'Private Vault',settings:'Settings',daemon:'Daemon settings'};
 if(compactTitles[state.page]||state.page==='flow'&&all)$('.page-heading').outerHTML='<div class="page-heading compact-page-heading"><h1 class="sr-only">'+(compactTitles[state.page]||'All projects')+'</h1></div>';
 if(state.page!=='daemon'&&state.page!=='settings'&&!all&&!fleetOnline())$('.page-heading').outerHTML=heading(fleetProjectName(p),host.name+' · No snapshot available',badge('Not connected','amber'));
 const pinned=$('#pinned-projects');if(pinned)pinned.innerHTML=fleetPinnedMarkup();
 const roster=$('#team-roster');
 if(roster){
  roster.hidden=all||state.page==='daemon';
  if(!all){
   const key=scopeKey(),online=fleetOnline();
   const ids=online?(mode()==='scrum'?['supervisor','lead','pm','ux','architect','dev','qa']:['supervisor','lead',...slpAuthorityPeerIds()]):[];
   const rows=ids.map(id=>{const a=agent(id);return `<button class="roster-agent ${state.selected===id&&state.inspector?'active':''}" data-agent="${id}" data-agent-working="${agentIsWorking(id,a.status)}" aria-label="Inspect ${esc(a.name)}">${botAvatar(id)}<span class="od-field od-fill"><strong>${esc(a.short||a.name)}</strong><small class="od-truncate">${esc(friendlyStatus(id))}</small></span>${agentActivityMark(id,a.status)}</button>`;}).join('');
   const running=ids.filter(id=>agent(id).status==='running').length,attention=ids.filter(id=>agent(id).status==='attention').length;
   roster.innerHTML=`<details class="fleet-team" id="team-disclosure" data-team-scope="${esc(key)}" ${state.teamExpanded[key]?'open':''}><summary><span class="fleet-team-title">The team<span>${online?ids.length:'—'}</span></span><span class="fleet-team-counts">${online?`${running} working · ${attention} need you`:'Host not connected'}</span></summary><div class="fleet-team-content">${online?rows:'<p>Agent data is unavailable until this Host connects.</p>'}</div></details>`;
  }
 }
 $$('.nav-item[data-nav]').forEach(buttonElement=>{const page=buttonElement.dataset.nav,active=page===state.page||(page==='overview'&&state.page==='flow'&&all)||(page==='settings'&&['hosts','daemon'].includes(state.page));buttonElement.classList.toggle('active',active);if(active)buttonElement.setAttribute('aria-current','page');else buttonElement.removeAttribute('aria-current');if(['flow','activity','models','integrations','design','vault'].includes(page))buttonElement.disabled=all;});
 const hostCount=$('#nav-host-count');if(hostCount)hostCount.textContent=state.hosts.length;
 $('#main').classList.toggle('management-page',['models','integrations','design','vault','settings','hosts','daemon'].includes(state.page));
};
const fleetFlowBefore=renderFlow;
renderFlow=function(){if(state.project==='all')return renderFleetOverview();if(!fleetOnline())return renderOfflineProject();return fleetFlowBefore();};
const fleetInboxBefore=renderInbox;
renderInbox=function(){return state.project==='all'?renderFleetInbox():!fleetOnline()?renderOfflineProject():fleetInboxBefore();};
const fleetOpenDrawerBefore=openAgentDrawer;
openAgentDrawer=function(id,trigger){if(state.project!=='all'&&!fleetOnline())return notify('This Host is not connected. No agent data is available.',true);fleetOpenDrawerBefore(id,trigger);};
const fleetOpenModalBefore=openModal;
openModal=function(title,body,wide=false){const context=state.project!=='all'?`<div class="fleet-modal-scope">${icon('host')}${esc(fleetScopeLabel())}</div>`:'';fleetOpenModalBefore(title,context+body,wide);};
const fleetTaskBefore=showTask;
showTask=function(id){const task=findTask(id);if(!task)return notify('Select the Host and Project for this Task first.',true);if(state.project==='all')selectFleetProject(task.hostId,task.project,'tasks');fleetTaskBefore(id);};
const fleetLogBefore=log;
log=function(...args){fleetLogBefore(...args);if(state.events[0]){state.events[0].hostId=activeHostId();state.events[0].project=state.project;}};
const fleetActivityBefore=renderActivity;
renderActivity=function(){const events=state.events;state.events=events.filter(event=>event.hostId===activeHostId()&&event.project===state.project);try{return fleetActivityBefore();}finally{state.events=events;}};
const fleetTaskRowBefore=taskRow;
taskRow=function(task){return fleetTaskRowBefore(task).replace('<span class="task-project-name">'+esc(task.project),'<span class="task-project-name">'+esc(fleetHost(task.hostId)?.name)+' / '+esc(task.project)).replace('<article ',`<article data-task-host="${esc(task.hostId)}" data-task-project="${esc(task.project)}" `);};
const fleetTaskCardBefore=compactTaskCard;
compactTaskCard=function(task){return fleetTaskCardBefore(task).replace('<article ',`<article data-task-host="${esc(task.hostId)}" data-task-project="${esc(task.project)}" `);};
const fleetRenderBefore=render;
render=function(){
 if(state.page==='hosts'){state.settingsTab='hosts';state.page='settings';}
 if(state.page==='daemon'){state.settingsTab='daemon';state.page='settings';}
 if(state.page==='overview'&&state.project!=='all')fleetSetAll(state.hostId);
 fleetSyncContext();
 if(state.page==='overview'){
  closeAgentDrawer({restoreFocus:false});syncShell();$('#view').innerHTML=renderFleetOverview();refreshIcons();
 }else if(state.page==='settings'){
  closeAgentDrawer({restoreFocus:false});syncShell();$('#view').innerHTML=renderSettings();refreshIcons();
 }else if(state.project!=='all'&&!fleetOnline()||state.project==='all'&&state.hostId!=='all'&&!fleetOnline(state.hostId)&&state.page==='tasks'){
  closeAgentDrawer({restoreFocus:false});syncShell();$('#view').innerHTML=renderOfflineProject();refreshIcons();
 }else if(state.project==='all'&&['activity','models','integrations','design','vault'].includes(state.page)){
  syncShell();$('#view').innerHTML='<div class="fleet-offline"><h2>Select a project first</h2><p>Each Host owns its own agent roster, activity, and configuration.</p><button class="btn primary" data-action="projects">Choose Host & Project</button></div>';refreshIcons();
 }else fleetRenderBefore();
 const backContext=$('.workspace-return-bar>span');if(backContext&&state.workspaceReturnContext)backContext.textContent=fleetScopeLabel();
};
commands.unshift(['All projects','overview','folder'],['Hosts','hosts','host']);
commandResults=function(query=''){const q=query.toLowerCase(),pages=commands.filter(([name])=>name.toLowerCase().includes(q)),tasks=scopedTasks().filter(task=>(task.id+' '+task.title+' '+task.project).toLowerCase().includes(q));return pages.map(([name,page,glyph])=>`<button class="command-result" data-action="command" data-page="${page}">${icon(glyph)}<span class="od-fill">${name}</span>${icon('chevron')}</button>`).join('')+(q?tasks.slice(0,6).map(task=>`<button class="command-result" data-action="task" data-task="${task.id}" data-task-host="${task.hostId}" data-task-project="${esc(task.project)}">${icon('tasks')}<span class="od-field"><strong class="small">${esc(task.id)} · ${esc(task.title)}</strong><span class="small muted">${esc(fleetHost(task.hostId).name)} / ${esc(task.project)}</span></span></button>`).join(''):'')||'<div class="empty">No matching pages or Tasks.</div>';};
document.addEventListener('click',event=>{
 const el=event.target.closest('button');if(!el||el.disabled)return;
 if(el.dataset.fleetGlobal){fleetSetAll('all');return;}
 const taskContainer=el.dataset.taskHost?el:el.closest('[data-task-host]');
 if(['task','open-agent'].includes(el.dataset.action)&&taskContainer?.dataset.taskHost&&taskContainer.dataset.taskProject&&(state.project!==taskContainer.dataset.taskProject||activeHostId()!==taskContainer.dataset.taskHost))selectFleetProject(taskContainer.dataset.taskHost,taskContainer.dataset.taskProject,'tasks');
},true);
document.addEventListener('click',event=>{
 const el=event.target.closest('button');if(!el||el.disabled)return;
 if(el.dataset.fleetInbox){const kind=el.dataset.fleetInbox;selectFleetProject(el.dataset.fleetHost,el.dataset.fleetProject,'inbox');if(!fleetOnline())return;if(kind==='design')review();else if(kind==='question')showQuestion();else showTask(el.dataset.fleetTask);return;}
 if(el.dataset.fleetProject&&el.dataset.fleetHost){selectFleetProject(el.dataset.fleetHost,el.dataset.fleetProject,el.dataset.fleetProjectPage==='inbox'?'inbox':'flow');return;}
 const action=el.dataset.fleetAction;
 if(action==='all-projects'){fleetSetAll('all');state.page='overview';closeModal();render();}
 if(action==='attention-filter'){state.fleetAttentionOnly=!state.fleetAttentionOnly;render();}
 if(action==='host-projects'){fleetSetAll(el.dataset.hostId);state.page='overview';closeModal();render();}
 if(action==='host-details')fleetHostDetails(el.dataset.hostId);
 if(action==='save-host-name'){const name=$('#host-alias').value.trim();if(!name)return notify('Enter a display name.',true);fleetHost(el.dataset.hostId).name=name;closeModal();render();notify('Host display name saved in this preview.');}
 if(action==='add-host')fleetAddHost();
 if(action==='save-host'){
  const name=$('#new-host-name').value.trim();if(!name){$('#new-host-error').hidden=false;return;}
  const id='sample-host-'+Date.now().toString(36);state.hosts.push({id,name,os:$('#new-host-os').value,status:'not-connected',snapshot:false,updated:null});state.fleetHostState[id]=fleetCopy(fleetHostDefaults);state.fleetHostState[id].plugins=[];state.fleetHostState[id].mcps=[];state.fleetHostState[id].skills=[];state.fleetHostState[id].events=[];
  closeModal();fleetSetAll('all');state.page='hosts';render();notify('Host entry added as Not connected. No machine was contacted.');
 }
 if(action==='add-project')fleetAddProject();
 if(action==='save-project'){
  const hostId=$('#new-project-host').value,path=$('#new-project-path').value.trim().replace(/[\\/]$/,''),name=path.split(/[\\/]/).at(-1);
  if(!fleetOnline(hostId)||!name||!(/^(\/|[A-Za-z]:[\\/])/).test(path)){$('#fleet-project-error').hidden=false;return;}
  if(fleetProject(name,hostId)){notify('A project with that name already exists on this Host.',true);return;}
  const p={name,hostId,path,mode:'slp',snapshot:true};state.projects.push(p);state.fleetProjectState[scopeKey(name,hostId)]=fleetCopy(fleetDefaults);state.emptyProjects=state.emptyProjects||new Set();state.emptyProjects.add(scopeKey(name,hostId));state.pinnedProjects.push(scopeKey(name,hostId));selectFleetProject(hostId,name);notify('Sample Project added to '+fleetHost(hostId).name+'. The folder was not accessed.');
 }
 if(action==='pin'){
  const p=fleetProject(el.dataset.fleetProjectName,el.dataset.hostId);if(!p)return;
  const key=scopeKey(p.name,p.hostId);state.pinnedProjects=state.pinnedProjects.includes(key)?state.pinnedProjects.filter(item=>item!==key):[...state.pinnedProjects,key];
  try{localStorage.setItem('factory.pinned-projects',JSON.stringify(state.pinnedProjects));}catch{}
  fleetRefreshPinControls();
 }
});
document.addEventListener('change',event=>{if(event.target.hasAttribute?.('data-fleet-host-filter')){fleetSetAll(event.target.value);state.page=state.page==='inbox'?'inbox':'overview';render();}});
document.addEventListener('input',event=>{
 if(event.target.id==='fleet-search'){const position=event.target.selectionStart;state.fleetSearch=event.target.value;render();$('#fleet-search')?.focus({preventScroll:true});$('#fleet-search')?.setSelectionRange(position,position);}
 if(event.target.id==='fleet-project-search'){const q=event.target.value.toLowerCase();$$('[data-switch-match]').forEach(row=>{row.hidden=!row.dataset.switchMatch.includes(q);});}
});
document.addEventListener('toggle',event=>{if(event.target.id!=='team-disclosure')return;state.teamExpanded[event.target.dataset.teamScope]=event.target.open;try{localStorage.setItem('factory.team-expanded',JSON.stringify(state.teamExpanded));}catch{}},true);
document.addEventListener('keydown',event=>{if(event.key==='Enter'&&['new-host-name','host-alias','new-project-path'].includes(event.target.id)&&$('#modal').open){const action=event.target.id==='new-host-name'?'save-host':event.target.id==='host-alias'?'save-host-name':'save-project';const control=$('[data-fleet-action="'+action+'"]');if(control){event.preventDefault();event.stopImmediatePropagation?.();control.click();}}},true);
render();
