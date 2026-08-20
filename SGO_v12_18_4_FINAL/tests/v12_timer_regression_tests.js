const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'Index.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'V12_TaskOperations.gs'), 'utf8');
function assert(cond, msg) { if (!cond) throw new Error(msg); }

assert(index.includes('<option value="Tarefa cronometrada" disabled>Tarefa cronometrada</option>'), 'Tipo cronometrado precisa existir no select.');
assert(index.includes("var isTimedQuickTask = Boolean(existingTask && ((existingTask.tipo === 'Tarefa cronometrada') || taskTimerEnabled(existingTask)));"), 'Validação precisa reconhecer cronômetro pelo registro.');
assert(index.includes("if (!isTimedQuickTask && (!Number.isFinite(estimate) || estimate <= 0))"), 'Estimativa > 0 não pode bloquear tarefa cronometrada.');
assert(index.includes("if (!isTimedQuickTask && (!due || Number.isNaN(new Date(due).getTime())))"), 'Prazo não pode bloquear tarefa cronometrada.');
assert(index.includes("tipo: existingTimedQuickTask ? 'Tarefa cronometrada' : document.getElementById('taskType').value"), 'Edição deve preservar tipo cronometrado.');
assert(index.includes("estimativa: existingTimedQuickTask ? 1"), 'Tarefa cronometrada deve manter esforço estimado padrão de 1 hora.');
assert(server.includes("Boolean(task.timeTracking && task.timeTracking.enabled)"), 'Servidor deve reconhecer timeTracking.enabled.');
assert(server.includes("Boolean(currentTask && currentTask.timeTracking && currentTask.timeTracking.enabled)"), 'Servidor deve recuperar registros legados cronometrados.');
console.log('V12_TIMER_REGRESSION_TESTS_OK', JSON.stringify({tests:8}));
