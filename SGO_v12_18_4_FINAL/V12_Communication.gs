/** SGO v12.10 — chat dedicado, grupos e paginação real. */
const V12_MESSAGE_INDEX_SHEET = 'SGO_MSG_INDEX';
const V12_MESSAGE_INDEX_HEADERS = ['CONVERSA_ID','SEQUENCIA','MENSAGEM_ID','CRIADO_EM'];

function ensureCommunicationSchemaV12_(spreadsheet) {
  initializeHeaders_(getOrCreateSheet_(spreadsheet, V12_MESSAGE_INDEX_SHEET), V12_MESSAGE_INDEX_HEADERS);
}


function migrateLegacyCommunicationV12_(spreadsheet) {
  ensureCommunicationSchemaV12_(spreadsheet);
  const messages = readCollectionRecords_(spreadsheet, 'messages', false);
  const collaborators = readCollectionRecords_(spreadsheet, 'collaborators', false).filter(function (person) { return person && person.ativo !== false; });
  const activeIds = {};
  collaborators.forEach(function (person) { activeIds[person.id] = true; });
  const grouped = {};
  messages.forEach(function (message) {
    if (!message || !message.id || !message.conversationId) return;
    (grouped[message.conversationId] = grouped[message.conversationId] || []).push(message);
  });
  Object.keys(grouped).forEach(function (conversationId) {
    const conversationMessages = grouped[conversationId].sort(function (a, b) { return new Date(a.createdAt || a._serverUpdatedAt || 0) - new Date(b.createdAt || b._serverUpdatedAt || 0); });
    const sample = conversationMessages[conversationMessages.length - 1];
    const operationId = String(sample._lastOperationId || sample.operationId || 'migration-v12:' + conversationId);
    const now = String(sample.createdAt || sample._serverUpdatedAt || new Date().toISOString());
    const conversationMeta = getRecordMeta_(spreadsheet, 'conversations', conversationId);
    if (!conversationMeta || conversationMeta.deleted) {
      const type = String(sample.conversationType || (conversationId.indexOf('area:') === 0 ? 'area' : conversationId.indexOf('task:') === 0 ? 'task' : conversationId.indexOf('direct:') === 0 ? 'direct' : 'group'));
      const participantIds = uniqueIdsV12_(conversationMessages.reduce(function (ids, message) { return ids.concat([message.authorId]).concat(message.recipientIds || []); }, [])).filter(function (id) { return activeIds[id]; });
      const area = String(sample.area || (type === 'area' ? conversationId.slice(5) : ''));
      const conversation = {
        id: String(conversationId), type: type, name: type === 'area' ? 'Grupo · ' + area : '',
        participantIds: participantIds, adminIds: [], area: area, areaKey: normalizeAreaKeyV12_(area),
        taskId: String(sample.taskId || (type === 'task' ? conversationId.slice(5) : '')),
        createdBy: String(conversationMessages[0].authorId || ''), createdAt: String(conversationMessages[0].createdAt || now),
        updatedAt: now, lastMessageId: sample.id, active: true,
        _collection: 'conversations', _recordVersion: 1, _updatedBy: String(sample.authorId || ''), _serverUpdatedAt: now, _lastOperationId: operationId
      };
      upsertRecord_(spreadsheet, 'conversations', conversation.id, 1, false, now, conversation.createdBy, operationId, conversation);
    }
    conversationMessages.forEach(function (message, index) {
      if (!Number(message._messageSequence || 0)) {
        message._messageSequence = index - conversationMessages.length;
        const meta = getRecordMeta_(spreadsheet, 'messages', message.id);
        if (meta) upsertRecord_(spreadsheet, 'messages', message.id, meta.version, false, meta.updatedAt || message.createdAt || now, meta.updatedBy || message.authorId || '', meta.operationId || operationId, message);
      }
      indexMessageV12_(spreadsheet, message);
    });
  });
}

function conversationVisibleForUserV1215_(spreadsheet, user, conversation) {
  if (!conversation || !user) return false;
  const visibleTaskIds = {};
  const taskId = String(conversation.taskId || '');
  if (taskId) {
    const taskMeta = getRecordMeta_(spreadsheet, 'tasks', taskId);
    const task = taskMeta && !taskMeta.deleted ? taskMeta.data : null;
    if (task && userCanSeeTaskV12_(user, task)) visibleTaskIds[taskId] = true;
  }
  return userCanSeeConversationV12_(user, conversation, visibleTaskIds);
}

function currentTaskConversationParticipantsV1215_(spreadsheet, conversation, senderId) {
  const taskId = String(conversation && conversation.taskId || '');
  if (!taskId) return uniqueIdsV12_((conversation && conversation.participantIds || []).concat([senderId]));
  const taskMeta = getRecordMeta_(spreadsheet, 'tasks', taskId);
  const task = taskMeta && !taskMeta.deleted ? taskMeta.data : null;
  if (!task) return [];
  return uniqueIdsV12_([task.responsavelId, task.solicitanteId, task.aprovadorId, senderId].concat(task.participantes || []));
}

