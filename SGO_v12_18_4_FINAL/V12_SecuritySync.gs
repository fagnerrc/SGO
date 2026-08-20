/**
 * SGO v12 — sessão no servidor, filtragem de dados e sincronização incremental.
 * Este módulo não envia hashes de PIN ao navegador e não confia em userId informado pelo cliente.
 */
const V12_CHANGELOG_SHEET = 'SGO_CHANGELOG';
const V12_OPERATION_SHEET = 'SGO_OPERACOES';
const V12_CHANGELOG_HEADERS = ['SEQUENCIA','COLECAO','ID_REGISTRO','VERSAO','EXCLUIDO','ATUALIZADO_EM','USUARIO_ID','OPERACAO_ID','DADOS_JSON','VISIBILIDADE_JSON'];
const V12_OPERATION_HEADERS = ['OPERACAO_ID','TIPO','USUARIO_ID','ENTIDADE_ID','STATUS','CRIADO_EM','ATUALIZADO_EM','RESULTADO_JSON','ERRO'];
const V12_SESSION_PREFIX = 'SGO_SESSION_';
const V12_SESSION_TTL_MAX_SEC = 8 * 60 * 60;
const SGO_APP_VERSION_V1215 = '12.18.4';
const V1215_CREDENTIAL_PEPPER_PROP = 'SGO_CREDENTIAL_PEPPER_V2';
const V1215_LOGIN_ATTEMPT_PREFIX = 'SGO_LOGIN_ATTEMPT_';
const V1215_CHANGELOG_ARCHIVE_SHEET = 'SGO_CHANGELOG_ARQUIVO';
const V1215_OPERATION_ARCHIVE_SHEET = 'SGO_OPERACOES_ARQUIVO';
const V12152_LEGACY_CONFIG_CACHE_KEY = 'SGO_LEGACY_CONFIG_V12152';
const V12152_LEGACY_CONFIG_CACHE_TTL = 3600;

function invalidateLegacyConfigCacheV12152_() {
  try { CacheService.getScriptCache().remove(V12152_LEGACY_CONFIG_CACHE_KEY); } catch (ignored) {}
}

function extractLegacyConfigV12152_(legacy) {
  legacy = legacy && typeof legacy === 'object' ? legacy : {};
  return {
    companies: cloneObject_(legacy.companies || []),
    organization: cloneObject_(legacy.organization || {}),
    branding: cloneObject_(legacy.branding || {}),
    settings: cloneObject_(legacy.settings || {}),
    security: cloneObject_(legacy.security || {})
  };
}

function readLegacyConfigV12152_(spreadsheet) {
  const cache = CacheService.getScriptCache();
  try {
    const cached = cache.get(V12152_LEGACY_CONFIG_CACHE_KEY);
    if (cached) return JSON.parse(cached);
  } catch (ignored) {}
  const config = extractLegacyConfigV12152_(readLegacyStateV12_(spreadsheet || getSpreadsheet_()));
  try {
    const raw = JSON.stringify(config);
    if (raw.length < 90000) cache.put(V12152_LEGACY_CONFIG_CACHE_KEY, raw, V12152_LEGACY_CONFIG_CACHE_TTL);
  } catch (ignored) {}
  return config;
}


// Extensões da estrutura v10. Objetos const continuam mutáveis.
V10_COLLECTIONS.conversations = 'SGO_CONVERSAS';
V10_COLLECTIONS.conversationReads = 'SGO_LEITURAS_CONVERSAS';
var V10_TRACKED_COLLECTIONS_SERVER_ = Object.keys(V10_COLLECTIONS);

function setupSGOV12(payload) {
  requireAdminOrEditorV12_(payload || {});
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const spreadsheet = getSpreadsheet_();
    ensureV10Schema_(spreadsheet);
    initializeHeaders_(getOrCreateSheet_(spreadsheet, V12_CHANGELOG_SHEET), V12_CHANGELOG_HEADERS);
    initializeHeaders_(getOrCreateSheet_(spreadsheet, V12_OPERATION_SHEET), V12_OPERATION_HEADERS);
    if (typeof ensureServerQueueV125_ === 'function') ensureServerQueueV125_(spreadsheet);
    const securitySetup = ensureLegacySecurityV12_(spreadsheet);
    ensureCommunicationSchemaV12_(spreadsheet);
    migrateLegacyCommunicationV12_(spreadsheet);
    if (!getMetaValue_('CHANGE_SEQUENCE')) setMetaValue_('CHANGE_SEQUENCE', '0');
    if (!getMetaValue_('SCHEMA_VERSION')) setMetaValue_('SCHEMA_VERSION', '12');
    setMetaValue_('V10_ACTIVE', 'true');
    setMetaValue_('APP_VERSION', SGO_APP_VERSION_V1215);
    SpreadsheetApp.flush();
    return successResponse_({
      operationId: Utilities.getUuid(),
      databaseVersion: getDatabaseVersion_(),
      data: { schemaVersion: 12, changeSequence: getChangeSequenceV12_(), temporaryPins: cloneObject_(securitySetup && securitySetup.temporaryPins || []) }
    });
  } finally {
    lock.releaseLock();
  }
}

function readLegacyStateV12_(spreadsheet) {
  const sheet = getOrCreateSheet_(spreadsheet || getSpreadsheet_(), DB_SHEET);
  initializeSheet_(sheet);
  const json = readJson_(sheet);
  if (!json) return {};
  try { return JSON.parse(json); } catch (error) { throw new Error('A base principal do SGO está inválida. Restaure um backup antes de prosseguir.'); }
}

function writeLegacyStateV12_(spreadsheet, state) {
  const sheet = getOrCreateSheet_(spreadsheet || getSpreadsheet_(), DB_SHEET);
  initializeSheet_(sheet);
  writeJson_(sheet, JSON.stringify(state || {}));
  invalidateLegacyConfigCacheV12152_();
}

function credentialHashV12_(value) {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  String(value || '').split('').forEach(function (char) {
    const code = char.codePointAt(0);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= (code + h1);
    h2 = Math.imul(h2, 0x85ebca6b);
  });
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

function sha256V12_(value) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value || ''), Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/g, '');
}


function credentialPepperV1215_() {
  const props = PropertiesService.getScriptProperties();
  let pepper = String(props.getProperty(V1215_CREDENTIAL_PEPPER_PROP) || '');
  if (!pepper) {
    pepper = Utilities.getUuid() + '.' + Utilities.getUuid() + '.' + Utilities.getUuid();
    props.setProperty(V1215_CREDENTIAL_PEPPER_PROP, pepper);
  }
  return pepper;
}

function credentialHashV1215_(userId, pin) {
  const message = String(userId || '') + ':' + String(pin || '');
  const pepper = credentialPepperV1215_();
  let signature;
  if (typeof Utilities.computeHmacSha256Signature === 'function') signature = Utilities.computeHmacSha256Signature(message, pepper, Utilities.Charset.UTF_8);
  else signature = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, pepper + '|' + message, Utilities.Charset.UTF_8);
  return 'v2:' + Utilities.base64EncodeWebSafe(signature).replace(/=+$/g, '');
}

function credentialMatchesV1215_(storedHash, userId, pin) {
  storedHash = String(storedHash || '');
  if (!storedHash) return false;
  if (storedHash.indexOf('v2:') === 0) {
    // Uma credencial v2 depende do pepper persistente. Nunca gere silenciosamente
    // uma nova chave durante a verificacao: isso tornaria credenciais v2
    // existentes irrecuperaveis apos uma perda de ScriptProperties.
    const pepper = String(PropertiesService.getScriptProperties().getProperty(V1215_CREDENTIAL_PEPPER_PROP) || '');
    if (!pepper) {
      const error = new Error('CREDENTIAL_KEY_MISSING');
      error.code = 'CREDENTIAL_KEY_MISSING';
      throw error;
    }
    const message = String(userId || '') + ':' + String(pin || '');
    let signature;
    if (typeof Utilities.computeHmacSha256Signature === 'function') signature = Utilities.computeHmacSha256Signature(message, pepper, Utilities.Charset.UTF_8);
    else signature = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, pepper + '|' + message, Utilities.Charset.UTF_8);
    const expected = 'v2:' + Utilities.base64EncodeWebSafe(signature).replace(/=+$/g, '');
    return storedHash === expected;
  }
  return storedHash === credentialHashV12_(String(userId || '') + ':' + String(pin || ''));
}

function randomTemporaryPinV1215_() {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + '|' + Utilities.getUuid() + '|' + Date.now(), Utilities.Charset.UTF_8);
  let value = 0;
  for (let i = 0; i < Math.min(6, digest.length); i += 1) value = (value * 257 + (digest[i] & 255)) >>> 0;
  return String(100000 + (value % 900000));
}

function setCredentialPinV1215_(spreadsheet, userId, pin) {
  const legacy = readLegacyStateV12_(spreadsheet || getSpreadsheet_());
  legacy.security = legacy.security && typeof legacy.security === 'object' ? legacy.security : {};
  legacy.security.pinHashes = legacy.security.pinHashes && typeof legacy.security.pinHashes === 'object' ? legacy.security.pinHashes : {};
  legacy.security.pinHashes[String(userId || '')] = credentialHashV1215_(String(userId || ''), String(pin || ''));
  writeLegacyStateV12_(spreadsheet || getSpreadsheet_(), legacy);
  return true;
}

