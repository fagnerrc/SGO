function createAutomaticNotifications_(spreadsheet, state, changes, userId, operationId, changedRecords) {
  const now = new Date().toISOString();
  const created = [];
  const users = Array.isArray(state.collaborators) ? state.collaborators : [];

  changes.forEach(function (change) {
    const collection = String(change.collection || '');
    const data = change.data || {};
    if (Boolean(change.deleted)) return;

    if (collection === 'tasks') {
      const previous = getRecordMeta_(spreadsheet, 'tasks', String(change.id || ''));
      const recipients = [];
      if (data.responsavelId && data.responsavelId !== userId) recipients.push(String(data.responsavelId));
      (Array.isArray(data.participantes) ? data.participantes : []).forEach(function (participantId) {
        if (participantId && participantId !== userId && recipients.indexOf(String(participantId)) < 0) recipients.push(String(participantId));
      });
      recipients.forEach(function (recipientId) {
        created.push(buildNotification_(recipientId, Number(change.expectedVersion || 0) === 0 ? 'TASK_ASSIGNED' : 'TASK_UPDATED', data.id, Number(change.expectedVersion || 0) === 0 ? 'Nova tarefa recebida' : 'Tarefa atualizada', data.titulo || '', now, change.id));
      });
    }

    if (collection === 'feedbacks') {
      const recipientId = String(data.destinatarioId || data.destinatario || '');
      if (recipientId && recipientId !== userId) {
        created.push(buildNotification_(recipientId, 'FEEDBACK_RECEIVED', data.taskId || data.id, 'Novo feedback', String(data.texto || '').slice(0, 180), now, change.id));
      }
    }

    if (collection === 'messages') {
      const recipients = Array.isArray(data.recipientIds) ? data.recipientIds : [];
      recipients.forEach(function (recipientId) {
        recipientId = String(recipientId || '');
        if (recipientId && recipientId !== userId) {
          created.push(buildNotification_(recipientId, data.taskId ? 'TASK_MESSAGE' : 'MESSAGE_RECEIVED', data.taskId || data.conversationId || data.id, data.taskId ? 'Nova mensagem na tarefa' : 'Nova mensagem', String(data.texto || '').slice(0, 180), now, change.id));
        }
      });
      const mentionIds = extractMentionedUserIds_(String(data.texto || ''), users);
      mentionIds.forEach(function (recipientId) {
        if (recipientId !== userId && !created.some(function (item) { return item.userId === recipientId && item.referenceId === (data.taskId || data.conversationId || data.id); })) {
          created.push(buildNotification_(recipientId, 'MENTION', data.taskId || data.conversationId || data.id, 'Você foi mencionado', String(data.texto || '').slice(0, 180), now, change.id + ':mention'));
        }
      });
    }
  });

  created.forEach(function (notification) {
    const existingDuplicate = readCollectionRecords_(spreadsheet, 'notifications', false).some(function (item) {
      return item && item.userId === notification.userId && item.type === notification.type && item.referenceId === notification.referenceId && item.eventKey === notification.eventKey;
    });
    if (existingDuplicate) return;
    upsertRecord_(spreadsheet, 'notifications', notification.id, 1, false, now, 'system', operationId, notification);
    if (!Array.isArray(state.notifications)) state.notifications = [];
    state.notifications.push(notification);
  });
  return created;
}

function buildNotification_(userId, type, referenceId, title, description, now, sourceId) {
  const eventKey = [type, referenceId, sourceId || String(now)].join(':');
  return {
    id: Utilities.getUuid(),
    _collection: 'notifications',
    _recordVersion: 1,
    userId: String(userId || ''),
    type: String(type || 'INFO'),
    referenceId: String(referenceId || ''),
    title: String(title || 'Notificação'),
    description: String(description || ''),
    createdAt: now,
    read: false,
    readAt: '',
    action: referenceId ? 'open:' + referenceId : '',
    eventKey: eventKey,
    _serverUpdatedAt: now,
    _updatedBy: 'system'
  };
}

function extractMentionedUserIds_(text, users) {
  const normalized = String(text || '').toLocaleLowerCase('pt-BR');
  return (Array.isArray(users) ? users : []).filter(function (user) {
    const firstName = String(user.nome || '').trim().split(/\s+/)[0].toLocaleLowerCase('pt-BR');
    return firstName && normalized.indexOf('@' + firstName) >= 0;
  }).map(function (user) { return String(user.id); });
}

