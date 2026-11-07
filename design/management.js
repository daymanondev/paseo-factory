'use strict';
/* Compact management surfaces; configuration remains scoped to its existing Host. */
state.paseoDaemon=state.paseoDaemon||{
 version:'0.24.2',
 latestVersion:'0.25.0',
 updateAvailable:true,
 channel:'stable',
 releaseNotes:'Faster worktree hydration, persistent Supervisor session handoff, and multi-host WebSocket multiplexing.'
};
function privateVaultStatus(){return state.vaultStage===2?'Configured':state.vaultStage===1?'Ready to set up':'Sign-in required';}
function paseoRuntimeStatus(){
 const host=typeof fleetHost==='function'?fleetHost():null;
 const online=typeof fleetOnline==='function'?fleetOnline():true;
 if(!online)return {label:'Host offline',tone:'muted'};
 const daemon=typeof paseoDaemonStatus==='function'?paseoDaemonStatus(host):null;
 if(daemon&&daemon.label==='Stale')return {label:'Stale',tone:'amber'};
 if(daemon&&daemon.label==='Connection error')return {label:'Connection error',tone:'red'};
 return {label:'Daemon running',tone:'green'};
}
function managementIntegrationItems(){
 const d=state.paseoDaemon||{},rtStatus=paseoRuntimeStatus(),host=typeof fleetHost==='function'?fleetHost():null;
 const paseoItem={
  id:'paseo',
  name:'Paseo Daemon',
  category:'HOST RUNTIME',
  recommended:true,
  description:'Local agent runtime and host daemon powering Factory sessions, isolated Git worktrees, and provider bridges.',
  version:d.version||'0.24.2',
  latestVersion:d.latestVersion||'0.25.0',
  updateAvailable:Boolean(d.updateAvailable),
  releaseNotes:d.releaseNotes,
  glyph:'host',
  tone:'cyan',
  status:rtStatus.label,
  statusTone:rtStatus.tone,
  tags:['Session Runtime','Worktree Isolation',host?.name||'Local Host'],
  protected:true,
  attrs:'data-management-action="paseo"',
  updateAttrs:'data-action="update-paseo"'
 };
 const plugins=state.plugins.filter(p=>p.id!=='design').map(p=>({
  id:p.id,
  name:p.name,
  category:p.id==='core'?'CORE ENGINE':'REQUIRED TOOL',
  recommended:true,
  description:p.description,
  version:p.version==='local'?'1.4.2':p.version,
  latestVersion:p.latestVersion||null,
  updateAvailable:Boolean(p.updateAvailable),
  releaseNotes:p.releaseNotes||'',
  glyph:p.id==='core'?'flow':'shield',
  tone:p.id==='core'?'coral':'cyan',
  status:!p.installed?'Not installed':p.enabled?'Running':'Disabled',
  statusTone:!p.installed?'muted':p.enabled?'green':'amber',
  tags:p.id==='core'?['Contracts','Mechanical Gate','Agent Roster']:['Artifact Checks','Browser Eye','Gate Evidence'],
  protected:Boolean(p.protected),
  attrs:`data-action="manage-plugin" data-plugin="${esc(p.id)}"`,
  updateAttrs:`data-action="update-plugin-card" data-plugin="${esc(p.id)}"`
 }));
 const design=state.plugins.find(p=>p.id==='design'),linked=state.linkedDesign&&design?.installed&&design.enabled;
 return [
  paseoItem,
  ...plugins,
  {
   id:'design',
   name:'Open Design',
   category:'RECOMMENDED',
   recommended:true,
   description:linked?'Factory workspace redesign · revision r3 connected for UI gate reviews.':'Interactive UI mockups, design token sync, and Owner UI approval for this project.',
   version:design?.version==='local'?'0.27.0':(design?.version||'0.27.0'),
   latestVersion:design?.latestVersion||null,
   updateAvailable:Boolean(design?.updateAvailable),
   glyph:'design',
   tone:'cyan',
   status:!design?.installed?'Not installed':!design.enabled?'Disabled':linked?'Linked':'Not linked',
   statusTone:linked?'cyan':design?.installed&&!design.enabled?'amber':'muted',
   tags:['Design Studio','UI Approval Gate',linked?'Revision r3':'Mockup Sync'],
   protected:false,
   attrs:'data-management-action="design"'
  },
  {
   id:'vault',
   name:'Private Vault',
   category:'RECOMMENDED',
   recommended:true,
   description:state.vaultStage===2?`Synced with ${state.vaultRepo} (${state.vaultBranch}).`:'Sync model lanes, signing keys (.p8, keystore), and secrets across machines.',
   version:'gh-cli',
   latestVersion:null,
   updateAvailable:false,
   glyph:'shield',
   tone:'lime',
   status:privateVaultStatus(),
   statusTone:state.vaultStage===2?'green':'amber',
   tags:['Signing Keys','Lane Sync','Multi-Host'],
   protected:false,
   attrs:'data-management-action="vault"'
  }
 ];
}
function managementIntegrationCard(item){
 const rawVer=item.version?String(item.version).replace(/^v/,''):'';
 const verLabel=rawVer?`v${esc(rawVer)}`:'';
 const nextVerLabel=item.latestVersion?`v${esc(String(item.latestVersion).replace(/^v/,''))}`:'';
 const needsSetup=['Not installed','Not linked','Sign-in required','Ready to set up'].includes(item.status);
 const statusDotTone=item.statusTone==='green'||item.statusTone==='cyan'?'green':item.statusTone==='amber'?'amber':item.statusTone==='red'?'red':'muted';
 const iconTone=item.tone||'cyan';
 let rightControl='';
 if(item.updateAvailable&&item.updateAttrs){
  rightControl=`<button type="button" class="integration-card-update-btn" ${item.updateAttrs} title="Update ${esc(item.name)} to ${nextVerLabel}" ${readonly()?'disabled':''}><span class="dot amber"></span><span>Update ${nextVerLabel}</span></button>`;
 }else if(needsSetup){
  rightControl=`<span class="integration-card-action-hint">${esc(item.status==='Not linked'?'Connect':'Set up')} →</span>`;
 }else{
  rightControl=`<span class="integration-card-chevron" aria-hidden="true">${icon('chevron')}</span>`;
 }
 return `<article class="integration-card ${item.updateAvailable?'has-update':''}" aria-label="${esc(item.name)}">
  <div class="integration-card-top">
   <span class="integration-item-icon tone-${esc(iconTone)}">${icon(item.glyph)}</span>
   <div class="integration-card-title-group">
    <button type="button" class="integration-card-main" ${item.attrs} aria-label="Configure ${esc(item.name)}" aria-haspopup="dialog" ${readonly()?'disabled':''}>${esc(item.name)}</button>
    <div class="integration-card-submeta">
     <span class="integration-card-status"><span class="dot ${statusDotTone}"></span><span>${esc(item.status)}</span></span>
     ${verLabel?`<span class="integration-card-sep">·</span><span class="integration-card-version">${verLabel}</span>`:''}
    </div>
   </div>
   <div class="integration-card-right">${rightControl}</div>
  </div>
  <p class="integration-card-desc">${esc(item.description)}</p>
 </article>`;
}
renderPlugins=function(){
 const items=managementIntegrationItems(),missing=state.plugins.filter(p=>p.protected&&!p.installed);
 return `${missing.length?`<div class="notice amber"><h3>Required setup is incomplete</h3><p>${missing.length} required components are missing.</p>${button('Install Required Skills & Tools','install-required',readonly()?'disabled':'','primary')}</div>`:''}
 <div class="integration-card-grid">${items.map(managementIntegrationCard).join('')}</div>`;
};
function skillRowClean(skill,host=false){
 return `<article class="skill-row-clean">
  <div class="skill-clean-main">
   <span class="skill-clean-icon">${icon(skill.pack==='Workflow'?'design':skill.pack==='Expo'?'agents':'code')}</span>
   <strong class="skill-clean-name">${esc(skill.name)}</strong>
   <span class="skill-clean-desc">${esc(skillDescription(skill))}</span>
  </div>
  <span class="skill-clean-pack">${esc(skill.pack)}</span>
  <span class="skill-clean-role">${esc(skill.role)}</span>
  <div class="skill-clean-action">
   ${host?`<button type="button" class="btn ghost skill-clean-btn" data-action="import-skill" data-skill="${esc(skill.name)}" ${readonly()?'disabled':''}>Import</button>`:`<button type="button" class="skill-clean-inspect" data-ui="skill-detail" data-skill="${esc(skill.name)}" aria-label="Inspect ${esc(skill.name)}"><span>Inspect</span>${icon('chevron')}</button>`}
  </div>
 </article>`;
}
renderSkills=function(){
 const installed=state.skills.filter(s=>s.installed),pack=state.skillPack||'All';
 const match=s=>(pack==='All'||s.pack===pack)&&skillMatchesRole(s,state.skillRole)&&(!state.search||(s.name+' '+s.pack+' '+skillDescription(s)).toLowerCase().includes(state.search.toLowerCase()));
 const items=state.skills.filter(s=>(state.skillTab==='host'?!s.installed:s.installed)&&match(s));
 const packNames=['All','Core','Workflow','Expo','Firebase','3D/ZCode','Science'];
 const packCanEnable=!['All','Core','Workflow'].includes(pack);
 const isPackEnabled=state.linkedPacks.includes(pack);
 const sidebar=`<aside class="skills-clean-nav" aria-label="Filter skill packs">${packNames.map(name=>{
  const cnt=installed.filter(s=>name==='All'||s.pack===name).length;
  return `<button type="button" class="skills-pack-item ${pack===name?'active':''}" data-ui="skill-pack" data-pack-name="${name}" aria-pressed="${pack===name}"><span>${name}</span><span class="skills-pack-count">${cnt}</span></button>`;
 }).join('')}</aside>`;
 const subtabs=`<div class="skills-clean-subbar">
  <div class="skills-clean-subtabs" role="tablist">
   ${[['installed','Installed',installed.length],['host','Available on host',state.skills.filter(s=>!s.installed).length],['matrix','Role matrix',null]].map(([id,label,cnt])=>`<button type="button" class="skills-subtab ${state.skillTab===id?'active':''}" data-skill-tab="${id}">${label}${cnt!==null?`<span class="skills-subtab-count">${cnt}</span>`:''}</button>`).join('')}
  </div>
  ${packCanEnable?`<div class="skills-pack-inline-toggle"><span>${esc(pack)} pack</span><button type="button" class="btn ghost skill-clean-btn ${isPackEnabled?'is-enabled':''}" data-action="toggle-pack" data-pack="${esc(pack)}" ${readonly()?'disabled':''}><span class="dot ${isPackEnabled?'green':'muted'}"></span><span>${isPackEnabled?'Enabled':'Enable for project'}</span></button></div>`:''}
 </div>`;
 let body;
 if(state.skillTab==='matrix'){
  const roleRows=[['SLP','Supervisor'],['SLP','Lead'],['SLP','Peer'],['Scrum','PM'],['Scrum','UX'],['Scrum','Architect'],['Scrum','Dev'],['Scrum','QA']];
  body=`<div class="skills-matrix-clean">${roleRows.map(([model,role])=>{
   const skills=installed.filter(s=>match(s)&&(s.role.includes(role)||(model==='SLP'&&['Lead','Peer'].includes(role)&&s.role.includes('Dev'))));
   return `<div class="skills-matrix-row"><div class="skills-matrix-role"><strong>${role}</strong><span>${model}</span></div><div class="skills-matrix-items">${skills.map(s=>`<span class="skills-matrix-chip">${esc(s.name)}</span>`).join('')||'<span class="skills-matrix-empty">Contract-scoped only</span>'}</div></div>`;
  }).join('')}</div>`;
 }else{
  body=items.length?`<div class="skills-clean-list">${items.map(s=>skillRowClean(s,state.skillTab==='host')).join('')}</div>`:`<div class="int-clean-empty"><p>${state.skillTab==='host'?'No unassigned host skills match this filter.':'No installed skills match this filter.'}</p></div>`;
 }
 return `<div class="skills-clean-layout">${sidebar}<div class="skills-clean-main">${subtabs}${body}</div></div>`;
};
function mcpCardClean(m,index){
 const healthy=m.health==='Sample connected',attention=['Auth Expired','Missing Key','Unreachable'].includes(m.health),tone=healthy?'green':attention?'amber':'muted';
 const healthLabel=healthy?'Connected':m.synced?m.health:'On host';
 const iconTone=healthy?'cyan':attention?'coral':'lime';
 return `<article class="mcp-server-card" aria-label="${esc(m.name)} MCP server">
  <div class="mcp-clean-top">
   <span class="integration-item-icon tone-${iconTone}">${icon(m.name==='GitHub'?'git':'code')}</span>
   <div class="mcp-clean-identity">
    <h3>${esc(m.name)}</h3>
    <div class="mcp-clean-submeta">
     <span class="mcp-clean-health" title="Status: ${esc(healthLabel)}"><span class="dot ${tone}"></span><span>${esc(healthLabel)}</span></span>
     <span class="integration-card-sep">·</span>
     <span class="mcp-clean-transport">${esc(m.transport)}</span>
    </div>
   </div>
   <div class="mcp-clean-actions">
    <button type="button" class="icon-btn mcp-card-probe" data-ui="mcp-probe" data-mcp-index="${index}" data-mcp-focus="probe-${index}" aria-label="Verify ${esc(m.name)}" title="Verify connection" ${readonly()?'disabled':''}>${icon('refresh')}</button>
    <button type="button" class="mcp-card-sync ${m.synced?'synced':''}" data-action="mcp-sync" data-mcp="${index}" data-mcp-focus="sync-${index}" ${readonly()?'disabled':''}>${m.synced?'Synced':'Sync'}</button>
   </div>
  </div>
  <div class="mcp-clean-bottom">
   <div class="mcp-clean-harnesses" role="group" aria-label="Harnesses for ${esc(m.name)}">
    <span class="mcp-clean-label">Harnesses</span>
    ${['Pi','Claude','Codex','OpenCode'].map(target=>{
     const selected=m.targets.includes(target);
     return `<button type="button" class="mcp-card-target ${selected&&m.synced?'selected':''}" data-action="mcp-target" data-mcp="${index}" data-target="${target}" data-mcp-focus="target-${index}-${target}" aria-pressed="${selected&&m.synced}" ${!m.synced||readonly()?'disabled':''}>${target}</button>`;
    }).join('')}
   </div>
   <button type="button" class="mcp-card-vault ${m.vault&&m.synced?'enabled':''}" data-action="mcp-vault" data-mcp="${index}" data-mcp-focus="vault-${index}" role="switch" aria-label="Vault sync for ${esc(m.name)}" aria-checked="${m.vault&&m.synced}" ${!m.synced||readonly()?'disabled':''}><span>Vault</span><span class="dot ${m.vault&&m.synced?'green':'muted'}"></span></button>
  </div>
 </article>`;
}
renderMcps=function(){
 const attention=state.mcps.filter(m=>['Auth Expired','Missing Key','Unreachable'].includes(m.health));
 const visible=state.mcps.map((m,index)=>({m,index})).filter(({m})=>(state.mcpFilter==='all'||state.mcpFilter==='synced'&&m.synced||state.mcpFilter==='host'&&!m.synced||state.mcpFilter==='attention'&&attention.includes(m))&&(!state.mcpSearch||m.name.toLowerCase().includes(state.mcpSearch.toLowerCase())));
 return visible.length?`<div class="mcp-card-grid">${visible.map(({m,index})=>mcpCardClean(m,index)).join('')}</div>`:`<div class="int-clean-empty"><p>No MCP servers match this filter.</p></div>`;
};
function renderIntegrationToolbarActions(items,updates){
 if(state.integrationTab==='skills'){
  return `<div class="int-header-controls">
   <div class="int-inline-search">${icon('search')}<label class="sr-only" for="skill-search">Search skills</label><input id="skill-search" placeholder="Filter skills…" value="${esc(state.search)}"></div>
   <button type="button" class="btn ghost int-quiet-btn" data-action="update-skills" ${readonly()?'disabled':''}>${icon('refresh')}<span>Sync</span></button>
  </div>`;
 }
 if(state.integrationTab==='mcps'){
  const synced=state.mcps.filter(m=>m.synced),attention=state.mcps.filter(m=>['Auth Expired','Missing Key','Unreachable'].includes(m.health));
  const filters=[['all','All',state.mcps.length],['synced','Synced',synced.length],['host','On host',state.mcps.filter(m=>!m.synced).length],...(attention.length?[['attention','Attention',attention.length]]:[])];
  return `<div class="int-header-controls">
   <div class="mcp-filter-pills" role="group" aria-label="Filter MCP servers">${filters.map(([id,name,count])=>`<button type="button" class="mcp-filter-pill ${state.mcpFilter===id?'selected':''}" data-ui="mcp-filter" data-mcp-filter="${id}" aria-pressed="${state.mcpFilter===id}"><span>${name}</span><small>${count}</small></button>`).join('')}</div>
   <div class="int-inline-search">${icon('search')}<label class="sr-only" for="mcp-search">Search MCP servers</label><input id="mcp-search" placeholder="Filter servers…" value="${esc(state.mcpSearch)}"></div>
   <button type="button" class="btn ghost int-quiet-btn" data-action="probe-mcps" ${readonly()?'disabled':''}>${icon('refresh')}<span>Verify all</span></button>
  </div>`;
 }
 return `<div class="int-header-controls">
  ${updates.length>1?`<button type="button" class="integration-card-update-btn" data-action="update-all-integrations" ${readonly()?'disabled':''}><span class="dot amber"></span><span>Update all (${updates.length})</span></button>`:''}
  <button type="button" class="btn ghost int-quiet-btn" data-action="check-updates">${icon('refresh')}<span>Check updates</span></button>
  ${paseoToolsMenu()}
 </div>`;
}
renderIntegrations=function(){
 const items=managementIntegrationItems(),updates=items.filter(i=>i.updateAvailable);
 const tabs=[['plugins','Plugins & tools',items.length,updates.length],['skills','Skills',state.skills.filter(s=>s.installed).length,0],['mcps','MCP servers',state.mcps.length,0]];
 return `<div class="int-header-bar">
  <div class="integration-tabs" aria-label="Integration categories">
   ${tabs.map(([id,title,count,upd])=>`<button type="button" class="integration-tab ${state.integrationTab===id?'active':''}" data-integration-tab="${id}" aria-pressed="${state.integrationTab===id}"><span>${title}</span><span class="nav-count">${count}</span>${upd?`<span class="integration-tab-update-dot" title="${upd} update available" aria-label="${upd} update available"></span>`:''}</button>`).join('')}
  </div>
  ${renderIntegrationToolbarActions(items,updates)}
 </div>
 ${state.integrationTab==='skills'?renderSkills():state.integrationTab==='mcps'?renderMcps():renderPlugins()}`;
};
renderVault=function(){
 const disabled=readonly()?'disabled':'',host=fleetHost();
 let body;
 if(state.vaultStage===0){
  body=`<p class="vault-dialog-intro">Sign in with GitHub CLI on ${esc(host?.name||'the selected Host')} to connect a private repository.</p><div class="vault-command"><code>gh auth login --web -p https</code>${button('Copy','copy','data-copy="gh auth login --web -p https"','ghost','copy')}</div><div class="dialog-actions">${button('Close','close-modal','','ghost')}${button('Check GitHub login','github-login',disabled,'primary')}</div>`;
 }else if(state.vaultStage===1){
  body=`<div class="field"><label for="vault-repository">Private repository</label><input id="vault-repository" value="${esc(state.vaultRepo||'')}" placeholder="owner/factory-vault" autocomplete="off" spellcheck="false"><small>Use owner/repository format.</small></div><div class="dialog-actions">${button('Cancel','close-modal','','ghost')}${button('Enable & sync','enable-vault',disabled,'primary')}</div>`;
 }else{
  body=`<dl class="vault-summary"><div><dt>Repository</dt><dd>${esc(state.vaultRepo)}</dd></div><div><dt>Branch</dt><dd>${esc(state.vaultBranch)}</dd></div><div><dt>Last sync</dt><dd>${state.vaultSynced?'Just now in preview':'Not synced'}</dd></div></dl><div class="vault-items">${badge('Lanes','green')}${badge('Eye','green')}${badge('Apps: '+(state.vaultImported?1:0))}${badge('ASC .p8',state.vaultImported?'green':'')}${badge('GPlay JSON',state.vaultImported?'green':'')}</div><div class="vault-secondary">${button('Import key','import-key',disabled,'ghost','plus')}${button('Advanced settings','vault-settings',disabled,'ghost','settings')}</div><div class="dialog-actions">${button('Close','close-modal','','ghost')}${button('Sync Vault','sync-vault',disabled,'primary','refresh')}</div>`;
 }
 return `<div class="compact-vault"><div class="vault-dialog-status"><span class="dot ${state.vaultStage===2?'green':'amber'}"></span>${privateVaultStatus()}</div>${body}<p class="management-preview-note">Preview only. No account, key file, or GitHub repository is accessed.</p></div>`;
};
state.privateVaultDialog=false;
state.openDesignDialog=false;
function showPrivateVault(){
 if(readonly()||!fleetOnline()){notify('Select a project on an online Host first.',true);return;}
 openModal('Private Vault',renderVault());state.privateVaultDialog=true;
}
function showOpenDesign(){
 if(readonly()||!fleetOnline()){notify('Select a project on an online Host first.',true);return;}
 openModal('Open Design',renderDesign());state.openDesignDialog=true;
}
function showPaseoDaemon(){
 if(readonly()||!fleetOnline()){notify('Select a project on an online Host first.',true);return;}
 if(typeof startIntegrationDialog==='function'){startIntegrationDialog('paseo');return;}
 openDaemonSettings(activeHostId());
}
function updatePaseoDaemon(){
 if(readonly()||!fleetOnline()){notify('Select a project on an online Host first.',true);return;}
 const d=state.paseoDaemon;if(!d)return;
 const next=d.latestVersion||'0.25.0';
 d.version=next;
 d.updateAvailable=false;
 log(`Updated Paseo Daemon to v${next}`,'','green','refresh');
 render();
 notify(`Paseo Daemon updated to v${next} in preview.`);
}
function updatePluginById(id){
 if(readonly()||!fleetOnline()){notify('Select a project on an online Host first.',true);return;}
 const p=state.plugins.find(item=>item.id===id);if(!p)return;
 const next=p.latestVersion||p.version;
 p.version=next;
 p.updateAvailable=false;
 log(`Updated ${p.name} to v${next}`,'','green','refresh');
 render();
 notify(`${p.name} updated to v${next} in preview.`);
}
function updateAllIntegrations(){
 if(readonly()||!fleetOnline()){notify('Select a project on an online Host first.',true);return;}
 const updated=[];
 if(state.paseoDaemon?.updateAvailable){
  state.paseoDaemon.version=state.paseoDaemon.latestVersion||'0.25.0';
  state.paseoDaemon.updateAvailable=false;
  updated.push(`Paseo v${state.paseoDaemon.version}`);
 }
 state.plugins.forEach(p=>{
  if(p.updateAvailable&&p.latestVersion){
   p.version=p.latestVersion;
   p.updateAvailable=false;
   updated.push(`${p.name} v${p.version}`);
  }
 });
 if(!updated.length){notify('All tools and plugins are already up to date.');return;}
 log(`Updated integrations: ${updated.join(', ')}`,'','green','refresh');
 render();
 notify(`Updated ${updated.join(' & ')} in preview.`);
}
function checkIntegrationUpdates(){
 const core=state.plugins.find(p=>p.id==='core');
 if(!state.paseoDaemon?.updateAvailable&&core&&core.version==='0.0.86'&&!core.updateAvailable){
  core.latestVersion='0.0.87';
  core.updateAvailable=true;
  core.releaseNotes='Improved Scrum UI gate state sync and Peer worktree cleanup.';
  render();
  notify('1 new update found: Paseo Factory v0.0.87.');
  return;
 }
 const pending=managementIntegrationItems().filter(i=>i.updateAvailable);
 if(pending.length){
  render();
  notify(`${pending.length} update${pending.length===1?' is':'s are'} ready to install (${pending.map(p=>p.name+' v'+p.latestVersion).join(', ')}).`);
  return;
 }
 notify(`All plugins and Paseo Daemon (v${state.paseoDaemon?.version||'0.25.0'}) are up to date.`);
}
const managementOpenModalBefore=openModal;
openModal=function(...args){state.privateVaultDialog=false;state.openDesignDialog=false;return managementOpenModalBefore(...args);};
const managementCloseModalBefore=closeModal;
closeModal=function(){state.privateVaultDialog=false;state.openDesignDialog=false;managementCloseModalBefore();};
const managementNavigateBefore=navigate;
navigate=function(page){
 if(page==='vault'||page==='design'){state.integrationTab='plugins';managementNavigateBefore('integrations');if(page==='vault')showPrivateVault();else showOpenDesign();return;}
 managementNavigateBefore(page);
};
const managementRenderBefore=render;
render=function(){
 managementRenderBefore();
 const navCount=$('.nav-item[data-nav="integrations"] .nav-count');
 if(navCount){
  const items=managementIntegrationItems(),updates=items.filter(i=>i.updateAvailable).length;
  navCount.textContent=items.length;
  navCount.classList.toggle('has-update',updates>0);
  navCount.title=updates?`${updates} update available`:'';
 }
 if((state.privateVaultDialog||state.openDesignDialog)&&$('#modal').open){
  const action=document.activeElement?.dataset?.action;
  $('#modal-body').innerHTML=state.openDesignDialog?renderDesign():renderVault();
  ($('[data-action="'+(action||'')+'"]',$('#modal-body'))||$('input,button',$('#modal-body')))?.focus({preventScroll:true});
 }
};
const managementModelsBefore=renderModels;
renderModels=function(){return managementModelsBefore();};
state.settingsTab='project';
renderSettings=function(){
 const all=state.project==='all',activeTab=state.settingsTab||(all?'hosts':'project');
 const tabs=[
  ['project','Project settings','settings',all?null:(mode()==='scrum'?'Scrum':'SLP')],
  ['hosts','Hosts & machines','host',state.hosts.length],
  ['daemon','Daemon & Paseo','plug',null]
 ];
 const tabBar=`<div class="integration-tabs settings-surface-tabs" role="tablist" aria-label="Settings sections">${tabs.map(([id,label,glyph,count])=>`<button type="button" class="integration-tab ${activeTab===id?'active':''}" role="tab" aria-selected="${activeTab===id}" data-settings-tab="${id}">${icon(glyph)}<span>${label}</span>${count!==null?`<span class="nav-count">${count}</span>`:''}</button>`).join('')}</div>`;
 if(activeTab==='hosts'){
  return `${tabBar}<div class="settings-tab-panel">${typeof renderFleetHosts==='function'?renderFleetHosts():''}</div>`;
 }
 if(activeTab==='daemon'){
  return `${tabBar}<div class="settings-tab-panel">${typeof renderDaemonSettings==='function'?renderDaemonSettings():''}</div>`;
 }
 if(all){
  return `${tabBar}<div class="fleet-offline"><h2>Select a project to configure project settings</h2><p>Execution mode switching, project reset, and directory settings belong to an individual project. You can manage connected Hosts in the Hosts tab above.</p><div class="od-row"><button class="btn primary" data-action="projects">Choose Host & Project</button><button class="btn ghost" data-settings-tab="hosts">${icon('host')}Manage Hosts</button></div></div>`;
 }
 const p=project(),host=fleetHost(),disabled=readonly()?'disabled':'';
 const nextModeLabel=mode()==='scrum'?'SLP':'Agile Scrum';
 return `${tabBar}<div class="project-settings-surface"><dl class="project-settings-list"><div class="project-setting-row"><dt>Name</dt><dd><strong>${esc(fleetProjectName(p))}</strong></dd></div><div class="project-setting-row"><dt>Directory</dt><dd class="setting-path">${esc(p?.path||'Unavailable')}</dd></div><div class="project-setting-row"><dt>Host</dt><dd><span class="setting-host">${hostAvatar(host)}${esc(host?.name||'Unavailable')}</span><button type="button" class="btn ghost" data-settings-tab="hosts">${icon('host')}Manage Hosts</button></dd></div><div class="project-setting-row"><dt>Execution mode</dt><dd><span class="setting-mode">${icon('flow')}<strong>${mode()==='scrum'?'Agile Scrum':'SLP'}</strong></span><span class="setting-mode-hint">Locked on workspace header to prevent accidental resets</span></dd></div></dl><details class="settings-diagnostics"><summary><span class="settings-disclosure-title">${icon('activity')}Connection details</span><span class="management-service-status ${paseoDaemonStatus(host).tone}"><span class="dot"></span>${paseoDaemonStatus(host).label}</span>${icon('chevron')}</summary><dl class="vault-summary"><div><dt>Daemon</dt><dd>${esc(paseoHostLinks(host?.id).address||'Address unavailable')}</dd></div><div><dt>Server ID</dt><dd>${esc(host?.daemonConnection?.serverId||'Unavailable')}</dd></div><div><dt>State directory</dt><dd>${esc(host?.daemonConnection?.stateDir||'Unavailable')}</dd></div></dl></details><div class="project-danger-actions"><div class="project-danger-heading">${icon('alert')}<span>Execution Lifecycle & Danger Zone</span></div><div class="project-danger-row mode-danger-row"><div><strong>Switch execution mode (${mode()==='scrum'?'Agile Scrum → SLP':'SLP → Agile Scrum'})</strong><p>Archives active Supervisor and Lead sessions and resets the current run roster. Only switch modes before starting a new run.</p></div>${button('Switch to '+nextModeLabel+'…','switch-mode',disabled,'danger')}</div><div class="project-danger-row"><div><strong>Reset project</strong><p>Clear tasks and agent seats. Keep the project.</p></div>${button('Reset project','danger-project',`data-op="reset" ${disabled}`,'ghost')}</div><div class="project-danger-row"><div><strong>Delete project</strong><p>Remove this project from Factory.</p></div>${button('Delete project','danger-project',`data-op="delete" ${disabled}`,'danger')}</div></div></div>`;
};
renderDesign=function(){
 const disabled=readonly()?'disabled':'',plugin=state.plugins.find(p=>p.id==='design');
 return `<div class="compact-design"><div class="vault-dialog-status"><span class="dot ${state.linkedDesign?'cyan':'muted'}"></span>${state.linkedDesign?'Linked':'Not linked'}</div>${state.linkedDesign?`<dl class="vault-summary"><div><dt>Design project</dt><dd>Factory workspace redesign</dd></div><div><dt>Revision</dt><dd>r3</dd></div><div><dt>Review</dt><dd>${esc(state.designDecision||'Awaiting Owner')}</dd></div><div><dt>Evidence</dt><dd>Illustrative design · no verified capture</dd></div></dl><div class="vault-secondary">${button('Sync','sync-design',disabled,'ghost','refresh')}${button('Unlink','unlink-design',disabled,'ghost')}</div>`:'<p class="vault-dialog-intro">Connect design sources to this project to review revisions and UI decisions.</p>'}${plugin?`<div class="design-plugin-access">${button('Plugin settings','manage-plugin','data-plugin="design" '+disabled,'ghost','settings')}</div>`:''}<div class="dialog-actions">${button('Close','close-modal','','ghost')}${state.linkedDesign?button('Open Studio','studio','','primary','external'):button('Link project','link-design',disabled,'primary','design')}</div><p class="management-preview-note">Preview only. No local design folder is accessed.</p></div>`;
};
document.addEventListener('click',event=>{
 const tabBtn=event.target.closest('button[data-settings-tab]');
 if(tabBtn&&!tabBtn.disabled){
  state.settingsTab=tabBtn.dataset.settingsTab;
  state.page='settings';
  render();
  $(`[data-settings-tab="${state.settingsTab}"]`)?.focus({preventScroll:true});
  return;
 }
 const actionBtn=event.target.closest('button[data-action]');
 if(actionBtn&&!actionBtn.disabled){
  const act=actionBtn.dataset.action;
  if(act==='update-paseo'){updatePaseoDaemon();return;}
  if(act==='update-plugin-card'){updatePluginById(actionBtn.dataset.plugin);return;}
  if(act==='update-all-integrations'){updateAllIntegrations();return;}
  if(act==='check-updates'){checkIntegrationUpdates();return;}
 }
 const control=event.target.closest('button[data-management-action]');if(!control||control.disabled)return;
 if(control.dataset.managementAction==='vault')showPrivateVault();
 if(control.dataset.managementAction==='design')showOpenDesign();
 if(control.dataset.managementAction==='paseo')showPaseoDaemon();
});
state.page='integrations';
state.integrationTab='mcps';
render();
