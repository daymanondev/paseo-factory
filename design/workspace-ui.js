'use strict';
/* Connected workflow and structured management views. Uses the existing actions. */
state.skillPack='All';state.mcpFilter='all';state.mcpSearch='';state.expandedMcp=null;
let workflowResizeObserver,workflowFrame;
const LEAD_HANDOFF_TOKENS=128000;
// Illustrative telemetry only. Runtime rotation state is distinct from context usage.
state.leadTelemetry={contextUsedTokens:42000,rotationState:'normal',queuedMailCount:2,sessionId:'sample-lead-03',lastHandoff:null};
function leadHandoffState(){
 const source=state.project!=='all'&&(!state.hosts||state.hosts.some(host=>host.id===activeHostId()&&host.status==='online'))&&!state.emptyProjects?.has(scopeKey())&&!state.retiredSeats?.has(scopeKey()+':lead')?state.leadTelemetry:null;
 const tokens=source&&Number.isFinite(source.contextUsedTokens)&&source.contextUsedTokens>=0?source.contextUsedTokens:null;
 const rotation=source?.rotationState;
 const percent=tokens===null?null:Math.round(tokens/LEAD_HANDOFF_TOKENS*100);
 let label='Status unavailable',tone='muted',note='No Lead telemetry is available for this workspace.';
 if(rotation==='handing_over'){label='Handing over';tone='cyan';note='Lead is extracting its handoff and preparing a successor. New mailbox messages stay queued.';}
 else if(rotation==='rotation_pending'){label='Waiting for turn boundary';tone='amber';note='Handoff is pending. The current turn must finish before Lead can hand over.';}
 else if(rotation==='normal'){
  label=tokens!==null&&tokens>=LEAD_HANDOFF_TOKENS?'Handoff mark reached':percent!==null&&percent>=80?'Nearing handoff mark':'Normal';
  tone=percent!==null&&percent>=80?'amber':'green';
  note=tokens!==null&&tokens>=LEAD_HANDOFF_TOKENS?'Context has reached 128k. The reported rotation state is still Normal; handoff has not started.':'Handoff mark: 128k context. The rotation state confirms when handoff actually starts.';
 }
 const queued=source&&Number.isInteger(source.queuedMailCount)&&source.queuedMailCount>=0?source.queuedMailCount:null;
 return {label,tone,note,tokens,percent,queued,rotation,session:source?.sessionId||null,lastHandoff:source?.lastHandoff||null};
}
function leadHandoffMeter(data){return `<div class="lead-context-meter"><div class="lead-context-label"><span>Context used</span><strong>${data.tokens===null?'Unavailable':Math.round(data.tokens/1000)+'k / 128k'}</strong></div>${data.tokens===null?'':`<progress max="${LEAD_HANDOFF_TOKENS}" value="${Math.min(LEAD_HANDOFF_TOKENS,data.tokens)}" aria-label="Lead context toward 128k handoff mark">${Math.min(100,data.percent)}%</progress>`}</div>`;}
function leadHandoffDetails(){
 const data=leadHandoffState();
 const label=data.rotation==='handing_over'?'Handoff':data.rotation==='rotation_pending'?'Pending':data.tokens!==null&&data.percent>=80?'Near limit':data.rotation==='normal'?'Normal':'Unavailable';
 return `<details class="drawer-disclosure drawer-handoff ${data.tone}" ${drawerDisclosureAttrs('handoff')}><summary><span class="drawer-section-label drawer-context-label">${icon('refresh')}<span>Context</span></span><strong>${data.tokens===null?'Unavailable':Math.round(data.tokens/1000)+'k / 128k'}</strong><span class="drawer-handoff-label">${label}</span><span class="drawer-queue">${data.queued===null?'Mailbox unknown':data.queued+' queued'}</span>${icon('chevron')}</summary><div class="drawer-disclosure-content">${leadHandoffMeter(data)}<p class="drawer-copy">${esc(data.note)}</p><dl class="data-list"><div><dt>Rotation</dt><dd>${esc(data.label)}</dd></div><div><dt>Last handoff</dt><dd>${esc(data.lastHandoff||'No event recorded in this sample')}</dd></div></dl></div></details>`;
}