function heartbeatServer(payload) {
  payload = payload || {};
  let auth;
  try { auth = requireSessionV12_(payload, true); }
  catch (error) { return errorResponse_('SESSION_INVALID', 'Sua sessão expirou.', getDatabaseVersion_(), Utilities.getUuid()); }
  const data = {
    userId: String(auth.user.id),
    page: String(payload.page || ''),
    activeTaskId: String(payload.activeTaskId || ''),
    syncStatus: String(payload.syncStatus || ''),
    databaseVersion: Number(payload.databaseVersion || 0),
    lastSeenAt: new Date().toISOString()
  };
  CacheService.getScriptCache().put('SGO_PRESENCE_' + data.userId, JSON.stringify(data), 120);
  return successResponse_({ operationId: Utilities.getUuid(), databaseVersion: getDatabaseVersion_(), data: { lastSeenAt: data.lastSeenAt } });
}

function getPresenceServer(payload) {
  payload = payload || {};
  let auth;
  try { auth = requireSessionV12_(payload, true); }
  catch (error) { return errorResponse_('SESSION_INVALID', 'Sua sessão expirou.', getDatabaseVersion_(), Utilities.getUuid()); }
  if (String(auth.user.perfil || '') !== 'admin') return errorResponse_('PERMISSION_DENIED', 'Somente administradores podem consultar a presença da equipe.', getDatabaseVersion_(), Utilities.getUuid());
  const cache = CacheService.getScriptCache();
  const users = readCollectionRecords_(getSpreadsheet_(), 'collaborators', false).filter(function (user) { return user && user.ativo !== false; });
  const presence = users.map(function (user) {
    const raw = cache.get('SGO_PRESENCE_' + user.id);
    if (!raw) return { userId:user.id, online:false, lastSeenAt:user.ultimoAcesso||'', page:'', activeTaskId:'', syncStatus:'', databaseVersion:0 };
    let item = {}; try { item = JSON.parse(raw); } catch (ignored) {}
    const age = Date.now() - new Date(item.lastSeenAt || 0).getTime();
    return { userId:user.id, online:age>=0&&age<=90000, lastSeenAt:item.lastSeenAt||'', page:item.page||'', activeTaskId:item.activeTaskId||'', syncStatus:item.syncStatus||'', databaseVersion:Number(item.databaseVersion||0) };
  });
  return successResponse_({ operationId:Utilities.getUuid(), databaseVersion:getDatabaseVersion_(), data:{presence:presence} });
}

function reportClientErrorServer(report) {
  report = report || {};
  const operationId = String(report.operationId || Utilities.getUuid());
  const auth = getSessionV12_(report.sessionToken, false);
  const userId = auth ? auth.user.id : 'anonymous';
  if (!auth) {
    const cache = CacheService.getScriptCache();
    const key = 'SGO_ANON_ERROR_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'America/Bahia', 'yyyyMMddHHmm');
    const count = Number(cache.get(key) || 0);
    if (count >= 5) return errorResponse_('RATE_LIMIT', 'Muitos relatórios anônimos foram enviados. Tente novamente mais tarde.', getDatabaseVersion_(), operationId);
    cache.put(key, String(count + 1), 120);
  }
  const now = new Date().toISOString();
  const errorId = String(report.errorId || Utilities.getUuid());
  const safe = {
    id:errorId, _collection:'errors', userId:userId, occurredAt:String(report.occurredAt||now),
    operation:String(report.operation||'').slice(0,200), page:String(report.page||'').slice(0,100), module:String(report.module||'').slice(0,100),
    message:sanitizeTechnicalText_(report.message,1200), errorCode:String(report.errorCode||'CLIENT_ERROR').slice(0,100),
    details:sanitizeTechnicalText_(report.details,4000), syncStatus:String(report.syncStatus||'').slice(0,100), appVersion:String(report.appVersion||(typeof SGO_APP_VERSION_V1215 !== 'undefined' ? SGO_APP_VERSION_V1215 : '12.16.0')).slice(0,30),
    databaseVersion:Number(report.databaseVersion||0), browser:sanitizeTechnicalText_(report.browser,500), device:sanitizeTechnicalText_(report.device,300),
    attempts:Math.max(1,Number(report.attempts||1)), analysisStatus:'Novo', correction:'', userMessage:sanitizeTechnicalText_(report.userMessage,2000),
    recentActions:Array.isArray(report.recentActions)?report.recentActions.slice(-10).map(function(item){return sanitizeTechnicalText_(item,400);}):[],
    _recordVersion:1, _serverUpdatedAt:now, _updatedBy:userId, _lastOperationId:operationId
  };
  const lock = tryWriteLockV12_(1500);
  if (!lock) return serverBusyV12_(operationId);
  try {
    const spreadsheet=getSpreadsheet_();
    upsertRecord_(spreadsheet,'errors',errorId,1,false,now,userId,operationId,safe);
    appendChangeOnceV12_(spreadsheet,'errors',errorId,1,false,now,userId,operationId,safe,{roles:['admin','diretoria','auditoria']});
    return successResponse_({operationId:operationId,recordId:errorId,recordVersion:1,databaseVersion:getDatabaseVersion_(),data:{errorId:errorId}});
  } finally { lock.releaseLock(); }
}

