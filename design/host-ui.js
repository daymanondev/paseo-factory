'use strict';
/* Original machine-bot identities. These are personal labels, not Host capabilities. */
const hostCharacters=[
 {id:'laptop',name:'Laptop',tone:'coral',art:'<rect x="9" y="8" width="30" height="25" rx="6"/><path d="M5 35h38l-3 5H8Z"/><path d="M20 36h8"/>',eyes:'<path d="M18 20v2m12-2v2m-9 5q3 3 6 0"/>'},
 {id:'mini',name:'Mini',tone:'cyan',art:'<rect x="7" y="14" width="34" height="24" rx="9"/><path d="M13 10h22M15 38v3m18-3v3"/>',eyes:'<path d="M17 24v2m14-2v2m-11 5h8"/><circle cx="35" cy="32" r="1"/>'},
 {id:'tower',name:'Tower',tone:'lime',art:'<rect x="13" y="5" width="22" height="38" rx="7"/><path d="M19 10h10m-10 24h10m-10 4h6"/>',eyes:'<path d="M19 20v2m10-2v2m-8 5h6"/>'},
 {id:'terminal',name:'Terminal',tone:'cyan',art:'<rect x="5" y="9" width="38" height="31" rx="7"/><path d="M5 17h38"/><path d="M11 13h1m4 0h1"/>',eyes:'<path d="m13 24 5 4-5 4m11 0h10"/>'},
 {id:'robot',name:'Robot',tone:'coral',art:'<rect x="10" y="15" width="28" height="25" rx="9"/><path d="M24 15V9M10 24H5v8h5m28-8h5v8h-5"/><circle cx="24" cy="6" r="3"/>',eyes:'<path d="M18 25v3m12-3v3m-9 6q3 2 6 0"/>'},
 {id:'chip',name:'Chip',tone:'lime',art:'<rect x="12" y="12" width="24" height="24" rx="7"/><path d="M18 6v6m12-6v6M18 36v6m12-6v6M6 18h6m-6 12h6m24-12h6m-6 12h6"/>',eyes:'<path d="M19 21v2m10-2v2m-8 6h6"/>'},
 {id:'orbit',name:'Orbit',tone:'cyan',art:'<circle cx="24" cy="24" r="12"/><ellipse cx="24" cy="24" rx="21" ry="7" transform="rotate(-30 24 24)"/>',eyes:'<path d="M19 20v2m10-2v2m-8 6h6"/>'},
 {id:'rocket',name:'Rocket',tone:'coral',art:'<path d="M24 5C14 12 13 24 16 33h16c3-9 2-21-8-28ZM16 25l-7 7v7l9-5m14-9 7 7v7l-9-5m-9 4 3 6 3-6"/>',eyes:'<path d="M20 21v2m8-2v2m-6 5h4"/>'},
 {id:'cube',name:'Cube',tone:'lime',art:'<path d="m24 5 17 10v20L24 45 7 35V15Z"/><path d="m7 15 17 10 17-10M24 25v20m-9-35 18 10"/>',eyes:'<path d="M12 24v3m7 1v3m11-4v3m7-7v3"/>'},
 {id:'cloud',name:'Cloud',tone:'coral',art:'<path d="M13 37a9 9 0 0 1-2-18 13 13 0 0 1 25-1 10 10 0 0 1 1 19Z"/>',eyes:'<path d="M18 25v2m12-2v2m-9 5q3 2 6 0"/>'}
];
function hostCharacter(value){return hostCharacters.find(item=>item.id===value)||hostCharacters[0];}
function hostAvatar(host){
 const character=hostCharacter(host?.iconId);
 return `<svg class="host-avatar host-avatar-${character.tone}" data-host-character="${character.id}" viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g class="host-avatar-shell">${character.art}</g><g class="host-avatar-face">${character.eyes}</g></svg>`;
}
state.hostPreferences={};state.hostEditor=null;state.hostStatusFilter='all';
try{const saved=JSON.parse(localStorage.getItem('factory.host-identities')||'{}');if(saved&&typeof saved==='object'&&!Array.isArray(saved))state.hostPreferences=saved;}catch{}
state.hosts.forEach(host=>{
 const saved=state.hostPreferences[host.id],fallback=host.id==='mac-mini'?'mini':host.id==='windows'?'tower':'laptop';
 host.iconId=hostCharacter(saved?.iconId||fallback).id;
 if(typeof saved?.name==='string'&&saved.name.trim())host.name=saved.name.trim().slice(0,64);
});
function saveHostIdentities(){
 state.hostPreferences=Object.fromEntries(state.hosts.map(host=>[host.id,{name:host.name,iconId:host.iconId}]));
 try{localStorage.setItem('factory.host-identities',JSON.stringify(state.hostPreferences));}catch{}
}
function hostConnectionLabel(host){return `<span class="host-link-status ${host.status==='online'?'green':'amber'}"><span class="dot"></span>${host.status==='online'?'Online':'Not connected'}</span>`;}
renderFleetHosts=function(){
 const filter=state.hostStatusFilter||'all',visible=state.hosts.filter(host=>filter==='all'||host.status===filter);
 const filters=[['all','All'],['online','Online'],['not-connected','Not connected']];
 return `<div class="fleet-toolbar factory-host-toolbar"><div class="host-status-filters" role="group" aria-label="Filter Hosts by connection">${filters.map(([value,label])=>`<button class="host-status-filter ${filter===value?'selected':''}" data-host-ui-action="filter" data-host-status="${value}" aria-pressed="${filter===value}"><span>${label}</span><span class="host-filter-count">${state.hosts.filter(host=>value==='all'||host.status===value).length}</span></button>`).join('')}</div><span class="spacer"></span><button class="btn primary" data-fleet-action="add-host">${icon('plus')}Add Host</button></div><section class="factory-host-list" aria-label="Hosts"><div role="list">${visible.map(host=>{
  const projects=state.projects.filter(p=>p.hostId===host.id);
  return `<article class="factory-host-row" role="listitem"><button class="host-avatar-button" data-host-ui-action="edit" data-edit-host="${host.id}" aria-label="Choose icon for ${esc(host.name)}">${hostAvatar(host)}<span class="host-avatar-edit">${icon('settings')}</span></button><div class="host-row-name"><h2>${esc(host.name)}</h2><small>${host.os}${host.id==='mac-local'?'<span class="host-local-label">This computer</span>':''}</small></div><div class="host-row-connection">${hostConnectionLabel(host)}<small>${host.snapshot?'Sample snapshot':'No snapshot'}</small></div><div class="host-row-projects"><button class="host-project-count" data-fleet-action="host-projects" data-host-id="${host.id}" aria-label="View projects on ${esc(host.name)}">${projects.length} ${projects.length===1?'project':'projects'} ${icon('chevron')}</button><div class="host-project-links">${projects.length?projects.slice(0,2).map(p=>`<button data-fleet-project="${esc(p.name)}" data-fleet-host="${host.id}" aria-label="Open ${esc(fleetProjectName(p))} on ${esc(host.name)}">${esc(fleetProjectName(p))}</button>`).join('')+(projects.length>2?`<button data-fleet-action="host-projects" data-host-id="${host.id}">+${projects.length-2} more</button>`:''):'<span>No projects added</span>'}</div></div><div class="host-row-actions"><button class="${host.status==='online'?'icon-btn':'btn ghost host-connect-button'}" data-host-ui-action="edit" data-edit-host="${host.id}" aria-label="${host.status==='online'?'Manage':'Connection settings for'} ${esc(host.name)}">${host.status==='online'?icon('settings'):'Connect'}</button></div></article>`;
 }).join('')||`<div class="host-filter-empty"><h3>${filter==='online'?'No online Hosts':filter==='not-connected'?'No disconnected Hosts':'No Hosts yet'}</h3><p>${filter==='all'?'Add a Host to begin.':'Choose All to see your other machines.'}</p>${filter==='all'?'':'<button class="btn ghost" data-host-ui-action="filter" data-host-status="all">Show all Hosts</button>'}</div>`}</div></section>`;
};
function hostIconPicker(){return `<fieldset class="host-icon-field"><legend>Choose an icon</legend><div class="host-icon-grid" role="group" aria-label="Host icon">${hostCharacters.map(character=>`<button class="host-icon-choice ${state.hostEditor.iconId===character.id?'selected':''}" data-host-ui-action="choose-icon" data-host-icon-id="${character.id}" aria-label="${character.name}" aria-pressed="${state.hostEditor.iconId===character.id}">${hostAvatar({iconId:character.id})}<span>${character.name}</span><span class="host-icon-check">${icon('check')}</span></button>`).join('')}</div></fieldset>`;}
function hostEditorBody(host,isNew){
 return `<div class="host-edit-preview"><span id="host-icon-preview">${hostAvatar({iconId:state.hostEditor.iconId})}</span><div><strong id="host-preview-name">${esc(host?.name||'Your Host')}</strong><small>${host?.os||'Choose a system below'}</small></div>${host?hostConnectionLabel(host):'<span class="host-link-status muted">Not connected</span>'}</div><div class="field"><label for="host-display-name">Name</label><input id="host-display-name" value="${esc(host?.name||'')}" placeholder="Build machine" maxlength="64" autocomplete="off" aria-describedby="host-name-error"><span id="host-name-error" class="error" hidden>Enter a name for this Host.</span></div>${isNew?'<div class="field"><label for="host-os-select">Operating system</label><select id="host-os-select"><option value="macOS">macOS</option><option value="Windows">Windows</option><option value="Linux">Linux</option></select></div>':''}${hostIconPicker()}${host?`<details class="host-diagnostics"><summary>Connection details ${icon('chevron')}</summary><dl class="data-list"><div><dt>System</dt><dd>${esc(host.os)}</dd></div><div><dt>Snapshot</dt><dd>${esc(host.updated||'Unavailable')}</dd></div><div><dt>Server ID</dt><dd>Unavailable in this prototype</dd></div></dl></details>`:''}${!host||host.status!=='online'?`<p class="host-connection-note">${icon('info')}<span>Connect this machine through Paseo. Saving here only changes its name and icon in this preview.</span></p>`:''}<div class="dialog-actions"><button class="btn ghost" data-action="close-modal">Cancel</button><button class="btn primary" data-host-ui-action="save">${isNew?'Add Host':'Save Host'}</button></div>`;
}
fleetHostDetails=function(id){
 const host=fleetHost(id);if(!host)return;
 state.hostEditor={hostId:id,iconId:hostCharacter(host.iconId).id,isNew:false};
 openModal('Host settings',hostEditorBody(host,false));
};
fleetAddHost=function(){state.hostEditor={hostId:null,iconId:'laptop',isNew:true};openModal('Add Host',hostEditorBody(null,true));};
function selectHostIcon(id){
 if(!state.hostEditor||!hostCharacters.some(character=>character.id===id))return;
 state.hostEditor.iconId=id;
 const preview=$('#host-icon-preview');if(preview)preview.innerHTML=hostAvatar({iconId:id});
 $$('[data-host-icon-id]').forEach(control=>{const selected=control.dataset.hostIconId===id;control.classList.toggle('selected',selected);control.setAttribute('aria-pressed',String(selected));});
}
let hostEntrySequence=0;
function saveFactoryHost(){
 const editor=state.hostEditor;if(!editor)return;
 const field=$('#host-display-name'),name=String(field?.value||'').trim();
 if(!name){$('#host-name-error').hidden=false;field?.setAttribute('aria-invalid','true');field?.focus();return;}
 if(editor.isNew){
  const id='sample-host-'+Date.now().toString(36)+'-'+(++hostEntrySequence),system=$('#host-os-select')?.value,os=['macOS','Windows','Linux'].includes(system)?system:'macOS';
  state.hosts.push({id,name:name.slice(0,64),os,iconId:hostCharacter(editor.iconId).id,status:'not-connected',snapshot:false,updated:null});
  const snapshot=fleetCopy(fleetHostDefaults);for(const key of ['plugins','mcps','skills','profiles','events'])snapshot[key]=[];state.fleetHostState[id]=snapshot;
 }else{
  const host=fleetHost(editor.hostId);if(!host){notify('This Host is no longer available.',true);return;}
  host.name=name.slice(0,64);host.iconId=hostCharacter(editor.iconId).id;
 }
 const added=editor.isNew;saveHostIdentities();state.hostEditor=null;closeModal();
 if(added){state.settingsTab='hosts';state.page='settings';state.hostStatusFilter='not-connected';}
 render();notify(added?'Host added as Not connected. No machine was contacted.':'Host name and icon saved in this preview.');
 const trigger=$$('[data-host-ui-action="edit"]').find(control=>control.dataset.editHost===editor.hostId);trigger?.focus({preventScroll:true});
}
const hostRenderBefore=render;
render=function(){hostRenderBefore();if(typeof renderTopbarCrumb==='function')renderTopbarCrumb();};
document.addEventListener('click',event=>{
 const control=event.target.closest('button');if(!control||control.disabled)return;
 const action=control.dataset.hostUiAction;
 if(action==='filter'){
  const value=control.dataset.hostStatus;if(!['all','online','not-connected'].includes(value))return;
  state.hostStatusFilter=value;render();$('[data-host-status="'+value+'"]')?.focus({preventScroll:true});return;
 }
 if(action==='edit')fleetHostDetails(control.dataset.editHost);
 if(action==='choose-icon')selectHostIcon(control.dataset.hostIconId);
 if(action==='save')saveFactoryHost();
});
document.addEventListener('input',event=>{if(event.target.id!=='host-display-name')return;const preview=$('#host-preview-name');if(preview)preview.textContent=event.target.value.trim()||'Your Host';if(event.target.value.trim()){$('#host-name-error').hidden=true;event.target.removeAttribute('aria-invalid');}});
document.addEventListener('keydown',event=>{if(event.key==='Enter'&&event.target?.id==='host-display-name'&&$('#modal').open){event.preventDefault();saveFactoryHost();}});
render();
