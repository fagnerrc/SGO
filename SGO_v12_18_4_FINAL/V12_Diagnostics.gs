/**
 * SGO v12.18.4 — diagnóstico técnico centralizado.
 * Objetivo: registrar falhas sem bloquear a operação principal e gerar um pacote
 * técnico exportável para análise. Nunca grava PIN, token de sessão ou payloads completos.
 */
const V128_DIAG_SHEET = 'SGO_LOG_TECNICO';
const V128_DIAG_HEADERS = [
  'LOG_ID','DATA','NIVEL','ORIGEM','MODULO','ETAPA','OPERACAO_ID','USUARIO_ID','ENTIDADE_ID','ACAO',
  'STATUS','ERRO_CODIGO','MENSAGEM','DURACAO_MS','TENTATIVA','DB_VERSION','RECORD_VERSION','ONLINE',
  'APP_VERSION','CONTEXTO_JSON'
];
const V128_DIAG_MAX_ROWS = 5000;
const V128_DIAG_MAX_BATCH = 40;
const V128_DIAG_CONTEXT_MAX = 3500;
const V128_DIAG_CACHE_KEY = 'SGO_DIAG_BUFFER_V128';
const V128_DIAG_CACHE_MAX = 60;

function ensureDiagnosticsV128_(spreadsheet) {
  const sheet = getOrCreateSheet_(spreadsheet || getSpreadsheet_(), V128_DIAG_SHEET);
  initializeHeaders_(sheet, V128_DIAG_HEADERS);
  return sheet;
}

function diagnosticLockV128_() {
  try { return LockService.getDocumentLock() || LockService.getScriptLock(); }
  catch (ignored) { return LockService.getScriptLock(); }
}

function diagnosticTextV128_(value, maxLen) {
  let text = value === null || value === undefined ? '' : String(value);
  const limit = Math.max(20, Number(maxLen || 1000));
  // Remove tokens/chaves que eventualmente tenham vazado em texto técnico.
  text = text
    .replace(/(sessionToken|token|pin|password|senha|secret|authorization)\s*[:=]\s*[^,;\s}]+/gi, '$1=[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]');
  return text.slice(0, limit);
}

function diagnosticContextV128_(value) {
  function scrub(input, depth) {
    if (depth > 4) return '[depth-limit]';
    if (input === null || input === undefined) return input;
    if (typeof input === 'string') return diagnosticTextV128_(input, 800);
    if (typeof input === 'number' || typeof input === 'boolean') return input;
    if (Array.isArray(input)) return input.slice(0, 25).map(function(item) { return scrub(item, depth + 1); });
    if (typeof input === 'object') {
      const output = {};
      Object.keys(input).slice(0, 40).forEach(function(key) {
        if (/token|pin|password|senha|secret|authorization|hash/i.test(key)) {
          output[key] = '[REDACTED]';
          return;
        }
        if (/payload|task|message|content|body|data/i.test(key) && typeof input[key] === 'object') {
          let size = 0;
          try { size = JSON.stringify(input[key]).length; } catch (ignored) {}
          output[key + 'Size'] = size;
          return;
        }
        output[key] = scrub(input[key], depth + 1);
      });
      return output;
    }
    return diagnosticTextV128_(input, 400);
  }
  let json = '{}';
  try { json = JSON.stringify(scrub(value || {}, 0)); }
  catch (ignored) { json = '{"serialization":"failed"}'; }
  return json.slice(0, V128_DIAG_CONTEXT_MAX);
}