const workspaceShellBefore=syncShell;
const workspaceAgentBefore=agent;
agent=function(id){const value=workspaceAgentBefore(id);if(id==='gate'&&mode()==='scrum'&&!state.emptyProjects?.has(scopeKey())&&state.designDecision&&state.designDecision!=='changes'&&workspaceAgentBefore('architect').status!=='completed')value.status='waiting';return value;};
syncShell=function(){
 workspaceShellBefore();
 if(state.page==='flow')$('.page-heading').outerHTML='<div class="page-heading" hidden></div>';

 const theme=$('meta[name="theme-color"]');if(theme)theme.content='#0d1015';
};
function agentIsWorking(id,status=agent(id).status){
 return status==='running'&&(id!=='lead'||!['handing_over','rotation_pending'].includes(leadHandoffState().rotation));
}
function agentActivityMark(id,status=agent(id).status){
 return agentIsWorking(id,status)?'<span class="agent-working-bars cyan" aria-hidden="true"><i></i><i></i><i></i></span>':`<span class="dot ${statusTone(status)}" aria-hidden="true"></span>`;
}
function flowCard(id,key=id,overrides={}){
 const a=agent(id),t=scopedTasks().find(item=>item.id===a.task),status=overrides.status||a.status;
 const name=overrides.name||(id==='lead'&&mode()==='scrum'?'Scrum Lead / PO':a.short||a.name);
 const subtitle=overrides.subtitle||(id==='owner'?'Product decisions':id==='supervisor'?'Authority & oversight':id==='lead'?'Coordination & dispatch':a.subtitle);
 const labels={running:'Working',completed:'Completed',attention:'Needs you',waiting:'Waiting for approval',queued:'Waiting',idle:'Available'};
 const gateLabel=id==='gate'&&mode()==='scrum'&&state.designDecision&&state.designDecision!=='changes'&&status==='waiting'?'Readiness pending':null;
 const label=overrides.label||(id==='lead'&&['rotation_pending','handing_over'].includes(leadHandoffState().rotation)?leadHandoffState().label:null)||gateLabel||(id==='owner'?'Owner':labels[status]||statusLabel(status));
 const action=overrides.action?`data-action="${overrides.action}"`:overrides.nav?`data-nav="${overrides.nav}"`:`data-agent="${id}"`;
 return `<button class="flow-node ${status} ${state.inspector&&state.selected===id&&!overrides.action&&!overrides.nav?'selected':''}" data-flow-id="${key}" data-agent-working="${agentIsWorking(id,status)}" ${action} aria-label="${esc(name)}: ${esc(label)}" ${!overrides.action&&!overrides.nav?`aria-pressed="${state.inspector&&state.selected===id}"`:''}><span class="node-top">${botAvatar(id)}<span class="od-field od-fill"><strong class="node-title">${esc(name)}</strong><span class="node-subtitle">${esc(subtitle)}</span></span></span><span class="node-bottom ${statusTone(status)}">${agentActivityMark(id,status)}<span>${esc(label)}</span>${t&&!overrides.action&&!overrides.nav?`<span class="node-task">${esc(t.id)}</span>`:''}</span></button>`;
}
function flowAuthority(){return `<div class="connected-authority">${flowCard('owner')}${flowCard('supervisor')}${flowCard('lead')}</div>`;}
function workspaceQuickLinks(){return `<div class="workspace-shortcuts"><h1 class="sr-only">Workspace workflow</h1><div class="workspace-mode-tools">${modeControls()}</div><span class="spacer"></span><button type="button" data-workspace-destination="models">${icon('agents')}Agents & Models</button><button type="button" data-workspace-destination="skills">${icon('code')}Skills</button><button type="button" data-workspace-destination="mcps">${icon('plug')}MCP</button></div>`;}
function skillMatchesRole(skill,role){if(!role)return true;const roles=skill.role.split(' · ');return roles.includes(role)||(role==='Peer'&&roles.includes('Dev'));}
function slpAuthorityPeerIds(){return [...new Set(scopedTasks().filter(task=>task.mode==='slp'&&['running','attention','ready'].includes(task.status)&&task.agent?.startsWith('peer-')).map(task=>task.agent))];}
function connectedScrum(){return `<div class="connected-canvas graph-canvas" id="graph-canvas" data-flow-mode="scrum"><svg class="workflow-wires" aria-hidden="true"></svg>${flowAuthority()}<div class="connected-flow"><div class="connected-stage"><div class="stage-caption"><b>1</b> Planning</div>${flowCard('pm')}</div><div class="connected-stage duet"><div class="stage-caption"><b>2</b> Design ∥ Architecture</div>${flowCard('ux')}${flowCard('architect')}</div><div class="connected-stage"><div class="stage-caption"><b>3</b> Readiness</div>${flowCard('gate','gate',{name:'Readiness & UI Gate',subtitle:'Artifacts & Owner decision'})}</div><div class="connected-stage"><div class="stage-caption"><b>4</b> Delivery</div>${flowCard('dev')}</div><div class="connected-stage"><div class="stage-caption"><b>5</b> Verification</div>${flowCard('qa')}</div></div><div class="wire-status"><span>${icon('git')} Supervisor → Lead → specialist execution</span><span>${icon('refresh')} QA → Dev fix loop · ${state.fixRounds}/${state.qaAllowance} rounds</span></div></div>`;}
function connectedSlp(){return renderSlpWorkflow();}
const connectedFlowFallback=renderFlow;
renderFlow=function(){
 state.graphTab='workflow';
 if(readonly()||(mode()!=='slp'&&typeof renderScrumWorkflow!=='function'&&state.emptyProjects?.has(scopeKey())))return workspaceQuickLinks()+connectedFlowFallback();
 return `${workspaceQuickLinks()}${stats()}<div class="workflow-split"><div><section class="journey-panel"><div class="journey-head"><div><h2>${mode()==='scrum'?'Agile Scrum workflow':'SLP workflow'}</h2></div></div><div class="workflow-viewport">${mode()==='scrum'?connectedScrum():connectedSlp()}</div><div class="graph-footer"><div class="legend"><span><i class="dot cyan"></i>Working</span><span><i class="dot green"></i>Completed</span><span><i class="dot amber"></i>Needs you</span><span><i class="dot muted"></i>Waiting</span></div><div class="graph-controls"><button data-action="zoom-out" aria-label="Zoom out">${icon('minus')}</button><span class="zoom">${state.zoom}%</span><button data-action="zoom-in" aria-label="Zoom in">${icon('plus')}</button><button data-action="fit" aria-label="Fit workflow">${icon('fit')}</button></div></div></section>${teamCheckIn()}</div></div>`;
};
function drawWorkflow(){
 const canvas=$('.connected-canvas'),svg=canvas&&$('.workflow-wires',canvas);if(!canvas||!svg)return;
 if(canvas.dataset.flowMode==='scrum'&&typeof drawScrumWorkflow==='function'){drawScrumWorkflow(canvas,svg);return;}
 if(canvas.dataset.flowMode==='slp'&&typeof drawSlpWorkflow==='function'){canvas.style.setProperty('--slp-zoom',state.zoom);drawSlpWorkflow(canvas,svg);return;}
 const bounds=canvas.getBoundingClientRect();if(bounds.width<1)return;
 const mobile=window.matchMedia('(max-width:767px)').matches;
 const point=(id,side)=>{const element=$(`[data-flow-id="${id}"]`,canvas);if(!element)return null;const r=element.getBoundingClientRect();const x=r.left-bounds.left,y=r.top-bounds.top;return {x:side==='left'?x:side==='right'?x+r.width:x+r.width/2,y:side==='top'?y:side==='bottom'?y+r.height:y+r.height/2};};
 const colors={neutral:'#98acc5',done:'#91ddad',active:'#62d9ef',wait:'#ffd17e',future:'#7f94ad'};
 const paths=[];
 const add=(d,tone='neutral',dashed=false,from='',to='')=>paths.push(`<path class="edge" data-wire-from="${from}" data-wire-to="${to}" d="${d}" stroke="${colors[tone]}" ${dashed?'stroke-dasharray="5 5"':''} marker-end="url(#flow-arrow-${tone})"/>`);
 const connect=(from,to,tone='neutral',dashed=false,vertical=mobile)=>{
  const a=point(from,vertical?'bottom':'right'),b=point(to,vertical?'top':'left');if(!a||!b)return;
  if(vertical){const bend=Math.max(18,Math.abs(b.y-a.y)/2);add(`M${a.x},${a.y} C${a.x},${a.y+bend} ${b.x},${b.y-bend} ${b.x},${b.y}`,tone,dashed,from,to);}
  else{const bend=Math.max(14,Math.abs(b.x-a.x)*.5);add(`M${a.x},${a.y} C${a.x+bend},${a.y} ${b.x-bend},${b.y} ${b.x},${b.y}`,tone,dashed,from,to);}
 };
 connect('owner','supervisor');connect('supervisor','lead','active');
 if(canvas.dataset.flowMode==='scrum'){
  const a=point('lead','bottom'),b=point('pm','left');if(a&&b){const left=12,channel=a.y+25;add(`M${a.x},${a.y} V${channel-8} Q${a.x},${channel} ${a.x-8},${channel} H${left+8} Q${left},${channel} ${left},${channel+8} V${b.y-8} Q${left},${b.y} ${left+8},${b.y} H${b.x}`,'active',false,'lead','pm');}
  connect('pm','ux','done');connect('pm','architect','done');connect('ux','gate','wait');connect('architect','gate','active');connect('gate','dev','future',true);connect('dev','qa','future',true);
  if(mobile){const a=point('qa','right'),b=point('dev','right'),right=bounds.width-12;if(a&&b)add(`M${a.x},${a.y} H${right-8} Q${right},${a.y} ${right},${a.y-8} V${b.y+8} Q${right},${b.y} ${right-8},${b.y} H${b.x}`,'future',true,'qa','dev');}
  else{const a=point('qa','bottom'),b=point('dev','bottom');if(a&&b){const y=Math.max(a.y,b.y)+28;add(`M${a.x},${a.y} V${y-8} Q${a.x},${y} ${a.x-8},${y} H${b.x+8} Q${b.x},${y} ${b.x},${y-8} V${b.y}`,'future',true,'qa','dev');}}
 }
 if(canvas.dataset.flowMode==='slp'){
  for(const id of ['peer-1','peer-2','peer-3']){
   if(mobile){const a=point('lead','bottom'),b=point(id,'left'),left=12;if(a&&b)add(`M${a.x},${a.y} V${a.y+18} H${left} V${b.y} H${b.x}`,'active',false,'lead',id);}
   else connect('lead',id,'active',false,true);
  }
  for(const id of ['peer-1','peer-2','peer-3']){
   const tone=agent(id).status==='completed'?'done':'neutral';
   if(mobile){const a=point(id,'right'),b=point('verification','right'),right=bounds.width-12;if(a&&b)add(`M${a.x},${a.y} H${right} V${b.y} H${b.x}`,tone,false,id,'verification');}
   else connect(id,'verification',tone,false,true);
  }
  connect('verification','acceptance','done');
 }
 svg.setAttribute('viewBox',`0 0 ${bounds.width} ${bounds.height}`);svg.setAttribute('preserveAspectRatio','none');
 svg.innerHTML=`<defs>${Object.entries(colors).map(([name,color])=>`<marker id="flow-arrow-${name}" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0 L7 3.5 L0 7 Z" fill="${color}"/></marker>`).join('')}</defs>${paths.join('')}`;
}
function queueWorkflow(){cancelAnimationFrame(workflowFrame);workflowFrame=requestAnimationFrame(drawWorkflow);}
const connectedRenderBefore=render;
render=function(){connectedRenderBefore();if(workflowResizeObserver)workflowResizeObserver.disconnect();const canvas=$('.connected-canvas');if(canvas&&typeof ResizeObserver!=='undefined'){workflowResizeObserver=new ResizeObserver(queueWorkflow);workflowResizeObserver.observe(canvas);}queueWorkflow();};
window.addEventListener('resize',queueWorkflow);
if(document.fonts?.ready)document.fonts.ready.then(queueWorkflow);
renderIntegrations=function(){const tabs=[['plugins','Plugins & tools','plug',state.plugins.length],['skills','Skills','code',state.skills.filter(s=>s.installed).length],['mcps','MCP servers','git',state.mcps.length]];return `<div class="integration-tabs" aria-label="Integration categories">${tabs.map(([id,title,glyph,count])=>`<button class="integration-tab ${state.integrationTab===id?'active':''}" data-integration-tab="${id}" aria-pressed="${state.integrationTab===id}">${icon(glyph)}<span>${title}</span><span class="nav-count">${count}</span></button>`).join('')}</div>${state.integrationTab==='skills'?renderSkills():state.integrationTab==='mcps'?renderMcps():renderPlugins()}`;};
function skillDescription(skill){return ({'code-review':'Standards and acceptance review','frontend-design':'Interface craft and visual direction','domain-modeling':'Shared terminology and architecture decisions','tdd':'Test-first development and verification','expo-overview':'Expo project setup and native development'})[skill.name]||'Project skill';}
function skillRow(skill,host=false){return `<article class="skill-row"><div class="skill-name"><span class="skill-symbol">${icon(skill.pack==='Workflow'?'design':skill.pack==='Expo'?'agents':'code')}</span><div class="od-fill"><strong>${esc(skill.name)}</strong><p>${esc(skillDescription(skill))}</p><p>${esc(skill.pack)} · Factory sample catalogue</p></div></div><div class="skill-role">${esc(skill.role)}</div><div class="skill-state">${badge(host?'On host':skill.installed?'Installed':'Not installed',skill.installed?'green':'')}</div>${host?button('Import','import-skill',`data-skill="${esc(skill.name)}" ${readonly()?'disabled':''}`):`<button class="text-btn" data-ui="skill-detail" data-skill="${esc(skill.name)}">Details</button>`}</article>`;}
renderSkills=function(){
 const installed=state.skills.filter(s=>s.installed),pack=state.skillPack||'All';
 const match=s=>(pack==='All'||s.pack===pack)&&skillMatchesRole(s,state.skillRole)&&(!state.search||(s.name+' '+s.pack+' '+skillDescription(s)).toLowerCase().includes(state.search.toLowerCase()));
 const items=state.skills.filter(s=>(state.skillTab==='host'?!s.installed:s.installed)&&match(s));
 const packNames=['All','Core','Workflow','Expo','Firebase','3D/ZCode','Science'];
 const packCanEnable=!['All','Core','Workflow'].includes(pack);
 const sidebar=`<aside class="catalog-sidebar" aria-label="Filter skill packs"><h3>Skill packs</h3>${packNames.map(name=>`<button class="pack-filter ${pack===name?'active':''}" data-ui="skill-pack" data-pack-name="${name}" aria-pressed="${pack===name}"><span>${name}</span><span class="pack-count">${installed.filter(s=>name==='All'||s.pack===name).length}</span></button>`).join('')}</aside>`;
 const tabs=`<div class="catalog-subtabs">${[['installed','Installed in Factory'],['host','Available on host'],['matrix','Role ↔ Skill Matrix']].map(([id,label])=>`<button class="tab ${state.skillTab===id?'active':''}" data-skill-tab="${id}">${label}</button>`).join('')}</div>`;
 let body;
 if(state.skillTab==='matrix'){
  const roleRows=[['SLP','Supervisor'],['SLP','Lead'],['SLP','Peer'],['Scrum','PM'],['Scrum','UX'],['Scrum','Architect'],['Scrum','Dev'],['Scrum','QA']];
  body=`<div class="table-wrap"><table class="matrix-table"><thead><tr><th>Role</th><th>Assigned skills</th><th>Task additions</th></tr></thead><tbody>${roleRows.map(([model,role])=>{const skills=installed.filter(s=>match(s)&&(s.role.includes(role)||(model==='SLP'&&['Lead','Peer'].includes(role)&&s.role.includes('Dev'))));return `<tr><td><strong>${role}</strong><div class="small muted" style="font-size:11px">${model}</div></td><td>${skills.map(s=>badge(s.name)).join(' ')||'<span class="muted">No matching role skills</span>'}</td><td class="muted">Defined in each Contract</td></tr>`;}).join('')}</tbody></table></div>`;
 }else body=`<div class="skill-columns"><span>Skill & source</span><span>Used by</span><span>Status</span><span></span></div>${items.map(s=>skillRow(s,state.skillTab==='host')).join('')||`<div class="empty"><h3>${state.skillTab==='host'?'No matching host skills':'No matching installed skills'}</h3><p>${pack==='All'?'Try a different search.':'Choose another pack or enable this pack for the project.'}</p></div>`}`;
 return `<div class="catalog-toolbar"><span class="management-count">${installed.length} installed · ${state.skills.filter(s=>!s.installed).length} available</span><div class="catalog-actions">${button('Update skills','update-skills',readonly()?'disabled':'','','refresh')}${button('Heal links','heal-skills',readonly()?'disabled':'','ghost')}</div></div><div class="catalog-layout">${sidebar}<div class="catalog-content"><section class="catalog-section"><div class="catalog-section-head"><div><h3>${pack==='All'?'All skills':pack+' skills'}</h3><p>${state.skillTab==='host'?'Import selected skills into Factory.':'Keep the right capabilities close to each role.'}</p></div><div class="catalog-search">${icon('search')}<label class="sr-only" for="skill-search">Search skills</label><input id="skill-search" placeholder="Search skills…" value="${esc(state.search)}"></div></div>${packCanEnable?`<div class="catalog-pack-summary"><div class="od-fill"><strong class="small">${pack} project pack</strong><p>${state.linkedPacks.includes(pack)?'Enabled for the selected project.':'Available as a project-scoped pack.'}</p></div>${button(state.linkedPacks.includes(pack)?'Enabled — disable':'Enable for Project','toggle-pack',`data-pack="${pack}" ${readonly()?'disabled':''}`)}</div>`:''}${tabs}${body}</section><div class="catalog-note">Role-wide skills apply to the selected roster. Task-specific requirements remain attached to their Contract. This preview does not inspect or modify host skill files.</div></div></div>`;
};
function mcpRow(m,index){
 const healthy=m.health==='Sample connected',attention=['Auth Expired','Missing Key','Unreachable'].includes(m.health),tone=healthy?'green':attention?'amber':'muted';
 const health=healthy?'Connected':m.health;
 return `<article class="mcp-server-card" aria-label="${esc(m.name)} MCP server"><header class="mcp-card-header"><span class="mcp-card-symbol">${icon(m.name==='GitHub'?'git':'code')}</span><div class="mcp-card-identity"><h3>${esc(m.name)}</h3><small>${esc(m.transport)}</small></div><button type="button" class="icon-btn mcp-card-probe" data-ui="mcp-probe" data-mcp-index="${index}" data-mcp-focus="probe-${index}" aria-label="Check connection for ${esc(m.name)}" title="Check connection" ${readonly()?'disabled':''}>${icon('refresh')}</button></header><div class="mcp-card-status"><span class="mcp-card-health ${tone}"><span class="dot"></span>${esc(health)}</span><span class="mcp-card-sync-state ${m.synced?'cyan':'muted'}">${icon(m.synced?'plug':'host')}${m.synced?'Synced':'On Host'}</span></div><div class="mcp-card-targets" role="group" aria-label="Agent access for ${esc(m.name)}">${['Pi','Claude','Codex','OpenCode'].map(target=>{const selected=m.targets.includes(target);return `<button type="button" class="mcp-card-target ${selected&&m.synced?'selected':''}" data-action="mcp-target" data-mcp="${index}" data-target="${target}" data-mcp-focus="target-${index}-${target}" aria-pressed="${selected&&m.synced}" ${!m.synced||readonly()?'disabled':''}>${icon(selected&&m.synced?'check':'plus')}<span>${target}</span></button>`;}).join('')}</div><footer class="mcp-card-actions"><button type="button" class="mcp-card-vault ${m.vault&&m.synced?'enabled':''}" data-action="mcp-vault" data-mcp="${index}" data-mcp-focus="vault-${index}" role="switch" aria-label="Vault sync for ${esc(m.name)}" aria-checked="${m.vault&&m.synced}" ${!m.synced||readonly()?'disabled':''}>${icon('shield')}<span>Vault</span><small>${m.vault&&m.synced?'On':'Off'}</small></button><button type="button" class="mcp-card-sync ${m.synced?'synced':''}" data-action="mcp-sync" data-mcp="${index}" data-mcp-focus="sync-${index}" ${readonly()?'disabled':''}>${icon(m.synced?'minus':'plus')}<span>${m.synced?'Unsync':'Sync'}</span></button></footer></article>`;
}
renderMcps=function(){
 const synced=state.mcps.filter(m=>m.synced),attention=state.mcps.filter(m=>['Auth Expired','Missing Key','Unreachable'].includes(m.health));
 const filters=[['all','All',state.mcps.length],['synced','Synced',synced.length],['host','On Host',state.mcps.filter(m=>!m.synced).length],['attention','Attention',attention.length]];
 const visible=state.mcps.map((m,index)=>({m,index})).filter(({m})=>(state.mcpFilter==='all'||state.mcpFilter==='synced'&&m.synced||state.mcpFilter==='host'&&!m.synced||state.mcpFilter==='attention'&&attention.includes(m))&&(!state.mcpSearch||m.name.toLowerCase().includes(state.mcpSearch.toLowerCase())));
 return `<div class="mcp-controls"><div class="mcp-filter-tabs" role="group" aria-label="Filter MCP servers">${filters.map(([id,name,count])=>`<button type="button" class="mcp-filter-tab ${state.mcpFilter===id?'selected':''} ${id==='attention'?'attention':''}" data-ui="mcp-filter" data-mcp-filter="${id}" aria-pressed="${state.mcpFilter===id}"><span>${name}</span><small>${count}</small></button>`).join('')}</div><div class="mcp-toolbar-actions"><div class="mcp-card-search">${icon('search')}<label class="sr-only" for="mcp-search">Search MCP servers</label><input id="mcp-search" placeholder="Search servers…" value="${esc(state.mcpSearch)}"></div><button type="button" class="btn ghost" data-action="probe-mcps" aria-label="Check connectivity for all MCP servers" ${readonly()?'disabled':''}>${icon('refresh')}Check all</button></div></div>${visible.length?`<div class="mcp-card-grid">${visible.map(({m,index})=>mcpRow(m,index)).join('')}</div>`:'<div class="mcp-card-empty"><h3>No matching servers</h3><p>Clear the search or choose another filter.</p></div>'}`;
};
renderPlugins=function(){
 const missing=state.plugins.filter(p=>p.protected&&!p.installed);
 return `${missing.length?`<div class="notice amber"><h3>Required setup is incomplete</h3><p>${missing.length} required components are missing.</p>${button('Install Required Skills & Tools','install-required',readonly()?'disabled':'','primary')}</div>`:''}<div class="catalog-toolbar"><span class="management-count">${state.plugins.filter(p=>p.installed&&p.enabled).length} active</span>${button('Check for updates','check-updates','','','refresh')}</div><div class="plugin-list">${state.plugins.filter(p=>p.id!=='design').map(p=>`<article class="plugin-row"><span class="server-mark">${icon(p.id==='core'?'flow':p.id==='design'?'design':'shield')}</span><div><h3>${esc(p.name)}</h3><p>${esc(p.description)}</p><div class="plugin-meta">${p.tag==='CORE'?'Core':p.tag==='REQUIRED TOOL'?'Required tool':'Companion'} · ${esc(p.version)} · ${esc(p.id)}</div></div><div class="plugin-status">${badge(p.installed?p.enabled?'Running':'Disabled':'Not installed',p.installed&&p.enabled?'green':'')}${p.protected?'<small>Protected component</small>':'<small>Project companion</small>'}</div>${button(p.installed?'Manage':'Install','manage-plugin',`data-plugin="${p.id}" ${readonly()?'disabled':''}`,'ghost')}</article>`).join('')}</div>`;
};
renderModels=function(){
 const ids=mode()==='scrum'?['supervisor','lead','pm','ux','architect','dev','qa','watch']:['supervisor','lead','dev','watch'];
 const tiers=mode()==='scrum'?['Authority','Coordinator','Planning','Design','Design','Delivery','Verification','Feedback']:['Authority','Coordinator','Coding workhorse','Feedback'];
 const profiles=state.profiles.filter(p=>p.mode===mode());
 const profileMenu=`<details class="model-profile-picker"><summary>${icon('folder')}<span>${esc(state.profile||'Profiles')}</span>${icon('chevron')}</summary><div class="model-profile-menu" aria-label="Model profiles">${profiles.length?profiles.map(p=>`<button type="button" class="model-profile-option ${state.profile===p.name?'selected':''}" data-action="apply-profile" data-profile="${esc(p.name)}" ${readonly()?'disabled':''}><span>${esc(p.name)}</span>${state.profile===p.name?icon('check'):''}</button>`).join(''):'<p>No saved profiles</p>'}<div class="model-profile-actions">${button('Save profile…','save-profile',readonly()?'disabled':'','ghost','plus')}${button('Reset defaults','reset-lanes',readonly()?'disabled':'','ghost','refresh')}</div></div></details>`;
 return `<div class="model-settings-toolbar">${modeControls()}<span class="model-roster-note">${mode()==='scrum'?'r3 · edits apply next run':'Project lanes'}</span><span class="spacer"></span>${profileMenu}${mode()==='scrum'?`<div class="model-approval-control"><span id="model-approval-label">UI approval</span><button class="switch ${state.approval?'on':''}" role="switch" aria-checked="${state.approval}" aria-labelledby="model-approval-label" data-action="toggle-approval" ${readonly()?'disabled':''}></button></div>`:''}</div><div class="panel table-wrap"><table class="roster-table"><thead><tr><th>Role</th><th>Provider & model</th><th class="roster-thinking">Thinking</th><th>Configuration</th></tr></thead><tbody>${ids.map((id,i)=>{const a=agent(id),c=laneConfig(id);return `<tr><td><div class="role-cell">${botAvatar(id)}<div><strong>${id==='dev'&&mode()==='slp'?'Default Worker':esc(a.name)}</strong><small>${tiers[i]}</small></div></div></td><td class="model-cell"><strong>${esc(c.model)}</strong><small>${esc(c.provider)}</small></td><td class="roster-thinking">${badge(c.thinking)}</td><td><div class="od-row" style="flex-wrap:wrap">${button('Configure','configure',`data-role="${id}" ${readonly()?'disabled':''}`,'ghost')}${['supervisor','lead'].includes(id)?button(id==='lead'?'Rotate':'Revoke','retire-seat',`data-role="${id}" ${readonly()?'disabled':''}`,'ghost'):''}</div></td></tr>`;}).join('')}</tbody></table></div>`;
};
document.addEventListener('click',event=>{
 const control=event.target.closest('button[data-ui]');if(!control||control.disabled)return;
 const action=control.dataset.ui;
 if(action==='skill-pack'){state.skillPack=control.dataset.packName;render();$(`[data-pack-name="${state.skillPack}"]`)?.focus({preventScroll:true});}
 if(action==='skill-detail'){
  const skill=state.skills.find(s=>s.name===control.dataset.skill);if(!skill)return;
  openModal(skill.name,`<div class="od-row">${badge(skill.pack)}${badge(skill.installed?'Installed':'Available on host',skill.installed?'green':'')}</div><p style="margin-top:20px">${esc(skillDescription(skill))}</p><dl class="data-list"><div><dt>Used by</dt><dd>${esc(skill.role)}</dd></div><div><dt>Source</dt><dd>Factory sample catalogue</dd></div><div><dt>Revision</dt><dd>Not connected to host</dd></div><div><dt>Task-level use</dt><dd>Defined by the Contract</dd></div></dl><div class="dialog-actions">${!skill.installed?button('Import to Factory','import-skill',`data-skill="${esc(skill.name)}" ${readonly()?'disabled':''}`,'primary'):button('Close','close-modal','','primary')}</div>`);
 }
 if(action==='mcp-filter'){state.mcpFilter=control.dataset.mcpFilter;render();$(`[data-mcp-filter="${state.mcpFilter}"]`)?.focus({preventScroll:true});}
 if(action==='mcp-probe'){const index=Number(control.dataset.mcpIndex),server=state.mcps[index];if(!server||readonly())return;server.health=server.synced?'Sample connected':'Not synced';render();notify('Preview connection status updated. No server was contacted.');}
 if(action==='mcp-inspect'){const index=Number(control.dataset.mcpIndex);state.expandedMcp=state.expandedMcp===index?null:index;render();$(`[data-mcp-index="${index}"]`)?.focus({preventScroll:true});}
});
document.addEventListener('input',event=>{if(event.target.id==='mcp-search'){const pos=event.target.selectionStart;state.mcpSearch=event.target.value;render();const replacement=$('#mcp-search');replacement?.focus({preventScroll:true});replacement?.setSelectionRange(pos,pos);}});
document.addEventListener('click',event=>{const control=event.target.closest('button[data-action="import-skill"]');if(control?.closest('#modal'))closeModal();},true);

