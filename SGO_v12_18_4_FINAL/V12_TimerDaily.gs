/** SGO v12.18.4 — recorrência diária preservada + identidade canônica de tarefas. */
function v1214TimeZone_() {
  return Session.getScriptTimeZone() || 'America/Bahia';
}

function v1214DateKey_(dateValue) {
  const date = dateValue instanceof Date ? dateValue : new Date(dateValue || new Date());
  return Utilities.formatDate(date, v1214TimeZone_(), 'yyyy-MM-dd');
}

function v1214TimeKeyFromDeadline_(deadline) {
  const raw = String(deadline || '');
  const match = raw.match(/T(\d{2}):(\d{2})/);
  if (match) return match[1] + ':' + match[2];
  const date = new Date(raw);
  if (!Number.isNaN(date.getTime())) return Utilities.formatDate(date, v1214TimeZone_(), 'HH:mm');
  return '17:00';
}

function resolveTaskActionTimeV1214_(payload, serverNow, action) {
  const fallback = String(serverNow || new Date().toISOString());
  const raw = String(payload && payload.clientActionAt || '');
  if (!raw) return fallback;
  const clientMs = new Date(raw).getTime();
  const serverMs = new Date(fallback).getTime();
  if (!Number.isFinite(clientMs) || !Number.isFinite(serverMs)) return fallback;
  // Aceita operações offline de até 14 dias e tolera até 5 minutos de relógio adiantado.
  if (clientMs < serverMs - 14 * 86400000 || clientMs > serverMs + 5 * 60000) return fallback;
  return new Date(clientMs).toISOString();
}


/*
 * Slot único de cronômetro por responsável.
 * A fila local resolve a experiência instantânea no mesmo navegador; este slot
 * fecha a brecha entre abas/computadores diferentes sem fazer varredura global.
 */

const V1215_TIMER_REGISTRY_READY_PROP = 'SGO_TIMER_REGISTRY_READY_V1215';

function timerRegistryReadyV1215_() {
  try { return String(PropertiesService.getScriptProperties().getProperty(V1215_TIMER_REGISTRY_READY_PROP) || '') === 'true'; }
  catch (ignored) { return false; }
}

function timerSlotPropertyKeyV1214_(userId) {
  const raw = String(userId || 'anonymous');
  let suffix = raw.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
  try { if (typeof sha256V12_ === 'function') suffix = sha256V12_(raw).slice(0, 32); } catch (ignored) {}
  return 'SGO_TIMER_SLOT_V1214_' + suffix;
}

function timerTaskIsTrackedV1214_(task) {
  return Boolean(task && (String(task.tipo || '') === 'Tarefa cronometrada' || (task.timeTracking && task.timeTracking.enabled)));
}

function timerTaskIsRunningV1214_(task) {
  return Boolean(timerTaskIsTrackedV1214_(task) && task.timeTracking && String(task.timeTracking.state || '') === 'running' && String(task.timeTracking.activeStartedAt || ''));
}

function findRunningTimerForOwnerV1214_(spreadsheet, ownerId, nextTaskId) {
  ownerId = String(ownerId || '');
  nextTaskId = String(nextTaskId || '');
  if (!ownerId || typeof readCollectionRecords_ !== 'function') return null;
  const tasks = readCollectionRecords_(spreadsheet, 'tasks', false) || [];
  let sameTask = null;
  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index];
    if (!timerTaskIsRunningV1214_(task)) continue;
    if (String(task.responsavelId || '') !== ownerId) continue;
    if (String(task.id || '') !== nextTaskId) return task; // outro cronômetro tem prioridade no bloqueio
    sameTask = task;
  }
  return sameTask;
}

function recoverTimerSlotV1214_(spreadsheet, props, key, ownerId, nextTaskId) {
  const recoveredTask = findRunningTimerForOwnerV1214_(spreadsheet, ownerId, nextTaskId);
  if (!recoveredTask) {
    props.deleteProperty(key);
    return {success:true,key:key,ownerId:ownerId,recoveredLegacySlot:false};
  }
  const recoveredId = String(recoveredTask.id || '');
  if (recoveredId) props.setProperty(key, recoveredId);
  if (recoveredId === String(nextTaskId || '')) {
    return {success:true,key:key,ownerId:ownerId,recoveredLegacySlot:true,activeTaskId:recoveredId};
  }
  return {
    success:false,
    errorCode:'TIMER_ALREADY_ACTIVE',
    message:'Já existe outra tarefa com cronômetro ativo para este responsável. Finalize, pause ou coloque a tarefa anterior em espera antes de iniciar outra.',
    activeTaskId:recoveredId,
    recoveredLegacySlot:true
  };
}