function ensureCollaboratorCredentialV1215_(spreadsheet, userId) {
  userId = String(userId || '');
  if (!userId) return null;
  const legacy = readLegacyStateV12_(spreadsheet || getSpreadsheet_());
  legacy.security = legacy.security && typeof legacy.security === 'object' ? legacy.security : {};
  legacy.security.pinHashes = legacy.security.pinHashes && typeof legacy.security.pinHashes === 'object' ? legacy.security.pinHashes : {};
  if (legacy.security.pinHashes[userId]) return null;
  const pin = randomTemporaryPinV1215_();
  legacy.security.pinHashes[userId] = credentialHashV1215_(userId, pin);
  writeLegacyStateV12_(spreadsheet || getSpreadsheet_(), legacy);
  return pin;
}

function loginAttemptKeyV1215_(email) { return V1215_LOGIN_ATTEMPT_PREFIX + sha256V12_(String(email || '').trim().toLowerCase()); }
function readLoginAttemptV1215_(email) {
  const key = loginAttemptKeyV1215_(email);
  const props = PropertiesService.getScriptProperties();
  let raw = '';
  try { raw = String(CacheService.getScriptCache().get(key) || ''); } catch (ignored) {}
  if (!raw) raw = String(props.getProperty(key) || '');
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch (ignored) { data = {}; }
  if (Number(data.expiresAt || 0) && Number(data.expiresAt) <= Date.now()) { props.deleteProperty(key); try { CacheService.getScriptCache().remove(key); } catch (ignored) {} return {}; }
  return data || {};
}
function writeLoginAttemptV1215_(email, data, ttlSec) {
  const key = loginAttemptKeyV1215_(email), props = PropertiesService.getScriptProperties();
  data = Object.assign({}, data || {}, { expiresAt: Date.now() + Math.max(60, Number(ttlSec || 900)) * 1000 });
  const raw = JSON.stringify(data);
  props.setProperty(key, raw);
  try { CacheService.getScriptCache().put(key, raw, Math.min(V12_SESSION_TTL_MAX_SEC, Math.max(60, Number(ttlSec || 900)))); } catch (ignored) {}
}
function clearLoginAttemptV1215_(email) {
  const key = loginAttemptKeyV1215_(email); PropertiesService.getScriptProperties().deleteProperty(key); try { CacheService.getScriptCache().remove(key); } catch (ignored) {}
}

function ensureLegacySecurityV12_(spreadsheet) {
  const legacy = readLegacyStateV12_(spreadsheet);
  legacy.security = legacy.security && typeof legacy.security === 'object' ? legacy.security : {};
  legacy.security.pinHashes = legacy.security.pinHashes && typeof legacy.security.pinHashes === 'object' ? legacy.security.pinHashes : {};
  legacy.security.sessionTimeoutMin = Math.max(5, Math.min(480, Number(legacy.security.sessionTimeoutMin || 60)));
  legacy.security.maxAttempts = Math.max(1, Math.min(20, Number(legacy.security.maxAttempts || 5)));
  legacy.security.lockoutMinutes = Math.max(1, Math.min(1440, Number(legacy.security.lockoutMinutes || 15)));
  const collaborators = readCollectionRecords_(spreadsheet, 'collaborators', false);
  const temporaryPins = [];
  let changed = false;
  collaborators.forEach(function (person) {
    if (!person || !person.id || legacy.security.pinHashes[person.id]) return;
    const userId = String(person.id);
    const pin = randomTemporaryPinV1215_();
    legacy.security.pinHashes[userId] = credentialHashV1215_(userId, pin);
    temporaryPins.push({ userId:userId, nome:String(person.nome || ''), pin:pin });
    changed = true;
  });
  if (changed || Number(legacy.version || 0) !== 12) {
    legacy.version = 12;
    writeLegacyStateV12_(spreadsheet, legacy);
  }
  const result = cloneObject_(legacy.security);
  result.temporaryPins = temporaryPins;
  return result;
}

function publicStateV12_(spreadsheet) {
  const legacy = readLegacyConfigV12152_(spreadsheet);
  const collaborators = [];
  return {
    version: 12,
    companies: [],
    collaborators: collaborators,
    processes: [], tasks: [], audits: [], activity: [], messages: [], feedbacks: [], notifications: [],
    conversations: [], conversationReads: [], securityLog: [], errors: [],
    organization: cloneObject_(legacy.organization || {}),
    branding: cloneObject_(legacy.branding || {}),
    settings: {},
    security: {
      sessionTimeoutMin: Number(legacy.security && legacy.security.sessionTimeoutMin || 60),
      maxAttempts: Number(legacy.security && legacy.security.maxAttempts || 5),
      lockoutMinutes: Number(legacy.security && legacy.security.lockoutMinutes || 15),
      pinHashes: {}, failedAttempts: {}, backendMode: 'server-session'
    },
    _databaseVersion: getDatabaseVersion_(),
    _changeSequence: getChangeSequenceV12_()
  };
}

function loadPublicBootstrapServer() {
  const spreadsheet = getSpreadsheet_();
  return successResponse_({
    operationId: Utilities.getUuid(),
    databaseVersion: getDatabaseVersion_(),
    data: { state: publicStateV12_(spreadsheet), changeSequence: getChangeSequenceV12_() }
  });
}

function authenticateSessionServer(payload) {
  payload = payload || {};
  const email = String(payload.email || '').trim().toLowerCase();
  const pin = String(payload.pin || '');
  const operationId = String(payload.operationId || Utilities.getUuid());
  if (!email || !pin) return errorResponse_('CREDENTIALS_REQUIRED', 'Informe o e-mail e o PIN.', getDatabaseVersion_(), operationId);

  const cache = CacheService.getScriptCache();
  let attempts = readLoginAttemptV1215_(email);
  if (Number(attempts.lockedUntil || 0) > Date.now()) {
    const minutes = Math.max(1, Math.ceil((Number(attempts.lockedUntil) - Date.now()) / 60000));
    return errorResponse_('LOGIN_LOCKED', 'Acesso temporariamente bloqueado. Tente novamente em ' + minutes + ' minuto(s).', getDatabaseVersion_(), operationId);
  }

  const perfStartedAt = Date.now();
  const perf = {};
  const spreadsheet = getSpreadsheet_();
  const configStartedAt = Date.now();
  const legacyState = readLegacyConfigV12152_(spreadsheet);
  perf.configMs = Date.now() - configStartedAt;
  const security = legacyState.security && typeof legacyState.security === 'object' ? legacyState.security : {};
  if (!security.pinHashes || typeof security.pinHashes !== 'object') {
    return errorResponse_('SETUP_REQUIRED', 'A segurança do SGO ainda não foi preparada. Execute setupSGO no editor Apps Script.', getDatabaseVersion_(), operationId);
  }
  const collaboratorsStartedAt = Date.now();
  const collaborators = readCollectionRecords_(spreadsheet, 'collaborators', false);
  perf.authCollaboratorsMs = Date.now() - collaboratorsStartedAt;
  const user = collaborators.find(function (person) {
    return person && person.ativo !== false && String(person.email || '').trim().toLowerCase() === email;
  });
  const storedCredential = user && security.pinHashes ? security.pinHashes[user.id] : '';
  let valid = false;
  try {
    valid = Boolean(user && credentialMatchesV1215_(storedCredential, user.id, pin));
  } catch (credentialError) {
    const code = String(credentialError && (credentialError.code || credentialError.message) || '');
    if (code === 'CREDENTIAL_KEY_MISSING') {
      return errorResponse_('CREDENTIAL_KEY_MISSING', 'A chave de seguranca das credenciais v2 nao foi encontrada. Execute repairV12151LoginAccess() no editor Apps Script.', getDatabaseVersion_(), operationId);
    }
    try { registerServerErrorV10_('LOGIN_CREDENTIAL_VERIFY_FAILURE', credentialError, user && user.id || '', 'security', operationId); } catch (ignored) {}
    return errorResponse_('LOGIN_CREDENTIAL_VERIFY_FAILURE', 'Nao foi possivel validar a credencial. Execute diagnoseV12151Login() no editor Apps Script.', getDatabaseVersion_(), operationId);
  }
  if (!valid) {
    const count = Number(attempts.count || 0) + 1;
    const max = Number(security.maxAttempts || 5);
    const lockedUntil = count >= max ? Date.now() + Number(security.lockoutMinutes || 15) * 60000 : 0;
    writeLoginAttemptV1215_(email, { count: count >= max ? 0 : count, lockedUntil: lockedUntil }, Math.min(V12_SESSION_TTL_MAX_SEC, Math.max(900, Number(security.lockoutMinutes || 15) * 60)));
    return errorResponse_('INVALID_CREDENTIALS', count >= max ? 'Muitas tentativas. O acesso foi temporariamente bloqueado.' : 'E-mail ou PIN inválido.', getDatabaseVersion_(), operationId);
  }
  clearLoginAttemptV1215_(email);

  // v12.16.0: migracao de credencial deixa o caminho critico do login.
  // O cliente dispara a migracao em segundo plano depois que a tela ja abriu.
  const needsCredentialMigration = Boolean(user && storedCredential && String(storedCredential).indexOf('v2:') !== 0);

  // Monta apenas o nucleo necessario para liberar a tela. Chat, auditoria,
  // feedbacks e logs são carregados depois, sem bloquear o acesso.
  // devolvemos um codigo diagnostico claro e nao deixamos sessao orfa.
  let coreResult;
  try {
    const coreStartedAt = Date.now();
    coreResult = buildLoginCoreStateV12152_(spreadsheet, user, legacyState, collaborators);
    perf.coreMs = Date.now() - coreStartedAt;
  } catch (stateError) {
    try { registerServerErrorV10_('LOGIN_STATE_BUILD_FAILURE', stateError, user.id, 'security', operationId); } catch (ignored) {}
    return errorResponse_('LOGIN_STATE_BUILD_FAILURE', 'Seu e-mail e PIN foram validados, mas houve falha ao carregar os dados do SGO. Execute diagnoseV12151Login() no editor Apps Script.', getDatabaseVersion_(), operationId);
  }

  const sessionStartedAt = Date.now();
  const session = createSessionV12_(user, Number(security.sessionTimeoutMin || 60));
  perf.sessionMs = Date.now() - sessionStartedAt;
  perf.totalMs = Date.now() - perfStartedAt;
  perf.coreBreakdown = coreResult && coreResult.perf || {};
  try {
    if (perf.totalMs >= 1800 && typeof taskDiagnosticV128_ === 'function') {
      taskDiagnosticV128_({level:'WARN',origin:'server',module:'login',step:'AUTHENTICATE_SLOW',durationMs:perf.totalMs,userId:String(user.id||''),message:'Login acima da meta.',context:perf});
    }
  } catch (ignored) {}
  return successResponse_({
    operationId: operationId,
    databaseVersion: getDatabaseVersion_(),
    data: {
      sessionToken: session.token,
      expiresAt: session.expiresAt,
      user: sanitizeUserV12_(user),
      state: coreResult.state,
      changeSequence: getChangeSequenceV12_(),
      needsCredentialMigration: needsCredentialMigration,
      loginPerf: perf
    }
  });
}