function normalizeConversationIdV12_(type, userId, participantIds, area, taskId, requestedId) {
  if (requestedId) return String(requestedId);
  if (type === 'direct') return 'direct:' + uniqueIdsV12_([userId].concat(participantIds || [])).sort().join(':');
  if (type === 'area') return 'area:' + normalizeAreaKeyV12_(area || 'sem-area');
  if (type === 'task') return 'task:' + String(taskId || '');
  return 'group:' + Utilities.getUuid();
}

function createConversationServer(payload) {
  payload = payload || {};
  const operationId = String(payload.operationId || Utilities.getUuid());
  let auth;
  try { auth = requireSessionV12_(payload, true); }
  catch (error) { return errorResponse_('SESSION_INVALID', 'Sua sessão expirou. Entre novamente.', getDatabaseVersion_(), operationId); }
  const lock = tryWriteLockV12_(5000);
  if (!lock) return serverBusyV12_(operationId);
  try {
    const spreadsheet = getSpreadsheet_();
    ensureCommunicationSchemaV12_(spreadsheet);
    const previous = getOperationRowV12_(spreadsheet, operationId);
    if (previous && previous.status === 'COMPLETED' && previous.result) return previous.result;

    const type = ['direct','area','group','task'].indexOf(String(payload.type || 'direct')) >= 0 ? String(payload.type || 'direct') : 'direct';
    let participants = uniqueIdsV12_([auth.user.id].concat(payload.participantIds || []));
    let area = String((['admin','diretoria'].indexOf(String(auth.user.perfil || '')) >= 0 ? payload.area : auth.user.area) || auth.user.area || '');
    const taskId = String(payload.taskId || '');
    if (type === 'direct' && participants.length !== 2) return errorResponse_('INVALID_PARTICIPANTS', 'Selecione uma pessoa para a conversa individual.', getDatabaseVersion_(), operationId);
    if (type === 'area') {
      if (!area) return errorResponse_('AREA_REQUIRED', 'Seu usuário não possui área definida.', getDatabaseVersion_(), operationId);
      participants = readCollectionRecords_(spreadsheet, 'collaborators', false)
        .filter(function (person) { return person && person.ativo !== false && normalizeAreaKeyV12_(person.area || '') === normalizeAreaKeyV12_(area); })
        .map(function (person) { return person.id; });
      if (participants.indexOf(auth.user.id) < 0) participants.push(auth.user.id);
    }
    if (type === 'task') {
      const taskMeta = getRecordMeta_(spreadsheet, 'tasks', taskId);
      const task = taskMeta && !taskMeta.deleted ? taskMeta.data : null;
      if (!task || !userCanSeeTaskV12_(auth.user, task)) return errorResponse_('TASK_NOT_AVAILABLE', 'A tarefa não está disponível para este usuário.', getDatabaseVersion_(), operationId);
      participants = uniqueIdsV12_([task.responsavelId].concat(task.participantes || []).concat([auth.user.id]));
    }
    if (type === 'group' && participants.length < 2) return errorResponse_('INVALID_PARTICIPANTS', 'O grupo deve possuir pelo menos dois participantes.', getDatabaseVersion_(), operationId);

    const activeUsers = readCollectionRecords_(spreadsheet, 'collaborators', false).filter(function (person) { return person && person.ativo !== false; });
    const activeIds = {};
    activeUsers.forEach(function (person) { activeIds[person.id] = true; });
    participants = participants.filter(function (id) { return activeIds[id]; });
    if (participants.indexOf(auth.user.id) < 0) participants.push(auth.user.id);
    if (type === 'direct' && participants.length !== 2) return errorResponse_('INVALID_PARTICIPANTS', 'O destinatário não está ativo.', getDatabaseVersion_(), operationId);
    if (type === 'group' && participants.length < 2) return errorResponse_('INVALID_PARTICIPANTS', 'O grupo deve possuir pelo menos dois participantes ativos.', getDatabaseVersion_(), operationId);

    const conversationId = normalizeConversationIdV12_(type, auth.user.id, participants, area, taskId, payload.conversationId);
    const existing = getRecordMeta_(spreadsheet, 'conversations', conversationId);
    if (existing && !existing.deleted) {
      if (!conversationVisibleForUserV1215_(spreadsheet, auth.user, existing.data)) return errorResponse_('PERMISSION_DENIED', 'Você não participa desta conversa.', getDatabaseVersion_(), operationId);
      if (String(existing.operationId || '') === operationId) {
        const recoveredConversation = cloneObject_(existing.data);
        appendChangeOnceV12_(spreadsheet, 'conversations', conversationId, existing.version, false, recoveredConversation._serverUpdatedAt || new Date().toISOString(), auth.user.id, operationId, recoveredConversation);
        const desiredVersion = Number(recoveredConversation._databaseVersionAtWrite || getDatabaseVersion_());
        if (getDatabaseVersion_() < desiredVersion) setMetaValue_('DATABASE_VERSION', String(desiredVersion));
        const recoveredResult = successResponse_({ operationId: operationId, recordId: conversationId, recordVersion: existing.version, databaseVersion: Math.max(getDatabaseVersion_(), desiredVersion), data: { conversation: recoveredConversation, created: true, recovered: true, sequence: getChangeSequenceV12_() } });
        setOperationV12_(spreadsheet, operationId, 'conversation:create', auth.user.id, conversationId, 'COMPLETED', recoveredResult, '');
        return recoveredResult;
      }
      const resultExisting = successResponse_({ operationId: operationId, recordId: conversationId, recordVersion: existing.version, databaseVersion: getDatabaseVersion_(), data: { conversation: existing.data, created: false, sequence: getChangeSequenceV12_() } });
      setOperationV12_(spreadsheet, operationId, 'conversation:create', auth.user.id, conversationId, 'COMPLETED', resultExisting, '');
      return resultExisting;
    }

    const now = new Date().toISOString();
    const desiredDatabaseVersion = getDatabaseVersion_() + 1;
    const conversation = {
      id: conversationId,
      type: type,
      name: String(payload.name || '').trim() || (type === 'area' ? 'Grupo · ' + area : type === 'group' ? 'Novo grupo' : ''),
      participantIds: participants,
      adminIds: type === 'group' ? [auth.user.id] : [],
      area: area,
      areaKey: normalizeAreaKeyV12_(area),
      taskId: taskId,
      createdBy: auth.user.id,
      createdAt: now,
      updatedAt: now,
      active: true,
      _collection: 'conversations', _recordVersion: 1, _updatedBy: auth.user.id, _serverUpdatedAt: now, _lastOperationId: operationId,
      _databaseVersionAtWrite: desiredDatabaseVersion
    };
    setOperationV12_(spreadsheet, operationId, 'conversation:create', auth.user.id, conversationId, 'PROCESSING', null, '');
    upsertRecord_(spreadsheet, 'conversations', conversationId, 1, false, now, auth.user.id, operationId, conversation);
    appendChangeOnceV12_(spreadsheet, 'conversations', conversationId, 1, false, now, auth.user.id, operationId, conversation);
    const databaseVersion = desiredDatabaseVersion;
    setMetaValue_('DATABASE_VERSION', String(databaseVersion));
    setMetaValue_('LAST_WRITE_MODULE', 'conversations');
    const result = successResponse_({ operationId: operationId, recordId: conversationId, recordVersion: 1, databaseVersion: databaseVersion, data: { conversation: conversation, created: true, sequence: getChangeSequenceV12_() } });
    setOperationV12_(spreadsheet, operationId, 'conversation:create', auth.user.id, conversationId, 'COMPLETED', result, '');
    SpreadsheetApp.flush();
    return result;
  } catch (error) {
    return errorResponse_('CONVERSATION_FAILURE', safeErrorMessage_(error), getDatabaseVersion_(), operationId);
  } finally { lock.releaseLock(); }
}