function checkTimerSlotV1214_(spreadsheet, user, currentTask, nextTask, deleted) {
  if (!timerTaskIsTrackedV1214_(currentTask) && !timerTaskIsTrackedV1214_(nextTask)) return {success:true};
  if (deleted || !timerTaskIsRunningV1214_(nextTask)) return {success:true};
  const ownerId = String(nextTask.responsavelId || user && user.id || '');
  if (!ownerId) return {success:true};
  const props = PropertiesService.getScriptProperties();
  const key = timerSlotPropertyKeyV1214_(ownerId);
  const activeTaskId = String(props.getProperty(key) || '');
  const nextTaskId = String(nextTask.id || '');

  // Migração segura: nas versões anteriores o slot ainda não existia. Quando o
  // marcador estiver vazio, fazemos UMA varredura de recuperação e reconstruímos
  // o slot a partir da tarefa realmente running do responsável.
  if (!activeTaskId) {
    // Depois da migração confirmada, o registro de slots é a fonte operacional.
    // A varredura de todas as tarefas fica restrita à migração/manutenção e não
    // ocorre dentro do lock de uma ação normal do usuário.
    if (timerRegistryReadyV1215_()) return {success:true,key:key,ownerId:ownerId};
    return recoverTimerSlotV1214_(spreadsheet, props, key, ownerId, nextTaskId);
  }
  if (activeTaskId === nextTaskId) return {success:true,key:key,ownerId:ownerId};

  // Slot órfão: após a migração validada, basta limpar o marcador inválido.
  // Uma manutenção periódica reconcilia os slots fora do caminho crítico.
  const activeMeta = getRecordMeta_(spreadsheet, 'tasks', activeTaskId);
  const activeTask = activeMeta && !activeMeta.deleted ? activeMeta.data : null;
  if (!timerTaskIsRunningV1214_(activeTask)) {
    props.deleteProperty(key);
    if (timerRegistryReadyV1215_()) return {success:true,key:key,ownerId:ownerId,repairedOrphan:true};
    return recoverTimerSlotV1214_(spreadsheet, props, key, ownerId, nextTaskId);
  }
  return {
    success:false,
    errorCode:'TIMER_ALREADY_ACTIVE',
    message:'Já existe outra tarefa com cronômetro ativo para este responsável. Finalize, pause ou coloque a tarefa anterior em espera antes de iniciar outra.',
    activeTaskId:activeTaskId
  };
}

function commitTimerSlotV1214_(user, currentTask, nextTask, deleted) {
  if (!timerTaskIsTrackedV1214_(currentTask) && !timerTaskIsTrackedV1214_(nextTask)) return true;
  const props = PropertiesService.getScriptProperties();
  const oldOwnerId = String(currentTask && currentTask.responsavelId || user && user.id || '');
  const newOwnerId = String(nextTask && nextTask.responsavelId || user && user.id || '');
  const taskId = String(nextTask && nextTask.id || currentTask && currentTask.id || '');

  if (oldOwnerId && oldOwnerId !== newOwnerId) {
    const oldKey = timerSlotPropertyKeyV1214_(oldOwnerId);
    if (String(props.getProperty(oldKey) || '') === taskId) props.deleteProperty(oldKey);
  }
  if (!newOwnerId) return true;
  const key = timerSlotPropertyKeyV1214_(newOwnerId);
  if (!deleted && timerTaskIsRunningV1214_(nextTask)) props.setProperty(key, taskId);
  else if (String(props.getProperty(key) || '') === taskId) props.deleteProperty(key);
  return true;
}

function buildDailyTaskTemplateV1214_(task) {
  task = task || {};
  return {
    tipo:'Tarefa diária', empresa:String(task.empresa || ''), area:String(task.area || ''), processoId:String(task.processoId || ''),
    titulo:String(task.titulo || ''), descricao:String(task.descricao || ''), cliente:String(task.cliente || ''), solicitante:String(task.solicitante || ''),
    responsavelId:String(task.responsavelId || ''), participantes:Array.isArray(task.participantes) ? cloneObject_(task.participantes) : [],
    estimativa:Math.max(0.25, Number(task.estimativa || 1)), prioridade:String(task.prioridade || 'Normal'), risco:String(task.risco || 'Médio'),
    tags:Array.isArray(task.tags) ? cloneObject_(task.tags) : [],
    checklist:(Array.isArray(task.checklist) ? task.checklist : []).map(function(item){ return { texto:String(item && (item.texto || item.text) || '') }; }).filter(function(item){return item.texto;}),
    approvalStatus:'not_required'
  };
}

