'use strict';
const fs=require('fs'), path=require('path'), assert=require('assert');
const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'Index.html'),'utf8');
const task=fs.readFileSync(path.join(root,'V12_TaskOperations.gs'),'utf8');
const db=fs.readFileSync(path.join(root,'V10_Database.gs'),'utf8');
const gateway=fs.readFileSync(path.join(root,'V12_RpcGateway.gs'),'utf8');

assert(!html.includes('runner[functionName]'), 'dynamic google.script.run dispatch remains');
assert(html.includes('runner.sgoRpcGateway'), 'stable RPC gateway not used');
assert(gateway.includes("case 'getMessagesSinceServer'"), 'chat route missing from RPC gateway');
assert(gateway.includes("case 'loadCommunicationBootstrapServer'"), 'communication bootstrap route missing');
assert(html.includes("if (!confirmedTask && !lastPending && !change.deleted) action = 'create';"), 'CREATE-first task chain protection missing');
assert(html.includes("if (item.kind === 'generic' && isTaskContext) return;"), 'legacy generic task operations are not purged');
assert(html.includes('queueMigrateStoredItems();\n      queueRender();'), 'IndexedDB hydration does not re-run queue migration');
assert(html.includes("var safeSystemPatch = taskContext ? {} : (diff.systemPatch || {});"), 'task saves can still produce accidental systemPatch commits');
assert(html.includes("var shouldFull = Boolean(forceFull) || !SGO_V10.changeSequence;"), 'periodic heavy full snapshot is still enabled');
assert((html.match(/setInterval\(heartbeat, 180000\)/g)||[]).length>=1, 'heartbeat was not reduced to 3 minutes');

const commit=db.slice(db.indexOf('function commitStateChangesServer'), db.indexOf('\nfunction restoreRecordFromBackupV10'));
assert(!commit.includes('buildScopedStateV12_('), 'generic commit still builds the full scoped state');
assert(!commit.includes('SpreadsheetApp.flush()'), 'generic commit still forces synchronous flush');
assert(commit.includes('systemFieldsChanged:Object.keys(systemPatch)'), 'generic commit does not return compact system metadata');

const accept=task.slice(task.indexOf('function acceptTaskOperationServer'), task.indexOf('\nfunction claimServerQueueOperationV125_'));
assert(!accept.includes("getRecordMeta_(spreadsheet, 'tasks'"), 'queue acceptance still reads the task');
assert(!accept.includes('setOperationV12_('), 'queue acceptance still writes duplicate operation state');
assert(!accept.includes('SpreadsheetApp.flush()'), 'queue acceptance still forces flush');
assert(accept.includes('tryWriteLockV12_(900)'), 'queue acceptance is not protected by a short atomic claim lock');

const mutate=task.slice(task.indexOf('function mutateTaskServer'), task.indexOf('\nfunction finishTaskOperationV12_'));
const release=mutate.indexOf('lock.releaseLock();');
const finish=mutate.lastIndexOf('finishTaskOperationV12_(');
assert(release>=0 && finish>release, 'task side effects are still executed while the global write lock is held');
assert(mutate.includes("appendChangeV12_(spreadsheet, 'tasks'") || mutate.includes("appendChangeWithSequenceV1210_(spreadsheet"), 'first task write does not use direct append-only changelog');
assert(task.includes('new Date(Date.now() + 120000).toISOString()'), 'server worker lease is not 2 minutes');
assert(task.includes("row.status !== 'PROCESSING'"), 'processing lease does not distinguish retry waiting');

console.log('V12_9_REGRESSION_TESTS_OK', JSON.stringify({tests:22}));
