const V10_META_SHEET = 'SGO_META';
const V10_BACKUPS_SHEET = 'SGO_BACKUPS';
const V10_RECORD_HEADERS = ['ID_INTERNO', 'ID_REGISTRO', 'COLECAO', 'VERSAO', 'EXCLUIDO', 'ATUALIZADO_EM', 'ATUALIZADO_POR', 'OPERACAO_ID', 'DADOS_JSON'];
const V10_META_HEADERS = ['CHAVE', 'VALOR', 'ATUALIZADO_EM'];
const V10_BACKUP_HEADERS = ['BACKUP_ID', 'ORDEM', 'CONTEUDO', 'DB_VERSION', 'CRIADO_EM', 'USUARIO_ID', 'MOTIVO'];
const V10_COLLECTIONS = {
  tasks: 'SGO_TAREFAS',
  messages: 'SGO_MENSAGENS',
  feedbacks: 'SGO_FEEDBACKS',
  notifications: 'SGO_NOTIFICACOES',
  collaborators: 'SGO_USUARIOS',
  processes: 'SGO_PROCESSOS',
  audits: 'SGO_AUDITORIAS',
  activity: 'SGO_EVENTOS',
  securityLog: 'SGO_EVENTOS',
  errors: 'SGO_ERROS'
};
const V10_SYSTEM_FIELDS = ['companies', 'settings', 'organization', 'security', 'branding'];

function setupSGOV10(payload) {
  requireAdminOrEditorV12_(payload || {});
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const spreadsheet = getSpreadsheet_();
    backupLegacyBeforeV10Schema_(spreadsheet);
    ensureV10Schema_(spreadsheet);
    migrateLegacyStateV10_(spreadsheet);
    setMetaValue_('V10_ACTIVE', 'true');
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  return typeof setupSGOV12 === 'function' ? setupSGOV12() : { success: true, confirmed: true, databaseVersion: getDatabaseVersion_(), serverTimestamp: new Date().toISOString() };
}

function loadV10BootstrapServer(payload) {
  payload = payload || {};
  if (!payload.sessionToken) return loadPublicBootstrapServer();
  return resumeSessionServer(payload);
}

function getSyncSnapshotServer(payload) {
  payload = payload || {};
  let auth;
  try { auth = requireSessionV12_(payload, true); }
  catch (error) { return errorResponse_('SESSION_INVALID', 'Sua sessão expirou. Entre novamente.', getDatabaseVersion_(), Utilities.getUuid()); }
  const spreadsheet = getSpreadsheet_();
  const serverVersion = getDatabaseVersion_();
  if (Number(payload.databaseVersion || 0) === serverVersion && !payload.force) {
    return successResponse_({ operationId: Utilities.getUuid(), databaseVersion: serverVersion, data: { noChange: true, sequence: getChangeSequenceV12_() } });
  }
  return successResponse_({ operationId: Utilities.getUuid(), databaseVersion: serverVersion, data: { noChange: false, state: buildScopedStateV12_(spreadsheet, auth.user), sequence: getChangeSequenceV12_() } });
}

function getDatabaseVersionServer() {
  return successResponse_({ operationId: Utilities.getUuid(), databaseVersion: getDatabaseVersion_(), data: { active: isV10Active_(), sequence: getChangeSequenceV12_() } });
}

function preflightWriteServer(payload) {
  payload = payload || {};
  const operationId = String(payload.operationId || Utilities.getUuid());
  let auth;
  try { auth = requireSessionV12_(payload, true); }
  catch (error) { return errorResponse_('SESSION_INVALID', 'Sua sessão expirou. Entre novamente.', getDatabaseVersion_(), operationId); }
  const taskId = String(payload.taskId || '');
  const clientTaskVersion = Number(payload.taskVersion || 0);
  let serverTaskVersion = 0;
  let serverTask = null;
  if (taskId) {
    const meta = getRecordMeta_(getSpreadsheet_(), 'tasks', taskId);
    serverTaskVersion = meta ? Number(meta.version || 0) : 0;
    serverTask = meta && !meta.deleted ? meta.data : null;
    if (serverTask && !canMutateTaskV12_(auth.user, serverTask, serverTask, false)) {
      return errorResponse_('PERMISSION_DENIED', 'Seu perfil não pode alterar esta tarefa.', getDatabaseVersion_(), operationId);
    }
  }
  if (clientTaskVersion !== serverTaskVersion) {
    return conflictResponse_({ operationId: operationId, message: 'A tarefa foi alterada por outro usuário.', localVersion: clientTaskVersion, serverVersion: serverTaskVersion, databaseVersion: getDatabaseVersion_(), serverData: serverTask });
  }
  return successResponse_({ operationId: operationId, recordId: taskId, recordVersion: serverTaskVersion, databaseVersion: getDatabaseVersion_(), data: { canWrite: true, sequence: getChangeSequenceV12_() } });
}