function registerServerErrorV10_(code, error, userId, moduleName, operationId) {
  try {
    const spreadsheet = getSpreadsheet_();
    initializeHeaders_(getOrCreateSheet_(spreadsheet, V10_COLLECTIONS.errors), V10_RECORD_HEADERS);
    const now = new Date().toISOString();
    const id = Utilities.getUuid();
    const data = {
      id: id,
      _collection: 'errors',
      userId: String(userId || ''),
      occurredAt: now,
      operation: String(operationId || ''),
      page: 'server',
      module: String(moduleName || 'server'),
      message: safeErrorMessage_(error),
      errorCode: String(code || 'SERVER_ERROR'),
      details: '',
      syncStatus: 'Erro de sincronização',
      appVersion: (typeof SGO_APP_VERSION_V1215 !== 'undefined' ? SGO_APP_VERSION_V1215 : '12.16.0'),
      databaseVersion: getDatabaseVersion_(),
      browser: '',
      device: 'Google Apps Script',
      attempts: 1,
      analysisStatus: 'Novo',
      correction: '',
      userMessage: '',
      recentActions: [],
      _recordVersion: 1,
      _serverUpdatedAt: now,
      _updatedBy: 'server',
      _lastOperationId: String(operationId || '')
    };
    upsertRecord_(spreadsheet, 'errors', id, 1, false, now, 'server', String(operationId || ''), data);
  } catch (ignored) {
    console.error('Não foi possível registrar o erro do servidor.', ignored);
  }
}