function resolveConversationV12_(spreadsheet, authUser, conversationId, payload) {
  let meta = getRecordMeta_(spreadsheet, 'conversations', conversationId);
  if (meta && !meta.deleted) return meta.data;
  const type = conversationId.indexOf('area:') === 0 ? 'area' : conversationId.indexOf('task:') === 0 ? 'task' : conversationId.indexOf('direct:') === 0 ? 'direct' : '';
  if (!type) return null;
  const now = new Date().toISOString();
  const operationId = String(payload.operationId || Utilities.getUuid()) + ':conversation';
  let participants = [];
  let area = '';
  let taskId = '';
  if (type === 'direct') {
    participants = uniqueIdsV12_(conversationId.slice(7).split(':').concat([authUser.id]));
    if (participants.length !== 2) return null;
  } else if (type === 'area') {
    area = String((['admin','diretoria'].indexOf(String(authUser.perfil || '')) >= 0 ? payload.area : authUser.area) || authUser.area || conversationId.slice(5));
    const areaKey = normalizeAreaKeyV12_(area);
    participants = readCollectionRecords_(spreadsheet, 'collaborators', false)
      .filter(function (person) { return person && person.ativo !== false && normalizeAreaKeyV12_(person.area || '') === areaKey; })
      .map(function (person) { return person.id; });
    if (participants.indexOf(authUser.id) < 0) participants.push(authUser.id);
  } else if (type === 'task') {
    taskId = conversationId.slice(5);
    const taskMeta = getRecordMeta_(spreadsheet, 'tasks', taskId);
    const task = taskMeta && !taskMeta.deleted ? taskMeta.data : null;
    if (!task || !userCanSeeTaskV12_(authUser, task)) return null;
    participants = uniqueIdsV12_([authUser.id, task.responsavelId, task.solicitanteId].concat(task.participantes || []));
  }
  const activeIds = {};
  readCollectionRecords_(spreadsheet, 'collaborators', false).forEach(function (person) { if (person && person.ativo !== false) activeIds[person.id] = true; });
  participants = participants.filter(function (id) { return activeIds[id]; });
  if (participants.indexOf(authUser.id) < 0) participants.push(authUser.id);
  const conversation = {
    id: conversationId, type: type, name: type === 'area' ? 'Grupo · ' + area : '', participantIds: participants,
    adminIds: [], area: area, areaKey: normalizeAreaKeyV12_(area), taskId: taskId, createdBy: authUser.id,
    createdAt: now, updatedAt: now, active: true,
    _collection: 'conversations', _recordVersion: 1, _updatedBy: authUser.id, _serverUpdatedAt: now, _lastOperationId: operationId
  };
  upsertRecord_(spreadsheet, 'conversations', conversationId, 1, false, now, authUser.id, operationId, conversation);
  appendChangeOnceV12_(spreadsheet, 'conversations', conversationId, 1, false, now, authUser.id, operationId, conversation);
  return conversation;
}

