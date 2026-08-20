'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert'),vm=require('vm');
const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'Index.html'),'utf8');
const task=fs.readFileSync(path.join(root,'V12_TaskOperations.gs'),'utf8');
const sec=fs.readFileSync(path.join(root,'V12_SecuritySync.gs'),'utf8');
const diag=fs.readFileSync(path.join(root,'V12_Diagnostics.gs'),'utf8');
const daily=fs.readFileSync(path.join(root,'V12_TimerDaily.gs'),'utf8');
const gateway=fs.readFileSync(path.join(root,'V12_RpcGateway.gs'),'utf8');
let tests=0;const ok=(v,m)=>{assert(v,m);tests++;};

ok(html.includes('>v12.18.3</span>'),'v12.18.3 badge missing');
ok(html.includes('var QUEUE_SCHEMA_VERSION = 10;'),'queue schema not bumped for reset epoch migration');
ok(task.includes('SERVER_QUEUE_BLOCKED_DEPENDENCIES_SKIPPED'),'blocked dependency scan not diagnosable');
ok(task.includes('const executableRows=timeReadyRows.filter'),'worker does not separate blocked from executable rows');
ok(task.includes("blockedDependencies.push({operationId:row.operationId"),'worker does not record skipped dependency rows');
ok(task.includes("const candidates = (interactive.length ? interactive : effectsOnly).slice(0, 10)"),'worker candidate cap/order changed unexpectedly');
ok(html.includes("data.waitingDependency===true"),'client does not suppress process kick while dependency waits');
ok(html.includes("data.hasDependency&&data.waitingDependency===false"),'client does not immediately resume once dependency is ready');
ok(html.includes("!data.hasDependency&&Date.now()-lastKick>=60000"),'ordinary accepted operation re-kick is still too aggressive');
ok(html.includes('current.pollAttempts=Number(current.pollAttempts||0)+1'),'status polls still inflate write attempt counter');

ok(html.includes('id="v12181QueueReset"'),'device queue reset control missing');
ok(html.includes('SGO_LOCAL_QUEUE_RESET_BACKUP_V12_18_1'),'reset does not create technical backup');
ok(html.includes('QUEUE_RESET_EPOCH_PREFIX'),'cross-tab reset epoch missing');
ok(html.includes('queueWasResetV12181_(incoming)'),'old operations can be resurrected after reset');
ok(html.includes("v12ServerCall('discardPendingClientOperationsServer'"),'local reset is not coordinated with server');
ok(html.includes('queueApplyAuthoritativeStateAfterResetV12181_(true)'),'reset does not reload authoritative state');
ok(html.includes("queueBroadcastV1215_('queue_reset')"),'other tabs are not notified of reset');

ok(task.includes('function discardPendingClientOperationsServer'),'server discard registration endpoint missing');
ok(task.includes('USER_DISCARDED_PENDING_OPERATION:true'),'discard is not terminal in server queue');
ok(task.includes('PropertiesService.getScriptProperties().setProperties(props,false)'),'discard registry is not durable');
ok(task.includes('queueOperationDiscardedV12181_(preloadedRowV1217)'),'discard is not checked before dependency/mutation');
ok(task.includes('if (queueOperationDiscardedV12181_(row)) return finishServerQueueAttemptV125_'),'discard is not rechecked after claim');
ok(gateway.includes("case 'discardPendingClientOperationsServer': return discardPendingClientOperationsServer(payload);"),'discard endpoint missing from RPC gateway');
ok(gateway.includes("case 'acceptTaskOperationBatchServer': return acceptTaskOperationBatchServer(payload);"),'v12.18 timer batch endpoint is missing from RPC gateway');

ok(diag.includes('receivedReady:0,receivedBlocked:0'),'diagnostic lacks ready/blocked received counters');
ok(diag.includes('oldestBlockedAgeMs'),'diagnostic lacks blocked age');
ok(diag.includes('clientQueueByUser'),'diagnostic lacks active queue counts by user');
ok(html.includes('queueSummary:(typeof window.v12181QueueSummary'),'diagnostic bundle lacks local queue reset summary');
ok(html.includes("tabId:String(window.__SGO_QUEUE_TAB_ID__||'')"),'diagnostic bundle lacks browser tab id');
ok(daily.includes('function finalizeV12181Deployment()'),'v12.18.3 deployment finalizer missing');
ok(daily.includes('skipBlockedDependencies:true,dependencyAwarePolling:true,coordinatedDeviceReset:true'),'deployment does not advertise queue recovery protections');

// Exercise the real dependency-status helper: waiting only while predecessor is non-terminal.
const start=sec.indexOf('function operationDependencyInfoV12181_');
const end=sec.indexOf('\nfunction getOperationStatusServer',start);
assert(start>=0&&end>start,'could not extract dependency status helper');
const helper=sec.slice(start,end);
let dep={status:'RECEIVED'};
const context={
  getCachedServerQueueStateV1210_:()=>dep,
  getServerQueueRowV125_:()=>dep
};
vm.createContext(context);vm.runInContext(helper,context);
let result=context.operationDependencyInfoV12181_({}, {operationId:'op2',dependsOnOperationId:'op1'});
ok(result.hasDependency&&result.waitingDependency&&result.dependencyStatus==='RECEIVED','received predecessor should block dependent');
dep={status:'COMPLETED'};
result=context.operationDependencyInfoV12181_({}, {operationId:'op2',dependsOnOperationId:'op1'});
ok(result.hasDependency&&!result.waitingDependency&&result.dependencyStatus==='COMPLETED','completed predecessor should release dependent');
dep={status:'REJECTED'};
result=context.operationDependencyInfoV12181_({}, {operationId:'op2',dependsOnOperationId:'op1'});
ok(result.hasDependency&&!result.waitingDependency&&result.dependencyStatus==='REJECTED','failed predecessor must be processable into terminal dependency failure');
result=context.operationDependencyInfoV12181_({}, {operationId:'op2'});
ok(!result.hasDependency&&!result.waitingDependency,'operation without dependency was marked blocked');

console.log('V12_18_1_QUEUE_RECOVERY_TESTS_OK',JSON.stringify({tests}));