function diagnosticRowV128_(entry) {
  entry = entry || {};
  return [
    String(entry.logId || Utilities.getUuid()),
    String(entry.at || new Date().toISOString()),
    diagnosticTextV128_(entry.level || 'INFO', 20).toUpperCase(),
    diagnosticTextV128_(entry.origin || 'server', 30),
    diagnosticTextV128_(entry.module || 'system', 50),
    diagnosticTextV128_(entry.step || '', 80),
    diagnosticTextV128_(entry.operationId || '', 120),
    diagnosticTextV128_(entry.userId || '', 120),
    diagnosticTextV128_(entry.entityId || '', 160),
    diagnosticTextV128_(entry.action || '', 50),
    diagnosticTextV128_(entry.status || '', 50),
    diagnosticTextV128_(entry.errorCode || '', 100),
    diagnosticTextV128_(entry.message || '', 1200),
    Math.max(0, Number(entry.durationMs || 0)),
    Math.max(0, Number(entry.attempt || 0)),
    Math.max(0, Number(entry.databaseVersion || getDatabaseVersion_() || 0)),
    Math.max(0, Number(entry.recordVersion || 0)),
    entry.online === false ? 'false' : entry.online === true ? 'true' : '',
    diagnosticTextV128_(entry.appVersion || 'v12.18.4', 30),
    diagnosticContextV128_(entry.context || {})
  ];
}

function bufferDiagnosticsV128_(entries) {
  entries = Array.isArray(entries) ? entries : [];
  if (!entries.length) return 0;
  try {
    const cache = CacheService.getScriptCache();
    let current = [];
    try { current = JSON.parse(cache.get(V128_DIAG_CACHE_KEY) || '[]'); } catch (ignored) { current = []; }
    if (!Array.isArray(current)) current = [];
    entries.forEach(function(entry) { current.push(entry || {}); });
    current = current.slice(-V128_DIAG_CACHE_MAX);
    cache.put(V128_DIAG_CACHE_KEY, JSON.stringify(current), 21600);
    return entries.length;
  } catch (error) {
    console.warn('SGO_DIAG_CACHE_FAILURE', error);
    return 0;
  }
}

function appendDiagnosticRowsV128_(entries) {
  entries = Array.isArray(entries) ? entries.slice(0, V128_DIAG_MAX_BATCH * 3) : [];
  if (!entries.length) return 0;
  const lock = diagnosticLockV128_();
  let locked = false;
  try {
    locked = lock.tryLock(800);
    if (!locked) return 0;
    const spreadsheet = getSpreadsheet_();
    const sheet = ensureDiagnosticsV128_(spreadsheet);
    const rows = entries.map(diagnosticRowV128_);
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, V128_DIAG_HEADERS.length).setValues(rows);
    const overflow = Math.max(0, sheet.getLastRow() - 1 - V128_DIAG_MAX_ROWS);
    if (overflow > 0) sheet.deleteRows(2, overflow);
    return rows.length;
  } catch (error) {
    console.error('SGO_DIAG_WRITE_FAILURE', error);
    return 0;
  } finally {
    if (locked) try { lock.releaseLock(); } catch (ignored) {}
  }
}

/**
 * Esvazia o buffer técnico para a planilha. Chamado pelo gatilho da fila e
 * imediatamente antes de gerar o pacote de diagnóstico.
 */
function flushDiagnosticsV128_() {
  let entries = [];
  try {
    const cache = CacheService.getScriptCache();
    try { entries = JSON.parse(cache.get(V128_DIAG_CACHE_KEY) || '[]'); } catch (ignored) { entries = []; }
    if (!Array.isArray(entries) || !entries.length) return 0;
    cache.remove(V128_DIAG_CACHE_KEY);
    const written = appendDiagnosticRowsV128_(entries);
    if (written < entries.length) bufferDiagnosticsV128_(entries.slice(written));
    return written;
  } catch (error) {
    bufferDiagnosticsV128_(entries);
    console.error('SGO_DIAG_FLUSH_FAILURE', error);
    return 0;
  }
}

/** Uso interno. Não faz escrita em planilha durante a operação principal. */
function logDiagnosticV128_(entry) {
  try { return bufferDiagnosticsV128_([entry]) > 0; }
  catch (error) { console.error('SGO_DIAG_INTERNAL_FAILURE', error); return false; }
}