function sendMessageServer(payload) {
  payload = payload || {};
  const operationId = String(payload.operationId || Utilities.getUuid());
  let auth;
  try { auth = requireSessionV12_(payload, true); }
  catch (error) { return errorResponse_('SESSION_INVALID', 'Sua sessão expirou. Entre novamente.', getDatabaseVersion_(), operationId); }
  const text = String(payload.text || payload.texto || '').trim();
  if (!text) return errorResponse_('MESSAGE_REQUIRED', 'Digite uma mensagem.', getDatabaseVersion_(), operationId);
  if (text.length > 4000) return errorResponse_('MESSAGE_TOO_LONG', 'A mensagem deve possuir no máximo 4.000 caracteres.', getDatabaseVersion_(), operationId);

  const lock = tryWriteLockV12_(5000);
  if (!lock) return serverBusyV12_(operationId);
  try {
    const spreadsheet = getSpreadsheet_();
    ensureCommunicationSchemaV12_(spreadsheet);
    const previous = getOperationRowV12_(spreadsheet, operationId);
    if (previous && previous.status === 'COMPLETED' && previous.result) return previous.result;

    const conversationId = String(payload.conversationId || '');
    if (!conversationId) return errorResponse_('CONVERSATION_REQUIRED', 'A conversa não foi informada.', getDatabaseVersion_(), operationId);
    const conversation = resolveConversationV12_(spreadsheet, auth.user, conversationId, payload);
    if (!conversation) return errorResponse_('CONVERSATION_NOT_FOUND', 'A conversa não foi encontrada.', getDatabaseVersion_(), operationId);

    if (!conversationVisibleForUserV1215_(spreadsheet, auth.user, conversation)) return errorResponse_('PERMISSION_DENIED', 'Você não participa desta conversa.', getDatabaseVersion_(), operationId);

    let participants = conversation.taskId
      ? currentTaskConversationParticipantsV1215_(spreadsheet, conversation, auth.user.id)
      : uniqueIdsV12_(conversation.participantIds || []);
    if (conversation.type === 'area') {
      participants = readCollectionRecords_(spreadsheet, 'collaborators', false)
        .filter(function (person) { return person && person.ativo !== false && normalizeAreaKeyV12_(person.area || '') === conversation.areaKey; })
        .map(function (person) { return person.id; });
    }
    const recipients = participants.filter(function (id) { return id !== auth.user.id; });
    const messageId = String(payload.messageId || deterministicIdV12_('message', operationId, conversationId));
    const existing = getRecordMeta_(spreadsheet, 'messages', messageId);
    if (existing && String(existing.operationId || '') === operationId) {
      return recoverMessageOperationV12_(spreadsheet, auth.user, operationId, conversation, existing);
    }

    const now = new Date().toISOString();
    const desiredDatabaseVersion = getDatabaseVersion_() + 1;
    const message = {
      id: messageId,
      conversationId: conversationId,
      conversationType: conversation.type,
      taskId: conversation.taskId || '',
      area: conversation.area || '',
      authorId: auth.user.id,
      recipientIds: recipients,
      texto: text,
      createdAt: now,
      replyToId: String(payload.replyToId || ''),
      readBy: [auth.user.id],
      editedAt: '', deleted: false,
      deliveryStatus: 'sent',
      _collection: 'messages', _recordVersion: 1, _updatedBy: auth.user.id, _serverUpdatedAt: now, _lastOperationId: operationId,
      _databaseVersionAtWrite: desiredDatabaseVersion
    };
    setOperationV12_(spreadsheet, operationId, 'message:send', auth.user.id, messageId, 'PROCESSING', null, '');
    upsertRecord_(spreadsheet, 'messages', messageId, 1, false, now, auth.user.id, operationId, message);
    const sequence = appendChangeOnceV12_(spreadsheet, 'messages', messageId, 1, false, now, auth.user.id, operationId, message);
    message._messageSequence = Number(sequence || getChangeSequenceV12_());
    upsertRecord_(spreadsheet, 'messages', messageId, 1, false, now, auth.user.id, operationId, message);
    indexMessageV12_(spreadsheet, message);

    conversation.updatedAt = now;
    conversation.lastMessageId = messageId;
    const conversationMeta = getRecordMeta_(spreadsheet, 'conversations', conversationId);
    const conversationVersion = conversationMeta ? Number(conversationMeta.version || 0) + 1 : 1;
    conversation._recordVersion = conversationVersion;
    conversation._serverUpdatedAt = now;
    conversation._updatedBy = auth.user.id;
    conversation._lastOperationId = operationId;
    upsertRecord_(spreadsheet, 'conversations', conversationId, conversationVersion, false, now, auth.user.id, operationId, conversation);
    appendChangeOnceV12_(spreadsheet, 'conversations', conversationId, conversationVersion, false, now, auth.user.id, operationId, conversation);

    const databaseVersion = desiredDatabaseVersion;
    setMetaValue_('DATABASE_VERSION', String(databaseVersion));
    setMetaValue_('LAST_WRITE_MODULE', 'messages');
    const result = successResponse_({ operationId: operationId, recordId: messageId, recordVersion: 1, databaseVersion: databaseVersion, data: { message: message, conversation: conversation, sequence: getChangeSequenceV12_() } });
    setOperationV12_(spreadsheet, operationId, 'message:send', auth.user.id, messageId, 'COMPLETED', result, '');
    SpreadsheetApp.flush();
    return result;
  } catch (error) {
    return errorResponse_('MESSAGE_FAILURE', safeErrorMessage_(error), getDatabaseVersion_(), operationId);
  } finally { lock.releaseLock(); }
}

