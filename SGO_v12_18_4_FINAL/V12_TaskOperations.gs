/** SGO v12.18.4 — identidade canônica de tarefas, recuperação de cronômetro congelado e persistência estável. */
function taskTimeZoneV1214_() {
  try { if (typeof v1214TimeZone_ === 'function') return v1214TimeZone_(); } catch (ignored) {}
  try { return Session.getScriptTimeZone() || 'America/Bahia'; } catch (ignored2) { return 'America/Bahia'; }
}

function taskHasManualDeadlineV1214_(task) {
  if (!task || typeof task !== 'object') return false;
  if (task.prazoManual === true) return true;
  if (task.prazoManual === false) return false;
  return Boolean(String(task.prazo || '').trim() && task.prazoAutomatico !== true);
}

function taskDiagnosticV128_(entry) {
  try { if (typeof logDiagnosticV128_ === 'function') logDiagnosticV128_(entry || {}); }
  catch (ignored) {}
}

function taskPerfContextV1216_(metrics) {
  const output = {};
  Object.keys(metrics || {}).forEach(function(key) {
    const value = Number(metrics[key] || 0);
    if (Number.isFinite(value) && value >= 0) output[key] = Math.round(value);
  });
  return output;
}

function taskCoreSuccessV1216_(operationId, action, core, sequence, sideEffectsPending, sideEffectsError) {
  const changedRecords = [{
    collection:'tasks', id:core.storedTask.id, version:Number(core.version || 0),
    deleted:Boolean(core.deleted), data:core.storedTask
  }];
  return successResponse_({
    operationId:operationId,
    recordId:core.storedTask.id,
    recordVersion:Number(core.version || 0),
    databaseVersion:Number(core.databaseVersion || getDatabaseVersion_()),
    data:{
      action:action,
      task:core.storedTask,
      changedRecords:changedRecords,
      sequence:Number(sequence || getChangeSequenceV12_()),
      sequenceCursorSafe:false,
      recovered:Boolean(core.recovering),
      sideEffectsPending:Boolean(sideEffectsPending),
      sideEffectsError:sideEffectsPending ? String(sideEffectsError || 'TASK_SIDE_EFFECT_PENDING') : ''
    }
  });
}


/**
 * v12.18 — idempotência semântica.
 * O operationId protege retries da mesma requisição. Esta camada protege o caso
 * em que uma ação equivalente nasceu com OUTRO operationId (duplo clique, aba
 * antiga, resposta perdida ou CREATE local sobrevivente). Não altera a tarefa:
 * devolve o estado já confirmado como sucesso/no-op.
 */
function taskSemanticNoopV1218_(action, currentTask, incomingTask, user, serverVersion, operationId, clientActionAt) {
  if (!currentTask || !currentTask.id || !user) return null;
  let allowed = false;
  try { allowed = canMutateTaskV12_(user, currentTask, currentTask, false); } catch (ignored) {}
  if (!allowed) return null;

  const normalizedAction = String(action || 'update');
  const tracking = currentTask.timeTracking && typeof currentTask.timeTracking === 'object' ? currentTask.timeTracking : {};
  const timerState = String(tracking.state || '');
  const completed = String(currentTask.status || '') === 'Concluída'
    || String(currentTask.status || '') === 'Auditada'
    || String(currentTask.status || '') === 'Cancelada'
    || timerState === 'completed'
    || Boolean(currentTask.concluidoEm);
  const timerActionsV12184 = ['start','pause','resume','wait','approval_wait','complete'];
  const incomingActionMsV12184 = clientActionAt ? new Date(clientActionAt).getTime() : 0;
  const serverTimerAtV12184 = new Date(tracking.lastChangedAt || tracking.completedAt || currentTask.concluidoEm || 0).getTime();
  let reason = '';

  // Um CREATE antigo da mesma taskId não deve virar conflito quando a tarefa já
  // existe. Como a função não grava nada, uma tentativa maliciosa também não
  // sobrescreve o registro existente.
  if (normalizedAction === 'create') reason = 'TASK_ALREADY_MATERIALIZED';
  else if (completed && timerActionsV12184.indexOf(normalizedAction) >= 0) {
    reason = normalizedAction === 'complete' ? 'TASK_ALREADY_COMPLETED' : 'STALE_TIMER_ACTION_AFTER_COMPLETION';
  } else if (timerActionsV12184.indexOf(normalizedAction) >= 0
      && Number.isFinite(incomingActionMsV12184) && incomingActionMsV12184 > 0
      && Number.isFinite(serverTimerAtV12184) && serverTimerAtV12184 > 0
      && incomingActionMsV12184 <= serverTimerAtV12184) {
    // v12.18.4: um comando antigo não pode vencer um comando mais novo já confirmado.
    // A hora vem do clique original (clientActionAt), não da hora em que o worker
    // conseguiu executar a fila. Isso mantém PAUSE/RESUME/COMPLETE monotônicos mesmo
    // quando o Apps Script passa minutos congestionado.
    reason = 'STALE_TIMER_COMMAND';
  } else if (normalizedAction === 'pause' && timerState === 'paused') reason = 'TIMER_ALREADY_PAUSED';
  else if (normalizedAction === 'resume' && timerState === 'running') reason = 'TIMER_ALREADY_RUNNING';
  else if (normalizedAction === 'wait' && timerState === 'waiting') reason = 'TIMER_ALREADY_WAITING';
  else if (normalizedAction === 'approval_wait' && timerState === 'approval') reason = 'TIMER_ALREADY_WAITING_APPROVAL';

  if (!reason) return null;
  const existing = cloneObject_(currentTask);
  const version = Math.max(0, Number(serverVersion || existing._recordVersion || 0));
  taskDiagnosticV128_({
    level:'INFO', origin:'server', module:'tasks', step:'SEMANTIC_NOOP',
    operationId:String(operationId || ''), userId:String(user.id || ''), entityId:String(existing.id || ''),
    action:normalizedAction, status:'confirmed', recordVersion:version,
    context:{reason:reason,timerState:timerState,serverStatus:String(existing.status || ''),clientActionAt:String(clientActionAt || ''),serverTimerAt:String(tracking.lastChangedAt || tracking.completedAt || currentTask.concluidoEm || '')}
  });
  return successResponse_({
    operationId:String(operationId || ''), recordId:String(existing.id || ''), recordVersion:version,
    databaseVersion:getDatabaseVersion_(),
    data:{
      action:normalizedAction, task:existing,
      changedRecords:[{collection:'tasks',id:String(existing.id || ''),version:version,deleted:false,data:existing}],
      sequence:getChangeSequenceV12_(), sequenceCursorSafe:false,
      semanticNoop:true, semanticReason:reason
    }
  });
}

/**
 * v12.18.4 — código visível de tarefa controlado pelo servidor.
 *
 * Antes cada navegador executava nextTaskCode() usando uma sequência local. Dois
 * colaboradores podiam, portanto, propor SGO-001008 ao mesmo tempo. O id interno
 * continuava diferente, mas o código humano duplicado contaminava a fila, a UI e
 * o suporte. A partir desta versão o código proposto pelo navegador é apenas
 * temporário: CREATE recebe um código canônico dentro do mesmo ScriptLock que
 * persiste a tarefa, e atualizações nunca podem trocar esse código.
 */
