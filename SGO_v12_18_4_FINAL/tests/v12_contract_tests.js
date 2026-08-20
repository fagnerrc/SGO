'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const core = fs.readFileSync(path.join(ROOT, 'Index.html'), 'utf8');
const serverFiles = ['Code.gs','V10_Database.gs','V10_Communication.gs','V12_SecuritySync.gs','V12_TaskOperations.gs','V12_TimerDaily.gs','V12_Communication.gs','V12_Diagnostics.gs','V12_RpcGateway.gs'];
const server = serverFiles.map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n');

const serverFunctions = new Set(Array.from(server.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g), (match) => match[1]));
const clientCalls = new Set(Array.from(core.matchAll(/v12ServerCall\(\s*['"]([^'"]+)['"]/g), (match) => match[1]));
const missing = Array.from(clientCalls).filter((name) => !serverFunctions.has(name));
assert.deepStrictEqual(missing, [], `Frontend calls missing server functions: ${missing.join(', ')}`);
assert(core.includes("runner.sgoRpcGateway({ method: String(functionName || ''), payload: payload || {} })"), 'frontend does not use the stable RPC gateway');
assert(!core.includes('runner[functionName]'), 'dynamic google.script.run dispatch is still present');
assert(server.includes('function sgoRpcGateway'), 'RPC gateway server function missing');

function lastIndex(needle) {
  const index = core.lastIndexOf(needle);
  assert(index >= 0, `Missing client contract: ${needle}`);
  return index;
}

assert(lastIndex('initFromGoogleSheets = function ()') > core.indexOf('initFromGoogleSheets = function ()'), 'secure bootstrap override is not last');
assert(lastIndex('authenticateCorporate = function (event)') > core.indexOf('/* SGO v12'), 'server authentication override is outside the final v12 layer');
assert(lastIndex('saveTaskFromForm = function (event)') > core.indexOf('saveTaskFromForm = function (event)'), 'secure task save override is not last');

const finalBootstrap = core.slice(lastIndex('initFromGoogleSheets = function ()'));
assert(finalBootstrap.includes("v12ServerCall('loadPublicBootstrapServer'"), 'public bootstrap missing');
assert(finalBootstrap.includes("v12ServerCall('resumeSessionServer'"), 'server session resume missing');
assert(finalBootstrap.includes('v12152StartPostLoginLoads('), 'post-login loader is not called after session restore');
assert(core.includes('function v12152StartPostLoginLoads(options)') && core.includes('v12LoadCommunicationBootstrap();'), 'post-login loader does not schedule communication bootstrap');

const finalAuth = core.slice(lastIndex('authenticateCorporate = function (event)'), lastIndex('logoutCorporate = function'));
assert(finalAuth.includes("v12ServerCall('authenticateSessionServer'"), 'login is not validated on the server');
assert(!finalAuth.includes('pinHashes['), 'final login still reads PIN hashes locally');

const finalTaskSaveStart = lastIndex('saveTaskFromForm = function (event)');
const finalTaskSave = core.slice(finalTaskSaveStart, finalTaskSaveStart + 3500);
assert(finalTaskSave.includes("taskAction:existing?'update':'create'"), 'task action is not preserved in queued save');
assert(finalTaskSave.includes('V10_LEGACY.saveTaskFromForm'), 'task form no longer feeds the outbox layer');
assert(core.includes("v12ServerCall('acceptTaskOperationServer'"), 'client does not durably accept task operations on the server');
assert(core.includes("v12ServerCall('processTaskOperationQueueServer'"), 'client does not request processing of accepted operations');
assert(core.includes('SGO_V10.serverState'), 'confirmed server state is not separated from optimistic state');
assert(core.includes("indexedDB.open('SGO_V12_OUTBOX'"), 'durable IndexedDB outbox mirror missing');

assert(core.includes("taskAction: options.taskAction || ''"), 'operation context discards taskAction');
assert(core.includes("if (hint && hint !== 'update') return hint;"), 'generic update hint can still hide task transitions');
assert(core.includes("if (next.status === 'Concluída' && previousTask.status !== 'Concluída') return 'complete';"), 'completion transition inference missing');
assert(core.includes("complete: 'completeTaskServer'"), 'dedicated completion endpoint missing');
assert(core.includes("pause: 'pauseTaskServer'"), 'dedicated pause endpoint missing');
assert(core.includes("resume: 'resumeTaskServer'"), 'dedicated resume endpoint missing');

assert(server.includes("delete systemPatch.security.pinHashes;"), 'client PIN hashes are not stripped');
assert(server.includes('legacy.security.pinHashes = preservedHashes;'), 'server PIN hashes are not preserved during settings patch');
assert(server.includes("return errorResponse_('SESSION_INVALID'"), 'session validation responses missing');
assert(server.includes('changeVisibleToUserV12_'), 'incremental sync visibility filter missing');
assert(server.includes("collection === 'messages'"), 'message visibility handling missing');
assert(server.includes("['tasks','messages','conversations','conversationReads'].indexOf(collection)"), 'dedicated modules can still fall back to generic writes');
assert(server.includes('migrateLegacyCommunicationV12_'), 'legacy communication migration missing');
assert(server.includes('message._messageSequence = index - conversationMessages.length;'), 'legacy pagination sequence migration missing');

const resolveStart = server.indexOf('function resolveConversationV12_');
const resolveEnd = server.indexOf('\nfunction sendMessageServer', resolveStart);
const resolveBody = server.slice(resolveStart, resolveEnd);
assert(!resolveBody.includes('createConversationServer('), 'conversation resolver recursively acquires the write lock');

assert(server.includes("function restoreRecordFromBackupV10"), 'record restore missing');
const restoreStart = server.indexOf('function restoreRecordFromBackupV10');
const restoreEnd = server.indexOf('\nfunction listBackupsV10', restoreStart);
const restoreBody = server.slice(restoreStart, restoreEnd);
assert(!restoreBody.includes('commitStateChangesServer('), 'administrative restore still routes through session-only generic commit');
assert(restoreBody.includes("'RESTORE_RECORD'"), 'restore security audit missing');
assert(server.includes('function restoreStateSnapshotV12_'), 'safe full snapshot restore missing');

assert(core.includes('state.version = 12;'), 'frontend still saves state as an old version');
assert(server.includes('state.version = 12;'), 'server still emits an old state version');
assert(server.includes('function acceptTaskOperationServer'), 'server queue acceptance endpoint missing');
assert(server.includes('function processTaskOperationQueueServer'), 'server queue processing endpoint missing');
assert(server.includes('function processPendingTaskOperationsV125'), 'server queue contingency processor missing');
assert(server.includes("V125_SERVER_QUEUE_SHEET = 'SGO_FILA_SERVIDOR'"), 'durable server queue sheet missing');
assert(server.includes("everyMinutes(1)"), 'one-minute contingency trigger for the server queue is missing');
assert(server.includes("appendChangeOnceV12_(spreadsheet, 'tasks', taskId, currentMeta.version"), 'partial task recovery does not restore the task changelog');

const publicStateStart = server.indexOf('function publicStateV12_');
const publicStateEnd = server.indexOf('\nfunction loadPublicBootstrapServer', publicStateStart);
const publicStateBody = server.slice(publicStateStart, publicStateEnd);
assert(publicStateBody.includes('tasks: []'), 'public bootstrap exposes tasks');
assert(publicStateBody.includes('const collaborators = [];'), 'public bootstrap exposes the user directory');
assert(publicStateBody.includes('pinHashes: {}'), 'public bootstrap exposes PIN hashes');
const clearPrivateStart = core.indexOf('function v12ClearPrivateState()');
const clearPrivateEnd = core.indexOf('\n}\n\nv12HandleSessionInvalid', clearPrivateStart) + 2;
const clearPrivateBody = core.slice(clearPrivateStart, clearPrivateEnd);
assert(clearPrivateBody.includes("'collaborators'"), 'logout does not clear the private user directory');
assert(clearPrivateBody.includes("'companies'"), 'logout does not clear private company data');
assert(clearPrivateBody.includes('state.settings = {}'), 'logout does not clear private settings');

console.log('V12_CONTRACT_TESTS_OK', JSON.stringify({ clientCalls: clientCalls.size, serverFunctions: serverFunctions.size }));