function createSessionV12_(user, timeoutMinutes) {
  const token = Utilities.getUuid() + '.' + Utilities.getUuid();
  const tokenHash = sha256V12_(token);
  const now = Date.now();
  const ttlSec = Math.min(V12_SESSION_TTL_MAX_SEC, Math.max(300, Number(timeoutMinutes || 60) * 60));
  const session = {
    userId: String(user.id),
    createdAt: now,
    lastActivityAt: now,
    expiresAt: now + ttlSec * 1000,
    timeoutSec: ttlSec,
    nonce: Utilities.getUuid()
  };
  PropertiesService.getScriptProperties().setProperty(V12_SESSION_PREFIX + tokenHash, JSON.stringify(session));
  CacheService.getScriptCache().put(V12_SESSION_PREFIX + tokenHash, JSON.stringify(session), ttlSec);
  return { token: token, expiresAt: session.expiresAt };
}

function getSessionV12_(token, touch) {
  token = String(token || '');
  if (!token) return null;
  const tokenHash = sha256V12_(token);
  const key = V12_SESSION_PREFIX + tokenHash;
  const cache = CacheService.getScriptCache();
  let raw = cache.get(key);
  if (!raw) raw = PropertiesService.getScriptProperties().getProperty(key);
  if (!raw) return null;
  let session;
  try { session = JSON.parse(raw); } catch (ignored) { session = null; }
  if (!session || !session.userId || Date.now() >= Number(session.expiresAt || 0)) {
    cache.remove(key);
    PropertiesService.getScriptProperties().deleteProperty(key);
    return null;
  }
  // Evita um TextFinder na planilha em toda chamada RPC. O usuário da sessão
  // fica em cache curto e é invalidado automaticamente quando o cadastro muda.
  const userCacheKey = v1210CacheKey_('SGO_USER_RECORD', session.userId);
  let user = null;
  try {
    const cachedUser = cache.get(userCacheKey);
    if (cachedUser) user = JSON.parse(cachedUser);
  } catch (ignored) { user = null; }
  if (!user) {
    const userMeta = getRecordMeta_(getSpreadsheet_(), 'collaborators', session.userId);
    user = userMeta && !userMeta.deleted && userMeta.data && userMeta.data.ativo !== false ? userMeta.data : null;
    if (user) {
      try { cache.put(userCacheKey, JSON.stringify(user), 120); } catch (ignored) {}
    }
  }
  if (!user || user.ativo === false) return null;
  if (touch && Date.now() - Number(session.lastActivityAt || 0) > 60000) {
    const now = Date.now();
    const timeoutSec = Math.min(V12_SESSION_TTL_MAX_SEC, Math.max(300, Number(session.timeoutSec || Math.floor((Number(session.expiresAt) - Number(session.createdAt || now)) / 1000) || 3600)));
    session.lastActivityAt = now;
    session.timeoutSec = timeoutSec;
    session.expiresAt = now + timeoutSec * 1000;
    cache.put(key, JSON.stringify(session), timeoutSec);
    PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(session));
  }
  return { tokenHash: tokenHash, session: session, user: user };
}

function requireSessionV12_(payload, touch) {
  const auth = getSessionV12_(payload && payload.sessionToken, touch !== false);
  if (!auth) throw new Error('SESSION_INVALID: sua sessão expirou. Entre novamente.');
  return auth;
}

function resumeSessionServer(payload) {
  payload = payload || {};
  const startedAt = Date.now();
  const auth = getSessionV12_(payload.sessionToken, true);
  if (!auth) return errorResponse_('SESSION_INVALID', 'Sua sessão expirou. Entre novamente.', getDatabaseVersion_(), Utilities.getUuid());
  const spreadsheet = getSpreadsheet_();
  const legacyConfig = readLegacyConfigV12152_(spreadsheet);
  const coreResult = buildLoginCoreStateV12152_(spreadsheet, auth.user, legacyConfig);
  return successResponse_({
    operationId: Utilities.getUuid(),
    databaseVersion: getDatabaseVersion_(),
    data: {
      expiresAt: auth.session.expiresAt,
      user: sanitizeUserV12_(auth.user),
      state: coreResult.state,
      changeSequence: getChangeSequenceV12_(),
      loginPerf: {totalMs:Date.now()-startedAt,coreBreakdown:coreResult.perf}
    }
  });
}

function logoutSessionServer(payload) {
  payload = payload || {};
  const token = String(payload.sessionToken || '');
  if (token) {
    const key = V12_SESSION_PREFIX + sha256V12_(token);
    CacheService.getScriptCache().remove(key);
    PropertiesService.getScriptProperties().deleteProperty(key);
  }
  return successResponse_({ operationId: Utilities.getUuid(), databaseVersion: getDatabaseVersion_(), data: { loggedOut: true } });
}

function sanitizeUserV12_(user) {
  user = user || {};
  const allowed = ['id','nome','email','cargo','area','empresa','perfil','capacidade','substitutoId','empresasAcesso','processos','ativo','ultimoAcesso'];
  const copy = {};
  allowed.forEach(function (field) {
    if (Object.prototype.hasOwnProperty.call(user, field)) copy[field] = cloneObject_(user[field]);
  });
  return copy;
}

function userCanSeeTaskV12_(user, task) {
  if (!user || !task || task.excluido) return false;
  const role = String(user.perfil || 'colaborador');
  if (['admin','diretoria','auditoria'].indexOf(role) >= 0) return true;
  const companies = Array.isArray(user.empresasAcesso) ? user.empresasAcesso : [];
  if (companies.length && task.empresa && companies.indexOf(task.empresa) < 0) return false;
  if (role === 'gestor' && String(task.area || '') === String(user.area || '')) return true;
  return String(task.responsavelId || '') === String(user.id)
    || String(task.aprovadorId || '') === String(user.id)
    || (Array.isArray(task.participantes) && task.participantes.indexOf(user.id) >= 0)
    || String(task.solicitanteId || '') === String(user.id);
}

function userCanSeeConversationV12_(user, conversation, visibleTaskIds) {
  if (!user || !conversation || conversation.active === false) return false;
  const role = String(user.perfil || 'colaborador');
  if (role === 'admin') return true;
  // Conversas vinculadas a tarefa seguem SEMPRE a visibilidade atual da tarefa.
  // participantIds é apenas roteamento de mensagens e não pode preservar acesso
  // depois que o usuário deixou de enxergar a tarefa.
  const taskId = String(conversation.taskId || '');
  if (taskId || String(conversation.type || '') === 'task') {
    return Boolean(taskId && visibleTaskIds && visibleTaskIds[taskId]);
  }
  if (Array.isArray(conversation.participantIds) && conversation.participantIds.indexOf(user.id) >= 0) return true;
  if (conversation.type === 'area' && String(conversation.areaKey || normalizeAreaKeyV12_(conversation.area || '')) === normalizeAreaKeyV12_(user.area || '')) return true;
  return false;
}