const V12183_TASK_CODE_SEQUENCE_PROP = 'SGO_V12183_TASK_CODE_SEQUENCE';
function taskCodeNumberV12183_(code) {
  const match = /^SGO-(\d{1,12})$/i.exec(String(code || '').trim());
  if (!match) return 0;
  const value = Number(match[1] || 0);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
function taskCodeFormatV12183_(value) {
  return 'SGO-' + String(Math.max(1, Number(value || 1))).padStart(6, '0');
}
function taskCodeSequenceStateV12183_(spreadsheet) {
  const tasks = readCollectionRecords_(spreadsheet, 'tasks', true) || [];
  let highest = 0;
  const used = {};
  tasks.forEach(function(task) {
    const code = String(task && task.code || '').trim().toUpperCase();
    const number = taskCodeNumberV12183_(code);
    if (!number) return;
    highest = Math.max(highest, number);
    used[code] = true;
  });
  return {highest:highest, used:used, count:tasks.length};
}
function ensureTaskCodeSequenceV12183_(spreadsheet) {
  spreadsheet = spreadsheet || getSpreadsheet_();
  const props = PropertiesService.getScriptProperties();
  const configured = Math.max(0, Number(props.getProperty(V12183_TASK_CODE_SEQUENCE_PROP) || 0));
  const state = taskCodeSequenceStateV12183_(spreadsheet);
  const next = Math.max(1, configured, state.highest + 1);
  props.setProperty(V12183_TASK_CODE_SEQUENCE_PROP, String(next));
  return {next:next,highest:state.highest,count:state.count};
}
function allocateTaskCodeV12183_(spreadsheet) {
  spreadsheet = spreadsheet || getSpreadsheet_();
  const props = PropertiesService.getScriptProperties();
  let sequence = Math.max(0, Number(props.getProperty(V12183_TASK_CODE_SEQUENCE_PROP) || 0));
  if (!sequence) sequence = ensureTaskCodeSequenceV12183_(spreadsheet).next;
  const code = taskCodeFormatV12183_(sequence);
  props.setProperty(V12183_TASK_CODE_SEQUENCE_PROP, String(sequence + 1));
  return code;
}
function repairDuplicateTaskCodesV12183_() {
  const spreadsheet = getSpreadsheet_();
  const lock = tryWriteLockV12_(5000);
  if (!lock) return {success:false,busy:1,updated:0,duplicateGroups:0,message:'Banco ocupado; execute novamente.'};
  try {
    const allTasks = readCollectionRecords_(spreadsheet, 'tasks', true) || [];
    const activeTasks = readCollectionRecords_(spreadsheet, 'tasks', false) || [];
    const activeIds = {};
    activeTasks.forEach(function(task){ if(task && task.id) activeIds[String(task.id)] = true; });
    const groups = {}, used = {};
    let highest = 0;
    allTasks.forEach(function(task) {
      if (!task || !task.id) return;
      const code = String(task.code || '').trim().toUpperCase();
      const number = taskCodeNumberV12183_(code);
      if (!number) return;
      highest = Math.max(highest, number);
      used[code] = true;
      (groups[code] || (groups[code] = [])).push(task);
    });
    const props = PropertiesService.getScriptProperties();
    let sequence = Math.max(highest + 1, Number(props.getProperty(V12183_TASK_CODE_SEQUENCE_PROP) || 0), 1);
    function nextFreeCode() {
      let code = taskCodeFormatV12183_(sequence++);
      while (used[code]) code = taskCodeFormatV12183_(sequence++);
      used[code] = true;
      return code;
    }
    const repairs = [];
    Object.keys(groups).sort().forEach(function(code) {
      const group = groups[code] || [];
      if (group.length <= 1) return;
      const active = group.filter(function(task){ return activeIds[String(task.id || '')]; });
      if (!active.length) return;
      const hasInactiveCopy = group.length > active.length;
      active.sort(function(a,b) {
        const ta = new Date(String(a.criadoEm || a._serverUpdatedAt || 0)).getTime() || 0;
        const tb = new Date(String(b.criadoEm || b._serverUpdatedAt || 0)).getTime() || 0;
        return ta - tb || String(a.id || '').localeCompare(String(b.id || ''));
      });
      // Se o mesmo código também pertence a um registro excluído, preservamos o
      // histórico excluído e renumeramos todas as cópias ativas. Caso contrário,
      // a ocorrência ativa mais antiga mantém o número original.
      const startAt = hasInactiveCopy ? 0 : 1;
      for (let index = startAt; index < active.length; index += 1) {
        repairs.push({task:active[index],oldCode:code,newCode:nextFreeCode()});
      }
    });

    let databaseVersion = getDatabaseVersion_();
    let changeSequence = getChangeSequenceV12_();
    const now = new Date().toISOString();
    let updated = 0;
    repairs.forEach(function(item) {
      const taskId = String(item.task && item.task.id || '');
      const meta = taskId ? getRecordMeta_(spreadsheet, 'tasks', taskId) : null;
      if (!meta || meta.deleted || !meta.data) return;
      // Só altera se o registro ainda possuir o código duplicado encontrado no
      // início da migração. Isso evita sobrescrever uma edição concorrente.
      if (String(meta.data.code || '').trim().toUpperCase() !== String(item.oldCode || '').toUpperCase()) return;
      const next = cloneObject_(meta.data);
      const previousCode = String(next.code || '');
      next.code = item.newCode;
      next.atualizadoEm = now;
      next.historico = Array.isArray(next.historico) ? next.historico : [];
      next.historico.push({at:now,userId:'system',action:'Código duplicado corrigido automaticamente: ' + previousCode + ' → ' + item.newCode,fromStatus:String(next.status || ''),toStatus:String(next.status || '')});
      next.historico = next.historico.slice(-500);
      const version = Number(meta.version || 0) + 1;
      databaseVersion += 1;
      changeSequence += 1;
      const opId = 'task-code-repair:' + taskId + ':' + String(version);
      next._collection = 'tasks';
      next._recordVersion = version;
      next._updatedBy = 'system';
      next._serverUpdatedAt = now;
      next._lastOperationId = opId;
      next._databaseVersionAtWrite = databaseVersion;
      upsertRecord_(spreadsheet, 'tasks', taskId, version, false, now, 'system', opId, next);
      appendChangeWithSequenceV1210_(spreadsheet, changeSequence, 'tasks', taskId, version, false, now, 'system', opId, next);
      updated += 1;
      taskDiagnosticV128_({level:'WARN',origin:'server',module:'tasks',step:'DUPLICATE_TASK_CODE_REPAIRED',operationId:opId,userId:'system',entityId:taskId,action:'repair_code',status:'confirmed',recordVersion:version,context:{oldCode:previousCode,newCode:item.newCode}});
    });
    props.setProperty(V12183_TASK_CODE_SEQUENCE_PROP, String(Math.max(sequence, highest + 1)));
    if (updated) {
      setMetaValuesV1210_({
        CHANGE_SEQUENCE:String(changeSequence), DATABASE_VERSION:String(databaseVersion),
        LAST_OPERATION_ID:'task-code-repair', LAST_WRITE_AT:now, LAST_WRITE_USER:'system', LAST_WRITE_MODULE:'tasks:code-repair'
      });
    }
    const duplicateGroups = Object.keys(groups).filter(function(code){ return (groups[code] || []).length > 1; }).length;
    return {success:true,busy:0,updated:updated,duplicateGroups:duplicateGroups,nextCode:taskCodeFormatV12183_(Math.max(sequence, highest + 1)),scanned:allTasks.length};
  } catch(error) {
    return {success:false,busy:0,updated:0,error:safeErrorMessage_(error)};
  } finally { lock.releaseLock(); }
}

/** v12.18.2 — tombstone de tarefa cronometrada descartada pelo usuário.
 * Impede que CREATE/PAUSE/RESUME/WAIT/COMPLETE antigos ressuscitem uma tarefa
 * depois de o usuário escolher explicitamente “Descartar”. */
const V12182_TIMER_ABANDON_PREFIX = 'SGO_V12182_TIMER_ABANDON_';
function timerAbandonPropertyKeyV12182_(taskId) {
  return V12182_TIMER_ABANDON_PREFIX + String(taskId || '').replace(/[^A-Za-z0-9_-]/g,'_').slice(0,140);
}
function timerAbandonInfoV12182_(taskId) {
  try { const raw=PropertiesService.getScriptProperties().getProperty(timerAbandonPropertyKeyV12182_(taskId)); return raw ? JSON.parse(raw) : null; }
  catch (ignored) { return null; }
}
function timerActionBlockedByAbandonV12182_(action, taskId, userId) {
  const info=timerAbandonInfoV12182_(taskId);
  // v12.18.4: o tombstone pertence à taskId, não ao navegador que clicou em
  // Descartar. Assim uma operação antiga enviada por outra aba/usuário autorizado
  // também não consegue ressuscitar o mesmo cronômetro.
  if(!info) return false;
  return ['create','start','pause','resume','wait','approval_wait','complete'].indexOf(String(action||''))>=0;
}
function abandonedTimerNoopV12182_(operationId, action, taskId, currentTask, serverVersion) {
  const task=currentTask ? cloneObject_(currentTask) : null;
  taskDiagnosticV128_({level:'INFO',origin:'server',module:'timer',step:'ABANDONED_TIMER_NOOP',operationId:String(operationId||''),entityId:String(taskId||''),action:String(action||''),status:'confirmed',recordVersion:Number(serverVersion||0),context:{reason:'TASK_ABANDONED_BY_USER'}});
  return successResponse_({operationId:String(operationId||''),recordId:String(taskId||''),recordVersion:Number(serverVersion||0),databaseVersion:getDatabaseVersion_(),data:{action:String(action||''),task:task,changedRecords:task?[{collection:'tasks',id:String(taskId||''),version:Number(serverVersion||0),deleted:false,data:task}]:[],sequence:getChangeSequenceV12_(),sequenceCursorSafe:false,semanticNoop:true,semanticReason:'TASK_ABANDONED_BY_USER'}});
}

function mutateTaskServer(payload) {
  payload = payload || {};
  const diagnosticStartedAtV128 = Date.now();
  const perfV1216 = { totalStartedAt:diagnosticStartedAtV128 };
  const operationId = String(payload.operationId || Utilities.getUuid());
  let auth;
  const authStartedAtV1216 = Date.now();
  try { auth = requireSessionV12_(payload, true); }
  catch (error) { return errorResponse_('SESSION_INVALID', 'Sua sessão expirou. Entre novamente.', getDatabaseVersion_(), operationId); }
  perfV1216.authMs = Date.now() - authStartedAtV1216;

  const taskId = String(payload.taskId || (payload.task && payload.task.id) || '');
  const action = String(payload.action || 'update');
  const fromServerQueue = payload._fromServerQueue === true;
  if (!taskId) return errorResponse_('INVALID_TASK', 'A tarefa não foi informada.', getDatabaseVersion_(), operationId);
  const spreadsheet = getSpreadsheet_();
  taskDiagnosticV128_({level:'INFO',origin:'server',module:'tasks',step:'MUTATION_START',operationId:operationId,userId:auth.user.id,entityId:taskId,action:action,status:'starting',databaseVersion:getDatabaseVersion_()});

  // Fase 1: leitura, autorização e validação sem ScriptLock. Essa é a parte mais
  // cara da operação e não deve bloquear outros usuários.
  let previousOperation = fromServerQueue ? null : getOperationRowV12_(spreadsheet, operationId);
  if (!fromServerQueue && previousOperation && previousOperation.userId !== auth.user.id && auth.user.perfil !== 'admin') {
    return errorResponse_('OPERATION_OWNERSHIP', 'A operação pertence a outro usuário.', getDatabaseVersion_(), operationId);
  }
  if (!fromServerQueue && previousOperation && previousOperation.status === 'COMPLETED' && previousOperation.result) return previousOperation.result;

  const firstLookupAtV1216 = Date.now();
  let currentMeta = getRecordMeta_(spreadsheet, 'tasks', taskId);
  perfV1216.initialTaskLookupMs = Date.now() - firstLookupAtV1216;
  let currentTask = currentMeta && !currentMeta.deleted ? cloneObject_(currentMeta.data) : null;
  const expectedVersion = Number(payload.expectedVersion || 0);
  let serverVersion = currentMeta ? Number(currentMeta.version || 0) : 0;

  // v12.18.2: um cronômetro explicitamente abandonado não pode ser recriado ou
  // reaberto por operações antigas ainda existentes no navegador/fila do servidor.
  if (timerActionBlockedByAbandonV12182_(action, taskId, auth.user.id)) {
    return abandonedTimerNoopV12182_(operationId, action, taskId, currentTask, serverVersion);
  }

  // Recuperação rápida: a tarefa já foi persistida com este operationId e apenas
  // a finalização/changelog ficou incompleta. A recuperação do MESMO operationId
  // tem prioridade sobre a idempotência semântica para não perder efeitos pendentes.
  let recoveringCore = Boolean(currentMeta && String(currentMeta.operationId || '') === operationId);

  // v12.18: antes de declarar conflito, reconhece semanticamente CREATEs antigas
  // e ações equivalentes que nasceram com OUTRO operationId.
  const semanticNoopInitialV1218 = !recoveringCore
    ? taskSemanticNoopV1218_(action, currentTask, payload.task || {}, auth.user, serverVersion, operationId, payload.clientActionAt)
    : null;
  if (semanticNoopInitialV1218) return semanticNoopInitialV1218;
  if (!recoveringCore && serverVersion !== expectedVersion) {
    taskDiagnosticV128_({level:'WARN',origin:'server',module:'tasks',step:'VERSION_CONFLICT',operationId:operationId,userId:auth.user.id,entityId:taskId,action:action,status:'conflict',errorCode:'VERSION_CONFLICT',recordVersion:serverVersion,durationMs:Date.now()-diagnosticStartedAtV128,context:{expectedVersion:expectedVersion,serverVersion:serverVersion}});
    return conflictResponse_({ operationId:operationId, message:'A tarefa foi alterada por outro usuário.', localVersion:expectedVersion, serverVersion:serverVersion, databaseVersion:getDatabaseVersion_(), serverData:currentTask });
  }

  const validationStartedAtV1216 = Date.now();
  const deleted = Boolean(payload.deleted || action === 'delete');
  let nextTask = recoveringCore ? cloneObject_(currentTask || {}) : (deleted ? cloneObject_(currentTask || payload.task || {}) : mergeTaskPayloadV127_(currentTask, payload.task || {}, action));
  nextTask.id = taskId;
  let mutationAllowed = canMutateTaskV12_(auth.user, currentTask, nextTask, deleted);
  if (!mutationAllowed && currentTask && (action === 'approve' || action === 'reject')) {
    mutationAllowed = canApproveTaskServerV1215_(spreadsheet, auth.user, currentTask);
  }
  if (!mutationAllowed) {
    return errorResponse_('PERMISSION_DENIED', 'Seu perfil não possui permissão para alterar esta tarefa.', getDatabaseVersion_(), operationId);
  }

  const now = new Date().toISOString();
  const actionAt = typeof resolveTaskActionTimeV1214_ === 'function' ? resolveTaskActionTimeV1214_(payload, now, action) : now;
  if (!recoveringCore) {
    nextTask._lastOperationId = operationId;
    const actionAuthorization = validateTaskActionAuthorizationV1215_(spreadsheet, auth.user, action, currentTask, nextTask, deleted);
    if (!actionAuthorization.success) return errorResponse_(actionAuthorization.errorCode, actionAuthorization.message, getDatabaseVersion_(), operationId);
    protectTaskServerOwnedFieldsV1215_(action, currentTask, nextTask);
    if (typeof prepareDailyTaskMutationV1214_ === 'function') {
      const dailyValidation = prepareDailyTaskMutationV1214_(auth.user, action, currentTask, nextTask, actionAt);
      if (dailyValidation && dailyValidation.success === false) return errorResponse_(dailyValidation.errorCode, dailyValidation.message, getDatabaseVersion_(), operationId);
    }
    // Uma recorrência só é persistida se o servidor comprovar que existe um
    // mecanismo de geração automática (gatilho dedicado ou fallback horário).
    // Assim não existe mais o caso de "Tarefa diária" criada com sucesso mas
    // sem automação instalada silenciosamente.
    if (nextTask && nextTask.dailyRecurrence && nextTask.dailyRecurrence.enabled !== false && nextTask.dailyRecurrence.isTemplate === true && typeof ensureDailyTaskTriggerV1214_ === 'function') {
      try {
        const dailyAutomation = ensureDailyTaskTriggerV1214_();
        if (!dailyAutomation || dailyAutomation.success === false || dailyAutomation.guaranteed === false) {
          return errorResponse_(dailyAutomation && dailyAutomation.errorCode || 'DAILY_AUTOMATION_UNAVAILABLE', dailyAutomation && dailyAutomation.message || 'Não foi possível garantir a automação da tarefa diária.', getDatabaseVersion_(), operationId);
        }
      } catch (triggerError) {
        registerServerErrorV10_('DAILY_TRIGGER_INSTALL_FAILURE', triggerError, auth.user.id, 'daily-tasks', operationId);
        return errorResponse_('DAILY_AUTOMATION_UNAVAILABLE', 'Não foi possível garantir a geração automática das tarefas diárias. Reinstale os gatilhos do SGO e tente novamente.', getDatabaseVersion_(), operationId);
      }
    }
    enforceTaskActionV12_(action, currentTask, nextTask, actionAt, auth.user.id);
    const validation = validateTaskMutationV12_(spreadsheet, auth.user, action, currentTask, nextTask, deleted);
    if (!validation.success) {
      taskDiagnosticV128_({level:'WARN',origin:'server',module:'tasks',step:'VALIDATION_REJECTED',operationId:operationId,userId:auth.user.id,entityId:taskId,action:action,status:'rejected',errorCode:validation.errorCode,message:validation.message,recordVersion:serverVersion,durationMs:Date.now()-diagnosticStartedAtV128});
      return errorResponse_(validation.errorCode, validation.message, getDatabaseVersion_(), operationId);
    }
  }
  perfV1216.validationMs = Date.now() - validationStartedAtV1216;

  // Fase 2: seção crítica curta. Releitura da versão + persistência da tarefa +
  // changelog. Atividade/notificações ficam fora do lock.
  const lockRequestedAt = Date.now();
  const lock = tryWriteLockV12_(1800);
  if (!lock) {
    taskDiagnosticV128_({level:'WARN',origin:'server',module:'tasks',step:'WRITE_LOCK_BUSY',operationId:operationId,userId:auth.user.id,entityId:taskId,action:action,status:'busy',errorCode:'SERVER_BUSY',durationMs:Date.now()-lockRequestedAt});
    return serverBusyV12_(operationId);
  }
  const lockAcquiredAt = Date.now();
  let lockReleasedAt = lockAcquiredAt;

  let core;
  try {
    if (!fromServerQueue) {
      previousOperation = getOperationRowV12_(spreadsheet, operationId);
      if (previousOperation && previousOperation.status === 'COMPLETED' && previousOperation.result) return previousOperation.result;
    }

    const lockedLookupAtV1216 = Date.now();
    currentMeta = getRecordMeta_(spreadsheet, 'tasks', taskId);
    perfV1216.lockedTaskLookupMs = Date.now() - lockedLookupAtV1216;
    currentTask = currentMeta && !currentMeta.deleted ? cloneObject_(currentMeta.data) : null;
    serverVersion = currentMeta ? Number(currentMeta.version || 0) : 0;

    if (currentMeta && String(currentMeta.operationId || '') === operationId) {
      recoveringCore = true;
      nextTask = cloneObject_(currentTask || nextTask || {});
      const recoverChangeAtV1216 = Date.now();
      appendChangeOnceV12_(spreadsheet, 'tasks', taskId, currentMeta.version, Boolean(currentMeta.deleted), currentMeta.updatedAt || now, auth.user.id, operationId, nextTask);
      perfV1216.changeLogRecoveryMs = Date.now() - recoverChangeAtV1216;
      core = { currentTask:currentTask, storedTask:nextTask, version:Number(currentMeta.version || 0), deleted:Boolean(currentMeta.deleted), recovering:true, databaseVersion:Number(nextTask._databaseVersionAtWrite || getDatabaseVersion_()) };
      if (typeof commitTimerSlotV1214_ === 'function') commitTimerSlotV1214_(auth.user, currentTask, nextTask, Boolean(currentMeta.deleted));
    } else {
      // O estado pode ter mudado enquanto aguardávamos o lock. Reaplica a mesma
      // regra idempotente na versão efetivamente confirmada dentro da seção crítica.
      const semanticNoopLockedV1218 = String(currentMeta && currentMeta.operationId || '') !== operationId
        ? taskSemanticNoopV1218_(action, currentTask, payload.task || {}, auth.user, serverVersion, operationId, payload.clientActionAt)
        : null;
      if (semanticNoopLockedV1218) return semanticNoopLockedV1218;
      if (serverVersion !== expectedVersion) {
        return conflictResponse_({ operationId:operationId, message:'A tarefa foi alterada por outro usuário.', localVersion:expectedVersion, serverVersion:serverVersion, databaseVersion:getDatabaseVersion_(), serverData:currentTask });
      }

      // Reconstroi o patch contra a releitura confirmada para impedir gravação com
      // uma base que mudou entre a validação e a aquisição do lock.
      nextTask = deleted ? cloneObject_(currentTask || payload.task || {}) : mergeTaskPayloadV127_(currentTask, payload.task || {}, action);
      nextTask.id = taskId;
      nextTask._lastOperationId = operationId;
      const actionAuthorizationLocked = validateTaskActionAuthorizationV1215_(spreadsheet, auth.user, action, currentTask, nextTask, deleted);
      if (!actionAuthorizationLocked.success) return errorResponse_(actionAuthorizationLocked.errorCode, actionAuthorizationLocked.message, getDatabaseVersion_(), operationId);
      protectTaskServerOwnedFieldsV1215_(action, currentTask, nextTask);
      if (typeof prepareDailyTaskMutationV1214_ === 'function') {
        const dailyValidationLocked = prepareDailyTaskMutationV1214_(auth.user, action, currentTask, nextTask, actionAt);
        if (dailyValidationLocked && dailyValidationLocked.success === false) return errorResponse_(dailyValidationLocked.errorCode, dailyValidationLocked.message, getDatabaseVersion_(), operationId);
      }
      enforceTaskActionV12_(action, currentTask, nextTask, actionAt, auth.user.id);
      if (typeof checkTimerSlotV1214_ === 'function') {
        const timerSlotValidation = checkTimerSlotV1214_(spreadsheet, auth.user, currentTask, nextTask, deleted);
        if (timerSlotValidation && timerSlotValidation.success === false) {
          taskDiagnosticV128_({level:'WARN',origin:'server',module:'timer',step:'TIMER_SLOT_REJECTED',operationId:operationId,userId:auth.user.id,entityId:taskId,action:action,status:'rejected',errorCode:timerSlotValidation.errorCode,recordVersion:serverVersion,context:{activeTaskId:timerSlotValidation.activeTaskId || ''}});
          return errorResponse_(timerSlotValidation.errorCode, timerSlotValidation.message, getDatabaseVersion_(), operationId);
        }
      }

      // v12.18.4: o código SGO é identidade humana controlada pelo servidor.
      // CREATE recebe um número novo sob o mesmo lock; qualquer operação posterior
      // preserva o código já confirmado, mesmo que a fila carregue um snapshot local
      // antigo com outro número.
      if (!currentTask && !deleted) {
        const clientProposedCodeV12183 = String(nextTask.code || '');
        nextTask.code = allocateTaskCodeV12183_(spreadsheet);
        if (clientProposedCodeV12183 && clientProposedCodeV12183 !== nextTask.code) {
          taskDiagnosticV128_({level:'INFO',origin:'server',module:'tasks',step:'TASK_CODE_CANONICALIZED',operationId:operationId,userId:auth.user.id,entityId:taskId,action:action,status:'confirmed',context:{clientCode:clientProposedCodeV12183,serverCode:nextTask.code}});
        }
      } else if (currentTask && currentTask.code) {
        nextTask.code = String(currentTask.code);
      }

      const nextRecordVersion = serverVersion + 1;
      const nextDatabaseVersion = getDatabaseVersion_() + 1;
      nextTask._collection = 'tasks';
      nextTask._recordVersion = nextRecordVersion;
      nextTask._updatedBy = auth.user.id;
      nextTask._serverUpdatedAt = now;
      nextTask._lastOperationId = operationId;
      nextTask._databaseVersionAtWrite = nextDatabaseVersion;

      let storedTask = nextTask;
      if (!deleted) {
        const compactStartedAtV1216 = Date.now();
        const compacted = compactTaskForStorageV127_(spreadsheet, nextTask, operationId);
        perfV1216.compactionMs = Date.now() - compactStartedAtV1216;
        if (!compacted.success) {
          taskDiagnosticV128_({level:'ERROR',origin:'server',module:'tasks',step:'STORAGE_REJECTED',operationId:operationId,userId:auth.user.id,entityId:taskId,action:action,status:'rejected',errorCode:compacted.errorCode,message:compacted.message,recordVersion:serverVersion,durationMs:Date.now()-diagnosticStartedAtV128});
          return errorResponse_(compacted.errorCode, compacted.message, getDatabaseVersion_(), operationId);
        }
        storedTask = compacted.task;
      }

      const taskWriteStartedAtV1216 = Date.now();
      upsertRecord_(spreadsheet, 'tasks', taskId, nextRecordVersion, deleted, now, auth.user.id, operationId, storedTask);
      perfV1216.taskWriteMs = Date.now() - taskWriteStartedAtV1216;
      const timerSlotStartedAtV1216 = Date.now();
      if (typeof commitTimerSlotV1214_ === 'function') commitTimerSlotV1214_(auth.user, currentTask, storedTask, deleted);
      perfV1216.timerSlotMs = Date.now() - timerSlotStartedAtV1216;
      // Reserva a sequência enquanto o lock ainda garante exclusividade e grava
      // CHANGE_SEQUENCE junto dos demais metadados. Isso remove uma escrita
      // separada em SGO_META de cada alteração de tarefa.
      const sequenceReadAtV1216 = Date.now();
      const taskChangeSequence = getChangeSequenceV12_() + 1;
      perfV1216.sequenceReadMs = Date.now() - sequenceReadAtV1216;
      const changeLogStartedAtV1216 = Date.now();
      appendChangeWithSequenceV1210_(spreadsheet, taskChangeSequence, 'tasks', taskId, nextRecordVersion, deleted, now, auth.user.id, operationId, storedTask);
      perfV1216.changeLogMs = Date.now() - changeLogStartedAtV1216;
      const metaWriteStartedAtV1216 = Date.now();
      // v12.17: estes metadados passam a ter fonte quente durável em ScriptProperties.
      // O espelho em SGO_META é atualizado pela manutenção, fora do ScriptLock da tarefa.
      setHotMetaValuesV1217_({
        CHANGE_SEQUENCE: String(taskChangeSequence),
        DATABASE_VERSION: String(nextDatabaseVersion),
        LAST_OPERATION_ID: operationId,
        LAST_WRITE_AT: now,
        LAST_WRITE_USER: auth.user.id,
        LAST_WRITE_MODULE: 'tasks:' + action
      });
      perfV1216.metaWriteMs = Date.now() - metaWriteStartedAtV1216;
      core = { currentTask:currentTask, storedTask:storedTask, version:nextRecordVersion, deleted:deleted, recovering:false, databaseVersion:nextDatabaseVersion };
    }
  } catch (error) {
    registerServerErrorV10_('TASK_CORE_WRITE_FAILURE', error, auth.user.id, 'tasks', operationId);
    taskDiagnosticV128_({level:'ERROR',origin:'server',module:'tasks',step:'CORE_WRITE_EXCEPTION',operationId:operationId,userId:auth.user.id,entityId:taskId,action:action,status:'failed',errorCode:'TASK_CORE_WRITE_FAILURE',message:safeErrorMessage_(error),durationMs:Date.now()-diagnosticStartedAtV128});
    return errorResponse_('TASK_CORE_WRITE_FAILURE', safeErrorMessage_(error), getDatabaseVersion_(), operationId);
  } finally {
    lockReleasedAt = Date.now();
    lock.releaseLock();
  }

  // Fase 3: efeitos idempotentes fora do lock global.
  // v12.17: na PRIMEIRA passagem da fila, o cliente é liberado assim que o core
  // da tarefa está persistido. Atividade/notificações são recuperadas pelo worker
  // em EFFECTS_PENDING. Isso remove segundos do caminho interativo sem perder dados.
  if (fromServerQueue && !core.recovering) {
    perfV1216.lockWaitMs = lockAcquiredAt-lockRequestedAt;
    perfV1216.lockHeldMs = lockReleasedAt-lockAcquiredAt;
    perfV1216.totalMs = Date.now()-diagnosticStartedAtV128;
    const deferredResultV1217 = taskCoreSuccessV1216_(operationId, action, core, getChangeSequenceV12_(), !core.deleted, core.deleted ? '' : 'Efeitos complementares serão processados em segundo plano.');
    if (!core.deleted && deferredResultV1217 && deferredResultV1217.data) {
      try {
        deferredResultV1217.data._deferredEffects = buildDeferredTaskEffectsV1217_(operationId, action, auth.user, core.currentTask, core.storedTask, String(core.storedTask && core.storedTask._serverUpdatedAt || new Date().toISOString()), core.deleted);
      } catch (deferredBuildErrorV1217) {
        // Nem mesmo uma falha ao materializar atividade/notificação pode rebaixar
        // um core já persistido. A fila mantém EFFECTS_PENDING e tenta o caminho
        // legado de recuperação quando o worker voltar.
        deferredResultV1217.data.sideEffectsError = 'TASK_SIDE_EFFECT_CONTEXT_PENDING: ' + safeErrorMessage_(deferredBuildErrorV1217);
        taskDiagnosticV128_({level:'WARN',origin:'server',module:'tasks',step:'DEFERRED_EFFECTS_BUILD_FAILED',operationId:operationId,userId:auth.user.id,entityId:taskId,action:action,status:'core_confirmed',errorCode:'TASK_SIDE_EFFECT_CONTEXT_PENDING',message:safeErrorMessage_(deferredBuildErrorV1217)});
      }
    }
    taskDiagnosticV128_({level:'INFO',origin:'server',module:'tasks',step:'CORE_CONFIRMED_EFFECTS_DEFERRED',operationId:operationId,userId:auth.user.id,entityId:taskId,action:action,status:'core_confirmed',recordVersion:core.version,databaseVersion:core.databaseVersion,durationMs:perfV1216.totalMs,context:taskPerfContextV1216_(perfV1216)});
    return deferredResultV1217;
  }

  try {
    perfV1216.effectsStartedAt = Date.now();
    const result = finishTaskOperationV12_(spreadsheet, operationId, action, auth.user, core.currentTask, core.storedTask, core.version, core.deleted, core.recovering, core.databaseVersion, perfV1216);
    perfV1216.effectsTotalMs = Date.now() - perfV1216.effectsStartedAt;
    // A garantia do gatilho já foi feita ANTES da persistência da recorrência.
    // Aqui apenas registramos o modo ativo para diagnóstico, sem esconder falhas.
    if (core.storedTask && core.storedTask.dailyRecurrence && core.storedTask.dailyRecurrence.enabled !== false && core.storedTask.dailyRecurrence.isTemplate === true && typeof dailyAutomationStatusV1214_ === 'function') {
      try {
        const automationStatus = dailyAutomationStatusV1214_();
        taskDiagnosticV128_({level:automationStatus.guaranteed?'INFO':'ERROR',origin:'server',module:'daily-tasks',step:'DAILY_AUTOMATION_STATUS',operationId:operationId,userId:auth.user.id,entityId:taskId,action:action,status:automationStatus.guaranteed?'ready':'failed',errorCode:automationStatus.guaranteed?'':'DAILY_AUTOMATION_UNAVAILABLE',context:{mode:automationStatus.mode,dedicated:automationStatus.dedicated,fallback:automationStatus.fallback}});
      } catch (ignoredAutomationStatus) {}
    }
    if (!fromServerQueue) setOperationV12_(spreadsheet, operationId, 'task:' + action, auth.user.id, taskId, 'COMPLETED', result, '');
    perfV1216.lockWaitMs = lockAcquiredAt-lockRequestedAt;
    perfV1216.lockHeldMs = lockReleasedAt-lockAcquiredAt;
    perfV1216.totalMs = Date.now()-diagnosticStartedAtV128;
    perfV1216.storedSize = (function(){try{return JSON.stringify(core.storedTask||{}).length;}catch(e){return 0;}})();
    taskDiagnosticV128_({level:'INFO',origin:'server',module:'tasks',step:'MUTATION_COMPLETED',operationId:operationId,userId:auth.user.id,entityId:taskId,action:action,status:'completed',recordVersion:core.version,databaseVersion:core.databaseVersion,durationMs:perfV1216.totalMs,context:taskPerfContextV1216_(perfV1216)});
    return result;
  } catch (error) {
    perfV1216.effectsTotalMs = perfV1216.effectsStartedAt ? Date.now() - perfV1216.effectsStartedAt : 0;
    perfV1216.lockWaitMs = lockAcquiredAt-lockRequestedAt;
    perfV1216.lockHeldMs = lockReleasedAt-lockAcquiredAt;
    perfV1216.totalMs = Date.now()-diagnosticStartedAtV128;
    registerServerErrorV10_('TASK_SIDE_EFFECT_FAILURE', error, auth.user.id, 'tasks', operationId);

    if (fromServerQueue) {
      const pendingResult = taskCoreSuccessV1216_(operationId, action, core, getChangeSequenceV12_(), true, safeErrorMessage_(error));
      taskDiagnosticV128_({level:'WARN',origin:'server',module:'tasks',step:'CORE_CONFIRMED_EFFECTS_PENDING',operationId:operationId,userId:auth.user.id,entityId:taskId,action:action,status:'core_confirmed',errorCode:'TASK_SIDE_EFFECT_PENDING',message:safeErrorMessage_(error),recordVersion:core.version,databaseVersion:core.databaseVersion,durationMs:perfV1216.totalMs,context:taskPerfContextV1216_(perfV1216)});
      return pendingResult;
    }

    try { setOperationV12_(spreadsheet, operationId, 'task:' + action, auth.user.id, taskId, 'FAILED', null, safeErrorMessage_(error)); } catch (ignored) {}
    taskDiagnosticV128_({level:'ERROR',origin:'server',module:'tasks',step:'SIDE_EFFECT_EXCEPTION',operationId:operationId,userId:auth.user.id,entityId:taskId,action:action,status:'failed',errorCode:'TASK_SIDE_EFFECT_FAILURE',message:safeErrorMessage_(error),durationMs:perfV1216.totalMs,context:taskPerfContextV1216_(perfV1216)});
    return errorResponse_('TASK_SIDE_EFFECT_FAILURE', safeErrorMessage_(error), getDatabaseVersion_(), operationId);
  }
}

function finishTaskOperationV12_(spreadsheet, operationId, action, user, currentTask, nextTask, taskVersion, deleted, recovering, desiredDatabaseVersion, perfV1216) {
  const now = String(nextTask && nextTask._serverUpdatedAt || new Date().toISOString());
  const changedRecords = [{ collection: 'tasks', id: nextTask.id, version: Number(taskVersion || 0), deleted: Boolean(deleted), data: nextTask }];

  if (!deleted) {
    perfV1216 = perfV1216 || {};
    // O lock dos efeitos é independente do core: se estiver ocupado, o core continua
    // confirmado e a fila do servidor recupera atividade/notificações posteriormente.
    const effectsLockRequestedAtV1216 = Date.now();
    const effectsLock = tryWriteLockV12_(1800);
    perfV1216.effectsLockWaitMs = Date.now() - effectsLockRequestedAtV1216;
    if (!effectsLock) throw new Error('SERVER_BUSY: não foi possível registrar os efeitos da tarefa agora. O core já está salvo e os efeitos serão recuperados em segundo plano.');
    const effectsLockAcquiredAtV1216 = Date.now();
    try {
      const activity = buildTaskActivityV12_(operationId, action, user, currentTask, nextTask, now);
      const activityLookupAtV1216 = Date.now();
      const activityMeta = getRecordMeta_(spreadsheet, 'activity', activity.id);
      perfV1216.activityLookupMs = Date.now() - activityLookupAtV1216;
      if (!activityMeta || String(activityMeta.operationId || '') !== operationId) {
        const activityWriteAtV1216 = Date.now();
        upsertRecord_(spreadsheet, 'activity', activity.id, 1, false, now, user.id, operationId, activity);
        perfV1216.activityWriteMs = Date.now() - activityWriteAtV1216;
        // Caminho normal: acabamos de persistir este operationId, portanto o changelog
        // correspondente ainda não existe. Em recuperação, appendChangeOnce repara
        // especificamente o caso "registro gravado, changelog interrompido".
        const activityChangeAtV1216 = Date.now();
        appendChangeV12_(spreadsheet, 'activity', activity.id, 1, false, now, user.id, operationId, activity);
        perfV1216.activityChangeMs = Date.now() - activityChangeAtV1216;
      } else {
        const activityRecoveryChangeAtV1216 = Date.now();
        appendChangeOnceV12_(spreadsheet, 'activity', activity.id, 1, false, now, user.id, operationId, activity);
        perfV1216.activityRecoveryChangeMs = Date.now() - activityRecoveryChangeAtV1216;
      }
      changedRecords.push({ collection: 'activity', id: activity.id, version: 1, deleted: false, data: activity });

      const notifications = buildTaskNotificationsV12_(operationId, action, user, currentTask, nextTask, now);
      perfV1216.notificationCount = notifications.length;
      notifications.forEach(function (notification) {
        const notificationLookupAtV1216 = Date.now();
        const meta = getRecordMeta_(spreadsheet, 'notifications', notification.id);
        perfV1216.notificationLookupMs = Number(perfV1216.notificationLookupMs || 0) + (Date.now() - notificationLookupAtV1216);
        if (!meta || String(meta.operationId || '') !== operationId) {
          const notificationWriteAtV1216 = Date.now();
          upsertRecord_(spreadsheet, 'notifications', notification.id, 1, false, now, user.id, operationId, notification);
          perfV1216.notificationWriteMs = Number(perfV1216.notificationWriteMs || 0) + (Date.now() - notificationWriteAtV1216);
          const notificationChangeAtV1216 = Date.now();
          appendChangeV12_(spreadsheet, 'notifications', notification.id, 1, false, now, user.id, operationId, notification);
          perfV1216.notificationChangeMs = Number(perfV1216.notificationChangeMs || 0) + (Date.now() - notificationChangeAtV1216);
        } else {
          const notificationRecoveryChangeAtV1216 = Date.now();
          appendChangeOnceV12_(spreadsheet, 'notifications', notification.id, 1, false, now, user.id, operationId, notification);
          perfV1216.notificationRecoveryChangeMs = Number(perfV1216.notificationRecoveryChangeMs || 0) + (Date.now() - notificationRecoveryChangeAtV1216);
        }
        changedRecords.push({ collection: 'notifications', id: notification.id, version: 1, deleted: false, data: notification });
      });
    } finally {
      perfV1216.effectsLockHeldMs = Date.now() - effectsLockAcquiredAtV1216;
      effectsLock.releaseLock();
    }
  }

  let databaseVersion = Number(nextTask && nextTask._databaseVersionAtWrite || desiredDatabaseVersion || 0);
  const currentDatabaseVersion = getDatabaseVersion_();
  if (!databaseVersion) databaseVersion = currentDatabaseVersion;
  // Na gravação normal estes metadados já foram persistidos em lote dentro da
  // seção crítica. Só repetimos na recuperação de uma operação interrompida.
  if (recovering) {
    databaseVersion = Math.max(databaseVersion, currentDatabaseVersion);
    setMetaValuesV1210_({
      DATABASE_VERSION: String(databaseVersion),
      LAST_OPERATION_ID: operationId,
      LAST_WRITE_AT: now,
      LAST_WRITE_USER: user.id,
      LAST_WRITE_MODULE: 'tasks:' + action
    });
  }

  return successResponse_({
    operationId: operationId,
    recordId: nextTask.id,
    recordVersion: Number(taskVersion || 0),
    databaseVersion: Math.max(databaseVersion, getDatabaseVersion_()),
    data: {
      action: action,
      task: nextTask,
      changedRecords: changedRecords,
      sequence: getChangeSequenceV12_(),
      sequenceCursorSafe:false,
      recovered: Boolean(recovering)
    }
  });
}

function deterministicIdV12_(prefix, operationId, suffix) {
  return String(prefix || 'rec') + '_' + sha256V12_(String(operationId || '') + '|' + String(suffix || '')).slice(0, 28);
}

function appendChangeOnceV12_(spreadsheet, collection, recordId, version, deleted, updatedAt, userId, operationId, data, visibility) {
  const sheet = getOrCreateSheet_(spreadsheet, V12_CHANGELOG_SHEET);
  initializeHeaders_(sheet, V12_CHANGELOG_HEADERS);
  if (sheet.getLastRow() > 1) {
    const operationMatches = sheet.getRange(2, 8, sheet.getLastRow() - 1, 1).createTextFinder(String(operationId || '')).matchEntireCell(true).findAll();
    const duplicate = operationMatches.some(function (cell) {
      const row = sheet.getRange(cell.getRow(), 2, 1, 2).getValues()[0];
      return String(row[0]) === String(collection) && String(row[1]) === String(recordId);
    });
    if (duplicate) return null;
  }
  return appendChangeV12_(spreadsheet, collection, recordId, version, deleted, updatedAt, userId, operationId, data, visibility);
}

function canMutateTaskV12_(user, currentTask, nextTask, deleted) {
  if (!user) return false;
  const role = String(user.perfil || 'colaborador');
  if (role === 'admin') return true;

  // Criação é validada posteriormente por empresa, área, responsável e processo.
  // Para registros existentes, a autorização NUNCA usa o estado proposto pelo
  // navegador: somente o registro já confirmado no servidor pode conceder acesso.
  if (!currentTask) return !deleted;
  if (!userCanSeeTaskV12_(user, currentTask)) return false;
  if (deleted) return ['diretoria','auditoria'].indexOf(role) >= 0;
  if (['diretoria','auditoria'].indexOf(role) >= 0) return true;
  if (role === 'gestor') {
    return String(currentTask.area || '') === String(user.area || '')
      || String(currentTask.responsavelId || '') === String(user.id)
      || (Array.isArray(currentTask.participantes) && currentTask.participantes.indexOf(user.id) >= 0);
  }
  return String(currentTask.responsavelId || '') === String(user.id)
    || (Array.isArray(currentTask.participantes) && currentTask.participantes.indexOf(user.id) >= 0);
}

function taskProcessV1215_(spreadsheet, task) {
  if (!task || !task.processoId) return null;
  const meta = getRecordMeta_(spreadsheet, 'processes', String(task.processoId));
  return meta && !meta.deleted ? meta.data : null;
}

function canApproveTaskServerV1215_(spreadsheet, user, task) {
  if (!user || !task) return false;
  const role = String(user.perfil || 'colaborador');
  if (['admin','diretoria','auditoria'].indexOf(role) >= 0) return true;
  const process = taskProcessV1215_(spreadsheet, task);
  return Boolean(process && String(process.aprovadorId || '') === String(user.id));
}

function canAuditTaskServerV1215_(user, task) {
  if (!user || !task) return false;
  if (!userCanSeeTaskV12_(user, task)) return false;
  return ['admin','diretoria','auditoria'].indexOf(String(user.perfil || '')) >= 0;
}

function sameFieldV1215_(a, b) {
  return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
}

function protectTaskServerOwnedFieldsV1215_(action, currentTask, nextTask) {
  if (!nextTask) return;
  const protectedFields = ['approvedBy','approvedAt'];
  if (action !== 'approve' && action !== 'reject') protectedFields.push('approvalStatus');
  if (action !== 'audit') protectedFields.push('auditado');
  protectedFields.forEach(function (field) {
    if (currentTask) nextTask[field] = cloneObject_(currentTask[field]);
    else if (field === 'approvalStatus') nextTask[field] = ['not_required','not_requested','pending'].indexOf(String(nextTask[field] || '')) >= 0 ? nextTask[field] : 'not_required';
    else if (field === 'auditado') nextTask[field] = false;
    else nextTask[field] = '';
  });
}

function validateTaskActionAuthorizationV1215_(spreadsheet, user, action, currentTask, nextTask, deleted) {
  const role = String(user && user.perfil || 'colaborador');
  if (deleted) return { success: canMutateTaskV12_(user, currentTask, nextTask, true), errorCode:'PERMISSION_DENIED', message:'Seu perfil não pode excluir esta tarefa.' };
  if (action === 'approve' || action === 'reject') {
    if (!currentTask || !canApproveTaskServerV1215_(spreadsheet, user, currentTask)) return { success:false, errorCode:'APPROVAL_PERMISSION', message:'Seu perfil não pode decidir a aprovação desta tarefa.' };
    if (String(currentTask.status || '') !== 'Aguardando aprovação' || String(currentTask.approvalStatus || '') !== 'pending') return { success:false, errorCode:'APPROVAL_NOT_PENDING', message:'A tarefa não está mais aguardando aprovação.' };
  }
  if (action === 'audit') {
    if (!currentTask || !canAuditTaskServerV1215_(user, currentTask)) return { success:false, errorCode:'AUDIT_PERMISSION', message:'Seu perfil não pode auditar esta tarefa.' };
    if (String(currentTask.status || '') !== 'Concluída' || currentTask.auditado === true) return { success:false, errorCode:'AUDIT_NOT_AVAILABLE', message:'A tarefa não está disponível para auditoria.' };
  }
  if (currentTask && action === 'update') {
    const fromStatus = String(currentTask.status || '');
    const toStatus = String(nextTask.status || '');
    if (toStatus === 'Auditada' && fromStatus !== 'Auditada') return { success:false, errorCode:'AUDIT_ACTION_REQUIRED', message:'Use o fluxo de auditoria para marcar uma tarefa como Auditada.' };
    if (toStatus === 'Concluída' && fromStatus !== 'Concluída') return { success:false, errorCode:'COMPLETE_ACTION_REQUIRED', message:'Use o fluxo de conclusão para concluir esta tarefa.' };
    if (toStatus === 'Aguardando aprovação' && fromStatus !== 'Aguardando aprovação') return { success:false, errorCode:'APPROVAL_WAIT_ACTION_REQUIRED', message:'Use o fluxo de envio para aprovação.' };
    if (toStatus === 'Aguardando terceiro' && fromStatus !== 'Aguardando terceiro') return { success:false, errorCode:'WAIT_ACTION_REQUIRED', message:'Use o fluxo de espera para registrar corretamente o tempo e o motivo.' };
    if (!sameFieldV1215_(currentTask.approvalStatus, nextTask.approvalStatus)
        || !sameFieldV1215_(currentTask.approvedBy, nextTask.approvedBy)
        || !sameFieldV1215_(currentTask.approvedAt, nextTask.approvedAt)
        || !sameFieldV1215_(currentTask.auditado, nextTask.auditado)) {
      return { success:false, errorCode:'SERVER_OWNED_FIELD', message:'Campos de aprovação e auditoria só podem ser alterados pelos fluxos específicos.' };
    }
  }
  if (role === 'gestor' && currentTask && String(currentTask.area || '') !== String(user.area || '')
      && String(currentTask.responsavelId || '') !== String(user.id)
      && (!Array.isArray(currentTask.participantes) || currentTask.participantes.indexOf(user.id) < 0)) {
    return { success:false, errorCode:'AREA_PERMISSION', message:'O gestor só pode alterar tarefas da própria área ou nas quais esteja envolvido.' };
  }
  return { success:true };
}

function validateTaskMutationV12_(spreadsheet, user, action, currentTask, task, deleted) {
  if (deleted) return { success: true };
  if (!task || typeof task !== 'object') return { success: false, errorCode: 'INVALID_TASK', message: 'Os dados da tarefa são inválidos.' };
  const validStatuses = ['Nova','Triagem','Em andamento','Aguardando terceiro','Aguardando aprovação','Concluída','Auditada','Reprovada/devolvida','Cancelada'];
  const validPriorities = ['Baixa','Normal','Alta','Crítica'];
  if (!String(task.titulo || '').trim()) return { success: false, errorCode: 'TITLE_REQUIRED', message: 'Informe o título da tarefa.' };
  if (!String(task.empresa || '').trim()) return { success: false, errorCode: 'COMPANY_REQUIRED', message: 'Informe a empresa.' };
  if (!String(task.area || '').trim()) return { success: false, errorCode: 'AREA_REQUIRED', message: 'Informe a área.' };
  if (!String(task.responsavelId || '').trim()) return { success: false, errorCode: 'OWNER_REQUIRED', message: 'Informe o responsável.' };
  if (validStatuses.indexOf(String(task.status || '')) < 0) return { success: false, errorCode: 'INVALID_STATUS', message: 'O status informado é inválido.' };
  if (validPriorities.indexOf(String(task.prioridade || 'Normal')) < 0) return { success: false, errorCode: 'INVALID_PRIORITY', message: 'A prioridade informada é inválida.' };
  const progress = Number(task.progresso || 0);
  if (!Number.isFinite(progress) || progress < 0 || progress > 100) return { success: false, errorCode: 'INVALID_PROGRESS', message: 'O progresso deve ficar entre 0 e 100%.' };

  /*
   * Compatibilidade com tarefas rápidas/cronometradas e registros legados.
   * Estimativa e prazo são campos obrigatórios no formulário normal (create/update),
   * porém não podem impedir ações operacionais como iniciar, pausar, retomar ou
   * concluir uma tarefa já existente. A tarefa cronometrada é criada de propósito
   * sem estimativa e sem prazo; o tempo real é medido pelo cronômetro.
   */
  const estimate = Number(task.estimativa || 0);
  // Tarefas controladas por cronômetro usam o tempo real, não uma estimativa obrigatória.
  // A checagem considera também timeTracking/currentTask para recuperar registros antigos
  // cujo campo `tipo` tenha sido alterado por versões anteriores do frontend.
  const isTimedQuickTask = String(task.tipo || '') === 'Tarefa cronometrada'
    || Boolean(task.timeTracking && task.timeTracking.enabled)
    || Boolean(currentTask && currentTask.timeTracking && currentTask.timeTracking.enabled)
    || String(currentTask && currentTask.tipo || '') === 'Tarefa cronometrada';
  // Regra de produto: toda tarefa cronometrada usa 1 hora como esforço estimado
  // padrão. O tempo efetivo continua vindo exclusivamente do cronômetro.
  if (isTimedQuickTask) task.estimativa = 1;
  const isPlanningWrite = action === 'create' || action === 'update';
  if (isPlanningWrite && !isTimedQuickTask && (!Number.isFinite(estimate) || estimate <= 0)) {
    return { success: false, errorCode: 'INVALID_ESTIMATE', message: 'Informe um esforço estimado maior que zero.' };
  }
  if (task.prazo) {
    if (Number.isNaN(new Date(task.prazo).getTime())) return { success: false, errorCode: 'INVALID_DEADLINE', message: 'Informe um prazo válido.' };
  } else if (isPlanningWrite && !isTimedQuickTask) {
    return { success: false, errorCode: 'INVALID_DEADLINE', message: 'Informe um prazo válido.' };
  }
  const invalidLink = (Array.isArray(task.links) ? task.links : []).find(function (link) {
    const url = String(link && link.url || '').trim();
    return !/^https?:\/\//i.test(url) || url.length > 2048;
  });
  if (invalidLink) return { success: false, errorCode: 'INVALID_EVIDENCE_LINK', message: 'Os links de evidência devem usar http:// ou https:// e possuir até 2.048 caracteres.' };

  const ownerMeta = getRecordMeta_(spreadsheet, 'collaborators', String(task.responsavelId));
  if (!ownerMeta || ownerMeta.deleted || !ownerMeta.data || ownerMeta.data.ativo === false) return { success: false, errorCode: 'INVALID_OWNER', message: 'O responsável não existe ou está inativo.' };
  const companies = Array.isArray(user.empresasAcesso) ? user.empresasAcesso : [];
  if (['admin','diretoria'].indexOf(String(user.perfil || '')) < 0 && companies.length && companies.indexOf(task.empresa) < 0) {
    return { success: false, errorCode: 'COMPANY_PERMISSION', message: 'Seu perfil não possui acesso a esta empresa.' };
  }
  if (['Alta','Crítica'].indexOf(task.prioridade) >= 0 && ['admin','diretoria','auditoria','gestor'].indexOf(String(user.perfil || '')) < 0 && (!currentTask || currentTask.prioridade !== task.prioridade)) {
    return { success: false, errorCode: 'PRIORITY_PERMISSION', message: 'Seu perfil não pode definir prioridade alta ou crítica.' };
  }

  let process = null;
  if (task.processoId) {
    const processMeta = getRecordMeta_(spreadsheet, 'processes', String(task.processoId));
    process = processMeta && !processMeta.deleted ? processMeta.data : null;
    if (!process || String(process.empresa || '') !== String(task.empresa || '')) return { success: false, errorCode: 'INVALID_PROCESS', message: 'O processo não pertence à empresa informada.' };
    // Campo derivado pelo servidor para que o aprovador consiga receber/visualizar
    // a tarefa sem ganhar permissão genérica de edição sobre ela.
    task.aprovadorId = String(process.aprovadorId || '');
    if (process.segregacao && [process.conferenteId, process.aprovadorId].filter(Boolean).indexOf(task.responsavelId) >= 0) {
      return { success: false, errorCode: 'SEGREGATION_VIOLATION', message: 'O executor não pode ser a mesma pessoa que confere ou aprova este processo.' };
    }
  }

  if (['Aguardando terceiro','Aguardando aprovação'].indexOf(task.status) >= 0) {
    if (!String(task.aguardandoQuem || '').trim()) return { success: false, errorCode: 'WAITING_PERSON_REQUIRED', message: 'Informe quem está sendo aguardado.' };
    if (!task.aguardandoDesde || Number.isNaN(new Date(task.aguardandoDesde).getTime())) return { success: false, errorCode: 'WAITING_DATE_REQUIRED', message: 'Informe desde quando está aguardando.' };
  }

  /*
   * Regras de conclusão são avaliadas somente quando a operação realmente
   * conclui a tarefa. Antes, qualquer UPDATE de uma tarefa que já estava
   * concluída voltava a exigir evidência/justificativa, o que prendia edições
   * legítimas na fila com DELAY_REASON_REQUIRED. A transição é determinada
   * também pelo estado atual do servidor para não depender apenas do frontend.
   */
  const completedStatuses = ['Concluída','Auditada'];
  const wasCompleted = Boolean(currentTask && completedStatuses.indexOf(String(currentTask.status || '')) >= 0);
  const willBeCompleted = completedStatuses.indexOf(String(task.status || '')) >= 0;
  const isCompletionTransition = action === 'complete' || (willBeCompleted && !wasCompleted);
  if (isCompletionTransition) {
    if (!String(task.evidencia || '').trim()) return { success: false, errorCode: 'EVIDENCE_REQUIRED', message: 'Informe a evidência de execução.' };
    const dueAt = task.prazo ? new Date(task.prazo).getTime() : NaN;
    const timedWithoutManualDeadline = isTimedQuickTask && !taskHasManualDeadlineV1214_(task);
    const completionAt = new Date(String(task.concluidoEm || task._serverUpdatedAt || new Date().toISOString())).getTime();
    const late = !timedWithoutManualDeadline && Number.isFinite(dueAt) && Number.isFinite(completionAt) && dueAt < completionAt;
    if (late && !String(task.justificativaAtraso || '').trim()) return { success: false, errorCode: 'DELAY_REASON_REQUIRED', message: 'Informe a justificativa de atraso.' };
    if (process && process.aprovadorId && task.approvalStatus !== 'approved') return { success: false, errorCode: 'APPROVAL_REQUIRED', message: 'A tarefa precisa ser aprovada antes da conclusão.' };
    const incomplete = (Array.isArray(task.checklist) ? task.checklist : []).some(function (item) { return item && item.feito !== true; });
    if (incomplete) return { success: false, errorCode: 'CHECKLIST_INCOMPLETE', message: 'Conclua todos os itens do checklist.' };
  }
  return { success: true };
}

function normalizeTrackingV12_(task) {
  task.timeTracking = task.timeTracking && typeof task.timeTracking === 'object' ? task.timeTracking : {};
  const tracking = task.timeTracking;
  tracking.enabled = tracking.enabled !== false;
  tracking.state = ['running','paused','waiting','approval','completed'].indexOf(tracking.state) >= 0 ? tracking.state : 'paused';
  tracking.totalMs = Math.max(0, Number(tracking.totalMs || 0));
  tracking.activeStartedAt = String(tracking.activeStartedAt || '');
  tracking.startedAt = String(tracking.startedAt || task.criadoEm || '');
  tracking.completedAt = String(tracking.completedAt || '');
  tracking.lastChangedAt = String(tracking.lastChangedAt || '');
  tracking.sessions = Array.isArray(tracking.sessions) ? tracking.sessions : [];
  return tracking;
}

function closeTrackingSessionV12_(task, outcome, now) {
  if (!task.timeTracking || !task.timeTracking.enabled) return;
  const tracking = normalizeTrackingV12_(task);
  if (tracking.state === 'running' && tracking.activeStartedAt) {
    const started = new Date(tracking.activeStartedAt).getTime();
    const ended = new Date(now).getTime();
    if (Number.isFinite(started) && Number.isFinite(ended) && ended >= started) {
      const duration = ended - started;
      tracking.totalMs += duration;
      tracking.sessions.push({ startedAt: tracking.activeStartedAt, endedAt: now, durationMs: duration, outcome: String(outcome || 'registered') });
      tracking.sessions = tracking.sessions.slice(-1000);
    }
  }
  tracking.activeStartedAt = '';
  tracking.lastChangedAt = now;
}

/** v12.18.4 — estado terminal do cronômetro é monotônico.
 * UPDATE comum pode editar título, observação, evidência etc., mas não pode reabrir
 * uma tarefa cronometrada que o servidor já confirmou como Concluída/Auditada/Cancelada.
 * Uma reabertura futura deverá ser uma ação explícita e auditável, nunca efeito colateral
 * de snapshot antigo ou sincronização atrasada. */
function preserveTerminalTimerStateV12184_(action, currentTask, task) {
  if (!currentTask || !task || String(action || '') !== 'update') return false;
  const currentTracking=currentTask.timeTracking&&typeof currentTask.timeTracking==='object'?currentTask.timeTracking:{};
  const timed=String(currentTask.tipo||'')==='Tarefa cronometrada'||Boolean(currentTracking.enabled);
  const terminal=['Concluída','Auditada','Cancelada'].indexOf(String(currentTask.status||''))>=0
    || String(currentTracking.state||'')==='completed' || Boolean(currentTask.concluidoEm) || Boolean(currentTask._timerAbandonedAt);
  if(!timed||!terminal)return false;
  const incomingTracking=task.timeTracking&&typeof task.timeTracking==='object'?task.timeTracking:{};
  const incomingTerminal=['Concluída','Auditada','Cancelada'].indexOf(String(task.status||''))>=0 || String(incomingTracking.state||'')==='completed';
  if(incomingTerminal)return false;
  task.status=String(currentTask.status||'Concluída');
  task.progresso=Number(currentTask.progresso||100);
  task.concluidoEm=String(currentTask.concluidoEm||'');
  task.timeTracking=cloneObject_(currentTracking);
  task.timeTracking.state='completed';
  task.timeTracking.activeStartedAt='';
  task.timeTracking.completedAt=String(currentTracking.completedAt||currentTask.concluidoEm||task.timeTracking.completedAt||'');
  task.timeTracking.lastChangedAt=String(currentTracking.lastChangedAt||task.timeTracking.completedAt||'');
  if(currentTask._timerAbandonedAt)task._timerAbandonedAt=currentTask._timerAbandonedAt;
  if(currentTask._timerAbandonedBy)task._timerAbandonedBy=currentTask._timerAbandonedBy;
  return true;
}

function enforceTaskActionV12_(action, currentTask, task, now, userId) {
  task.criadoEm = task.criadoEm || now;
  if (String(task.tipo || '') === 'Tarefa cronometrada'
      || Boolean(task.timeTracking && task.timeTracking.enabled)
      || Boolean(currentTask && currentTask.timeTracking && currentTask.timeTracking.enabled)) {
    task.tipo = 'Tarefa cronometrada';
    task.estimativa = 1;
  }
  task.atualizadoEm = now;
  task.historico = Array.isArray(task.historico) ? task.historico : [];
  const terminalPreservedV12184 = preserveTerminalTimerStateV12184_(action,currentTask,task);
  const previousStatus = currentTask && currentTask.status || '';
  let actionLabel = 'Tarefa atualizada';

  if (action === 'start') {
    const tracking = normalizeTrackingV12_(task);
    if (tracking.state !== 'running') {
      tracking.state = 'running';
      tracking.activeStartedAt = now;
      tracking.startedAt = tracking.startedAt || now;
      tracking.completedAt = '';
      tracking.lastChangedAt = now;
    }
    task.status = 'Em andamento';
    if (Number(task.progresso || 0) <= 0) task.progresso = 1;
    actionLabel = 'Tarefa iniciada';
  } else if (action === 'pause') {
    closeTrackingSessionV12_(task, 'paused', now);
    if (task.timeTracking) task.timeTracking.state = 'paused';
    actionLabel = 'Cronômetro pausado';
  } else if (action === 'resume') {
    const tracking = normalizeTrackingV12_(task);
    if (tracking.state !== 'running') {
      tracking.state = 'running';
      tracking.activeStartedAt = now;
      tracking.startedAt = tracking.startedAt || now;
      tracking.completedAt = '';
      tracking.lastChangedAt = now;
    }
    task.status = 'Em andamento';
    actionLabel = 'Tarefa retomada';
  } else if (action === 'wait' || action === 'approval_wait') {
    const approvalWait = action === 'approval_wait';
    closeTrackingSessionV12_(task, approvalWait ? 'approval' : 'waiting', now);
    if (task.timeTracking) task.timeTracking.state = approvalWait ? 'approval' : 'waiting';
    task.status = approvalWait ? 'Aguardando aprovação' : 'Aguardando terceiro';
    task.aguardandoDesde = task.aguardandoDesde || now;
    if (approvalWait) task.approvalStatus = 'pending';
    actionLabel = approvalWait ? 'Tarefa enviada para aprovação' : 'Tarefa colocada em espera';
  } else if (action === 'complete') {
    closeTrackingSessionV12_(task, 'completed', now);
    if (task.timeTracking) {
      task.timeTracking.state = 'completed';
      task.timeTracking.completedAt = now;
      task.timeTracking.activeStartedAt = '';
    }
    task.status = 'Concluída';
    task.progresso = 100;
    task.concluidoEm = now;
    if ((String(task.tipo || '') === 'Tarefa cronometrada' || (task.timeTracking && task.timeTracking.enabled)) && !taskHasManualDeadlineV1214_(task)) {
      task.prazo = Utilities.formatDate(new Date(now), taskTimeZoneV1214_(), "yyyy-MM-dd'T'HH:mm");
      task.prazoManual = false;
      task.prazoAutomatico = true;
    } else if (String(task.prazo || '').trim()) {
      task.prazoManual = true;
      task.prazoAutomatico = false;
    }
    if ((String(task.tipo || '') === 'Tarefa cronometrada' || (task.timeTracking && task.timeTracking.enabled))
        && !String(task.evidencia || '').trim()) {
      task.evidencia = 'Execução registrada automaticamente pelo cronômetro do SGO.';
    }
    actionLabel = 'Tarefa concluída';
  } else if (action === 'approve') {
    task.approvalStatus = 'approved';
    task.approvedBy = userId;
    task.approvedAt = now;
    actionLabel = 'Aprovação concedida';
  } else if (action === 'reject') {
    task.approvalStatus = 'rejected';
    task.status = 'Reprovada/devolvida';
    task.approvedBy = userId;
    task.approvedAt = now;
    actionLabel = 'Aprovação rejeitada';
  } else if (action === 'audit') {
    task.auditado = true;
    task.status = String(task.auditResult || task.status || '') === 'Reprovada/devolvida' ? 'Reprovada/devolvida' : 'Auditada';
    actionLabel = task.status === 'Auditada' ? 'Tarefa auditada' : 'Tarefa reprovada na auditoria';
  } else {
    if (['Concluída','Auditada','Cancelada'].indexOf(task.status) >= 0) {
      closeTrackingSessionV12_(task, task.status === 'Cancelada' ? 'cancelled' : 'completed', now);
      if (task.timeTracking) {
        task.timeTracking.state = 'completed';
        task.timeTracking.completedAt = task.timeTracking.completedAt || now;
      }
      if (task.status === 'Concluída') {
        task.progresso = 100; task.concluidoEm = task.concluidoEm || now;
        if ((String(task.tipo || '') === 'Tarefa cronometrada' || (task.timeTracking && task.timeTracking.enabled)) && !taskHasManualDeadlineV1214_(task)) {
          task.prazo = Utilities.formatDate(new Date(task.concluidoEm), taskTimeZoneV1214_(), "yyyy-MM-dd'T'HH:mm");
          task.prazoManual = false;
          task.prazoAutomatico = true;
        } else if (String(task.prazo || '').trim()) {
          task.prazoManual = true;
          task.prazoAutomatico = false;
        }
      }
    } else if (task.status === 'Aguardando terceiro') {
      closeTrackingSessionV12_(task, 'waiting', now);
      if (task.timeTracking) task.timeTracking.state = 'waiting';
    } else if (task.status === 'Aguardando aprovação') {
      closeTrackingSessionV12_(task, 'approval', now);
      if (task.timeTracking) task.timeTracking.state = 'approval';
      task.approvalStatus = 'pending';
    } else if (task.timeTracking && task.timeTracking.state === 'completed') {
      // v12.18.4: nunca converte completed -> paused implicitamente. Se este UPDATE
      // veio de um snapshot antigo, preserveTerminalTimerStateV12184_ já restaurou
      // o estado terminal confirmado. Reabertura exige comando explícito futuro.
      task.timeTracking.activeStartedAt = '';
    }
  }

  const operationId = String(task._lastOperationId || '');
  const already = task.historico.some(function (entry) { return entry && entry.operationId && entry.operationId === operationId; });
  if (!already) {
    task.historico.push({ at: now, userId: userId, action: actionLabel, fromStatus: previousStatus, toStatus: task.status || '', operationId: operationId });
    task.historico = task.historico.slice(-1000);
  }
}

function buildTaskActivityV12_(operationId, action, user, currentTask, task, now) {
  const labels = {
    create: 'foi criada', update: 'foi atualizada', start: 'foi iniciada', pause: 'teve o cronômetro pausado',
    resume: 'foi retomada', wait: 'foi colocada em espera', approval_wait: 'foi enviada para aprovação', complete: 'foi concluída', approve: 'foi aprovada', reject: 'foi devolvida', audit: 'foi auditada', delete: 'foi excluída'
  };
  return {
    id: deterministicIdV12_('log', operationId, 'activity'),
    taskId: task.id,
    type: action === 'complete' ? 'success' : (action === 'reject' || action === 'delete' ? 'error' : 'info'),
    text: String(task.code || task.id) + ' ' + (labels[action] || 'foi alterada') + ' por ' + String(user.nome || 'usuário') + '.',
    at: now,
    userId: user.id,
    operationId: operationId,
    _collection: 'activity', _recordVersion: 1, _updatedBy: user.id, _serverUpdatedAt: now, _lastOperationId: operationId
  };
}

function buildTaskNotificationsV12_(operationId, action, user, currentTask, task, now) {
  const recipients = [];
  if (action === 'create' || (!currentTask && task.responsavelId)) recipients.push(task.responsavelId);
  if (currentTask && currentTask.responsavelId !== task.responsavelId) recipients.push(task.responsavelId);
  if (action === 'complete') {
    recipients.push(task.responsavelId);
    (task.participantes || []).forEach(function (id) { recipients.push(id); });
  }
  if (action === 'approve' || action === 'reject') recipients.push(task.responsavelId);
  const unique = uniqueIdsV12_(recipients).filter(function (id) { return id && id !== user.id; });
  return unique.map(function (recipientId) {
    return {
      id: deterministicIdV12_('notification', operationId, recipientId),
      userId: recipientId,
      type: 'TASK_' + String(action || 'update').toUpperCase(),
      taskId: task.id,
      title: action === 'complete' ? 'Tarefa concluída' : action === 'approve' ? 'Tarefa aprovada' : action === 'reject' ? 'Tarefa devolvida' : 'Tarefa atualizada',
      message: String(task.code || '') + ' · ' + String(task.titulo || ''),
      createdAt: now,
      read: false,
      sourceOperationId: operationId,
      _collection: 'notifications', _recordVersion: 1, _updatedBy: user.id, _serverUpdatedAt: now, _lastOperationId: operationId
    };
  });
}


function buildDeferredTaskEffectsV1217_(operationId, action, user, currentTask, task, now, deleted) {
  if (deleted) return { activity:null, notifications:[] };
  return {
    activity:buildTaskActivityV12_(operationId, action, user, currentTask, task, now),
    notifications:buildTaskNotificationsV12_(operationId, action, user, currentTask, task, now)
  };
}

/** Recupera somente os efeitos já materializados pelo core. Não revalida nem
 * regrava a tarefa, portanto uma operação posterior pode avançar sem impedir
 * a atividade/notificação da operação anterior. */
function completeDeferredTaskEffectsV1217_(spreadsheet, row) {
  const deferred = row && row.payload && row.payload._deferredEffects;
  if (!deferred || typeof deferred !== 'object') return null;
  const perf = {};
  const requestedAt = Date.now();
  const lock = tryWriteLockV12_(1800);
  perf.effectsLockWaitMs = Date.now() - requestedAt;
  if (!lock) return errorResponse_('SERVER_BUSY', 'Os efeitos da tarefa serão tentados novamente em segundo plano.', getDatabaseVersion_(), row.operationId);
  const acquiredAt = Date.now();
  const changed = [];
  try {
    const activity = deferred.activity && typeof deferred.activity === 'object' ? cloneObject_(deferred.activity) : null;
    if (activity && activity.id) {
      const meta = getRecordMeta_(spreadsheet, 'activity', activity.id);
      if (!meta || String(meta.operationId || '') !== String(row.operationId || '')) {
        upsertRecord_(spreadsheet, 'activity', activity.id, 1, false, String(activity.at || new Date().toISOString()), String(activity.userId || row.userId || ''), row.operationId, activity);
        appendChangeV12_(spreadsheet, 'activity', activity.id, 1, false, String(activity.at || new Date().toISOString()), String(activity.userId || row.userId || ''), row.operationId, activity);
      } else {
        appendChangeOnceV12_(spreadsheet, 'activity', activity.id, 1, false, String(activity.at || meta.updatedAt || new Date().toISOString()), String(activity.userId || row.userId || ''), row.operationId, activity);
      }
      changed.push({collection:'activity',id:activity.id,version:1,deleted:false,data:activity});
    }
    const notifications = Array.isArray(deferred.notifications) ? deferred.notifications : [];
    notifications.forEach(function(notification){
      if (!notification || !notification.id) return;
      const meta = getRecordMeta_(spreadsheet, 'notifications', notification.id);
      const at = String(notification.createdAt || new Date().toISOString());
      if (!meta || String(meta.operationId || '') !== String(row.operationId || '')) {
        upsertRecord_(spreadsheet, 'notifications', notification.id, 1, false, at, String(notification._updatedBy || row.userId || ''), row.operationId, notification);
        appendChangeV12_(spreadsheet, 'notifications', notification.id, 1, false, at, String(notification._updatedBy || row.userId || ''), row.operationId, notification);
      } else {
        appendChangeOnceV12_(spreadsheet, 'notifications', notification.id, 1, false, at, String(notification._updatedBy || row.userId || ''), row.operationId, notification);
      }
      changed.push({collection:'notifications',id:notification.id,version:1,deleted:false,data:notification});
    });
  } finally {
    perf.effectsLockHeldMs = Date.now() - acquiredAt;
    lock.releaseLock();
  }
  const base = cloneObject_(row.result || successResponse_({operationId:row.operationId,databaseVersion:getDatabaseVersion_(),data:{}}));
  base.success = true; base.confirmed = true; base.operationId = row.operationId; base.databaseVersion = getDatabaseVersion_();
  base.data = base.data && typeof base.data === 'object' ? base.data : {};
  base.data.sideEffectsPending = false; base.data.sideEffectsError = '';
  delete base.data._deferredEffects;
  base.data.changedRecords = (Array.isArray(base.data.changedRecords) ? base.data.changedRecords : []).concat(changed);
  taskDiagnosticV128_({level:'INFO',origin:'server',module:'tasks',step:'DEFERRED_EFFECTS_COMPLETED',operationId:row.operationId,userId:row.userId,entityId:row.entityId,action:row.action,status:'completed',durationMs:Number(perf.effectsLockWaitMs||0)+Number(perf.effectsLockHeldMs||0),context:taskPerfContextV1216_(perf)});
  return base;
}

function completeTaskServer(payload) { payload = payload || {}; payload.action = 'complete'; return mutateTaskServer(payload); }
function updateTaskServer(payload) { payload = payload || {}; payload.action = 'update'; return mutateTaskServer(payload); }
function createTaskServer(payload) { payload = payload || {}; payload.action = 'create'; return mutateTaskServer(payload); }
function startTaskServer(payload) { payload = payload || {}; payload.action = 'start'; return mutateTaskServer(payload); }
function pauseTaskServer(payload) { payload = payload || {}; payload.action = 'pause'; return mutateTaskServer(payload); }
function resumeTaskServer(payload) { payload = payload || {}; payload.action = 'resume'; return mutateTaskServer(payload); }
function waitTaskServer(payload) { payload = payload || {}; payload.action = payload.approvalWait === true ? 'approval_wait' : 'wait'; return mutateTaskServer(payload); }
function auditTaskServer(payload) { payload = payload || {}; payload.action = 'audit'; return mutateTaskServer(payload); }
function approveTaskOperationServer(payload) { payload = payload || {}; payload.action = payload.approved === false ? 'reject' : 'approve'; return mutateTaskServer(payload); }
function deleteTaskServer(payload) { payload = payload || {}; payload.action = 'delete'; payload.deleted = true; return mutateTaskServer(payload); }

/**
 * SGO v12.5 — fila transacional no servidor para operações de tarefa.
 * A aceitação é rápida e durável; o processamento pode ocorrer logo em seguida
 * pelo navegador ou pelo acionador de contingência de 1 minuto.
 */
const V125_SERVER_QUEUE_SHEET = 'SGO_FILA_SERVIDOR';
const V1215_SERVER_QUEUE_ARCHIVE_SHEET = 'SGO_FILA_ARQUIVO';
const V1215_QUEUE_MAINTENANCE_PROP = 'SGO_QUEUE_MAINTENANCE_AT_V1215';
const V125_SERVER_QUEUE_HEADERS = [
  'ORDEM','OPERACAO_ID','USUARIO_ID','TIPO','ACAO','ENTIDADE_ID','PAYLOAD_JSON','STATUS',
  'TENTATIVAS','PROXIMA_TENTATIVA_EM','CRIADO_EM','ATUALIZADO_EM','RESULTADO_JSON','ERRO'
];
const V125_SERVER_QUEUE_SEQ_PROP = 'SGO_SERVER_QUEUE_SEQUENCE';
const V125_SERVER_QUEUE_PERMANENT_ERRORS = {
  PERMISSION_DENIED:true, INVALID_TASK:true, TITLE_REQUIRED:true, COMPANY_REQUIRED:true,
  AREA_REQUIRED:true, OWNER_REQUIRED:true, OWNER_INACTIVE:true, INVALID_OWNER:true,
  INVALID_STATUS:true, INVALID_PRIORITY:true, INVALID_PROGRESS:true, INVALID_ESTIMATE:true,
  INVALID_DEADLINE:true, INVALID_EVIDENCE_LINK:true, EVIDENCE_REQUIRED:true,
  DELAY_REASON_REQUIRED:true, CHECKLIST_PENDING:true, CHECKLIST_INCOMPLETE:true,
  APPROVAL_REQUIRED:true, COMPANY_PERMISSION:true, PRIORITY_PERMISSION:true,
  INVALID_PROCESS:true, SEGREGATION_VIOLATION:true, DEPENDENCY_FAILED:true, APPROVAL_PERMISSION:true, APPROVAL_NOT_PENDING:true, AUDIT_PERMISSION:true, AUDIT_NOT_AVAILABLE:true, AUDIT_ACTION_REQUIRED:true, COMPLETE_ACTION_REQUIRED:true, APPROVAL_WAIT_ACTION_REQUIRED:true, WAIT_ACTION_REQUIRED:true, SERVER_OWNED_FIELD:true, AREA_PERMISSION:true, WAITING_PERSON_REQUIRED:true,
  WAITING_DATE_REQUIRED:true, INVALID_RECORD:true, OPERATION_OWNERSHIP:true, OPERATION_TOO_LARGE:true, TASK_STORAGE_LIMIT:true, USER_DISCARDED_PENDING_OPERATION:true
};

/*
 * SGO v12.7 — tarefas leves e armazenamento seguro.
 * O Google Sheets limita cada célula a 50.000 caracteres. Nas versões anteriores,
 * historico + sessões do cronômetro cresciam dentro do DADOS_JSON da tarefa até
 * estourar esse limite. O servidor agora:
 *  - não recebe histórico/sessões inteiros a cada ação de cronômetro;
 *  - mescla o patch com a versão confirmada no servidor;
 *  - arquiva automaticamente histórico/sessões antigos em SGO_TAREFA_ARQUIVO;
 *  - mantém o registro principal pequeno e rápido.
 */
const V127_TASK_ARCHIVE_SHEET = 'SGO_TAREFA_ARQUIVO';
const V127_TASK_ARCHIVE_HEADERS = ['ARQUIVO_ID','TAREFA_ID','TIPO','OPERACAO_ID','ORDEM','CONTEUDO','CRIADO_EM'];
const V127_TASK_INLINE_HISTORY = 30;
const V127_TASK_INLINE_SESSIONS = 30;
const V127_TASK_INLINE_COMMENTS = 50;
const V127_TASK_INLINE_LINKS = 50;
const V127_SAFE_CELL_CHARS = 16000;

function ensureTaskArchiveV127_(spreadsheet) {
  const sheet = getOrCreateSheet_(spreadsheet || getSpreadsheet_(), V127_TASK_ARCHIVE_SHEET);
  initializeHeaders_(sheet, V127_TASK_ARCHIVE_HEADERS);
  return sheet;
}

function archiveTaskArrayV127_(spreadsheet, taskId, type, items, operationId) {
  items = Array.isArray(items) ? items : [];
  if (!items.length) return 0;
  const sheet = ensureTaskArchiveV127_(spreadsheet);
  const archiveId = String(operationId || Utilities.getUuid()) + ':' + String(type || 'data');
  if (sheet.getLastRow() > 1) {
    const found = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1)
      .createTextFinder(archiveId).matchEntireCell(true).findNext();
    if (found) return items.length;
  }
  const json = JSON.stringify(items);
  const chunkSize = 30000;
  const rows = [];
  const createdAt = new Date().toISOString();
  let order = 1;
  for (let pos = 0; pos < json.length; pos += chunkSize) {
    rows.push([archiveId, String(taskId || ''), String(type || 'data'), String(operationId || ''), order++, json.slice(pos, pos + chunkSize), createdAt]);
  }
  if (rows.length) sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, V127_TASK_ARCHIVE_HEADERS.length).setValues(rows);
  return items.length;
}

