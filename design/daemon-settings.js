'use strict';
/* Settings stay in Paseo. Factory displays connection metadata and supplied shortcuts. */
state.daemonSettingsHostId=null;
state.daemonDetailsOpen={};
function daemonSettingsHost(){return fleetHost(state.daemonSettingsHostId)||fleetHost(state.project==='all'?state.hostId:activeHostId())||state.hosts[0]||null;}
function openDaemonSettings(hostId,shortcutKey=null){
 const host=fleetHost(hostId)||daemonSettingsHost();if(!host)return;
 state.daemonSettingsHostId=host.id;
 state.settingsTab='daemon';
 if($('#modal').open)closeModal();
 closeProjectOpen();closeProjectHostMenu();navigate('settings');
 const target=shortcutKey?$('#daemon-shortcut-'+shortcutKey):null;
 if(target&&!target.disabled)target.focus({preventScroll:false});else $('.daemon-settings-host-picker>summary')?.focus({preventScroll:true});
}
function daemonHostPicker(host){
 return `<details class="daemon-settings-host-picker"><summary aria-label="Choose Host for Daemon settings">${hostAvatar(host)}<span><strong>${esc(host.name)}</strong><small>${esc(host.os)}</small></span>${icon('chevron')}</summary><div class="daemon-settings-host-menu" role="group" aria-label="Hosts">${state.hosts.map(item=>{const selected=item.id===host.id,status=paseoDaemonStatus(item);return `<button type="button" class="project-host-option ${selected?'selected':''}" data-daemon-select-host="${esc(item.id)}" aria-pressed="${selected}">${hostAvatar(item)}<span class="project-host-option-copy"><strong>${esc(item.name)}</strong><small><span>${esc(item.os)}</span><span class="project-host-health ${status.tone}"><span class="dot"></span>${status.label}</span></small></span><span class="project-host-check">${icon('check')}</span></button>`;}).join('')}</div></details>`;
}
function daemonShortcutRow(key,title,description,glyph,links){
 const url=links[key],attrs=`id="daemon-shortcut-${key}" aria-label="Open ${title} in Paseo Web"`;
 return `<div class="daemon-shortcut-row"><span class="daemon-shortcut-icon">${icon(glyph)}</span><div class="daemon-shortcut-copy"><strong>${title}</strong><small>${description}</small></div>${paseoExternal('Open',url,attrs,'paseo-link daemon-shortcut-open')}</div>`;
}
function renderDaemonSettings(){
 const host=daemonSettingsHost();if(!host)return '<div class="empty">No Hosts available.</div>';
 const links=paseoHostLinks(host.id),status=paseoDaemonStatus(host),data=host.daemonConnection;
 const last=Number.isFinite(data?.lastSeenAt)?new Intl.DateTimeFormat('en',{dateStyle:'medium',timeStyle:'short'}).format(data.lastSeenAt):'Unavailable';
 const shortcuts=[['settingsUrl','Daemon settings','Host configuration and service preferences','settings'],['providersUrl','Providers','Models, providers and CLI configuration','agents'],['pluginsUrl','Plugin Manager','Install plugins and inspect loaded bundles','plug'],['newSupervisorUrl','New Supervisor','Open New Chat in Paseo','plus']];
 return `<div class="daemon-settings-screen"><div class="daemon-settings-toolbar">${daemonHostPicker(host)}<div class="daemon-settings-connection"><span class="daemon-inline-status ${status.tone}"><span class="dot"></span>${status.label}</span><small>${esc(paseoEndpointLabel(links.address))}</small></div><span class="spacer"></span>${paseoExternal('Open Paseo Web',links.webUrl,'','paseo-link daemon-web-open')}</div><section class="daemon-shortcut-list" aria-label="Paseo settings shortcuts">${shortcuts.map(item=>daemonShortcutRow(...item,links)).join('')}</section><details class="daemon-settings-diagnostics" id="daemon-settings-diagnostics" ${state.daemonDetailsOpen[host.id]?'open':''}><summary><span>${icon('activity')}Connection details</span>${icon('chevron')}</summary><dl class="daemon-settings-facts"><div><dt>Address</dt><dd>${esc(links.address||'Unavailable')}${links.address?`<button type="button" class="icon-btn daemon-copy-address" data-action="copy" data-copy="${esc(links.address)}" aria-label="Copy daemon address">${icon('copy')}</button>`:''}</dd></div><div><dt>Server ID</dt><dd>${esc(data?.serverId||'Unavailable')}</dd></div><div><dt>Last received</dt><dd>${last}</dd></div>${data?.error?`<div><dt>Error</dt><dd class="red">${esc(data.error)}</dd></div>`:''}</dl></details></div>`;
}
const daemonPageShellBefore=syncShell;
syncShell=function(){
 daemonPageShellBefore();if(state.page!=='daemon')return;
 if(typeof renderTopbarCrumb==='function')renderTopbarCrumb();
};
commands.push(['Daemon settings','daemon','host']);
document.addEventListener('click',event=>{
 const control=event.target.closest('button');if(!control||control.disabled)return;
 if(control.dataset.daemonSelectHost){state.daemonSettingsHostId=control.dataset.daemonSelectHost;render();$('.daemon-settings-host-picker>summary')?.focus({preventScroll:true});}
});
document.addEventListener('toggle',event=>{
 if(state.page==='daemon'&&event.target.id==='daemon-settings-diagnostics')state.daemonDetailsOpen[daemonSettingsHost().id]=event.target.open;
},true);
document.addEventListener('keydown',event=>{
 if(state.page!=='daemon'||event.key!=='Escape')return;
 const picker=$('.daemon-settings-host-picker');if(picker?.open){event.preventDefault();picker.open=false;$('summary',picker)?.focus({preventScroll:true});}
});
