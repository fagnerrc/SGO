'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert');
const root=path.resolve(__dirname,'..');
const read=n=>fs.readFileSync(path.join(root,n),'utf8');
const html=read('Index.html'), core=read('V10_Core.html'), code=read('Code.gs'), task=read('V12_TaskOperations.gs'), sec=read('V12_SecuritySync.gs'), db=read('V10_Database.gs'), comm=read('V12_Communication.gs'), oldComm=read('V10_Communication.gs'), rpc=read('V12_RpcGateway.gs'), daily=read('V12_TimerDaily.gs'), diag=read('V12_Diagnostics.gs');
let tests=0;
function ok(v,m){assert(v,m);tests++;}
function no(v,m){assert(!v,m);tests++;}
function before(text,a,b,m){const ia=text.indexOf(a),ib=text.indexOf(b);assert(ia>=0&&ib>=0&&ia<ib,m);tests++;}

// A — segurança e permissões
ok(task.includes('autorização NUNCA usa o estado proposto pelo'), 'task authorization is not documented/current-state based');
ok(task.includes('if (!userCanSeeTaskV12_(user, currentTask)) return false;'), 'existing task visibility is not enforced before mutation');
no(/nextTask\.responsavelId[^\n]*user\.id/.test(task.slice(task.indexOf('function canMutateTaskV12_'),task.indexOf('function taskProcessV1215_'))), 'nextTask can still grant mutation permission');
ok(task.includes('canApproveTaskServerV1215_') && task.includes("errorCode:'APPROVAL_PERMISSION'"), 'server approval authorization missing');
ok(task.includes('canAuditTaskServerV1215_') && task.includes("errorCode:'AUDIT_PERMISSION'"), 'server audit authorization missing');
ok(task.includes("COMPLETE_ACTION_REQUIRED") && task.includes("APPROVAL_WAIT_ACTION_REQUIRED") && task.includes("WAIT_ACTION_REQUIRED"), 'sensitive status transitions do not require dedicated actions');
ok(task.includes("SERVER_OWNED_FIELD"), 'server-owned approval/audit field protection missing');
ok(db.includes("if (currentRole === 'admin' || nextRole === 'admin') return false;"), 'non-admin can touch admin collaborator profile');
ok(db.includes('currentRole !== nextRole) return false;'), 'self profile elevation protection missing');
ok(comm.includes("payload.area : auth.user.area") && comm.includes("['admin','diretoria']"), 'area conversation is not server-scoped');
ok(sec.includes("const allowed = ['id','nome','email','cargo','area','empresa','perfil'"), 'collaborator payload is not whitelist-sanitized');
ok(sec.includes("collection === 'processes'") && sec.includes('companies.indexOf(data.empresa)'), 'incremental process visibility is not company-scoped');
ok(sec.includes('processApprovers') && sec.includes('process.aprovadorId'), 'process approvers cannot receive legacy approval tasks at bootstrap');
ok(sec.includes("String(task.aprovadorId || '') === String(user.id)"), 'approver visibility missing for current tasks');
ok(rpc.includes('fallback nunca pode ser mais permissivo') && rpc.includes("if (profile === 'admin') return true;"), 'RPC fallback is still more permissive than primary policy');
for(const fn of ['createTaskServer','updateTaskServer','startTaskServer','pauseTaskServer','resumeTaskServer','waitTaskServer','completeTaskServer','approveTaskOperationServer','auditTaskServer','deleteTaskServer']) ok(rpc.includes("case '"+fn+"'"), 'RPC gateway missing '+fn);
ok(html.includes('function v12ClearPrivateState()') && html.includes('STORAGE_BACKUP_KEY') && html.includes('STORAGE_TEMP_KEY') && html.includes('PREVIOUS_STORAGE_KEYS'), 'private cache purge incomplete');
ok(html.includes('function v12SessionStorageSetV1215_') && html.includes('sessionStorage.setItem(V12_SESSION_KEY') && html.includes('storageRemove(V12_SESSION_KEY)'), 'server session token is still persistently stored when sessionStorage is available');
before(html,'v12ClearPrivateState();','startupNotice = { title: \'Servidor indisponível\'', 'server failure can render stale private cache before purge');
// Auditoria final: chat de tarefa, perfis e fronteiras administrativas.
ok(sec.includes("if (taskId || String(conversation.type || '') === 'task')") && sec.includes('visibleTaskIds && visibleTaskIds[taskId]'), 'task conversations can survive after current task visibility is lost');
ok(comm.includes('function conversationVisibleForUserV1215_') && comm.includes("getRecordMeta_(spreadsheet, 'tasks', taskId)") && comm.includes('userCanSeeTaskV12_(user, task)'), 'task-chat reads do not revalidate the real current task');
ok(comm.includes('function currentTaskConversationParticipantsV1215_'), 'task-chat recipients are not rebuilt from the current task');
no(comm.includes("conversation.taskId ? { [conversation.taskId]: true } : {}"), 'task-chat still fabricates visibility from the conversation taskId');
ok(sec.includes("const taskScopedCollections = ['messages','conversations','feedbacks','audits','activity']") && sec.includes('return Boolean(visibleTaskIds && visibleTaskIds[String(visibility.taskId)])'), 'incremental task-scoped records can bypass current task visibility');
no(sec.slice(sec.indexOf('function buildScopedStateV12_'),sec.indexOf('function changeVisibleToUserV12_')).includes('buildAuthoritativeState_('), 'scoped bootstrap still loads the entire authoritative private state before filtering');
ok(comm.includes('function messageIdsForConversationsV1215_') && sec.includes('messageIdsForConversationsV1215_'), 'communication bootstrap still performs one full index scan per conversation');
ok(db.includes("if (currentRecord && currentRole !== nextRole) return false;") && db.includes("if (!currentRecord && nextRole !== 'colaborador') return false;"), 'non-admin collaborator managers can still elevate roles');
ok(html.includes('profileSelect.disabled = !isAdminEditor;'), 'non-admin collaborator UI still allows profile changes');
ok(sec.includes('function trustedEditorExecutionV1215_') && sec.includes('Session.getActiveUser') && sec.includes('Session.getEffectiveUser'), 'editor-only administrative boundary is missing');
ok(sec.includes('function trustedTriggerInvocationV1215_') && sec.includes('trigger.getUniqueId'), 'trigger handlers do not validate installed trigger identity');
ok(oldComm.includes("trustedTriggerInvocationV1215_('generateDeadlineNotificationsV10', event)"), 'deadline public trigger wrapper is not protected');
ok(daily.includes("trustedTriggerInvocationV1215_('generateDailyTasksV1214', event)"), 'daily public trigger wrapper is not protected');
ok(task.includes("trustedTriggerInvocationV1215_('processPendingTaskOperationsV125', event)"), 'queue public trigger wrapper is not protected');
ok(code.includes('trustedEditorExecutionV1215_') && code.includes('EDITOR_EXECUTION_REQUIRED'), 'setupSGO can be invoked without a trusted editor context');