function mergeTaskPayloadV127_(currentTask, incomingTask, action) {
  const incoming = cloneObject_(incomingTask || {});
  if (!currentTask) return incoming;
  const merged = Object.assign({}, cloneObject_(currentTask), incoming);

  // Histórico é sempre gerenciado no servidor.
  merged.historico = Array.isArray(currentTask.historico) ? cloneObject_(currentTask.historico) : [];

  const currentTracking = currentTask.timeTracking && typeof currentTask.timeTracking === 'object'
    ? cloneObject_(currentTask.timeTracking) : null;
  const incomingTracking = incoming.timeTracking && typeof incoming.timeTracking === 'object'
    ? cloneObject_(incoming.timeTracking) : null;

  if (currentTracking || incomingTracking) {
    if (['start','pause','resume','wait','approval_wait','complete'].indexOf(String(action || '')) >= 0) {
      // Para ações do cronômetro, o relógio do servidor é a fonte de verdade.
      merged.timeTracking = currentTracking || incomingTracking || {};
    } else {
      merged.timeTracking = Object.assign({}, currentTracking || {}, incomingTracking || {});
      if (currentTracking && Array.isArray(currentTracking.sessions)) {
        merged.timeTracking.sessions = cloneObject_(currentTracking.sessions);
      }
    }
  }

  // Campos ausentes no patch nunca apagam coleções existentes.
  ['comentarios','checklist','links'].forEach(function (field) {
    if (!Object.prototype.hasOwnProperty.call(incoming, field) && Array.isArray(currentTask[field])) {
      merged[field] = cloneObject_(currentTask[field]);
    }
  });
  return merged;
}

