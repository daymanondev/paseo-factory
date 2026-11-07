'use strict';
/* Task-specific integration dialogs. All actions stay in local preview state. */
fleetHostFields.push('vaultKeyTypes');
fleetHostDefaults.vaultKeyTypes=[];
Object.values(state.fleetHostState).forEach(host=>{host.vaultKeyTypes=host.vaultKeyTypes||[];});
state.vaultKeyTypes=[];
state.integrationDialog=null;
shapes.key='<circle cx="8" cy="8" r="5"/><path d="m12 12 9 9m-4-4 3-3m-6 0 3-3"/>';
const integrationKeyTypes={
 asc:{name:'App Store',label:'App Store Connect',glyph:'key',fields:[['asc-path','Private key path','/path/to/AuthKey.p8',true],['asc-id','Key ID','Key ID'],['asc-issuer','Issuer ID','Issuer ID']]},
 play:{name:'Google Play',label:'Google Play',glyph:'code',fields:[['play-path','Service account JSON','/path/to/service-account.json',true]]},
 android:{name:'Android',label:'Android keystore',glyph:'lock',fields:[['keystore-path','Keystore path','/path/to/release.keystore',true],['keystore-password','Keystore password','Optional in this preview',false,'password']]},
 eye:{name:'Eye',label:'Eye configuration',glyph:'eye',fields:[['eye-path','Configuration path','/path/to/eye-config.json',true]]}
};
function intButton(label,action,attrs='',variant='ghost',glyph=''){
 return `<button type="button" class="btn ${variant}" data-integration-action="${action}" data-int-focus="${action}" ${variant==='primary'?'data-int-primary':''} ${attrs}>${glyph?icon(glyph):''}<span>${label}</span></button>`;
}
function intFacts(rows){return `<dl class="int-facts">${rows.map(([label,value])=>`<div><dt>${label}</dt><dd>${value}</dd></div>`).join('')}</dl>`;}
function intDisclosure(label,body,open=false){return `<details class="int-disclosure" ${open?'open':''}><summary><span>${label}</span>${icon('chevron')}</summary><div class="int-disclosure-body">${body}</div></details>`;}
function intFeedback(){const d=state.integrationDialog;return d.feedback?`<p class="int-feedback" role="status">${icon('info')}<span>${esc(d.feedback)}</span></p>`:'';}
function intFooter(primary,secondary=''){
 const back=state.integrationDialog.view!=='main';
 return `<footer class="int-footer"><div class="int-footer-actions">${intButton(back?'Back':'Close',back?'back':'close','','ghost',back?'chevron':'')}<span class="spacer"></span>${secondary}${primary}</div><p class="int-preview">Preview only · no live operations</p></footer>`;
}
function intPanel(body,primary,secondary=''){return `<div class="int-main">${body}${intFeedback()}</div>${intFooter(primary,secondary)}`;}
function intPluginStatus(plugin){return !plugin?.installed?{text:'Not installed',tone:'muted'}:!plugin.enabled?{text:'Disabled',tone:'amber'}:{text:'Running',tone:'green'};}
function intDesignPlugin(){return state.plugins.find(plugin=>plugin.id==='design');}
function intDesignStatus(){const plugin=intDesignPlugin();return !plugin?.installed?{text:'Not installed',tone:'muted'}:!plugin.enabled?{text:'Disabled',tone:'amber'}:state.linkedDesign?{text:'Linked',tone:'cyan'}:{text:'Not linked',tone:'muted'};}
function intHeaderInfo(){
 const d=state.integrationDialog;
 if(d.kind==='paseo'){
  const rt=typeof paseoRuntimeStatus==='function'?paseoRuntimeStatus():{label:'Daemon running',tone:'green'};
  return {title:'Paseo Daemon',glyph:'host',tone:'cyan',status:{text:rt.label,tone:rt.tone}};
 }
 if(d.kind==='plugin'||d.view==='plugin'){
  const plugin=state.plugins.find(p=>p.id===d.pluginId),status=intPluginStatus(plugin);
  return {title:plugin?.name||'Plugin',glyph:d.pluginId==='core'?'flow':d.pluginId==='tools'?'shield':'design',tone:d.pluginId==='core'?'coral':'cyan',status};
 }
 if(d.kind==='design')return {title:d.view==='link'?'Link design project':'Open Design',glyph:'design',tone:'cyan',status:intDesignStatus()};
 return {title:d.view==='import'?'Import key':d.view==='vault-settings'?'Vault settings':'Private Vault',glyph:'shield',tone:'lime',status:{text:privateVaultStatus(),tone:state.vaultStage===2?'green':'amber'}};
}
function intPaseoBody(){
 const paseo=state.paseoDaemon||{},host=fleetHost(),links=typeof paseoHostLinks==='function'&&host?paseoHostLinks(host.id):{};
 const endpoint=typeof paseoEndpointLabel==='function'&&links?.address?paseoEndpointLabel(links.address):'127.0.0.1:6767 (local bridge)';
 const capabilities=[
  ['host','Host Daemon & Runtime','Executes Supervisor, Lead, and Peer sessions on this machine'],
  ['git','Isolated Task Worktrees','Manages parallel worktree checkouts per task attempt'],
  ['plug','Provider & Session Multiplexer','Streams Codex, Claude, Pi, and OpenCode sessions']
 ];
 const updateBox=paseo.updateAvailable?`<div class="int-update-callout">${icon('refresh')}<div><strong>Paseo v${esc(paseo.latestVersion)} is ready to install</strong><p>${esc(paseo.releaseNotes||'Includes faster worktree hydration and Supervisor handoff improvements.')}</p></div></div>`:'';
 const body=`<p class="int-description">Factory runs on the Paseo daemon. Keep Paseo updated so Supervisor, Lead, and Peer worktrees have the latest runtime capabilities.</p>${updateBox}${intFacts([
  ['Host',`${esc(host?.name||'Local Host')} (${esc(host?.os||'macOS')})`],
  ['Installed version',`v${esc(paseo.version||'0.24.2')} · ${esc(paseo.channel||'stable')}`],
  ['Update status',paseo.updateAvailable?`<span class="int-inline-status amber">${icon('refresh')}v${esc(paseo.latestVersion)} available</span>`:`<span class="int-inline-status green">${icon('check')}Up to date (v${esc(paseo.version||'0.25.0')})</span>`],
  ['Daemon endpoint',esc(endpoint)]
 ])}<div class="int-capabilities" aria-label="Paseo Daemon capabilities">${capabilities.map(([glyph,title,detail])=>`<div class="int-capability">${icon(glyph)}<span><strong>${title}</strong><small>${detail}</small></span></div>`).join('')}</div><p class="int-protected">${icon('lock')}<span>Required host daemon · powers Factory sessions</span></p>${intDisclosure('Connection & Host diagnostics',`<div class="int-settings-link"><span><strong>Daemon &amp; Paseo settings</strong><small>Inspect host endpoints, Server ID, and Paseo Web shortcuts</small></span>${intButton('Open settings','paseo-open-settings','','ghost','settings')}</div>`)}`;
 return intPanel(
  body,
  paseo.updateAvailable?intButton(`Update to v${paseo.latestVersion}`,'paseo-update','','primary','refresh'):intButton('Check for updates','paseo-check','','primary','refresh'),
  intButton('Restart daemon','paseo-restart','','ghost','refresh')
 );
}
function intPluginBody(){
 const d=state.integrationDialog,plugin=state.plugins.find(p=>p.id===d.pluginId);
 if(!plugin)return intPanel('<p class="int-description">This component is no longer available.</p>','');
 const isCore=plugin.id==='core',isTools=plugin.id==='tools';
 const capabilities=isCore?[['tasks','Contracts','Task scope and acceptance rules'],['shield','Verification gates','Attempt verdicts and evidence'],['agents','Agent orchestration','Supervisor, Lead and Peer lifecycle']]:isTools?[['code','Artifact checks','Required task outputs'],['eye','Browser verification','Support for UI evidence collection']]:[['design','Design Studio','Project sources and revisions'],['shield','UI approval','Owner decisions before implementation']];
 const source=esc(plugin.customSource||'Canonical GitHub source');
 const values=d.sourceDraft||{};
 const advanced=`<div class="int-form-field"><label for="int-plugin-source">Custom source</label><input id="int-plugin-source" data-int-draft="source" value="${esc(values.source??plugin.customSource??'')}" placeholder="owner/repository" autocomplete="off" spellcheck="false" aria-describedby="int-source-error"></div><div class="int-form-field"><label for="int-plugin-ref">Ref</label><input id="int-plugin-ref" data-int-draft="ref" value="${esc(values.ref??plugin.sourceRef??'main')}" autocomplete="off" spellcheck="false"></div><p class="int-field-error" id="int-source-error" role="alert" ${d.error?'':'hidden'}>${esc(d.error||'')}</p><div class="int-inline-actions">${intButton('Apply source','plugin-source','','ghost','git')}${plugin.customSource?intButton('Use canonical','plugin-canonical'):''}</div>${!plugin.protected?`<div class="int-maintenance">${intButton(plugin.enabled?'Disable plugin':'Enable plugin','plugin-toggle','','ghost',plugin.enabled?'minus':'check')}${intButton('Remove plugin','plugin-remove','','danger')}</div>`:''}`;
 const updateBox=plugin.updateAvailable?`<div class="int-update-callout">${icon('refresh')}<div><strong>v${esc(plugin.latestVersion)} update available</strong><p>${esc(plugin.releaseNotes||'New plugin improvements ready to install.')}</p></div></div>`:'';
 const body=`<p class="int-description">${esc(plugin.description)}</p>${updateBox}${intFacts([['Version',esc(plugin.version)+(plugin.updateAvailable?` → v${esc(plugin.latestVersion)} available`:'')],['Source',source]])}<div class="int-capabilities" aria-label="${isTools?'Verification capabilities':'Capabilities'}">${capabilities.map(([glyph,title,detail])=>`<div class="int-capability">${icon(glyph)}<span><strong>${title}</strong><small>${detail}</small></span></div>`).join('')}</div>${isTools?'<p class="int-context-note">Verification results are recorded with each task’s Gate.</p>':''}${plugin.protected?`<p class="int-protected">${icon('lock')}<span>${isCore?'Core component':'Required tool'} · stays enabled</span></p>`:''}${intDisclosure('Advanced',advanced,Boolean(d.error))}`;
 return intPanel(body,intButton(plugin.installed?(plugin.updateAvailable?`Update to v${plugin.latestVersion}`:'Update'):'Install',plugin.installed?'plugin-update':'plugin-install','','primary',plugin.installed?'refresh':'plus'),plugin.installed?intButton('Reload','plugin-reload','','ghost','refresh'):'');
}
function intDesignBody(){
 const d=state.integrationDialog,plugin=intDesignPlugin(),usable=plugin?.installed&&plugin.enabled;
 if(d.view==='link'){
  return intPanel(`<p class="int-description">Choose the design project to connect to this workspace.</p><div class="int-project-selection">${icon('design')}<span><strong>Factory workspace redesign</strong><small>Revision r3 · preview project</small></span><span class="int-selection-check">${icon('check')}</span></div>`,intButton('Link project','design-link-confirm','','primary','design'));
 }
 if(!usable){
  return intPanel(`<p class="int-description">${plugin?.installed?'Enable the Open Design plugin to use this connection.':'Install the Open Design companion to connect design sources.'}</p>${intFacts([['Workspace',esc(fleetProjectName(project()))],['Plugin',plugin?.installed?'Disabled':'Not installed']])}`,intButton(plugin?.installed?'Enable plugin':'Install plugin','design-enable','','primary','plus'));
 }
 const needsReview=mode()==='scrum'&&!state.designDecision&&!state.emptyProjects?.has(scopeKey());
 const decision={approve:'Approved',changes:'Changes requested',waive:'Waived'}[state.designDecision]||'Awaiting Owner';
 const decisionTone=state.designDecision==='changes'||!state.designDecision?'amber':'green';
 const linked=`<div class="int-project-identity">${icon('folder')}<div><strong>Factory workspace redesign</strong><small>Revision r3</small></div>${intButton('Sync','design-sync','','ghost','refresh')}</div>${intFacts([['Review',`<span class="int-inline-status ${decisionTone}">${icon(needsReview?'clock':'check')}${decision}</span>`],['Evidence','Illustrative layout · no verified capture']])}${needsReview?`<div class="int-decision-note">${icon('clock')}<span>Implementation is waiting for your UI decision.</span></div>`:''}`;
 const advanced=`<div class="int-inline-actions">${intButton('Plugin settings','design-plugin','','ghost','settings')}${state.linkedDesign?intButton('Unlink project','design-unlink','','danger'):''}</div>`;
 const body=(state.linkedDesign?linked:'<p class="int-description">Connect a design project to review its revisions and UI decisions here.</p>')+intDisclosure('Connection settings',advanced);
 return intPanel(body,intButton(state.linkedDesign?needsReview?'Review design':'Open Studio':'Link project',state.linkedDesign?needsReview?'design-review':'design-studio':'design-link','','primary',state.linkedDesign?needsReview?'eye':'external':'plus'));
}
function intVaultSteps(){return `<ol class="int-setup-steps" aria-label="Vault setup">${['GitHub','Repository','Sync'].map((label,index)=>`<li class="${state.vaultStage===index?'current':state.vaultStage>index?'complete':''}" ${state.vaultStage===index?'aria-current="step"':''}><span>${state.vaultStage>index?icon('check'):index+1}</span>${label}</li>`).join('')}</ol>`;}
function intVaultImportBody(){
 const d=state.integrationDialog,type=integrationKeyTypes[d.keyType],values=d.importValues||{};
 const fields=type.fields.map(([id,label,placeholder,required,password])=>`<div class="int-form-field"><label for="int-${id}">${label}${required?' <span class="int-required">*</span>':''}</label><input id="int-${id}" data-int-import="${id}" type="${password||'text'}" value="${esc(values[id]||'')}" placeholder="${placeholder}" autocomplete="off" spellcheck="false" ${required?'aria-required="true"':''} ${required&&d.error?'aria-invalid="true" aria-describedby="int-import-error"':''}></div>`).join('');
 const body=`<div class="int-key-types" role="group" aria-label="Key type">${Object.entries(integrationKeyTypes).map(([id,item])=>`<button type="button" data-integration-action="key-type" data-key-type="${id}" aria-pressed="${d.keyType===id}" class="${d.keyType===id?'selected':''}">${icon(item.glyph)}<span>${item.name}</span></button>`).join('')}</div><p class="int-context-note">Add ${type.label} metadata. Files are not opened or uploaded.</p>${fields}<p class="int-field-error" id="int-import-error" role="alert" ${d.error?'':'hidden'}>${esc(d.error||'')}</p>${intDisclosure('Optional app identifier',`<div class="int-form-field"><label for="int-app-key">App key</label><input id="int-app-key" data-int-import="app-key" value="${esc(values['app-key']||'')}" placeholder="App identifier" autocomplete="off"></div>`)}`;
 return intPanel(body,intButton('Import & sync','vault-import-save','','primary','plus'));
}
function intVaultSettingsBody(){
 const d=state.integrationDialog,values=d.vaultDraft||{};
 return intPanel(`<div class="int-form-field"><label for="int-vault-repository">Repository</label><input id="int-vault-repository" data-int-vault="repo" value="${esc(values.repo??state.vaultRepo)}" placeholder="owner/repository" autocomplete="off" spellcheck="false"></div><div class="int-form-field"><label for="int-vault-branch">Branch</label><input id="int-vault-branch" data-int-vault="branch" value="${esc(values.branch??state.vaultBranch)}" autocomplete="off" spellcheck="false"></div><div class="int-form-field"><label for="int-vault-passphrase">Passphrase <small>(optional)</small></label><input id="int-vault-passphrase" type="password" autocomplete="off"><small>This preview does not retain the passphrase.</small></div><p class="int-field-error" role="alert" ${d.error?'':'hidden'}>${esc(d.error||'')}</p>${intDisclosure('Recovery',`<p class="int-context-note">Restore configuration from the existing Vault checkout.</p>${intButton('Direct hydrate','vault-hydrate','','ghost','refresh')}`)}`,intButton('Save settings','vault-settings-save','','primary','check'));
}
function intVaultBody(){
 const d=state.integrationDialog,host=fleetHost();
 if(d.view==='import')return intVaultImportBody();
 if(d.view==='vault-settings')return intVaultSettingsBody();
 if(state.vaultStage===0){
  return intPanel(`${intVaultSteps()}<p class="int-description">Sign in with GitHub CLI on ${esc(host?.name||'this Host')} to connect your private Vault.</p><div class="int-command"><code>gh auth login --web -p https</code><button type="button" class="icon-btn" data-action="copy" data-copy="gh auth login --web -p https" aria-label="Copy GitHub login command">${icon('copy')}</button></div>${intFacts([['Host',esc(host?.name||'Unavailable')],['GitHub login','Not checked']])}`,intButton('Check login','vault-login','','primary','refresh'));
 }
 if(state.vaultStage===1){
  return intPanel(`${intVaultSteps()}<div class="int-form-field"><label for="int-vault-repo">Private repository <span class="int-required">*</span></label><input id="int-vault-repo" data-int-vault="repo" value="${esc(d.vaultDraft?.repo??state.vaultRepo??'')}" placeholder="owner/factory-vault" autocomplete="off" spellcheck="false" aria-required="true" aria-describedby="int-vault-error"><small>Use owner/repository format.</small></div><p class="int-field-error" id="int-vault-error" role="alert" ${d.error?'':'hidden'}>${esc(d.error||'')}</p>${intFacts([['Host',esc(host?.name||'Unavailable')],['Branch',esc(state.vaultBranch)]])}`,intButton('Enable & sync','vault-enable','','primary','shield'));
 }
 const types=state.vaultKeyTypes||[];
 const items=types.map(type=>integrationKeyTypes[type]).filter(Boolean);
 return intPanel(`<div class="int-project-identity">${icon('git')}<div><strong>${esc(state.vaultRepo)}</strong><small>${esc(state.vaultBranch)}</small></div></div>${intFacts([['Sync',state.vaultSynced?'<span class="int-inline-status green">'+icon('check')+'Preview sync recorded</span>':'Not synced'],['Configuration','Lanes · Eye']])}<section class="int-key-inventory"><div><strong>Signing keys & credentials</strong>${intButton('Import key','vault-import','','ghost','plus')}</div>${items.length?`<ul>${items.map(item=>`<li>${icon(item.glyph)}<span>${item.label}</span><small>Metadata added</small></li>`).join('')}</ul>`:'<p>No key metadata added.</p>'}</section>${intDisclosure('Advanced',`<div class="int-settings-link"><span><strong>Repository settings</strong><small>Repository, branch and passphrase</small></span>${intButton('Edit','vault-settings','','ghost','settings')}</div>`)}`,intButton('Sync Vault','vault-sync','','primary','refresh'));
}
function intReadDraft(){
 const d=state.integrationDialog;if(!d)return;
 const read=(selector,key)=>{$$(selector,$('#modal-body')).forEach(input=>{d[key]=d[key]||{};d[key][input.dataset.intDraft||input.dataset.intImport||input.dataset.intVault]=input.value;});};
 read('[data-int-draft]','sourceDraft');read('[data-int-import]','importValues');read('[data-int-vault]','vaultDraft');
}
function paintIntegrationDialog(focus=false){
 const d=state.integrationDialog;if(!d||!$('#modal').open)return;
 const info=intHeaderInfo(),oldFocus=document.activeElement?.dataset?.intFocus;
 const body=d.kind==='paseo'?intPaseoBody():d.kind==='plugin'||d.view==='plugin'?intPluginBody():d.kind==='design'?intDesignBody():intVaultBody();
 $('#modal').classList.add('integration-dialog');
 $('#modal-title').innerHTML=`<span class="int-title-icon ${info.tone}">${icon(info.glyph)}</span><span class="int-title-name">${esc(info.title)}</span><span class="int-header-status ${info.status.tone}"><span class="dot"></span>${info.status.text}</span>`;
 $('#modal-body').innerHTML=body;
 if(focus){
  const selector=d.view==='import'?'#int-'+integrationKeyTypes[d.keyType].fields[0][0]:d.view==='vault-settings'?'#int-vault-repository':d.kind==='vault'&&state.vaultStage===1?'#int-vault-repo':oldFocus?'[data-int-focus="'+oldFocus+'"]':'[data-int-primary]';
  ($(selector,$('#modal-body'))||$('[data-int-primary]',$('#modal-body'))||$('#modal-title'))?.focus({preventScroll:true});
 }
}
function startIntegrationDialog(kind,pluginId=null){
 if(readonly()||!fleetOnline()){notify('Select a project on an online Host first.',true);return;}
 state.privateVaultDialog=false;state.openDesignDialog=false;
 state.integrationDialog={kind,pluginId,view:'main',scope:scopeKey(),hostId:activeHostId(),keyType:'asc',importValues:{},sourceDraft:null,vaultDraft:null,error:'',feedback:''};
 // Use the native dialog shell without the repeated Host/project banner.
 fleetOpenModalBefore('Integration','');paintIntegrationDialog(true);
}
showPrivateVault=function(){startIntegrationDialog('vault');};
showOpenDesign=function(){startIntegrationDialog('design');};
showPaseoDaemon=function(){startIntegrationDialog('paseo');};
managePlugin=function(id){if(state.plugins.some(plugin=>plugin.id===id))startIntegrationDialog('plugin',id);};
vaultImport=function(){startIntegrationDialog('vault');state.integrationDialog&&(state.integrationDialog.view='import');paintIntegrationDialog(true);};
function resetIntegrationDialog(){state.integrationDialog=null;$('#modal')?.classList.remove('integration-dialog');}
const integrationOpenBefore=openModal;
openModal=function(...args){resetIntegrationDialog();return integrationOpenBefore(...args);};
const integrationCloseBefore=closeModal;
closeModal=function(){resetIntegrationDialog();return integrationCloseBefore();};
const integrationRenderBefore=render;
render=function(){
 const d=state.integrationDialog;
 integrationRenderBefore();
 if(d&&d.scope!==scopeKey()){closeModal();return;}
 if(d)paintIntegrationDialog();
};
function intCommit(message){state.integrationDialog.feedback=message;state.integrationDialog.error='';render();paintIntegrationDialog(true);}
function intEnsureDesign(){
 let plugin=intDesignPlugin();
 if(!plugin){plugin={id:'design',name:'Open Design',tag:'COMPANION',description:'Design workspace, interactive mockups, and Owner approval.',enabled:true,installed:true,version:'local',protected:false};state.plugins.push(plugin);}
 else{plugin.installed=true;plugin.enabled=true;}
 intCommit('Plugin enabled in preview. No installation was performed.');
}
document.addEventListener('click',event=>{
 const control=event.target.closest('button[data-integration-action]');if(!control||control.disabled)return;
 const d=state.integrationDialog;if(!d)return;
 if(d.scope!==scopeKey()||d.hostId!==activeHostId()||readonly()||!fleetOnline()){closeModal();notify('The Host or project changed. Reopen this integration.',true);return;}
 intReadDraft();const action=control.dataset.integrationAction;
 const plugin=state.plugins.find(p=>p.id===d.pluginId);
 if(action==='close'){closeModal();return;}
 if(action==='back'){d.view='main';d.error='';d.feedback='';d.sourceDraft=null;paintIntegrationDialog(true);return;}
 if(action==='paseo-update'){
  if(state.paseoDaemon){
   state.paseoDaemon.version=state.paseoDaemon.latestVersion||'0.25.0';
   state.paseoDaemon.updateAvailable=false;
   log('Updated Paseo Daemon to v'+state.paseoDaemon.version,'','green','refresh');
  }
  intCommit('Paseo Daemon updated to v'+(state.paseoDaemon?.version||'0.25.0')+' in preview.');return;
 }
 if(action==='paseo-check'){
  intCommit('Paseo Daemon is up to date (v'+(state.paseoDaemon?.version||'0.25.0')+').');return;
 }
 if(action==='paseo-restart'){
  log('Restarted Paseo Daemon on '+(fleetHost()?.name||'Host'),'','cyan','refresh');
  intCommit('Daemon restart recorded in preview. Active worktrees preserved.');return;
 }
 if(action==='paseo-open-settings'){
  closeModal();openDaemonSettings(activeHostId());return;
 }
 if(action==='plugin-update'||action==='plugin-reload'||action==='plugin-install'){
  if(!plugin)return;
  if(action==='plugin-install'){plugin.installed=true;plugin.enabled=true;}
  if(action==='plugin-update'&&plugin.updateAvailable&&plugin.latestVersion){
   plugin.version=plugin.latestVersion;
   plugin.updateAvailable=false;
  }
  log('Preview '+plugin.name+': '+action.replace('plugin-',''));
  intCommit(action==='plugin-install'?'Marked installed in preview. No files were installed.':action==='plugin-reload'?'Reload recorded in preview. No process was restarted.':'Updated to v'+plugin.version+' in preview. No files were downloaded.');return;
 }
 if(action==='plugin-source'){
  if(!plugin)return;const source=d.sourceDraft?.source?.trim();
  if(!source){d.error='Enter a source repository, such as owner/repository.';paintIntegrationDialog();$('#int-plugin-source')?.focus();return;}
  plugin.customSource=source;plugin.sourceRef=d.sourceDraft?.ref?.trim()||'main';intCommit('Source saved for this preview. No checkout was changed.');return;
 }
 if(action==='plugin-canonical'){if(!plugin)return;delete plugin.customSource;delete plugin.sourceRef;d.sourceDraft=null;intCommit('Canonical source selected in preview.');return;}
 if(action==='plugin-toggle'){if(!plugin||plugin.protected)return;plugin.enabled=!plugin.enabled;intCommit('Plugin state changed in preview.');return;}
 if(action==='plugin-remove'){if(!plugin||plugin.protected)return;destructive('Remove companion?','Remove '+plugin.name+' from this preview.','plugin',plugin.id);return;}
 if(action==='design-enable'){intEnsureDesign();return;}
 if(action==='design-plugin'){d.view='plugin';d.pluginId='design';d.feedback='';d.error='';paintIntegrationDialog(true);return;}
 if(action==='design-link'){d.view='link';d.feedback='';paintIntegrationDialog(true);return;}
 if(action==='design-link-confirm'){state.linkedDesign=true;d.view='main';intCommit('Design project linked in preview. No local folder was accessed.');return;}
 if(action==='design-sync'){intCommit('Revision r3 retained in preview. No folder was read.');return;}
 if(action==='design-unlink'){state.linkedDesign=false;intCommit('Project link removed in preview.');return;}
 if(action==='design-review'||action==='design-studio'){review();return;}
 if(action==='vault-login'){state.vaultStage=1;intCommit('GitHub-ready state shown. No authentication was performed.');return;}
 if(action==='vault-enable'){
  const repo=d.vaultDraft?.repo?.trim()||'';
  if(!/^[^\s/]+\/[^\s/]+$/.test(repo)){d.error='Enter owner/repository, such as you/factory-vault.';paintIntegrationDialog(true);return;}
  state.vaultRepo=repo;state.vaultStage=2;state.vaultSynced=true;intCommit('Vault configured in preview. No repository was created.');return;
 }
 if(action==='vault-sync'){state.vaultSynced=true;intCommit('Sync recorded in preview. No keys or files were transmitted.');return;}
 if(action==='vault-import'){d.view='import';d.error='';d.feedback='';paintIntegrationDialog(true);return;}
 if(action==='key-type'){if(!integrationKeyTypes[control.dataset.keyType])return;d.keyType=control.dataset.keyType;d.error='';d.feedback='';paintIntegrationDialog(true);return;}
 if(action==='vault-import-save'){
  const type=integrationKeyTypes[d.keyType],required=type.fields.find(field=>field[3]);
  if(!d.importValues?.[required[0]]?.trim()){d.error='Enter the '+required[1].toLowerCase()+' to continue.';paintIntegrationDialog(true);return;}
  state.vaultKeyTypes=[...new Set([...(state.vaultKeyTypes||[]),d.keyType])];state.vaultImported=true;state.vaultSynced=true;d.importValues={};d.view='main';intCommit(type.label+' metadata added. No key file was read or uploaded.');return;
 }
 if(action==='vault-settings'){d.view='vault-settings';d.vaultDraft={repo:state.vaultRepo,branch:state.vaultBranch};d.error='';d.feedback='';paintIntegrationDialog(true);return;}
 if(action==='vault-settings-save'){
  const repo=d.vaultDraft?.repo?.trim()||'',branch=d.vaultDraft?.branch?.trim()||'';
  if(!/^[^\s/]+\/[^\s/]+$/.test(repo)||!branch){d.error='Enter owner/repository and a branch name.';paintIntegrationDialog(true);return;}
  state.vaultRepo=repo;state.vaultBranch=branch;d.view='main';intCommit('Vault settings saved in preview. The passphrase was not retained.');return;
 }
 if(action==='vault-hydrate'){intCommit('Recovery action recorded in preview. No GitHub API request was made.');}
});
document.addEventListener('keydown',event=>{
 if(event.key!=='Enter'||!state.integrationDialog||event.target.tagName!=='INPUT')return;
 if(!event.target.id?.startsWith('int-'))return;
 event.preventDefault();
 const source=event.target.id==='int-plugin-source'||event.target.id==='int-plugin-ref';
 $(source?'[data-integration-action="plugin-source"]':'[data-int-primary]',$('#modal-body'))?.click();
});