/* Tasks are a working list first; the board is an optional alternate view. */
state.taskView='list';state.collapsedTaskGroups=[];
shapes.list='<path d="M9 6h12M9 12h12M9 18h12"/><circle cx="3" cy="6" r="1"/><circle cx="3" cy="12" r="1"/><circle cx="3" cy="18" r="1"/>';
shapes.more='<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>';
const taskGroupOrder=['attention','ready','running','queued','accepted'];
function taskGate(task){const verdict=task.attempts.at(-1);return {label:verdict==='green'?'Green':verdict==='red'?'Red':verdict==='open'?'Running':'Pending',tone:verdict==='green'?'green':verdict==='red'?'red':verdict==='open'?'cyan':'muted',icon:verdict==='green'?'check':verdict==='red'?'alert':verdict==='open'?'activity':'minus'};}
function taskGateLabel(task){const gate=taskGate(task);return `<span class="task-gate ${gate.tone}">${icon(gate.icon)}<span>${gate.label}</span></span>`;}
function taskRow(task){
 const a=agent(task.agent),canAccept=task.status==='ready'&&task.attempts.at(-1)==='green';
 return `<article class="task-list-row ${task.status}" aria-label="${esc(task.id)}: ${esc(task.title)}"><button class="task-name-button" data-action="task" data-task="${task.id}" data-task-open="${task.id}"><span class="task-code">${task.id}</span><span class="task-name-content"><strong>${esc(task.title)}</strong>${readonly()?`<span class="task-project-name">${esc(task.project)} · ${task.mode==='scrum'?'Scrum':'SLP'}</span>`:''}${task.blocker?`<span class="task-blocker">${icon('alert')}${esc(task.blocker)}</span>`:''}</span></button><button class="task-assignee" data-paseo-attempt-open="sessionUrl" ${paseoAttemptAttrs(task,task.attempts.length-1)} ${task.attempts.length?'':'disabled'} aria-label="Open ${esc(a.name)} in Paseo">${botAvatar(task.agent)}<span>${esc(task.role)}</span></button><span class="task-gate-cell">${taskGateLabel(task)}</span><span class="task-attempt-cell" aria-label="${task.attempts.length} attempts">${attemptTrail(task)}</span><span class="task-cost">${task.cost?money(task.cost):'—'}</span><span class="task-row-actions">${canAccept?`<button class="task-accept" data-action="accept" data-task="${task.id}" ${readonly()?'disabled':''}>${icon('check')}Accept</button>`:task.status==='accepted'?`<span class="task-accepted">${icon('check')}</span>`:''}<details class="task-row-menu"><summary aria-label="More actions for ${task.id}">${icon('more')}</summary><div>${button('Task details','task',`data-task="${task.id}"`,'ghost','tasks')}${paseoAttemptActions(task,task.attempts.length-1,true)}</div></details></span></article>`;
}
function compactTaskCard(task){const canAccept=task.status==='ready'&&task.attempts.at(-1)==='green';return `<article class="compact-task ${task.status}"><button class="compact-task-title" data-action="task" data-task="${task.id}" data-task-open="${task.id}"><span class="task-code">${task.id}</span><strong class="od-clamp-2">${esc(task.title)}</strong></button>${task.blocker?`<div class="compact-task-blocker">${icon('alert')}Owner decision needed</div>`:''}<div class="compact-task-foot"><button class="task-assignee" data-paseo-attempt-open="sessionUrl" ${paseoAttemptAttrs(task,task.attempts.length-1)} ${task.attempts.length?'':'disabled'} aria-label="Open ${esc(agent(task.agent).name)} in Paseo">${botAvatar(task.agent)}<span>${esc(task.role)}</span></button>${taskGateLabel(task)}<span class="spacer"></span><details class="task-row-menu"><summary aria-label="More actions for ${task.id}">${icon('more')}</summary><div>${paseoAttemptActions(task,task.attempts.length-1,true)}</div></details>${canAccept?`<button class="task-accept" data-action="accept" data-task="${task.id}" ${readonly()?'disabled':''}>${icon('check')}Accept</button>`:`<span class="task-mini-attempt">${task.attempts.length?task.attempts.length+'/3':'—'}</span>`}</div></article>`;}
renderTasks=function(){
 const all=scopedTasks(),query=state.search.toLowerCase();
 const tasks=all.filter(task=>(state.filter==='all'||task.status===state.filter||task.mode===state.filter)&&(!query||(task.title+' '+task.id+' '+task.role+' '+task.project).toLowerCase().includes(query)));
 const groups=taskGroupOrder.map(id=>({id,definition:columns.find(col=>col[0]===id),tasks:tasks.filter(task=>task.status===id)})).filter(group=>group.tasks.length);
 const statusFilters=[['all','All'],...columns.map(col=>[col[0],col[1]])];
 const filterbar=`<div class="task-filterbar"><div class="task-status-tabs">${statusFilters.map(([id,label])=>`<button class="task-status-tab ${state.filter===id?'active':''}" data-filter="${id}" aria-pressed="${state.filter===id}">${label}<span>${all.filter(task=>id==='all'||task.status===id).length}</span></button>`).join('')}</div>${readonly()?`<div class="task-mode-filters">${[['slp','SLP'],['scrum','Agile Scrum']].map(([id,label])=>`<button class="filter ${state.filter===id?'active':''}" data-filter="${id}">${label}</button>`).join('')}</div>`:''}</div>`;
 const toolbar=`<div class="task-toolbar"><div class="task-workspace-label"><span class="task-page-mark">${icon('tasks')}</span><div><strong>${tasks.length} ${tasks.length===1?'task':'tasks'}</strong><small>${all.filter(task=>task.status==='accepted').length} accepted · ${money(all.reduce((sum,task)=>sum+task.cost,0))} sample cost</small></div></div><span class="spacer"></span><div class="task-search"><label class="sr-only" for="task-search">Search tasks</label>${icon('search')}<input id="task-search" placeholder="Find a task…" value="${esc(state.search)}"></div><div class="task-view-switch" aria-label="Task view"><button data-task-view="list" class="${state.taskView==='list'?'selected':''}" aria-pressed="${state.taskView==='list'}">${icon('list')}<span>List</span></button><button data-task-view="board" class="${state.taskView==='board'?'selected':''}" aria-pressed="${state.taskView==='board'}">${icon('tasks')}<span>Board</span></button></div></div>`;
 let body;
 if(!tasks.length)body='<div class="task-empty"><span class="task-empty-mark">'+icon('search')+'</span><h3>No tasks match this view</h3><p>Clear your search or choose another status.</p><button class="btn ghost" data-task-clear>Clear filters</button></div>';
 else if(state.taskView==='board')body=`<div class="compact-board" style="--board-cols:${groups.length}">${groups.map(group=>`<section class="compact-board-column ${group.id}"><h2><span class="status-mark ${group.id}">${icon(group.id==='ready'||group.id==='accepted'?'check':group.id==='attention'?'alert':group.id==='running'?'activity':'clock')}</span>${group.definition[1]}<small>${group.tasks.length}</small></h2>${group.tasks.map(compactTaskCard).join('')}</section>`).join('')}</div>`;
 else body=`<div class="task-list"><div class="task-list-columns"><span>Task</span><span>Agent</span><span>Gate</span><span>Attempts</span><span>Cost</span><span></span></div>${groups.map(group=>{const collapsed=state.collapsedTaskGroups.includes(group.id);return `<section class="task-group ${group.id}"><button class="task-group-heading" data-task-group="${group.id}" aria-expanded="${!collapsed}"><span class="group-chevron ${collapsed?'collapsed':''}">${icon('chevron')}</span><span class="status-mark ${group.id}">${icon(group.id==='ready'||group.id==='accepted'?'check':group.id==='attention'?'alert':group.id==='running'?'activity':'clock')}</span><strong>${group.definition[1]}</strong><span class="group-count">${group.tasks.length}</span></button><div ${collapsed?'hidden':''}>${group.tasks.map(taskRow).join('')}</div></section>`;}).join('')}</div>`;
 return `<div class="task-surface">${toolbar}${filterbar}${body}<div class="task-list-footer"><span>${state.taskView==='list'?'Select a task to inspect its Contract, attempts, and evidence.':'Select a card to inspect the full task.'}</span><span>Sample workspace · local changes only</span></div></div>`;
};
const taskShellBefore=syncShell;
syncShell=function(){taskShellBefore();if(state.page==='tasks')$('.page-heading').outerHTML=heading('Tasks','Follow each Contract from first attempt to acceptance.',badge(mode()==='scrum'?'Agile Scrum':'SLP','cyan'));const theme=$('meta[name="theme-color"]');if(theme)theme.content='#101014';};
document.addEventListener('click',event=>{
 const el=event.target.closest('button');if(!el)return;
 if(el.dataset.taskView){state.taskView=el.dataset.taskView;render();$(`[data-task-view="${state.taskView}"]`)?.focus({preventScroll:true});}
 if(el.dataset.taskGroup){const id=el.dataset.taskGroup;state.collapsedTaskGroups=state.collapsedTaskGroups.includes(id)?state.collapsedTaskGroups.filter(value=>value!==id):[...state.collapsedTaskGroups,id];render();$(`[data-task-group="${id}"]`)?.focus({preventScroll:true});}
 if(el.hasAttribute('data-task-clear')){state.filter='all';state.search='';state.collapsedTaskGroups=[];render();$('#task-search')?.focus({preventScroll:true});}
 if(el.dataset.action==='accept'&&state.page==='tasks')($(`[data-task-open="${el.dataset.task}"]`)||$('[data-filter="all"]'))?.focus({preventScroll:true});
});
render();

// Restore focus after inline MCP actions, including cards removed by a filter.
document.addEventListener('click',event=>{
 const control=event.target.closest('button[data-mcp-focus]');if(!control||control.disabled||state.page!=='integrations'||state.integrationTab!=='mcps')return;
 ($('[data-mcp-focus="'+control.dataset.mcpFocus+'"]')||$('[data-mcp-filter="'+state.mcpFilter+'"]')||$('#mcp-search'))?.focus({preventScroll:true});
});