function compactQueuedTaskPayloadV127_(task, action) {
  const clean = cloneObject_(task || {});
  delete clean.historico;

  if (clean.timeTracking && typeof clean.timeTracking === 'object') {
    clean.timeTracking = cloneObject_(clean.timeTracking);
    delete clean.timeTracking.sessions;
  }

  // Ações do cronômetro não precisam reenviar o corpo inteiro da tarefa.
  if (['start','pause','resume','wait','approval_wait','complete'].indexOf(String(action || '')) >= 0) {
    return {
      id: clean.id,
      status: clean.status,
      progresso: clean.progresso,
      evidencia: clean.evidencia,
      justificativaAtraso: clean.justificativaAtraso,
      approvalStatus: clean.approvalStatus,
      aguardandoQuem: clean.aguardandoQuem,
      aguardandoDesde: clean.aguardandoDesde,
      motivoEspera: clean.motivoEspera,
      prazo: clean.prazo,
      prazoManual: clean.prazoManual === true,
      prazoAutomatico: clean.prazoAutomatico === true,
      concluidoEm: clean.concluidoEm,
      atualizadoEm: clean.atualizadoEm,
      timeTracking: clean.timeTracking ? {
        enabled: clean.timeTracking.enabled !== false,
        state: clean.timeTracking.state,
        completedAt: clean.timeTracking.completedAt,
        lastChangedAt: clean.timeTracking.lastChangedAt
      } : undefined
    };
  }
  return clean;
}

