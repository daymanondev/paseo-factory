'use strict';
/* A scoped Host picker for the project directory; Inbox keeps its existing filter. */
const basicFleetHostFilter=fleetHostFilter;
fleetHostFilter=function(){
 if(state.page!=='overview'&&!(state.page==='flow'&&state.project==='all'))return basicFleetHostFilter();
 const host=state.hostId==='all'?null:fleetHost(state.hostId);
 return `<button class="project-host-trigger" data-project-host-trigger aria-haspopup="menu" aria-expanded="false" aria-controls="project-host-menu" aria-label="Filter projects by Host: ${esc(host?.name||'All Hosts')}">${host?hostAvatar(host):icon('host')}<span>${esc(host?.name||'All Hosts')}</span><span class="project-host-caret">${icon('chevron')}</span></button>`;
};
let projectHostTrigger=null;
function closeProjectHostMenu(restoreFocus=false){
 const menu=$('#project-host-menu');if(!menu)return;
 menu.hidden=true;projectHostTrigger?.setAttribute('aria-expanded','false');
 if(restoreFocus&&projectHostTrigger?.isConnected)projectHostTrigger.focus({preventScroll:true});
 projectHostTrigger=null;
}
function projectHostOptions(){
 const allSelected=state.hostId==='all';
 return `<div class="project-host-menu-title">Filter by Host</div><button class="project-host-option ${allSelected?'selected':''}" role="menuitemradio" aria-checked="${allSelected}" data-project-host-choice="all"><span class="project-host-all-icon">${icon('host')}</span><span class="project-host-option-copy"><strong>All Hosts</strong><small>${state.projects.length} projects across ${state.hosts.length} machines</small></span><span class="project-host-check">${icon('check')}</span></button><div class="project-host-menu-rule" role="separator"></div>${state.hosts.map(host=>{const selected=state.hostId===host.id,count=state.projects.filter(p=>p.hostId===host.id).length;return `<button class="project-host-option ${selected?'selected':''}" role="menuitemradio" aria-checked="${selected}" data-project-host-choice="${host.id}">${hostAvatar(host)}<span class="project-host-option-copy"><strong>${esc(host.name)}</strong><small><span class="project-host-health ${host.status==='online'?'green':'muted'}"><span class="dot"></span>${host.status==='online'?'Online':'Not connected'}</span><span>${count} ${count===1?'project':'projects'}</span></small></span><span class="project-host-check">${icon('check')}</span></button>`;}).join('')}`;
}
function showProjectHostMenu(trigger){
 const menu=$('#project-host-menu');if(!menu)return;
 if(projectHostTrigger===trigger&&!menu.hidden){closeProjectHostMenu(true);return;}
 closeProjectHostMenu();closeProjectOpen();menu.innerHTML=projectHostOptions();menu.hidden=false;
 projectHostTrigger=trigger;trigger.setAttribute('aria-expanded','true');
 const rect=trigger.getBoundingClientRect(),gap=8,width=menu.offsetWidth||280,height=menu.offsetHeight||300;
 const viewportWidth=window.innerWidth||document.documentElement?.clientWidth||1024,viewportHeight=window.innerHeight||document.documentElement?.clientHeight||768;
 const bottom=rect.bottom??rect.top+rect.height;
 menu.style.left=Math.max(gap,Math.min(rect.left,viewportWidth-width-gap))+'px';
 menu.style.top=(bottom+gap+height<=viewportHeight-gap?bottom+gap:Math.max(gap,rect.top-height-gap))+'px';
 ($('[aria-checked="true"]',menu)||$('button',menu))?.focus({preventScroll:true});
}
function chooseProjectHost(value){
 if(value!=='all'&&!fleetHost(value))return;
 if(state.project!=='all'){closeProjectHostMenu();return;}
 closeProjectHostMenu();fleetSetAll(value);state.page='overview';render();$('[data-project-host-trigger]')?.focus({preventScroll:true});
}
const projectFilterShellBefore=syncShell;
syncShell=function(){closeProjectHostMenu();projectFilterShellBefore();};
document.addEventListener('click',event=>{
 const control=event.target.closest('button');
 if(control?.hasAttribute('data-project-host-trigger')&&!control.disabled){showProjectHostMenu(control);return;}
 if(control?.hasAttribute('data-project-host-choice')&&!control.disabled){chooseProjectHost(control.dataset.projectHostChoice);return;}
 if(!event.target.closest('#project-host-menu'))closeProjectHostMenu();
});
document.addEventListener('keydown',event=>{
 const menu=$('#project-host-menu');if(!menu)return;
 if(event.target?.hasAttribute?.('data-project-host-trigger')&&['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();showProjectHostMenu(event.target);return;}
 if(menu.hidden)return;
 if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation?.();closeProjectHostMenu(true);return;}
 if(event.key==='Tab'){closeProjectHostMenu(true);return;}
 if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
 const controls=$$('button',menu);if(!controls.length)return;
 event.preventDefault();const current=controls.indexOf(document.activeElement);
 const next=event.key==='Home'?0:event.key==='End'?controls.length-1:event.key==='ArrowDown'?(current+1)%controls.length:(current<=0?controls.length:current)-1;
 controls[next].focus({preventScroll:true});
},true);
window.addEventListener('resize',()=>closeProjectHostMenu());
window.addEventListener('scroll',event=>{if(!event.target?.closest?.('#project-host-menu'))closeProjectHostMenu();},true);
render();