function buildLoginCoreStateV12152_(spreadsheet, user, legacyConfig, preloadedCollaborators) {
  const startedAt = Date.now();
  const legacy = legacyConfig || readLegacyConfigV12152_(spreadsheet);
  const role = String(user.perfil || 'colaborador');
  const privileged = ['admin','diretoria','auditoria'].indexOf(role) >= 0;

  const tProcesses = Date.now();
  const allProcesses = readCollectionRecords_(spreadsheet, 'processes', false);
  const processesMs = Date.now() - tProcesses;
  const processApprovers = {};
  allProcesses.forEach(function(process){
    if (process && process.id && process.aprovadorId) processApprovers[String(process.id)] = String(process.aprovadorId);
  });

  const tTasks = Date.now();
  const allTasks = readCollectionRecords_(spreadsheet, 'tasks', false);
  const tasksMs = Date.now() - tTasks;
  const tasks = allTasks.filter(function(task){
    return userCanSeeTaskV12_(user, task)
      || (task && processApprovers[String(task.processoId || '')] === String(user.id));
  });

  const processes = allProcesses.filter(function(process){
    if (privileged) return true;
    const companies = Array.isArray(user.empresasAcesso) ? user.empresasAcesso : [];
    return !companies.length || !process || !process.empresa || companies.indexOf(process.empresa) >= 0;
  });

  const tCollaborators = Date.now();
  const collaboratorSource = Array.isArray(preloadedCollaborators)
    ? preloadedCollaborators
    : readCollectionRecords_(spreadsheet, 'collaborators', false);
  const collaborators = collaboratorSource
    .filter(function(person){ return person && person.ativo !== false; })
    .map(sanitizeUserV12_);
  const collaboratorsMs = Date.now() - tCollaborators;

  return {
    state: {
      version:12,
      companies:cloneObject_(legacy.companies || []),
      collaborators:collaborators,
      processes:processes,
      tasks:tasks,
      audits:[],
      activity:[],
      messages:[],
      feedbacks:[],
      notifications:[],
      conversations:[],
      conversationReads:[],
      errors:[],
      securityLog:[],
      organization:cloneObject_(legacy.organization || {}),
      settings:cloneObject_(legacy.settings || {}),
      branding:cloneObject_(legacy.branding || {}),
      security:{
        sessionTimeoutMin:Number(legacy.security && legacy.security.sessionTimeoutMin || 60),
        maxAttempts:Number(legacy.security && legacy.security.maxAttempts || 5),
        lockoutMinutes:Number(legacy.security && legacy.security.lockoutMinutes || 15),
        pinHashes:{}, failedAttempts:{}, backendMode:'server-session'
      },
      _databaseVersion:getDatabaseVersion_(),
      _changeSequence:getChangeSequenceV12_(),
      _deferredPending:true
    },
    perf: {
      processesMs:processesMs,
      tasksMs:tasksMs,
      collaboratorsMs:collaboratorsMs,
      coreStateMs:Date.now()-startedAt,
      counts:{processes:processes.length,tasks:tasks.length,collaborators:collaborators.length}
    }
  };
}

function buildDeferredStateV12152_(spreadsheet, user) {
  const startedAt = Date.now();
  const role = String(user.perfil || 'colaborador');
  const privileged = ['admin','diretoria','auditoria'].indexOf(role) >= 0;
  const allProcesses = readCollectionRecords_(spreadsheet, 'processes', false);
  const processApprovers = {};
  allProcesses.forEach(function(process){
    if (process && process.id && process.aprovadorId) processApprovers[String(process.id)] = String(process.aprovadorId);
  });
  const allTasks = readCollectionRecords_(spreadsheet, 'tasks', false);
  const visibleTaskIds = {};
  allTasks.forEach(function(task){
    if (userCanSeeTaskV12_(user, task) || (task && processApprovers[String(task.processoId || '')] === String(user.id))) {
      visibleTaskIds[String(task.id || '')] = true;
    }
  });

  const feedbacks = readCollectionRecords_(spreadsheet, 'feedbacks', false).filter(function(feedback){
    if (!feedback) return false;
    if (feedback.taskId) return Boolean(visibleTaskIds[String(feedback.taskId)]);
    return String(feedback.autorId || '') === String(user.id) || String(feedback.destinatarioId || '') === String(user.id);
  });
  const audits = readCollectionRecords_(spreadsheet, 'audits', false).filter(function(audit){
    return privileged || Boolean(audit && audit.taskId && visibleTaskIds[String(audit.taskId)]);
  });
  const activity = readCollectionRecords_(spreadsheet, 'activity', false).filter(function(entry){
    if (!entry) return false;
    if (entry.taskId) return Boolean(visibleTaskIds[String(entry.taskId)]);
    return privileged || String(entry.userId || '') === String(user.id);
  }).slice(-300);
  const errors = privileged ? readCollectionRecords_(spreadsheet, 'errors', false).slice(-500) : [];
  const securityLog = privileged ? readCollectionRecords_(spreadsheet, 'securityLog', false).slice(-500) : [];
  return {
    feedbacks:feedbacks,
    audits:audits,
    activity:activity,
    errors:errors,
    securityLog:securityLog,
    durationMs:Date.now()-startedAt
  };
}

function loadDeferredBootstrapServer(payload) {
  payload = payload || {};
  let auth;
  try { auth = requireSessionV12_(payload, true); }
  catch (error) { return errorResponse_('SESSION_INVALID', 'Sua sessão expirou.', getDatabaseVersion_(), Utilities.getUuid()); }
  const data = buildDeferredStateV12152_(getSpreadsheet_(), auth.user);
  try {
    if (data.durationMs >= 1800 && typeof taskDiagnosticV128_ === 'function') {
      taskDiagnosticV128_({level:'WARN',origin:'server',module:'login',step:'DEFERRED_BOOTSTRAP_SLOW',durationMs:data.durationMs,userId:String(auth.user.id||''),message:'Carga pos-login acima da meta.'});
    }
  } catch (ignored) {}
  return successResponse_({operationId:Utilities.getUuid(),databaseVersion:getDatabaseVersion_(),data:data});
}

function migrateMyCredentialAfterLoginServer(payload) {
  payload = payload || {};
  let auth;
  try { auth = requireSessionV12_(payload, true); }
  catch (error) { return errorResponse_('SESSION_INVALID', 'Sua sessão expirou.', getDatabaseVersion_(), Utilities.getUuid()); }
  const pin = String(payload.pin || '');
  if (!pin) return successResponse_({operationId:Utilities.getUuid(),databaseVersion:getDatabaseVersion_(),data:{migrated:false,reason:'PIN_EMPTY'}});
  const spreadsheet = getSpreadsheet_();
  const legacy = readLegacyConfigV12152_(spreadsheet);
  const stored = legacy.security && legacy.security.pinHashes ? String(legacy.security.pinHashes[String(auth.user.id)] || '') : '';
  if (!stored || stored.indexOf('v2:') === 0) {
    return successResponse_({operationId:Utilities.getUuid(),databaseVersion:getDatabaseVersion_(),data:{migrated:false,reason:stored?'ALREADY_V2':'NO_LEGACY_CREDENTIAL'}});
  }
  if (!credentialMatchesV1215_(stored, auth.user.id, pin)) {
    return errorResponse_('INVALID_CREDENTIALS', 'A credencial não pôde ser migrada.', getDatabaseVersion_(), Utilities.getUuid());
  }
  const migrationLock = tryWriteLockV12_(1200);
  if (!migrationLock) return successResponse_({operationId:Utilities.getUuid(),databaseVersion:getDatabaseVersion_(),data:{migrated:false,reason:'LOCK_BUSY'}});
  try {
    setCredentialPinV1215_(spreadsheet, auth.user.id, pin);
  } finally {
    migrationLock.releaseLock();
  }
  return successResponse_({operationId:Utilities.getUuid(),databaseVersion:getDatabaseVersion_(),data:{migrated:true}});
}