/** Recebe lote de eventos técnicos do navegador. */
function appendDiagnosticLogsServer(payload) {
  payload = payload || {};
  let auth;
  try { auth = requireSessionV12_(payload, true); }
  catch (error) { return errorResponse_('SESSION_INVALID', 'Sua sessão expirou.', getDatabaseVersion_(), String(payload.operationId || Utilities.getUuid())); }
  const events = Array.isArray(payload.events) ? payload.events.slice(0, V128_DIAG_MAX_BATCH) : [];
  const normalized = events.map(function(event) {
    event = event || {};
    return {
      logId: event.logId || Utilities.getUuid(), at: event.at || new Date().toISOString(),
      level: event.level || 'INFO', origin: 'client', module: event.module || 'client', step: event.step || '',
      operationId: event.operationId || '', userId: auth.user.id, entityId: event.entityId || '', action: event.action || '',
      status: event.status || '', errorCode: event.errorCode || '', message: event.message || '',
      durationMs: event.durationMs || 0, attempt: event.attempt || 0,
      databaseVersion: event.databaseVersion || getDatabaseVersion_(), recordVersion: event.recordVersion || 0,
      online: event.online, appVersion: event.appVersion || 'v12.18.4', context: event.context || {}
    };
  });
  const written = bufferDiagnosticsV128_(normalized);
  return successResponse_({
    operationId: String(payload.operationId || Utilities.getUuid()),
    databaseVersion: getDatabaseVersion_(),
    data: { received: events.length, written: written }
  });
}

function readRecentDiagnosticsV128_(spreadsheet, limit) {
  const sheet = ensureDiagnosticsV128_(spreadsheet);
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const take = Math.min(Math.max(1, Number(limit || 300)), 1000, last - 1);
  const start = Math.max(2, last - take + 1);
  const values = sheet.getRange(start, 1, take, V128_DIAG_HEADERS.length).getValues();
  return values.map(function(row) {
    let context = {};
    try { context = JSON.parse(String(row[19] || '{}')); } catch (ignored) {}
    return {
      logId:String(row[0]||''), at:valueToIso_(row[1]), level:String(row[2]||''), origin:String(row[3]||''),
      module:String(row[4]||''), step:String(row[5]||''), operationId:String(row[6]||''), userId:String(row[7]||''),
      entityId:String(row[8]||''), action:String(row[9]||''), status:String(row[10]||''), errorCode:String(row[11]||''),
      message:String(row[12]||''), durationMs:Number(row[13]||0), attempt:Number(row[14]||0),
      databaseVersion:Number(row[15]||0), recordVersion:Number(row[16]||0), online:String(row[17]||''),
      appVersion:String(row[18]||''), context:context
    };
  }).reverse();
}

function diagnosticCollectionCountsV128_(spreadsheet) {
  const counts = {};
  Object.keys(V10_COLLECTIONS).forEach(function(collection) {
    const sheet = spreadsheet.getSheetByName(V10_COLLECTIONS[collection]);
    counts[collection] = sheet ? Math.max(0, sheet.getLastRow() - 1) : 0;
  });
  ['SGO_FILA_SERVIDOR','SGO_TAREFA_ARQUIVO',V128_DIAG_SHEET].forEach(function(name) {
    const sheet = spreadsheet.getSheetByName(name);
    counts[name] = sheet ? Math.max(0, sheet.getLastRow() - 1) : 0;
  });
  return counts;
}

