'use strict';
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');

class Cell {
  constructor(sheet, row, col) { this.sheet = sheet; this.row = row; this.col = col; }
  getRow() { return this.row; }
  getColumn() { return this.col; }
}

class TextFinder {
  constructor(range, text) { this.range = range; this.text = String(text); this.entire = false; }
  matchEntireCell(value) { this.entire = Boolean(value); return this; }
  _matches(value) {
    const current = String(value === undefined || value === null ? '' : value);
    return this.entire ? current === this.text : current.includes(this.text);
  }
  findAll() {
    const matches = [];
    const values = this.range.getValues();
    for (let r = 0; r < values.length; r += 1) {
      for (let c = 0; c < values[r].length; c += 1) {
        if (this._matches(values[r][c])) matches.push(new Cell(this.range.sheet, this.range.row + r, this.range.col + c));
      }
    }
    return matches;
  }
  findNext() { return this.findAll()[0] || null; }
}

class Range {
  constructor(sheet, row, col, numRows = 1, numCols = 1) {
    this.sheet = sheet; this.row = row; this.col = col; this.numRows = numRows; this.numCols = numCols;
  }
  getValues() {
    const result = [];
    for (let r = 0; r < this.numRows; r += 1) {
      const row = [];
      for (let c = 0; c < this.numCols; c += 1) row.push(this.sheet.get(this.row + r, this.col + c));
      result.push(row);
    }
    return result;
  }
  setValues(values) {
    if (!Array.isArray(values) || values.length !== this.numRows) throw new Error('setValues row count mismatch');
    for (let r = 0; r < this.numRows; r += 1) {
      if (!Array.isArray(values[r]) || values[r].length !== this.numCols) throw new Error('setValues column count mismatch');
      for (let c = 0; c < this.numCols; c += 1) this.sheet.set(this.row + r, this.col + c, values[r][c]);
    }
    return this;
  }
  getValue() { return this.sheet.get(this.row, this.col); }
  setValue(value) { this.sheet.set(this.row, this.col, value); return this; }
  createTextFinder(text) { return new TextFinder(this, text); }
}

class Sheet {
  constructor(name) { this.name = name; this.data = []; this.hidden = false; this.frozenRows = 0; }
  getName() { return this.name; }
  getLastRow() {
    for (let row = this.data.length; row > 0; row -= 1) {
      if ((this.data[row - 1] || []).some((value) => value !== '' && value !== undefined && value !== null)) return row;
    }
    return 0;
  }
  getLastColumn() {
    return this.data.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), 0);
  }
  getRange(row, col, numRows = 1, numCols = 1) { return new Range(this, row, col, numRows, numCols); }
  get(row, col) { return (this.data[row - 1] || [])[col - 1] ?? ''; }
  set(row, col, value) {
    while (this.data.length < row) this.data.push([]);
    while (this.data[row - 1].length < col) this.data[row - 1].push('');
    this.data[row - 1][col - 1] = value;
  }
  appendRow(values) {
    const row = this.getLastRow() + 1;
    this.getRange(row, 1, 1, values.length).setValues([values]);
    return this;
  }
  clearContents() { this.data = []; return this; }
  setFrozenRows(count) { this.frozenRows = count; return this; }
  hideSheet() { this.hidden = true; return this; }
}

class Spreadsheet {
  constructor(id = 'sheet-test', name = 'SGO Test') { this.id = id; this.name = name; this.sheets = {}; }
  getId() { return this.id; }
  getName() { return this.name; }
  getSheetByName(name) { return this.sheets[name] || null; }
  insertSheet(name) {
    if (this.sheets[name]) return this.sheets[name];
    const sheet = new Sheet(name);
    this.sheets[name] = sheet;
    return sheet;
  }
}

const spreadsheet = new Spreadsheet();
const properties = Object.create(null);
const cache = Object.create(null);
let uuidCounter = 0;
const triggers = [];

function scriptProperties() {
  return {
    setProperty(key, value) { properties[key] = String(value); return this; },
    setProperties(values) { Object.keys(values || {}).forEach((key) => { properties[key] = String(values[key]); }); return this; },
    getProperty(key) { return Object.prototype.hasOwnProperty.call(properties, key) ? properties[key] : null; },
    deleteProperty(key) { delete properties[key]; return this; }
  };
}

function scriptCache() {
  return {
    put(key, value) { cache[key] = String(value); },
    get(key) { return Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : null; },
    remove(key) { delete cache[key]; }
  };
}