function compactTaskForStorageV127_(spreadsheet, task, operationId) {
  const clean = cloneObject_(task || {});
  const taskId = String(clean.id || '');

  clean.historico = Array.isArray(clean.historico) ? clean.historico : [];
  if (clean.historico.length > V127_TASK_INLINE_HISTORY) {
    const old = clean.historico.slice(0, clean.historico.length - V127_TASK_INLINE_HISTORY);
    archiveTaskArrayV127_(spreadsheet, taskId, 'historico', old, operationId);
    clean.historico = clean.historico.slice(-V127_TASK_INLINE_HISTORY);
    clean._historicoArquivado = Math.max(0, Number(clean._historicoArquivado || 0)) + old.length;
  }

  if (clean.timeTracking && typeof clean.timeTracking === 'object') {
    clean.timeTracking.sessions = Array.isArray(clean.timeTracking.sessions) ? clean.timeTracking.sessions : [];
    if (clean.timeTracking.sessions.length > V127_TASK_INLINE_SESSIONS) {
      const oldSessions = clean.timeTracking.sessions.slice(0, clean.timeTracking.sessions.length - V127_TASK_INLINE_SESSIONS);
      archiveTaskArrayV127_(spreadsheet, taskId, 'sessoes_tempo', oldSessions, operationId);
      clean.timeTracking.sessions = clean.timeTracking.sessions.slice(-V127_TASK_INLINE_SESSIONS);
      clean.timeTracking.archivedSessions = Math.max(0, Number(clean.timeTracking.archivedSessions || 0)) + oldSessions.length;
    }
  }

  let json = JSON.stringify(clean);
  if (json.length > V127_SAFE_CELL_CHARS && Array.isArray(clean.comentarios) && clean.comentarios.length > 20) {
    const keepComments = Math.min(V127_TASK_INLINE_COMMENTS, 20);
    const oldComments = clean.comentarios.slice(0, clean.comentarios.length - keepComments);
    archiveTaskArrayV127_(spreadsheet, taskId, 'comentarios', oldComments, operationId);
    clean.comentarios = clean.comentarios.slice(-keepComments);
    clean._comentariosArquivados = Math.max(0, Number(clean._comentariosArquivados || 0)) + oldComments.length;
    json = JSON.stringify(clean);
  }
  if (json.length > V127_SAFE_CELL_CHARS && Array.isArray(clean.links) && clean.links.length > 20) {
    const keepLinks = Math.min(V127_TASK_INLINE_LINKS, 20);
    const oldLinks = clean.links.slice(0, clean.links.length - keepLinks);
    archiveTaskArrayV127_(spreadsheet, taskId, 'links', oldLinks, operationId);
    clean.links = clean.links.slice(-keepLinks);
    clean._linksArquivados = Math.max(0, Number(clean._linksArquivados || 0)) + oldLinks.length;
    json = JSON.stringify(clean);
  }

  if (json.length >= 18000) {
    return {
      success:false,
      errorCode:'TASK_STORAGE_LIMIT',
      message:'A tarefa ainda possui conteúdo demais após o arquivamento automático. Reduza textos muito extensos para manter o salvamento rápido e seguro.'
    };
  }
  return { success:true, task:clean, size:json.length };
}

function ensureServerQueueV125_(spreadsheet) {
  const sheet = getOrCreateSheet_(spreadsheet || getSpreadsheet_(), V125_SERVER_QUEUE_SHEET);
  initializeHeaders_(sheet, V125_SERVER_QUEUE_HEADERS);
  return sheet;
}

function nextServerQueueSequenceV125_() {
  const props = PropertiesService.getScriptProperties();
  const next = Math.max(0, Number(props.getProperty(V125_SERVER_QUEUE_SEQ_PROP) || 0)) + 1;
  props.setProperty(V125_SERVER_QUEUE_SEQ_PROP, String(next));
  return next;
}

function serverQueueCacheKeyV1210_(operationId) {
  return v1210CacheKey_('SGO_SERVER_QUEUE_STATE', operationId);
}

function cacheServerQueueStateV1210_(row) {
  if (!row || !row.operationId) return;
  try {
    CacheService.getScriptCache().put(serverQueueCacheKeyV1210_(row.operationId), JSON.stringify({
      operationId:String(row.operationId || ''),
      userId:String(row.userId || ''),
      entityId:String(row.entityId || ''),
      action:String(row.action || ''),
      status:String(row.status || ''),
      attempts:Number(row.attempts || 0),
      nextAttemptAt:String(row.nextAttemptAt || ''),
      dependsOnOperationId:String(row.dependsOnOperationId || (row.payload && row.payload.dependsOnOperationId) || ''),
      result:row.result || null,
      error:String(row.error || '')
    }), 21600);
  } catch (ignored) {}
}

function getCachedServerQueueStateV1210_(operationId) {
  try {
    const raw = CacheService.getScriptCache().get(serverQueueCacheKeyV1210_(operationId));
    return raw ? JSON.parse(raw) : null;
  } catch (ignored) { return null; }
}

function serverQueueRowFromValuesV1217_(values, rowNumber) {
  if (!values) return null;
  let payload=null,result=null;
  try{payload=JSON.parse(String(values[6]||'null'));}catch(ignored){}
  try{result=JSON.parse(String(values[12]||'null'));}catch(ignored2){}
  const row={
    row:Number(rowNumber||0),sequence:Number(values[0]||0),operationId:String(values[1]||''),userId:String(values[2]||''),
    type:String(values[3]||''),action:String(values[4]||''),entityId:String(values[5]||''),payload:payload,status:String(values[7]||''),
    attempts:Number(values[8]||0),nextAttemptAt:valueToIso_(values[9]),dependsOnOperationId:String(payload&&payload.dependsOnOperationId||''),
    createdAt:valueToIso_(values[10]),updatedAt:valueToIso_(values[11]),result:result,error:String(values[13]||'')
  };
  if(row.operationId)cacheServerQueueStateV1210_(row);
  return row;
}

/** Checagem curta para corrida de primeira aceitação. Não substitui o lookup
 * durável de retry: procura apenas nas últimas linhas, onde uma chamada gêmea
 * acabaria de inserir o mesmo operationId. */
function getRecentServerQueueRowV1217_(spreadsheet, operationId, limit) {
  const sheet=ensureServerQueueV125_(spreadsheet), last=sheet.getLastRow();
  if(last<2)return null;
  const count=Math.min(Math.max(10,Number(limit||80)),last-1), start=last-count+1, key=String(operationId||'');
  const ids=sheet.getRange(start,2,count,1).getValues();
  for(let i=ids.length-1;i>=0;i-=1){
    if(String(ids[i][0]||'')!==key)continue;
    const rowNumber=start+i;
    const values=sheet.getRange(rowNumber,1,1,V125_SERVER_QUEUE_HEADERS.length).getValues()[0];
    v1210SetCachedRow_('SGO_SERVER_QUEUE_ROW',key,rowNumber);
    return serverQueueRowFromValuesV1217_(values,rowNumber);
  }
  return null;
}

function getServerQueueRowV125_(spreadsheet, operationId) {
  const sheet = ensureServerQueueV125_(spreadsheet);
  if (sheet.getLastRow() < 2) return null;
  const key = String(operationId || '');
  let rowNumber = v1210GetCachedRow_('SGO_SERVER_QUEUE_ROW', key);
  let values = null;

  if (rowNumber >= 2 && rowNumber <= sheet.getLastRow()) {
    const candidate = sheet.getRange(rowNumber, 1, 1, V125_SERVER_QUEUE_HEADERS.length).getValues()[0];
    if (String(candidate[1] || '') === key) values = candidate;
    else rowNumber = 0;
  }

  if (!values) {
    const found = sheet.getRange(2, 2, sheet.getLastRow() - 1, 1)
      .createTextFinder(key).matchEntireCell(true).findNext();
    if (!found) return null;
    rowNumber = found.getRow();
    values = sheet.getRange(rowNumber, 1, 1, V125_SERVER_QUEUE_HEADERS.length).getValues()[0];
    v1210SetCachedRow_('SGO_SERVER_QUEUE_ROW', key, rowNumber);
  }

  return serverQueueRowFromValuesV1217_(values, rowNumber);
}

function writeServerQueueRowV125_(spreadsheet, rowData) {
  const sheet = ensureServerQueueV125_(spreadsheet);
  const now = new Date().toISOString();
  let existing = rowData.row ? rowData : null;
  if (!existing && Number(rowData.lookupExisting || 0) === 1) existing = getServerQueueRowV125_(spreadsheet, rowData.operationId);

  const createdAt = String((existing && existing.createdAt) || rowData.createdAt || now);
  const sequence = Number((existing && existing.sequence) || rowData.sequence || nextServerQueueSequenceV125_());
  const values = [
    sequence, String(rowData.operationId || ''), String(rowData.userId || ''), String(rowData.type || 'task'),
    String(rowData.action || 'update'), String(rowData.entityId || ''), JSON.stringify(rowData.payload || null),
    String(rowData.status || 'RECEIVED'), Number(rowData.attempts || 0), String(rowData.nextAttemptAt || ''),
    createdAt, now, JSON.stringify(rowData.result || null), String(rowData.error || '')
  ];

  let rowNumber = existing && existing.row ? existing.row : 0;
  if (rowNumber) {
    sheet.getRange(rowNumber, 1, 1, V125_SERVER_QUEUE_HEADERS.length).setValues([values]);
    v1210SetCachedRow_('SGO_SERVER_QUEUE_ROW', rowData.operationId, rowNumber);
  } else {
    // Novas operações só entram aqui sob o claim curto de acceptTaskOperationServer.
    // Gravamos a linha conhecida e armazenamos imediatamente operationId -> row,
    // eliminando o segundo TextFinder no claim/processamento subsequente.
    rowNumber = sheet.getLastRow() + 1;
    sheet.getRange(rowNumber, 1, 1, V125_SERVER_QUEUE_HEADERS.length).setValues([values]);
    v1210SetCachedRow_('SGO_SERVER_QUEUE_ROW', rowData.operationId, rowNumber);
  }

  const output = {
    row:rowNumber, sequence:sequence, operationId:String(rowData.operationId || ''),
    userId:String(rowData.userId || ''), type:String(rowData.type || 'task'),
    action:String(rowData.action || 'update'), entityId:String(rowData.entityId || ''),
    payload:rowData.payload || null, status:String(rowData.status || 'RECEIVED'),
    attempts:Number(rowData.attempts || 0), nextAttemptAt:String(rowData.nextAttemptAt || ''),
    dependsOnOperationId:String(rowData.dependsOnOperationId || (rowData.payload && rowData.payload.dependsOnOperationId) || ''),
    createdAt:createdAt, updatedAt:now, result:rowData.result || null, error:String(rowData.error || '')
  };
  cacheServerQueueStateV1210_(output);
  return output;
}

function sanitizeQueuedTaskPayloadV125_(payload) {
  const action = String(payload.action || 'update');
  return {
    operationId:String(payload.operationId || ''), taskId:String(payload.taskId || (payload.task && payload.task.id) || ''),
    expectedVersion:Math.max(0, Number(payload.expectedVersion || 0)), action:action,
    task:compactQueuedTaskPayloadV127_(payload.task || {}, action), deleted:Boolean(payload.deleted), approved:payload.approved !== false,
    clientActionAt:String(payload.clientActionAt || ''), dependsOnOperationId:String(payload.dependsOnOperationId || '')
  };
}