function buildScopedStateV12_(spreadsheet, user) {
  // v12.15: monta o snapshot já escopado. Evita carregar mensagens, erros e
  // logs privados de todos os usuários para só depois descartá-los.
  const legacy = readLegacyStateV12_(spreadsheet) || {};
  const role = String(user.perfil || 'colaborador');
  const privileged = ['admin','diretoria','auditoria'].indexOf(role) >= 0;

  const allProcesses = readCollectionRecords_(spreadsheet, 'processes', false);
  const processApprovers = {};
  allProcesses.forEach(function(process){
    if (process && process.id && process.aprovadorId) processApprovers[String(process.id)] = String(process.aprovadorId);
  });

  const allTasks = readCollectionRecords_(spreadsheet, 'tasks', false);
  const tasks = allTasks.filter(function(task){
    return userCanSeeTaskV12_(user, task)
      || (task && processApprovers[String(task.processoId || '')] === String(user.id));
  });
  const visibleTaskIds = {};
  tasks.forEach(function(task){ if (task && task.id) visibleTaskIds[String(task.id)] = true; });

  const processes = allProcesses.filter(function(process){
    if (privileged) return true;
    const companies = Array.isArray(user.empresasAcesso) ? user.empresasAcesso : [];
    return !companies.length || !process || !process.empresa || companies.indexOf(process.empresa) >= 0;
  });

  const collaborators = readCollectionRecords_(spreadsheet, 'collaborators', false)
    .filter(function(person){ return person && person.ativo !== false; })
    .map(sanitizeUserV12_);

  const conversations = readCollectionRecords_(spreadsheet, 'conversations', false)
    .filter(function(conversation){ return userCanSeeConversationV12_(user, conversation, visibleTaskIds); });
  const visibleConversationIds = {};
  conversations.forEach(function(conversation){ if (conversation && conversation.id) visibleConversationIds[String(conversation.id)] = true; });

  // Mensagens são a coleção de maior crescimento. Usa o índice por conversa e
  // traz somente as 50 mais recentes por conversa visível. Faz fallback seguro
  // para a coleção completa em instalações antigas ainda sem índice.
  let messages = [];
  const seenMessageIds = {};
  if (typeof messageIdsForConversationsV1215_ === 'function' && typeof getRecordMeta_ === 'function') {
    let groupedRefs = {};
    try { groupedRefs = messageIdsForConversationsV1215_(spreadsheet, conversations.map(function(conversation){ return conversation.id; }), 50); } catch (ignored) { groupedRefs = {}; }
    conversations.forEach(function(conversation){
      const refs = groupedRefs[String(conversation.id || '')] || [];
      refs.forEach(function(ref){
        const id = String(ref && ref.id || '');
        if (!id || seenMessageIds[id]) return;
        const meta = getRecordMeta_(spreadsheet, 'messages', id);
        if (!meta || meta.deleted || !meta.data) return;
        seenMessageIds[id] = true;
        messages.push(meta.data);
      });
    });
  } else if (typeof messageIdsForConversationV12_ === 'function' && typeof getRecordMeta_ === 'function') {
    conversations.forEach(function(conversation){
      let refs = [];
      try { refs = messageIdsForConversationV12_(spreadsheet, String(conversation.id || '')).slice(-50); } catch (ignored) { refs = []; }
      refs.forEach(function(ref){
        const id = String(ref && ref.id || '');
        if (!id || seenMessageIds[id]) return;
        const meta = getRecordMeta_(spreadsheet, 'messages', id);
        if (!meta || meta.deleted || !meta.data) return;
        seenMessageIds[id] = true;
        messages.push(meta.data);
      });
    });
  } else {
    messages = readCollectionRecords_(spreadsheet, 'messages', false).filter(function(message){
      if (!message || message.deleted) return false;
      if (message.taskId) return Boolean(visibleTaskIds[String(message.taskId)]);
      return Boolean(visibleConversationIds[String(message.conversationId || '')])
        || String(message.authorId || '') === String(user.id)
        || (Array.isArray(message.recipientIds) && message.recipientIds.indexOf(user.id) >= 0);
    });
  }
  messages.sort(function(a,b){ return new Date(a.createdAt || a._serverUpdatedAt || 0) - new Date(b.createdAt || b._serverUpdatedAt || 0); });

  const feedbacks = readCollectionRecords_(spreadsheet, 'feedbacks', false).filter(function(feedback){
    if (!feedback) return false;
    if (feedback.taskId) return Boolean(visibleTaskIds[String(feedback.taskId)]);
    return String(feedback.autorId || '') === String(user.id) || String(feedback.destinatarioId || '') === String(user.id);
  });
  const audits = readCollectionRecords_(spreadsheet, 'audits', false).filter(function(audit){
    return privileged || Boolean(audit && audit.taskId && visibleTaskIds[String(audit.taskId)]);
  });
  const activity = readCollectionRecords_(spreadsheet, 'activity', false).filter(function(entry){
    if (!entry) return false;
    if (entry.taskId) return Boolean(visibleTaskIds[String(entry.taskId)]);
    return privileged || String(entry.userId || '') === String(user.id);
  }).slice(-300);
  const notifications = readCollectionRecords_(spreadsheet, 'notifications', false).filter(function(notification){
    return notification && String(notification.userId || notification.destinatarioId || '') === String(user.id);
  }).slice(-300);
  const conversationReads = readCollectionRecords_(spreadsheet, 'conversationReads', false).filter(function(read){
    return read && String(read.userId || '') === String(user.id);
  });
  const errors = privileged ? readCollectionRecords_(spreadsheet, 'errors', false).slice(-500) : [];
  const securityLog = privileged ? readCollectionRecords_(spreadsheet, 'securityLog', false).slice(-500) : [];

  return {
    version:12,
    companies:cloneObject_(legacy.companies || []),
    collaborators:collaborators,
    processes:processes,
    tasks:tasks,
    audits:audits,
    activity:activity,
    messages:messages,
    feedbacks:feedbacks,
    notifications:notifications,
    conversations:conversations,
    conversationReads:conversationReads,
    errors:errors,
    securityLog:securityLog,
    organization:cloneObject_(legacy.organization || {}),
    settings:cloneObject_(legacy.settings || {}),
    branding:cloneObject_(legacy.branding || {}),
    security:{
      sessionTimeoutMin:Number(legacy.security && legacy.security.sessionTimeoutMin || 60),
      maxAttempts:Number(legacy.security && legacy.security.maxAttempts || 5),
      lockoutMinutes:Number(legacy.security && legacy.security.lockoutMinutes || 15),
      pinHashes:{}, failedAttempts:{}, backendMode:'server-session'
    },
    _databaseVersion:getDatabaseVersion_(),
    _changeSequence:getChangeSequenceV12_()
  };
}

