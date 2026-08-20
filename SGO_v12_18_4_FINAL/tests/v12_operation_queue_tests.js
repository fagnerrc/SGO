const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'Index.html'), 'utf8');
const marker = 'var QUEUE_SCHEMA_VERSION';
const pos = html.indexOf(marker);
if (pos < 0) throw new Error('Módulo da fila não encontrado.');
const code = html.slice(pos);
const checks = [
  ['fila persistente', /sgo_v12_1_operation_outbox/],
  ['estados da fila', /queued[\s\S]*retry_wait[\s\S]*sending[\s\S]*conflict[\s\S]*rejected/],
  ['operationId preservado', /operationId:operationId/],
  ['envio imediato', /queueProcessSoon\(0\)/],
  ['backoff progressivo', /\[0, 3000, 10000, 30000, 60000, 180000\]/],
  ['sincronização geral de três minutos', /180000 \+ Math\.floor\(Math\.random\(\) \* 10000\)/],
  ['chat aberto em oito segundos', /currentPage === 'chat' \? 8000 : 60000/],
  ['modal fecha após fila local', /V10_LEGACY\.closeModal\(context\.modalId\)/],
  ['salvamento não exige preflight', /saveTaskFromForm = function[\s\S]*v10BeginOperation[\s\S]*V10_LEGACY\.saveTaskFromForm/],
  ['mensagens também usam fila', /kind:'message'[\s\S]*serverFunction:'sendMessageServer'/],
  ['processamento respeita dependência por entidade', /queueHasEarlierDependency/],
  ['operações sobrevivem recarregamento', /storageGet\(QUEUE_KEY\)[\s\S]*storageSet\(QUEUE_KEY/],
  ['fila não bloqueia botão por sincronização', /v10SetTaskSaveLocked = function \(\)/],
  ['sincronização ao voltar para aba', /visibilitychange[\s\S]*v10SyncNow\(false\)/],
  ['sincronização ao reconectar', /window\.addEventListener\('online'[\s\S]*queueProcessSoon\(0\)/],
  ['efeitos locais de tarefa não usam commit genérico', /TASK_SIDE_EFFECT_COLLECTIONS[\s\S]*taskContext[\s\S]*TASK_SIDE_EFFECT_COLLECTIONS\[collection\]/],
  ['coleções dedicadas nunca usam commit genérico', /DEDICATED_COLLECTIONS\[collection\]/],
  ['fila antiga é migrada automaticamente', /function queueMigrateStoredItems\([\s\S]*QUEUE_SCHEMA_VERSION/],
  ['erro de estimativa não repete indefinidamente', /INVALID_ESTIMATE: true/]
];
for (const [name, regex] of checks) {
  if (!regex.test(code)) throw new Error(`Falhou: ${name}`);
}
if (/preflightWriteServer[\s\S]*V10_LEGACY\.saveTaskFromForm/.test(code.slice(code.indexOf('saveTaskFromForm = function'), code.indexOf('var patchCollectionBeforeQueue')))) {
  throw new Error('O override final de tarefa ainda executa preflight bloqueante.');
}
console.log('V12_OPERATION_QUEUE_TESTS_OK', JSON.stringify({ tests: checks.length }));
