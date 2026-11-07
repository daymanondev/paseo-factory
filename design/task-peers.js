'use strict';
/* These are local view keys, never native agent IDs or Paseo session handles.
   A Task owns its Peer execution; worker lanes only supply default configuration. */
function slpTaskPeerKey(task){return 'peer-task-'+encodeURIComponent(task.id);}
function slpTaskForPeerKey(id){return typeof id==='string'&&id.startsWith('peer-task-')?slpTasks().find(task=>slpTaskPeerKey(task)===id):null;}
const slpTaskDataBefore=slpData;
function slpTaskRuntime(task){return slpTaskDataBefore().taskPeers?.[task.id]||task.peerTelemetry||{};}
function slpTaskSession(task,index=task.attempts.length-1){
 const detail=task.attemptDetails?.[index]||{};
 return index===task.attempts.length-1?slpTaskRuntime(task).currentSession||task.peerSession||detail:detail;
}
slpPeers=function(){
 return slpTasks().filter(task=>!['queued','accepted'].includes(task.status)).slice(0,3).map(task=>({id:slpTaskPeerKey(task),task}));
};
slpAuthorityPeerIds=function(){return slpPeers().map(peer=>peer.id);};
slpData=function(){
 const source=slpTaskDataBefore(),peers={...source.peers};
 for(const task of slpTasks())peers[slpTaskPeerKey(task)]=slpTaskRuntime(task);
 return {...source,peers};
};
const slpTaskAgentBefore=agent;
agent=function(id){
 const task=slpTaskForPeerKey(id);
 if(!task){const value=slpTaskAgentBefore(id);return mode()==='slp'&&id?.startsWith('peer-')?{...value,name:'Peer',short:'Peer',subtitle:'Task session'}:value;}
 const baseline=agentDefinitions[task.agent]?slpTaskAgentBefore(task.agent):{},session=slpTaskSession(task),runtime=slpTaskRuntime(task);
 return {
  name:'Peer · '+task.id,short:'Peer · '+task.id,initials:'P',subtitle:task.title,task:task.id,
  provider:session.provider||runtime.provider||baseline.provider||null,
  model:session.model||runtime.model||baseline.model||null,
  thinking:session.thinking||runtime.thinking||baseline.thinking||null,
  status:runtime.status||({ready:'completed',accepted:'completed'})[task.status]||task.status,
  agentId:session.agentId||null,sessionId:session.sessionId||null,sessionUrl:session.sessionUrl||null
 };
};
const slpCurrentTaskBeforeTaskPeers=slpCurrentTask;
slpCurrentTask=function(id){return slpTaskForPeerKey(id)||slpCurrentTaskBeforeTaskPeers(id);};
const slpTaskDetailRevisionBefore=slpDetailRevision;
slpDetailRevision=function(context){
 const task=slpTaskForPeerKey(context.id);
 const session=task?slpTaskSession(task):{},runtime=task?slpTaskRuntime(task):{};
 return slpTaskDetailRevisionBefore(context)+(task?'|'+JSON.stringify([session.agentId,session.sessionId,session.sessionUrl,session.provider,session.model,session.thinking,runtime.revision,runtime.seqEnd,runtime.status,runtime.handoffState,runtime.respawnCount,runtime.contextUsedTokens]):'');
};
const slpTaskOpenBefore=openAgent;
openAgent=function(id){
 const task=slpTaskForPeerKey(id);
 if(!task){slpTaskOpenBefore(id);return;}
 const session=slpTaskSession(task),url=paseoSafeUrl(session.sessionUrl)||paseoAttemptLinks(task,task.attempts.length-1).sessionUrl;
 if(url)paseoOpenUrl(url);else notify('No Peer session link has been reported for '+task.id+'.',true);
};
const slpTaskModelBefore=drawerModel;
drawerModel=function(id){
 const task=slpTaskForPeerKey(id);if(!task)return slpTaskModelBefore(id);
 const current=agent(id);
 return `<div class="drawer-model-inline"><span class="slp-peer-session-model">${esc(current.provider||'Provider —')} · ${esc(current.model||'Model —')}${current.thinking?' · '+esc(current.thinking):''}</span></div>`;
};
const slpTaskViewBefore=slpTaskView;
slpTaskView=function(context){
 const task=slpTaskForPeerKey(context.id);if(!task)return slpTaskViewBefore(context);
 const session=slpTaskSession(task);
 return `<p class="slp-peer-lifecycle-note">Peer session spawned for this Task.</p>${slpRows([['Agent ID',session.agentId],['Session',session.sessionId]])}${slpTaskViewBefore(context)}`;
};
const slpTaskMapBefore=renderSlpWorkflow;
renderSlpWorkflow=function(){
 return slpTaskMapBefore()
  .replace('aria-label="Vacant Peer slot"','aria-label="Peers are spawned for individual Tasks"')
  .replace('<strong class="node-title">Peer</strong>','<strong class="node-title">No active Peers</strong>')
  .replace(`<span class="node-bottom muted">${icon('seat')}Vacant</span>`,`<span class="node-bottom muted">Spawned per Task</span>`);
};
render();