function commitStateChangesServer(payload) {
  payload = payload || {};
  const operationId = String(payload.operationId || Utilities.getUuid());
  let auth;
  try { auth = requireSessionV12_(payload, true); }
  catch (error) { return errorResponse_('SESSION_INVALID', 'Sua sessão expirou. Entre novamente.', getDatabaseVersion_(), operationId); }
  const changes = Array.isArray(payload.changes) ? payload.changes : [];
  const systemPatch = payload.systemPatch && typeof payload.systemPatch === 'object' ? cloneObject_(payload.systemPatch) : {};
  // Segredos e controles de autenticação nunca são aceitos do navegador.
  if (systemPatch.security) {
    delete systemPatch.security.pinHashes;
    delete systemPatch.security.failedAttempts;
  }
  const lock = tryWriteLockV12_(1800);
  if (!lock) return serverBusyV12_(operationId);
  try {
    const spreadsheet = getSpreadsheet_();
    const previousOperation = getOperationRowV12_(spreadsheet, operationId);
    if (previousOperation && previousOperation.status === 'COMPLETED' && previousOperation.result) return previousOperation.result;
    if (Object.keys(systemPatch).length && String(auth.user.perfil || '') !== 'admin') {
      return errorResponse_('PERMISSION_DENIED', 'Somente administradores podem alterar configurações globais.', getDatabaseVersion_(), operationId);
    }
    const conflicts = [];
    const currentState = {};
    changes.forEach(function (change) {
      const collection = String(change.collection || '');
      const recordId = String(change.id || '');
      if (!V10_COLLECTIONS[collection] || !recordId) { conflicts.push({ collection: collection, id: recordId, code: 'INVALID_RECORD' }); return; }
      // Tarefas e comunicação usam operações dedicadas para garantir validação, privacidade e idempotência.
      if (['tasks','messages','conversations','conversationReads'].indexOf(collection) >= 0) {
        conflicts.push({ collection: collection, id: recordId, code: 'DEDICATED_OPERATION_REQUIRED' });
        return;
      }
      const meta = getRecordMeta_(spreadsheet, collection, recordId);
      const serverVersion = meta ? Number(meta.version || 0) : 0;
      const expectedVersion = Number(change.expectedVersion || 0);
      if (serverVersion !== expectedVersion) { conflicts.push({ collection: collection, id: recordId, code: 'VERSION_CONFLICT', localVersion: expectedVersion, serverVersion: serverVersion, serverData: meta ? meta.data : null }); return; }
      if (!canWriteRecordV10_(currentState || {}, auth.user, collection, meta ? meta.data : null, change.data, Boolean(change.deleted))) conflicts.push({ collection: collection, id: recordId, code: 'PERMISSION_DENIED' });
    });
    if (conflicts.length) {
      const first = conflicts[0];
      return { success:false, confirmed:false, conflict:first.code==='VERSION_CONFLICT', errorCode:first.code, message:first.code==='DEDICATED_OPERATION_REQUIRED'?'Este registro deve ser salvo pelo fluxo seguro e dedicado do módulo.':first.code==='PERMISSION_DENIED'?'Seu perfil não possui permissão para concluir esta gravação.':'Um ou mais registros foram alterados por outro usuário.', operationId:operationId, databaseVersion:getDatabaseVersion_(), conflicts:conflicts, serverTimestamp:new Date().toISOString() };
    }
    setOperationV12_(spreadsheet, operationId, 'generic:' + String(payload.module || 'system'), auth.user.id, '', 'PROCESSING', null, '');
    const changedRecords = [];
    const temporaryPins = [];
    const now = new Date().toISOString();
    changes.forEach(function (change) {
      const collection = String(change.collection);
      const recordId = String(change.id);
      const meta = getRecordMeta_(spreadsheet, collection, recordId);
      const version = (meta ? Number(meta.version || 0) : 0) + 1;
      const deleted = Boolean(change.deleted);
      const data = deleted ? cloneObject_(meta && meta.data || change.data || {}) : cloneObject_(change.data || {});
      data.id = recordId; data._collection = collection; data._recordVersion = version; data._updatedBy = auth.user.id; data._serverUpdatedAt = now; data._lastOperationId = operationId;
      upsertRecord_(spreadsheet, collection, recordId, version, deleted, now, auth.user.id, operationId, data);
      appendChangeOnceV12_(spreadsheet, collection, recordId, version, deleted, now, auth.user.id, operationId, data);
      if (collection === 'collaborators' && !deleted && typeof ensureCollaboratorCredentialV1215_ === 'function') {
        const temporaryPin = ensureCollaboratorCredentialV1215_(spreadsheet, recordId);
        if (temporaryPin) temporaryPins.push({ userId:recordId, nome:String(data.nome || ''), pin:temporaryPin });
        try { CacheService.getScriptCache().remove(v1210CacheKey_('SGO_USER_RECORD', recordId)); } catch (ignored) {}
      }
      changedRecords.push({ collection:collection, id:recordId, version:version, deleted:deleted, data:data });
    });
    if (Object.keys(systemPatch).length) {
      const legacy = readLegacyStateV12_(spreadsheet);
      V10_SYSTEM_FIELDS.forEach(function (field) {
        if (!Object.prototype.hasOwnProperty.call(systemPatch, field)) return;
        if (field === 'security') {
          const preservedHashes = cloneObject_(legacy.security && legacy.security.pinHashes || {});
          legacy.security = Object.assign({}, legacy.security || {}, cloneObject_(systemPatch.security || {}));
          legacy.security.pinHashes = preservedHashes;
          delete legacy.security.failedAttempts;
        } else {
          legacy[field] = cloneObject_(systemPatch[field]);
        }
      });
      legacy.version = 12;
      writeLegacyStateV12_(spreadsheet, legacy);
    }
    const databaseVersion = getDatabaseVersion_() + 1;
    // v12.17: o commit genérico não reescreve SGO_META cinco vezes dentro do
    // ScriptLock. A fonte quente é autoritativa; a manutenção faz o espelho.
    setHotMetaValuesV1217_({
      DATABASE_VERSION:String(databaseVersion), LAST_OPERATION_ID:operationId,
      LAST_WRITE_AT:now, LAST_WRITE_USER:auth.user.id,
      LAST_WRITE_MODULE:String(payload.module || 'system')
    });
    // Nunca devolve nem persiste o estado completo dentro de SGO_OPERACOES.
    // O resultado deve permanecer pequeno para não atingir o limite de 50.000 caracteres por célula.
    const result = successResponse_({
      operationId:operationId,
      recordId:changedRecords.length===1?changedRecords[0].id:'',
      recordVersion:changedRecords.length===1?changedRecords[0].version:null,
      databaseVersion:databaseVersion,
      data:{ changedRecords:changedRecords, systemFieldsChanged:Object.keys(systemPatch), temporaryPins:temporaryPins, sequence:getChangeSequenceV12_(), sequenceCursorSafe:false }
    });
    // PIN temporário é resposta efêmera ao administrador: nunca persiste em SGO_OPERACOES.
    const persistedResult = cloneObject_(result);
    if (persistedResult && persistedResult.data) persistedResult.data.temporaryPins = [];
    setOperationV12_(spreadsheet, operationId, 'generic:' + String(payload.module || 'system'), auth.user.id, '', 'COMPLETED', persistedResult, '');
    return result;
  } catch (error) {
    registerServerErrorV10_('COMMIT_FAILURE', error, auth.user.id, String(payload.module || 'system'), operationId);
    return errorResponse_('COMMIT_FAILURE', safeErrorMessage_(error), getDatabaseVersion_(), operationId);
  } finally { lock.releaseLock(); }
}