function diagnosticQueueSnapshotV128_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName('SGO_FILA_SERVIDOR');
  if (!sheet || sheet.getLastRow() < 2) return { counts:{}, problematic:[] };
  const take = Math.min(300, sheet.getLastRow() - 1);
  const start = Math.max(2, sheet.getLastRow() - take + 1);
  const rows = sheet.getRange(start, 1, take, Math.min(14, sheet.getLastColumn())).getValues();
  const counts = {};
  const problematic = [];
  rows.forEach(function(row) {
    const status = String(row[7] || '');
    counts[status] = Number(counts[status] || 0) + 1;
    if (['COMPLETED'].indexOf(status) < 0 && problematic.length < 80) {
      problematic.push({
        sequence:Number(row[0]||0), operationId:String(row[1]||''), userId:String(row[2]||''), type:String(row[3]||''),
        action:String(row[4]||''), entityId:String(row[5]||''), payloadSize:String(row[6]||'').length,
        status:status, attempts:Number(row[8]||0), nextAttemptAt:valueToIso_(row[9]), createdAt:valueToIso_(row[10]),
        updatedAt:valueToIso_(row[11]), resultSize:String(row[12]||'').length, error:diagnosticTextV128_(row[13]||'',800)
      });
    }
  });
  return { counts:counts, problematic:problematic };
}

function diagnosticLargestTaskCellsV128_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(V10_COLLECTIONS.tasks);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const take = Math.min(1500, sheet.getLastRow() - 1);
  const values = sheet.getRange(Math.max(2, sheet.getLastRow() - take + 1), 2, take, 8).getValues();
  return values.map(function(row) {
    return { id:String(row[0]||''), version:Number(row[2]||0), updatedAt:valueToIso_(row[4]), operationId:String(row[6]||''), jsonSize:String(row[7]||'').length };
  }).sort(function(a,b){ return b.jsonSize-a.jsonSize; }).slice(0,25);
}

function diagnosticRecentErrorsV128_(spreadsheet) {
  const rows = readCollectionRecords_(spreadsheet, 'errors', false) || [];
  return rows.slice().sort(function(a,b){
    return new Date(b && (b.occurredAt || b._serverUpdatedAt) || 0) - new Date(a && (a.occurredAt || a._serverUpdatedAt) || 0);
  }).slice(0,120).map(function(data) {
    data = data || {};
    return {
      id:String(data.id||''), occurredAt:String(data.occurredAt||data._serverUpdatedAt||''), userId:String(data.userId||''),
      module:String(data.module||''), operation:String(data.operation||''), errorCode:String(data.errorCode||''),
      message:diagnosticTextV128_(data.message||'',1200), details:diagnosticTextV128_(data.details||data.stack||'',1800),
      analysisStatus:String(data.analysisStatus||'Novo')
    };
  });
}