function prepareDailyTaskMutationV1214_(user, action, currentTask, task, actionAt) {
  if (!task || typeof task !== 'object') return { success:true };
  const role = String(user && user.perfil || 'colaborador');
  const requestedDaily = String(task.tipo || '') === 'Tarefa diária';
  const currentDaily = Boolean(currentTask && String(currentTask.tipo || '') === 'Tarefa diária');
  const currentRecurrence = currentTask && currentTask.dailyRecurrence && typeof currentTask.dailyRecurrence === 'object'
    ? cloneObject_(currentTask.dailyRecurrence) : null;
  const currentTemplate = Boolean(currentRecurrence && currentRecurrence.isTemplate === true && currentRecurrence.enabled !== false);

  if (!currentTask && requestedDaily && role !== 'admin') {
    return { success:false, errorCode:'DAILY_TASK_ADMIN_ONLY', message:'Somente administradores podem criar tarefas diárias.' };
  }
  if (currentTask && !currentDaily && requestedDaily && role !== 'admin') {
    return { success:false, errorCode:'DAILY_TASK_ADMIN_ONLY', message:'Somente administradores podem ativar recorrência diária.' };
  }
  if (currentTemplate && role !== 'admin') {
    // O responsável pode executar a ocorrência inicial, mas não altera o modelo de recorrência.
    task.tipo = currentTask.tipo;
    task.dailyRecurrence = currentRecurrence;
    return { success:true };
  }

  if (requestedDaily) {
    if (currentRecurrence && currentRecurrence.isTemplate === false) {
      // Ocorrências geradas nunca viram um novo modelo.
      task.dailyRecurrence = currentRecurrence;
      return { success:true };
    }
    const dueRaw = String(task.prazo || '');
    const startDate = currentRecurrence && currentRecurrence.startDate
      ? String(currentRecurrence.startDate)
      : (dueRaw ? dueRaw.slice(0,10) : v1214DateKey_(actionAt));
    task.dailyRecurrence = {
      enabled:true,
      isTemplate:true,
      templateId:String(task.id || currentTask && currentTask.id || ''),
      startDate:startDate,
      occurrenceDate:String(currentRecurrence && currentRecurrence.occurrenceDate || startDate),
      dueTime:v1214TimeKeyFromDeadline_(dueRaw),
      createdBy:String(currentRecurrence && currentRecurrence.createdBy || user && user.id || ''),
      template:buildDailyTaskTemplateV1214_(task)
    };
  } else if (currentTemplate && role === 'admin') {
    task.dailyRecurrence = Object.assign({}, currentRecurrence, { enabled:false });
  }
  return { success:true };
}

function dailyAutomationStatusV1214_() {
  const triggers = ScriptApp.getProjectTriggers() || [];
  const handlers = triggers.map(function(trigger){ return String(trigger.getHandlerFunction() || ''); });
  const dedicated = handlers.indexOf('generateDailyTasksV1214') >= 0;
  const fallback = handlers.indexOf('generateDeadlineNotificationsV10') >= 0;
  return {
    success: dedicated || fallback,
    guaranteed: dedicated || fallback,
    dedicated: dedicated,
    fallback: fallback,
    mode: dedicated ? 'dedicated' : (fallback ? 'deadline-fallback' : 'none')
  };
}

function ensureDailyTaskTriggerV1214_() {
  let status = dailyAutomationStatusV1214_();
  if (status.dedicated) return status;
  let installError = '';
  try {
    ScriptApp.newTrigger('generateDailyTasksV1214').timeBased().everyHours(1).create();
  } catch (error) {
    installError = String(error && error.message || error || 'Falha ao criar o gatilho diário.');
  }
  status = dailyAutomationStatusV1214_();
  if (status.guaranteed) {
    status.installError = installError;
    return status;
  }
  return {
    success:false,
    guaranteed:false,
    dedicated:false,
    fallback:false,
    mode:'none',
    errorCode:'DAILY_AUTOMATION_UNAVAILABLE',
    message:'Não foi possível garantir a geração automática das tarefas diárias. Um administrador deve reinstalar os gatilhos do SGO antes de ativar esta recorrência.',
    installError:installError
  };
}