const context = {
  console, Date, JSON, Math, String, Number, Boolean, Array, Object, RegExp, Error, Set, Map, Promise,
  SpreadsheetApp: {
    getActiveSpreadsheet: () => spreadsheet,
    openById: (id) => { if (String(id) !== spreadsheet.id) throw new Error('Unknown spreadsheet'); return spreadsheet; },
    flush: () => {}
  },
  PropertiesService: { getScriptProperties: scriptProperties },
  CacheService: { getScriptCache: scriptCache },
  LockService: {
    getScriptLock: () => ({ waitLock: () => true, tryLock: () => true, releaseLock: () => {} })
  },
  Utilities: {
    getUuid: () => `uuid_${++uuidCounter}`,
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' },
    computeDigest: (_algorithm, value) => Array.from(crypto.createHash('sha256').update(String(value), 'utf8').digest()),
    base64EncodeWebSafe: (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
    formatDate: (date) => {
      const d = new Date(date);
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd}`;
    }
  },
  Session: { getScriptTimeZone: () => 'America/Bahia' },
  ScriptApp: {
    getProjectTriggers: () => triggers.slice(),
    deleteTrigger: (trigger) => { const index = triggers.indexOf(trigger); if (index >= 0) triggers.splice(index, 1); },
    newTrigger: (handler) => ({
      timeBased() { return this; },
      everyHours() { return this; },
      everyMinutes() { return this; },
      create() { const trigger = { getHandlerFunction: () => handler }; triggers.push(trigger); return trigger; }
    })
  },
  HtmlService: {
    createHtmlOutputFromFile: () => ({ getContent: () => '' }),
    createTemplateFromFile: () => ({ evaluate: () => ({ setTitle() { return this; }, addMetaTag() { return this; } }) })
  }
};

vm.createContext(context);
[
  'Code.gs',
  'V10_Database.gs',
  'V10_Communication.gs',
  'V12_SecuritySync.gs',
  'V12_TaskOperations.gs',
  'V12_TimerDaily.gs',
  'V12_Communication.gs',
  'V12_RpcGateway.gs'
].forEach((file) => vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file }));

function seedLegacy(state) {
  properties.SGO_SPREADSHEET_ID = spreadsheet.id;
  const sheet = context.getOrCreateSheet_(spreadsheet, 'SGO_DB');
  context.initializeSheet_(sheet);
  context.writeJson_(sheet, JSON.stringify(state));
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function assertSuccess(result, label) { assert(result && result.success, `${label}: ${result && result.errorCode} ${result && result.message}`); }
const integrationPins = {};
function login(email, pin) {
  pin = String(pin || integrationPins[email] || '');
  const result = context.authenticateSessionServer({ email, pin, operationId: `login_${email}` });
  assertSuccess(result, `login ${email}`);
  assert(result.data.sessionToken, 'session token missing');
  return result;
}

const future = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
const legacy = {
  version: 10,
  companies: ['GQ', 'OUTRA'],
  settings: { taskSequence: 10 },
  organization: { name: 'Grupo Quintão', environment: 'homologacao' },
  branding: { primaryColor: '#123456' },
  security: { sessionTimeoutMin: 60, maxAttempts: 5, lockoutMinutes: 15, pinHashes: {} },
  collaborators: [
    { id: 'u1', nome: 'Admin', email: 'admin@example.com', perfil: 'admin', area: 'Diretoria', empresa: 'GQ', empresasAcesso: [], ativo: true },
    { id: 'u2', nome: 'Operador', email: 'user@example.com', perfil: 'colaborador', area: 'Financeiro', empresa: 'GQ', empresasAcesso: ['GQ'], ativo: true },
    { id: 'u3', nome: 'Terceiro', email: 'third@example.com', perfil: 'colaborador', area: 'Comercial', empresa: 'OUTRA', empresasAcesso: ['OUTRA'], ativo: true },
    { id: 'u4', nome: 'Diretoria', email: 'director@example.com', perfil: 'diretoria', area: 'Diretoria', empresa: 'GQ', empresasAcesso: [], ativo: true }
  ],
  processes: [],
  tasks: [
    {
      id: 't1', code: 'SGO-000001', titulo: 'Fechar relatório', descricao: 'Teste', tipo: 'Demanda operacional',
      empresa: 'GQ', area: 'Financeiro', processoId: '', solicitanteId: 'u1', responsavelId: 'u2', participantes: ['u1'],
      prazo: future, estimativa: 2, prioridade: 'Normal', risco: 'Baixo', status: 'Em andamento', progresso: 40,
      aguardandoQuem: '', aguardandoDesde: '', motivoEspera: '', evidencia: '', justificativaAtraso: '', tags: [],
      criadoEm: new Date(Date.now() - 86400000).toISOString(), atualizadoEm: new Date().toISOString(), concluidoEm: '',
      approvalStatus: 'not_required', checklist: [{ id: 'c1', texto: 'Conferir dados', feito: true }], historico: [], comentarios: [], links: [],
      timeTracking: { enabled: true, state: 'running', totalMs: 1000, activeStartedAt: new Date(Date.now() - 5000).toISOString(), startedAt: new Date(Date.now() - 5000).toISOString(), completedAt: '', lastChangedAt: '', sessions: [] },
      excluido: false
    }
  ],
  messages: [], feedbacks: [], notifications: [], conversations: [], conversationReads: [], audits: [], activity: [], securityLog: [], errors: []
};

seedLegacy(legacy);

const setup = context.setupSGO();
assert(setup && setup.success, 'setup did not complete v12.15');
assert(String(setup.message || '').includes('v12.18.4'), 'setup version message missing');
((setup.data && setup.data.temporaryPins) || []).forEach((entry) => {
  const person = legacy.collaborators.find((item) => item.id === entry.userId);
  if (person) integrationPins[person.email] = String(entry.pin || '');
});
assert(Object.keys(integrationPins).length === legacy.collaborators.length, 'setup did not return temporary credentials for users missing a PIN');
assert.strictEqual(context.getMetaValue_('SCHEMA_VERSION'), '12');
const triggerInstall = context.installV10Triggers();
assert(triggerInstall && triggerInstall.success, 'trigger installation failed');
assert(triggers.some((trigger) => trigger.getHandlerFunction() === 'generateDeadlineNotificationsV10'), 'deadline trigger missing');
assert(triggers.some((trigger) => trigger.getHandlerFunction() === 'processPendingTaskOperationsV125'), 'server queue contingency trigger missing');
assert.strictEqual(typeof context.finalizeV1215Deployment, 'function', 'legacy v12.15 finalizer compatibility missing');
const deploymentFinalizer = context.finalizeV1218Deployment();
assert(deploymentFinalizer && deploymentFinalizer.success && deploymentFinalizer.confirmed, 'v12.15 deployment finalizer failed');
assert.strictEqual(deploymentFinalizer.readyForPublish, true, 'v12.15 finalizer did not authorize publication in a consistent state');
assert(deploymentFinalizer.dailyAutomation && deploymentFinalizer.dailyAutomation.guaranteed === true, 'v12.15 finalizer did not guarantee daily automation');
assert.deepStrictEqual(Array.from(deploymentFinalizer.timerConflicts || []), [], 'v12.15 finalizer detected unexpected timer conflicts');
assert.strictEqual(deploymentFinalizer.version, '12.18.4', 'v12.18 finalizer reported wrong version');

const publicBoot = context.loadPublicBootstrapServer();
assertSuccess(publicBoot, 'public bootstrap');
assert.deepStrictEqual(Object.keys(publicBoot.data.state.security.pinHashes || {}), [], 'PIN hashes leaked publicly');
assert.strictEqual(publicBoot.data.state.tasks.length, 0, 'private tasks leaked publicly');
assert.strictEqual(publicBoot.data.state.collaborators.length, 0, 'user directory leaked publicly');

const admin = login('admin@example.com');
const user = login('user@example.com');
const third = login('third@example.com');
const director = login('director@example.com');

// v12.18.3 — um PIN legado correto deve continuar autenticando mesmo se a
// migracao para o hash forte falhar. A migracao e manutencao, nao autenticacao.
{
  const legacyForMigration = context.readLegacyStateV12_(spreadsheet);
  legacyForMigration.security.pinHashes.u2 = context.credentialHashV12_('u2:' + integrationPins['user@example.com']);
  context.writeLegacyStateV12_(spreadsheet, legacyForMigration);
  const originalSetCredential = context.setCredentialPinV1215_;
  context.setCredentialPinV1215_ = () => { throw new Error('simulated migration failure'); };
  const migrationSafeLogin = context.authenticateSessionServer({ email:'user@example.com', pin:integrationPins['user@example.com'], operationId:'login_migration_failure' });
  assertSuccess(migrationSafeLogin, 'legacy login must survive credential migration failure');
  context.setCredentialPinV1215_ = originalSetCredential;
}

assert.deepStrictEqual(Object.keys(user.data.state.security.pinHashes || {}), [], 'PIN hashes leaked in authenticated state');
assert(user.data.state.tasks.some((task) => task.id === 't1'), 'assigned task missing from user scope');
assert(!third.data.state.tasks.some((task) => task.id === 't1'), 'task leaked to unrelated user');


const task = clone(user.data.state.tasks.find((item) => item.id === 't1'));

// v12.18.3 — limpar a fila local deve bloquear também uma operação já aceita
// pelo servidor, para que ela não apareça minutos depois como tarefa fantasma.
{
  const abandoned=clone(task);
  abandoned.id='task_discard_v12181'; abandoned.code='SGO-DISCARD-TEST'; abandoned.titulo='Operação que será abandonada';
  abandoned.status='Nova'; abandoned.progresso=0; abandoned._recordVersion=0; abandoned.criadoEm=new Date().toISOString(); abandoned.atualizadoEm=abandoned.criadoEm;
  abandoned.timeTracking={enabled:false,state:'idle',totalMs:0,sessions:[]};
  const accepted=context.acceptTaskOperationServer({sessionToken:user.data.sessionToken,operationId:'op_discard_v12181',taskId:abandoned.id,expectedVersion:0,action:'create',task:abandoned});
  assertSuccess(accepted,'accept abandoned queue operation');
  const discarded=context.sgoRpcGateway({method:'discardPendingClientOperationsServer',payload:{sessionToken:user.data.sessionToken,operationId:'discard_batch_v12181',operationIds:['op_discard_v12181']}});
  assertSuccess(discarded,'register abandoned queue operation');
  assert.strictEqual(discarded.data.registered,1,'discard endpoint did not register operation');
  const processed=context.processTaskOperationQueueServer({sessionToken:user.data.sessionToken,operationId:'op_discard_v12181'});
  assert(!processed.success&&processed.errorCode==='USER_DISCARDED_PENDING_OPERATION','discarded operation was still mutated');
  const status=context.getOperationStatusServer({sessionToken:user.data.sessionToken,operationId:'op_discard_v12181'});
  assertSuccess(status,'read discarded operation status');
  assert.strictEqual(status.data.status,'rejected','discarded server queue row did not become terminal');
  assert.strictEqual(context.getRecordMeta_(spreadsheet,'tasks',abandoned.id),null,'discarded CREATE still materialized a task');

  const batchTask=clone(abandoned); batchTask.id='task_batch_gateway_v12181'; batchTask.code='SGO-BATCH-GATEWAY'; batchTask.titulo='Teste gateway do lote';
  const batchAccepted=context.sgoRpcGateway({method:'acceptTaskOperationBatchServer',payload:{sessionToken:user.data.sessionToken,operationId:'batch_gateway_v12181',operations:[{operationId:'op_batch_gateway_v12181',taskId:batchTask.id,expectedVersion:0,action:'create',task:batchTask}]}});
  assertSuccess(batchAccepted,'timer batch gateway routing');
  assert(batchAccepted.data&&Array.isArray(batchAccepted.data.operations)&&batchAccepted.data.operations.length===1,'batch gateway did not return accepted operation');
  context.sgoRpcGateway({method:'discardPendingClientOperationsServer',payload:{sessionToken:user.data.sessionToken,operationId:'discard_batch_gateway_v12181',operationIds:['op_batch_gateway_v12181']}});

  // Head-of-line: mais de dez operações bloqueadas não podem esconder uma
  // operação independente que esteja logo atrás delas na fila.
  for(let i=0;i<12;i+=1){
    const blockedTask=clone(abandoned); blockedTask.id=`task_blocked_${i}`; blockedTask.code=`SGO-BLOCK-${i}`; blockedTask.titulo=`Bloqueada ${i}`;
    context.writeServerQueueRowV125_(spreadsheet,{operationId:`op_blocked_${i}`,userId:'u2',type:'task',action:'create',entityId:blockedTask.id,payload:{operationId:`op_blocked_${i}`,taskId:blockedTask.id,expectedVersion:0,action:'create',task:blockedTask,dependsOnOperationId:'missing_dependency_v12181'},status:'RECEIVED',attempts:0,nextAttemptAt:''});
  }
  const independent=clone(abandoned); independent.id='task_independent_v12181'; independent.code='SGO-INDEPENDENT'; independent.titulo='Independente após bloqueadas';
  context.writeServerQueueRowV125_(spreadsheet,{operationId:'op_independent_v12181',userId:'u2',type:'task',action:'create',entityId:independent.id,payload:{operationId:'op_independent_v12181',taskId:independent.id,expectedVersion:0,action:'create',task:independent,dependsOnOperationId:''},status:'RECEIVED',attempts:0,nextAttemptAt:''});
  const worker=context.processPendingTaskOperationsV1215_();
  assert(worker.blockedDependencies>=12,'worker did not identify blocked dependency rows');
  assert(context.getRecordMeta_(spreadsheet,'tasks',independent.id),'independent operation behind blocked rows was starved');
}

// v12.15 — testes comportamentais de segurança, não apenas inspeção estática.
const deniedApproval = context.approveTaskOperationServer({ sessionToken:user.data.sessionToken, operationId:'sec_approve_denied', taskId:'t1', expectedVersion:Number(task._recordVersion || 1), task:clone(task), approved:true });
assert(!deniedApproval.success && deniedApproval.errorCode === 'APPROVAL_PERMISSION', 'responsável sem papel de aprovador conseguiu aprovar diretamente');
const deniedAudit = context.auditTaskServer({ sessionToken:user.data.sessionToken, operationId:'sec_audit_denied', taskId:'t1', expectedVersion:Number(task._recordVersion || 1), task:clone(task) });
assert(!deniedAudit.success && deniedAudit.errorCode === 'AUDIT_PERMISSION', 'colaborador conseguiu auditar tarefa diretamente');
const approvalTamperTask = clone(task); approvalTamperTask.approvalStatus = 'approved'; approvalTamperTask.approvedBy = 'u2'; approvalTamperTask.approvedAt = new Date().toISOString();
const approvalTamper = context.updateTaskServer({ sessionToken:user.data.sessionToken, operationId:'sec_approval_tamper', taskId:'t1', expectedVersion:Number(task._recordVersion || 1), task:approvalTamperTask });
assert(!approvalTamper.success && approvalTamper.errorCode === 'SERVER_OWNED_FIELD', 'update genérico alterou campos controlados de aprovação');

const hiddenTaskSeed = {
  id:'hidden_security_task', code:'SGO-SEC-HIDDEN', titulo:'Tarefa restrita', descricao:'Teste de autorização pelo estado atual', tipo:'Demanda operacional',
  empresa:'GQ', area:'Comercial', processoId:'', solicitanteId:'u1', responsavelId:'u3', participantes:[], prazo:future, estimativa:1,
  prioridade:'Normal', risco:'Baixo', status:'Nova', progresso:0, aguardandoQuem:'', aguardandoDesde:'', motivoEspera:'', evidencia:'', justificativaAtraso:'', tags:[],
  criadoEm:new Date().toISOString(), atualizadoEm:new Date().toISOString(), concluidoEm:'', approvalStatus:'not_required', checklist:[], historico:[], comentarios:[], links:[], excluido:false
};
const hiddenCreated = context.createTaskServer({ sessionToken:admin.data.sessionToken, operationId:'sec_hidden_create', taskId:hiddenTaskSeed.id, expectedVersion:0, task:hiddenTaskSeed });
assertSuccess(hiddenCreated, 'create hidden security task');
const selfAssigned = clone(hiddenCreated.data.task); selfAssigned.responsavelId = 'u2'; selfAssigned.participantes = ['u2'];
const selfAssignAttempt = context.updateTaskServer({ sessionToken:user.data.sessionToken, operationId:'sec_self_assign', taskId:hiddenTaskSeed.id, expectedVersion:hiddenCreated.recordVersion, task:selfAssigned });
assert(!selfAssignAttempt.success && selfAssignAttempt.errorCode === 'PERMISSION_DENIED', 'estado proposto pelo cliente concedeu permissão sobre tarefa invisível');

const u2Meta = context.getRecordMeta_(spreadsheet, 'collaborators', 'u2');
const elevatedU2 = clone(u2Meta.data); elevatedU2.perfil = 'diretoria';
const elevationAttempt = context.commitStateChangesServer({
  sessionToken:director.data.sessionToken, operationId:'sec_role_elevation', module:'collaborators', systemPatch:{},
  changes:[{collection:'collaborators', id:'u2', expectedVersion:u2Meta.version, deleted:false, data:elevatedU2}]
});
assert(!elevationAttempt.success && elevationAttempt.errorCode === 'PERMISSION_DENIED', 'diretoria conseguiu escalar perfil de outro colaborador');

const forcedArea = context.createConversationServer({ sessionToken:user.data.sessionToken, operationId:'sec_area_scope', type:'area', area:'Comercial' });
assertSuccess(forcedArea, 'create own area conversation');
assert.strictEqual(forcedArea.data.conversation.area, 'Financeiro', 'colaborador conseguiu criar conversa para outra área pelo payload');

const chatTaskSeed = {
  id:'task_chat_security', code:'SGO-SEC-CHAT', titulo:'Tarefa com chat revogável', descricao:'Teste de revogação', tipo:'Demanda operacional',
  empresa:'GQ', area:'Financeiro', processoId:'', solicitanteId:'u1', responsavelId:'u2', participantes:[], prazo:future, estimativa:1,
  prioridade:'Normal', risco:'Baixo', status:'Nova', progresso:0, aguardandoQuem:'', aguardandoDesde:'', motivoEspera:'', evidencia:'', justificativaAtraso:'', tags:[],
  criadoEm:new Date().toISOString(), atualizadoEm:new Date().toISOString(), concluidoEm:'', approvalStatus:'not_required', checklist:[], historico:[], comentarios:[], links:[], excluido:false
};
const chatTaskCreated = context.createTaskServer({ sessionToken:admin.data.sessionToken, operationId:'sec_chat_task_create', taskId:chatTaskSeed.id, expectedVersion:0, task:chatTaskSeed });
assertSuccess(chatTaskCreated, 'create task-chat security task');
const taskConversation = context.createConversationServer({ sessionToken:user.data.sessionToken, operationId:'sec_task_conversation', type:'task', taskId:chatTaskSeed.id });
assertSuccess(taskConversation, 'create task conversation while visible');
const taskChatMessage = context.sendMessageServer({ sessionToken:user.data.sessionToken, operationId:'sec_task_message', conversationId:taskConversation.data.conversation.id, text:'Mensagem antes da revogação.' });
assertSuccess(taskChatMessage, 'send task message before access revocation');
const chatTaskReassigned = clone(chatTaskCreated.data.task); chatTaskReassigned.responsavelId = 'u3'; chatTaskReassigned.participantes = [];
const chatTaskRevoked = context.updateTaskServer({ sessionToken:admin.data.sessionToken, operationId:'sec_chat_task_reassign', taskId:chatTaskSeed.id, expectedVersion:chatTaskCreated.recordVersion, task:chatTaskReassigned });
assertSuccess(chatTaskRevoked, 'reassign task to revoke former owner access');
const revokedRead = context.getConversationMessagesServer({ sessionToken:user.data.sessionToken, conversationId:taskConversation.data.conversation.id, limit:20 });
assert(!revokedRead.success && revokedRead.errorCode === 'PERMISSION_DENIED', 'former task participant kept reading task chat after losing task access');
const revokedSend = context.sendMessageServer({ sessionToken:user.data.sessionToken, operationId:'sec_revoked_send', conversationId:taskConversation.data.conversation.id, text:'Não deveria enviar.' });
assert(!revokedSend.success && revokedSend.errorCode === 'PERMISSION_DENIED', 'former task participant kept sending to task chat after losing task access');

// v12.5: a tarefa entra primeiro na fila durável do servidor e só depois é processada.
const queuedTask = {
  id:'queued_task_1', code:'SGO-QUEUE-1', titulo:'Operação recebida pelo servidor', descricao:'Teste da fila transacional', tipo:'Demanda operacional',
  empresa:'GQ', area:'Financeiro', processoId:'', solicitanteId:'u2', responsavelId:'u2', participantes:[], prazo:future,
  estimativa:1, prioridade:'Normal', risco:'Baixo', status:'Nova', progresso:0, aguardandoQuem:'', aguardandoDesde:'', motivoEspera:'',
  evidencia:'', justificativaAtraso:'', tags:[], criadoEm:new Date().toISOString(), atualizadoEm:new Date().toISOString(), concluidoEm:'',
  approvalStatus:'not_required', checklist:[], historico:[], comentarios:[], links:[], excluido:false,
  timeTracking:{enabled:true,state:'paused',totalMs:0,activeStartedAt:'',startedAt:'',completedAt:'',lastChangedAt:'',sessions:[]}
};
const acceptedQueue = context.acceptTaskOperationServer({ sessionToken:user.data.sessionToken, operationId:'op_server_queue_create', taskId:queuedTask.id, expectedVersion:0, action:'create', task:queuedTask });
assertSuccess(acceptedQueue, 'accept server task queue');
assert.strictEqual(acceptedQueue.data.status, 'received', 'server queue did not acknowledge receipt');
assert(!context.getRecordMeta_(spreadsheet,'tasks',queuedTask.id), 'acceptance should not mutate task immediately');
const processedQueue = context.processTaskOperationQueueServer({ sessionToken:user.data.sessionToken, operationId:'op_server_queue_create' });
assertSuccess(processedQueue, 'process server task queue');
assert(context.getRecordMeta_(spreadsheet,'tasks',queuedTask.id), 'processed server queue did not persist task');
const acceptedAgain = context.acceptTaskOperationServer({ sessionToken:user.data.sessionToken, operationId:'op_server_queue_create', taskId:queuedTask.id, expectedVersion:0, action:'create', task:queuedTask });
assertSuccess(acceptedAgain, 'idempotent accept server task queue');
assert.strictEqual(acceptedAgain.data.status, 'completed', 'completed queue operation was not recognized');
// v12.18: CREATE antiga com outro operationId deve ser reconhecida como a mesma taskId.
const staleCreateDifferentOp = context.createTaskServer({ sessionToken:user.data.sessionToken, operationId:'op_stale_create_different_id', taskId:queuedTask.id, expectedVersion:0, task:queuedTask });
assertSuccess(staleCreateDifferentOp, 'semantic idempotency for stale CREATE');
assert(staleCreateDifferentOp.data && staleCreateDifferentOp.data.semanticNoop === true, 'stale CREATE was not confirmed as semantic no-op');
assert.strictEqual(staleCreateDifferentOp.data.semanticReason, 'TASK_ALREADY_MATERIALIZED', 'stale CREATE reported wrong semantic reason');

const queuedTaskBg = clone(queuedTask);
queuedTaskBg.id='queued_task_bg'; queuedTaskBg.code='SGO-QUEUE-BG'; queuedTaskBg.titulo='Processamento por contingência';
const acceptedBg = context.acceptTaskOperationServer({ sessionToken:user.data.sessionToken, operationId:'op_server_queue_bg', taskId:queuedTaskBg.id, expectedVersion:0, action:'create', task:queuedTaskBg });
assertSuccess(acceptedBg, 'accept background queue task');
const bgProcess = context.processPendingTaskOperationsV125();
assert(bgProcess.processed >= 1, 'background queue processor did not claim pending operation');
assert(context.getRecordMeta_(spreadsheet,'tasks',queuedTaskBg.id), 'background queue processor did not persist task');

// v12.17: uma falha de atividade/notificação depois do core NÃO pode fazer a tarefa parecer não salva.
const queuedTaskEffects = clone(queuedTask);
queuedTaskEffects.id='queued_task_effects'; queuedTaskEffects.code='SGO-QUEUE-EFFECTS'; queuedTaskEffects.titulo='Core confirmado com efeito temporariamente indisponível';
const acceptedEffects = context.acceptTaskOperationServer({ sessionToken:user.data.sessionToken, operationId:'op_server_queue_effects', taskId:queuedTaskEffects.id, expectedVersion:0, action:'create', task:queuedTaskEffects });
assertSuccess(acceptedEffects, 'accept side-effect recovery task');
const originalBuildTaskActivity = context.buildTaskActivityV12_;
context.buildTaskActivityV12_ = function(){ throw new Error('FORCED_SIDE_EFFECT_FAILURE'); };
const processedEffects = context.processTaskOperationQueueServer({ sessionToken:user.data.sessionToken, operationId:'op_server_queue_effects' });
assertSuccess(processedEffects, 'core should remain confirmed when side effect fails');
assert(processedEffects.data && processedEffects.data.sideEffectsPending === true, 'side effect failure was not reported as pending recovery');
assert(context.getRecordMeta_(spreadsheet,'tasks',queuedTaskEffects.id), 'task core was not persisted before side-effect failure');
const effectsStatus = context.getOperationStatusServer({ sessionToken:user.data.sessionToken, operationId:'op_server_queue_effects' });
assertSuccess(effectsStatus, 'status lookup for effects-pending operation');
assert.strictEqual(effectsStatus.data.status, 'completed', 'client-facing status must be completed after task core persistence');
let effectsRow = context.getServerQueueRowV125_(spreadsheet,'op_server_queue_effects');
assert.strictEqual(effectsRow.status, 'EFFECTS_PENDING', 'server queue must retain effects-pending recovery state');
context.buildTaskActivityV12_ = originalBuildTaskActivity;
effectsRow.nextAttemptAt = new Date(Date.now()-1000).toISOString();
context.writeServerQueueRowV125_(spreadsheet,effectsRow);
const recoveredEffects = context.processTaskOperationQueueServer({ sessionToken:user.data.sessionToken, operationId:'op_server_queue_effects' });
assertSuccess(recoveredEffects, 'recover side effects after core confirmation');
effectsRow = context.getServerQueueRowV125_(spreadsheet,'op_server_queue_effects');
assert.strictEqual(effectsRow.status, 'COMPLETED', 'side-effect recovery did not finalize server queue');
assert.strictEqual(context.readCollectionRecords_(spreadsheet,'activity',false).filter((entry)=>entry.operationId==='op_server_queue_effects').length,1,'side-effect recovery duplicated activity');
const unsafeLinkTask = clone(task);
unsafeLinkTask.links = [{ id: 'unsafe', titulo: 'Inválido', url: 'javascript:alert(1)' }];
const unsafeLink = context.updateTaskServer({ sessionToken: user.data.sessionToken, operationId: 'op_unsafe_link', taskId: 't1', expectedVersion: Number(task._recordVersion || 1), task: unsafeLinkTask });
assert(!unsafeLink.success && unsafeLink.errorCode === 'INVALID_EVIDENCE_LINK', 'unsafe evidence URL was accepted');
task.evidencia = 'Relatório validado e anexado.';
const completePayload = {
  sessionToken: user.data.sessionToken,
  operationId: 'op_complete_t1',
  taskId: 't1',
  expectedVersion: Number(task._recordVersion || 1),
  task
};
const completed = context.completeTaskServer(completePayload);
assertSuccess(completed, 'complete task');
assert.strictEqual(completed.data.task.status, 'Concluída');
assert.strictEqual(completed.data.task.progresso, 100);
assert.strictEqual(completed.data.task.timeTracking.state, 'completed');
assert.strictEqual(completed.data.task.timeTracking.activeStartedAt, '');
assert(completed.data.task.timeTracking.sessions.length >= 1, 'active timer session was not closed');
assert(completed.data.changedRecords.some((record) => record.collection === 'activity'), 'task activity missing');
assert(completed.data.changedRecords.some((record) => record.collection === 'notifications'), 'task notification missing');

const duplicateCompletion = context.completeTaskServer(completePayload);
assertSuccess(duplicateCompletion, 'idempotent completion');
assert.strictEqual(duplicateCompletion.operationId, completed.operationId);
// v12.18: um segundo COMPLETE com operationId diferente também é no-op.
const semanticDuplicateCompletion = context.completeTaskServer({
  sessionToken:user.data.sessionToken, operationId:'op_complete_t1_second_operation', taskId:'t1',
  expectedVersion:Number(task._recordVersion || 1), task:clone(task)
});
assertSuccess(semanticDuplicateCompletion, 'semantic duplicate completion with distinct operationId');
assert(semanticDuplicateCompletion.data && semanticDuplicateCompletion.data.semanticNoop === true, 'second COMPLETE operation was not swallowed semantically');
assert.strictEqual(semanticDuplicateCompletion.data.semanticReason, 'TASK_ALREADY_COMPLETED', 'second COMPLETE reported wrong semantic reason');
assert.strictEqual(context.readCollectionRecords_(spreadsheet, 'activity', false).filter((entry) => entry.operationId === 'op_complete_t1').length, 1, 'activity duplicated');

// Tarefa rápida cronometrada: não possui prazo nem estimativa por desenho do produto.
const quickTimedTask = {
  id: 'timer_quick_1', code: 'SGO-QUICK-1', titulo: 'Atividade rápida', descricao: 'Cronometrar atendimento', tipo: 'Tarefa cronometrada',
  empresa: 'GQ', area: 'Financeiro', processoId: '', solicitante: 'Operador', responsavelId: 'u2', participantes: [],
  prazo: '', estimativa: 0, prioridade: 'Normal', risco: 'Baixo', status: 'Em andamento', progresso: 25,
  aguardandoQuem: '', aguardandoDesde: '', motivoEspera: '', evidencia: '', justificativaAtraso: '', tags: ['cronometrada'],
  criadoEm: new Date().toISOString(), atualizadoEm: new Date().toISOString(), concluidoEm: '', approvalStatus: 'not_required',
  checklist: [], historico: [], comentarios: [], links: [], excluido: false,
  timeTracking: { enabled:true, state:'running', totalMs:0, activeStartedAt:new Date(Date.now()-1000).toISOString(), startedAt:new Date(Date.now()-1000).toISOString(), completedAt:'', lastChangedAt:'', sessions:[] }
};
const quickStarted = context.startTaskServer({ sessionToken:user.data.sessionToken, operationId:'op_quick_start', taskId:quickTimedTask.id, expectedVersion:0, task:quickTimedTask });
assertSuccess(quickStarted, 'start quick timed task without planning fields');
assert.strictEqual(quickStarted.data.task.status, 'Em andamento');
const quickForPause = clone(quickStarted.data.task);
const quickPaused = context.pauseTaskServer({ sessionToken:user.data.sessionToken, operationId:'op_quick_pause', taskId:quickTimedTask.id, expectedVersion:quickStarted.recordVersion, task:quickForPause });
assertSuccess(quickPaused, 'pause quick timed task without planning fields');
const quickForComplete = clone(quickPaused.data.task);
quickForComplete.evidencia = 'Execução registrada pelo cronômetro.';
const quickCompleted = context.completeTaskServer({ sessionToken:user.data.sessionToken, operationId:'op_quick_complete', taskId:quickTimedTask.id, expectedVersion:quickPaused.recordVersion, task:quickForComplete });
assertSuccess(quickCompleted, 'complete quick timed task without planning fields');
assert.strictEqual(quickCompleted.data.task.status, 'Concluída');

// Regressão v12.4: editar uma tarefa que JÁ estava concluída e atrasada
// não pode exigir novamente a justificativa de atraso.
const legacyLateCompleted = clone(completed.data.task);
legacyLateCompleted.id = 'late_completed_legacy';
legacyLateCompleted.code = 'SGO-LEGACY-LATE';
legacyLateCompleted.titulo = 'Concluída antiga sem justificativa';
legacyLateCompleted.prazo = new Date(Date.now() - 3 * 86400000).toISOString();
legacyLateCompleted.justificativaAtraso = '';
legacyLateCompleted.status = 'Concluída';
legacyLateCompleted.progresso = 100;
legacyLateCompleted.evidencia = 'Evidência histórica';
legacyLateCompleted._recordVersion = 1;
legacyLateCompleted._lastOperationId = 'seed_late_completed';
legacyLateCompleted._updatedBy = 'u2';
legacyLateCompleted._serverUpdatedAt = new Date().toISOString();
context.upsertRecord_(spreadsheet, 'tasks', legacyLateCompleted.id, 1, false, legacyLateCompleted._serverUpdatedAt, 'u2', 'seed_late_completed', legacyLateCompleted);
const legacyLateEdited = clone(legacyLateCompleted);
legacyLateEdited.titulo = 'Concluída antiga editada sem nova justificativa';
const legacyLateUpdate = context.updateTaskServer({ sessionToken:user.data.sessionToken, operationId:'op_late_completed_update', taskId:legacyLateCompleted.id, expectedVersion:1, task:legacyLateEdited });
assertSuccess(legacyLateUpdate, 'update already completed overdue task without delay reason');

// A mesma regra não pode liberar uma NOVA conclusão em atraso sem justificativa.
const reopenedLate = clone(legacyLateUpdate.data.task);
reopenedLate.status = 'Em andamento';
reopenedLate.progresso = 80;
reopenedLate.concluidoEm = '';
if (reopenedLate.timeTracking) { reopenedLate.timeTracking.state = 'paused'; reopenedLate.timeTracking.completedAt = ''; }
const reopenedLateResult = context.updateTaskServer({ sessionToken:user.data.sessionToken, operationId:'op_late_reopen', taskId:legacyLateCompleted.id, expectedVersion:legacyLateUpdate.recordVersion, task:reopenedLate });
assertSuccess(reopenedLateResult, 'reopen late completed task');
const lateCompleteWithoutReason = clone(reopenedLateResult.data.task);
lateCompleteWithoutReason.evidencia = 'Nova evidência';
lateCompleteWithoutReason.justificativaAtraso = '';
const lateCompleteRejected = context.completeTaskServer({ sessionToken:user.data.sessionToken, operationId:'op_late_complete_no_reason', taskId:legacyLateCompleted.id, expectedVersion:reopenedLateResult.recordVersion, task:lateCompleteWithoutReason });
assert(!lateCompleteRejected.success && lateCompleteRejected.errorCode === 'DELAY_REASON_REQUIRED', 'late completion without delay reason should be rejected');

const staleTask = clone(completed.data.task);
staleTask.titulo = 'Alteração obsoleta';
const stale = context.updateTaskServer({ sessionToken: user.data.sessionToken, operationId: 'op_stale', taskId: 't1', expectedVersion: 1, task: staleTask });
assert(!stale.success && stale.conflict, 'stale task version was not rejected');

// Simula interrupção depois da gravação da tarefa e antes dos efeitos secundários.
const taskMetaBeforeRecovery = context.getRecordMeta_(spreadsheet, 'tasks', 't1');
const partialTask = clone(taskMetaBeforeRecovery.data);
partialTask.descricao = 'Alteração parcial recuperada';
partialTask._recordVersion = taskMetaBeforeRecovery.version + 1;
partialTask._lastOperationId = 'op_task_partial';
partialTask._updatedBy = 'u2';
partialTask._serverUpdatedAt = new Date().toISOString();
partialTask._databaseVersionAtWrite = context.getDatabaseVersion_() + 1;
context.setOperationV12_(spreadsheet, 'op_task_partial', 'task:update', 'u2', 't1', 'PROCESSING', null, '');
context.upsertRecord_(spreadsheet, 'tasks', 't1', partialTask._recordVersion, false, partialTask._serverUpdatedAt, 'u2', 'op_task_partial', partialTask);
const recoveredTaskOperation = context.updateTaskServer({ sessionToken: user.data.sessionToken, operationId: 'op_task_partial', taskId: 't1', expectedVersion: taskMetaBeforeRecovery.version, task: partialTask });
assertSuccess(recoveredTaskOperation, 'partial task recovery');
assert(recoveredTaskOperation.data.recovered, 'partial task operation was not marked recovered');
assert.strictEqual(context.readCollectionRecords_(spreadsheet, 'activity', false).filter((entry) => entry.operationId === 'op_task_partial').length, 1, 'partial task effects were not recovered exactly once');
assert(context.findChangeSequenceV12_(spreadsheet, 'tasks', 't1', 'op_task_partial') > 0, 'partial task recovery did not restore the task changelog');

const directConversation = context.createConversationServer({
  sessionToken: admin.data.sessionToken,
  operationId: 'op_direct_conversation',
  type: 'direct',
  participantIds: ['u2']
});
assertSuccess(directConversation, 'create direct conversation');
const sequenceBeforeMessage = context.getChangeSequenceV12_();
const sent = context.sendMessageServer({
  sessionToken: admin.data.sessionToken,
  operationId: 'op_message_private',
  conversationId: directConversation.data.conversation.id,
  text: 'Mensagem privada para o operador.'
});
assertSuccess(sent, 'send private message');
assert(sent.data.message && sent.data.conversation, 'message response incomplete');

// Simula interrupção depois da mensagem ser gravada, mas antes do changelog, índice e conversa.
const partialMessageOperation = 'op_message_partial';
const partialMessageId = context.deterministicIdV12_('message', partialMessageOperation, directConversation.data.conversation.id);
const partialMessageNow = new Date().toISOString();
const partialMessage = {
  id: partialMessageId,
  conversationId: directConversation.data.conversation.id,
  conversationType: 'direct', taskId: '', area: '', authorId: 'u1', recipientIds: ['u2'],
  texto: 'Mensagem recuperada após interrupção.', createdAt: partialMessageNow, replyToId: '', readBy: ['u1'],
  editedAt: '', deleted: false, deliveryStatus: 'sent', _collection: 'messages', _recordVersion: 1,
  _updatedBy: 'u1', _serverUpdatedAt: partialMessageNow, _lastOperationId: partialMessageOperation,
  _databaseVersionAtWrite: context.getDatabaseVersion_() + 1
};
context.setOperationV12_(spreadsheet, partialMessageOperation, 'message:send', 'u1', partialMessageId, 'PROCESSING', null, '');
context.upsertRecord_(spreadsheet, 'messages', partialMessageId, 1, false, partialMessageNow, 'u1', partialMessageOperation, partialMessage);
const recoveredMessage = context.sendMessageServer({ sessionToken: admin.data.sessionToken, operationId: partialMessageOperation, conversationId: directConversation.data.conversation.id, text: partialMessage.texto, messageId: partialMessageId });
assertSuccess(recoveredMessage, 'partial message recovery');
assert(recoveredMessage.data.recovered, 'partial message operation was not marked recovered');
assert(Number(recoveredMessage.data.message._messageSequence) > 0, 'recovered message did not receive a sequence');
assert(context.messageIdsForConversationV12_(spreadsheet, directConversation.data.conversation.id).some((item) => item.id === partialMessageId), 'recovered message was not indexed');

const userChanges = context.getChangesSinceServer({ sessionToken: user.data.sessionToken, sequence: sequenceBeforeMessage, limit: 100 });
assertSuccess(userChanges, 'user incremental sync');
assert(userChanges.data.changes.some((change) => change.collection === 'messages' && change.id === sent.data.message.id), 'recipient did not receive private message');

const thirdChanges = context.getChangesSinceServer({ sessionToken: third.data.sessionToken, sequence: sequenceBeforeMessage, limit: 100 });
assertSuccess(thirdChanges, 'third incremental sync');
assert(!thirdChanges.data.changes.some((change) => change.collection === 'messages' && change.id === sent.data.message.id), 'private message leaked to third user');
assert(!thirdChanges.data.changes.some((change) => change.collection === 'conversations' && change.id === sent.data.conversation.id), 'private conversation leaked to third user');

// Simula criação de grupo interrompida antes de registrar changelog e conclusão.
const partialConversationNow = new Date().toISOString();
const partialConversation = {
  id: 'group:partial', type: 'group', name: 'Grupo recuperado', participantIds: ['u1','u2'], adminIds: ['u1'],
  area: '', areaKey: '', taskId: '', createdBy: 'u1', createdAt: partialConversationNow, updatedAt: partialConversationNow,
  active: true, _collection: 'conversations', _recordVersion: 1, _updatedBy: 'u1', _serverUpdatedAt: partialConversationNow,
  _lastOperationId: 'op_group_partial', _databaseVersionAtWrite: context.getDatabaseVersion_() + 1
};
context.setOperationV12_(spreadsheet, 'op_group_partial', 'conversation:create', 'u1', partialConversation.id, 'PROCESSING', null, '');
context.upsertRecord_(spreadsheet, 'conversations', partialConversation.id, 1, false, partialConversationNow, 'u1', 'op_group_partial', partialConversation);
const recoveredConversation = context.createConversationServer({ sessionToken: admin.data.sessionToken, operationId: 'op_group_partial', type: 'group', conversationId: partialConversation.id, name: partialConversation.name, participantIds: ['u2'] });
assertSuccess(recoveredConversation, 'partial conversation recovery');
assert(recoveredConversation.data.recovered, 'partial conversation operation was not marked recovered');
assert(context.findChangeSequenceV12_(spreadsheet, 'conversations', partialConversation.id, 'op_group_partial') > 0, 'recovered conversation did not enter changelog');

const group = context.createConversationServer({
  sessionToken: admin.data.sessionToken,
  operationId: 'op_group',
  type: 'group',
  name: 'Financeiro e Diretoria',
  participantIds: ['u2']
});
assertSuccess(group, 'create custom group');
assert.deepStrictEqual(Array.from(group.data.conversation.participantIds).sort(), ['u1', 'u2']);
const groupDuplicate = context.createConversationServer({
  sessionToken: admin.data.sessionToken,
  operationId: 'op_group',
  type: 'group', name: 'Financeiro e Diretoria', participantIds: ['u2']
});
assertSuccess(groupDuplicate, 'idempotent group creation');
assert.strictEqual(groupDuplicate.data.conversation.id, group.data.conversation.id);

for (let index = 0; index < 5; index += 1) {
  const message = context.sendMessageServer({
    sessionToken: admin.data.sessionToken,
    operationId: `op_group_message_${index}`,
    conversationId: group.data.conversation.id,
    text: `Mensagem ${index + 1}`
  });
  assertSuccess(message, `group message ${index}`);
}
const page = context.getConversationMessagesServer({ sessionToken: user.data.sessionToken, conversationId: group.data.conversation.id, limit: 2 });
assertSuccess(page, 'conversation pagination');
assert.strictEqual(page.data.messages.length, 2);
assert(page.data.hasMore, 'pagination did not report older messages');
const older = context.getConversationMessagesServer({ sessionToken: user.data.sessionToken, conversationId: group.data.conversation.id, beforeSequence: page.data.oldestSequence, limit: 2 });
assertSuccess(older, 'older conversation page');
assert.strictEqual(older.data.messages.length, 2);

const latestMessage = page.data.messages[page.data.messages.length - 1];
const readResult = context.markConversationReadServer({
  sessionToken: user.data.sessionToken,
  operationId: 'op_mark_read',
  conversationId: group.data.conversation.id,
  lastReadMessageId: latestMessage.id,
  lastReadSequence: latestMessage._messageSequence
});
assertSuccess(readResult, 'mark conversation read');
const readDuplicate = context.markConversationReadServer({ sessionToken: user.data.sessionToken, operationId: 'op_mark_read', conversationId: group.data.conversation.id, lastReadMessageId: latestMessage.id, lastReadSequence: latestMessage._messageSequence });
assertSuccess(readDuplicate, 'idempotent mark read');
assert.strictEqual(readDuplicate.recordVersion, readResult.recordVersion, 'read cursor version was duplicated');
const commBootstrap = context.loadCommunicationBootstrapServer({ sessionToken: user.data.sessionToken });
assertSuccess(commBootstrap, 'communication bootstrap');
assert(commBootstrap.data.conversations.some((conversation) => conversation.id === group.data.conversation.id), 'existing group missing from bootstrap');
assert(commBootstrap.data.conversationReads.some((read) => read.conversationId === group.data.conversation.id && read.userId === 'u2'), 'read cursor not restored');

const deniedSettings = context.commitStateChangesServer({
  sessionToken: user.data.sessionToken,
  operationId: 'op_settings_denied',
  module: 'system', changes: [], systemPatch: { settings: { x: 1 } }
});
assert(!deniedSettings.success && deniedSettings.errorCode === 'PERMISSION_DENIED', 'non-admin changed global settings');

const adminSettings = context.commitStateChangesServer({
  sessionToken: admin.data.sessionToken,
  operationId: 'op_settings_admin',
  module: 'system', changes: [],
  systemPatch: { settings: { x: 2 }, security: { sessionTimeoutMin: 90, pinHashes: { u2: 'tamper' } } }
});
assertSuccess(adminSettings, 'admin settings patch');
context.logoutSessionServer({ sessionToken: user.data.sessionToken });
const relogin = login('user@example.com');
assert(relogin.data.sessionToken, 'PIN hash was lost after settings patch');

const backup = context.createManualBackupV10('Teste v12', 'u1', { sessionToken: admin.data.sessionToken });
assertSuccess(backup, 'manual backup');
const restored = context.restoreRecordFromBackupV10('tasks', 't1', backup.data.backupId, 'u1', 'Teste de restauração', { sessionToken: admin.data.sessionToken, operationId: 'op_restore' });
assertSuccess(restored, 'record restore');
assert(restored.data.changedRecords.some((record) => record.collection === 'securityLog'), 'restore security log missing');

const status = context.getOperationStatusServer({ sessionToken: admin.data.sessionToken, operationId: 'op_restore' });
assertSuccess(status, 'operation status');
assert.strictEqual(status.data.status, 'completed');

const fullRestore = context.restoreServerBackup({ sessionToken: admin.data.sessionToken, operationId: 'op_full_restore' });
assertSuccess(fullRestore, 'automatic full restore');
assert(fullRestore.data.safetyBackupId, 'pre-restore safety backup missing');
const restoredTask = context.readCollectionRecords_(spreadsheet, 'tasks', false).find((item) => item.id === 't1');
assert(restoredTask && restoredTask.status === 'Em andamento', 'automatic backup did not restore the original task');
assert.strictEqual(context.readCollectionRecords_(spreadsheet, 'messages', false).length, 0, 'automatic backup did not remove later messages');


const invalidSession = context.getChangesSinceServer({ sessionToken: 'invalid', sequence: 0 });
assert(!invalidSession.success && invalidSession.errorCode === 'SESSION_INVALID', 'invalid session accepted');

// v12.18: uma cadeia rápida do cronômetro entra na fila com uma única aceitação em lote.
const batchTaskId='timer_batch_task';
const batchCreatedAt=new Date().toISOString();
const batchTask={
  id:batchTaskId,code:'SGO-BATCH-001',titulo:'Teste lote cronômetro',descricao:'Teste',tipo:'Tarefa cronometrada',
  empresa:'GQ',area:'Financeiro',processoId:'',solicitante:'Operador',responsavelId:'u2',participantes:[],prazo:'',prazoManual:false,prazoAutomatico:false,
  estimativa:1,prioridade:'Normal',risco:'Baixo',status:'Em andamento',progresso:25,aguardandoQuem:'',aguardandoDesde:'',motivoEspera:'',evidencia:'',justificativaAtraso:'',tags:['cronometrada'],
  criadoEm:batchCreatedAt,atualizadoEm:batchCreatedAt,concluidoEm:'',approvalStatus:'not_required',checklist:[],historico:[],comentarios:[],links:[],excluido:false,
  timeTracking:{enabled:true,state:'running',totalMs:0,activeStartedAt:batchCreatedAt,startedAt:batchCreatedAt,completedAt:'',lastChangedAt:batchCreatedAt,sessions:[]}
};
const batchCompleteAt=new Date(Date.now()+1000).toISOString();
const batchAccepted=context.acceptTaskOperationBatchServer({sessionToken:relogin.data.sessionToken,operationId:'batch_test_accept',operations:[
  {operationId:'op_batch_create',taskId:batchTaskId,expectedVersion:0,action:'create',task:batchTask,clientActionAt:batchCreatedAt},
  {operationId:'op_batch_complete',taskId:batchTaskId,expectedVersion:1,action:'complete',dependsOnOperationId:'op_batch_create',task:{id:batchTaskId,status:'Concluída',progresso:100,evidencia:'Cronômetro',prazo:'',prazoManual:false,prazoAutomatico:false,concluidoEm:batchCompleteAt,timeTracking:{enabled:true,state:'completed',completedAt:batchCompleteAt,lastChangedAt:batchCompleteAt}},clientActionAt:batchCompleteAt}
]});
assertSuccess(batchAccepted,'accept timer operation batch');
assert(batchAccepted.data && batchAccepted.data.batch === true && batchAccepted.data.operations.length===2,'timer batch did not accept both operations');
assert.strictEqual(context.getServerQueueRowV125_(spreadsheet,'op_batch_create').status,'RECEIVED','batch CREATE not durable on server');
assert.strictEqual(context.getServerQueueRowV125_(spreadsheet,'op_batch_complete').status,'RECEIVED','batch COMPLETE not durable on server');
const batchWait=context.processTaskOperationQueueServer({sessionToken:relogin.data.sessionToken,operationId:'op_batch_complete'});
assertSuccess(batchWait,'batch dependent waits for create');
assert(batchWait.data && batchWait.data.waitingDependency === true,'batch dependent COMPLETE ran before CREATE');
assertSuccess(context.processTaskOperationQueueServer({sessionToken:relogin.data.sessionToken,operationId:'op_batch_create'}),'process batch CREATE');
assertSuccess(context.processTaskOperationQueueServer({sessionToken:relogin.data.sessionToken,operationId:'op_batch_complete'}),'process batch COMPLETE');
const batchPersisted=context.readCollectionRecords_(spreadsheet,'tasks',false).find((item)=>item.id===batchTaskId);
assert(batchPersisted && batchPersisted.status==='Concluída','batch timer chain did not preserve final state');

// v12.17: operações do cronômetro chegam cedo ao servidor e aguardam dependência durável.
const depTaskId = 'timer_dependency_task';
const depCreatedAt = new Date().toISOString();
const depTask = {
  id:depTaskId, code:'SGO-DEP-001', titulo:'Teste dependência cronômetro', descricao:'Teste', tipo:'Tarefa cronometrada',
  empresa:'GQ', area:'Financeiro', processoId:'', solicitante:'Operador', responsavelId:'u2', participantes:[],
  prazo:'', prazoManual:false, prazoAutomatico:false, estimativa:1, prioridade:'Normal', risco:'Baixo', status:'Em andamento', progresso:25,
  aguardandoQuem:'', aguardandoDesde:'', motivoEspera:'', evidencia:'', justificativaAtraso:'', tags:['cronometrada'],
  criadoEm:depCreatedAt, atualizadoEm:depCreatedAt, concluidoEm:'', approvalStatus:'not_required', checklist:[], historico:[], comentarios:[], links:[], excluido:false,
  timeTracking:{enabled:true,state:'running',totalMs:0,activeStartedAt:depCreatedAt,startedAt:depCreatedAt,completedAt:'',lastChangedAt:depCreatedAt,sessions:[]}
};
const depA = context.acceptTaskOperationServer({sessionToken:relogin.data.sessionToken,operationId:'op_dep_create',taskId:depTaskId,expectedVersion:0,action:'create',task:depTask,clientActionAt:depCreatedAt});
assertSuccess(depA,'accept dependency create');
const depCompleteAt = new Date(Date.now()+2000).toISOString();
const depB = context.acceptTaskOperationServer({sessionToken:relogin.data.sessionToken,operationId:'op_dep_complete',taskId:depTaskId,expectedVersion:1,action:'complete',dependsOnOperationId:'op_dep_create',task:{id:depTaskId,status:'Concluída',progresso:100,evidencia:'Cronômetro',prazo:'',prazoManual:false,prazoAutomatico:false,concluidoEm:depCompleteAt,timeTracking:{enabled:true,state:'completed',completedAt:depCompleteAt,lastChangedAt:depCompleteAt}},clientActionAt:depCompleteAt});
assertSuccess(depB,'accept dependent complete');
const depBefore = context.processTaskOperationQueueServer({sessionToken:relogin.data.sessionToken,operationId:'op_dep_complete'});
assertSuccess(depBefore,'dependency wait response');
assert(depBefore.data && depBefore.data.queued && depBefore.data.waitingDependency === true,'dependent operation executed before predecessor core');
const depCreateProcessed = context.processTaskOperationQueueServer({sessionToken:relogin.data.sessionToken,operationId:'op_dep_create'});
assertSuccess(depCreateProcessed,'process dependency create');
assert(depCreateProcessed.data && depCreateProcessed.data.sideEffectsPending === true,'first queue pass should confirm core and defer effects');
const depCompleteProcessed = context.processTaskOperationQueueServer({sessionToken:relogin.data.sessionToken,operationId:'op_dep_complete'});
assertSuccess(depCompleteProcessed,'process dependent complete after predecessor');
const depPersisted = context.readCollectionRecords_(spreadsheet,'tasks',false).find((item)=>item.id===depTaskId);
assert(depPersisted && depPersisted.status==='Concluída','dependent timer completion was not persisted after predecessor');
// Efeitos ficam em baixa prioridade e podem ser recuperados depois sem refazer o core.
let depCreateRow = context.getServerQueueRowV125_(spreadsheet,'op_dep_create');
assert(depCreateRow && depCreateRow.status==='EFFECTS_PENDING','core confirmation did not leave deferred effects in server queue');
depCreateRow.nextAttemptAt=''; context.writeServerQueueRowV125_(spreadsheet,depCreateRow);
const depEffectsRecovered = context.processTaskOperationQueueServer({sessionToken:relogin.data.sessionToken,operationId:'op_dep_create'});
assertSuccess(depEffectsRecovered,'recover deferred task effects');
assert(!(depEffectsRecovered.data && depEffectsRecovered.data.sideEffectsPending),'deferred effects did not complete on recovery pass');
depCreateRow = context.getServerQueueRowV125_(spreadsheet,'op_dep_create');
assert(depCreateRow && depCreateRow.status==='COMPLETED','server queue did not finalize after deferred effects recovery');

// Dependência permanentemente rejeitada não pode gerar retry infinito nas operações seguintes.
const badPredecessorTask = clone(depTask); badPredecessorTask.id='bad_dep_predecessor'; badPredecessorTask.code='SGO-BAD-DEP'; badPredecessorTask.responsavelId='usuario_inexistente';
assertSuccess(context.acceptTaskOperationServer({sessionToken:relogin.data.sessionToken,operationId:'op_bad_dep',taskId:badPredecessorTask.id,expectedVersion:0,action:'create',task:badPredecessorTask}),'accept invalid predecessor for dependency test');
const badProcessed = context.processTaskOperationQueueServer({sessionToken:relogin.data.sessionToken,operationId:'op_bad_dep'});
assert(!badProcessed.success && badProcessed.errorCode==='INVALID_OWNER','invalid predecessor was not permanently rejected');
const childTask=clone(depTask); childTask.id='child_after_bad_dep'; childTask.code='SGO-CHILD-DEP';
assertSuccess(context.acceptTaskOperationServer({sessionToken:relogin.data.sessionToken,operationId:'op_child_bad_dep',taskId:childTask.id,expectedVersion:0,action:'create',dependsOnOperationId:'op_bad_dep',task:childTask}),'accept dependent child after bad predecessor');
const childFailed=context.processTaskOperationQueueServer({sessionToken:relogin.data.sessionToken,operationId:'op_child_bad_dep'});
assert(!childFailed.success && childFailed.errorCode==='DEPENDENCY_FAILED','dependent child did not stop after permanent predecessor failure');
const childRow=context.getServerQueueRowV125_(spreadsheet,'op_child_bad_dep');
assert(childRow && childRow.status==='REJECTED' && !childRow.nextAttemptAt,'dependent child remained retryable after permanent dependency failure');


// v12.18.3: tarefa cronometrada congelada pode ser abandonada sem depender da fila,
// e operações antigas não conseguem ressuscitá-la depois do descarte.
const frozenId='timer_frozen_v12182';
const frozenAt=new Date().toISOString();
const frozenTask=clone(depTask); frozenTask.id=frozenId; frozenTask.code='SGO-FROZEN-182'; frozenTask.titulo='Cronômetro congelado'; frozenTask.status='Em andamento'; frozenTask.responsavelId='u2'; frozenTask.timeTracking={enabled:true,state:'paused',totalMs:12345000,activeStartedAt:'',startedAt:frozenAt,completedAt:'',lastChangedAt:frozenAt,sessions:[]};
const frozenCreate=context.createTaskServer({sessionToken:relogin.data.sessionToken,operationId:'op_frozen_create_182',taskId:frozenId,expectedVersion:0,action:'create',task:frozenTask});
assertSuccess(frozenCreate,'create frozen timer fixture');
const frozenDiscard=context.sgoRpcGateway({method:'abandonTimedTaskServer',payload:{sessionToken:relogin.data.sessionToken,operationId:'op_frozen_abandon_182',taskId:frozenId,localOperationIds:[]}});
assertSuccess(frozenDiscard,'abandon frozen timer');
assert(frozenDiscard.data && frozenDiscard.data.abandoned===true,'abandon endpoint did not confirm abandonment');
let frozenPersisted=context.readCollectionRecords_(spreadsheet,'tasks',false).find((item)=>item.id===frozenId);
assert(frozenPersisted && frozenPersisted.status==='Cancelada','frozen timer was not cancelled on server');
assert(frozenPersisted.timeTracking && frozenPersisted.timeTracking.state==='completed','frozen timer tracking did not become terminal');
const staleResume=context.resumeTaskServer({sessionToken:relogin.data.sessionToken,operationId:'op_frozen_stale_resume_182',taskId:frozenId,expectedVersion:1,action:'resume',task:{id:frozenId,status:'Em andamento',timeTracking:{enabled:true,state:'running',activeStartedAt:new Date().toISOString()}}});
assertSuccess(staleResume,'stale resume after frozen discard');
assert(staleResume.data && staleResume.data.semanticReason==='TASK_ABANDONED_BY_USER','stale timer action was not neutralized by abandon tombstone');
frozenPersisted=context.readCollectionRecords_(spreadsheet,'tasks',false).find((item)=>item.id===frozenId);
assert(frozenPersisted && frozenPersisted.status==='Cancelada','stale resume resurrected cancelled frozen timer');
const frozenDiscardAgain=context.sgoRpcGateway({method:'abandonTimedTaskServer',payload:{sessionToken:relogin.data.sessionToken,operationId:'op_frozen_abandon_again_182',taskId:frozenId}});
assertSuccess(frozenDiscardAgain,'idempotent second abandon');
assert(frozenDiscardAgain.data && frozenDiscardAgain.data.alreadyCancelled===true,'second abandon was not idempotent');

// Se a tarefa só existia localmente, o tombstone impede que uma CREATE atrasada a materialize.
const localOnlyId='timer_local_only_abandoned_182';
const localOnlyDrop=context.sgoRpcGateway({method:'abandonTimedTaskServer',payload:{sessionToken:relogin.data.sessionToken,operationId:'op_local_only_drop_182',taskId:localOnlyId}});
assertSuccess(localOnlyDrop,'abandon local-only timer');
assert(localOnlyDrop.data && localOnlyDrop.data.alreadyMissing===true,'local-only abandon did not confirm missing server task');
const lateCreateTask=clone(depTask); lateCreateTask.id=localOnlyId; lateCreateTask.code='SGO-LOCAL-DROP'; lateCreateTask.responsavelId='u2';
const lateCreate=context.createTaskServer({sessionToken:relogin.data.sessionToken,operationId:'op_late_create_after_drop_182',taskId:localOnlyId,expectedVersion:0,action:'create',task:lateCreateTask});
assertSuccess(lateCreate,'late create after local-only abandon');
assert(lateCreate.data && lateCreate.data.semanticReason==='TASK_ABANDONED_BY_USER','late create was not blocked by abandon tombstone');
assert(!context.readCollectionRecords_(spreadsheet,'tasks',false).some((item)=>item.id===localOnlyId),'abandoned local-only task was materialized later');

console.log('V12_INTEGRATION_TESTS_OK', JSON.stringify({
  databaseVersion: context.getDatabaseVersion_(),
  changeSequence: context.getChangeSequenceV12_(),
  tasks: context.readCollectionRecords_(spreadsheet, 'tasks', false).length,
  conversations: context.readCollectionRecords_(spreadsheet, 'conversations', false).length,
  messages: context.readCollectionRecords_(spreadsheet, 'messages', false).length
}));