/** Reserva uma faixa de sequências da fila sob um lock já adquirido. */
function reserveServerQueueSequencesV1218_(count) {
  count=Math.max(0,Math.min(20,Number(count||0)));
  if(!count)return 0;
  const props=PropertiesService.getScriptProperties();
  const current=Math.max(0,Number(props.getProperty(V125_SERVER_QUEUE_SEQ_PROP)||0));
  props.setProperty(V125_SERVER_QUEUE_SEQ_PROP,String(current+count));
  return current+1;
}

/** v12.18.4 — depois de aceitar, tenta processar a própria operação na mesma
 * RPC sem transformar SERVER_BUSY em falha de aceitação. Se o core não puder avançar,
 * a linha permanece RECEIVED com backoff e o cliente apenas acompanha o status. */
function queueAcceptAndMaybeProcessV12184_(payload, auth, operationId, rowHint) {
  if (!payload || payload.processNow !== true || !operationId) return null;
  let processed=null;
  try { processed=processOneServerQueueOperationV125_(operationId,String(payload.sessionToken||''),auth&&auth.user||null,rowHint||null); }
  catch(ignoredProcessV12184){ processed=null; }
  const spreadsheet=getSpreadsheet_();
  const row=getCachedServerQueueStateV1210_(operationId)||getServerQueueRowV125_(spreadsheet,operationId);
  if(!row)return null;
  const status=String(row.status||'RECEIVED').toUpperCase();
  if((status==='COMPLETED'||status==='EFFECTS_PENDING')&&row.result){
    return {status:'completed',result:row.result,sideEffectsPending:status==='EFFECTS_PENDING'};
  }
  if((status==='CONFLICT'||status==='REJECTED')&&row.result)return {status:status.toLowerCase(),result:row.result};
  const dep=operationDependencyInfoV12181_(spreadsheet,row);
  return Object.assign({status:status==='PROCESSING'?'processing':'received'},dep);
}

/**
 * v12.18 — aceitação em lote de uma cadeia do cronômetro.
 * Cinco cliques rápidos deixam de disputar cinco vezes o ScriptLock apenas para
 * entrar na fila. Cada ação preserva operationId/payload/dependência próprios.
 */
function acceptTaskOperationBatchServer(payload) {
  payload=payload||{};
  const operationId=String(payload.operationId||'batch_'+Utilities.getUuid());
  let auth;
  try{auth=requireSessionV12_(payload,true);}catch(error){return errorResponse_('SESSION_INVALID','Sua sessão expirou. Entre novamente.',getDatabaseVersion_(),operationId);}
  const raw=Array.isArray(payload.operations)?payload.operations.slice(0,10):[];
  if(!raw.length)return errorResponse_('INVALID_OPERATION_BATCH','Nenhuma operação foi informada para o lote.',getDatabaseVersion_(),operationId);
  const allowed=['create','update','start','pause','resume','wait','approval_wait','complete','approve','reject','audit','delete'];
  const prepared=[];
  for(let i=0;i<raw.length;i+=1){
    const source=raw[i]||{}, opId=String(source.operationId||'');
    if(!opId)return errorResponse_('OPERATION_ID_REQUIRED','Uma operação do lote não possui identificador.',getDatabaseVersion_(),operationId);
    const action=String(source.action||'update');
    if(allowed.indexOf(action)<0)return errorResponse_('INVALID_ACTION','Uma ação do lote é inválida.',getDatabaseVersion_(),opId);
    const clean=sanitizeQueuedTaskPayloadV125_(source);
    if(!clean.taskId)return errorResponse_('INVALID_TASK','Uma tarefa do lote não foi informada.',getDatabaseVersion_(),opId);
    const json=JSON.stringify(clean);
    if(json.length>45000)return errorResponse_('OPERATION_TOO_LARGE','Uma operação do cronômetro acumulou dados demais.',getDatabaseVersion_(),opId);
    prepared.push({operationId:opId,action:action,clean:clean,payloadJson:json});
  }

  // Cache resolve retries comuns sem lock. Itens não encontrados são verificados
  // em uma única janela recente dentro do lock antes da gravação em bloco.
  const resolved={}, pending=[];
  prepared.forEach(function(entry){
    const cached=getCachedServerQueueStateV1210_(entry.operationId);
    if(cached){
      if(cached.userId&&cached.userId!==auth.user.id&&String(auth.user.perfil||'')!=='admin')resolved[entry.operationId]={error:'OPERATION_OWNERSHIP'};
      else resolved[entry.operationId]=cached;
    } else pending.push(entry);
  });
  const ownershipError=Object.keys(resolved).some(function(key){return resolved[key]&&resolved[key].error==='OPERATION_OWNERSHIP';});
  if(ownershipError)return errorResponse_('OPERATION_OWNERSHIP','Uma operação do lote pertence a outro usuário.',getDatabaseVersion_(),operationId);

  if(pending.length){
    const spreadsheet=getSpreadsheet_(), sheet=ensureServerQueueV125_(spreadsheet);
    // v12.18.4: a leitura das linhas recentes é feita FORA do ScriptLock. Dentro
    // dele fica apenas a rechecagem de cache + append em bloco, reduzindo muito o
    // tempo em que outros usuários recebem QUEUE_BATCH_ACCEPT_LOCK_BUSY.
    const recentMapV12184={};
    const recentLastV12184=sheet.getLastRow();
    if(recentLastV12184>=2){
      const recentCountV12184=Math.min(200,recentLastV12184-1), recentStartV12184=recentLastV12184-recentCountV12184+1;
      const recentValuesV12184=sheet.getRange(recentStartV12184,1,recentCountV12184,V125_SERVER_QUEUE_HEADERS.length).getValues();
      recentValuesV12184.forEach(function(values,index){const key=String(values[1]||'');if(key)recentMapV12184[key]=serverQueueRowFromValuesV1217_(values,recentStartV12184+index);});
    }
    const lockRequestedAt=Date.now(), lock=tryWriteLockV12_(1200);
    if(!lock){
      taskDiagnosticV128_({level:'WARN',origin:'server',module:'queue',step:'QUEUE_BATCH_ACCEPT_LOCK_BUSY',operationId:operationId,userId:auth.user.id,status:'busy',errorCode:'SERVER_BUSY',durationMs:Date.now()-lockRequestedAt,context:{batchSize:prepared.length,pending:pending.length}});
      return serverBusyV12_(operationId);
    }
    try{
      const toInsert=[];
      pending.forEach(function(entry){
        // Uma chamada concorrente que inseriu a mesma operação enquanto aguardávamos
        // o lock já terá preenchido o cache antes de liberar o lock anterior.
        const existing=getCachedServerQueueStateV1210_(entry.operationId)||recentMapV12184[entry.operationId];
        if(existing){
          if(existing.userId&&existing.userId!==auth.user.id&&String(auth.user.perfil||'')!=='admin')throw new Error('OPERATION_OWNERSHIP');
          resolved[entry.operationId]=existing;
        } else toInsert.push(entry);
      });
      if(toInsert.length){
        const firstSequence=reserveServerQueueSequencesV1218_(toInsert.length);
        const now=new Date().toISOString(), firstRow=sheet.getLastRow()+1;
        const values=toInsert.map(function(entry,index){
          return [firstSequence+index,entry.operationId,auth.user.id,'task',entry.action,entry.clean.taskId,JSON.stringify(entry.clean),'RECEIVED',0,'',now,now,JSON.stringify(null),''];
        });
        sheet.getRange(firstRow,1,values.length,V125_SERVER_QUEUE_HEADERS.length).setValues(values);
        toInsert.forEach(function(entry,index){
          const row={row:firstRow+index,sequence:firstSequence+index,operationId:entry.operationId,userId:auth.user.id,type:'task',action:entry.action,entityId:entry.clean.taskId,payload:entry.clean,status:'RECEIVED',attempts:0,nextAttemptAt:'',dependsOnOperationId:String(entry.clean.dependsOnOperationId||''),createdAt:now,updatedAt:now,result:null,error:''};
          v1210SetCachedRow_('SGO_SERVER_QUEUE_ROW',entry.operationId,row.row); cacheServerQueueStateV1210_(row); resolved[entry.operationId]=row;
        });
      }
    }catch(error){
      if(String(error&&error.message||'')==='OPERATION_OWNERSHIP')return errorResponse_('OPERATION_OWNERSHIP','Uma operação do lote pertence a outro usuário.',getDatabaseVersion_(),operationId);
      taskDiagnosticV128_({level:'ERROR',origin:'server',module:'queue',step:'QUEUE_BATCH_ACCEPT_FAILURE',operationId:operationId,userId:auth.user.id,status:'failed',errorCode:'QUEUE_ACCEPT_FAILURE',message:safeErrorMessage_(error),context:{batchSize:prepared.length}});
      return errorResponse_('QUEUE_ACCEPT_FAILURE','Não foi possível registrar o lote do cronômetro agora. As operações continuam preservadas no dispositivo.',getDatabaseVersion_(),operationId);
    }finally{lock.releaseLock();}
  }

  const processOperationIdV12184=String(payload.processOperationId||'');
  if(payload.processNow===true && processOperationIdV12184 && prepared.some(function(entry){return entry.operationId===processOperationIdV12184;})){
    const processRowV12184=resolved[processOperationIdV12184]||null;
    queueAcceptAndMaybeProcessV12184_(payload,auth,processOperationIdV12184,processRowV12184);
    const refreshedV12184=getCachedServerQueueStateV1210_(processOperationIdV12184)||getServerQueueRowV125_(getSpreadsheet_(),processOperationIdV12184);
    if(refreshedV12184)resolved[processOperationIdV12184]=refreshedV12184;
  }

  const results=prepared.map(function(entry){
    const row=resolved[entry.operationId]||{};
    const rawStatus=String(row.status||'RECEIVED').toUpperCase();
    const publicStatus=rawStatus==='COMPLETED'||rawStatus==='EFFECTS_PENDING'?'completed':rawStatus==='CONFLICT'?'conflict':rawStatus==='REJECTED'?'rejected':rawStatus==='PROCESSING'?'processing':'received';
    return {operationId:entry.operationId,status:publicStatus,result:row.result||null,sideEffectsPending:rawStatus==='EFFECTS_PENDING'};
  });
  taskDiagnosticV128_({level:'INFO',origin:'server',module:'queue',step:'SERVER_QUEUE_BATCH_ACCEPTED',operationId:operationId,userId:auth.user.id,status:'received',context:{batchSize:results.length}});
  return successResponse_({operationId:operationId,databaseVersion:getDatabaseVersion_(),data:{accepted:true,batch:true,operations:results}});
}

function acceptTaskOperationServer(payload) {
  payload = payload || {};
  const acceptStartedAtV1216 = Date.now();
  const acceptPerfV1216 = {};
  const operationId = String(payload.operationId || '');
  if (!operationId) return errorResponse_('OPERATION_ID_REQUIRED', 'A operação não possui identificador.', getDatabaseVersion_(), operationId);
  let auth;
  const acceptAuthAtV1216 = Date.now();
  try { auth = requireSessionV12_(payload, true); }
  catch (error) { return errorResponse_('SESSION_INVALID', 'Sua sessão expirou. Entre novamente.', getDatabaseVersion_(), operationId); }
  acceptPerfV1216.authMs = Date.now() - acceptAuthAtV1216;

  const allowed = ['create','update','start','pause','resume','wait','approval_wait','complete','approve','reject','audit','delete'];
  const action = String(payload.action || 'update');
  if (allowed.indexOf(action) < 0) return errorResponse_('INVALID_ACTION', 'A ação de tarefa é inválida.', getDatabaseVersion_(), operationId);
  const clean = sanitizeQueuedTaskPayloadV125_(payload);
  if (!clean.taskId) return errorResponse_('INVALID_TASK', 'A tarefa não foi informada.', getDatabaseVersion_(), operationId);
  const payloadJson = JSON.stringify(clean);
  if (payloadJson.length > 45000) return errorResponse_('OPERATION_TOO_LARGE', 'A tarefa acumulou dados demais para a fila. Arquive comentários ou histórico antigo antes de salvar.', getDatabaseVersion_(), operationId);

  // v12.16: a aceitação usa apenas um claim global curto para garantir idempotência
  // e sequência da fila. O lock não envolve validação pesada nem persistência da tarefa;
  // retries consultam cache/fila e retornam o estado já conhecido quando possível.
  const cacheLookupAtV1216 = Date.now();
  const cached = getCachedServerQueueStateV1210_(operationId);
  acceptPerfV1216.cacheLookupMs = Date.now() - cacheLookupAtV1216;
  if (cached) {
    if (cached.userId && cached.userId !== auth.user.id && String(auth.user.perfil || '') !== 'admin') {
      return errorResponse_('OPERATION_OWNERSHIP', 'A operação pertence a outro usuário.', getDatabaseVersion_(), operationId);
    }
    if (String(cached.status || '').toUpperCase() === 'EFFECTS_PENDING' && cached.result) {
      return successResponse_({ operationId:operationId, databaseVersion:getDatabaseVersion_(), data:{ accepted:true, status:'completed', result:cached.result, sideEffectsPending:true } });
    }
    if (['RECEIVED','PROCESSING'].indexOf(String(cached.status || '').toUpperCase()) >= 0) {
      const cachedImmediateV12184=String(cached.status||'').toUpperCase()==='RECEIVED' ? queueAcceptAndMaybeProcessV12184_(payload,auth,operationId,cached) : null;
      return successResponse_({ operationId:operationId, databaseVersion:getDatabaseVersion_(), data:Object.assign({ accepted:true, status:String(cached.status || 'RECEIVED').toLowerCase() },cachedImmediateV12184||{}) });
    }
  }

  const spreadsheet = getSpreadsheet_();
  const clientAttempt = Math.max(1, Number(payload.clientAttempt || 1));
  // v12.17: TextFinder nunca roda segurando o ScriptLock da fila. O lookup caro
  // ocorre antes; dentro do lock só rechecamos o cache criado por uma corrida.
  let existing = null;
  if (clientAttempt > 1 || ['COMPLETED','CONFLICT','REJECTED'].indexOf(String(cached && cached.status || '').toUpperCase()) >= 0) {
    const existingLookupAtV1216 = Date.now();
    existing = getServerQueueRowV125_(spreadsheet, operationId);
    acceptPerfV1216.retryLookupMs = Date.now() - existingLookupAtV1216;
  }
  if (existing) {
    if (existing.userId !== auth.user.id && String(auth.user.perfil || '') !== 'admin') {
      return errorResponse_('OPERATION_OWNERSHIP', 'A operação pertence a outro usuário.', getDatabaseVersion_(), operationId);
    }
    if ((existing.status === 'COMPLETED' || existing.status === 'EFFECTS_PENDING') && existing.result) {
      return successResponse_({ operationId:operationId, databaseVersion:getDatabaseVersion_(), data:{ accepted:true, status:'completed', result:existing.result, sideEffectsPending:existing.status === 'EFFECTS_PENDING' } });
    }
    if ((existing.status === 'CONFLICT' || existing.status === 'REJECTED') && existing.result) {
      return successResponse_({ operationId:operationId, databaseVersion:getDatabaseVersion_(), data:{ accepted:true, status:existing.status.toLowerCase(), result:existing.result } });
    }
    const existingImmediateV12184=String(existing.status||'').toUpperCase()==='RECEIVED' ? queueAcceptAndMaybeProcessV12184_(payload,auth,operationId,existing) : null;
    return successResponse_({ operationId:operationId, databaseVersion:getDatabaseVersion_(), data:Object.assign({ accepted:true, status:String(existing.status || 'RECEIVED').toLowerCase() },existingImmediateV12184||{}) });
  }

  // v12.18.4: também procura a janela recente antes do lock no primeiro envio.
  // Isso substitui a leitura de planilha que antes acontecia DENTRO da seção crítica.
  const recentBeforeLockV12184 = getRecentServerQueueRowV1217_(spreadsheet, operationId, 80);
  if (recentBeforeLockV12184) {
    if (recentBeforeLockV12184.userId !== auth.user.id && String(auth.user.perfil || '') !== 'admin') return errorResponse_('OPERATION_OWNERSHIP','A operação pertence a outro usuário.',getDatabaseVersion_(),operationId);
    const rbStatusV12184=String(recentBeforeLockV12184.status||'RECEIVED').toUpperCase();
    if((rbStatusV12184==='COMPLETED'||rbStatusV12184==='EFFECTS_PENDING')&&recentBeforeLockV12184.result)return successResponse_({operationId:operationId,databaseVersion:getDatabaseVersion_(),data:{accepted:true,status:'completed',result:recentBeforeLockV12184.result,sideEffectsPending:rbStatusV12184==='EFFECTS_PENDING'}});
    if((rbStatusV12184==='CONFLICT'||rbStatusV12184==='REJECTED')&&recentBeforeLockV12184.result)return successResponse_({operationId:operationId,databaseVersion:getDatabaseVersion_(),data:{accepted:true,status:rbStatusV12184.toLowerCase(),result:recentBeforeLockV12184.result}});
    const immediateExistingV12184=queueAcceptAndMaybeProcessV12184_(payload,auth,operationId,recentBeforeLockV12184);
    return successResponse_({operationId:operationId,databaseVersion:getDatabaseVersion_(),data:Object.assign({accepted:true},immediateExistingV12184||{status:String(recentBeforeLockV12184.status||'RECEIVED').toLowerCase()})});
  }

  // Claim curtíssimo e atômico: impede duas chamadas simultâneas de criarem
  // linhas distintas para o mesmo operationId e reserva a sequência da fila uma vez.
  const queueAcceptLockRequestedAtV1216 = Date.now();
  const queueAcceptLock = tryWriteLockV12_(900);
  acceptPerfV1216.lockWaitMs = Date.now() - queueAcceptLockRequestedAtV1216;
  if (!queueAcceptLock) {
    taskDiagnosticV128_({level:'WARN',origin:'server',module:'queue',step:'QUEUE_ACCEPT_LOCK_BUSY',operationId:operationId,userId:auth.user.id,entityId:clean.taskId,action:action,status:'busy',errorCode:'SERVER_BUSY',durationMs:Date.now()-acceptStartedAtV1216,context:taskPerfContextV1216_(acceptPerfV1216)});
    return serverBusyV12_(operationId);
  }
  const queueAcceptLockAcquiredAtV1216 = Date.now();
  try {
    const raceLookupAtV1216 = Date.now();
    const raceExisting = getCachedServerQueueStateV1210_(operationId);
    acceptPerfV1216.raceLookupMs = Date.now() - raceLookupAtV1216;
    if (raceExisting) {
      if (raceExisting.userId !== auth.user.id && String(auth.user.perfil || '') !== 'admin') return errorResponse_('OPERATION_OWNERSHIP', 'A operação pertence a outro usuário.', getDatabaseVersion_(), operationId);
      if (raceExisting.status === 'EFFECTS_PENDING' && raceExisting.result) {
        return successResponse_({ operationId:operationId, databaseVersion:getDatabaseVersion_(), data:{ accepted:true, status:'completed', result:raceExisting.result, sideEffectsPending:true } });
      }
      return successResponse_({ operationId:operationId, databaseVersion:getDatabaseVersion_(), data:{ accepted:true, status:String(raceExisting.status || 'RECEIVED').toLowerCase(), result:raceExisting.result || null } });
    }
    const queueWriteAtV1216 = Date.now();
    writeServerQueueRowV125_(spreadsheet, {
      operationId:operationId, userId:auth.user.id, type:'task', action:action, entityId:clean.taskId,
      payload:clean, status:'RECEIVED', attempts:0, nextAttemptAt:'', error:''
    });
    acceptPerfV1216.queueWriteMs = Date.now() - queueWriteAtV1216;
  } finally {
    acceptPerfV1216.lockHeldMs = Date.now() - queueAcceptLockAcquiredAtV1216;
    queueAcceptLock.releaseLock();
  }
  acceptPerfV1216.totalMs = Date.now() - acceptStartedAtV1216;
  const acceptContextV1216 = taskPerfContextV1216_(acceptPerfV1216);
  acceptContextV1216.payloadSize = payloadJson.length;
  acceptContextV1216.clientAttempt = clientAttempt;
  taskDiagnosticV128_({level:acceptPerfV1216.totalMs>=1200?'WARN':'INFO',origin:'server',module:'queue',step:'SERVER_QUEUE_ACCEPTED',operationId:operationId,userId:auth.user.id,entityId:clean.taskId,action:action,status:'received',recordVersion:clean.expectedVersion,durationMs:acceptPerfV1216.totalMs,context:acceptContextV1216});
  const immediateV12184=queueAcceptAndMaybeProcessV12184_(payload,auth,operationId,getCachedServerQueueStateV1210_(operationId));
  return successResponse_({ operationId:operationId, databaseVersion:getDatabaseVersion_(), data:Object.assign({ accepted:true, status:'received' },immediateV12184||{}) });
}