function buildDailyOccurrenceV1214_(templateTask, dateKey, nowIso) {
  const recurrence = templateTask.dailyRecurrence || {};
  // Usa o modelo ATUAL, não um snapshot histórico: alterações administrativas
  // válidas passam a valer nas ocorrências seguintes.
  const snapshot = buildDailyTaskTemplateV1214_(templateTask);
  const occurrenceId = deterministicIdV12_('daily', String(templateTask.id || ''), String(dateKey || ''));
  const shortHash = sha256V12_(String(templateTask.id || '') + '|' + String(dateKey || '')).slice(0,4).toUpperCase();
  const dueTime = String(recurrence.dueTime || '17:00');
  return {
    id:occurrenceId,
    code:'DIA-' + String(dateKey || '').replace(/-/g,'').slice(2) + '-' + shortHash,
    tipo:'Tarefa diária', empresa:String(snapshot.empresa || templateTask.empresa || ''), area:String(snapshot.area || templateTask.area || ''),
    processoId:String(snapshot.processoId || ''), titulo:String(snapshot.titulo || templateTask.titulo || 'Tarefa diária'),
    descricao:String(snapshot.descricao || ''), cliente:String(snapshot.cliente || ''), solicitante:String(snapshot.solicitante || 'Rotina diária'),
    responsavelId:String(snapshot.responsavelId || templateTask.responsavelId || ''), participantes:Array.isArray(snapshot.participantes) ? cloneObject_(snapshot.participantes) : [],
    prazo:String(dateKey) + 'T' + dueTime, prazoManual:true, prazoAutomatico:false,
    estimativa:Math.max(0.25,Number(snapshot.estimativa || 1)), prioridade:String(snapshot.prioridade || 'Normal'), risco:String(snapshot.risco || 'Médio'),
    status:'Nova', progresso:0, aguardandoQuem:'', aguardandoDesde:'', motivoEspera:'', evidencia:'', justificativaAtraso:'',
    tags:Array.isArray(snapshot.tags) ? cloneObject_(snapshot.tags) : [], criadoEm:nowIso, atualizadoEm:nowIso, concluidoEm:'',
    approvalStatus:String(templateTask._dailyApprovalStatusV1215 || 'not_required'), approvedBy:'', approvedAt:'', auditado:false, excluido:false,
    historico:[{at:nowIso,userId:'system',action:'Ocorrência diária gerada automaticamente',fromStatus:'',toStatus:'Nova'}],
    checklist:(Array.isArray(snapshot.checklist) ? snapshot.checklist : []).map(function(item,index){return {id:deterministicIdV12_('check',occurrenceId,String(index)),texto:String(item.texto||''),feito:false,feitoEm:'',feitoPor:''};}),
    comentarios:[], links:[], timeTracking:null,
    dailyRecurrence:{enabled:true,isTemplate:false,templateId:String(recurrence.templateId || templateTask.id || ''),occurrenceDate:String(dateKey),dueTime:dueTime}
  };
}

function validateDailyTemplateReferencesV1215_(spreadsheet, templateTask) {
  const responsibleId = String(templateTask && templateTask.responsavelId || '');
  const responsibleMeta = responsibleId ? getRecordMeta_(spreadsheet, 'collaborators', responsibleId) : null;
  if (!responsibleMeta || responsibleMeta.deleted || !responsibleMeta.data || responsibleMeta.data.ativo === false) {
    return {success:false,errorCode:'DAILY_RESPONSIBLE_INACTIVE',message:'O responsável da tarefa diária está inativo ou não existe.'};
  }
  let process = null;
  const processId = String(templateTask && templateTask.processoId || '');
  if (processId) {
    const processMeta = getRecordMeta_(spreadsheet, 'processes', processId);
    process = processMeta && !processMeta.deleted ? processMeta.data : null;
    if (!process || process.ativo === false) return {success:false,errorCode:'DAILY_PROCESS_INACTIVE',message:'O processo da tarefa diária está inativo ou não existe.'};
    if (process.empresa && templateTask.empresa && String(process.empresa) !== String(templateTask.empresa)) return {success:false,errorCode:'DAILY_PROCESS_COMPANY_MISMATCH',message:'O processo da tarefa diária pertence a outra empresa.'};
    if (process.segregacao && [process.conferenteId,process.aprovadorId].filter(Boolean).indexOf(responsibleId) >= 0) return {success:false,errorCode:'DAILY_SEGREGATION_VIOLATION',message:'O responsável conflita com a segregação atual do processo.'};
  }
  const participantIds = [];
  (Array.isArray(templateTask.participantes) ? templateTask.participantes : []).forEach(function(id){
    const meta = getRecordMeta_(spreadsheet,'collaborators',String(id||''));
    if (meta && !meta.deleted && meta.data && meta.data.ativo !== false) participantIds.push(String(id));
  });
  return {success:true,responsible:responsibleMeta.data,process:process,participantIds:uniqueIdsV12_(participantIds),approvalStatus:process && process.aprovadorId ? 'not_requested' : 'not_required'};
}