function restoreRecordFromBackupV10(collection, recordId, backupId, userId, reason, payload) {
  payload = payload || {};
  const auth = requireAdminOrEditorV12_(payload);
  const operationId = String(payload.operationId || Utilities.getUuid());
  collection = String(collection || '');
  recordId = String(recordId || '');
  if (!V10_COLLECTIONS[collection] || !recordId) throw new Error('Coleção ou registro inválido para restauração.');

  const lock = tryWriteLockV12_(5000);
  if (!lock) return serverBusyV12_(operationId);
  try {
    const spreadsheet = getSpreadsheet_();
    const previousOperation = getOperationRowV12_(spreadsheet, operationId);
    if (previousOperation && previousOperation.status === 'COMPLETED' && previousOperation.result) return previousOperation.result;

    const backupState = readV10BackupState_(spreadsheet, String(backupId || ''));
    if (!backupState) throw new Error('Backup não localizado ou incompleto.');
    const records = Array.isArray(backupState[collection]) ? backupState[collection] : [];
    const record = records.find(function (item) { return item && String(item.id) === recordId; });
    if (!record) throw new Error('O registro não existe no backup selecionado.');

    const actorId = String(auth && auth.user && auth.user.id || userId || 'editor');
    const now = new Date().toISOString();
    const meta = getRecordMeta_(spreadsheet, collection, recordId);
    const version = (meta ? Number(meta.version || 0) : 0) + 1;
    const data = cloneObject_(record);
    data.id = recordId;
    data._collection = collection;
    data._recordVersion = version;
    data._updatedBy = actorId;
    data._serverUpdatedAt = now;
    data._lastOperationId = operationId;

    setOperationV12_(spreadsheet, operationId, 'restore:' + collection, actorId, recordId, 'PROCESSING', null, '');
    upsertRecord_(spreadsheet, collection, recordId, version, false, now, actorId, operationId, data);
    appendChangeOnceV12_(spreadsheet, collection, recordId, version, false, now, actorId, operationId, data);

    const securityEntry = {
      id: 'SEC-' + Utilities.getUuid(),
      at: now,
      userId: actorId,
      action: 'RESTORE_RECORD',
      details: 'Registro ' + collection + ':' + recordId + ' restaurado do backup ' + String(backupId || '') + '.',
      entity: collection,
      entityId: recordId,
      backupId: String(backupId || ''),
      reason: String(reason || 'Restauração administrativa'),
      operationId: operationId
    };
    const securityVersion = 1;
    upsertRecord_(spreadsheet, 'securityLog', securityEntry.id, securityVersion, false, now, actorId, operationId, securityEntry);
    appendChangeOnceV12_(spreadsheet, 'securityLog', securityEntry.id, securityVersion, false, now, actorId, operationId, securityEntry);

    const databaseVersion = getDatabaseVersion_() + 1;
    setMetaValue_('DATABASE_VERSION', String(databaseVersion));
    setMetaValue_('LAST_OPERATION_ID', operationId);
    setMetaValue_('LAST_WRITE_AT', now);
    setMetaValue_('LAST_WRITE_USER', actorId);
    setMetaValue_('LAST_WRITE_MODULE', 'recovery');

    const result = successResponse_({
      operationId: operationId,
      recordId: recordId,
      recordVersion: version,
      databaseVersion: databaseVersion,
      data: {
        restored: true,
        backupId: String(backupId || ''),
        changedRecords: [
          { collection: collection, id: recordId, version: version, deleted: false, data: data },
          { collection: 'securityLog', id: securityEntry.id, version: securityVersion, deleted: false, data: securityEntry }
        ],
        sequence: getChangeSequenceV12_()
      }
    });
    setOperationV12_(spreadsheet, operationId, 'restore:' + collection, actorId, recordId, 'COMPLETED', result, '');
    SpreadsheetApp.flush();
    return result;
  } catch (error) {
    registerServerErrorV10_('RESTORE_FAILURE', error, String(userId || 'editor'), collection, operationId);
    return errorResponse_('RESTORE_FAILURE', safeErrorMessage_(error), getDatabaseVersion_(), operationId);
  } finally {
    lock.releaseLock();
  }
}

/** Restaura um snapshot completo sem reutilizar o fluxo legado de gravação integral. */
function restoreStateSnapshotV12_(spreadsheet, snapshot, actorId, operationId, reason) {
  snapshot = snapshot && typeof snapshot === 'object' ? cloneObject_(snapshot) : null;
  if (!snapshot) throw new Error('O snapshot informado é inválido.');
  ensureV10Schema_(spreadsheet);
  ensureCommunicationSchemaV12_(spreadsheet);
  const previousOperation = getOperationRowV12_(spreadsheet, operationId);
  if (previousOperation && previousOperation.status === 'COMPLETED' && previousOperation.result) return previousOperation.result;

  const currentState = buildAuthoritativeState_(spreadsheet);
  const safetyBackupId = createV10Backup_(spreadsheet, currentState, getDatabaseVersion_(), actorId, 'Antes da restauração completa: ' + String(reason || 'snapshot'));
  setOperationV12_(spreadsheet, operationId, 'restore:snapshot', actorId, '', 'PROCESSING', null, '');

  const now = new Date().toISOString();
  const changedRecords = [];
  Object.keys(V10_COLLECTIONS).forEach(function (collection) {
    const targetRecords = Array.isArray(snapshot[collection]) ? snapshot[collection].filter(function (item) { return item && item.id; }) : [];
    const targetById = {};
    targetRecords.forEach(function (item) { targetById[String(item.id)] = item; });
    const currentRecords = readCollectionRecords_(spreadsheet, collection, false);
    const allIds = uniqueIdsV12_(currentRecords.map(function (item) { return item.id; }).concat(Object.keys(targetById)));
    allIds.forEach(function (recordId) {
      const meta = getRecordMeta_(spreadsheet, collection, recordId);
      const target = targetById[recordId];
      const deleted = !target;
      const data = cloneObject_(target || (meta && meta.data) || {});
      const version = (meta ? Number(meta.version || 0) : 0) + 1;
      data.id = recordId;
      data._collection = collection;
      data._recordVersion = version;
      data._updatedBy = actorId;
      data._serverUpdatedAt = now;
      data._lastOperationId = operationId;
      upsertRecord_(spreadsheet, collection, recordId, version, deleted, now, actorId, operationId, data);
      appendChangeOnceV12_(spreadsheet, collection, recordId, version, deleted, now, actorId, operationId, data);
      changedRecords.push({ collection: collection, id: recordId, version: version, deleted: deleted, data: deleted ? null : data });
    });
  });

  const currentLegacy = readLegacyStateV12_(spreadsheet);
  V10_SYSTEM_FIELDS.forEach(function (field) {
    if (!Object.prototype.hasOwnProperty.call(snapshot, field)) return;
    if (field === 'security') {
      const restoredSecurity = cloneObject_(snapshot.security || {});
      const currentHashes = cloneObject_(currentLegacy.security && currentLegacy.security.pinHashes || {});
      if (!restoredSecurity.pinHashes || !Object.keys(restoredSecurity.pinHashes).length) restoredSecurity.pinHashes = currentHashes;
      restoredSecurity.failedAttempts = {};
      currentLegacy.security = restoredSecurity;
    } else {
      currentLegacy[field] = cloneObject_(snapshot[field]);
    }
  });
  currentLegacy.version = 12;
  writeLegacyStateV12_(spreadsheet, currentLegacy);
  migrateLegacyCommunicationV12_(spreadsheet);

  const databaseVersion = getDatabaseVersion_() + 1;
  setMetaValue_('DATABASE_VERSION', String(databaseVersion));
  setMetaValue_('LAST_OPERATION_ID', operationId);
  setMetaValue_('LAST_WRITE_AT', now);
  setMetaValue_('LAST_WRITE_USER', actorId);
  setMetaValue_('LAST_WRITE_MODULE', 'restore:snapshot');
  setMetaValue_('LAST_RESTORE_BACKUP_ID', safetyBackupId);

  const result = successResponse_({
    operationId: operationId,
    databaseVersion: databaseVersion,
    data: {
      restored: true,
      safetyBackupId: safetyBackupId,
      changedRecords: changedRecords,
      sequence: getChangeSequenceV12_()
    }
  });
  setOperationV12_(spreadsheet, operationId, 'restore:snapshot', actorId, '', 'COMPLETED', result, '');
  SpreadsheetApp.flush();
  return result;
}

