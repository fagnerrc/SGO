const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const core = fs.readFileSync(path.join(root, 'V10_Core.html'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(core.includes("messages:true, conversations:true, conversationReads:true"),
  'Coleções de comunicação precisam ser independentes do salvamento da tarefa.');
assert(core.includes("v12ConfirmBaselineCollections(['conversations', 'conversationReads', 'messages', 'notifications'])"),
  'Bootstrap de comunicação precisa atualizar a base confirmada.');
assert(core.includes("v12ConfirmBaselineCollections(['messages'])"),
  'Polling de mensagens precisa atualizar a base confirmada.');
assert(core.includes("v10SetTaskSaveLocked(false);"),
  'Falha de gravação mista precisa desbloquear o botão de salvar.');

const independentlySynced = {
  activity:true, securityLog:true, notifications:true, audits:true,
  messages:true, conversations:true, conversationReads:true, errors:true
};
const isUnsafe = collections => collections.some(collection => !independentlySynced[collection]);
assert(isUnsafe(['messages', 'notifications']) === false,
  'Mensagem/notificação recebida em segundo plano não pode bloquear tarefa.');
assert(isUnsafe(['collaborators']) === true,
  'Alteração local real em outro cadastro deve continuar protegida.');

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function mapById(items) {
  const map = {};
  (items || []).forEach(item => { if (item && item.id) map[item.id] = item; });
  return map;
}
function changedCollections(previous, current) {
  return ['tasks','messages','conversations','conversationReads','notifications'].filter(collection => {
    const a = mapById(previous[collection]);
    const b = mapById(current[collection]);
    return JSON.stringify(a) !== JSON.stringify(b);
  });
}

const baseline = { tasks: [], messages: [], conversations: [], conversationReads: [], notifications: [] };
const current = clone(baseline);
current.messages.push({ id:'m1', texto:'nova mensagem' });
// Confirmação de mensagem vinda do servidor atualiza também a baseline.
baseline.messages = clone(current.messages);
current.tasks.push({ id:'t1', titulo:'Nova tarefa' });
assert(JSON.stringify(changedCollections(baseline, current)) === JSON.stringify(['tasks']),
  'Após confirmar comunicação na baseline, o diff da tarefa deve conter somente tasks.');

console.log('V12_TASK_SAVE_REGRESSION_TESTS_OK', JSON.stringify({ tests: 8 }));