function generateDailyTasksV1215_() {
  const now = new Date();
  const nowIso = now.toISOString();
  const today = v1214DateKey_(now);
  const spreadsheet = getSpreadsheet_();
  const tasks = readCollectionRecords_(spreadsheet,'tasks',false);
  const templates = tasks.filter(function(task){
    const recurrence = task && task.dailyRecurrence;
    return task && !task.excluido && String(task.tipo || '') === 'Tarefa diária' && recurrence && recurrence.enabled !== false && recurrence.isTemplate === true;
  });
  let created = 0;
  let retryNeeded = false;

  templates.forEach(function(templateTask){
    const recurrence = templateTask.dailyRecurrence || {};
    const startDate = String(recurrence.startDate || today);
    if (today < startDate) return;
    // A própria tarefa-modelo representa a primeira ocorrência na data de início.
    if (today === String(recurrence.occurrenceDate || startDate)) return;
    const occurrenceId = deterministicIdV12_('daily', String(templateTask.id || ''), today);
    if (getRecordMeta_(spreadsheet,'tasks',occurrenceId)) return;

    const lock = tryWriteLockV12_(1800);
    if (!lock) { retryNeeded = true; return; }
    try {
      if (getRecordMeta_(spreadsheet,'tasks',occurrenceId)) return;
      // Revalida o modelo dentro do lock para não gerar uma ocorrência com dados
      // que foram desativados/alterados enquanto o gatilho estava executando.
      const latestTemplateMeta = getRecordMeta_(spreadsheet,'tasks',String(templateTask.id || ''));
      const latestTemplate = latestTemplateMeta && !latestTemplateMeta.deleted ? latestTemplateMeta.data : null;
      const latestRecurrence = latestTemplate && latestTemplate.dailyRecurrence;
      if (!latestTemplate || latestTemplate.excluido || String(latestTemplate.tipo || '') !== 'Tarefa diária' || !latestRecurrence || latestRecurrence.enabled === false || latestRecurrence.isTemplate !== true) return;
      const references = validateDailyTemplateReferencesV1215_(spreadsheet, latestTemplate);
      if (!references.success) {
        taskDiagnosticV128_({level:'ERROR',origin:'server',module:'daily-tasks',step:'DAILY_TEMPLATE_BLOCKED',operationId:'daily:'+String(latestTemplate.id||'')+':'+today,userId:'system',entityId:String(latestTemplate.id||''),action:'validate',status:'rejected',errorCode:references.errorCode,message:references.message,context:{date:today}});
        return;
      }
      latestTemplate.participantes = references.participantIds;
      latestTemplate._dailyApprovalStatusV1215 = references.approvalStatus;
      const occurrence = buildDailyOccurrenceV1214_(latestTemplate,today,nowIso);
      delete latestTemplate._dailyApprovalStatusV1215;
      const nextDatabaseVersion = getDatabaseVersion_() + 1;
      const sequence = getChangeSequenceV12_() + 1;
      const operationId = 'daily:' + String(latestTemplate.id || '') + ':' + today;
      occurrence._collection='tasks'; occurrence._recordVersion=1; occurrence._updatedBy='system'; occurrence._serverUpdatedAt=nowIso;
      occurrence._lastOperationId=operationId; occurrence._databaseVersionAtWrite=nextDatabaseVersion;
      upsertRecord_(spreadsheet,'tasks',occurrence.id,1,false,nowIso,'system',operationId,occurrence);
      appendChangeWithSequenceV1210_(spreadsheet,sequence,'tasks',occurrence.id,1,false,nowIso,'system',operationId,occurrence);
      setMetaValuesV1210_({
        CHANGE_SEQUENCE:String(sequence), DATABASE_VERSION:String(nextDatabaseVersion), LAST_OPERATION_ID:operationId,
        LAST_WRITE_AT:nowIso, LAST_WRITE_USER:'system', LAST_WRITE_MODULE:'daily-tasks'
      });
      created += 1;
      taskDiagnosticV128_({level:'INFO',origin:'server',module:'daily-tasks',step:'DAILY_OCCURRENCE_CREATED',operationId:operationId,userId:'system',entityId:occurrence.id,action:'create',status:'completed',recordVersion:1,databaseVersion:nextDatabaseVersion,context:{templateId:latestTemplate.id,date:today}});
    } catch(error) {
      retryNeeded = true;
      registerServerErrorV10_('DAILY_TASK_GENERATION_FAILURE',error,'system','daily-tasks','daily:'+String(templateTask.id||'')+':'+today);
    } finally { lock.releaseLock(); }
  });
  return {success:true,confirmed:true,created:created,date:today,retryNeeded:retryNeeded,serverTimestamp:new Date().toISOString()};
}


/** Handler público do gatilho diário protegido contra chamada direta pelo Web App. */
function generateDailyTasksV1214(event) {
  if (!(typeof trustedTriggerInvocationV1215_ === 'function' && trustedTriggerInvocationV1215_('generateDailyTasksV1214', event))) {
    requireAdminOrEditorV12_(event || {});
  }
  return generateDailyTasksV1215_();
}


