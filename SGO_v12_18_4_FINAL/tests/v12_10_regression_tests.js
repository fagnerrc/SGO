'use strict';
const fs=require('fs'), path=require('path'), assert=require('assert');
const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'Index.html'),'utf8');
const task=fs.readFileSync(path.join(root,'V12_TaskOperations.gs'),'utf8');
const db=fs.readFileSync(path.join(root,'V10_Database.gs'),'utf8');
const sec=fs.readFileSync(path.join(root,'V12_SecuritySync.gs'),'utf8');
const rpc=fs.readFileSync(path.join(root,'V12_RpcGateway.gs'),'utf8');
const diag=fs.readFileSync(path.join(root,'V12_Diagnostics.gs'),'utf8');
const comm=fs.readFileSync(path.join(root,'V12_Communication.gs'),'utf8');

// Tarefa cronometrada: estimativa fixa e coerente ponta a ponta.
assert(html.includes("prazo: '', estimativa: 1, prioridade: 'Normal'"), 'timed task creation is not defaulting to 1 hour');
assert(html.includes("taskEstimateControl.value = timedQuickTask ? 1"), 'timed task modal does not display 1 hour');
assert(html.includes("estimativa: existingTimedQuickTask ? 1"), 'timed task edit can save another estimate');
assert(task.includes('if (isTimedQuickTask) task.estimativa = 1;'), 'server validation does not force timed estimate to 1');
assert(task.includes("task.estimativa = 1;"), 'server action enforcement does not preserve timed estimate');
assert(task.includes('Execução registrada automaticamente pelo cronômetro do SGO.'), 'timed completion still depends on manual evidence');

// Menos round-trips de planilha e sincronização vazia barata.
assert(db.includes('function v1210GetCachedRow_'), 'row cache helper missing');
assert(db.includes('function setMetaValuesV1210_'), 'batched meta writer missing');
assert(sec.includes("SGO_USER_RECORD"), 'session collaborator cache missing');
assert(sec.includes('if (after >= currentSequence)'), 'no-change sync fast path missing');
assert(sec.includes('function appendChangeWithSequenceV1210_'), 'batched changelog sequence writer missing');
assert(task.includes('CHANGE_SEQUENCE: String(taskChangeSequence)'), 'task mutation does not batch change sequence metadata');

// Fila: aceite/claim não devem competir com o lock global; worker não duplica SGO_OPERACOES.
const accept=task.slice(task.indexOf('function acceptTaskOperationServer'), task.indexOf('\nfunction claimServerQueueOperationV125_'));
const claim=task.slice(task.indexOf('function claimServerQueueOperationV125_'), task.indexOf('\nfunction temporarySessionForQueueV125_'));
const finishQueue=task.slice(task.indexOf('function finishServerQueueAttemptV125_'), task.indexOf('\nfunction processOneServerQueueOperationV125_'));
const processServer=task.slice(task.indexOf('function processTaskOperationQueueServer'), task.indexOf('\n/** Acionador de contingência'));
assert(accept.includes('tryWriteLockV12_(900)'), 'queue acceptance lacks short atomic claim lock');
assert(claim.includes('tryWriteLockV12_(900)'), 'queue claim lacks short atomic lease lock');
assert(!finishQueue.includes('setOperationV12_('), 'server queue still mirrors each attempt into SGO_OPERACOES');
assert(processServer.includes('processOneServerQueueOperationV125_'), 'queue server processor is not using single claim path');
assert(task.includes('executionPayload._fromServerQueue = true;'), 'server queue does not enable lean mutation mode');
assert(sec.includes("typeof getServerQueueRowV125_ === 'function'"), 'operation status does not fall back to server queue');

// Cliente: um kick imediato, depois status polling/backoff em vez de bombardear worker.
assert(html.includes("v12ServerCall('getOperationStatusServer'"), 'accepted operations are not polled through status API');
assert(html.includes('Date.now()-lastKick>=60000'), 'client can re-kick worker too aggressively');
assert(html.includes("data.waitingDependency===true"), 'dependency-blocked operation can still receive blind process kicks');
assert(html.includes('current.nextAttemptAt = Date.now() + Math.max(15000'), 'server-received retry interval is too short');

// Gateway robusto e comunicação presente no pacote.
assert(rpc.includes("typeof getMessagesSinceServer === 'function'"), 'RPC gateway lacks chat fallback');
assert(rpc.includes('rpcFallbackMessagesSinceV1210_'), 'RPC message fallback missing');
assert(rpc.includes('rpcFallbackCommunicationBootstrapV1210_'), 'RPC communication bootstrap fallback missing');
assert(comm.includes('function getMessagesSinceServer(payload)'), 'communication module does not expose message polling');
assert(comm.includes('function loadCommunicationBootstrapServer(payload)'), 'communication module does not expose bootstrap');
assert(comm.includes('if (after >= currentSequence)'), 'chat no-change path still scans changelog');

// Diagnóstico deve permanecer texto, não ser convertido em data pelo Sheets.
assert(diag.includes("'v12.18.3'"), 'diagnostic app version is not text-safe v12.18.3');
assert(task.includes('perfV1216.lockWaitMs = lockAcquiredAt-lockRequestedAt'), 'diagnostic lacks lock wait measurement');
assert(task.includes('perfV1216.lockHeldMs = lockReleasedAt-lockAcquiredAt'), 'diagnostic lacks lock hold measurement');

console.log('V12_10_REGRESSION_TESTS_OK', JSON.stringify({tests:29}));