function listBackupsV10(limit, payload) {
  requireAdminOrEditorV12_(payload || {});
  const spreadsheet = getSpreadsheet_();
  const sheet = getOrCreateSheet_(spreadsheet, V10_BACKUPS_SHEET);
  initializeHeaders_(sheet, V10_BACKUP_HEADERS);
  const rows = sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, V10_BACKUP_HEADERS.length).getValues()
    : [];
  const map = {};
  rows.forEach(function (row) {
    const id = String(row[0] || '');
    if (!id || map[id]) return;
    map[id] = {
      id: id,
      databaseVersion: Number(row[3] || 0),
      createdAt: valueToIso_(row[4]),
      userId: String(row[5] || ''),
      reason: String(row[6] || '')
    };
  });
  return Object.keys(map).map(function (key) { return map[key]; })
    .sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); })
    .slice(0, Math.max(1, Math.min(100, Number(limit || 20))));
}

function rollbackV10ToLegacy(userId, reason, payload) {
  requireAdminOrEditorV12_(payload || {});
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const spreadsheet = getSpreadsheet_();
    const state = buildAuthoritativeState_(spreadsheet);
    createV10Backup_(spreadsheet, state, getDatabaseVersion_(), String(userId || 'admin'), 'Antes do rollback: ' + String(reason || 'retorno à versão anterior'));
    writeLegacyStateV10_(spreadsheet, state);
    setMetaValue_('V10_ACTIVE', 'false');
    setMetaValue_('ROLLBACK_AT', new Date().toISOString());
    setMetaValue_('ROLLBACK_USER', String(userId || 'admin'));
    setMetaValue_('ROLLBACK_REASON', String(reason || ''));
    SpreadsheetApp.flush();
    return {
      success: true,
      confirmed: true,
      message: 'Gravação v10 desativada. A base legada SGO_DB foi atualizada e preservada.',
      databaseVersion: getDatabaseVersion_(),
      serverTimestamp: new Date().toISOString()
    };
  } finally {
    lock.releaseLock();
  }
}

function backupLegacyBeforeV10Schema_(spreadsheet) {
  const databaseSheet = getOrCreateSheet_(spreadsheet, DB_SHEET);
  const backupSheet = getOrCreateSheet_(spreadsheet, BACKUP_SHEET);
  initializeSheet_(databaseSheet);
  initializeSheet_(backupSheet);
  const json = readJson_(databaseSheet);
  if (json) writeJson_(backupSheet, json);
}

function createManualBackupV10(reason, userId, payload) {
  requireAdminOrEditorV12_(payload || {});
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const spreadsheet = getSpreadsheet_();
    ensureV10Schema_(spreadsheet);
    const state = buildAuthoritativeState_(spreadsheet);
    const backupId = createV10Backup_(spreadsheet, state, getDatabaseVersion_(), String(userId || ''), String(reason || 'Backup manual'));
    SpreadsheetApp.flush();
    return successResponse_({ operationId: Utilities.getUuid(), databaseVersion: getDatabaseVersion_(), data: { backupId: backupId } });
  } finally {
    lock.releaseLock();
  }
}

function validateV10Migration(payload) {
  requireAdminOrEditorV12_(payload || {});
  const spreadsheet = getSpreadsheet_();
  ensureV10Schema_(spreadsheet);
  const state = buildAuthoritativeState_(spreadsheet);
  const issues = [];
  Object.keys(V10_COLLECTIONS).forEach(function (collection) {
    const seen = {};
    (state[collection] || []).forEach(function (record) {
      if (!record || !record.id) issues.push(collection + ': registro sem identificador');
      else if (seen[record.id]) issues.push(collection + ': identificador duplicado ' + record.id);
      else seen[record.id] = true;
      if (Number(record && record._recordVersion || 0) < 1) issues.push(collection + ': versão inválida em ' + String(record && record.id || 'sem-id'));
    });
  });
  return {
    success: issues.length === 0,
    confirmed: true,
    databaseVersion: getDatabaseVersion_(),
    serverTimestamp: new Date().toISOString(),
    counts: Object.keys(V10_COLLECTIONS).reduce(function (acc, collection) { acc[collection] = (state[collection] || []).length; return acc; }, {}),
    issues: issues
  };
}

function exportModuleV10(collection, payload) {
  requireAdminOrEditorV12_(payload || {});
  collection = String(collection || '');
  if (collection === 'all') return { success: true, confirmed: true, databaseVersion: getDatabaseVersion_(), data: buildAuthoritativeState_(getSpreadsheet_()), serverTimestamp: new Date().toISOString() };
  if (!V10_COLLECTIONS[collection]) return errorResponse_('INVALID_COLLECTION', 'Módulo inválido para exportação.', getDatabaseVersion_(), Utilities.getUuid());
  return successResponse_({ operationId: Utilities.getUuid(), databaseVersion: getDatabaseVersion_(), data: { collection: collection, records: readCollectionRecords_(getSpreadsheet_(), collection, true) } });
}

function ensureV10Schema_(spreadsheet) {
  initializeHeaders_(getOrCreateSheet_(spreadsheet, V10_META_SHEET), V10_META_HEADERS);
  initializeHeaders_(getOrCreateSheet_(spreadsheet, V10_BACKUPS_SHEET), V10_BACKUP_HEADERS);
  Object.keys(V10_COLLECTIONS).forEach(function (collection) {
    initializeHeaders_(getOrCreateSheet_(spreadsheet, V10_COLLECTIONS[collection]), V10_RECORD_HEADERS);
  });
}

function initializeHeaders_(sheet, headers) {
  const current = sheet.getLastRow() > 0
    ? sheet.getRange(1, 1, 1, Math.max(headers.length, sheet.getLastColumn())).getValues()[0]
    : [];
  const valid = headers.every(function (header, index) { return String(current[index] || '') === header; });
  if (!valid) {
    if (sheet.getLastRow() > 0 && current.some(function (value) { return value !== ''; })) {
      throw new Error('A aba ' + sheet.getName() + ' já existe com cabeçalhos incompatíveis.');
    }
    sheet.clearContents();
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }
}