function rebuildTimerSlotsV1215_(spreadsheet) {
  spreadsheet = spreadsheet || getSpreadsheet_();
  const tasks = readCollectionRecords_(spreadsheet, 'tasks', false) || [];
  const runningByOwner = {};
  tasks.forEach(function(task) {
    if (!timerTaskIsRunningV1214_(task)) return;
    const ownerId = String(task.responsavelId || '');
    if (!ownerId) return;
    (runningByOwner[ownerId] = runningByOwner[ownerId] || []).push(task);
  });

  const props = PropertiesService.getScriptProperties();
  const allProps = props.getProperties ? props.getProperties() : {};
  Object.keys(allProps || {}).forEach(function(key) {
    if (String(key).indexOf('SGO_TIMER_SLOT_V1214_') === 0) props.deleteProperty(key);
  });

  const conflicts = [];
  let rebuiltSlots = 0;
  Object.keys(runningByOwner).forEach(function(ownerId) {
    const list = runningByOwner[ownerId].slice().sort(function(a, b) {
      return new Date(a.timeTracking && a.timeTracking.activeStartedAt || 0).getTime() - new Date(b.timeTracking && b.timeTracking.activeStartedAt || 0).getTime();
    });
    const chosen = list[0];
    props.setProperty(timerSlotPropertyKeyV1214_(ownerId), String(chosen.id || ''));
    rebuiltSlots += 1;
    if (list.length > 1) {
      conflicts.push({
        ownerId: ownerId,
        activeTaskIds: list.map(function(task){ return String(task.id || ''); }),
        protectedTaskId: String(chosen.id || '')
      });
    }
  });
  if (conflicts.length) props.deleteProperty(V1215_TIMER_REGISTRY_READY_PROP);
  else props.setProperty(V1215_TIMER_REGISTRY_READY_PROP, 'true');
  return {rebuiltSlots:rebuiltSlots, conflicts:conflicts, ready:conflicts.length===0};
}

function repairTimerSlotsV1215_() {
  try {
    const result = rebuildTimerSlotsV1215_(getSpreadsheet_());
    try {
      taskDiagnosticV128_({level:result.ready?'INFO':'WARN',origin:'server',module:'timer',step:'TIMER_SLOT_RECONCILIATION',operationId:'timer-slot-maintenance',userId:'system',action:'repair',status:result.ready?'completed':'conflict',context:{rebuiltSlots:result.rebuiltSlots,duplicateOwners:result.conflicts.length}});
    } catch (ignoredDiagnostic) {}
    return result;
  } catch (error) {
    try { registerServerErrorV10_('TIMER_SLOT_REPAIR_FAILURE', error, 'system', 'timer', 'timer-slot-maintenance'); } catch (ignored) {}
    return {ready:false,rebuiltSlots:0,conflicts:[],error:safeErrorMessage_(error)};
  }
}

/**
 * Finalização única da implantação v12.16.0.
 * Execute diretamente no editor Apps Script vinculado à planilha depois de
 * substituir os arquivos. Não altera tarefas; apenas instala/valida gatilhos e
 * reconstrói os slots a partir do estado persistido atual.
 */
function finalizeV1215Deployment() {
  requireAdminOrEditorV12_({});
  const spreadsheet = getSpreadsheet_();
  const triggerResult = installV10Triggers({});
  const automation = dailyAutomationStatusV1214_();
  if (!automation || automation.guaranteed !== true) {
    throw new Error('DAILY_AUTOMATION_UNAVAILABLE: a automação diária não pôde ser confirmada.');
  }

  // Garante que o segredo usado nas novas credenciais já exista antes da
  // publicação e remove sessões/throttles expirados da instalação antiga.
  try { if (typeof credentialPepperV1215_ === 'function') credentialPepperV1215_(); } catch (pepperError) { throw new Error('CREDENTIAL_SECURITY_INIT_FAILED: ' + safeErrorMessage_(pepperError)); }
  let sessionMaintenance = {removed:0};
  try { if (typeof cleanupExpiredSessionsV1215_ === 'function') sessionMaintenance = cleanupExpiredSessionsV1215_(); } catch (ignoredSessionCleanup) {}

  const timerMigration = rebuildTimerSlotsV1215_(spreadsheet);
  const conflicts = timerMigration.conflicts || [];
  const readyForPublish = Boolean(timerMigration.ready && automation.guaranteed === true);

  let maintenance = {};
  try { if (typeof maintainServerQueueV1215_ === 'function') maintenance = maintainServerQueueV1215_(spreadsheet) || {}; } catch (maintenanceError) { maintenance = {warning:safeErrorMessage_(maintenanceError)}; }

  try {
    setMetaValue_('APP_VERSION', typeof SGO_APP_VERSION_V1215 !== 'undefined' ? SGO_APP_VERSION_V1215 : '12.16.0');
    setMetaValue_('V1215_DEPLOYMENT_CHECKED_AT', new Date().toISOString());
    if (readyForPublish) setMetaValue_('V1215_DEPLOYMENT_FINALIZED_AT', new Date().toISOString());
  } catch (ignored) {}

  try {
    taskDiagnosticV128_({
      level: readyForPublish ? 'INFO' : 'WARN', origin:'server', module:'deployment', step:'V1215_FINALIZED',
      operationId:'deploy-v1215', userId:'editor', action:'migration', status:readyForPublish?'completed':'blocked',
      context:{rebuiltSlots:timerMigration.rebuiltSlots,duplicateOwners:conflicts.length,dailyAutomationMode:automation.mode,readyForPublish:readyForPublish}
    });
  } catch (ignoredDiagnostic) {}

  const result = {
    success:true,
    confirmed:true,
    readyForPublish:readyForPublish,
    version:'12.16.0',
    triggers:triggerResult,
    dailyAutomation:automation,
    rebuiltTimerSlots:timerMigration.rebuiltSlots,
    timerConflicts:conflicts,
    sessionMaintenance:sessionMaintenance,
    maintenance:maintenance,
    message: readyForPublish
      ? 'Implantação v12.16.0 validada. Pode publicar a nova versão do Web App.'
      : 'NÃO PUBLIQUE ainda: existem responsáveis com mais de um cronômetro antigo ativo. Pause/finalize os excedentes e execute finalizeV1216Deployment() novamente.'
  };
  try { Logger.log(JSON.stringify(result)); } catch (ignoredLog) {}
  return result;
}


