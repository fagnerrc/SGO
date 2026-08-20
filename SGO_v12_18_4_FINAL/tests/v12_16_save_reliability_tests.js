'use strict';
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(root,'Index.html'),'utf8');
const core=fs.readFileSync(path.join(root,'V10_Core.html'),'utf8');
const task=fs.readFileSync(path.join(root,'V12_TaskOperations.gs'),'utf8');
const sec=fs.readFileSync(path.join(root,'V12_SecuritySync.gs'),'utf8');
const diag=fs.readFileSync(path.join(root,'V12_Diagnostics.gs'),'utf8');
const daily=fs.readFileSync(path.join(root,'V12_TimerDaily.gs'),'utf8');
function ok(v,m){if(!v)throw new Error(m);tests++;}
function no(v,m){if(v)throw new Error(m);tests++;}
let tests=0;

// Release coherence.
ok(html.includes('>v12.18.3</span>'),'v12.17 client badge missing');
ok(sec.includes("const SGO_APP_VERSION_V1215 = '12.18.3'"),'v12.17 server version missing');
ok(daily.includes('function finalizeV1217Deployment()'),'v12.17 deployment finalizer missing');

// Bloco 1: observabilidade ponta a ponta, sempre correlacionada por operationId.
for(const step of ['TASK_SAVE_CLICK','TASK_SAVE_DIFF_READY','OUTBOX_ACCEPT_START','OUTBOX_ACCEPT_RESPONSE','OUTBOX_PROCESS_START','OUTBOX_PROCESS_RESPONSE','OUTBOX_CONFIRMED']) {
  ok(html.includes("'"+step+"'") || html.includes('"'+step+'"'),'client save diagnostic step missing: '+step);
}
for(const step of ['SERVER_QUEUE_ACCEPTED','SERVER_QUEUE_CLAIMED','SERVER_QUEUE_PROCESS_COMPLETE','MUTATION_START','MUTATION_COMPLETED','CORE_CONFIRMED_EFFECTS_PENDING']) {
  ok(task.includes("step:'"+step+"'") || task.includes('step:"'+step+'"'),'server save diagnostic step missing: '+step);
}
ok(diag.includes('function diagnoseV1216TaskSavePerformance()'),'task-save performance diagnostic missing');
ok(diag.includes('operationId') && diag.includes('stepStats') && diag.includes('operations:operations') && diag.includes('steps:timeline.map'),'diagnostic does not correlate save timelines');

// Bloco 2: fila mais leve e manutenção de baixa prioridade.
const writeQueue=task.slice(task.indexOf('function writeServerQueueRowV125_'),task.indexOf('\nfunction sanitizeQueuedTaskPayloadV125_'));
ok(writeQueue.includes('rowNumber = sheet.getLastRow() + 1'),'new queue row is not written at known row');
ok(writeQueue.includes("v1210SetCachedRow_('SGO_SERVER_QUEUE_ROW', rowData.operationId, rowNumber)"),'new queue row is not cached immediately');
no(writeQueue.includes('appendRow('),'hot queue write still uses appendRow');
const pendingWorker=task.slice(task.indexOf('function processPendingTaskOperationsV1215_'),task.indexOf('/** Handler público do worker'));
ok(pendingWorker.includes("row.status === 'RECEIVED' || row.status === 'EFFECTS_PENDING'"),'worker does not recover pending side effects');
ok(pendingWorker.indexOf('candidates.forEach') < pendingWorker.indexOf('flushDiagnosticsV128_'),'worker candidate processing missing');
ok(pendingWorker.includes('if (!candidates.length)') && pendingWorker.includes('maintainServerQueueV1215_(spreadsheet)'),'maintenance is not deferred until queue is idle');
ok(pendingWorker.includes('maintenanceDeferred:Boolean(candidates.length)'),'maintenance deferral is not observable');