function findChangeSequenceV12_(spreadsheet, collection, recordId, operationId) {
  const sheet = getOrCreateSheet_(spreadsheet, V12_CHANGELOG_SHEET);
  initializeHeaders_(sheet, V12_CHANGELOG_HEADERS);
  if (sheet.getLastRow() < 2) return 0;
  const matches = sheet.getRange(2, 8, sheet.getLastRow() - 1, 1).createTextFinder(String(operationId || '')).matchEntireCell(true).findAll();
  for (let index = 0; index < matches.length; index += 1) {
    const row = sheet.getRange(matches[index].getRow(), 1, 1, 3).getValues()[0];
    if (String(row[1] || '') === String(collection) && String(row[2] || '') === String(recordId)) return Number(row[0] || 0);
  }
  return 0;
}

function recoverMessageOperationV12_(spreadsheet, user, operationId, conversation, existingMeta) {
  const message = cloneObject_(existingMeta.data || {});
  const messageId = String(message.id || existingMeta.data && existingMeta.data.id || '');
  const now = String(message._serverUpdatedAt || message.createdAt || new Date().toISOString());
  let sequence = Number(message._messageSequence || 0);
  if (!sequence) {
    sequence = Number(appendChangeOnceV12_(spreadsheet, 'messages', messageId, existingMeta.version, false, now, user.id, operationId, message) || findChangeSequenceV12_(spreadsheet, 'messages', messageId, operationId) || getChangeSequenceV12_());
    message._messageSequence = sequence;
    upsertRecord_(spreadsheet, 'messages', messageId, existingMeta.version, false, now, user.id, operationId, message);
  }
  indexMessageV12_(spreadsheet, message);

  const conversationId = String(message.conversationId || conversation && conversation.id || '');
  let conversationMeta = getRecordMeta_(spreadsheet, 'conversations', conversationId);
  const recoveredConversation = cloneObject_(conversationMeta && conversationMeta.data || conversation || {});
  recoveredConversation.id = conversationId;
  recoveredConversation.updatedAt = now;
  recoveredConversation.lastMessageId = messageId;
  recoveredConversation._updatedBy = user.id;
  recoveredConversation._serverUpdatedAt = now;
  recoveredConversation._lastOperationId = operationId;
  let conversationVersion = conversationMeta ? Number(conversationMeta.version || 0) : 0;
  if (!conversationMeta || String(conversationMeta.operationId || '') !== operationId || String(conversationMeta.data && conversationMeta.data.lastMessageId || '') !== messageId) conversationVersion += 1;
  if (conversationVersion < 1) conversationVersion = 1;
  recoveredConversation._recordVersion = conversationVersion;
  upsertRecord_(spreadsheet, 'conversations', conversationId, conversationVersion, false, now, user.id, operationId, recoveredConversation);
  appendChangeOnceV12_(spreadsheet, 'conversations', conversationId, conversationVersion, false, now, user.id, operationId, recoveredConversation);

  let desiredDatabaseVersion = Number(message._databaseVersionAtWrite || 0);
  if (!desiredDatabaseVersion) {
    desiredDatabaseVersion = getDatabaseVersion_() + 1;
    message._databaseVersionAtWrite = desiredDatabaseVersion;
    upsertRecord_(spreadsheet, 'messages', messageId, existingMeta.version, false, now, user.id, operationId, message);
  }
  if (getDatabaseVersion_() < desiredDatabaseVersion) setMetaValue_('DATABASE_VERSION', String(desiredDatabaseVersion));
  setMetaValue_('LAST_WRITE_MODULE', 'messages');
  const result = successResponse_({ operationId: operationId, recordId: messageId, recordVersion: existingMeta.version, databaseVersion: Math.max(getDatabaseVersion_(), desiredDatabaseVersion), data: { message: message, conversation: recoveredConversation, sequence: getChangeSequenceV12_(), recovered: true } });
  setOperationV12_(spreadsheet, operationId, 'message:send', user.id, messageId, 'COMPLETED', result, '');
  SpreadsheetApp.flush();
  return result;
}