/** Alias explícito da release v12.16.0; mantém finalizeV1215Deployment por compatibilidade. */
function finalizeV1216Deployment() {
  return finalizeV1215Deployment();
}


/** v12.17: repara dependências apenas de operações RECEIVED do cronômetro; nunca altera PROCESSING. */
function repairServerTimerDependenciesV1217_() {
  const spreadsheet=getSpreadsheet_();
  const sheet=ensureServerQueueV125_(spreadsheet);
  if(sheet.getLastRow()<2)return {updated:0,active:0,planned:0,busy:0};
  const rows=sheet.getRange(2,1,sheet.getLastRow()-1,V125_SERVER_QUEUE_HEADERS.length).getValues();
  const statusByOperationV12184={};rows.forEach(function(values){statusByOperationV12184[String(values[1]||'')]=String(values[7]||'').toUpperCase();});
  const lastByOwner={}, planned=[]; let active=0, skippedOrphan=0;
  rows.forEach(function(values,index){
    const status=String(values[7]||'').toUpperCase();
    if(['RECEIVED','PROCESSING','EFFECTS_PENDING'].indexOf(status)<0)return;
    let payload=null; try{payload=JSON.parse(String(values[6]||'null'));}catch(e){return;}
    const task=payload&&payload.task||{};
    const timed=String(task.tipo||'')==='Tarefa cronometrada'||Boolean(task.timeTracking&&task.timeTracking.enabled);
    if(!timed)return;
    active+=1;
    const owner=String(task.responsavelId||values[2]||''), opId=String(values[1]||''), dep=String(payload.dependsOnOperationId||'');
    const createdMs=new Date(values[10]||values[11]||0).getTime(), age=Number.isFinite(createdMs)?Math.max(0,Date.now()-createdMs):0;
    const orphanBlocked=Boolean(dep)&&!statusByOperationV12184[dep]&&age>=5*60*1000;
    // v12.18.4: uma linha já presa a dependência MISSING antiga não vira o
    // predecessor de tarefas novas. Ela será tratada pelo reparo órfão separado.
    if(orphanBlocked){skippedOrphan+=1;return;}
    if(owner && status==='RECEIVED' && lastByOwner[owner] && !dep) planned.push({row:index+2,operationId:opId,dependsOnOperationId:lastByOwner[owner]});
    if(owner) lastByOwner[owner]=opId;
  });
  let updated=0,busy=0;
  planned.forEach(function(candidate){
    const lock=tryWriteLockV12_(1200);
    if(!lock){busy+=1;return;}
    try{
      const current=sheet.getRange(candidate.row,1,1,V125_SERVER_QUEUE_HEADERS.length).getValues()[0];
      if(String(current[1]||'')!==candidate.operationId || String(current[7]||'').toUpperCase()!=='RECEIVED')return;
      let payload=null;try{payload=JSON.parse(String(current[6]||'null'));}catch(e){return;}
      if(!payload || String(payload.dependsOnOperationId||''))return;
      payload.dependsOnOperationId=candidate.dependsOnOperationId;
      sheet.getRange(candidate.row,7).setValue(JSON.stringify(payload));
      sheet.getRange(candidate.row,12).setValue(new Date().toISOString());
      try{CacheService.getScriptCache().remove(serverQueueCacheKeyV1210_(candidate.operationId));}catch(e){}
      updated+=1;
    } finally {lock.releaseLock();}
  });
  return {updated:updated,active:active,planned:planned.length,busy:busy,skippedOrphan:skippedOrphan};
}