// Bloco 3: confirmação do core separada de atividade/notificações.
ok(task.includes("row.status = 'EFFECTS_PENDING'"),'server queue has no effects-pending recovery state');
ok(task.includes('sideEffectsPending:Boolean(sideEffectsPending)'),'core success does not expose side-effect recovery state');
ok(task.includes("step:'CORE_CONFIRMED_EFFECTS_PENDING'"),'core-confirmed effect failure is not logged');
ok(sec.includes("EFFECTS_PENDING:'completed'"),'client status does not treat persisted core as completed');
ok(task.includes('sequenceCursorSafe:false'),'task results do not protect incremental-sync cursor from partial operation responses');
ok(html.includes('result.data.sequenceCursorSafe === true'),'client can advance sync cursor from operation-scoped responses without an explicit completeness guarantee');
const unsafeCursorAdvances=(html.match(/SGO_V10\.changeSequence = Math\.max/g)||[]).length;
const guardedCursorAdvances=(html.match(/sequenceCursorSafe === true\) SGO_V10\.changeSequence = Math\.max/g)||[]).length;
ok(unsafeCursorAdvances===guardedCursorAdvances,'an operation response can still advance the global changelog cursor without an explicit completeness guarantee');
const finishEffects=task.slice(task.indexOf('function finishTaskOperationV12_'),task.indexOf('\nfunction taskStatusIsLateV12_'));
ok(finishEffects.includes('appendChangeV12_(') && finishEffects.includes('appendChangeOnceV12_('),'effect changelog lacks fast path + recovery path');
ok(finishEffects.includes('effectsLockWaitMs') && finishEffects.includes('effectsLockHeldMs'),'effect lock timing is not measured');

// Bloco 4: cliques repetidos antes do aceite devem atualizar a mesma outbox.
ok(html.includes('canCoalesceV1216'),'pending task updates are not coalesced');
ok(html.includes('!lastPending.serverAccepted') && html.includes('Number(lastPending.attempts||0) === 0') && html.includes('!Number(lastPending.lastAttemptAt||0)'),'coalescing can modify an operation that may already have reached the server');
ok(html.includes("item.coalescedUpdate && !existingV1216.serverAccepted && String(existingV1216.status||'') === 'queued' && Number(existingV1216.attempts||0) === 0"),'queueAdd does not limit coalescing to pre-network operations');
ok(html.includes('OUTBOX_COALESCED'),'coalescing is not observable');
ok(html.includes('Salvo neste dispositivo'),'UI still calls a merely local outbox save a server save');

// Task save should avoid a global full-state diff when an explicit task context exists.
ok(html.lastIndexOf('saveTaskFromForm = function') < html.lastIndexOf('initFromGoogleSheets();'),'final task-save implementation is assigned after bootstrap starts');
ok(html.indexOf("document.getElementById('taskForm').addEventListener('submit', saveTaskFromForm)") < html.lastIndexOf('initFromGoogleSheets();'),'task submit binding definition missing before bootstrap');
ok(html.includes('function v1216BuildTaskScopedDiff(context)'),'task-scoped diff helper missing in Index');
ok(core.includes('function v1216BuildTaskScopedDiff(context)'),'task-scoped diff helper missing in Core source');
ok(html.includes("context.module === 'tasks' && typeof v1216BuildTaskScopedDiff === 'function'"),'task save does not select scoped diff');
ok(html.includes('if (!SGO_V10.operationContext)') && html.includes('return v10SaveState(options);'),'final saveState path does not preserve explicit task context');

// Login optimization remains but yields to an immediate interactive save.
ok(html.includes('function v1216RunPostLoginWhenIdle'),'post-login priority helper missing');
ok(html.includes('SGO_V10.saveInProgress || SGO_V10.queueEnqueueInProgress || SGO_V10.queueProcessing'),'post-login work does not yield to writes');
ok(html.includes('}, 800, 4);') && html.includes('}, 2500, 8);'),'secondary loads are not delayed after login');

// No destructive DB/schema migration was introduced by this save release.
no(task.includes('deleteSheet('),'task save release contains destructive sheet deletion');

console.log('V12_16_SAVE_RELIABILITY_TESTS_OK',JSON.stringify({tests}));