function migrateLegacyStateV10_(spreadsheet) {
  if (String(getMetaValue_('MIGRATION_V10_DONE') || '') === 'true') return;
  const databaseSheet = getOrCreateSheet_(spreadsheet, DB_SHEET);
  initializeSheet_(databaseSheet);
  const json = readJson_(databaseSheet);
  let state = json ? JSON.parse(json) : {};
  state.tasks = Array.isArray(state.tasks) ? state.tasks : [];
  state.collaborators = Array.isArray(state.collaborators) ? state.collaborators : [];
  state.processes = Array.isArray(state.processes) ? state.processes : [];
  state.audits = Array.isArray(state.audits) ? state.audits : [];
  state.activity = Array.isArray(state.activity) ? state.activity : [];
  state.securityLog = Array.isArray(state.securityLog) ? state.securityLog : [];
  state.feedbacks = Array.isArray(state.feedbacks) ? state.feedbacks : [];
  state.messages = Array.isArray(state.messages) ? state.messages : [];
  state.notifications = Array.isArray(state.notifications) ? state.notifications : [];
  state.errors = Array.isArray(state.errors) ? state.errors : [];

  createV10Backup_(spreadsheet, state, Number(state._databaseVersion || 0), 'system', 'Backup anterior à migração v10');

  Object.keys(V10_COLLECTIONS).forEach(function (collection) {
    const records = Array.isArray(state[collection]) ? state[collection] : [];
    records.forEach(function (record) {
      if (!record || typeof record !== 'object') return;
      const recordId = String(record.id || Utilities.getUuid());
      const existing = getRecordMeta_(spreadsheet, collection, recordId);
      if (existing) return;
      const version = Math.max(1, Number(record._recordVersion || 1));
      const data = cloneObject_(record);
      data.id = recordId;
      data._collection = collection;
      data._recordVersion = version;
      data._serverUpdatedAt = String(data._serverUpdatedAt || data.atualizadoEm || data.criadoEm || new Date().toISOString());
      data._updatedBy = String(data._updatedBy || data.criadoPor || data.userId || 'migration');
      data._lastOperationId = String(data._lastOperationId || 'migration-v10');
      upsertRecord_(spreadsheet, collection, recordId, version, Boolean(record.excluido), data._serverUpdatedAt, data._updatedBy, data._lastOperationId, data);
    });
  });

  const databaseVersion = Math.max(1, Number(state._databaseVersion || 0));
  state.version = 12;
  state._databaseVersion = databaseVersion;
  state._serverUpdatedAt = new Date().toISOString();
  writeLegacyStateV10_(spreadsheet, state);
  setMetaValue_('DATABASE_VERSION', String(databaseVersion));
  setMetaValue_('MIGRATION_V10_DONE', 'true');
  setMetaValue_('V10_ACTIVE', 'true');
}

function buildAuthoritativeState_(spreadsheet, baseState) {
  let state = baseState ? cloneObject_(baseState) : {};
  if (!baseState) {
    const json = readJson_(getOrCreateSheet_(spreadsheet, DB_SHEET));
    state = json ? JSON.parse(json) : {};
  }
  Object.keys(V10_COLLECTIONS).forEach(function (collection) {
    state[collection] = readCollectionRecords_(spreadsheet, collection, false);
  });
  state.version = 12;
  state._databaseVersion = getDatabaseVersion_();
  return state;
}

function applyChangeToState_(state, collection, recordId, data, deleted) {
  if (!Array.isArray(state[collection])) state[collection] = [];
  const index = state[collection].findIndex(function (item) { return item && String(item.id) === String(recordId); });
  if (deleted) {
    if (index >= 0) state[collection].splice(index, 1);
    return;
  }
  if (index >= 0) state[collection][index] = cloneObject_(data);
  else state[collection].push(cloneObject_(data));
}

function readCollectionRecords_(spreadsheet, collection, includeDeleted) {
  const sheet = getOrCreateSheet_(spreadsheet, V10_COLLECTIONS[collection]);
  initializeHeaders_(sheet, V10_RECORD_HEADERS);
  if (sheet.getLastRow() < 2) return [];
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, V10_RECORD_HEADERS.length).getValues();
  const output = [];
  rows.forEach(function (row, offset) {
    if (String(row[2] || '') !== collection || (!includeDeleted && Boolean(row[4]))) return;
    try {
      const data = JSON.parse(String(row[8] || '{}'));
      data.id = String(row[1] || data.id || '');
      data._collection = collection;
      data._recordVersion = Number(row[3] || 0);
      data._serverUpdatedAt = valueToIso_(row[5]);
      data._updatedBy = String(row[6] || '');
      data._lastOperationId = String(row[7] || '');
      output.push(data);
    } catch (error) {
      try { console.error('CORRUPT_RECORD', collection, String(row[1] || ''), 'linha', offset + 2, safeErrorMessage_(error)); } catch (ignored) {}
      try { if (typeof taskDiagnosticV128_ === 'function') taskDiagnosticV128_({level:'ERROR',origin:'server',module:'database',step:'CORRUPT_RECORD_SKIPPED',entityId:String(row[1]||''),errorCode:'CORRUPT_RECORD',message:safeErrorMessage_(error),context:{collection:collection,row:offset+2}}); } catch (ignoredDiag) {}
    }
  });
  return output;
}

function v1210CacheKey_(prefix, value) {
  return String(prefix || 'SGO') + '_' + String(value || '').replace(/[^A-Za-z0-9:_-]/g, '_').slice(0, 180);
}

function v1210GetCachedRow_(prefix, value) {
  try { return Math.max(0, Number(CacheService.getScriptCache().get(v1210CacheKey_(prefix, value)) || 0)); }
  catch (ignored) { return 0; }
}

function v1210SetCachedRow_(prefix, value, row) {
  try {
    if (Number(row || 0) >= 2) CacheService.getScriptCache().put(v1210CacheKey_(prefix, value), String(row), 21600);
  } catch (ignored) {}
}