function diagnoseV1216TaskSavePerformance() {
  requireAdminOrEditorV12_({});
  const spreadsheet = getSpreadsheet_();
  try { flushDiagnosticsV128_(); } catch (ignored) {}
  const logs = readRecentDiagnosticsV128_(spreadsheet, 900);
  const wanted = {
    TASK_SAVE_CLICK:true,TASK_SAVE_DIFF_READY:true,OUTBOX_ENQUEUED:true,OUTBOX_COALESCED:true,
    OUTBOX_ACCEPT_START:true,OUTBOX_ACCEPT_RESPONSE:true,OUTBOX_PROCESS_START:true,OUTBOX_PROCESS_RESPONSE:true,
    OUTBOX_CONFIRMED:true,QUEUE_ACCEPT_LOCK_BUSY:true,SERVER_QUEUE_ACCEPTED:true,SERVER_QUEUE_CLAIMED:true,
    SERVER_QUEUE_PROCESS_COMPLETE:true,MUTATION_START:true,WRITE_LOCK_BUSY:true,MUTATION_COMPLETED:true,
    CORE_CONFIRMED_EFFECTS_PENDING:true,CORE_CONFIRMED_EFFECTS_DEFERRED:true,TIMER_CREATE_COALESCED:true,TIMER_QUEUE_REPAIRED:true,TIMER_CHAIN_PREACCEPTED:true,DEFERRED_EFFECTS_COMPLETED:true,DEFERRED_EFFECTS_BUILD_FAILED:true,SIDE_EFFECT_EXCEPTION:true,OUTBOX_FAILURE:true
  };
  const filtered = logs.filter(function(log){ return wanted[String(log.step||'')] && String(log.operationId||''); });
  const byOperation = {};
  filtered.forEach(function(log){
    const id = String(log.operationId||'');
    if (!byOperation[id]) byOperation[id] = [];
    byOperation[id].push(log);
  });
  const operations = Object.keys(byOperation).map(function(operationId){
    const timeline = byOperation[operationId].slice().sort(function(a,b){return new Date(a.at||0)-new Date(b.at||0);});
    const first = timeline[0] || {};
    const last = timeline[timeline.length-1] || {};
    return {
      operationId:operationId,
      entityId:String(first.entityId||last.entityId||''),
      action:String(first.action||last.action||''),
      startedAt:String(first.at||''),
      finishedAt:String(last.at||''),
      elapsedMs:Math.max(0,new Date(last.at||0).getTime()-new Date(first.at||0).getTime()),
      steps:timeline.map(function(log){
        return {
          at:String(log.at||''),origin:String(log.origin||''),module:String(log.module||''),step:String(log.step||''),
          status:String(log.status||''),errorCode:String(log.errorCode||''),durationMs:Number(log.durationMs||0),
          attempt:Number(log.attempt||0),context:log.context||{}
        };
      })
    };
  }).sort(function(a,b){return new Date(b.finishedAt||0)-new Date(a.finishedAt||0);}).slice(0,30);

  const stepStats = {};
  filtered.forEach(function(log){
    const step=String(log.step||'');
    if (!stepStats[step]) stepStats[step]={count:0,totalMs:0,maxMs:0};
    const d=Math.max(0,Number(log.durationMs||0));
    stepStats[step].count+=1; stepStats[step].totalMs+=d; stepStats[step].maxMs=Math.max(stepStats[step].maxMs,d);
  });
  Object.keys(stepStats).forEach(function(step){
    const stat=stepStats[step];
    stat.avgMs=stat.count?Math.round(stat.totalMs/stat.count):0;
  });

  return {
    success:true,confirmed:true,version:(typeof SGO_APP_VERSION_V1215!=='undefined'?SGO_APP_VERSION_V1215:'12.18.1'),
    generatedAt:new Date().toISOString(),
    operations:operations,
    stepStats:stepStats,
    queue:diagnosticQueueSnapshotV128_(spreadsheet)
  };
}

/**
 * Gera pacote seguro para suporte. Não inclui PINs, tokens, textos de mensagens,
 * payload completo de tarefas ou conteúdo integral de células.
 */
function getDiagnosticBundleServer(payload) {
  payload = payload || {};
  let auth;
  try { auth = requireSessionV12_(payload, true); }
  catch (error) { return errorResponse_('SESSION_INVALID', 'Sua sessão expirou.', getDatabaseVersion_(), String(payload.operationId || Utilities.getUuid())); }
  if (['admin','diretoria','auditoria'].indexOf(String(auth.user.perfil || '')) < 0) {
    return errorResponse_('PERMISSION_DENIED', 'Seu perfil não pode gerar o diagnóstico técnico.', getDatabaseVersion_(), String(payload.operationId || Utilities.getUuid()));
  }
  const spreadsheet = getSpreadsheet_();
  flushDiagnosticsV128_();
  const logs = readRecentDiagnosticsV128_(spreadsheet, Math.min(700, Number(payload.limit || 500)));
  const queue = diagnosticQueueSnapshotV128_(spreadsheet);
  const triggers = ScriptApp.getProjectTriggers().map(function(trigger) {
    return { functionName:trigger.getHandlerFunction(), eventType:String(trigger.getEventType()), triggerSource:String(trigger.getTriggerSource()) };
  });
  const bundle = {
    schema:'SGO_DIAGNOSTIC_BUNDLE_V12_8', generatedAt:new Date().toISOString(), generatedBy:{ id:auth.user.id, perfil:auth.user.perfil },
    system:{
      databaseVersion:getDatabaseVersion_(), changeSequence:typeof getChangeSequenceV12_ === 'function' ? getChangeSequenceV12_() : 0,
      lastOperationId:String(getMetaValue_('LAST_OPERATION_ID')||''), lastWriteAt:String(getMetaValue_('LAST_WRITE_AT')||''),
      lastWriteUser:String(getMetaValue_('LAST_WRITE_USER')||''), lastWriteModule:String(getMetaValue_('LAST_WRITE_MODULE')||''),
      timezone:Session.getScriptTimeZone(), collectionCounts:diagnosticCollectionCountsV128_(spreadsheet), triggers:triggers
    },
    queue:queue,
    largestTaskCells:diagnosticLargestTaskCellsV128_(spreadsheet),
    recentErrors:diagnosticRecentErrorsV128_(spreadsheet),
    technicalLogs:logs,
    clientSnapshot:diagnosticContextV128_(payload.clientSnapshot || {})
  };
  return successResponse_({
    operationId:String(payload.operationId || Utilities.getUuid()), databaseVersion:getDatabaseVersion_(),
    data:{ bundle:bundle }
  });
}