// B — cronômetro/fila local
ok(html.includes("QUEUE_OP_PREFIX = 'sgo_v12_15_outbox_op_'"), 'outbox is not per-operation');
ok(html.includes("QUEUE_TOMBSTONE_PREFIX = 'sgo_v12_15_outbox_tombstone_'"), 'outbox tombstones missing');
ok(html.includes("BroadcastChannel('SGO_V12_15_SYNC')"), 'multi-tab broadcast coordination missing');
ok(html.includes('QUEUE_PROCESS_LEASE_PREFIX'), 'multi-tab processing lease missing');
ok(html.includes('queueStorageSetRawV1215_(QUEUE_OP_PREFIX + idValue'), 'queue operation is not persisted independently');
ok(html.includes('queueStorageRemoveRawV1215_(QUEUE_OP_PREFIX + operationId)'), 'completed operation is not independently removed');
ok(html.includes("return 'approval_wait';") && html.includes("return 'wait';"), 'client does not infer dedicated waiting actions');
ok(task.includes("action === 'wait' || action === 'approval_wait'"), 'server dedicated wait actions missing');
ok(task.includes('resolveTaskActionTimeV1214_(payload, now, action)'), 'client action time not honored by server');
ok(task.includes('dueAt < completionAt'), 'late completion is not compared with action/completion time');
ok(daily.includes('V1215_TIMER_REGISTRY_READY_PROP'), 'timer registry migration marker missing');
ok(daily.includes('timerRegistryReadyV1215_()'), 'hot path cannot avoid full timer scan after migration');
ok(daily.includes('function repairTimerSlotsV1215_()'), 'timer-slot background reconciliation missing');
ok(task.includes('repairTimerSlotsV1215_'), 'timer-slot reconciliation not wired into maintenance');
ok(html.includes('timerV1214RequireDurableLocal'), 'timer handoff does not require durable local save');
before(html,'queueAdd(item)','timerV1214RequireDurableLocal(operationId)', 'timer is released before local operation is queued');

