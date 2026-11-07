'use strict';
/* Host-provided Paseo navigation. No URL-entry or route-guessing flow. */
state.paseoHostLinks={};state.paseoSessionLinks={};state.paseoAttemptLinks={};state.paseoLinkEditor=null;
try{const saved=JSON.parse(localStorage.getItem('factory.paseo-links')||'{}');if(saved&&typeof saved==='object'&&!Array.isArray(saved))state.paseoHostLinks=saved;}catch{}
const paseoLinkFields=[['address','Daemon address'],['webUrl','Paseo Web URL'],['settingsUrl','Daemon settings URL'],['providersUrl','Provider settings URL'],['pluginsUrl','Plugin manager URL'],['newSupervisorUrl','Supervisor New Chat URL']];
function paseoSafeUrl(value,endpoint=false){
 if(typeof value!=='string'||!value.trim())return null;
 try{const url=new URL(value.trim());if(!(endpoint?['http:','https:','ws:','wss:']:['http:','https:']).includes(url.protocol)||url.username||url.password)return null;return url.href;}catch{return null;}
}
function paseoHostLinks(hostId){
 const supplied=fleetHost(hostId)?.daemonConnection||{},saved=state.paseoHostLinks[hostId]||{};
 return Object.fromEntries(paseoLinkFields.map(([key])=>[key,paseoSafeUrl(supplied[key]||saved[key],key==='address')]));
}
function paseoDaemonStatus(host){
 const data=host?.daemonConnection;
 if(data?.status==='connected')return {label:'Connected',tone:'green'};
 if(data?.status==='stale')return {label:'Stale',tone:'amber'};
 if(data?.status==='error')return {label:'Connection error',tone:'red'};
 return {label:'Not connected',tone:'muted'};
}
function paseoEndpointLabel(address){
 if(!address)return 'Address unavailable';
 const url=new URL(address),port=url.port||(['https:','wss:'].includes(url.protocol)?'443':'80');
 return url.hostname+':'+port;
}
function paseoExternal(label,url,extra='',className='paseo-link'){
 return url?`<a class="${className}" href="${esc(url)}" target="_blank" rel="noopener noreferrer" ${extra}><span>${label}</span>${icon('external')}</a>`:`<button type="button" class="${className} unavailable" disabled ${extra}><span>${label}</span>${icon('external')}</button>`;
}
function paseoHostShortcuts(host){
 const links=paseoHostLinks(host.id);
 return `<div class="paseo-host-shortcuts">${paseoExternal('Open daemon',links.webUrl)}${paseoExternal('Daemon settings',links.settingsUrl)}<button type="button" class="paseo-link" data-paseo-edit-host="${esc(host.id)}">${icon('settings')}<span>Connection details</span></button></div>`;
}
function paseoSettingsShortcut(kind,hostId=activeHostId()){
 const host=fleetHost(hostId);if(!host)return '';
 const key=kind==='providers'?'providersUrl':kind==='plugins'?'pluginsUrl':'settingsUrl',label=kind==='providers'?'Paseo Provider Settings':kind==='plugins'?'Paseo Plugin Manager':'Paseo settings',url=paseoHostLinks(hostId)[key];
 return paseoExternal(label,url,'title="'+esc(url?'Open in Paseo Web':'Unavailable until Paseo provides this link')+'"');
}
function paseoToolsMenu(){return `<details class="paseo-settings-menu"><summary aria-label="Paseo settings shortcuts">${icon('more')}</summary><div>${paseoSettingsShortcut('plugins')}${paseoSettingsShortcut('settings')}</div></details>`;}
function paseoDaemonWidget(){
 const all=state.project==='all'&&state.hostId==='all',host=all?null:fleetHost(state.project==='all'?state.hostId:activeHostId()),status=paseoDaemonStatus(host),links=host?paseoHostLinks(host.id):null;
 const count=state.hosts.filter(item=>paseoDaemonStatus(item).label==='Connected').length;
 return `<button type="button" class="daemon-access-trigger" data-daemon-access ${state.page==='daemon'?'aria-current="page"':''} aria-label="Open Daemon settings"><span class="daemon-access-top"><span class="dot ${all?(count?'green':'muted'):status.tone}"></span><strong>${all?'Daemons':'Daemon'}</strong><small>${all?count+' connected':status.label}</small>${icon('chevron')}</span><span class="daemon-access-address">${all?'Across your Hosts':esc(host?.name||'Host')+' · '+esc(paseoEndpointLabel(links?.address))}</span></button>`;
}
function editPaseoHostLinks(hostId,focusKey='address'){openDaemonSettings(hostId,focusKey);}
const paseoTaskVersions=new WeakMap();let paseoTaskSequence=0;
function paseoTaskVersion(task){if(!paseoTaskVersions.has(task))paseoTaskVersions.set(task,++paseoTaskSequence);return paseoTaskVersions.get(task);}
function paseoAttemptKey(task,index){return scopeKey(task.project,task.hostId)+'::'+task.id+'::'+paseoTaskVersion(task)+'::'+index;}
function paseoAttemptLinks(task,index){
 const detail=task.attemptDetails?.[index]||(typeof task.attempts[index]==='object'?task.attempts[index]:null)||{},saved=state.paseoAttemptLinks[paseoAttemptKey(task,index)]||{};
 return {sessionUrl:paseoSafeUrl(detail.sessionUrl||saved.sessionUrl),worktreeUrl:paseoSafeUrl(detail.worktreeUrl||detail.workspaceUrl||saved.worktreeUrl||(index===task.attempts.length-1?task.worktreeUrl||task.workspaceUrl:null))};
}
function paseoAttemptAttrs(task,index){return `data-paseo-task="${esc(task.id)}" data-paseo-project="${esc(task.project)}" data-paseo-host="${esc(task.hostId)}" data-paseo-attempt="${index}"`;}
function paseoAttemptActions(task,index,menu=false){
 if(index<0)return menu?'':'<span class="paseo-no-session">No Peer attempt yet</span>';
 const links=paseoAttemptLinks(task,index),attrs=paseoAttemptAttrs(task,index);
 return `<span class="paseo-attempt-actions ${menu?'in-menu':''}">${[['sessionUrl','Open Peer Session'],['worktreeUrl','Open Task Worktree']].map(([key,label])=>paseoExternal(label,links[key],'aria-label="'+label+' for '+esc(task.id)+' attempt '+(index+1)+'"')).join('')}</span>`;
}
function paseoSupervisorVacant(){return state.emptyProjects?.has(scopeKey())||state.retiredSeats?.has(scopeKey()+':supervisor');}
function paseoSessionFingerprint(id){const a=agent(id);return a.sessionId||a.agentId||(id==='lead'?leadHandoffState().session:null)||null;}
function paseoAgentUrl(id){
 if(state.emptyProjects?.has(scopeKey())||state.retiredSeats?.has(scopeKey()+':'+id))return null;
 const a=agent(id),record=state.paseoSessionLinks[scopeKey()+':'+id];
 return paseoSafeUrl(a.sessionUrl||(record?.fingerprint===paseoSessionFingerprint(id)?record?.url:null));
}
function paseoOpenUrl(url){if(url)window.open(url,'_blank','noopener,noreferrer');}
openAgent=function(id){
 if(state.project==='all'){notify('Select the Host and project for this agent first.',true);return;}
 if(id==='supervisor'&&paseoSupervisorVacant()){
  const url=paseoHostLinks(activeHostId()).newSupervisorUrl;if(url)paseoOpenUrl(url);else notify('Paseo New Chat is unavailable in this preview.',true);return;
 }
 if(state.emptyProjects?.has(scopeKey())||state.retiredSeats?.has(scopeKey()+':'+id)){notify('This seat has no active session.',true);return;}
 const url=paseoAgentUrl(id);if(url){paseoOpenUrl(url);return;}
 notify('The Paseo session link is not available in this preview.',true);
};
const paseoShellBefore=syncShell;
syncShell=function(){paseoShellBefore();const root=$('#daemon-access');if(root)root.innerHTML=paseoDaemonWidget();};
const paseoHostEditorBefore=hostEditorBody;
hostEditorBody=function(host,isNew){const body=paseoHostEditorBefore(host,isNew);return host?body.replace('<div class="field">',paseoHostShortcuts(host)+'<div class="field">'):body;};
document.addEventListener('click',event=>{
 const control=event.target.closest('button');
 if(control?.hasAttribute('data-daemon-access')){openDaemonSettings(state.project==='all'?state.hostId:activeHostId());return;}
 if(control?.dataset.paseoEditHost){editPaseoHostLinks(control.dataset.paseoEditHost,control.dataset.paseoFocus||'address');return;}
 if(control?.dataset.paseoAttemptOpen){
  const task=state.tasks.find(t=>t.id===control.dataset.paseoTask&&t.project===control.dataset.paseoProject&&t.hostId===control.dataset.paseoHost);
  if(!task)return;const index=Number(control.dataset.paseoAttempt),key=control.dataset.paseoAttemptOpen,links=paseoAttemptLinks(task,index);
  if(links[key])paseoOpenUrl(links[key]);else notify('This Attempt’s Paseo link is not available in this preview.',true);return;
 }
});
const initialDaemonAccess=$('#daemon-access');if(initialDaemonAccess)initialDaemonAccess.innerHTML=paseoDaemonWidget();