function getRecordMeta_(spreadsheet, collection, recordId) {
  const sheetName = V10_COLLECTIONS[collection];
  if (!sheetName) return null;
  const sheet = getOrCreateSheet_(spreadsheet, sheetName);
  initializeHeaders_(sheet, V10_RECORD_HEADERS);
  if (sheet.getLastRow() < 2) return null;
  const internalId = collection + ':' + recordId;
  const rowCacheKey = collection + ':' + recordId;
  let rowNumber = v1210GetCachedRow_('SGO_RECORD_ROW', rowCacheKey);
  let row = null;

  if (rowNumber >= 2 && rowNumber <= sheet.getLastRow()) {
    const candidate = sheet.getRange(rowNumber, 1, 1, V10_RECORD_HEADERS.length).getValues()[0];
    if (String(candidate[0] || '') === internalId) row = candidate;
    else rowNumber = 0;
  }
  if (!row) {
    const finder = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).createTextFinder(internalId).matchEntireCell(true).findNext();
    if (!finder) return null;
    rowNumber = finder.getRow();
    row = sheet.getRange(rowNumber, 1, 1, V10_RECORD_HEADERS.length).getValues()[0];
    v1210SetCachedRow_('SGO_RECORD_ROW', rowCacheKey, rowNumber);
  }

  let data;
  try { data = JSON.parse(String(row[8] || '{}')); }
  catch (error) { throw new Error('CORRUPT_RECORD: ' + collection + ':' + recordId + ' possui JSON inválido e foi bloqueado para evitar sobrescrita.'); }
  data.id = String(row[1] || recordId);
  data._collection = collection;
  data._recordVersion = Number(row[3] || 0);
  return {
    row: rowNumber,
    version: Number(row[3] || 0),
    deleted: Boolean(row[4]),
    updatedAt: valueToIso_(row[5]),
    updatedBy: String(row[6] || ''),
    operationId: String(row[7] || ''),
    data: data
  };
}

function upsertRecord_(spreadsheet, collection, recordId, version, deleted, updatedAt, userId, operationId, data) {
  const sheet = getOrCreateSheet_(spreadsheet, V10_COLLECTIONS[collection]);
  initializeHeaders_(sheet, V10_RECORD_HEADERS);
  const internalId = collection + ':' + recordId;
  const rowCacheKey = collection + ':' + recordId;
  let rowNumber = v1210GetCachedRow_('SGO_RECORD_ROW', rowCacheKey);

  if (rowNumber >= 2 && rowNumber <= sheet.getLastRow()) {
    const currentInternalId = String(sheet.getRange(rowNumber, 1).getValue() || '');
    if (currentInternalId !== internalId) rowNumber = 0;
  }
  if (!rowNumber) {
    const existing = sheet.getLastRow() > 1
      ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).createTextFinder(internalId).matchEntireCell(true).findNext()
      : null;
    rowNumber = existing ? existing.getRow() : sheet.getLastRow() + 1;
  }

  sheet.getRange(rowNumber, 1, 1, V10_RECORD_HEADERS.length).setValues([[
    internalId,
    recordId,
    collection,
    version,
    deleted,
    updatedAt,
    userId,
    operationId,
    JSON.stringify(data || {})
  ]]);
  v1210SetCachedRow_('SGO_RECORD_ROW', rowCacheKey, rowNumber);

  // Sessões podem reutilizar o colaborador em cache por alguns segundos.
  // Qualquer alteração de colaborador invalida imediatamente esse snapshot.
  if (collection === 'collaborators') {
    try { CacheService.getScriptCache().remove(v1210CacheKey_('SGO_USER_RECORD', recordId)); } catch (ignored) {}
  }
}

function writeLegacyStateV10_(spreadsheet, state) {
  const databaseSheet = getOrCreateSheet_(spreadsheet, DB_SHEET);
  const backupSheet = getOrCreateSheet_(spreadsheet, BACKUP_SHEET);
  initializeSheet_(databaseSheet);
  initializeSheet_(backupSheet);
  const currentJson = readJson_(databaseSheet);
  if (currentJson) writeJson_(backupSheet, currentJson);
  writeJson_(databaseSheet, JSON.stringify(state));
}

function maintainBackupsV1215_(spreadsheet, maxBackups) {
  const sheet=getOrCreateSheet_(spreadsheet || getSpreadsheet_(),V10_BACKUPS_SHEET);
  initializeHeaders_(sheet,V10_BACKUP_HEADERS);
  if(sheet.getLastRow()<2)return {compacted:false,count:0};
  const rows=sheet.getRange(2,1,sheet.getLastRow()-1,V10_BACKUP_HEADERS.length).getValues();
  const meta={};
  rows.forEach(function(row){
    const id=String(row[0]||''); if(!id)return;
    const at=new Date(row[4]||0).getTime();
    if(!meta[id]||at>meta[id])meta[id]=Number.isFinite(at)?at:0;
  });
  const ids=Object.keys(meta).sort(function(a,b){return meta[b]-meta[a];});
  const keepIds={};
  ids.slice(0,Math.max(5,Number(maxBackups||20))).forEach(function(id){keepIds[id]=true;});
  if(ids.length<=Object.keys(keepIds).length)return {compacted:false,count:ids.length};
  const kept=rows.filter(function(row){return keepIds[String(row[0]||'')];});
  sheet.getRange(2,1,sheet.getLastRow()-1,V10_BACKUP_HEADERS.length).clearContent();
  if(kept.length)sheet.getRange(2,1,kept.length,V10_BACKUP_HEADERS.length).setValues(kept);
  return {compacted:true,before:ids.length,after:Object.keys(keepIds).length};
}

function createV10Backup_(spreadsheet, state, databaseVersion, userId, reason) {
  const sheet = getOrCreateSheet_(spreadsheet, V10_BACKUPS_SHEET);
  initializeHeaders_(sheet, V10_BACKUP_HEADERS);
  const backupId = Utilities.getUuid();
  const json = JSON.stringify(state || {});
  const chunks = [];
  for (let position = 0; position < json.length; position += CHUNK_SIZE) {
    chunks.push(json.slice(position, position + CHUNK_SIZE));
  }
  const createdAt = new Date().toISOString();
  const rows = (chunks.length ? chunks : ['{}']).map(function (chunk, index) {
    return [backupId, index + 1, chunk, Number(databaseVersion || 0), createdAt, String(userId || ''), String(reason || '')];
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, V10_BACKUP_HEADERS.length).setValues(rows);
  try { maintainBackupsV1215_(spreadsheet,20); } catch (ignoredRetention) {}
  return backupId;
}

function readV10BackupState_(spreadsheet, backupId) {
  const sheet = getOrCreateSheet_(spreadsheet, V10_BACKUPS_SHEET);
  initializeHeaders_(sheet, V10_BACKUP_HEADERS);
  if (sheet.getLastRow() < 2) return null;
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, V10_BACKUP_HEADERS.length).getValues()
    .filter(function (row) { return String(row[0] || '') === backupId; })
    .sort(function (a, b) { return Number(a[1]) - Number(b[1]); });
  if (!rows.length) return null;
  return JSON.parse(rows.map(function (row) { return String(row[2] || ''); }).join(''));
}

const V1217_HOT_META_PREFIX = 'SGO_HOT_META_V1217_';
const V1217_HOT_META_KEYS = {
  CHANGE_SEQUENCE:true, DATABASE_VERSION:true, LAST_OPERATION_ID:true,
  LAST_WRITE_AT:true, LAST_WRITE_USER:true, LAST_WRITE_MODULE:true, APP_VERSION:true
};