// C — consistência do servidor e credenciais
ok(sec.includes("return 'v2:' + Utilities.base64EncodeWebSafe(signature)"), 'strong credential format missing');
ok(sec.includes('computeHmacSha256Signature') && sec.includes('credentialPepperV1215_'), 'credential HMAC/pepper missing');
ok(sec.includes('randomTemporaryPinV1215_'), 'random temporary PIN generator missing');
no(html.includes("':2026'"), 'client still generates universal 2026 PIN');
no(html.includes('Redefinir o PIN para 2026'), 'UI still exposes universal reset PIN');
no(html.includes(':2026'), 'production Index still creates a universal legacy PIN');
no(core.includes("pin: '2026'") || core.includes('para 2026'), 'V10 core still resets credentials to universal PIN 2026');
no(sec.includes("credentialHashV12_(String(person.id) + ':2026')"), 'server setup still provisions missing users with universal PIN 2026');
ok(sec.includes('const temporaryPins = [];') && sec.includes('credentialHashV1215_(userId, pin)') && sec.includes('result.temporaryPins = temporaryPins'), 'setup does not generate/report random temporary credentials for users missing a credential');
ok(sec.includes('temporaryPins: cloneObject_(securitySetup && securitySetup.temporaryPins || [])'), 'setup response does not surface one-time temporary credentials to the authorized operator');
ok(db.includes('persistedResult.data.temporaryPins = [];'), 'temporary PIN is persisted in operation history');
ok(sec.includes('V1215_LOGIN_ATTEMPT_PREFIX') && sec.includes('PropertiesService.getScriptProperties()'), 'login throttle is not durable');
ok(db.includes("CORRUPT_RECORD_SKIPPED") && db.includes('catch (error)'), 'corrupt JSON does not isolate a single row');
ok(db.includes("throw new Error('CORRUPT_RECORD"), 'writes can overwrite a corrupt row silently');
ok(task.includes('const effectsLock = tryWriteLockV12_(1800);'), 'task side effects do not serialize changelog changes');
ok(task.includes('const acceptLock = tryWriteLockV12_(900)') || task.includes('tryWriteLockV12_(900)'), 'server queue accept/claim short atomic lock missing');
ok(sec.includes('CHANGELOG_LOCK_REQUIRED'), 'unlocked changelog append is not blocked');
ok(task.includes('appendChangeOnceV12_') && task.includes('effectsLock.releaseLock()'), 'side-effect changelog writes are not under short lock');
ok(oldComm.includes('deadlineNotificationIdV1215_'), 'deadline notification deterministic ID missing');
ok(oldComm.includes('const lock = tryWriteLockV12_(1800);'), 'deadline trigger still holds long global lock');
before(oldComm,"const tasks = readCollectionRecords_(spreadsheet, 'tasks', false);",'const lock = tryWriteLockV12_(1800);','deadline trigger still performs heavy reads inside lock');