/** v12.17: alias do diagnóstico de persistência, preservando a análise v12.16. */
function diagnoseV1217PersistencePerformance() { return diagnoseV1216TaskSavePerformance(); }

/** v12.17 — saúde operacional da persistência sem expor payloads. */
function diagnoseV1217PersistenceHealth() {
  requireAdminOrEditorV12_({});
  const spreadsheet = getSpreadsheet_();
  try { flushDiagnosticsV128_(); } catch (ignored) {}
  const sheet = typeof ensureServerQueueV125_ === 'function' ? ensureServerQueueV125_(spreadsheet) : getOrCreateSheet_(spreadsheet, 'SGO_FILA_SERVIDOR');
  const statusCounts = {}, actionCounts = {}, dependencies = { total:0, waiting:0, failed:0, ready:0 };
  const queueScheduler={receivedReady:0,receivedBlocked:0,orphanDependencies:0,processing:0,effectsPending:0,oldestReceivedAgeMs:0,oldestBlockedAgeMs:0,blockedSamples:[]};
  const activeByUser={};
  let active = 0, oldestActiveAt = '', oldestActiveAgeMs = 0;
  if (sheet.getLastRow() >= 2) {
    const width = typeof V125_SERVER_QUEUE_HEADERS !== 'undefined' ? V125_SERVER_QUEUE_HEADERS.length : 14;
    const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues();
    const byOperation = {};
    rows.forEach(function(row){ byOperation[String(row[1] || '')] = String(row[7] || '').toUpperCase(); });
    rows.forEach(function(row){
      const status = String(row[7] || '').toUpperCase() || 'UNKNOWN';
      const action = String(row[4] || '').toLowerCase() || 'unknown';
      statusCounts[status] = Number(statusCounts[status] || 0) + 1;
      actionCounts[action] = Number(actionCounts[action] || 0) + 1;
      if (['RECEIVED','PROCESSING','EFFECTS_PENDING'].indexOf(status) >= 0) {
        active += 1;
        const owner=String(row[2]||'unknown'); activeByUser[owner]=Number(activeByUser[owner]||0)+1;
        if(status==='PROCESSING')queueScheduler.processing+=1;
        if(status==='EFFECTS_PENDING')queueScheduler.effectsPending+=1;
        const at = new Date(row[10] || row[11] || 0).getTime();
        if (Number.isFinite(at) && at > 0) {
          const age = Math.max(0, Date.now() - at);
          if (age > oldestActiveAgeMs) { oldestActiveAgeMs = age; oldestActiveAt = new Date(at).toISOString(); }
        }
      }
      try {
        const payload = JSON.parse(String(row[6] || 'null')) || {};
        const dep = String(payload.dependsOnOperationId || '');
        if (dep) {
          dependencies.total += 1;
          const depStatus = String(byOperation[dep] || '').toUpperCase();
          const dependencyReady=['COMPLETED','EFFECTS_PENDING'].indexOf(depStatus)>=0;
          if (!dependencyReady) dependencies.waiting += 1; else dependencies.ready += 1;
          if (['CONFLICT','REJECTED'].indexOf(depStatus) >= 0 || !depStatus) dependencies.failed += 1;
          if(status==='RECEIVED'){
            const rowAt=new Date(row[10]||row[11]||0).getTime(), age=Number.isFinite(rowAt)?Math.max(0,Date.now()-rowAt):0;
            if(dependencyReady || ['CONFLICT','REJECTED'].indexOf(depStatus)>=0){queueScheduler.receivedReady+=1;queueScheduler.oldestReceivedAgeMs=Math.max(queueScheduler.oldestReceivedAgeMs,age);}
            else {queueScheduler.receivedBlocked+=1;if(!depStatus)queueScheduler.orphanDependencies+=1;queueScheduler.oldestBlockedAgeMs=Math.max(queueScheduler.oldestBlockedAgeMs,age);if(queueScheduler.blockedSamples.length<25)queueScheduler.blockedSamples.push({operationId:String(row[1]||''),userId:String(row[2]||''),action:String(row[4]||''),entityId:String(row[5]||''),dependsOnOperationId:dep,dependencyStatus:depStatus||'MISSING',ageMs:age});}
          }
        }
      } catch (ignoredPayload) {}
    });
  }
  queueScheduler.receivedReady=Math.max(queueScheduler.receivedReady,Number(statusCounts.RECEIVED||0)-queueScheduler.receivedBlocked);
  const clientQueueByUser=Object.keys(activeByUser).map(function(userId){return {userId:userId,active:Number(activeByUser[userId]||0)};}).sort(function(a,b){return b.active-a.active;});
  const hotMeta = {};
  try {
    Object.keys(typeof V1217_HOT_META_KEYS !== 'undefined' ? V1217_HOT_META_KEYS : {}).forEach(function(key){
      hotMeta[key] = getHotMetaValueV1217_(key);
    });
  } catch (ignoredMeta) {}
  return {
    success:true, confirmed:true, version:(typeof SGO_APP_VERSION_V1215 !== 'undefined' ? SGO_APP_VERSION_V1215 : '12.18.1'),
    generatedAt:new Date().toISOString(), queueRows:Math.max(0, sheet.getLastRow()-1), active:active,
    statusCounts:statusCounts, actionCounts:actionCounts, dependencies:dependencies, queueScheduler:queueScheduler, clientQueueByUser:clientQueueByUser,
    oldestActiveAt:oldestActiveAt, oldestActiveAgeMs:oldestActiveAgeMs,
    databaseVersion:getDatabaseVersion_(), changeSequence:typeof getChangeSequenceV12_ === 'function' ? getChangeSequenceV12_() : 0,
    hotMeta:hotMeta
  };
}


/** v12.18 — aliases para a bateria de persistência após a correção anti-duplicidade. */
function diagnoseV1218PersistenceHealth(payload) { return diagnoseV1217PersistenceHealth(payload); }
function diagnoseV1218PersistencePerformance(payload) { return diagnoseV1217PersistencePerformance(payload); }
function diagnoseV12181PersistenceHealth(payload) { return diagnoseV1217PersistenceHealth(payload); }
function diagnoseV12181PersistencePerformance(payload) { return diagnoseV1217PersistencePerformance(payload); }

function diagnoseV12182PersistenceHealth(payload) { return diagnoseV1217PersistenceHealth(payload); }
function diagnoseV12182PersistencePerformance(payload) { return diagnoseV1217PersistencePerformance(payload); }

function diagnoseV12183PersistenceHealth(payload) { return diagnoseV1217PersistenceHealth(payload); }
function diagnoseV12183PersistencePerformance(payload) { return diagnoseV1217PersistencePerformance(payload); }

function diagnoseV12184PersistenceHealth(payload) { return diagnoseV1217PersistenceHealth(payload); }
function diagnoseV12184PersistencePerformance(payload) { return diagnoseV1217PersistencePerformance(payload); }