function normalizeAreaKeyV12_(value) {
  return String(value || '').trim().toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function getChangeSequenceV12_() {
  return Math.max(0, Number(getMetaValue_('CHANGE_SEQUENCE') || 0));
}

function nextChangeSequenceV12_() {
  const next = getChangeSequenceV12_() + 1;
  // v12.17: appendChangeV12_ só pode chamar esta função sob ScriptLock. Mantemos
  // CHANGE_SEQUENCE na fonte quente durável e espelhamos SGO_META na manutenção,
  // evitando uma leitura+reescrita da planilha de metadados a cada changelog.
  if (typeof setHotMetaValuesV1217_ === 'function') setHotMetaValuesV1217_({ CHANGE_SEQUENCE:String(next) });
  else setMetaValue_('CHANGE_SEQUENCE', String(next));
  return next;
}

function appendChangeV12_(spreadsheet, collection, recordId, version, deleted, updatedAt, userId, operationId, data, visibility) {
  // Todas as chamadas não-reservadas devem ocorrer sob ScriptLock. Isso torna
  // CHANGE_SEQUENCE e a deduplicação por operationId atomicamente consistentes.
  try { const activeLock = LockService.getScriptLock(); if (activeLock && typeof activeLock.hasLock === 'function' && !activeLock.hasLock()) throw new Error('CHANGELOG_LOCK_REQUIRED'); } catch (error) { if (String(error && error.message || error) === 'CHANGELOG_LOCK_REQUIRED') throw error; }
  const sheet = getOrCreateSheet_(spreadsheet, V12_CHANGELOG_SHEET);
  initializeHeaders_(sheet, V12_CHANGELOG_HEADERS);
  const sequence = nextChangeSequenceV12_();
  sheet.appendRow([
    sequence, String(collection || ''), String(recordId || ''), Number(version || 0), Boolean(deleted),
    String(updatedAt || new Date().toISOString()), String(userId || ''), String(operationId || ''),
    JSON.stringify(data || {}), JSON.stringify(visibility || visibilityForRecordV12_(collection, data || {}))
  ]);
  return sequence;
}

/** v12.10: append de changelog com sequência já reservada pelo chamador.
 * Usado dentro do lock de tarefa para que CHANGE_SEQUENCE possa ser atualizado
 * no mesmo lote dos demais metadados, evitando uma escrita extra em SGO_META. */
function appendChangeWithSequenceV1210_(spreadsheet, sequence, collection, recordId, version, deleted, updatedAt, userId, operationId, data, visibility) {
  const sheet = getOrCreateSheet_(spreadsheet, V12_CHANGELOG_SHEET);
  initializeHeaders_(sheet, V12_CHANGELOG_HEADERS);
  const seq = Math.max(1, Number(sequence || 0));
  sheet.appendRow([
    seq, String(collection || ''), String(recordId || ''), Number(version || 0), Boolean(deleted),
    String(updatedAt || new Date().toISOString()), String(userId || ''), String(operationId || ''),
    JSON.stringify(data || {}), JSON.stringify(visibility || visibilityForRecordV12_(collection, data || {}))
  ]);
  return seq;
}

function visibilityForRecordV12_(collection, data) {
  data = data || {};
  if (collection === 'messages') return { userIds: uniqueIdsV12_([data.authorId].concat(data.recipientIds || [])), conversationId: data.conversationId || '', taskId: data.taskId || '', areaKey: normalizeAreaKeyV12_(data.area || '') };
  if (collection === 'conversations') return { userIds: uniqueIdsV12_(data.participantIds || []), taskId: data.taskId || '', areaKey: data.areaKey || normalizeAreaKeyV12_(data.area || '') };
  if (collection === 'conversationReads' || collection === 'notifications') return { userIds: uniqueIdsV12_([data.userId || data.destinatarioId]) };
  if (collection === 'errors' || collection === 'securityLog') return { roles: ['admin','diretoria','auditoria'] };
  if (collection === 'tasks' || collection === 'feedbacks' || collection === 'audits' || collection === 'activity') return { taskId: data.taskId || data.id || '', userIds: uniqueIdsV12_([data.responsavelId, data.userId, data.autorId, data.destinatarioId].concat(data.participantes || [])) };
  return { public: true };
}

function uniqueIdsV12_(values) {
  const map = {};
  return (values || []).map(String).filter(function (value) { if (!value || map[value]) return false; map[value] = true; return true; });
}

function rebuildDataSheetV1215_(sheet, headers, keptRows) {
  initializeHeaders_(sheet, headers);
  const oldCount = Math.max(0, sheet.getLastRow() - 1);
  if (oldCount > 0) sheet.getRange(2,1,oldCount,headers.length).clearContent();
  if (keptRows.length) sheet.getRange(2,1,keptRows.length,headers.length).setValues(keptRows);
}

function maintainChangeLogV1215_(spreadsheet) {
  const sheet = getOrCreateSheet_(spreadsheet || getSpreadsheet_(), V12_CHANGELOG_SHEET);
  initializeHeaders_(sheet,V12_CHANGELOG_HEADERS);
  const count = Math.max(0,sheet.getLastRow()-1);
  if (count <= 20000) return {compacted:false,count:count};
  const keepCount = 15000;
  const start = Math.max(2,sheet.getLastRow()-keepCount+1);
  const removedCount = Math.max(0,start-2);
  const kept = sheet.getRange(start,1,sheet.getLastRow()-start+1,V12_CHANGELOG_HEADERS.length).getValues();
  if (!kept.length) return {compacted:false,count:count};
  if (removedCount > 0) {
    const removed = sheet.getRange(2,1,removedCount,V12_CHANGELOG_HEADERS.length).getValues();
    const archive = getOrCreateSheet_(spreadsheet || getSpreadsheet_(),V1215_CHANGELOG_ARCHIVE_SHEET);
    initializeHeaders_(archive,V12_CHANGELOG_HEADERS.concat(['ARQUIVADO_EM']));
    const archivedAt = new Date().toISOString();
    archive.getRange(archive.getLastRow()+1,1,removed.length,V12_CHANGELOG_HEADERS.length+1).setValues(removed.map(function(row){return row.concat([archivedAt]);}));
  }
  const minSequence = Number(kept[0][0]||0);
  rebuildDataSheetV1215_(sheet,V12_CHANGELOG_HEADERS,kept);
  setMetaValue_('MIN_CHANGE_SEQUENCE',String(minSequence));
  return {compacted:true,before:count,after:kept.length,archived:removedCount,minSequence:minSequence};
}

function maintainOperationHistoryV1215_(spreadsheet) {
  const sheet = getOrCreateSheet_(spreadsheet || getSpreadsheet_(), V12_OPERATION_SHEET);
  initializeHeaders_(sheet,V12_OPERATION_HEADERS);
  const count=Math.max(0,sheet.getLastRow()-1);
  if(count<=3000)return {compacted:false,count:count};
  const rows=sheet.getRange(2,1,count,V12_OPERATION_HEADERS.length).getValues();
  const cutoff=Date.now()-30*86400000;
  const active=[], recentFinal=[], archive=[];
  rows.forEach(function(row){
    const status=String(row[4]||'').toUpperCase();
    if(['PROCESSING','RECEIVED','PENDING'].indexOf(status)>=0){active.push(row);return;}
    const at=new Date(row[6]||row[5]||0).getTime();
    if(!Number.isFinite(at)||at>=cutoff)recentFinal.push(row); else archive.push(row);
  });
  const room=Math.max(0,3000-active.length);
  if(recentFinal.length>room) archive.push.apply(archive,recentFinal.slice(0,recentFinal.length-room));
  const kept=active.concat(recentFinal.slice(Math.max(0,recentFinal.length-room)));
  if(archive.length){
    const archiveSheet=getOrCreateSheet_(spreadsheet || getSpreadsheet_(),V1215_OPERATION_ARCHIVE_SHEET);
    initializeHeaders_(archiveSheet,V12_OPERATION_HEADERS.concat(['ARQUIVADO_EM']));
    const archivedAt=new Date().toISOString();
    archiveSheet.getRange(archiveSheet.getLastRow()+1,1,archive.length,V12_OPERATION_HEADERS.length+1).setValues(archive.map(function(row){return row.concat([archivedAt]);}));
  }
  rebuildDataSheetV1215_(sheet,V12_OPERATION_HEADERS,kept);
  return {compacted:true,before:count,after:kept.length,archived:archive.length,activePreserved:active.length};
}

function maintainSecurityRuntimeV1215_() {
  try { return cleanupExpiredSessionsV1215_(); } catch (ignored) { return {removed:0}; }
}

function changeVisibleToUserV12_(user, collection, data, visibility, visibleTaskIds) {
  if (!user) return false;
  const role = String(user.perfil || 'colaborador');
  visibility = visibility || {};
  if (collection === 'tasks') return userCanSeeTaskV12_(user, data);

  // Registros que carregam conteúdo de uma tarefa seguem a permissão ATUAL da
  // tarefa antes de qualquer recipientId/participantId histórico.
  const taskScopedCollections = ['messages','conversations','feedbacks','audits','activity'];
  if (visibility.taskId && taskScopedCollections.indexOf(collection) >= 0) {
    return Boolean(visibleTaskIds && visibleTaskIds[String(visibility.taskId)]);
  }

  if (visibility.public) return true;
  if (Array.isArray(visibility.roles) && visibility.roles.indexOf(role) >= 0) return true;
  if (Array.isArray(visibility.userIds) && visibility.userIds.indexOf(user.id) >= 0) return true;
  if (visibility.areaKey && normalizeAreaKeyV12_(user.area || '') === visibility.areaKey) return true;
  if (visibility.taskId && visibleTaskIds && visibleTaskIds[visibility.taskId]) return true;
  if (collection === 'collaborators') return Boolean(data && data.ativo !== false);
  if (collection === 'processes') {
    if (['admin','diretoria','auditoria'].indexOf(role) >= 0) return true;
    const companies = Array.isArray(user.empresasAcesso) ? user.empresasAcesso : [];
    return !companies.length || !data || !data.empresa || companies.indexOf(data.empresa) >= 0;
  }
  return false;
}

function getChangesSinceServer(payload) {
  payload = payload || {};
  let auth;
  try { auth = requireSessionV12_(payload, true); } catch (error) { return errorResponse_('SESSION_INVALID', 'Sua sessão expirou. Entre novamente.', getDatabaseVersion_(), Utilities.getUuid()); }
  const after = Math.max(0, Number(payload.sequence || 0));
  const limit = Math.max(1, Math.min(500, Number(payload.limit || 250)));
  const currentSequence = getChangeSequenceV12_();
  const minRetainedSequence = Math.max(0, Number(getMetaValue_('MIN_CHANGE_SEQUENCE') || 0));
  if (after > 0 && minRetainedSequence > 0 && after < minRetainedSequence - 1) {
    return successResponse_({
      operationId:Utilities.getUuid(), databaseVersion:getDatabaseVersion_(),
      data:{ changes:[], sequence:currentSequence, hasMore:false, fullSnapshotRequired:true, minRetainedSequence:minRetainedSequence }
    });
  }

  // Caminho rápido: quando nada mudou, não lê changelog nem tarefas.
  if (after >= currentSequence) {
    return successResponse_({
      operationId: Utilities.getUuid(),
      databaseVersion: getDatabaseVersion_(),
      data: { changes: [], sequence: currentSequence, hasMore: false }
    });
  }

  const spreadsheet = getSpreadsheet_();
  const sheet = getOrCreateSheet_(spreadsheet, V12_CHANGELOG_SHEET);
  initializeHeaders_(sheet, V12_CHANGELOG_HEADERS);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return successResponse_({ operationId: Utilities.getUuid(), databaseVersion: getDatabaseVersion_(), data: { changes: [], sequence: currentSequence, hasMore: false } });

  // SGO_CHANGELOG é append-only. Se a última linha corresponde à sequência atual,
  // calculamos diretamente a primeira linha necessária em vez de reler todo o histórico.
  let startRow = 2;
  try {
    const lastSequenceInSheet = Number(sheet.getRange(lastRow, 1).getValue() || 0);
    if (lastSequenceInSheet === currentSequence && currentSequence > after) {
      const estimated = lastRow - (currentSequence - (after + 1));
      if (estimated >= 2 && estimated <= lastRow) {
        const firstCandidateSequence = Number(sheet.getRange(estimated, 1).getValue() || 0);
        if (firstCandidateSequence > after) startRow = estimated;
      }
    }
  } catch (ignored) { startRow = 2; }

  const rowCount = Math.max(0, lastRow - startRow + 1);
  const rows = rowCount ? sheet.getRange(startRow, 1, rowCount, V12_CHANGELOG_HEADERS.length).getValues() : [];
  // Não carregamos mais a coleção inteira de tarefas em toda sincronização.
  // Quando uma mudança depende da visibilidade de uma tarefa relacionada, ela é
  // resolvida pontualmente e aproveita o cache de linhas do v12.10.
  const visibleTaskIds = {};
  const checkedTaskIds = {};
  const changes = [];
  let scannedSequence = after;
  let hasMore = false;

  for (let index = 0; index < rows.length; index += 1) {
    const sequence = Number(rows[index][0] || 0);
    if (sequence <= after) continue;
    scannedSequence = sequence;
    let data = {};
    let visibility = {};
    try { data = JSON.parse(String(rows[index][8] || '{}')); } catch (ignored) { data = {}; }
    try { visibility = JSON.parse(String(rows[index][9] || '{}')); } catch (ignored) { visibility = {}; }
    const collection = String(rows[index][1] || '');
    const relatedTaskId = String(visibility.taskId || '');
    if (relatedTaskId && !Object.prototype.hasOwnProperty.call(checkedTaskIds, relatedTaskId)) {
      checkedTaskIds[relatedTaskId] = true;
      const taskMeta = getRecordMeta_(spreadsheet, 'tasks', relatedTaskId);
      if (taskMeta && !taskMeta.deleted && taskMeta.data && userCanSeeTaskV12_(auth.user, taskMeta.data)) visibleTaskIds[relatedTaskId] = true;
    }
    const visible = changeVisibleToUserV12_(auth.user, collection, data, visibility, visibleTaskIds);
    if (visible) {
      changes.push({ sequence: sequence, collection: collection, id: String(rows[index][2] || ''), version: Number(rows[index][3] || 0), deleted: Boolean(rows[index][4]), updatedAt: valueToIso_(rows[index][5]), data: data });
    } else if (collection === 'tasks') {
      changes.push({ sequence: sequence, collection: collection, id: String(rows[index][2] || ''), version: Number(rows[index][3] || 0), deleted: true, updatedAt: valueToIso_(rows[index][5]), data: null });
    }
    if (changes.length >= limit) {
      hasMore = rows.slice(index + 1).some(function (row) { return Number(row[0] || 0) > scannedSequence; });
      break;
    }
  }
  if (!hasMore) scannedSequence = currentSequence;
  return successResponse_({
    operationId: Utilities.getUuid(),
    databaseVersion: getDatabaseVersion_(),
    data: { changes: changes, sequence: scannedSequence, hasMore: hasMore }
  });
}

function tryWriteLockV12_(waitMs) {
  const lock = LockService.getScriptLock();
  return lock.tryLock(Math.max(100, Math.min(8000, Number(waitMs || 5000)))) ? lock : null;
}

function serverBusyV12_(operationId) {
  return {
    success: false, confirmed: false, conflict: false, errorCode: 'SERVER_BUSY',
    message: 'O servidor está processando outra operação. Tente novamente em alguns segundos.',
    operationId: String(operationId || ''), databaseVersion: getDatabaseVersion_(), serverTimestamp: new Date().toISOString()
  };
}

function getOperationRowV12_(spreadsheet, operationId) {
  const sheet = getOrCreateSheet_(spreadsheet, V12_OPERATION_SHEET);
  initializeHeaders_(sheet, V12_OPERATION_HEADERS);
  if (sheet.getLastRow() < 2) return null;
  const key = String(operationId || '');
  let rowNumber = v1210GetCachedRow_('SGO_OPERATION_ROW', key);
  let values = null;
  if (rowNumber >= 2 && rowNumber <= sheet.getLastRow()) {
    const candidate = sheet.getRange(rowNumber, 1, 1, V12_OPERATION_HEADERS.length).getValues()[0];
    if (String(candidate[0] || '') === key) values = candidate;
    else rowNumber = 0;
  }
  if (!values) {
    const found = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).createTextFinder(key).matchEntireCell(true).findNext();
    if (!found) return null;
    rowNumber = found.getRow();
    values = sheet.getRange(rowNumber, 1, 1, V12_OPERATION_HEADERS.length).getValues()[0];
    v1210SetCachedRow_('SGO_OPERATION_ROW', key, rowNumber);
  }
  let result = null;
  try { result = JSON.parse(String(values[7] || 'null')); } catch (ignored) { result = null; }
  return { row: rowNumber, operationId: String(values[0]), type: String(values[1]), userId: String(values[2]), entityId: String(values[3]), status: String(values[4]), createdAt: valueToIso_(values[5]), updatedAt: valueToIso_(values[6]), result: result, error: String(values[8] || '') };
}