function claimServerQueueOperationV125_(spreadsheet, operationId, preloadedRow) {
  // Lease de claim extremamente curto: só lê e marca PROCESSING. O trabalho pesado
  // ocorre depois, fora do lock. Assim dois workers nunca processam a mesma linha.
  const perf = {};
  const claimStartedAt = Date.now();
  const claimLockRequestedAt = Date.now();
  const claimLock = tryWriteLockV12_(900);
  perf.lockWaitMs = Date.now() - claimLockRequestedAt;
  if (!claimLock) return { busy:true, perf:perf };
  const claimLockAcquiredAt = Date.now();
  try {
    const lookupAt = Date.now();
    let row = preloadedRow || null;
    if (row && Number(row.row || 0) >= 2) {
      const sheet = ensureServerQueueV125_(spreadsheet);
      const values = sheet.getRange(Number(row.row),1,1,V125_SERVER_QUEUE_HEADERS.length).getValues()[0];
      if (String(values[1] || '') === String(operationId || '')) {
        let payload = null, result = null;
        try { payload = JSON.parse(String(values[6] || 'null')); } catch (ignored) {}
        try { result = JSON.parse(String(values[12] || 'null')); } catch (ignored2) {}
        row = {row:Number(row.row),sequence:Number(values[0]||0),operationId:String(values[1]||''),userId:String(values[2]||''),type:String(values[3]||''),action:String(values[4]||''),entityId:String(values[5]||''),payload:payload,status:String(values[7]||''),attempts:Number(values[8]||0),nextAttemptAt:valueToIso_(values[9]),dependsOnOperationId:String(payload&&payload.dependsOnOperationId||''),createdAt:valueToIso_(values[10]),updatedAt:valueToIso_(values[11]),result:result,error:String(values[13]||'')};
      } else row = getServerQueueRowV125_(spreadsheet, operationId);
    } else row = getServerQueueRowV125_(spreadsheet, operationId);
    perf.lookupMs = Date.now() - lookupAt;
    if (!row) return { missing:true, perf:perf };
    if (['COMPLETED','CONFLICT','REJECTED'].indexOf(row.status) >= 0) return { row:row, final:true, perf:perf };
    if (row.status === 'PROCESSING') {
      const leaseUntil = row.nextAttemptAt ? new Date(row.nextAttemptAt).getTime() : 0;
      if (Number.isFinite(leaseUntil) && leaseUntil > Date.now()) return { row:row, processing:true, perf:perf };
    }
    const nextAt = row.nextAttemptAt ? new Date(row.nextAttemptAt).getTime() : 0;
    if (row.status !== 'PROCESSING' && Number.isFinite(nextAt) && nextAt > Date.now()) return { row:row, waiting:true, perf:perf };
    row.status = 'PROCESSING'; row.attempts = Number(row.attempts || 0) + 1; row.error = '';
    row.nextAttemptAt = new Date(Date.now() + 120000).toISOString();
    const writeAt = Date.now();
    const written = writeServerQueueRowV125_(spreadsheet, row);
    perf.writeMs = Date.now() - writeAt;
    return { row:written, perf:perf };
  } finally {
    perf.lockHeldMs = Date.now() - claimLockAcquiredAt;
    perf.totalMs = Date.now() - claimStartedAt;
    claimLock.releaseLock();
  }
}

function temporarySessionForQueueV125_(spreadsheet, userId) {
  const meta = getRecordMeta_(spreadsheet, 'collaborators', String(userId || ''));
  if (!meta || meta.deleted || !meta.data || meta.data.ativo === false) return null;
  return createSessionV12_(meta.data, 5);
}

function finishServerQueueAttemptV125_(spreadsheet, row, result) {
  const code = String(result && result.errorCode || '');
  let returnResult = result;
  if (result && result.success && result.confirmed && result.data && result.data.sideEffectsPending) {
    // O contexto dos efeitos é exclusivamente do servidor. Persiste junto ao payload
    // da fila e não é devolvido ao navegador nem reabre o core da tarefa depois.
    const deferred = result.data._deferredEffects ? cloneObject_(result.data._deferredEffects) : null;
    row.payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
    if (deferred) {
      // Depois que o core está salvo, o snapshot completo da tarefa não é mais
      // necessário para recuperar efeitos. Compactar aqui evita que PAYLOAD_JSON
      // cresça perto do limite de 50 mil caracteres ao anexar o contexto.
      row.payload = {
        operationId:String(row.operationId||row.payload.operationId||''), taskId:String(row.entityId||row.payload.taskId||''),
        action:String(row.action||row.payload.action||''), dependsOnOperationId:String(row.dependsOnOperationId||row.payload.dependsOnOperationId||''),
        _deferredEffects:deferred
      };
    }
    returnResult = cloneObject_(result); if (returnResult.data) delete returnResult.data._deferredEffects;
    row.status = 'EFFECTS_PENDING'; row.result = returnResult; row.error = String(result.data.sideEffectsError || 'Efeitos complementares pendentes.');
    const effectDelays = [15000,30000,60000,180000,300000];
    row.nextAttemptAt = new Date(Date.now() + effectDelays[Math.min(Math.max(0, Number(row.attempts || 1) - 1), effectDelays.length - 1)]).toISOString();
  } else if (result && result.success && result.confirmed) {
    row.status = 'COMPLETED'; row.result = result; row.error = ''; row.nextAttemptAt = '';
  } else if (result && (result.conflict || code === 'VERSION_CONFLICT')) {
    row.status = 'CONFLICT'; row.result = result; row.error = String(result.message || 'Conflito de versão.'); row.nextAttemptAt = '';
  } else if (V125_SERVER_QUEUE_PERMANENT_ERRORS[code]) {
    row.status = 'REJECTED'; row.result = result; row.error = String(result && result.message || 'Operação rejeitada.'); row.nextAttemptAt = '';
  } else {
    row.status = 'RECEIVED'; row.result = null; row.error = String(result && result.message || 'Falha temporária.');
    const delays = [3000,10000,30000,60000,180000];
    const delay = delays[Math.min(Math.max(0, Number(row.attempts || 1) - 1), delays.length - 1)];
    row.nextAttemptAt = new Date(Date.now() + delay).toISOString();
  }
  taskDiagnosticV128_({level:row.status==='COMPLETED'?'INFO':(['RECEIVED','EFFECTS_PENDING'].indexOf(row.status)>=0?'WARN':'ERROR'),origin:'server',module:'queue',step:'SERVER_QUEUE_ATTEMPT',operationId:row.operationId,userId:row.userId,entityId:row.entityId,action:row.action,status:String(row.status||'').toLowerCase(),errorCode:code,message:row.error||'',attempt:row.attempts,databaseVersion:getDatabaseVersion_(),context:{nextAttemptAt:row.nextAttemptAt||''}});
  // A fila do servidor é a fonte oficial do status das operações assíncronas.
  // Não espelhamos cada tentativa em SGO_OPERACOES: isso eliminava duas buscas/
  // gravações extras por tentativa e era uma das maiores fontes de contenção.
  writeServerQueueRowV125_(spreadsheet, row);
  return returnResult;
}


/** v12.18.2 — recuperação direta de cronômetro congelado.
 * Não depende da fila de tarefa para decidir o descarte: registra primeiro um
 * tombstone semântico e depois cancela o registro oficial, preservando histórico. */
function abandonTimedTaskServer(payload) {
  payload=payload||{};
  const operationId=String(payload.operationId||('abandon_'+Utilities.getUuid()));
  let auth;
  try{auth=requireSessionV12_(payload,true);}catch(error){return errorResponse_('SESSION_INVALID','Sua sessão expirou. Entre novamente.',getDatabaseVersion_(),operationId);}
  const taskId=String(payload.taskId||'');
  if(!taskId)return errorResponse_('INVALID_TASK','A tarefa não foi informada.',getDatabaseVersion_(),operationId);
  const spreadsheet=getSpreadsheet_();
  const meta=getRecordMeta_(spreadsheet,'tasks',taskId);
  const current=meta&&!meta.deleted?cloneObject_(meta.data):null;
  if(current && !canMutateTaskV12_(auth.user,current,current,false))return errorResponse_('PERMISSION_DENIED','Seu perfil não pode descartar esta tarefa.',getDatabaseVersion_(),operationId);

  const now=new Date().toISOString();
  PropertiesService.getScriptProperties().setProperty(timerAbandonPropertyKeyV12182_(taskId),JSON.stringify({userId:String(auth.user.id||''),ownerId:String(current&&current.responsavelId||''),requestedBy:String(auth.user.id||''),abandonedAt:now,reason:'FROZEN_TIMER_RECOVERY'}));

  const localIds=(Array.isArray(payload.localOperationIds)?payload.localOperationIds:[]).map(function(id){return String(id||'');}).filter(Boolean).slice(0,300);
  let discardSummary={registered:0,processing:0};
  if(localIds.length){
    try{const dropped=discardPendingClientOperationsServer({sessionToken:payload.sessionToken,operationId:'discard_'+operationId,operationIds:localIds});if(dropped&&dropped.success&&dropped.data)discardSummary=dropped.data;}catch(ignored){}
  }

  if(!current){
    taskDiagnosticV128_({level:'WARN',origin:'server',module:'timer',step:'FROZEN_TIMER_ABANDONED',operationId:operationId,userId:auth.user.id,entityId:taskId,action:'abandon',status:'confirmed',context:{alreadyMissing:true,discardedLocalOps:localIds.length}});
    return successResponse_({operationId:operationId,recordId:taskId,recordVersion:Number(meta&&meta.version||0),databaseVersion:getDatabaseVersion_(),data:{abandoned:true,alreadyMissing:true,task:null,discardSummary:discardSummary,changedRecords:[],sequence:getChangeSequenceV12_()}});
  }
  if(String(current.status||'')==='Cancelada' || (current._timerAbandonedAt && current.timeTracking && String(current.timeTracking.state||'')==='completed')){
    return successResponse_({operationId:operationId,recordId:taskId,recordVersion:Number(meta.version||0),databaseVersion:getDatabaseVersion_(),data:{abandoned:true,alreadyCancelled:true,task:current,discardSummary:discardSummary,changedRecords:[{collection:'tasks',id:taskId,version:Number(meta.version||0),deleted:false,data:current}],sequence:getChangeSequenceV12_()}});
  }
  const next=cloneObject_(current);
  next.status='Cancelada';
  next.aguardandoQuem=''; next.aguardandoDesde=''; next.motivoEspera='';
  next._timerAbandonedAt=now; next._timerAbandonedBy=String(auth.user.id||'');
  const result=mutateTaskServer(Object.assign({},payload,{operationId:operationId,taskId:taskId,expectedVersion:Number(meta.version||0),action:'update',task:next,_timerRecovery:true}));
  if(result&&result.success&&result.data){result.data.abandoned=true;result.data.discardSummary=discardSummary;}
  if(result&&result.success)taskDiagnosticV128_({level:'WARN',origin:'server',module:'timer',step:'FROZEN_TIMER_ABANDONED',operationId:operationId,userId:auth.user.id,entityId:taskId,action:'abandon',status:'confirmed',recordVersion:Number(result.recordVersion||0),context:{discardedLocalOps:localIds.length}});
  return result;
}

/** v12.18.1 — descarte coordenado de operações abandonadas no dispositivo.
 * O registro fica em ScriptProperties para que uma operação já aceita no servidor
 * não volte a ser executada depois que o usuário limpar a fila local. */
const V12181_DISCARD_PROP_PREFIX = 'SGO_V12181_DROP_';
function queueDiscardPropertyKeyV12181_(operationId) {
  return V12181_DISCARD_PROP_PREFIX + String(operationId || '').replace(/[^A-Za-z0-9_-]/g,'_').slice(0,140);
}
function queueDiscardInfoV12181_(operationId) {
  try {
    const raw=PropertiesService.getScriptProperties().getProperty(queueDiscardPropertyKeyV12181_(operationId));
    return raw ? JSON.parse(raw) : null;
  } catch (ignored) { return null; }
}
function queueOperationDiscardedV12181_(row) {
  if (!row || !row.operationId) return false;
  const info=queueDiscardInfoV12181_(row.operationId);
  if (!info) return false;
  return !info.userId || String(info.userId)===String(row.userId||'');
}
function discardPendingClientOperationsServer(payload) {
  payload=payload||{};
  const operationId=String(payload.operationId||('discard_'+Utilities.getUuid()));
  let auth;
  try{auth=requireSessionV12_(payload,true);}catch(error){return errorResponse_('SESSION_INVALID','Sua sessão expirou. Entre novamente.',getDatabaseVersion_(),operationId);}
  const ids=(Array.isArray(payload.operationIds)?payload.operationIds:[]).map(function(id){return String(id||'');}).filter(Boolean).slice(0,300);
  if(!ids.length)return successResponse_({operationId:operationId,databaseVersion:getDatabaseVersion_(),data:{registered:0,alreadyFinal:0,processing:0,notFound:0}});
  const wanted={};ids.forEach(function(id){wanted[id]=true;});
  const spreadsheet=getSpreadsheet_(), sheet=ensureServerQueueV125_(spreadsheet);
  const found={}, finalStates={COMPLETED:true,CONFLICT:true,REJECTED:true,EFFECTS_PENDING:true};
  if(sheet.getLastRow()>=2){
    const values=sheet.getRange(2,2,sheet.getLastRow()-1,9).getValues(); // operationId..nextAttemptAt
    values.forEach(function(row){
      const id=String(row[0]||''); if(!wanted[id])return;
      found[id]={userId:String(row[1]||''),status:String(row[6]||'').toUpperCase()};
    });
  }
  const props={}, now=new Date().toISOString(); let registered=0,alreadyFinal=0,processing=0,notFound=0,forbidden=0;
  ids.forEach(function(id){
    const row=found[id];
    if(row && row.userId && row.userId!==auth.user.id && String(auth.user.perfil||'')!=='admin'){forbidden+=1;return;}
    if(!row)notFound+=1;
    else if(finalStates[row.status])alreadyFinal+=1;
    else if(row.status==='PROCESSING')processing+=1;
    props[queueDiscardPropertyKeyV12181_(id)]=JSON.stringify({userId:row&&row.userId||auth.user.id,requestedBy:auth.user.id,discardedAt:now,reason:'DEVICE_QUEUE_RESET'});
    registered+=1;
  });
  if(Object.keys(props).length)PropertiesService.getScriptProperties().setProperties(props,false);
  taskDiagnosticV128_({level:'WARN',origin:'server',module:'queue',step:'CLIENT_QUEUE_DISCARD_REGISTERED',operationId:operationId,userId:auth.user.id,action:'discard',status:'confirmed',context:{requested:ids.length,registered:registered,alreadyFinal:alreadyFinal,processing:processing,notFound:notFound,forbidden:forbidden}});
  return successResponse_({operationId:operationId,databaseVersion:getDatabaseVersion_(),data:{requested:ids.length,registered:registered,alreadyFinal:alreadyFinal,processing:processing,notFound:notFound,forbidden:forbidden}});
}
function discardedQueueResultV12181_(row) {
  return errorResponse_('USER_DISCARDED_PENDING_OPERATION','A operação pendente foi descartada pelo usuário neste dispositivo.',getDatabaseVersion_(),String(row&&row.operationId||''));
}

function queueDependencyStateV1217_(spreadsheet, row) {
  const dependencyId = String(row && (row.dependsOnOperationId || (row.payload && row.payload.dependsOnOperationId)) || '');
  if (!dependencyId || dependencyId === String(row && row.operationId || '')) return { ready:true, dependencyId:'' };
  let dependency = getCachedServerQueueStateV1210_(dependencyId);
  if (!dependency) dependency = getServerQueueRowV125_(spreadsheet, dependencyId);
  if (!dependency) return { ready:false, waiting:true, dependencyId:dependencyId, status:'missing' };
  const status = String(dependency.status || '').toUpperCase();
  if (status === 'COMPLETED' || status === 'EFFECTS_PENDING') return { ready:true, dependencyId:dependencyId, status:status };
  if (status === 'CONFLICT' || status === 'REJECTED') return { ready:false, failed:true, dependencyId:dependencyId, status:status, error:String(dependency.error || '') };
  return { ready:false, waiting:true, dependencyId:dependencyId, status:status || 'RECEIVED' };
}

const V12184_ORPHAN_DEP_MIN_AGE_MS = 5 * 60 * 1000;
const V12184_ORPHAN_REPAIR_PROP = 'SGO_V12184_LAST_ORPHAN_REPAIR';

/** v12.18.4 — reconcilia dependências que realmente não existem mais na fila quente.
 * - tarefa já terminal: a operação dependente vira sucesso semântico;
 * - tarefa existente (ou CREATE): remove apenas a dependência órfã e deixa a regra
 *   normal de versão/idempotência decidir o resultado;
 * - tarefa inexistente + ação não CREATE: rejeita para impedir ressurreição.
 * O reparo é limitado por lote e nunca espera lock indefinidamente. */
function repairOrphanQueueDependenciesV12184_(options) {
  options=options||{};
  const spreadsheet=getSpreadsheet_(), sheet=ensureServerQueueV125_(spreadsheet);
  if(sheet.getLastRow()<2)return {success:true,scanned:0,candidates:0,released:0,terminalNoops:0,rejected:0,busy:0};
  const rows=sheet.getRange(2,1,sheet.getLastRow()-1,V125_SERVER_QUEUE_HEADERS.length).getValues();
  const statusById={}; rows.forEach(function(row){statusById[String(row[1]||'')]=String(row[7]||'').toUpperCase();});
  const nowMs=Date.now(), minAge=Math.max(60000,Number(options.minAgeMs||V12184_ORPHAN_DEP_MIN_AGE_MS));
  const candidates=[];
  rows.forEach(function(values,index){
    if(String(values[7]||'').toUpperCase()!=='RECEIVED')return;
    let payload=null;try{payload=JSON.parse(String(values[6]||'null'));}catch(e){return;}
    const dep=String(payload&&payload.dependsOnOperationId||''); if(!dep||statusById[dep])return;
    const at=new Date(values[10]||values[11]||0).getTime(); const age=Number.isFinite(at)?Math.max(0,nowMs-at):0;
    if(age<minAge)return;
    candidates.push({row:index+2,operationId:String(values[1]||''),userId:String(values[2]||''),action:String(values[4]||''),taskId:String(values[5]||''),payload:payload,dependencyId:dep,ageMs:age});
  });
  const limit=Math.max(1,Math.min(20,Number(options.limit||8))), selected=candidates.slice(0,limit);
  if(!selected.length)return {success:true,scanned:rows.length,candidates:0,released:0,terminalNoops:0,rejected:0,busy:0};
  // Um único snapshot de tarefas evita TextFinder dentro do lock.
  const taskMap={}; readCollectionRecords_(spreadsheet,'tasks',false).forEach(function(task){if(task&&task.id)taskMap[String(task.id)]=task;});
  const lock=tryWriteLockV12_(Math.max(300,Math.min(1200,Number(options.lockMs||700))));
  if(!lock)return {success:true,scanned:rows.length,candidates:candidates.length,released:0,terminalNoops:0,rejected:0,busy:1};
  let released=0,terminalNoops=0,rejected=0;
  try{
    selected.forEach(function(candidate){
      const current=sheet.getRange(candidate.row,1,1,V125_SERVER_QUEUE_HEADERS.length).getValues()[0];
      if(String(current[1]||'')!==candidate.operationId||String(current[7]||'').toUpperCase()!=='RECEIVED')return;
      let payload=null;try{payload=JSON.parse(String(current[6]||'null'));}catch(e){return;}
      const dep=String(payload&&payload.dependsOnOperationId||''); if(!dep||dep!==candidate.dependencyId)return;
      // Rechecagem curta de cache: se a dependência reapareceu por corrida, não mexe.
      if(getCachedServerQueueStateV1210_(dep))return;
      const task=taskMap[candidate.taskId]||null, tracking=task&&task.timeTracking&&typeof task.timeTracking==='object'?task.timeTracking:{};
      const terminal=Boolean(task)&&(['Concluída','Auditada','Cancelada'].indexOf(String(task.status||''))>=0||String(tracking.state||'')==='completed'||Boolean(task.concluidoEm)||Boolean(task._timerAbandonedAt));
      const now=new Date().toISOString();
      if(terminal){
        const version=Number(task._recordVersion||0);
        const result=successResponse_({operationId:candidate.operationId,recordId:candidate.taskId,recordVersion:version,databaseVersion:getDatabaseVersion_(),data:{action:candidate.action,task:task,changedRecords:[{collection:'tasks',id:candidate.taskId,version:version,deleted:false,data:task}],sequence:getChangeSequenceV12_(),sequenceCursorSafe:false,semanticNoop:true,semanticReason:'ORPHAN_DEPENDENCY_TERMINAL_TASK'}});
        current[7]='COMPLETED'; current[9]=''; current[11]=now; current[12]=JSON.stringify(result); current[13]='';
        terminalNoops+=1;
      }else if(task || String(candidate.action||'')==='create'){
        payload.dependsOnOperationId=''; current[6]=JSON.stringify(payload); current[9]=''; current[11]=now; current[13]=''; released+=1;
      }else{
        const result=errorResponse_('DEPENDENCY_ORPHANED_TASK_MISSING','A dependência antiga desapareceu e a tarefa não existe mais no servidor.',getDatabaseVersion_(),candidate.operationId);
        current[7]='REJECTED'; current[9]=''; current[11]=now; current[12]=JSON.stringify(result); current[13]=String(result.message||''); rejected+=1;
      }
      sheet.getRange(candidate.row,1,1,V125_SERVER_QUEUE_HEADERS.length).setValues([current]);
      try{CacheService.getScriptCache().remove(serverQueueCacheKeyV1210_(candidate.operationId));}catch(e){}
      v1210SetCachedRow_('SGO_SERVER_QUEUE_ROW',candidate.operationId,candidate.row);
    });
  }finally{lock.releaseLock();}
  const result={success:true,scanned:rows.length,candidates:candidates.length,processed:selected.length,remaining:Math.max(0,candidates.length-selected.length),released:released,terminalNoops:terminalNoops,rejected:rejected,busy:0};
  try{taskDiagnosticV128_({level:'WARN',origin:'server',module:'queue',step:'ORPHAN_DEPENDENCIES_REPAIRED',operationId:'orphan-repair',userId:'system',action:'repair',status:'confirmed',context:result});}catch(e){}
  return result;
}

