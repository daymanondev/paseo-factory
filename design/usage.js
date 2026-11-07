'use strict';
/* Illustrative request-level usage, kept separate from context occupancy and model configuration. */
const usageExampleTime=Date.now();
const usageExampleRuns={'mac-local::research-slp':'example-scrum-03','mac-mini::pos-tax':'example-slp-04'};
const usageExamples=[];
function usageExample(hostId,project,runId,agentId,role,sessionId,provider,model,hoursAgo,input,output,cached,taskId=null,attempt=null){
 usageExamples.push({id:'usage-example-'+(usageExamples.length+1),hostId,project,runId,agentId,role,sessionId,provider,model,at:usageExampleTime-hoursAgo*3600000,inputTokens:input,outputTokens:output,cachedInputTokens:cached,taskId,attempt});
}
const usageScrumArgs=['mac-local','research-slp','example-scrum-03'];
usageExample(...usageScrumArgs,'supervisor','Supervisor','example-supervisor-03','Codex','GPT-6.1',5,12400,2100,8000);
usageExample(...usageScrumArgs,'lead','Lead','example-lead-03','Codex','GPT-6.1',4,28600,3400,18000);
usageExample(...usageScrumArgs,'lead','Lead','example-lead-03','Codex','GPT-6.1',1,22400,2800,14000);
usageExample(...usageScrumArgs,'pm','PM / Analyst','example-pm-01','Codex','GPT-6.1',4.5,8300,1800,4200,'SCR-01',1);
usageExample(...usageScrumArgs,'ux','UX Designer','example-ux-02','Claude','Claude Sonnet',3.5,18600,4200,12000,'SCR-02',1);
usageExample(...usageScrumArgs,'ux','UX Designer','example-ux-02','Claude','Claude Sonnet',2,24800,5300,16000,'SCR-02',2);
usageExample(...usageScrumArgs,'architect','System Architect','example-architect-03','Codex','GPT-6.1',.5,21300,null,null,'SCR-03',1);
usageExample(...usageScrumArgs,'watch','Watch & Retro','example-watch-01','Pi','GLM-5.3',1.5,2200,450,null);
usageExample('mac-local','research-slp','example-scrum-02','lead','Lead','example-lead-02','Claude','Claude Sonnet',40,56400,7100,34000);
usageExample('mac-local','research-slp','example-scrum-02','supervisor','Supervisor','example-supervisor-02','Codex','GPT-6.1',44,15300,2400,9600);
usageExample('mac-local','research-slp','example-scrum-02','dev','Senior Dev','example-dev-02','Pi','GLM-5.3',48,38200,6700,20000);
usageExample('mac-local','research-slp','example-scrum-01','lead','Lead','example-lead-01','Codex','GPT-6.1',240,43600,5100,26000);
const usageSlpArgs=['mac-mini','pos-tax','example-slp-04'];
usageExample(...usageSlpArgs,'supervisor','Supervisor','example-supervisor-04','Codex','GPT-6.1',6,9400,1600,5600);
usageExample(...usageSlpArgs,'lead','Lead','example-lead-04','Codex','GPT-6.1',3,32600,4200,22000);
usageExample(...usageSlpArgs,'peer-1','Receipt worker','example-peer-01','Pi','GLM-5.3',1,34200,6300,16000,'SLP-01',1);
usageExample(...usageSlpArgs,'peer-2','Reprint reviewer','example-peer-02','Codex','GPT-6.1',2.5,12000,2100,7000,'SLP-02',1);
usageExample(...usageSlpArgs,'peer-2','Reprint reviewer','example-peer-02','Codex','GPT-6.1',.5,14800,2600,9000,'SLP-02',2);
usageExample(...usageSlpArgs,'peer-3','Printer worker','example-peer-03','Pi','GLM-5.3',4,9600,null,null,'SLP-03',1);
usageExample('mac-mini','pos-tax','example-slp-03','lead','Lead','example-lead-previous','Claude','Claude Sonnet',60,46200,5100,28000);
state.usageExamples=usageExamples;
state.usageViews={};
function usageView(){const key=scopeKey();return state.usageViews[key]||(state.usageViews[key]={period:'run',model:null,expanded:[]});}
function usageModelKey(record){return encodeURIComponent(record.provider)+'|'+encodeURIComponent(record.model);}
function usageNumber(value){return Number.isFinite(value)&&value>=0?value:null;}
function usageAggregate(records){
 const result={input:0,output:0,cached:0,inputKnown:0,outputKnown:0,cachedKnown:0,complete:0,count:records.length};
 for(const record of records){
  const input=usageNumber(record.inputTokens),output=usageNumber(record.outputTokens),cached=usageNumber(record.cachedInputTokens);
  if(input!==null){result.input+=input;result.inputKnown++;}
  if(output!==null){result.output+=output;result.outputKnown++;}
  if(input!==null&&cached!==null&&cached<=input){result.cached+=cached;result.cachedKnown++;}
  if(input!==null&&output!==null)result.complete++;
 }
 result.total=result.input+result.output;result.totalKnown=result.inputKnown>0||result.outputKnown>0;
 return result;
}
function usageUnique(records){const seen=new Set();return records.filter(record=>{if(seen.has(record.id))return false;seen.add(record.id);return true;});}
function usageRecords(){
 const view=usageView(),key=scopeKey(),current=state.emptyProjects?.has(key)?null:usageExampleRuns[key],now=Date.now();
 return usageUnique(state.usageExamples.filter(record=>record.hostId===activeHostId()&&record.project===state.project&&(view.period==='run'?current&&record.runId===current:view.period==='all'?true:record.at>=now-(view.period==='24h'?24:168)*3600000)));
}
function usageCompact(value){return new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:1}).format(value);}
function usageExact(value){return new Intl.NumberFormat('en').format(value);}
function usageValue(aggregate,type='total',compact=true){
 const known=type==='total'?aggregate.totalKnown:aggregate[type+'Known']>0;
 if(!known)return '—';
 const partial=type==='total'?aggregate.complete<aggregate.count:aggregate[type+'Known']<aggregate.count;
 return (compact?usageCompact(aggregate[type]):usageExact(aggregate[type]))+(partial?'+':'');
}
function usageGroups(records,keyFn){
 const groups=new Map();for(const record of records){const key=keyFn(record);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(record);}return [...groups.entries()].map(([key,items])=>({key,records:items,usage:usageAggregate(items)}));
}
function usageSummary(records){
 const a=usageAggregate(records);
 return `<dl class="usage-summary">${[['total','Total recorded'],['input','Input'],['output','Output'],['cached','Cached input']].map(([type,label])=>`<div class="usage-stat usage-stat-${type}"><dt>${label}${type==='cached'?'<small>Included in Input</small>':''}</dt><dd>${usageValue(a,type,false)}</dd></div>`).join('')}</dl>`;
}
function usageChart(records){
 const view=usageView(),models=usageGroups(records,usageModelKey).sort((a,b)=>b.usage.total-a.usage.total),max=Math.max(1,...models.map(group=>group.usage.total));
 const rows=models.map((group,index)=>{
  const first=group.records[0],a=group.usage,input=a.input/max*640,output=a.output/max*640,cached=a.cached/max*640,pattern='usage-cache-'+index;
  const label=first.model+' via '+first.provider+': '+usageExact(a.input)+' recorded input, '+usageExact(a.output)+' recorded output, '+usageValue(a,'total',false)+' total tokens';
  return `<button type="button" class="usage-model-row ${view.model===group.key?'selected':''}" data-usage-model="${esc(group.key)}" aria-pressed="${view.model===group.key}" aria-label="Filter agents using ${esc(first.model)} via ${esc(first.provider)}"><span class="usage-model-identity"><strong>${esc(first.model)}</strong><small>${esc(first.provider)}</small></span><svg class="usage-model-chart" viewBox="0 0 640 16" width="640" height="16" preserveAspectRatio="none" role="img" aria-label="${esc(label)}"><defs><pattern id="${pattern}" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="8" height="8" fill="#57d5e9"/><path d="M0 0v8" stroke="#152a32" stroke-width="3"/></pattern></defs><rect width="640" height="16" rx="4" fill="#2d2d35"/><rect width="${input}" height="16" fill="#57d5e9"/>${cached?`<rect width="${cached}" height="16" fill="url(#${pattern})"/>`:''}<rect x="${input}" width="${output}" height="16" fill="#ffac94"/></svg><span class="usage-model-total" title="${esc(usageValue(a,'total',false))} recorded tokens">${usageValue(a)}</span></button>`;
 }).join('');
 return `<section class="usage-model-section" aria-labelledby="usage-model-title"><div class="usage-section-head"><h2 id="usage-model-title">By model</h2><div class="usage-legend"><span><i class="usage-key-input"></i>Input</span><span><i class="usage-key-output"></i>Output</span><span><i class="usage-key-cached"></i>Cached</span></div></div><div class="usage-model-list">${rows}</div></section>`;
}
function usageExpectedAgents(){return mode()==='scrum'?['supervisor','lead','pm','ux','architect','dev','qa','watch']:['supervisor','lead','peer-1','peer-2','peer-3','watch'];}
function usageAgentLabel(id,records){return records[0]?.role||agent(id).name;}
function usageSessions(records){
 return usageGroups(records,record=>record.sessionId+'|'+usageModelKey(record)).sort((a,b)=>Math.max(...b.records.map(r=>r.at))-Math.max(...a.records.map(r=>r.at))).map(group=>{
  const first=group.records[0],date=new Intl.DateTimeFormat('en',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(Math.max(...group.records.map(r=>r.at)));
  const tasks=[...new Set(group.records.map(record=>record.taskId).filter(Boolean))];
  return `<div class="usage-session"><div class="usage-session-head"><div><strong>${esc(first.model)} <span>${esc(first.provider)}</span></strong><small>${esc(first.sessionId)} · ${date}</small></div><span class="usage-session-total">${usageValue(group.usage)}</span></div><div class="usage-session-breakdown"><span>Input <strong>${usageValue(group.usage,'input')}</strong></span><span>Output <strong>${usageValue(group.usage,'output')}</strong></span><span>Cached <strong>${usageValue(group.usage,'cached')}</strong></span></div>${tasks.length?`<div class="usage-session-tasks">${tasks.map(id=>{const task=state.tasks.find(t=>t.id===id&&t.hostId===activeHostId()&&t.project===state.project),attempts=[...new Set(group.records.filter(r=>r.taskId===id).map(r=>r.attempt).filter(Boolean))];return task?`<button type="button" data-action="task" data-task="${esc(id)}">${icon('tasks')}<span>${esc(id)}</span><small>${attempts.map(n=>'#'+n).join(', ')}</small>${icon('chevron')}</button>`:`<span>${esc(id)}</span>`;}).join('')}</div>`:''}</div>`;
 }).join('');
}
function usageAgentRows(records,total){
 const view=usageView(),filtered=view.model?records.filter(record=>usageModelKey(record)===view.model):records;
 const ids=view.model?[...new Set(filtered.map(record=>record.agentId))]:[...new Set([...usageExpectedAgents(),...filtered.map(record=>record.agentId)])];
 return ids.map(id=>{
  const items=filtered.filter(record=>record.agentId===id),a=usageAggregate(items),groups=usageGroups(items,usageModelKey),label=usageAgentLabel(id,items),percent=a.totalKnown&&total?Math.round(a.total/total*100):null;
  const models=groups.length===1?`<strong>${esc(groups[0].records[0].model)}</strong><small>${esc(groups[0].records[0].provider)}</small>`:groups.length?`<strong>${groups.length} models</strong><small>${new Set(items.map(item=>item.sessionId)).size} sessions</small>`:'<span class="usage-unreported">No usage reported</span>';
  const row=`<span class="usage-agent-identity">${botAvatar(id)}<strong>${esc(label)}</strong></span><span class="usage-agent-models">${models}</span><span class="usage-agent-tokens">${usageValue(a)}</span><span class="usage-agent-share">${percent===null?'—':percent+'%'}</span><span class="usage-agent-caret">${items.length?icon('chevron'):''}</span>`;
  return items.length?`<details class="usage-agent-group" data-usage-agent="${esc(id)}" ${view.expanded.includes(id)?'open':''}><summary class="usage-agent-row">${row}</summary><div class="usage-agent-details"><div class="usage-agent-breakdown">${[['input','Input'],['output','Output'],['cached','Cached input']].map(([type,name])=>`<span><small>${name}</small><strong>${usageValue(a,type,false)}</strong></span>`).join('')}</div><div class="usage-sessions">${usageSessions(items)}</div></div></details>`:`<div class="usage-agent-row usage-agent-unreported">${row}</div>`;
 }).join('');
}
function usageAgents(records){
 const view=usageView(),a=usageAggregate(records),model=records.find(record=>usageModelKey(record)===view.model);
 return `<section class="usage-agent-section" aria-labelledby="usage-agent-title"><div class="usage-section-head"><h2 id="usage-agent-title">By agent</h2>${model?`<button type="button" class="usage-model-clear" data-usage-clear-model>${esc(model.model)} ${icon('close')}<span class="sr-only">Clear model filter</span></button>`:`<span class="usage-section-meta">${new Set(records.map(record=>record.agentId)).size} agents reporting</span>`}</div><div class="usage-agent-table"><div class="usage-agent-columns" aria-hidden="true"><span>Agent</span><span>Recorded model</span><span>Tokens</span><span>Share</span><span></span></div>${usageAgentRows(records,a.total)}</div></section>`;
}
function renderUsage(){
 const view=usageView(),records=usageRecords(),a=usageAggregate(records);
 if(view.model&&!records.some(record=>usageModelKey(record)===view.model))view.model=null;
 const toolbar=`<div class="usage-toolbar"><details class="usage-example-note"><summary>${icon('info')}Example data ${icon('chevron')}</summary><p>Illustrative usage records, not measured from your projects. Context occupancy and next-run model settings are separate.</p></details><div class="usage-periods" role="group" aria-label="Usage period">${[['run','This run'],['24h','24h'],['7d','7d'],['all','All time']].map(([id,label])=>`<button type="button" data-usage-period="${id}" class="${view.period===id?'selected':''}" aria-pressed="${view.period===id}">${label}</button>`).join('')}</div></div>`;
 const partial=a.complete<a.count||a.cachedKnown<a.count;
 return `<div class="usage-surface">${toolbar}${usageSummary(records)}${records.length?usageChart(records)+usageAgents(records):`<div class="usage-empty">${icon('activity')}<h2>No usage reported</h2><p>${view.period==='run'?'Token usage will appear when the current run reports it.':'No usage records are available for this period.'}</p>${view.period!=='all'&&state.usageExamples.some(r=>r.hostId===activeHostId()&&r.project===state.project)?'<button type="button" class="btn ghost" data-usage-period="all">View all time</button>':''}</div>`}${records.length?`<p class="usage-reporting-note">${icon('info')}<span>${partial?'“+” means a partial recorded total; “—” means unreported. ':''}Shares use recorded tokens. Cached tokens are included in Input.</span></p>`:''}</div>`;
}
state.activityTab=state.activityTab==='timeline'?'usage':state.activityTab;
document.addEventListener('click',event=>{
 const control=event.target.closest('button');if(!control||control.disabled||state.page!=='activity')return;
 const view=usageView();
 if(control.dataset.usagePeriod){if(!['run','24h','7d','all'].includes(control.dataset.usagePeriod))return;view.period=control.dataset.usagePeriod;view.model=null;view.expanded=[];render();$('[data-usage-period="'+view.period+'"]')?.focus({preventScroll:true});return;}
 if(control.hasAttribute('data-usage-model')){view.model=view.model===control.dataset.usageModel?null:control.dataset.usageModel;view.expanded=[];render();$('[data-usage-model="'+control.dataset.usageModel+'"]')?.focus({preventScroll:true});return;}
 if(control.hasAttribute('data-usage-clear-model')){view.model=null;view.expanded=[];render();$('[data-usage-model]')?.focus({preventScroll:true});}
});
document.addEventListener('toggle',event=>{
 const details=event.target;if(!details.matches?.('details[data-usage-agent]')||state.page!=='activity')return;
 const view=usageView(),id=details.dataset.usageAgent;
 view.expanded=details.open?[...new Set([...view.expanded,id])]:view.expanded.filter(value=>value!==id);
},true);