function setOperationV12_(spreadsheet, operationId, type, userId, entityId, status, result, error) {
  const sheet = getOrCreateSheet_(spreadsheet, V12_OPERATION_SHEET);
  initializeHeaders_(sheet, V12_OPERATION_HEADERS);
  const key = String(operationId || '');
  let existing = getOperationRowV12_(spreadsheet, key);
  const now = new Date().toISOString();
  const row = existing ? existing.row : sheet.getLastRow() + 1;
  sheet.getRange(row, 1, 1, V12_OPERATION_HEADERS.length).setValues([[
    key, String(type || ''), String(userId || ''), String(entityId || ''), String(status || ''),
    existing ? existing.createdAt : now, now, JSON.stringify(result || null), String(error || '')
  ]]);
  v1210SetCachedRow_('SGO_OPERATION_ROW', key, row);
}


function operationDependencyInfoV12181_(spreadsheet, row) {
  const dependencyId=String(row&&(row.dependsOnOperationId||(row.payload&&row.payload.dependsOnOperationId))||'');
  if(!dependencyId)return {hasDependency:false,waitingDependency:false,dependsOnOperationId:'',dependencyStatus:''};
  try{
    const dep=typeof getCachedServerQueueStateV1210_==='function' ? (getCachedServerQueueStateV1210_(dependencyId) || (typeof getServerQueueRowV125_==='function' ? getServerQueueRowV125_(spreadsheet,dependencyId) : null)) : null;
    const status=String(dep&&dep.status||'').toUpperCase();
    return {hasDependency:true,waitingDependency:['COMPLETED','EFFECTS_PENDING','CONFLICT','REJECTED'].indexOf(status)<0,dependsOnOperationId:dependencyId,dependencyStatus:status||'MISSING'};
  }catch(ignored){return {hasDependency:true,waitingDependency:true,dependsOnOperationId:dependencyId,dependencyStatus:'UNKNOWN'};}
}

function getOperationStatusServer(payload) {
  payload = payload || {};
  let auth;
  try { auth = requireSessionV12_(payload, true); } catch (error) { return errorResponse_('SESSION_INVALID', 'Sua sessão expirou. Entre novamente.', getDatabaseVersion_(), String(payload.operationId || '')); }
  const operationId = String(payload.operationId || '');
  const spreadsheet = getSpreadsheet_();

  // v12.10: tarefas assíncronas vivem na fila do servidor. Consultamos primeiro
  // o cache/queue para evitar um TextFinder em SGO_OPERACOES a cada polling.
  if (typeof getCachedServerQueueStateV1210_ === 'function') {
    const cached = getCachedServerQueueStateV1210_(operationId);
    if (cached) {
      if (cached.userId && cached.userId !== auth.user.id && auth.user.perfil !== 'admin') {
        return successResponse_({ operationId:operationId, databaseVersion:getDatabaseVersion_(), data:{ status:'not_found' } });
      }
      const cachedMap = { COMPLETED:'completed', EFFECTS_PENDING:'completed', CONFLICT:'conflict', REJECTED:'rejected', PROCESSING:'processing', RECEIVED:'received' };
      const cachedStatus = cachedMap[String(cached.status || '').toUpperCase()] || 'received';
      if (cachedStatus === 'received' || cachedStatus === 'processing' || cached.result) {
        const depInfoV12181=operationDependencyInfoV12181_(spreadsheet,cached);
        return successResponse_({ operationId:operationId, databaseVersion:getDatabaseVersion_(), data:Object.assign({ status:cachedStatus, result:cached.result || null, error:cached.error || '', nextAttemptAt:String(cached.nextAttemptAt || '') },depInfoV12181) });
      }
    }
  }

  if (typeof getServerQueueRowV125_ === 'function') {
    const queued = getServerQueueRowV125_(spreadsheet, operationId);
    if (queued) {
      if (queued.userId && queued.userId !== auth.user.id && auth.user.perfil !== 'admin') {
        return successResponse_({ operationId:operationId, databaseVersion:getDatabaseVersion_(), data:{ status:'not_found' } });
      }
      const statusMap = { COMPLETED:'completed', EFFECTS_PENDING:'completed', CONFLICT:'conflict', REJECTED:'rejected', PROCESSING:'processing', RECEIVED:'received' };
      const status = statusMap[String(queued.status || '').toUpperCase()] || 'received';
      const depInfoV12181=operationDependencyInfoV12181_(spreadsheet,queued);
      return successResponse_({ operationId:operationId, databaseVersion:getDatabaseVersion_(), data:Object.assign({ status:status, result:queued.result || null, error:queued.error || '', nextAttemptAt:String(queued.nextAttemptAt || '') },depInfoV12181) });
    }
  }

  // Compatibilidade com operações não-tarefa e versões anteriores.
  const row = getOperationRowV12_(spreadsheet, operationId);
  if (!row || (row.userId && row.userId !== auth.user.id && auth.user.perfil !== 'admin')) {
    return successResponse_({ operationId: operationId, databaseVersion: getDatabaseVersion_(), data: { status: 'not_found' } });
  }
  return successResponse_({ operationId: operationId, databaseVersion: getDatabaseVersion_(), data: { status: row.status.toLowerCase(), result: row.result, error: row.error } });
}


/**
 * Diagnostico seguro do login v12.16.0. Execute apenas no editor Apps Script.
 * Nao retorna hashes nem PINs.
 */

/**
 * Diagnóstico de desempenho do acesso v12.16.0.
 * Execute no editor Apps Script quando quiser medir as leituras que compõem
 * o caminho crítico do login. Não retorna PINs, hashes ou tokens.
 */
function diagnoseV12152AccessPerformance() {
  if (typeof trustedEditorExecutionV1215_ === 'function' && !trustedEditorExecutionV1215_()) {
    throw new Error('EDITOR_EXECUTION_REQUIRED');
  }
  const spreadsheet = getSpreadsheet_();
  const totalStartedAt = Date.now();
  const timings = {};
  const rows = {};

  let startedAt = Date.now();
  readLegacyConfigV12152_(spreadsheet);
  timings.legacyConfigMs = Date.now() - startedAt;

  ['collaborators','processes','tasks','conversations','messages','activity','audits','feedbacks','notifications'].forEach(function(collection){
    const sheetName = V10_COLLECTIONS[collection];
    const sheet = sheetName ? spreadsheet.getSheetByName(sheetName) : null;
    rows[collection] = sheet ? Math.max(0, sheet.getLastRow() - 1) : 0;
  });

  ['collaborators','processes','tasks'].forEach(function(collection){
    const t = Date.now();
    const records = readCollectionRecords_(spreadsheet, collection, false);
    timings[collection + 'ReadMs'] = Date.now() - t;
    timings[collection + 'Records'] = records.length;
  });

  timings.totalDiagnosticMs = Date.now() - totalStartedAt;
  return {
    success:true,
    confirmed:true,
    version:String(typeof SGO_APP_VERSION_V1215!=='undefined'?SGO_APP_VERSION_V1215:'12.18.1'),
    timings:timings,
    rows:rows,
    target:{openMs:2000,loginCoreMs:1800},
    note:'O login v12.18.4 bloqueia somente em configuração, colaboradores, processos e tarefas. Demais módulos carregam depois.'
  };
}