function markQueueDependencyFailedV1217_(spreadsheet, row, dependency) {
  if (!row) return;
  row.status = 'REJECTED';
  row.error = 'A operação anterior necessária não pôde ser concluída (' + String(dependency && dependency.status || 'falhou') + ').';
  row.nextAttemptAt = '';
  row.result = errorResponse_('DEPENDENCY_FAILED', row.error, getDatabaseVersion_(), row.operationId);
  writeServerQueueRowV125_(spreadsheet, row);
}

function processOneServerQueueOperationV125_(operationId, sessionToken, authenticatedUser, preloadedHintV1217) {
  const processStartedAtV1216 = Date.now();
  const spreadsheet = getSpreadsheet_();
  // Dependências do cronômetro são duráveis no servidor. Operações posteriores
  // podem ser aceitas imediatamente, mas só executam depois do core anterior.
  const preloadedRowV1217 = preloadedHintV1217 || getServerQueueRowV125_(spreadsheet, operationId);
  if (!preloadedRowV1217) return errorResponse_('OPERATION_NOT_FOUND', 'A operação não está na fila do servidor.', getDatabaseVersion_(), operationId);
  const recoveringDeferredEffectsV1217 = String(preloadedRowV1217.status || '').toUpperCase() === 'EFFECTS_PENDING';
  if (queueOperationDiscardedV12181_(preloadedRowV1217) && ['COMPLETED','CONFLICT','REJECTED','EFFECTS_PENDING'].indexOf(String(preloadedRowV1217.status||'').toUpperCase()) < 0) {
    const discardClaimV12181=claimServerQueueOperationV125_(spreadsheet,operationId,preloadedRowV1217);
    if(discardClaimV12181.busy)return serverBusyV12_(operationId);
    // Se outro worker já possui lease ativo, não sobrescrevemos PROCESSING. O
    // marcador de descarte permanece e será reavaliado se a operação voltar à fila.
    if(discardClaimV12181.processing||discardClaimV12181.waiting)return successResponse_({operationId:operationId,databaseVersion:getDatabaseVersion_(),data:{queued:true,status:discardClaimV12181.processing?'processing':'received',discardRequested:true}});
    if(discardClaimV12181.row && !discardClaimV12181.final)return finishServerQueueAttemptV125_(spreadsheet,discardClaimV12181.row,discardedQueueResultV12181_(discardClaimV12181.row));
    return discardClaimV12181.row&&discardClaimV12181.row.result||discardedQueueResultV12181_(preloadedRowV1217);
  }
  const dependencyV1217 = queueDependencyStateV1217_(spreadsheet, preloadedRowV1217);
  if (dependencyV1217.failed) {
    const failedClaimV1217 = claimServerQueueOperationV125_(spreadsheet, operationId, preloadedRowV1217);
    if (failedClaimV1217.busy) return serverBusyV12_(operationId);
    if (failedClaimV1217.row && !failedClaimV1217.final) {
      const dependencyErrorV1217 = errorResponse_('DEPENDENCY_FAILED', 'A operação anterior necessária não pôde ser concluída (' + String(dependencyV1217.status || 'falhou') + ').', getDatabaseVersion_(), operationId);
      return finishServerQueueAttemptV125_(spreadsheet, failedClaimV1217.row, dependencyErrorV1217);
    }
    return failedClaimV1217.row && failedClaimV1217.row.result || errorResponse_('DEPENDENCY_FAILED','A dependência da operação falhou.',getDatabaseVersion_(),operationId);
  }
  if (dependencyV1217.waiting) {
    return successResponse_({operationId:operationId,databaseVersion:getDatabaseVersion_(),data:{queued:true,status:'received',waitingDependency:true,dependsOnOperationId:dependencyV1217.dependencyId}});
  }
  const claimed = claimServerQueueOperationV125_(spreadsheet, operationId, preloadedRowV1217);
  if (claimed.busy) return serverBusyV12_(operationId);
  if (claimed.missing) return errorResponse_('OPERATION_NOT_FOUND', 'A operação não está na fila do servidor.', getDatabaseVersion_(), operationId);
  const row = claimed.row;
  if (row) {
    const claimContextV1216 = taskPerfContextV1216_(claimed.perf || {});
    const createdMsV1216 = row.createdAt ? new Date(row.createdAt).getTime() : 0;
    if (Number.isFinite(createdMsV1216) && createdMsV1216 > 0) claimContextV1216.queueAgeMs = Math.max(0, Date.now() - createdMsV1216);
    taskDiagnosticV128_({level:'INFO',origin:'server',module:'queue',step:'SERVER_QUEUE_CLAIMED',operationId:operationId,userId:row.userId,entityId:row.entityId,action:row.action,status:String(row.status||'').toLowerCase(),attempt:row.attempts,durationMs:Number(claimContextV1216.totalMs||0),context:claimContextV1216});
  }

  // Para chamadas feitas pelo navegador, a autorização já foi validada antes da
  // tentativa de claim. Fazemos a checagem de propriedade aqui para evitar uma
  // segunda leitura da fila antes de processar. O acionador interno não passa
  // authenticatedUser e usa a sessão técnica temporária do proprietário.
  if (authenticatedUser && row.userId !== authenticatedUser.id && String(authenticatedUser.perfil || '') !== 'admin') {
    return errorResponse_('OPERATION_OWNERSHIP', 'A operação pertence a outro usuário.', getDatabaseVersion_(), operationId);
  }

  if (claimed.final) return row.result || errorResponse_('OPERATION_FINALIZED', row.error || 'A operação já foi finalizada.', getDatabaseVersion_(), operationId);
  if (claimed.processing || claimed.waiting) {
    return successResponse_({ operationId:operationId, databaseVersion:getDatabaseVersion_(), data:{ queued:true, status:claimed.processing?'processing':'received' } });
  }
  // Uma limpeza pode ocorrer entre o primeiro snapshot e o claim. Revalida antes
  // de qualquer mutação para impedir que uma tarefa abandonada seja aplicada.
  if (queueOperationDiscardedV12181_(row)) return finishServerQueueAttemptV125_(spreadsheet,row,discardedQueueResultV12181_(row));

  let tempSession = null;
  let token = String(sessionToken || '');
  try {
    if (!token) {
      tempSession = temporarySessionForQueueV125_(spreadsheet, row.userId);
      if (!tempSession) {
        const rejected = errorResponse_('USER_INACTIVE', 'O usuário da operação não está mais ativo.', getDatabaseVersion_(), operationId);
        row.status = 'REJECTED'; row.result = rejected; row.error = rejected.message;
        writeServerQueueRowV125_(spreadsheet, row);
        return rejected;
      }
      token = tempSession.token;
    }
    const executionPayload = cloneObject_(row.payload || {});
    executionPayload.sessionToken = token;
    executionPayload._fromServerQueue = true;
    const mutationAtV1216 = Date.now();
    // EFFECTS_PENDING v12.17 não reabre a tarefa: usa o contexto materializado
    // quando o core foi confirmado. Filas antigas sem esse contexto mantêm o
    // caminho legado de recuperação para compatibilidade.
    let result = null;
    if (recoveringDeferredEffectsV1217 && executionPayload._deferredEffects) result = completeDeferredTaskEffectsV1217_(spreadsheet, row);
    if (!result) result = mutateTaskServer(executionPayload);
    const mutationMsV1216 = Date.now() - mutationAtV1216;
    const finished = finishServerQueueAttemptV125_(spreadsheet, row, result);
    taskDiagnosticV128_({level:result&&result.success?'INFO':'WARN',origin:'server',module:'queue',step:'SERVER_QUEUE_PROCESS_COMPLETE',operationId:operationId,userId:row.userId,entityId:row.entityId,action:row.action,status:result&&result.success?'confirmed':'pending',errorCode:String(result&&result.errorCode||''),attempt:row.attempts,durationMs:Date.now()-processStartedAtV1216,context:{mutationMs:mutationMsV1216,sideEffectsPending:Boolean(result&&result.data&&result.data.sideEffectsPending),queueStatus:String(row.status||'')}});
    return finished;
  } catch (error) {
    const failure = errorResponse_('QUEUE_PROCESSING_FAILURE', safeErrorMessage_(error), getDatabaseVersion_(), operationId);
    finishServerQueueAttemptV125_(spreadsheet, row, failure);
    return failure;
  } finally {
    if (tempSession && tempSession.token) {
      try { logoutSessionServer({ sessionToken:tempSession.token }); } catch (ignored) {}
    }
  }
}

function processTaskOperationQueueServer(payload) {
  payload = payload || {};
  const operationId = String(payload.operationId || '');
  let auth;
  try { auth = requireSessionV12_(payload, true); }
  catch (error) { return errorResponse_('SESSION_INVALID', 'Sua sessão expirou. Entre novamente.', getDatabaseVersion_(), operationId); }
  if (!operationId) return errorResponse_('OPERATION_ID_REQUIRED', 'A operação não possui identificador.', getDatabaseVersion_(), operationId);
  // A própria função de processamento faz uma única leitura/claim da fila e
  // valida a propriedade usando o usuário já autenticado.
  return processOneServerQueueOperationV125_(operationId, payload.sessionToken, auth.user);
}

function maintainServerQueueV1215_(spreadsheet) {
  const props=PropertiesService.getScriptProperties();
  const last=Number(props.getProperty(V1215_QUEUE_MAINTENANCE_PROP)||0);
  if(Date.now()-last<3600000)return {skipped:true};
  const lock=tryWriteLockV12_(3000);
  if(!lock)return {skipped:true,busy:true};
  try{
    // Outra execução pode ter feito a manutenção enquanto aguardávamos o lock.
    const secondLast=Number(props.getProperty(V1215_QUEUE_MAINTENANCE_PROP)||0);
    if(Date.now()-secondLast<3600000)return {skipped:true};
    const sheet=ensureServerQueueV125_(spreadsheet);
    const count=Math.max(0,sheet.getLastRow()-1);
    let archived=0;
    if(count>1200){
      const rows=sheet.getRange(2,1,count,V125_SERVER_QUEUE_HEADERS.length).getValues();
      const nowArchiveV12184=Date.now(), keep=[], archive=[];
      rows.forEach(function(row){
        const status=String(row[7]||'').toUpperCase();
        const at=new Date(row[11]||row[10]||0).getTime();
        const age=Number.isFinite(at)?Math.max(0,nowArchiveV12184-at):0;
        // COMPLETED é puramente histórico após alguns dias; conflitos/rejeições ficam
        // mais tempo para suporte. EFFECTS_PENDING nunca é arquivado antes de terminar.
        const archiveCompleted=status==='COMPLETED' && age>3*86400000;
        const archiveReview=['CONFLICT','REJECTED'].indexOf(status)>=0 && age>14*86400000;
        if(archiveCompleted||archiveReview)archive.push(row); else keep.push(row);
      });
      if(archive.length){
        const archiveSheet=getOrCreateSheet_(spreadsheet,V1215_SERVER_QUEUE_ARCHIVE_SHEET);
        initializeHeaders_(archiveSheet,V125_SERVER_QUEUE_HEADERS.concat(['ARQUIVADO_EM']));
        const archivedAt=new Date().toISOString();
        const batch=archive.map(function(row){return row.concat([archivedAt]);});
        archiveSheet.getRange(archiveSheet.getLastRow()+1,1,batch.length,V125_SERVER_QUEUE_HEADERS.length+1).setValues(batch);
        sheet.getRange(2,1,count,V125_SERVER_QUEUE_HEADERS.length).clearContent();
        if(keep.length)sheet.getRange(2,1,keep.length,V125_SERVER_QUEUE_HEADERS.length).setValues(keep);
        archived=archive.length;
      }
    }
    let changelog={};let operations={};let sessions={};let timerSlots={};let hotMeta={};let orphanDependencies={};
    try{if(typeof flushHotMetaV1217_==='function')hotMeta=flushHotMetaV1217_();}catch(e){}
    try{if(typeof maintainChangeLogV1215_==='function')changelog=maintainChangeLogV1215_(spreadsheet);}catch(e){}
    try{if(typeof maintainOperationHistoryV1215_==='function')operations=maintainOperationHistoryV1215_(spreadsheet);}catch(e){}
    try{if(typeof maintainSecurityRuntimeV1215_==='function')sessions=maintainSecurityRuntimeV1215_();}catch(e){}
    // Reconciliação pesada do índice de cronômetros ocorre somente na manutenção,
    // nunca no caminho quente de iniciar/pausar uma tarefa após a migração.
    try{if(typeof repairTimerSlotsV1215_==='function')timerSlots=repairTimerSlotsV1215_();}catch(e){}
    // O reparo órfão usa seu próprio lock curto; executa após liberar esta manutenção.
    props.setProperty(V1215_QUEUE_MAINTENANCE_PROP,String(Date.now()));
    return {archived:archived,hotMeta:hotMeta,changelog:changelog,operations:operations,sessions:sessions,timerSlots:timerSlots,orphanDependencies:orphanDependencies};
  }finally{lock.releaseLock();}
}

/** Acionador de contingência. Processa operações recebidas mesmo se o navegador for fechado. */
function processPendingTaskOperationsV1215_() {
  const spreadsheet = getSpreadsheet_();
  const sheet = ensureServerQueueV125_(spreadsheet);
  if (sheet.getLastRow() < 2) {
    // Manutenção é baixa prioridade: só disputa lock quando não há operação interativa.
    try { maintainServerQueueV1215_(spreadsheet); } catch (ignoredMaintenanceEmpty) {}
    return { processed:0 };
  }
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, V125_SERVER_QUEUE_HEADERS.length).getValues();
  const statusByOperation={};
  rows.forEach(function(values){statusByOperation[String(values[1]||'')]=String(values[7]||'').toUpperCase();});
  const timeReadyRows = rows.map(function (values,index) {
    const parsed=serverQueueRowFromValuesV1217_(values,index+2);
    return { operationId:String(values[1] || ''), status:String(values[7] || '').toUpperCase(), nextAttemptAt:valueToIso_(values[9]), updatedAt:valueToIso_(values[11]), rowData:parsed };
  }).filter(function (row) {
    if (row.status === 'RECEIVED' || row.status === 'EFFECTS_PENDING') {
      const nextAt = row.nextAttemptAt ? new Date(row.nextAttemptAt).getTime() : 0;
      return !Number.isFinite(nextAt) || nextAt <= Date.now();
    }
    if (row.status === 'PROCESSING') {
      const leaseUntil = row.nextAttemptAt ? new Date(row.nextAttemptAt).getTime() : 0;
      return !Number.isFinite(leaseUntil) || leaseUntil <= Date.now();
    }
    return false;
  });
  // v12.18.1: uma operação RECEIVED cuja dependência ainda está ativa não ocupa
  // mais uma das dez vagas do worker. O scan já possui todos os status em memória,
  // portanto pula a cadeia bloqueada sem TextFinder e continua procurando trabalho executável.
  const blockedDependencies=[];
  const executableRows=timeReadyRows.filter(function(row){
    if(row.status==='EFFECTS_PENDING')return true;
    const dep=String(row.rowData&&row.rowData.dependsOnOperationId||'');
    if(!dep)return true;
    const depStatus=String(statusByOperation[dep]||'').toUpperCase();
    if(['COMPLETED','EFFECTS_PENDING','CONFLICT','REJECTED'].indexOf(depStatus)>=0)return true;
    blockedDependencies.push({operationId:row.operationId,dependsOnOperationId:dep,dependencyStatus:depStatus||'MISSING'});
    return false;
  });
  // Efeitos continuam atrás de qualquer core executável, mas dependências bloqueadas
  // não impedem tarefas independentes de avançar.
  const interactive = executableRows.filter(function(row){ return row.status !== 'EFFECTS_PENDING'; });
  const effectsOnly = executableRows.filter(function(row){ return row.status === 'EFFECTS_PENDING'; });
  const candidates = (interactive.length ? interactive : effectsOnly).slice(0, 10);
  if(blockedDependencies.length){
    try{taskDiagnosticV128_({level:'INFO',origin:'server',module:'queue',step:'SERVER_QUEUE_BLOCKED_DEPENDENCIES_SKIPPED',operationId:'worker-scan',userId:'system',action:'scan',status:'skipped',context:{blocked:blockedDependencies.length,ready:executableRows.length,sample:blockedDependencies.slice(0,8)}});}catch(ignoredBlockedDiag){}
  }

  // Nunca executa compactação/retenção antes de operações pendentes. Essa mudança
  // evita que um gatilho de manutenção ocupe o ScriptLock no exato momento em que
  // um usuário tenta aceitar/gravar uma tarefa.
  if (!candidates.length) {
    try {
      const propsV12184=PropertiesService.getScriptProperties(), lastRepairV12184=Number(propsV12184.getProperty(V12184_ORPHAN_REPAIR_PROP)||0);
      if(Date.now()-lastRepairV12184>5*60*1000){
        const orphanRepairV12184=repairOrphanQueueDependenciesV12184_({limit:8,lockMs:500});
        if(!orphanRepairV12184.busy)propsV12184.setProperty(V12184_ORPHAN_REPAIR_PROP,String(Date.now()));
      }
    } catch (ignoredOrphanRepairV12184) {}
    try { maintainServerQueueV1215_(spreadsheet); } catch (ignoredMaintenanceIdle) {}
  } else {
    candidates.forEach(function (candidate) {
      try { processOneServerQueueOperationV125_(candidate.operationId, '', null, candidate.rowData); } catch (ignored) {}
    });
  }
  try { if (typeof flushDiagnosticsV128_ === 'function') flushDiagnosticsV128_(); } catch (ignored) {}
  return { processed:candidates.length, blockedDependencies:blockedDependencies.length, executable:executableRows.length, maintenanceDeferred:Boolean(candidates.length) };
}


/** Handler público do worker de contingência, aceitando apenas o gatilho instalado ou execução administrativa. */
function processPendingTaskOperationsV125(event) {
  if (!(typeof trustedTriggerInvocationV1215_ === 'function' && trustedTriggerInvocationV1215_('processPendingTaskOperationsV125', event))) {
    requireAdminOrEditorV12_(event || {});
  }
  return processPendingTaskOperationsV1215_();
}
