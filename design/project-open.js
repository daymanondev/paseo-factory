'use strict';
/* UI-only quick-open targets. Native launching belongs to the Paseo integration. */
const projectOpenApps=[
 {id:'vscode',name:'VS Code',icon:'code'},
 {id:'antigravity',name:'Antigravity',icon:'code'},
 {id:'xcode',name:'Xcode',icon:'code'},
 {id:'finder',name:'Finder',icon:'folder'},
 {id:'terminal',name:'Terminal',icon:'terminal'}
];
function projectOpenAppIcon(app){return `<img class="project-app-icon" src="assets/app-icons/${app.id}.png" width="64" height="64" alt="" aria-hidden="true">`;}
shapes.terminal='<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/>';
state.projectOpenPreferences={};state.lastProjectOpen=null;
try{const saved=JSON.parse(localStorage.getItem('factory.open-in')||'{}');if(saved&&typeof saved==='object'&&!Array.isArray(saved))state.projectOpenPreferences=saved;}catch{}
let projectOpenTrigger=null;
function projectOpenReason(p){
 if(!p)return 'Select a project first.';
 if(p.hostId!=='mac-local')return 'Quick open is available on This Mac only. Remote Hosts are not supported yet.';
 if(!fleetOnline(p.hostId))return 'This Host is not connected.';
 if(!p.path)return 'The project directory is unavailable.';
 return '';
}
function projectOpenPreferred(p){return projectOpenApps.find(app=>app.id===state.projectOpenPreferences[scopeKey(p.name,p.hostId)])||projectOpenApps[0];}
function projectOpenAttrs(p){return `data-launch-host="${esc(p.hostId)}" data-launch-project="${esc(p.name)}"`;}
function projectOpenToolbar(p){
 if(!p)return '';
 const reason=projectOpenReason(p),app=projectOpenPreferred(p);
 if(reason)return `<span class="project-open-unavailable" title="${esc(reason)}"><button class="project-open-main" disabled aria-label="${esc(reason)}">${icon('external')}Open in</button><span>This Mac only</span></span>`;
 return `<div class="project-open-split" role="group" aria-label="Open current project in an application"><button class="project-open-main" data-project-launch-app="${app.id}" ${projectOpenAttrs(p)} aria-label="Open ${esc(p.name)} in ${app.name}">${projectOpenAppIcon(app)}<span class="project-open-prefix">Open in</span><span>${app.name}</span></button><button class="project-open-chevron" data-project-launch-menu ${projectOpenAttrs(p)} aria-haspopup="menu" aria-expanded="false" aria-controls="project-open-menu" aria-label="Choose application for ${esc(p.name)}">${icon('chevron')}</button></div>`;
}
function projectRowLauncher(p){return `<button class="icon-btn project-open-row-menu" data-project-launch-menu ${projectOpenAttrs(p)} aria-haspopup="menu" aria-expanded="false" aria-controls="project-open-menu" aria-label="Open ${esc(p.name)} in an application">${icon('more')}</button>`;}
function closeProjectOpen(restoreFocus=false){
 const menu=$('#project-open-menu');if(!menu)return;
 menu.hidden=true;projectOpenTrigger?.setAttribute('aria-expanded','false');
 if(restoreFocus&&projectOpenTrigger?.isConnected)projectOpenTrigger.focus();
 projectOpenTrigger=null;
}
function showProjectOpen(trigger){
 const menu=$('#project-open-menu');if(!menu)return;
 if(projectOpenTrigger===trigger&&!menu.hidden){closeProjectOpen(true);return;}
 closeProjectOpen();
 const p=fleetProject(trigger.dataset.launchProject,trigger.dataset.launchHost);if(!p)return notify('This project is no longer available.',true);
 const host=fleetHost(p.hostId),reason=projectOpenReason(p),preferred=projectOpenPreferred(p);
 menu.innerHTML=`<div class="project-open-menu-heading"><strong>Open ${esc(fleetProjectName(p))} in</strong><span>${esc(host.name)}</span><small>${esc(p.path||'Project directory unavailable')}</small></div><div class="project-open-options">${projectOpenApps.map(app=>`<button role="menuitem" data-project-launch-app="${app.id}" ${projectOpenAttrs(p)} ${reason?'disabled':''}>${projectOpenAppIcon(app)}<span>${app.name}</span>${app.id===preferred.id?'<small>Quick open</small>':''}</button>`).join('')}</div><p class="project-open-menu-note">${reason?esc(reason):'Preview only. No app is launched; installed apps are not detected here.'}</p>`;
 menu.hidden=false;projectOpenTrigger=trigger;trigger.setAttribute('aria-expanded','true');
 const rect=trigger.getBoundingClientRect(),gap=8,width=menu.offsetWidth||288,height=menu.offsetHeight||340;
 const viewportWidth=window.innerWidth||document.documentElement?.clientWidth||1024,viewportHeight=window.innerHeight||document.documentElement?.clientHeight||768;
 menu.style.left=Math.max(gap,Math.min(rect.right-width,viewportWidth-width-gap))+'px';
 menu.style.top=Math.max(gap,Math.min(rect.bottom+gap,viewportHeight-height-gap))+'px';
 const first=$('button:not([disabled])',menu);if(first)first.focus();else menu.focus();
}
function launchProjectApp(hostId,name,appId){
 const p=fleetProject(name,hostId),app=projectOpenApps.find(item=>item.id===appId),reason=projectOpenReason(p);
 if(reason||!app){closeProjectOpen(true);return notify(reason||'Choose an available application.',true);}
 // Preserve the target pair even when launched from the global project list.
 state.lastProjectOpen={hostId:p.hostId,project:p.name,path:p.path,appId:app.id,simulated:true};
 state.projectOpenPreferences[scopeKey(p.name,p.hostId)]=app.id;
 try{localStorage.setItem('factory.open-in',JSON.stringify(state.projectOpenPreferences));}catch{}
 const previousTrigger=projectOpenTrigger;closeProjectOpen(true);syncShell();
 if(state.project===p.name&&activeHostId()===p.hostId)$('#project-open-toolbar .project-open-main')?.focus({preventScroll:true});
 else if(previousTrigger?.isConnected)previousTrigger.focus({preventScroll:true});
 notify(`Preview: open ${p.name} in ${app.name} on ${fleetHost(p.hostId).name}. No app was launched.`);
}
const projectOpenShellBefore=syncShell;
syncShell=function(){
 closeProjectOpen();projectOpenShellBefore();
 const target=$('#project-open-toolbar');if(!target)return;
 const p=state.project==='all'||state.page==='daemon'?null:project();target.hidden=!p;target.innerHTML=p?fleetProjectPin(p,'header')+projectOpenToolbar(p):'';
};
document.addEventListener('click',event=>{
 const trigger=event.target.closest('button');
 if(trigger?.hasAttribute('data-project-launch-menu')&&!trigger.disabled){showProjectOpen(trigger);return;}
 if(trigger?.dataset.projectLaunchApp&&!trigger.disabled){launchProjectApp(trigger.dataset.launchHost,trigger.dataset.launchProject,trigger.dataset.projectLaunchApp);return;}
 if(!event.target.closest('#project-open-menu'))closeProjectOpen();
});
document.addEventListener('keydown',event=>{
 const menu=$('#project-open-menu');if(!menu||menu.hidden)return;
 if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation?.();closeProjectOpen(true);return;}
 if(event.key==='Tab'){closeProjectOpen(true);return;}
 if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
 const controls=$$('button:not([disabled])',menu);if(!controls.length)return;
 event.preventDefault();const current=controls.indexOf(document.activeElement);
 const next=event.key==='Home'?0:event.key==='End'?controls.length-1:event.key==='ArrowDown'?(current+1)%controls.length:(current<=0?controls.length:current)-1;
 controls[next].focus();
},true);
window.addEventListener('resize',()=>closeProjectOpen());
// Close before content scrolls away from its triggering control.
window.addEventListener('scroll',event=>{if(!event.target?.closest?.('#project-open-menu'))closeProjectOpen();},true);
render();