function diagnoseV12151Login() {
  requireAdminOrEditorV12_({});
  const spreadsheet = getSpreadsheet_();
  const legacy = readLegacyStateV12_(spreadsheet) || {};
  const security = legacy.security && typeof legacy.security === 'object' ? legacy.security : {};
  const hashes = security.pinHashes && typeof security.pinHashes === 'object' ? security.pinHashes : {};
  const collaborators = readCollectionRecords_(spreadsheet, 'collaborators', false);
  const props = PropertiesService.getScriptProperties().getProperties();
  const summary = { legacy:0, v2:0, missing:0 };
  const missingUsers = [];
  collaborators.forEach(function(person){
    if (!person || !person.id || person.ativo === false) return;
    const hash = String(hashes[String(person.id)] || '');
    if (!hash) { summary.missing += 1; missingUsers.push({id:String(person.id), nome:String(person.nome||''), email:String(person.email||'')}); }
    else if (hash.indexOf('v2:') === 0) summary.v2 += 1;
    else summary.legacy += 1;
  });
  const lockouts = Object.keys(props).filter(function(key){ return key.indexOf(V1215_LOGIN_ATTEMPT_PREFIX) === 0; }).length;
  const stateBuildFailures = [];
  collaborators.forEach(function(person){
    if (!person || !person.id || person.ativo === false) return;
    try { buildScopedStateV12_(spreadsheet, person); }
    catch (error) { stateBuildFailures.push({ userId:String(person.id), nome:String(person.nome||''), email:String(person.email||''), error:safeErrorMessage_(error) }); }
  });
  const result = {
    success:true, confirmed:true, version:SGO_APP_VERSION_V1215,
    activeCollaborators:collaborators.filter(function(p){return p && p.ativo !== false;}).length,
    credentials:summary,
    pepperConfigured:Boolean(String(props[V1215_CREDENTIAL_PEPPER_PROP] || '')),
    loginThrottleRecords:lockouts,
    missingUsers:missingUsers,
    stateBuildFailures:stateBuildFailures,
    databaseVersion:getDatabaseVersion_(),
    message:'Diagnostico de login concluido sem expor credenciais.'
  };
  try { Logger.log(JSON.stringify(result)); } catch (ignored) {}
  return result;
}

/**
 * Recuperacao segura do login v12.16.0. Execute apenas no editor Apps Script.
 * - limpa bloqueios de tentativa;
 * - cria credenciais somente para usuarios que nao possuem nenhuma;
 * - se a chave v2 foi perdida, redefine SOMENTE credenciais v2 irrecuperaveis;
 * - preserva credenciais legadas validas.
 * Os PINs temporarios retornados aparecem uma unica vez no Logger.
 */
function repairV12151LoginAccess() {
  requireAdminOrEditorV12_({});
  const spreadsheet = getSpreadsheet_();
  const propsService = PropertiesService.getScriptProperties();
  const allProps = propsService.getProperties();
  Object.keys(allProps).forEach(function(key){
    if (key.indexOf(V1215_LOGIN_ATTEMPT_PREFIX) === 0) {
      propsService.deleteProperty(key);
      try { CacheService.getScriptCache().remove(key); } catch (ignored) {}
    }
  });

  const legacy = readLegacyStateV12_(spreadsheet) || {};
  legacy.security = legacy.security && typeof legacy.security === 'object' ? legacy.security : {};
  legacy.security.pinHashes = legacy.security.pinHashes && typeof legacy.security.pinHashes === 'object' ? legacy.security.pinHashes : {};
  const hashes = legacy.security.pinHashes;
  const collaborators = readCollectionRecords_(spreadsheet, 'collaborators', false);
  const hadPepper = Boolean(String(propsService.getProperty(V1215_CREDENTIAL_PEPPER_PROP) || ''));
  if (!hadPepper) credentialPepperV1215_();
  const temporaryPins = [];
  let changed = false;

  collaborators.forEach(function(person){
    if (!person || !person.id || person.ativo === false) return;
    const userId = String(person.id);
    const stored = String(hashes[userId] || '');
    const needsCredential = !stored;
    const unrecoverableV2 = !hadPepper && stored.indexOf('v2:') === 0;
    if (!needsCredential && !unrecoverableV2) return;
    const pin = randomTemporaryPinV1215_();
    hashes[userId] = credentialHashV1215_(userId, pin);
    temporaryPins.push({ userId:userId, nome:String(person.nome||''), email:String(person.email||''), reason:unrecoverableV2?'v2_key_recovered':'missing_credential', pin:pin });
    changed = true;
  });

  if (changed) writeLegacyStateV12_(spreadsheet, legacy);
  try { cleanupExpiredSessionsV1215_(); } catch (ignored) {}
  try { setMetaValue_('APP_VERSION', SGO_APP_VERSION_V1215); } catch (ignored) {}
  const result = {
    success:true, confirmed:true, version:SGO_APP_VERSION_V1215,
    clearedLoginThrottles:true,
    pepperWasPresent:hadPepper,
    credentialsChanged:temporaryPins.length,
    temporaryPins:temporaryPins,
    message: temporaryPins.length
      ? 'Recuperacao concluida. Use os PINs temporarios listados no retorno para os usuarios afetados.'
      : 'Recuperacao concluida. Nenhuma credencial existente foi alterada; bloqueios de login foram limpos.'
  };
  try { Logger.log(JSON.stringify(result)); } catch (ignored) {}
  return result;
}

function resetUserPinServer(payload) {
  payload = payload || {};
  let auth;
  try { auth = requireSessionV12_(payload, true); } catch (error) { return errorResponse_('SESSION_INVALID', 'Sua sessão expirou.', getDatabaseVersion_(), Utilities.getUuid()); }
  if (String(auth.user.perfil || '') !== 'admin') return errorResponse_('PERMISSION_DENIED', 'Somente administradores podem redefinir PINs.', getDatabaseVersion_(), Utilities.getUuid());
  const userId = String(payload.userId || '');
  const pin = String(payload.pin || randomTemporaryPinV1215_());
  if (!/^\d{4,12}$/.test(pin)) return errorResponse_('INVALID_PIN', 'O PIN deve possuir entre 4 e 12 números.', getDatabaseVersion_(), Utilities.getUuid());
  const lock = tryWriteLockV12_(5000);
  if (!lock) return serverBusyV12_(Utilities.getUuid());
  try {
    const spreadsheet = getSpreadsheet_();
    const target = getRecordMeta_(spreadsheet, 'collaborators', userId);
    if (!target || target.deleted) return errorResponse_('USER_NOT_FOUND', 'Usuário não encontrado.', getDatabaseVersion_(), Utilities.getUuid());
    const legacy = readLegacyStateV12_(spreadsheet);
    legacy.security = legacy.security || {};
    legacy.security.pinHashes = legacy.security.pinHashes || {};
    legacy.security.pinHashes[userId] = credentialHashV1215_(userId, pin);
    writeLegacyStateV12_(spreadsheet, legacy);
    return successResponse_({ operationId: Utilities.getUuid(), databaseVersion: getDatabaseVersion_(), data: { reset: true, temporaryPin: pin } });
  } finally { lock.releaseLock(); }
}

function cleanupExpiredSessionsV1215_() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const now = Date.now();
  let removed = 0;
  Object.keys(all).forEach(function(key) {
    if (key.indexOf(V12_SESSION_PREFIX) !== 0 && key.indexOf(V1215_LOGIN_ATTEMPT_PREFIX) !== 0) return;
    let data = null; try { data = JSON.parse(String(all[key] || 'null')); } catch (ignored) {}
    const expiresAt = Number(data && (data.expiresAt || data.lockedUntil) || 0);
    if (!data || (expiresAt && expiresAt <= now)) { props.deleteProperty(key); try { CacheService.getScriptCache().remove(key); } catch (ignored) {} removed += 1; }
  });
  return { removed:removed };
}

function trustedEditorExecutionV1215_() {
  const active = SpreadsheetApp.getActiveSpreadsheet();
  const configuredId = PropertiesService.getScriptProperties().getProperty(SPREADSHEET_ID_PROPERTY);
  if (!active || (configuredId && active.getId() !== configuredId)) return false;
  // Em execução real do Apps Script, o editor direto possui identidade ativa e
  // efetiva iguais. Em Web App executado como proprietário, o effectiveUser é
  // o proprietário e o activeUser é o visitante (ou vazio), o que bloqueia a
  // tentativa de usar funções administrativas sem sessionToken.
  try {
    if (typeof Session !== 'undefined' && Session.getActiveUser && Session.getEffectiveUser) {
      const activeEmail = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
      const effectiveEmail = String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
      if (!activeEmail || !effectiveEmail || activeEmail !== effectiveEmail) return false;
    }
  } catch (error) { return false; }
  return true;
}

function trustedTriggerInvocationV1215_(handlerName, event) {
  const triggerUid = String(event && event.triggerUid || '');
  if (!triggerUid) return false;
  try {
    return (ScriptApp.getProjectTriggers() || []).some(function(trigger){
      const handlerMatches = String(trigger.getHandlerFunction() || '') === String(handlerName || '');
      const uid = typeof trigger.getUniqueId === 'function' ? String(trigger.getUniqueId() || '') : '';
      return handlerMatches && uid && uid === triggerUid;
    });
  } catch (ignored) { return false; }
}

/** Autoriza operações administrativas pela sessão de administrador ou pelo editor vinculado à planilha. */
function requireAdminOrEditorV12_(payload) {
  payload = payload || {};
  if (payload.sessionToken) {
    const auth = requireSessionV12_(payload, true);
    if (String(auth.user.perfil || '') !== 'admin') throw new Error('PERMISSION_DENIED: somente administradores podem executar esta operação.');
    return auth;
  }
  if (!trustedEditorExecutionV1215_()) {
    throw new Error('EDITOR_EXECUTION_REQUIRED: execute esta função diretamente no editor Apps Script vinculado à planilha ou use uma sessão de administrador.');
  }
  return { user: { id: 'editor', perfil: 'admin', nome: 'Editor Apps Script' }, editor: true };
}
