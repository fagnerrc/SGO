'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert'),vm=require('vm');
const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'Index.html'),'utf8');
const task=fs.readFileSync(path.join(root,'V12_TaskOperations.gs'),'utf8');
const daily=fs.readFileSync(path.join(root,'V12_TimerDaily.gs'),'utf8');
let tests=0; const ok=(v,m)=>{assert(v,m);tests++;};

ok(html.includes('>v12.18.3</span>'),'v12.18 badge missing');
ok(html.includes('var QUEUE_SCHEMA_VERSION = 10;'),'v12.18 queue schema was not advanced');
ok(html.includes('function timerV1218FindActiveAction'),'client semantic duplicate detector missing');
ok(html.includes("action === 'create' || action === 'complete'"),'CREATE/COMPLETE duplicate suppression missing');
ok(html.includes('TIMER_DUPLICATE_SUPPRESSED'),'suppressed timer duplicate is not diagnosable');
ok(html.includes('function timerV1218PendingStartForUser'),'pending timer start recovery missing');
ok(html.includes("String(item.action||'')!=='create'"),'pending start recovery is not scoped to CREATE');
ok(html.includes('TIMER_START_DUPLICATE_SUPPRESSED'),'duplicate START is not diagnosable');
ok(html.includes("timerV1218FindActiveAction(queueReadAll(),taskId,'complete')"),'complete flow does not guard queued duplicate completion');
ok(html.includes('LEGACY_CREATE_CONFLICT_RESOLVED'),'legacy CREATE conflict is not auto-resolved locally');
ok(html.includes('STALE_TIMER_OPERATION_REMOVED'),'stale operations after confirmed completion are not removed');
ok(html.includes('queueDeleteOneV1215(operationId)'),'removed legacy queue entries are not tombstoned');

ok(task.includes('function taskSemanticNoopV1218_'),'server semantic idempotency helper missing');
ok(task.includes("reason = 'TASK_ALREADY_MATERIALIZED'"),'old CREATE is not treated as already materialized');
ok(task.includes("reason = normalizedAction === 'complete' ? 'TASK_ALREADY_COMPLETED' : 'STALE_TIMER_ACTION_AFTER_COMPLETION'"),'completed timer terminality missing');
ok(task.includes("reason = 'TIMER_ALREADY_PAUSED'"),'duplicate PAUSE semantic noop missing');
ok(task.includes("reason = 'TIMER_ALREADY_RUNNING'"),'duplicate RESUME semantic noop missing');
ok(task.includes('semanticNoopInitialV1218'),'semantic noop is not checked before version conflict');
ok(task.includes('semanticNoopLockedV1218'),'semantic noop is not rechecked after acquiring write lock');
ok(task.includes('!recoveringCore'),'same-operation recovery no longer has priority over semantic noop');
ok(task.includes("step:'SEMANTIC_NOOP'"),'semantic noops are not diagnosable');
ok(html.includes('function queueTimerBatchCandidatesV1218'),'timer batch acceptance helper missing');
ok(html.includes("v12ServerCall('acceptTaskOperationBatchServer'"),'timer chain does not use batch accept endpoint');
ok(html.includes('OUTBOX_BATCH_ACCEPT_RESPONSE'),'timer batch acceptance is not diagnosable');
ok(task.includes('function acceptTaskOperationBatchServer'),'server timer batch endpoint missing');
ok(task.includes('reserveServerQueueSequencesV1218_'),'batch queue sequences are not reserved under one lock');
ok(task.includes('SERVER_QUEUE_BATCH_ACCEPTED'),'server batch acceptance is not diagnosable');
ok(daily.includes('function finalizeV1218Deployment()'),'v12.18 deployment finalizer missing');
ok(daily.includes('antiDuplication:{semanticIdempotency:true,duplicateCompleteSuppression:true,legacyCreateConflictRecovery:true') && daily.includes('serverCanonicalTaskCode:true'),'deployment readiness omits anti-duplication capabilities');

// Exercise the real server helper in isolation with Apps Script dependencies stubbed.
const start=task.indexOf('function taskSemanticNoopV1218_');
const end=task.indexOf('\nfunction mutateTaskServer',start);
assert(start>=0&&end>start,'could not extract taskSemanticNoopV1218_');
const helper=task.slice(start,end);
const context={
  canMutateTaskV12_:()=>true,
  cloneObject_:v=>JSON.parse(JSON.stringify(v)),
  taskDiagnosticV128_:()=>{},
  getDatabaseVersion_:()=>50,
  getChangeSequenceV12_:()=>90,
  successResponse_:o=>Object.assign({success:true,confirmed:true,conflict:false},o)
};
vm.createContext(context); vm.runInContext(helper,context);
const user={id:'u1'};
const base={id:'t1',status:'Em andamento',_recordVersion:3,timeTracking:{enabled:true,state:'running'}};
let r=context.taskSemanticNoopV1218_('create',base,{},user,3,'op-create');
ok(r&&r.success&&r.data.semanticReason==='TASK_ALREADY_MATERIALIZED','existing CREATE did not become success/no-op');
r=context.taskSemanticNoopV1218_('resume',base,{},user,3,'op-resume');
ok(r&&r.data.semanticReason==='TIMER_ALREADY_RUNNING','duplicate RESUME did not become no-op');
r=context.taskSemanticNoopV1218_('pause',Object.assign({},base,{timeTracking:{enabled:true,state:'paused'}}),{},user,4,'op-pause');
ok(r&&r.data.semanticReason==='TIMER_ALREADY_PAUSED','duplicate PAUSE did not become no-op');
const done=Object.assign({},base,{status:'Concluída',concluidoEm:'2026-08-12T20:00:00Z',timeTracking:{enabled:true,state:'completed'}});
r=context.taskSemanticNoopV1218_('complete',done,{},user,5,'op-complete');
ok(r&&r.data.semanticReason==='TASK_ALREADY_COMPLETED','duplicate COMPLETE did not become no-op');
r=context.taskSemanticNoopV1218_('resume',done,{},user,5,'op-late');
ok(r&&r.data.semanticReason==='STALE_TIMER_ACTION_AFTER_COMPLETION','late timer action can reopen completed task');
r=context.taskSemanticNoopV1218_('update',base,{},user,3,'op-update');
ok(r===null,'ordinary UPDATE was incorrectly swallowed as semantic noop');
context.canMutateTaskV12_=()=>false;
r=context.taskSemanticNoopV1218_('create',base,{},user,3,'op-denied');
ok(r===null,'semantic noop bypassed authorization');

console.log('V12_18_ANTIDUP_TESTS_OK',JSON.stringify({tests}));