function sanitizeTechnicalText_(value, limit) {
  return String(value || '')
    .replace(/(token|senha|password|pin|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[PROTEGIDO]')
    .slice(0, Number(limit || 1000));
}

/** Instala o gatilho horário das notificações de prazo. Execute uma vez como administrador. */
function installV10Triggers(payload) {
  requireAdminOrEditorV12_(payload || {});
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (['generateDeadlineNotificationsV10','processPendingTaskOperationsV125','generateDailyTasksV1214'].indexOf(trigger.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('generateDeadlineNotificationsV10').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('processPendingTaskOperationsV125').timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger('generateDailyTasksV1214').timeBased().everyHours(1).create();
  if (typeof dailyAutomationStatusV1214_ === 'function') {
    const dailyStatus = dailyAutomationStatusV1214_();
    if (!dailyStatus || dailyStatus.guaranteed !== true) throw new Error('O gatilho das tarefas diárias não pôde ser confirmado após a instalação.');
  }
  return { success: true, confirmed: true, message: 'Gatilhos de prazos, fila transacional e tarefas diárias instalados e confirmados.', serverTimestamp: new Date().toISOString() };
}

function deadlineNotificationIdV1215_(eventKey) {
  const raw = String(eventKey || 'deadline');
  try { if (typeof deterministicIdV12_ === 'function') return deterministicIdV12_('notif', raw, 'deadline'); } catch (ignored) {}
  try { if (typeof sha256V12_ === 'function') return 'notif_' + sha256V12_(raw).slice(0, 28); } catch (ignored2) {}
  return 'notif_' + raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
}

function generateDeadlineNotificationsV1215_() {
  // O gatilho de prazos também funciona como fallback da recorrência diária.
  try { if (typeof generateDailyTasksV1215_ === 'function') generateDailyTasksV1215_(); else if (typeof generateDailyTasksV1214 === 'function') generateDailyTasksV1214({}); }
  catch (dailyError) { registerServerErrorV10_('DAILY_TASK_FALLBACK_FAILURE', dailyError, 'system', 'daily-tasks', 'deadline-trigger'); }

  // Toda leitura/análise pesada acontece FORA do ScriptLock. A seção crítica
  // apenas revalida os IDs determinísticos e persiste notificações novas.
  const spreadsheet = getSpreadsheet_();
  const tasks = readCollectionRecords_(spreadsheet, 'tasks', false);
  const processes = readCollectionRecords_(spreadsheet, 'processes', false);
  const existing = readCollectionRecords_(spreadsheet, 'notifications', false);
  const existingKeys = {};
  existing.forEach(function(item){ if (item && item.eventKey) existingKeys[String(item.eventKey)] = true; });
  const processMap = {};
  processes.forEach(function(process){ if (process && process.id) processMap[String(process.id)] = process; });

  const now = new Date();
  const nowIso = now.toISOString();
  const todayKey = Utilities.formatDate(now, Session.getScriptTimeZone() || 'America/Bahia', 'yyyy-MM-dd');
  const done = ['Concluída','Auditada','Cancelada'];
  const candidates = [];
  const candidateKeys = {};

  function addCandidate(userId, type, task, title) {
    const key = [type, task.id, todayKey].join(':');
    if (!userId || existingKeys[key] || candidateKeys[key]) return;
    const notification = buildNotification_(userId, type, task.id, title, (task.code || '') + ' · ' + (task.titulo || ''), nowIso, task.id + ':' + todayKey);
    notification.eventKey = key;
    notification.id = deadlineNotificationIdV1215_(key);
    candidateKeys[key] = true;
    candidates.push(notification);
  }

  tasks.forEach(function(task) {
    if (!task || task.excluido || done.indexOf(task.status) >= 0 || !task.prazo || !task.responsavelId) return;
    const due = new Date(task.prazo);
    if (Number.isNaN(due.getTime())) return;
    const hours = (due.getTime() - now.getTime()) / 3600000;
    if (hours < 0) addCandidate(task.responsavelId, 'TASK_OVERDUE', task, 'Tarefa atrasada');
    else if (hours <= 24) addCandidate(task.responsavelId, 'TASK_DUE_SOON', task, 'Tarefa próxima do prazo');

    if (task.status === 'Aguardando aprovação') {
      const process = processMap[String(task.processoId || '')] || null;
      const approver = String(task.aprovadorId || (process && process.aprovadorId) || '');
      if (approver) addCandidate(approver, 'APPROVAL_PENDING', task, 'Aprovação pendente');
    }
  });

  if (!candidates.length) return successResponse_({operationId:Utilities.getUuid(), databaseVersion:getDatabaseVersion_(), data:{created:0}});

  const operationId = Utilities.getUuid();
  const lock = tryWriteLockV12_(1800);
  if (!lock) return serverBusyV12_(operationId);
  try {
    const created = [];
    candidates.forEach(function(notification) {
      // ID determinístico fecha a corrida entre dois gatilhos simultâneos.
      const current = getRecordMeta_(spreadsheet, 'notifications', notification.id);
      if (current && !current.deleted) return;
      notification._recordVersion = 1;
      notification._collection = 'notifications';
      notification._serverUpdatedAt = nowIso;
      notification._updatedBy = 'system';
      notification._lastOperationId = operationId;
      upsertRecord_(spreadsheet, 'notifications', notification.id, 1, false, nowIso, 'system', operationId, notification);
      appendChangeOnceV12_(spreadsheet, 'notifications', notification.id, 1, false, nowIso, 'system', operationId, notification);
      created.push(notification);
    });
    if (!created.length) return successResponse_({operationId:operationId, databaseVersion:getDatabaseVersion_(), data:{created:0, sequence:getChangeSequenceV12_()}});
    const version = getDatabaseVersion_() + 1;
    setMetaValue_('DATABASE_VERSION', String(version));
    setMetaValue_('LAST_WRITE_MODULE', 'notifications:deadline');
    SpreadsheetApp.flush();
    return successResponse_({operationId:operationId, databaseVersion:version, data:{created:created.length, sequence:getChangeSequenceV12_()}});
  } finally { lock.releaseLock(); }
}


/** Handler público do gatilho. Chamadas do Web App sem sessão/admin não executam o worker. */
function generateDeadlineNotificationsV10(event) {
  if (!(typeof trustedTriggerInvocationV1215_ === 'function' && trustedTriggerInvocationV1215_('generateDeadlineNotificationsV10', event))) {
    requireAdminOrEditorV12_(event || {});
  }
  return generateDeadlineNotificationsV1215_();
}