function hotMetaPropertyKeyV1217_(key) {
  return V1217_HOT_META_PREFIX + String(key || '');
}

function getHotMetaValueV1217_(key) {
  key = String(key || '');
  if (!V1217_HOT_META_KEYS[key]) return null;
  try {
    const value = PropertiesService.getScriptProperties().getProperty(hotMetaPropertyKeyV1217_(key));
    return value === null ? null : String(value);
  } catch (ignored) { return null; }
}

function setHotMetaValuesV1217_(values) {
  values = values && typeof values === 'object' ? values : {};
  const props = {};
  const cache = CacheService.getScriptCache();
  Object.keys(values).forEach(function(key) {
    const stringKey = String(key || '');
    if (!V1217_HOT_META_KEYS[stringKey]) return;
    const stringValue = String(values[key]);
    props[hotMetaPropertyKeyV1217_(stringKey)] = stringValue;
    try { cache.put(v1210CacheKey_('SGO_META_VALUE', stringKey), stringValue || '__SGO_EMPTY__', 21600); } catch (ignored) {}
  });
  if (Object.keys(props).length) {
    const store = PropertiesService.getScriptProperties();
    if (typeof store.setProperties === 'function') store.setProperties(props, false);
    else Object.keys(props).forEach(function(propKey){ store.setProperty(propKey, props[propKey]); });
  }
}

function getMetaValueFromSheetV1217_(key) {
  key = String(key || '');
  const cache = CacheService.getScriptCache();
  const cacheKey = v1210CacheKey_('SGO_META_VALUE', key);
  const spreadsheet = getSpreadsheet_();
  const sheet = getOrCreateSheet_(spreadsheet, V10_META_SHEET);
  initializeHeaders_(sheet, V10_META_HEADERS);
  if (sheet.getLastRow() < 2) return '';
  let rowNumber = v1210GetCachedRow_('SGO_META_ROW', key);
  let value = '';
  if (rowNumber >= 2 && rowNumber <= sheet.getLastRow() && String(sheet.getRange(rowNumber, 1).getValue() || '') === key) {
    value = String(sheet.getRange(rowNumber, 2).getValue() || '');
  } else {
    const found = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).createTextFinder(key).matchEntireCell(true).findNext();
    if (found) {
      rowNumber = found.getRow();
      value = String(sheet.getRange(rowNumber, 2).getValue() || '');
      v1210SetCachedRow_('SGO_META_ROW', key, rowNumber);
    }
  }
  try { cache.put(cacheKey, value || '__SGO_EMPTY__', 21600); } catch (ignored) {}
  return value;
}

function getMetaValue_(key) {
  key = String(key || '');
  const hot = getHotMetaValueV1217_(key);
  if (hot !== null) return hot;
  const cache = CacheService.getScriptCache();
  const cacheKey = v1210CacheKey_('SGO_META_VALUE', key);
  try {
    const cached = cache.get(cacheKey);
    if (cached !== null) return cached === '__SGO_EMPTY__' ? '' : String(cached);
  } catch (ignored) {}

  const value = getMetaValueFromSheetV1217_(key);
  // Primeira leitura depois da implantação inicializa a fonte quente durável.
  if (V1217_HOT_META_KEYS[key]) setHotMetaValuesV1217_((function(){ const o={}; o[key]=value; return o; })());
  return value;
}

function writeMetaValuesToSheetV1217_(values) {
  values = values && typeof values === 'object' ? values : {};
  const keys = Object.keys(values);
  if (!keys.length) return;
  const spreadsheet = getSpreadsheet_();
  const sheet = getOrCreateSheet_(spreadsheet, V10_META_SHEET);
  initializeHeaders_(sheet, V10_META_HEADERS);
  const lastRow = sheet.getLastRow();
  const rows = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, V10_META_HEADERS.length).getValues() : [];
  const indexByKey = {};
  rows.forEach(function(row, index) { indexByKey[String(row[0] || '')] = index; });
  const now = new Date().toISOString();
  keys.forEach(function(key) {
    const stringKey = String(key);
    const stringValue = String(values[key]);
    if (Object.prototype.hasOwnProperty.call(indexByKey, stringKey)) rows[indexByKey[stringKey]] = [stringKey, stringValue, now];
    else { indexByKey[stringKey] = rows.length; rows.push([stringKey, stringValue, now]); }
  });
  if (rows.length) sheet.getRange(2, 1, rows.length, V10_META_HEADERS.length).setValues(rows);
  const cache = CacheService.getScriptCache();
  keys.forEach(function(key) {
    const rowNumber = 2 + indexByKey[String(key)];
    v1210SetCachedRow_('SGO_META_ROW', key, rowNumber);
    try { cache.put(v1210CacheKey_('SGO_META_VALUE', key), String(values[key]) || '__SGO_EMPTY__', 21600); } catch (ignored) {}
  });
}

function setMetaValue_(key, value) {
  key = String(key || '');
  value = String(value);
  if (V1217_HOT_META_KEYS[key]) setHotMetaValuesV1217_((function(){ const o={}; o[key]=value; return o; })());
  writeMetaValuesToSheetV1217_((function(){ const o={}; o[key]=value; return o; })());
}

function setMetaValuesV1210_(values) {
  values = values && typeof values === 'object' ? values : {};
  setHotMetaValuesV1217_(values);
  writeMetaValuesToSheetV1217_(values);
}

/** Espelha os metadados quentes para SGO_META fora do caminho crítico. */
function flushHotMetaV1217_() {
  const props = PropertiesService.getScriptProperties();
  const values = {};
  Object.keys(V1217_HOT_META_KEYS).forEach(function(key) {
    const value = props.getProperty(hotMetaPropertyKeyV1217_(key));
    if (value !== null) values[key] = value;
  });
  if (Object.keys(values).length) writeMetaValuesToSheetV1217_(values);
  return { success:true, keys:Object.keys(values).length };
}

function getDatabaseVersion_() {
  return Math.max(0, Number(getMetaValue_('DATABASE_VERSION') || 0));
}

function isV10Active_() {
  return String(getMetaValue_('V10_ACTIVE') || '') === 'true';
}

function isIdempotentOperation_(spreadsheet, changes, operationId) {
  if (!operationId) return false;
  if (String(getMetaValue_('LAST_OPERATION_ID') || '') === String(operationId)) return true;
  if (!changes.length) return false;
  return changes.every(function (change) {
    const meta = getRecordMeta_(spreadsheet, String(change.collection || ''), String(change.id || ''));
    return meta && meta.operationId === operationId;
  });
}

function findActiveUser_(state, userId) {
  return (Array.isArray(state.collaborators) ? state.collaborators : []).find(function (user) {
    return user && String(user.id) === String(userId) && user.ativo !== false;
  }) || null;
}

