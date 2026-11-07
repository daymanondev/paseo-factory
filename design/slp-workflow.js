'use strict';
/* Compact SLP topology; detailed operational data is rendered on demand in the drawer. */
Object.assign(shapes,{
 seat:'<path d="M6 4v9h12V4M4 13h16v4H4Zm2 4v4m12-4v4M9 4h6"/>',
 transfer:'<path d="M3 7h15m-4-4 4 4-4 4M21 17H6m4-4-4 4 4 4"/>'
});
state.slpDrawerPanel=null;
function slpData(){return state.slpGraphTelemetry?.[scopeKey()]||{};}
function slpVacant(id){return Boolean(state.emptyProjects?.has(scopeKey())||state.retiredSeats?.has(scopeKey()+':'+id)||slpData()[id]?.vacant);}
function slpTasks(){return state.emptyProjects?.has(scopeKey())?[]:scopedTasks().filter(task=>task.mode==='slp');}
function slpPeers(){const tasks=slpTasks().filter(task=>!['queued','accepted'].includes(task.status));return [...new Set(tasks.map(task=>task.agent))].slice(0,3).map(id=>({id,task:tasks.find(task=>task.agent===id)}));}
function slpStatus(id,task=null){
 if(id==='owner')return {label:'Human',tone:'muted',status:'idle'};
 if(slpVacant(id))return {label:'Vacant',tone:'muted',status:'queued'};
 if(id==='lead'){
  const rotation=leadHandoffState().rotation;
  if(rotation==='handing_over')return {label:'Handoff',tone:'cyan',status:'running',handoff:true};
  if(rotation==='rotation_pending')return {label:'Rotation pending',tone:'amber',status:'attention'};
 }
 if(slpData().peers?.[id]?.handoffState==='handing_over')return {label:'Handoff',tone:'cyan',status:'running',handoff:true};
 const value=task?.status||agent(id).status;
 return {label:({running:'Running',idle:'Idle',attention:'Needs you',waiting:'Waiting',queued:'Queued',ready:'Ready',accepted:'Done',completed:'Done',error:'Error'})[value]||statusLabel(value),tone:statusTone(value),status:value==='ready'||value==='accepted'?'completed':value};
}
function slpCompactNode(id,task=null){
 const a=agent(id),s=slpStatus(id,task),vacant=id!=='owner'&&slpVacant(id),selected=state.inspector&&!state.slpDrawerPanel&&state.drawerAgent===id;
 const name=id==='lead'?'Lead':id==='supervisor'?'Supervisor':a.name;
 const avatar=id==='owner'?`<span class="slp-human-avatar">${icon('user')}</span>`:vacant?`<span class="slp-empty-avatar">${icon('seat')}</span>`:botAvatar(id);
 const mark=s.handoff?icon('transfer'):vacant?icon('seat'):agentActivityMark(id,s.status);
 return `<button type="button" class="flow-node slp-node ${s.status} ${vacant?'slp-node-vacant':''} ${selected?'selected':''}" data-agent="${id}" data-flow-id="${id}" data-agent-working="${!vacant&&!s.handoff&&agentIsWorking(id,s.status)}" aria-pressed="${Boolean(selected)}" aria-label="${esc(name)}: ${esc(s.label)}${task?', '+esc(task.id):''}"><span class="node-top">${avatar}<strong class="node-title">${esc(name)}</strong></span><span class="node-bottom ${s.tone}">${mark}<span>${esc(s.label)}</span>${task?`<span class="node-task">${esc(task.id)}</span>`:''}</span></button>`;
}
const slpPanels={
 'supervisor-mailbox':{title:'Supervisor Mailbox',glyph:'inbox',agent:'supervisor'},
 'lead-mailbox':{title:'Lead Mailbox',glyph:'inbox',agent:'lead'},
 fence:{title:'Seat write fence',glyph:'shield',agent:'supervisor'},
 design:{title:'Open Design',glyph:'design',agent:'lead'},
 capabilities:{title:'Skills & MCP',glyph:'plug',agent:'peer-1'},
 gate:{title:'Mechanical Gate',glyph:'shield',agent:'lead'},
 watch:{title:'Watch',glyph:'eye',agent:'watch'},
 driver:{title:'Driver & Oracle',glyph:'activity',agent:'lead'},
 retro:{title:'Memory loop',glyph:'refresh',agent:'owner'}
};
function slpFeature(id,label=null,flowId=id){
 const panel=slpPanels[id],mail=id.endsWith('mailbox'),lead=id==='lead-mailbox';
 const source=lead?state.leadTelemetry:slpData().supervisor;
 const locked=mail&&!slpVacant(panel.agent)&&lead&&(leadHandoffState().rotation==='handing_over'||source?.mailboxLocked);
 const queued=mail&&!slpVacant(panel.agent)&&Number.isInteger(source?.queuedMailCount)&&source.queuedMailCount>0;
 const selected=state.inspector&&state.slpDrawerPanel?.id===id&&state.slpDrawerPanel.scope===scopeKey();
 return `<button type="button" class="slp-point ${mail?'slp-mail-point':''} ${locked?'is-locked':''} ${selected?'selected':''}" data-slp-feature="${id}" data-flow-id="${flowId}" aria-pressed="${Boolean(selected)}" aria-label="${esc(panel.title)}${locked?': locked during handoff':queued?': messages waiting':''}"><span class="slp-point-icon">${icon(locked?'lock':panel.glyph)}${queued||locked?'<i class="slp-point-signal" aria-hidden="true"></i>':''}</span><span class="slp-point-label">${label||panel.title}</span></button>`;
}
function renderSlpWorkflow(){
 const peers=slpPeers();
 return `<div class="connected-canvas graph-canvas slp-canvas" id="graph-canvas" data-flow-mode="slp"><svg class="workflow-wires" aria-hidden="true"></svg><div class="slp-compact-layout"><div class="slp-owner-slot">${slpCompactNode('owner')}</div><div class="slp-supervisor-mail-slot">${slpFeature('supervisor-mailbox','Mailbox')}</div><div class="slp-supervisor-slot">${slpCompactNode('supervisor')}</div><div class="slp-lead-mail-slot">${slpFeature('lead-mailbox','Mailbox')}</div><div class="slp-lead-slot">${slpCompactNode('lead')}</div><span class="slp-dispatch-point" data-flow-id="dispatch" aria-hidden="true"></span><div class="slp-fence-slot">${slpFeature('fence','Fence')}</div><div class="slp-design-slot">${slpFeature('design','Design')}</div><div class="slp-capability-slot">${slpFeature('capabilities','Skills / MCP')}</div><div class="slp-retro-slot">${slpFeature('retro','Retro')}</div><div class="slp-verification-slot" aria-label="Verification mechanisms">${slpFeature('gate','Gate','verification')}${slpFeature('watch','Watch')}${slpFeature('driver','Driver')}</div><div class="slp-compact-peers" aria-label="Working Peers" style="--slp-peer-count:${Math.max(1,peers.length)}">${peers.length?peers.map(({id,task})=>slpCompactNode(id,task)).join(''):`<button type="button" class="flow-node slp-node queued slp-node-vacant" data-slp-feature="capabilities" data-flow-id="vacant-peer" aria-label="Vacant Peer slot"><span class="node-top"><span class="slp-empty-avatar">${icon('seat')}</span><strong class="node-title">Peer</strong></span><span class="node-bottom muted">${icon('seat')}Vacant</span></button>`}</div></div></div>`;
}
function drawSlpWorkflow(canvas,svg){
 const bounds=canvas.getBoundingClientRect();if(bounds.width<1||bounds.height<1)return;
 const mobile=window.matchMedia('(max-width:767px)').matches,u=bounds.width/(canvas.offsetWidth||bounds.width);
 const point=(id,side)=>{
  const el=canvas.querySelector(`[data-flow-id="${id==='acceptance'?'owner':id}"]`);if(!el||!el.getClientRects().length)return null;
  const r=el.getBoundingClientRect();return {x:(side==='left'?r.left:side==='right'?r.right:r.left+r.width/2)-bounds.left,y:(side==='top'?r.top:side==='bottom'?r.bottom:r.top+r.height/2)-bounds.top};
 };
 // Route through explicit ports, rounding only actual orthogonal turns.
 const route=points=>{
  const p=points.filter((v,i)=>!i||v.x!==points[i-1].x||v.y!==points[i-1].y);if(p.length<2)return '';
  let d=`M${p[0].x},${p[0].y}`;
  for(let i=1;i<p.length-1;i++){
   const a=p[i-1],b=p[i],c=p[i+1],ab=Math.hypot(b.x-a.x,b.y-a.y),bc=Math.hypot(c.x-b.x,c.y-b.y);
   if(!ab||!bc||(b.x-a.x)*(c.y-b.y)===(b.y-a.y)*(c.x-b.x)){d+=` L${b.x},${b.y}`;continue;}
   const r=Math.min(8*u,ab/2,bc/2),before={x:b.x-(b.x-a.x)/ab*r,y:b.y-(b.y-a.y)/ab*r},after={x:b.x+(c.x-b.x)/bc*r,y:b.y+(c.y-b.y)/bc*r};
   d+=` L${before.x},${before.y} Q${b.x},${b.y} ${after.x},${after.y}`;
  }
  return d+` L${p.at(-1).x},${p.at(-1).y}`;
 };
 const colors={neutral:'#8394a8',done:'#addb84',active:'#68d8ed',wait:'#f2c778',future:'#68788c'},paths=[];
 const add=(from,to,points,tone='neutral',options={})=>{
  const d=route(points);if(!d)return;
  paths.push(`<path class="edge${options.hidden?' slp-motion-route':''}" data-wire-from="${from}" data-wire-to="${to}"${options.shared?' data-slp-shared-route="'+options.shared+'"':''} d="${d}" stroke="${colors[tone]}"${options.dashed?' stroke-dasharray="4 5"':''}${options.arrow===false?'':` marker-end="url(#slp-arrow-${tone})"`}${options.both?` marker-start="url(#slp-arrow-${tone})"`:''}/>`);
 };
 const vertical=(from,to,tone='neutral',both=false)=>{const a=point(from,'bottom'),b=point(to,'top');if(a&&b)add(from,to,[a,b],tone,{both});};
 vertical('owner','supervisor-mailbox','neutral',true);vertical('supervisor-mailbox','supervisor','neutral',true);vertical('supervisor','lead-mailbox','active',true);vertical('lead-mailbox','lead','active',true);
 const peers=[...canvas.querySelectorAll('.slp-compact-peers [data-flow-id]')].map(el=>({id:el.dataset.flowId,top:point(el.dataset.flowId,'top'),bottom:point(el.dataset.flowId,'bottom'),left:point(el.dataset.flowId,'left'),right:point(el.dataset.flowId,'right')}));
 const lead=point('lead','bottom'),gate=point('verification','bottom'),first=peers[0],leftBus=12*u,rightBus=bounds.width-12*u;
 if(lead&&first){
  const forkY=Math.max(lead.y+16*u,Math.min(...peers.map(p=>p.top.y))-20*u);
  if(mobile){
   add('lead','dispatch',[lead,{x:lead.x,y:forkY},{x:leftBus,y:forkY},{x:leftBus,y:peers.at(-1).left.y}],'active',{arrow:false,shared:'dispatch'});
   for(const peer of peers){
    add('lead',peer.id,[lead,{x:lead.x,y:forkY},{x:leftBus,y:forkY},{x:leftBus,y:peer.left.y},peer.left],'active',{hidden:true});
    add('lead',peer.id,[{x:leftBus,y:peer.left.y},peer.left],'active');
   }
  }else{
   add('lead','dispatch',[lead,{x:lead.x,y:forkY}],'active',{arrow:false,shared:'dispatch'});
   for(const peer of peers){
    add('lead',peer.id,[lead,{x:lead.x,y:forkY},{x:peer.top.x,y:forkY},peer.top],'active',{hidden:true});
    add('lead',peer.id,[{x:lead.x,y:forkY},{x:peer.top.x,y:forkY},peer.top],'active');
   }
  }
 }
 const claimed=peers.filter(peer=>peer.id!=='vacant-peer');
 if(gate&&claimed.length){
  const gateApproach=gate.y+16*u;
  if(mobile){
   for(const peer of claimed){
    const tone=agent(peer.id).status==='completed'?'done':'neutral';
    add(peer.id,'verification',[peer.right,{x:rightBus,y:peer.right.y},{x:rightBus,y:gateApproach},{x:gate.x,y:gateApproach},gate],tone,{hidden:true});
    add(peer.id,'verification',[peer.right,{x:rightBus,y:peer.right.y}],tone,{arrow:false});
   }
   add('claim-collector','verification',[{x:rightBus,y:Math.max(...claimed.map(p=>p.right.y))},{x:rightBus,y:gateApproach},{x:gate.x,y:gateApproach},gate],'neutral',{shared:'claims'});
  }else{
   const collectorY=Math.max(...claimed.map(peer=>peer.bottom.y))+24*u;
   for(const peer of claimed){
    const tone=agent(peer.id).status==='completed'?'done':'neutral';
    add(peer.id,'verification',[peer.bottom,{x:peer.bottom.x,y:collectorY},{x:rightBus,y:collectorY},{x:rightBus,y:gateApproach},{x:gate.x,y:gateApproach},gate],tone,{hidden:true});
    add(peer.id,'verification',[peer.bottom,{x:peer.bottom.x,y:collectorY}],tone,{arrow:false});
   }
   add('claim-collector','verification',[{x:Math.min(...claimed.map(p=>p.bottom.x)),y:collectorY},{x:rightBus,y:collectorY},{x:rightBus,y:gateApproach},{x:gate.x,y:gateApproach},gate],'neutral',{shared:'claims'});
  }
 }
 const side=(from,to,tone='neutral',rightwards=true,both=false)=>{const a=point(from,rightwards?'right':'left'),b=point(to,rightwards?'left':'right');if(a&&b){const mid=(a.x+b.x)/2;add(from,to,[a,{x:mid,y:a.y},{x:mid,y:b.y},b],tone,{dashed:true,both});}};
 side('design','lead');side('owner','retro','done',true,true);side('verification','lead','done',false);
 const cap=point('capabilities','left');
 if(cap&&first&&!mobile)add('capabilities',first.id,[cap,{x:leftBus,y:cap.y},{x:leftBus,y:first.left.y},first.left],'neutral',{dashed:true});
 // Keep a geometry-only route for the existing one-shot Accept animation.
 // The normal feedback goes through Lead and the vertical hierarchy.
 const owner=point('owner','right'),g=point('verification','right');
 if(owner&&g)add('verification','acceptance',[g,{x:rightBus,y:g.y},{x:rightBus,y:owner.y},owner],'done',{hidden:true});
 svg.setAttribute('viewBox',`0 0 ${bounds.width} ${bounds.height}`);svg.setAttribute('preserveAspectRatio','none');
 svg.innerHTML=`<defs>${Object.entries(colors).map(([name,color])=>`<marker id="slp-arrow-${name}" viewBox="0 0 8 8" markerWidth="8" markerHeight="8" refX="8" refY="4" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="M0 0 L8 4 L0 8 Z" fill="${color}"/></marker>`).join('')}</defs>${paths.join('')}`;
}
function slpRows(rows){return `<dl class="data-list slp-drawer-data">${rows.map(([name,value])=>`<div><dt>${esc(name)}</dt><dd>${esc(value==null?'—':String(value))}</dd></div>`).join('')}</dl>`;}
function slpDisclosure(key,label,glyph,body,meta=''){
 return `<details class="drawer-disclosure slp-drawer-disclosure" ${drawerDisclosureAttrs('slp-'+key)}><summary><span class="drawer-section-label">${icon(glyph)}<span>${label}</span></span>${meta?`<span class="slp-disclosure-meta">${esc(meta)}</span>`:''}${icon('chevron')}</summary><div class="drawer-disclosure-content">${body}</div></details>`;
}
function slpDrawerLink(feature,label,glyph){return `<button type="button" class="slp-drawer-link" data-slp-feature="${feature}">${icon(glyph)}<span>${label}</span>${icon('chevron')}</button>`;}
function slpUsageDetails(id){
 const empty=state.emptyProjects?.has(scopeKey()),records=empty?[]:(state.usageExamples||[]).filter(r=>r.hostId===activeHostId()&&r.project===state.project&&(id==='owner'||r.agentId===id));
 const aggregate=usageAggregate(records),costs=(id==='owner'?slpTasks():slpTasks().filter(task=>task.agent===id)).map(task=>task.cost).filter(value=>Number.isFinite(value)&&value>=0);
 const cost=costs.length?'$'+costs.reduce((sum,value)=>sum+value,0).toFixed(2)+' metered':'—';
 return slpDisclosure('usage',id==='owner'?'Project usage':'Token usage','activity',slpRows([['Total tokens',usageValue(aggregate,'total',false)],['Input',usageValue(aggregate,'input',false)],['Output',usageValue(aggregate,'output',false)],['Cached input',usageValue(aggregate,'cached',false)],['Cost',cost]])+`<p class="drawer-muted">Example records · cumulative usage, separate from context occupancy.</p><button type="button" class="slp-drawer-link" data-slp-activity="usage">${icon('activity')}<span>View usage by model & agent</span>${icon('chevron')}</button>`,usageValue(aggregate));
}
function slpPeerDetails(id){
 const task=slpPeers().find(peer=>peer.id===id)?.task||slpTasks().find(item=>item.agent===id),telemetry=slpData().peers?.[id]||{},attempts=task?.attempts||[];
 const trail=`<div class="slp-drawer-attempts" aria-label="Attempts, maximum three">${[0,1,2].map(n=>`<span class="${attempts[n]==='green'?'green':attempts[n]==='red'?'red':attempts[n]==='open'?'cyan':'muted'}">${icon(attempts[n]==='green'?'check':attempts[n]==='red'?'close':attempts[n]==='open'?'activity':'minus')}#${n+1}</span>`).join('')}</div>`;
 const context=Number.isFinite(telemetry.contextUsedTokens)?usageExact(telemetry.contextUsedTokens)+' / 160,000':'— / 160,000';
 return slpDisclosure('peer-execution','Attempts & handoff','refresh',trail+slpRows([['Context',context],['Worktree',task?'factory/'+task.id:'—'],['Respawned',Number.isInteger(telemetry.respawnCount)?'×'+telemetry.respawnCount:'—']])+`<p class="drawer-copy">At the 160k handoff mark, the Peer extracts <strong>${task?'peer-handoff-'+esc(task.id)+'.md':'peer-handoff-&lt;task&gt;.md'}</strong>. Its successor continues in the same worktree with 0% context.</p>${telemetry.handoffState==='handing_over'?'<p class="slp-drawer-notice cyan">Peer handoff is in progress.</p>':''}`,attempts.length+' / 3');
}
function slpAgentDetails(id){
 let body='';
 if(['supervisor','lead'].includes(id)){
  const source=slpData()[id]||{},seq=source.seqEnd??(id==='lead'?state.leadTelemetry?.seqEnd:null);
  body+=slpDisclosure('seat','Seat & permissions','shield',slpRows([['Seat',id],['Workspace',project()?.path||'—'],['seqEnd',seq],['Attention',agent(id).status==='attention'?'Needs owner':'—']])+slpDrawerLink('fence','Write fence & choke policy','shield')+slpDrawerLink(id+'-mailbox','Open mailbox','inbox'));
 }
 if(id.startsWith('peer-'))body+=slpPeerDetails(id);
 if(['owner','supervisor','lead'].includes(id)||id.startsWith('peer-'))body+=slpUsageDetails(id);
 if(id==='owner')body+=slpDrawerLink('retro','Ledger, Retro & proposals','refresh');
 return body;
}
function slpLeadContext(){
 const data=leadHandoffState(),vacant=slpVacant('lead'),raw=state.leadTelemetry||{},status=slpStatus('lead');
 const context=vacant?'0% on next spawn':data.tokens===null?'—':Math.round(data.tokens/1000)+'k / 128k';
 let body=vacant?'<p class="drawer-copy">This seat is empty. The next Supervisor dispatch spawns a fresh Lead with 0% context.</p>':leadHandoffMeter(data)+`<p class="drawer-copy">${esc(data.note)}</p>`;
 if(!vacant&&data.rotation==='handing_over')body+=`<div class="slp-drawer-handoff"><span>Outgoing Lead <b>${data.tokens===null?'Context —':Math.round(data.tokens/1000)+'k'}</b></span>${icon('arrow')}<span>${icon('file')}lead-handoff.md <small>Max 24 KB</small></span>${icon('arrow')}<span>Successor Lead <b>0% · pending</b></span></div><p class="slp-drawer-notice amber">${raw.handoffPhase==='pending_kickoff'?'Pending handoff kickoff · waiting for Peers.':'Lead Mailbox is locked during handoff.'}</p>`;
 body+=slpRows([['Lifecycle',status.label],['Last handoff',data.lastHandoff||'—']])+slpDrawerLink('lead-mailbox','Inspect queued mail','inbox');
 body+=`<details class="slp-lifecycle-help"><summary>Lead lifecycle ${icon('chevron')}</summary><p>Active → Rotation pending → Handing over → successor active.</p><p>Rotation pending finishes the current turn. A manually rotated seat remains vacant until the next Supervisor dispatch.</p></details>`;
 return slpDisclosure('lead-context','Context & handoff','refresh',body,context);
}
function slpPanelBody(id){
 if(id.endsWith('mailbox')){
  const lead=id==='lead-mailbox',seat=lead?'lead':'supervisor',source=lead?state.leadTelemetry:slpData().supervisor;
  const count=!slpVacant(seat)&&Number.isInteger(source?.queuedMailCount)?source.queuedMailCount:null;
  const locked=lead&&!slpVacant(seat)&&(leadHandoffState().rotation==='handing_over'||source?.mailboxLocked);
  return `<p class="drawer-copy">${lead?'Directives from Supervisor wait here while Lead is busy.':'Directives from Owner go down. Reports, questions and needs-human signals come back up.'}</p>${slpRows([['Seat',seat],['Status',slpVacant(seat)?'Awaiting seat':locked?'Locked during handoff':'Available'],['Queued',count],['Message contents','Not reported']])}${locked?'<p class="slp-drawer-notice amber">New messages stay queued until handoff finishes.</p>':''}`;
 }
 if(id==='fence')return `<p class="drawer-copy">Three layers enforce the product-write fence and choke policy for Supervisor and Lead.</p>${slpRows([['Product code','Fenced for Supervisor and Lead'],['Project memory','Writable'],['Files','AGENTS.md · CONTEXT.md · docs/adr/']])}<p class="drawer-copy">Working Peers implement bounded changes inside isolated Task worktrees.</p>`;
 if(id==='design')return slpRows([['Bundle',state.linkedDesign?'Linked':'Not linked']])+`<section class="slp-drawer-section"><h3>${icon('file')}Catalog → Lead</h3><p>screens-data.js · design-manifest.json</p><small>Lightweight planning reference · approximately 7k tokens in the reference architecture.</small></section><section class="slp-drawer-section"><h3>${icon('code')}Source → Peers</h3><p>index.html · app.js · styles.css</p><small>The full design source goes to working Peers.</small></section>`;
 if(id==='capabilities'){
  const peers=slpPeers();
  return `<p class="drawer-copy">Helper MCP servers are assigned to working Peers. Skills follow their role and each Task Contract.</p>${peers.length?peers.map(({id:peer,task})=>`<section class="slp-drawer-section"><h3>${esc(agent(peer).name)} <small>${esc(task.id)}</small></h3>${slpRows([['Skills',drawerSkills(peer).map(skill=>skill.name).join(', ')||'None assigned'],['Helper MCP',drawerServers(peer).map(server=>server.name).join(', ')||'None synced']])}</section>`).join(''):'<p class="drawer-muted">No working Peers yet.</p>'}`;
 }
 if(id==='gate'){
  const tasks=slpTasks().filter(task=>task.attempts.length);
  return `<p class="drawer-copy">Claim (--sha) → mechanical test verdict → Lead diff review → merge to the stable checkpoint.</p><div class="slp-gate-tasks">${tasks.map(task=>{const verdict=task.attempts.at(-1),tone=verdict==='green'?'green':verdict==='red'?'red':'muted';return `<button type="button" class="slp-drawer-link" data-action="task" data-task="${esc(task.id)}"><span class="${tone}">${icon(verdict==='green'?'check':verdict==='red'?'close':'clock')}</span><span>${esc(task.id)}<small>${verdict==='open'?'Pending':esc(verdict.toUpperCase())} · attempt #${task.attempts.length}</small></span>${icon('chevron')}</button>`;}).join('')||'<p class="drawer-muted">No attempt verdicts yet.</p>'}</div>${slpDisclosure('challenges','Challenge signals','alert',`<div class="slp-challenge-list"><p><strong>REOPEN_REQUEST</strong>Revisit a contradicted premise or boundary.</p><p><strong>DEPENDENCY_REQUEST</strong>Resolve an unowned prerequisite.</p><p><strong>BLOCKED</strong>Report an external blocker with evidence and commit SHA.</p></div>`)}`;
 }
 if(id==='watch'){
  const questions=['destructive-writes','test-weakened','stuck-loop','scope-creep','secret-leak'];
  return `<p class="drawer-copy">Headless risk assessment. Each reported probability is between 0 and 1.</p>${slpRows(questions.map(name=>{const value=slpData().watch?.[name];return [name,Number.isFinite(value)&&value>=0&&value<=1?value.toFixed(2):null];}))}`;
 }
 if(id==='driver')return `<p class="drawer-copy">Driver & Timeline Oracle uses the life signal (seqEnd) to distinguish stalled work from a lost session.</p>${slpRows([['Denial stall','Re-poke'],['Substrate death','Respawn Peer'],['Last recovery',slpData().driver?.status||null],['Supervisor seqEnd',slpData().supervisor?.seqEnd],['Lead seqEnd',slpData().lead?.seqEnd??state.leadTelemetry?.seqEnd]])}`;
 if(id==='retro'){
  const proposals=state.retro||[];
  return `<div class="slp-memory-links">${[['ledger','Project Ledger','file','ledger.jsonl · all seats'],['usage','Usage meter','activity','usage.json · tokens by model and agent'],['retro','Daily Retro','refresh','lanes.retro → proposals']].map(([tab,name,glyph,detail])=>`<button type="button" class="slp-drawer-link" data-slp-activity="${tab}">${icon(glyph)}<span>${name}<small>${detail}</small></span>${icon('chevron')}</button>`).join('')}</div><section class="slp-drawer-section"><h3>${icon('inbox')}Proposals</h3>${proposals.length?proposals.map((proposal,i)=>`<div class="slp-proposal-row"><span>R${i+1}</span>${proposal.ratified?'<span class="green">Recorded for Supervisor</span>':`<button type="button" class="btn ghost" data-action="ratify" data-retro="${i}">Ratify via Supervisor</button>`}</div>`).join(''):'<p class="drawer-muted">No proposals yet.</p>'}</section>`;
 }
 return '';
}
function slpPanelFooter(id){
 if(id.endsWith('mailbox'))return button('Open in Paseo','open-agent',`data-agent-id="${slpPanels[id].agent}"`,'primary','external');
 if(id==='design')return '<button type="button" class="btn primary" data-slp-manage-design>'+icon('design')+'Manage Open Design</button>';
 if(id==='capabilities')return `<button type="button" class="btn ghost" data-workspace-destination="skills" data-context-agent="peer-1">${icon('code')}Skills</button><button type="button" class="btn primary" data-workspace-destination="mcps" data-context-agent="peer-1">${icon('plug')}MCP</button>`;
 if(id==='gate')return '<button type="button" class="btn primary" data-nav="tasks">'+icon('tasks')+'View Tasks</button>';
 if(id==='retro')return '<button type="button" class="btn primary" data-slp-activity="retro">'+icon('refresh')+'Open Daily Retro</button>';
 return button('Close','drawer-close','','ghost');
}
function slpPanelMarkup(id){
 const panel=slpPanels[id];
 return `<button class="agent-drawer-scrim" data-drawer-close aria-label="Close details" tabindex="-1"></button><aside class="agent-drawer slp-feature-drawer" id="agent-drawer" role="dialog" aria-modal="false" aria-labelledby="agent-drawer-title" tabindex="-1"><header class="agent-drawer-header"><span class="slp-panel-icon">${icon(panel.glyph)}</span><div class="drawer-header-identity"><div class="drawer-name-row"><h2 id="agent-drawer-title">${panel.title}</h2></div></div><button type="button" class="icon-btn" data-drawer-close data-drawer-focus="close" aria-label="Close details">${icon('close')}</button></header><div class="agent-drawer-body">${slpPanelBody(id)}<p class="slp-sample-note">Example data · unreported values appear as —</p></div><footer class="agent-drawer-footer">${slpPanelFooter(id)}</footer></aside>`;
}
const slpBaseDrawerMarkup=drawerMarkup;
const slpBaseHandoffDetails=leadHandoffDetails;
leadHandoffDetails=function(){return mode()==='slp'?slpLeadContext():slpBaseHandoffDetails();};
const slpBaseDrawerStatus=drawerAgentStatus;
drawerAgentStatus=function(id){if(mode()==='slp'&&id!=='owner'&&slpVacant(id))return {label:'Vacant',tone:'muted'};return slpBaseDrawerStatus(id);};
function slpActivePanel(){return mode()==='slp'&&state.inspector&&state.slpDrawerPanel?.scope===scopeKey()&&slpPanels[state.slpDrawerPanel.id]?state.slpDrawerPanel.id:null;}
// Reuse the established drawer mounting, focus restoration and mobile modal behavior.
 drawerMarkup=function(id){
 const panel=slpActivePanel();if(panel)return slpPanelMarkup(panel);
 let markup=slpBaseDrawerMarkup(id);if(mode()!=='slp')return markup;
 const marker='<details class="drawer-disclosure drawer-technical"';
 markup=markup.replace(marker,slpAgentDetails(id)+marker);
 if(['supervisor','lead'].includes(id)){
  const vacant=slpVacant(id),open=vacant&&id==='lead'?'<button type="button" class="btn primary" disabled>Awaiting dispatch</button>':button(vacant?'Start Supervisor':'Open in Paseo','open-agent',`data-agent-id="${id}"`,'primary','external');
  const retire=vacant?'':button(id==='lead'?'Rotate Lead':'Revoke Supervisor','retire-seat',`data-role="${id}"`,'ghost',id==='lead'?'refresh':'close');
  markup=markup.replace(/<footer class="agent-drawer-footer">[\s\S]*?<\/footer>/,`<footer class="agent-drawer-footer">${retire}${open}</footer>`);
 }
 return markup;
};
const slpBaseOpenDrawer=openAgentDrawer;
openAgentDrawer=function(id,trigger){if(!trigger?.hasAttribute('data-slp-feature'))state.slpDrawerPanel=null;slpBaseOpenDrawer(id,trigger);};
const slpBaseDrawerSelection=drawerSelection;
drawerSelection=function(){
 slpBaseDrawerSelection();const panel=slpActivePanel();
 if(panel)$$('.slp-node[data-agent]').forEach(node=>{node.classList.remove('selected');node.setAttribute('aria-pressed','false');});
 $$('.slp-point').forEach(node=>{const selected=Boolean(panel&&node.dataset.slpFeature===panel);node.classList.toggle('selected',selected);node.setAttribute('aria-pressed',String(selected));});
};
document.addEventListener('click',event=>{
 const control=event.target.closest('button');if(!control||control.disabled)return;
 if(control.dataset.slpFeature&&slpPanels[control.dataset.slpFeature]){
  const id=control.dataset.slpFeature;state.slpDrawerPanel={id,scope:scopeKey()};
  openAgentDrawer(slpPanels[id].agent,control);const body=$('.agent-drawer-body');if(body)body.scrollTop=0;
 }
 if(control.dataset.slpActivity){state.activityTab=control.dataset.slpActivity;if(state.activityTab==='usage')usageView().period='all';navigate('activity');}
 if(control.hasAttribute('data-slp-manage-design'))navigate('design');
});
render();