function indexMessageV12_(spreadsheet, message) {
  const sheet = getOrCreateSheet_(spreadsheet, V12_MESSAGE_INDEX_SHEET);
  initializeHeaders_(sheet, V12_MESSAGE_INDEX_HEADERS);
  if (sheet.getLastRow() > 1) {
    const found = sheet.getRange(2, 3, sheet.getLastRow() - 1, 1).createTextFinder(String(message.id)).matchEntireCell(true).findNext();
    if (found) return;
  }
  sheet.appendRow([String(message.conversationId || ''), Number(message._messageSequence || 0), String(message.id || ''), String(message.createdAt || message._serverUpdatedAt || '')]);
}

function messageIdsForConversationV12_(spreadsheet, conversationId) {
  const sheet = getOrCreateSheet_(spreadsheet, V12_MESSAGE_INDEX_SHEET);
  initializeHeaders_(sheet, V12_MESSAGE_INDEX_HEADERS);
  if (sheet.getLastRow() < 2) return [];
  const key = String(conversationId || '');
  const matches = sheet.getRange(2,1,sheet.getLastRow()-1,1).createTextFinder(key).matchEntireCell(true).findAll();
  return matches.map(function(cell){
    const row = sheet.getRange(cell.getRow(),1,1,V12_MESSAGE_INDEX_HEADERS.length).getValues()[0];
    return { sequence:Number(row[1]||0), id:String(row[2]||''), createdAt:valueToIso_(row[3]) };
  }).sort(function(a,b){ return a.sequence-b.sequence; });
}

function messageIdsForConversationsV1215_(spreadsheet, conversationIds, perConversationLimit) {
  const wanted = {};
  (conversationIds || []).forEach(function(id){ if (id) wanted[String(id)] = true; });
  const output = {};
  Object.keys(wanted).forEach(function(id){ output[id] = []; });
  const sheet = getOrCreateSheet_(spreadsheet, V12_MESSAGE_INDEX_SHEET);
  initializeHeaders_(sheet, V12_MESSAGE_INDEX_HEADERS);
  if (!Object.keys(wanted).length || sheet.getLastRow() < 2) return output;
  const rows = sheet.getRange(2,1,sheet.getLastRow()-1,V12_MESSAGE_INDEX_HEADERS.length).getValues();
  rows.forEach(function(row){
    const id = String(row[0] || '');
    if (!wanted[id]) return;
    output[id].push({sequence:Number(row[1]||0),id:String(row[2]||''),createdAt:valueToIso_(row[3])});
  });
  const limit = Math.max(1,Number(perConversationLimit||50));
  Object.keys(output).forEach(function(id){
    output[id] = output[id].sort(function(a,b){return a.sequence-b.sequence;}).slice(-limit);
  });
  return output;
}

function getConversationMessagesServer(payload) {
  payload = payload || {};
  let auth;
  try { auth = requireSessionV12_(payload, true); }
  catch (error) { return errorResponse_('SESSION_INVALID', 'Sua sessão expirou.', getDatabaseVersion_(), Utilities.getUuid()); }
  const conversationId = String(payload.conversationId || '');
  const limit = Math.max(1, Math.min(100, Number(payload.limit || 50)));
  const beforeSequence = Number(payload.beforeSequence || Number.MAX_SAFE_INTEGER);
  const spreadsheet = getSpreadsheet_();
  const conversationMeta = getRecordMeta_(spreadsheet, 'conversations', conversationId);
  const conversation = conversationMeta && !conversationMeta.deleted ? conversationMeta.data : null;
  if (!conversation || !conversationVisibleForUserV1215_(spreadsheet, auth.user, conversation)) return errorResponse_('PERMISSION_DENIED', 'Conversa indisponível.', getDatabaseVersion_(), Utilities.getUuid());
  const index = messageIdsForConversationV12_(spreadsheet, conversationId).filter(function (item) { return item.sequence < beforeSequence; });
  const selected = index.slice(-limit);
  const messages = selected.map(function (item) {
    const meta = getRecordMeta_(spreadsheet, 'messages', item.id);
    return meta && !meta.deleted ? meta.data : null;
  }).filter(Boolean);
  return successResponse_({ operationId: Utilities.getUuid(), databaseVersion: getDatabaseVersion_(), data: { messages: messages, hasMore: index.length > selected.length, oldestSequence: selected.length ? selected[0].sequence : 0 } });
}