function canWriteRecordV10_(state, user, collection, currentRecord, nextRecord, deleted) {
  if (!user) return false;
  if (user.perfil === 'admin') return true;
  const role = String(user.perfil || 'colaborador');
  if (collection === 'collaborators') {
    if (role !== 'diretoria' && role !== 'auditoria') return false;
    const currentRole = String(currentRecord && currentRecord.perfil || '');
    const nextRole = String(nextRecord && nextRecord.perfil || 'colaborador');
    // Perfil de acesso é campo administrativo: diretoria/auditoria podem manter
    // cadastro operacional, mas não criar/escalar/rebaixar privilégios.
    if (!currentRecord && nextRole !== 'colaborador') return false;
    if (currentRecord && currentRole !== nextRole) return false;
    if (currentRole === 'admin' || nextRole === 'admin') return false;
    return true;
  }
  if (collection === 'processes') {
    return role === 'diretoria' || role === 'auditoria';
  }
  if (collection === 'audits') {
    return role === 'diretoria' || role === 'auditoria';
  }
  if (collection === 'errors') return role === 'diretoria' || role === 'auditoria';
  if (collection === 'notifications') {
    const target = nextRecord || currentRecord || {};
    return String(target.userId || target.destinatarioId || '') === String(user.id) || role === 'diretoria' || role === 'auditoria';
  }
  if (collection === 'feedbacks') {
    const target = nextRecord || currentRecord || {};
    if (role === 'diretoria' || role === 'auditoria') return true;
    if (!currentRecord) return String(target.autorId || '') === String(user.id);
    const involved = String(currentRecord.autorId || '') === String(user.id) || String(currentRecord.destinatarioId || '') === String(user.id);
    if (!involved) return false;
    const allowedFields = { read: true, readAt: true, status: true, updatedAt: true, _recordVersion: true, _serverUpdatedAt: true, _updatedBy: true, _lastOperationId: true, _collection: true };
    const keys = {};
    Object.keys(currentRecord || {}).forEach(function (key) { keys[key] = true; });
    Object.keys(target || {}).forEach(function (key) { keys[key] = true; });
    return Object.keys(keys).every(function (key) {
      return allowedFields[key] || JSON.stringify(currentRecord[key] === undefined ? null : currentRecord[key]) === JSON.stringify(target[key] === undefined ? null : target[key]);
    });
  }
  if (collection === 'messages') {
    const target = nextRecord || currentRecord || {};
    if (role === 'diretoria' || role === 'auditoria') return true;
    if (currentRecord) {
      if (String(target.authorId || '') !== String(currentRecord.authorId || '')) return false;
      if (String(currentRecord.authorId || '') === String(user.id)) return true;
      const isRecipient = Array.isArray(currentRecord.recipientIds) && currentRecord.recipientIds.indexOf(user.id) >= 0;
      if (!isRecipient) return false;
      const allowedFields = { readBy: true, readAtBy: true, _recordVersion: true, _serverUpdatedAt: true, _updatedBy: true, _lastOperationId: true, _collection: true };
      const keys = {};
      Object.keys(currentRecord || {}).forEach(function (key) { keys[key] = true; });
      Object.keys(target || {}).forEach(function (key) { keys[key] = true; });
      return Object.keys(keys).every(function (key) {
        return allowedFields[key] || JSON.stringify(currentRecord[key] === undefined ? null : currentRecord[key]) === JSON.stringify(target[key] === undefined ? null : target[key]);
      });
    }
    if (String(target.authorId || '') !== String(user.id)) return false;
    if (target.taskId) {
      const task = (state.tasks || []).find(function (item) { return item && String(item.id) === String(target.taskId); });
      if (!task) return false;
      if (role !== 'gestor' && String(task.responsavelId || '') !== String(user.id) && (!Array.isArray(task.participantes) || task.participantes.indexOf(user.id) < 0)) return false;
    }
    if (target.conversationType === 'area' && String(target.area || '') !== String(user.area || '')) return false;
    return true;
  }
  if (collection === 'activity' || collection === 'securityLog') {
    const target = nextRecord || currentRecord || {};
    return String(target.userId || target.criadoPor || user.id) === String(user.id) || role === 'diretoria' || role === 'auditoria';
  }
  if (collection !== 'tasks') return false;

  if (deleted) return role === 'diretoria' || role === 'auditoria';
  if (!currentRecord) return true;
  if (!userCanSeeTaskV12_(user, currentRecord)) return false;
  if (role === 'diretoria' || role === 'auditoria') return true;
  if (role === 'gestor') return String(currentRecord.area || '') === String(user.area || '')
    || String(currentRecord.responsavelId || '') === String(user.id)
    || (Array.isArray(currentRecord.participantes) && currentRecord.participantes.indexOf(user.id) >= 0);
  return String(currentRecord.responsavelId || '') === String(user.id)
    || (Array.isArray(currentRecord.participantes) && currentRecord.participantes.indexOf(user.id) >= 0);
}

function successResponse_(options) {
  options = options || {};
  return {
    success: true,
    confirmed: true,
    operationId: String(options.operationId || Utilities.getUuid()),
    recordId: options.recordId || '',
    recordVersion: options.recordVersion === undefined ? null : options.recordVersion,
    databaseVersion: Number(options.databaseVersion || 0),
    serverTimestamp: new Date().toISOString(),
    data: options.data || {},
    error: null
  };
}

function conflictResponse_(options) {
  options = options || {};
  return {
    success: false,
    confirmed: false,
    conflict: true,
    errorCode: 'VERSION_CONFLICT',
    message: String(options.message || 'O registro foi alterado por outro usuário.'),
    operationId: String(options.operationId || ''),
    localVersion: Number(options.localVersion || 0),
    serverVersion: Number(options.serverVersion || 0),
    databaseVersion: Number(options.databaseVersion || 0),
    serverData: options.serverData || null,
    serverTimestamp: new Date().toISOString()
  };
}

function errorResponse_(code, message, databaseVersion, operationId) {
  return {
    success: false,
    confirmed: false,
    conflict: false,
    errorCode: String(code || 'SERVER_ERROR'),
    message: String(message || 'Não foi possível concluir a operação.'),
    operationId: String(operationId || ''),
    databaseVersion: Number(databaseVersion || 0),
    serverTimestamp: new Date().toISOString()
  };
}

function cloneObject_(value) {
  return JSON.parse(JSON.stringify(value === undefined ? null : value));
}

function valueToIso_(value) {
  if (!value) return '';
  if (Object.prototype.toString.call(value) === '[object Date]') return value.toISOString();
  return String(value);
}

function safeErrorMessage_(error) {
  const message = error && error.message ? String(error.message) : 'Falha interna no servidor.';
  return message.replace(/(token|senha|password|pin|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[PROTEGIDO]').slice(0, 1000);
}
