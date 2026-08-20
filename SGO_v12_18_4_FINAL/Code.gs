const DB_SHEET = 'SGO_DB';
const BACKUP_SHEET = 'SGO_BACKUP';
const CONTROL_SHEET = 'CONTROLE';
const SPREADSHEET_ID_PROPERTY = 'SGO_SPREADSHEET_ID';
const CHUNK_SIZE = 40000;

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('SGO Grupo Quintão')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Execute uma vez a partir do editor vinculado à planilha. */
function setupSGO() {
  // setupSGO é uma função administrativa exposta pelo Apps Script. Exigimos
  // execução direta no editor para impedir chamadas anônimas pelo Web App.
  if (typeof trustedEditorExecutionV1215_ === 'function' && !trustedEditorExecutionV1215_()) {
    throw new Error('EDITOR_EXECUTION_REQUIRED: execute setupSGO diretamente no editor Apps Script vinculado à planilha.');
  }
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) {
    throw new Error('Abra este projeto por Extensões > Apps Script dentro da Planilha Google.');
  }

  PropertiesService.getScriptProperties()
    .setProperty(SPREADSHEET_ID_PROPERTY, spreadsheet.getId());

  if (!spreadsheet.getSheetByName(CONTROL_SHEET)) {
    spreadsheet.insertSheet(CONTROL_SHEET);
  }

  const databaseSheet = getOrCreateSheet_(spreadsheet, DB_SHEET);
  const backupSheet = getOrCreateSheet_(spreadsheet, BACKUP_SHEET);

  initializeSheet_(databaseSheet);
  initializeSheet_(backupSheet);

  databaseSheet.hideSheet();
  backupSheet.hideSheet();

  const setupResult = setupSGOV10();
  if (setupResult && typeof setupResult === 'object') {
    setupResult.message = 'Banco de dados do SGO v12.18.4 preparado com sucesso.';
    return setupResult;
  }
  return { success:true, confirmed:true, message:'Banco de dados do SGO v12.18.4 preparado com sucesso.', data:{ temporaryPins:[] } };
}

/** Compatibilidade de leitura para restauração e diagnóstico. */
function loadStateServer(payload) {
  payload = payload || {};
  if (!payload.sessionToken) return loadPublicBootstrapServer();
  let auth;
  try { auth = requireSessionV12_(payload, true); }
  catch (error) { return errorResponse_('SESSION_INVALID', 'Sua sessão expirou. Entre novamente.', getDatabaseVersion_(), Utilities.getUuid()); }
  return successResponse_({
    operationId: Utilities.getUuid(),
    databaseVersion: getDatabaseVersion_(),
    data: { state: buildScopedStateV12_(getSpreadsheet_(), auth.user), changeSequence: getChangeSequenceV12_() }
  });
}

/**
 * Entrada legada. Depois da ativação da v10, gravações integrais são bloqueadas
 * para impedir que uma sessão antiga substitua registros mais novos.
 */
function saveStateServer(state) {
  requireAdminOrEditorV12_({});
  if (isV10Active_()) {
    throw new Error('LEGACY_WRITE_BLOCKED: atualize o SGO para a versão 12 antes de gravar.');
  }
  if (!state || typeof state !== 'object') {
    throw new Error('O estado recebido pelo servidor é inválido.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const spreadsheet = getSpreadsheet_();
    const databaseSheet = getOrCreateSheet_(spreadsheet, DB_SHEET);
    const backupSheet = getOrCreateSheet_(spreadsheet, BACKUP_SHEET);

    initializeSheet_(databaseSheet);
    initializeSheet_(backupSheet);

    const currentJson = readJson_(databaseSheet);
    if (currentJson) writeJson_(backupSheet, currentJson);

    writeJson_(databaseSheet, JSON.stringify(state));
    SpreadsheetApp.flush();

    return {
      ok: true,
      savedAt: new Date().toISOString()
    };
  } finally {
    lock.releaseLock();
  }
}

function restoreServerBackup(payload) {
  payload = payload || {};
  const auth = requireAdminOrEditorV12_(payload);
  const operationId = String(payload.operationId || Utilities.getUuid());
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const spreadsheet = getSpreadsheet_();
    const backupSheet = getOrCreateSheet_(spreadsheet, BACKUP_SHEET);
    const backupJson = readJson_(backupSheet);
    if (!backupJson) throw new Error('Não existe uma cópia automática disponível.');
    let snapshot;
    try { snapshot = JSON.parse(backupJson); }
    catch (error) { throw new Error('A cópia automática está corrompida e não pode ser restaurada.'); }
    return restoreStateSnapshotV12_(spreadsheet, snapshot, String(auth.user.id || 'editor'), operationId, 'Restauração da cópia automática');
  } finally {
    lock.releaseLock();
  }
}

function getDatabaseStatus(payload) {
  requireAdminOrEditorV12_(payload || {});
  const spreadsheet = getSpreadsheet_();
  const databaseSheet = getOrCreateSheet_(spreadsheet, DB_SHEET);
  const json = readJson_(databaseSheet);

  return {
    spreadsheetName: spreadsheet.getName(),
    hasData: Boolean(json),
    characters: String(json || '').length,
    databaseVersion: getDatabaseVersion_(),
    v10Active: isV10Active_(),
    checkedAt: new Date().toISOString()
  };
}

function getSpreadsheet_() {
  const id = PropertiesService.getScriptProperties()
    .getProperty(SPREADSHEET_ID_PROPERTY);

  if (!id) {
    throw new Error('Execute a função setupSGO novamente antes de usar o aplicativo.');
  }

  return SpreadsheetApp.openById(id);
}

function getOrCreateSheet_(spreadsheet, sheetName) {
  return spreadsheet.getSheetByName(sheetName) || spreadsheet.insertSheet(sheetName);
}

function initializeSheet_(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, 3).setValues([
      ['ORDEM', 'CONTEÚDO', 'ATUALIZADO_EM']
    ]);
    sheet.setFrozenRows(1);
  }
}

function readJson_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return '';

  return sheet
    .getRange(2, 1, lastRow - 1, 2)
    .getValues()
    .filter(function (row) {
      return row[0] !== '' && row[1] !== '';
    })
    .sort(function (a, b) {
      return Number(a[0]) - Number(b[0]);
    })
    .map(function (row) {
      return String(row[1]);
    })
    .join('');
}

function writeJson_(sheet, json) {
  const chunks = [];

  for (let position = 0; position < json.length; position += CHUNK_SIZE) {
    chunks.push(json.slice(position, position + CHUNK_SIZE));
  }

  sheet.clearContents();
  sheet.getRange(1, 1, 1, 3).setValues([
    ['ORDEM', 'CONTEÚDO', 'ATUALIZADO_EM']
  ]);

  if (chunks.length) {
    const updatedAt = new Date();
    const rows = chunks.map(function (chunk, index) {
      return [index + 1, chunk, index === 0 ? updatedAt : ''];
    });
    sheet.getRange(2, 1, rows.length, 3).setValues(rows);
  }

  sheet.setFrozenRows(1);
}