function getMessagesSinceServer(payload) {
  payload = payload || {};
  let auth;
  try { auth = requireSessionV12_(payload, true); }
  catch (error) { return errorResponse_('SESSION_INVALID', 'Sua sessão expirou.', getDatabaseVersion_(), Utilities.getUuid()); }
  const after = Math.max(0, Number(payload.sequence || 0));
  const limit = Math.max(1, Math.min(200, Number(payload.limit || 100)));
  const conversationId = String(payload.conversationId || '');
  const currentSequence = getChangeSequenceV12_();
  // Caminho mais comum: nenhuma mensagem nova. Evita abrir/ler o changelog.
  if (after >= currentSequence) {
    return successResponse_({ operationId:Utilities.getUuid(), databaseVersion:getDatabaseVersion_(), data:{ messages:[], sequence:currentSequence, hasMore:false } });
  }
  const spreadsheet = getSpreadsheet_();
  const sheet = getOrCreateSheet_(spreadsheet, V12_CHANGELOG_SHEET);
  initializeHeaders_(sheet, V12_CHANGELOG_HEADERS);
  if (sheet.getLastRow() < 2) return successResponse_({ operationId: Utilities.getUuid(), databaseVersion: getDatabaseVersion_(), data: { messages: [], sequence: currentSequence, hasMore: false } });

  // O changelog é append-only e sua sequência cresce monotonicamente. Na maior
  // parte das bases a linha ~= sequência + 1; validamos a primeira linha antes
  // de usar a janela reduzida e recuamos para a linha 2 se houver migrações.
  let startRow = Math.max(2, Math.min(sheet.getLastRow(), after + 2));
  if (startRow > 2) {
    const probe = Number(sheet.getRange(startRow, 1).getValue() || 0);
    if (!probe || probe > after + 1) startRow = 2;
  }
  const count = sheet.getLastRow() - startRow + 1;
  const rows = count > 0 ? sheet.getRange(startRow, 1, count, V12_CHANGELOG_HEADERS.length).getValues() : [];
  const messages = [];
  let scanned = after;
  let hasMore = false;
  for (let i = 0; i < rows.length; i += 1) {
    const sequence = Number(rows[i][0] || 0);
    if (sequence <= after) continue;
    scanned = sequence;
    if (String(rows[i][1] || '') !== 'messages') continue;
    let data = {};
    try { data = JSON.parse(String(rows[i][8] || '{}')); } catch (ignored) { data = {}; }
    let visible = false;
    if (data.taskId) {
      const taskId = String(data.taskId || '');
      const taskMeta = getRecordMeta_(spreadsheet, 'tasks', taskId);
      const task = taskMeta && !taskMeta.deleted ? taskMeta.data : null;
      visible = Boolean(task && userCanSeeTaskV12_(auth.user, task));
    } else {
      visible = String(data.authorId || '') === String(auth.user.id)
        || (Array.isArray(data.recipientIds) && data.recipientIds.indexOf(auth.user.id) >= 0)
        || (data.area && normalizeAreaKeyV12_(data.area) === normalizeAreaKeyV12_(auth.user.area || ''));
    }
    if (!visible || (conversationId && String(data.conversationId || '') !== conversationId)) continue;
    messages.push(data);
    if (messages.length >= limit) {
      hasMore = rows.slice(i + 1).some(function (row) { return Number(row[0] || 0) > scanned && String(row[1] || '') === 'messages'; });
      break;
    }
  }
  if (!hasMore) scanned = currentSequence;
  return successResponse_({ operationId: Utilities.getUuid(), databaseVersion: getDatabaseVersion_(), data: { messages: messages, sequence: scanned, hasMore: hasMore } });
}