// D — desempenho, manutenção e recorrência
ok(task.includes("V1215_SERVER_QUEUE_ARCHIVE_SHEET = 'SGO_FILA_ARQUIVO'"), 'server queue archive missing');
ok(task.includes('maintenanceDeferred:Boolean(candidates.length)') && task.includes('Nunca executa compactação/retenção antes de operações pendentes'), 'queue maintenance does not yield to pending interactive operations');
ok(sec.includes("MIN_CHANGE_SEQUENCE") && sec.includes('fullSnapshotRequired:true'), 'changelog retention cannot force safe full snapshot');
ok(html.includes('fullSnapshotRequired') && html.includes('v10SyncNow(true)'), 'client does not recover from compacted changelog');
ok(sec.includes("V1215_CHANGELOG_ARCHIVE_SHEET = 'SGO_CHANGELOG_ARQUIVO'") && sec.includes('removed.map(function(row){return row.concat([archivedAt]);})'), 'changelog compaction does not archive removed rows');
ok(sec.includes("V1215_OPERATION_ARCHIVE_SHEET = 'SGO_OPERACOES_ARQUIVO'") && sec.includes('activePreserved:active.length'), 'operation compaction does not archive finals while preserving active rows');
ok(sec.includes('maintainOperationHistoryV1215_'), 'operation history retention missing');
ok(db.includes('function maintainBackupsV1215_') && db.includes('Math.max(5,Number(maxBackups||20))'), 'backup retention helper missing or unsafe minimum changed');
ok(db.includes('maintainBackupsV1215_(spreadsheet,20)'), 'backup creation does not enforce 20-backup retention');
ok(sec.includes('cleanupExpiredSessionsV1215_'), 'expired session cleanup missing');
no(daily.includes('SGO_DAILY_TASKS_LAST_SUCCESS_DATE'), 'global daily-run flag can suppress same-day templates');
ok(daily.includes('validateDailyTemplateReferencesV1215_'), 'daily task references are not revalidated');
ok(daily.includes("approvalStatus:'not_required'") || daily.includes("approvalStatus ="), 'daily approval state is not recomputed');
ok(daily.includes('function finalizeV1215Deployment()') && daily.includes('function finalizeV1216Deployment()') && daily.includes('function finalizeV1217Deployment()'), 'deployment finalizer or v12.17 alias missing');
ok(daily.includes('readyForPublish') && daily.includes('NÃO PUBLIQUE'), 'deployment finalizer does not block publish on migration conflicts');
ok(daily.includes('credentialPepperV1215_') && daily.includes('cleanupExpiredSessionsV1215_'), 'deployment finalizer does not initialize security maintenance');
ok(diag.includes('}).slice(0,120).map(function(data)') && !diag.includes('meta.data'), 'recent diagnostic error parser still expects meta.data wrapper');
ok(sec.includes("const SGO_APP_VERSION_V1215 = '12.18.3'"), 'server version constant wrong');
ok(html.includes('>v12.18.3</span>'), 'client build badge wrong');

// O legado permanece por compatibilidade, mas cada ação crítica deve ter uma única implementação final explícita.
for(const name of ['startTimedTask','pauseTimedTask','resumeTimedTask','saveTimerWait','completeTimedTask']) {
  const assign=(html.match(new RegExp('\\b'+name+'\\s*=\\s*function\\s*\\(','g'))||[]).length;
  assert.strictEqual(assign,1,'multiple final timer overrides for '+name);tests++;
}

console.log('V12_15_HARDENING_TESTS_OK',JSON.stringify({tests}));