function finalizeV12184Deployment() {
  const baseResult = finalizeV1216Deployment();
  let dependencyRepair={updated:0,active:0,planned:0,busy:0}, orphanRepair={success:true,busy:0,candidates:0,released:0,terminalNoops:0,rejected:0}, hotMeta={}, queueHealth={}, taskCodeRepair={success:true,busy:0,updated:0,duplicateGroups:0};
  try{dependencyRepair=repairServerTimerDependenciesV1217_();}catch(error){dependencyRepair={error:safeErrorMessage_(error),busy:0};}
  try{if(typeof repairOrphanQueueDependenciesV12184_==='function')orphanRepair=repairOrphanQueueDependenciesV12184_({limit:20,minAgeMs:5*60*1000,lockMs:900});}catch(orphanError){orphanRepair={success:false,busy:0,error:safeErrorMessage_(orphanError)};}
  try{if(typeof flushHotMetaV1217_==='function')hotMeta=flushHotMetaV1217_();}catch(error2){hotMeta={error:safeErrorMessage_(error2)};}
  try{if(typeof repairDuplicateTaskCodesV12183_==='function')taskCodeRepair=repairDuplicateTaskCodesV12183_();}catch(error3){taskCodeRepair={success:false,busy:0,updated:0,error:safeErrorMessage_(error3)};}
  try{if(typeof diagnoseV12184PersistenceHealth==='function')queueHealth=diagnoseV12184PersistenceHealth({})||{};}catch(error4){queueHealth={warning:safeErrorMessage_(error4)};}
  try{setMetaValue_('APP_VERSION','12.18.4');}catch(ignored){}
  const dependencyRepairOk = !dependencyRepair.error && Number(dependencyRepair.busy||0)===0;
  const orphanRepairOk = orphanRepair && orphanRepair.success !== false && Number(orphanRepair.busy||0)===0 && Number(orphanRepair.remaining||0)===0 && !orphanRepair.error;
  const codeRepairOk = taskCodeRepair && taskCodeRepair.success !== false && Number(taskCodeRepair.busy||0)===0 && !taskCodeRepair.error;
  const readyForPublish = Boolean(baseResult&&baseResult.readyForPublish) && dependencyRepairOk && orphanRepairOk && codeRepairOk && !hotMeta.error;
  return Object.assign({},baseResult,{
    version:'12.18.4',
    dependencyRepair:dependencyRepair,
    orphanDependencyRepair:orphanRepair,
    hotMeta:hotMeta,
    taskCodeRepair:taskCodeRepair,
    queueHealth:queueHealth,
    timerIntegrity:{terminalStateMonotonic:true,staleCommandSuppression:true,terminalOverlaySuppression:true,orphanDependencyRecovery:true,chainIgnoresObsoleteTimers:true},
    queueScheduler:{skipBlockedDependencies:true,dependencyAwarePolling:true,batchRespectsBackoff:true,acceptProcessSingleRpc:true,shortAcceptCriticalSection:true,coordinatedDeviceReset:true,stuckTaskDirectDiscard:true},
    antiDuplication:{semanticIdempotency:true,duplicateCompleteSuppression:true,legacyCreateConflictRecovery:true,serverCanonicalTaskCode:true},
    frozenTimerRecovery:{directServerCancel:true,abandonTombstone:true,staleTimerResurrectionBlocked:true,taskWideTombstone:true},
    taskIdentity:{serverAllocatedCode:true,clientCannotRenameConfirmedCode:true,duplicateCodeRepair:true},
    readyForPublish:readyForPublish,
    message:readyForPublish
      ? 'Implantação v12.18.4 validada. Estado terminal do cronômetro é monotônico, comandos/overlays antigos não ressuscitam tarefas e dependências órfãs são reconciliadas; pode publicar.'
      : (Number(dependencyRepair.busy||0)>0 || Number(orphanRepair.busy||0)>0 || Number(taskCodeRepair.busy||0)>0
          ? 'NÃO PUBLIQUE: o banco estava ocupado durante os reparos. Execute finalizeV12184Deployment() novamente até todos os campos busy ficarem em 0.'
          : (Number(orphanRepair.remaining||0)>0
              ? 'NÃO PUBLIQUE ainda: ainda existem dependências órfãs antigas para reconciliar. Execute finalizeV12184Deployment() novamente até orphanDependencyRepair.remaining=0.'
              : 'NÃO PUBLIQUE: revise dependencyRepair, orphanDependencyRepair, taskCodeRepair e hotMeta no retorno da migração v12.18.4.'))
  });
}
function finalizeV12183Deployment() { return finalizeV12184Deployment(); }
function finalizeV12182Deployment() { return finalizeV12184Deployment(); }
function finalizeV12181Deployment() { return finalizeV12184Deployment(); }
function finalizeV1218Deployment() { return finalizeV12184Deployment(); }

/** Compatibilidade: instalações que ainda chamem o finalizador anterior recebem a validação atual. */
function finalizeV1217Deployment() { return finalizeV12184Deployment(); }
