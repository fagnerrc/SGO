'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const corePath = path.join(__dirname, '..', 'V10_Core.html');
const source = fs.readFileSync(corePath, 'utf8');

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Função não encontrada: ${name}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Função incompleta: ${name}`);
}

const context = {
  SGO_V10: { operationContext: null },
  v10OperationId: () => 'op-test-001',
  Date,
  console
};
vm.createContext(context);
vm.runInContext(`${extractFunction('v12InferTaskAction')}\n${extractFunction('v10BeginOperation')}`, context);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const base = {
  id: 'T-1',
  status: 'Em andamento',
  timeTracking: { state: 'running', startedAt: '2026-08-06T10:00:00.000Z', activeStartedAt: '2026-08-06T10:00:00.000Z' }
};

context.SGO_V10.operationContext = { taskAction: 'update' };
assert(
  context.v12InferTaskAction({ deleted: false, data: { ...base, status: 'Concluída', timeTracking: { ...base.timeTracking, state: 'completed' } } }, base) === 'complete',
  'Conclusão deve ser inferida mesmo quando o hint genérico for update.'
);

context.SGO_V10.operationContext = { taskAction: 'update' };
assert(
  context.v12InferTaskAction({ deleted: false, data: { ...base, timeTracking: { ...base.timeTracking, state: 'paused' } } }, base) === 'pause',
  'Pausa deve ser inferida pela transição do cronômetro.'
);

const paused = { ...base, timeTracking: { ...base.timeTracking, state: 'paused' } };
context.SGO_V10.operationContext = { taskAction: 'update' };
assert(
  context.v12InferTaskAction({ deleted: false, data: { ...paused, timeTracking: { ...paused.timeTracking, state: 'running' } } }, paused) === 'resume',
  'Retomada deve ser inferida pela transição do cronômetro.'
);

const neverStarted = { ...base, timeTracking: { state: 'idle', startedAt: '' } };
context.SGO_V10.operationContext = { taskAction: 'update' };
assert(
  context.v12InferTaskAction({ deleted: false, data: { ...neverStarted, timeTracking: { state: 'running', startedAt: '2026-08-06T10:00:00.000Z' } } }, neverStarted) === 'start',
  'Primeiro início deve ser inferido corretamente.'
);

context.SGO_V10.operationContext = null;
context.v10BeginOperation({
  module: 'tasks',
  taskId: 'T-1',
  taskAction: 'complete',
  operationId: 'fixed-op',
  draft: { evidence: 'Arquivo anexado' }
});
assert(context.SGO_V10.operationContext.taskAction === 'complete', 'v10BeginOperation deve preservar taskAction.');
assert(context.SGO_V10.operationContext.operationId === 'fixed-op', 'v10BeginOperation deve preservar operationId.');
assert(context.SGO_V10.operationContext.taskId === 'T-1', 'v10BeginOperation deve preservar taskId.');
assert(context.SGO_V10.operationContext.pending === true, 'Nova operação deve iniciar pendente.');

context.SGO_V10.operationContext = null;
context.v10BeginOperation({ module: 'tasks', taskAction: 'pause' });
assert(context.SGO_V10.operationContext.operationId === 'op-test-001', 'Deve gerar operationId quando não fornecido.');
assert(context.SGO_V10.operationContext.taskAction === 'pause', 'Ação explícita de pausa deve ser preservada.');

assert(source.includes('> 1800000'), 'A reconciliação completa deve ocorrer em intervalo de 30 minutos, não a cada 5 minutos.');

console.log('V12_FRONTEND_BEHAVIOR_TESTS_OK', JSON.stringify({ tests: 11 }));