function markConversationReadServer(payload) {
  payload = payload || {};
  const operationId = String(payload.operationId || Utilities.getUuid());
  let auth;
  try { auth = requireSessionV12_(payload, true); }
  catch (error) { return errorResponse_('SESSION_INVALID', 'Sua sessão expirou.', getDatabaseVersion_(), operationId); }
  const conversationId = String(payload.conversationId || '');
  if (!conversationId) return errorResponse_('CONVERSATION_REQUIRED', 'A conversa não foi informada.', getDatabaseVersion_(), operationId);
  const lock = tryWriteLockV12_(3000);
  if (!lock) return serverBusyV12_(operationId);
  try {
    const spreadsheet = getSpreadsheet_();
    const previous = getOperationRowV12_(spreadsheet, operationId);
    if (previous && previous.status === 'COMPLETED' && previous.result) return previous.result;
    const conversationMeta = getRecordMeta_(spreadsheet, 'conversations', conversationId);
    const conversation = conversationMeta && !conversationMeta.deleted ? conversationMeta.data : null;
    if (!conversation || !conversationVisibleForUserV1215_(spreadsheet, auth.user, conversation)) return errorResponse_('PERMISSION_DENIED', 'Conversa indisponível.', getDatabaseVersion_(), operationId);
    const recordId = conversationId + ':' + auth.user.id;
    const meta = getRecordMeta_(spreadsheet, 'conversationReads', recordId);
    if (meta && String(meta.operationId || '') === operationId) {
      appendChangeOnceV12_(spreadsheet, 'conversationReads', recordId, meta.version, false, meta.updatedAt || new Date().toISOString(), auth.user.id, operationId, meta.data, { userIds: [auth.user.id] });
      const recoveredResult = successResponse_({ operationId: operationId, recordId: recordId, recordVersion: meta.version, databaseVersion: getDatabaseVersion_(), data: { read: meta.data, sequence: getChangeSequenceV12_(), recovered: true } });
      setOperationV12_(spreadsheet, operationId, 'conversation:read', auth.user.id, recordId, 'COMPLETED', recoveredResult, '');
      return recoveredResult;
    }
    const now = new Date().toISOString();
    const read = {
      id: recordId,
      conversationId: conversationId,
      userId: auth.user.id,
      lastReadMessageId: String(payload.lastReadMessageId || conversation.lastMessageId || ''),
      lastReadSequence: Number(payload.lastReadSequence || getChangeSequenceV12_()),
      lastReadAt: now,
      _collection: 'conversationReads', _recordVersion: (meta ? Number(meta.version || 0) : 0) + 1,
      _updatedBy: auth.user.id, _serverUpdatedAt: now, _lastOperationId: operationId
    };
    setOperationV12_(spreadsheet, operationId, 'conversation:read', auth.user.id, recordId, 'PROCESSING', null, '');
    upsertRecord_(spreadsheet, 'conversationReads', recordId, read._recordVersion, false, now, auth.user.id, operationId, read);
    appendChangeOnceV12_(spreadsheet, 'conversationReads', recordId, read._recordVersion, false, now, auth.user.id, operationId, read, { userIds: [auth.user.id] });
    const result = successResponse_({ operationId: operationId, recordId: recordId, recordVersion: read._recordVersion, databaseVersion: getDatabaseVersion_(), data: { read: read, sequence: getChangeSequenceV12_() } });
    setOperationV12_(spreadsheet, operationId, 'conversation:read', auth.user.id, recordId, 'COMPLETED', result, '');
    return result;
  } finally { lock.releaseLock(); }
}

function loadCommunicationBootstrapServer(payload) {
  payload = payload || {};
  let auth;
  try { auth = requireSessionV12_(payload, true); }
  catch (error) { return errorResponse_('SESSION_INVALID', 'Sua sessão expirou.', getDatabaseVersion_(), Utilities.getUuid()); }
  const spreadsheet = getSpreadsheet_();
  ensureCommunicationSchemaV12_(spreadsheet);
  const tasks = readCollectionRecords_(spreadsheet, 'tasks', false);
  const visibleTaskIds = {};
  tasks.forEach(function (task) { if (userCanSeeTaskV12_(auth.user, task)) visibleTaskIds[task.id] = true; });
  const conversations = readCollectionRecords_(spreadsheet, 'conversations', false).filter(function (conversation) { return userCanSeeConversationV12_(auth.user, conversation, visibleTaskIds); });
  const reads = readCollectionRecords_(spreadsheet, 'conversationReads', false).filter(function (read) { return String(read.userId || '') === String(auth.user.id); });
  const messages = [];
  const groupedMessageIds = messageIdsForConversationsV1215_(spreadsheet, conversations.map(function(conversation){ return conversation.id; }), 30);
  conversations.forEach(function (conversation) {
    const ids = groupedMessageIds[String(conversation.id || '')] || [];
    ids.forEach(function (item) {
      const meta = getRecordMeta_(spreadsheet, 'messages', item.id);
      if (meta && !meta.deleted) messages.push(meta.data);
    });
  });
  const notifications = readCollectionRecords_(spreadsheet, 'notifications', false).filter(function (notification) { return String(notification.userId || notification.destinatarioId || '') === String(auth.user.id); }).slice(-200);
  return successResponse_({ operationId: Utilities.getUuid(), databaseVersion: getDatabaseVersion_(), data: { conversations: conversations, conversationReads: reads, messages: messages, notifications: notifications, sequence: getChangeSequenceV12_() } });
}
