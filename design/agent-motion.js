'use strict';
/* One-shot transfer cues use observed task changes, never a looping traffic simulation. */
let workflowTransferQueue=[];
let workflowMotionScope=scopeKey();
const workflowMotionSnapshot=()=>new Map(state.tasks.map(task=>[scopeKey(task.project,task.hostId)+'::'+task.id,{status:task.status,verdict:task.attempts.at(-1)||null}]));
let workflowPreviousTasks=workflowMotionSnapshot();
function queueWorkflowTransfer(from,to,tone='active'){
 if(state.page!=='flow'||state.project==='all'||!fleetOnline()||state.emptyProjects?.has(scopeKey())||window.matchMedia('(prefers-reduced-motion:reduce)').matches)return;
 if(workflowTransferQueue.some(item=>item.from===from&&item.to===to))return;
 workflowTransferQueue.push({from,to,tone,scope:scopeKey(),expires:Date.now()+1000});
 queueWorkflow();
}
function workflowTaskTransfers(task,before){
 const isScrum=task.mode==='scrum',id=isScrum||typeof slpTaskPeerKey!=='function'?task.agent:slpTaskPeerKey(task);
 if(before.status!=='running'&&task.status==='running'){
  const source=isScrum?({pm:'lead',ux:'pm',architect:'pm',dev:'gate',qa:'dev'})[id]:'lead';
  if(source)queueWorkflowTransfer(source,id);
 }
 const verdict=task.attempts.at(-1);
 if((verdict==='green'||verdict==='red')&&verdict!==before.verdict){
  if(!isScrum)queueWorkflowTransfer(id,'verification',verdict==='green'?'done':'wait');
  else if(id==='pm'&&verdict==='green'){queueWorkflowTransfer('pm','ux','done');queueWorkflowTransfer('pm','architect','done');}
  else if(id==='ux'||id==='architect')queueWorkflowTransfer(id,'gate',verdict==='green'?'done':'wait');
  else if(id==='dev'&&verdict==='green')queueWorkflowTransfer('dev','qa','done');
  else if(id==='qa'&&verdict==='red')queueWorkflowTransfer('qa','dev','wait');
 }
 if(!isScrum&&before.status!=='accepted'&&task.status==='accepted')queueWorkflowTransfer('verification','acceptance','done');
}
const workflowMotionRenderBefore=render;
render=function(){
 workflowMotionRenderBefore();
 const currentScope=scopeKey();
 if(workflowMotionScope!==currentScope){workflowTransferQueue=[];workflowMotionScope=currentScope;}
 else if(state.page==='flow'&&state.project!=='all'){
  for(const task of scopedTasks()){
   const before=workflowPreviousTasks.get(scopeKey(task.project,task.hostId)+'::'+task.id);
   if(before)workflowTaskTransfers(task,before);
  }
 }
 workflowPreviousTasks=workflowMotionSnapshot();
};
const workflowMotionDrawBefore=drawWorkflow;
drawWorkflow=function(){
 workflowMotionDrawBefore();
 const svg=$('.connected-canvas .workflow-wires');if(!svg)return;
 const events=workflowTransferQueue;workflowTransferQueue=[];
 if(window.matchMedia('(prefers-reduced-motion:reduce)').matches)return;
 const ns='http://www.w3.org/2000/svg',colors={active:'#83e8f4',done:'#d0ef91',wait:'#ffda8a'};
 for(const event of events){
  if(event.scope!==scopeKey()||event.expires<Date.now())continue;
  const edge=$(`path[data-wire-from="${event.from}"][data-wire-to="${event.to}"]`,svg),path=edge?.getAttribute('d');if(!path)continue;
  const group=document.createElementNS(ns,'g');group.setAttribute('class','workflow-transfer');group.setAttribute('aria-hidden','true');
  const motions=[];
  for(const [radius,opacity,delay] of [[2,.3,40],[2.5,.6,20],[3,1,0]]){
   const dot=document.createElementNS(ns,'circle');dot.setAttribute('r',String(radius));dot.setAttribute('fill',colors[event.tone]||colors.active);dot.setAttribute('opacity',String(opacity));dot.setAttribute('visibility','hidden');
   const motion=document.createElementNS(ns,'animateMotion');motion.setAttribute('path',path);motion.setAttribute('dur','320ms');motion.setAttribute('begin','indefinite');motion.setAttribute('fill','freeze');motion.setAttribute('calcMode','paced');
   dot.appendChild(motion);group.appendChild(dot);motions.push({motion,delay});
  }
  svg.appendChild(group);
  for(const {motion,delay} of motions)setTimeout(()=>{if(group.isConnected&&event.scope===scopeKey()&&!window.matchMedia('(prefers-reduced-motion:reduce)').matches){if(typeof motion.beginElement==='function'){motion.parentNode.setAttribute('visibility','visible');motion.beginElement();}}},delay);
  setTimeout(()=>group.remove(),400);
 }
};
