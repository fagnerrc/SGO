'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'Index.html'), 'utf8');
const start = html.indexOf('/* SGO v12.6 — fila transacional + conclusão cronometrada consistente. */');
const end = html.indexOf('\ninitFromGoogleSheets();', start);
if (start < 0 || end < 0) throw new Error('Módulo da fila não localizado.');
const moduleCode = html.slice(start, end);
const storage = new Map();
let closedModal = '';
let lastToast = null;
let nextTimerId = 1;
const timers = new Map();
const oldTask = { id:'T-1', titulo:'Antes', status:'Em andamento', _recordVersion:3, timeTracking:{state:'paused'} };
const newTask = { id:'T-1', titulo:'Depois', status:'Em andamento', _recordVersion:3, timeTracking:{state:'paused'} };
const context = {
  console,
  Date,
  JSON,
  Math,
  Promise,
  Number,
  String,
  Object,
  Array,
  Infinity,
  window: null,
  navigator: { onLine:true },
  document: {
    hidden:false,
    body:{ appendChild(){}, },
    head:{ appendChild(){} },
    getElementById(){ return null; },
    querySelector(){ return null; },
    createElement(){ return { className:'', id:'', type:'', title:'', innerHTML:'', style:{}, classList:{toggle(){},add(){},remove(){}}, addEventListener(){}, appendChild(){}, set textContent(v){this._text=v;}, get textContent(){return this._text;} }; },
    addEventListener(){}
  },
  setTimeout(fn, delay){ const id=nextTimerId++; timers.set(id,{fn,delay}); return id; },
  clearTimeout(id){ timers.delete(id); },
  setInterval(){ return nextTimerId++; },
  clearInterval(){},
  storageGet(k){ return storage.has(k)?storage.get(k):null; },
  storageSet(k,v){ storage.set(k,String(v)); return true; },
  currentUser(){ return {id:'U-1', perfil:'admin'}; },
  currentUserId:'U-1',
  state:{tasks:[{...newTask}],messages:[],feedbacks:[],notifications:[],collaborators:[],processes:[],audits:[],activity:[],securityLog:[],errors:[],conversations:[],conversationReads:[]},
  SGO_V10:{sessionValidated:true,sessionToken:'token',status:'updated',lastSyncedState:{tasks:[{...oldTask}],messages:[],feedbacks:[],notifications:[],collaborators:[],processes:[],audits:[],activity:[],securityLog:[],errors:[],conversations:[],conversationReads:[]},databaseVersion:10,changeSequence:20,operationContext:{operationId:'OP-1',module:'tasks',modalId:'taskModal',taskAction:'update',pending:true,successTitle:'Salvar'},queueTimer:null},
  V10_LEGACY:{toast(t,m,type){lastToast={t,m,type};},closeModal(id){closedModal=id;},saveTaskFromForm(){}},
  V10_TRACKED_COLLECTIONS:['tasks','messages','feedbacks','notifications','collaborators','processes','audits','activity','securityLog','errors','conversations','conversationReads'],
  V10_SYSTEM_FIELDS:['companies','settings','organization','security','branding'],
  toast(){},
  saveTaskFromForm(){},
  v10CanStartWrite(){return true;},
  v10SetTaskSaveLocked(){},
  v10SaveState(){},
  v10CommitPendingChanges(){},
  v10StartBackgroundServices(){},
  v12ScheduleChatPolling(){},
  v10SendActiveChatMessage(){},
  v12PatchCollection(collection,id,data,deleted){
    const list=context.state[collection]||(context.state[collection]=[]);
    const i=list.findIndex(x=>x.id===id);
    if(deleted){if(i>=0)list.splice(i,1);return;}
    if(i>=0)list[i]=JSON.parse(JSON.stringify(data)); else list.push(JSON.parse(JSON.stringify(data)));
  },
  v12ApplyState(){},
  v10Clone(v){return JSON.parse(JSON.stringify(v));},
  v10EnsureCollections(target){ for(const c of context.V10_TRACKED_COLLECTIONS) if(!Array.isArray(target[c])) target[c]=[]; return target; },
  v10MapById(items){const m={};for(const x of items||[])if(x&&x.id)m[x.id]=x;return m;},
  v12InferTaskAction(){return 'update';},
  v12TaskServerFunction(){return 'updateTaskServer';},
  v10PersistLocal(){return true;},
  v10ClearTaskDraft(){},
  v10SetStatus(){},
  v10SyncNow(){},
  v10RenderChat(){},
  v10RenderNotifications(){},
  v12MergeUniqueRecords(){},
  v12ConfirmBaselineCollections(){},
  v12SessionPayload(x){return x;},
  v12ServerCall(){return Promise.resolve({success:true,confirmed:true,data:{changedRecords:[]}});},
  v12HandleSessionInvalid(){return false;},
  v12ApplyChangedRecords(){},
  v12RefreshAfterPatch(){},
  trackedElapsedMs(){return 0;},
  renderTimerDock(){},
  updateLiveTimerDisplays(){},
  v128DiagEvent(){},
  refreshIcons(){},
  escapeHTML(v){return String(v);},
  runningInGoogleAppsScript(){return true;},
  can(){return true;},
  validateTask(){return true;},
  v10CaptureTaskDraft(){return {};},
  v10BeginOperation(){},
  v10OperationId(){return 'GENERATED';},
  currentPage:'dashboard'
};
context.window=context;
context.addEventListener=function(){};
context.v10BuildDiff=function(){return {changes:[{collection:'tasks',id:'T-1',expectedVersion:3,data:{...newTask},deleted:false}],systemPatch:{}};};
vm.createContext(context);
vm.runInContext(moduleCode, context);
function assert(cond,msg){if(!cond)throw new Error(msg);}
const saved=context.v10SaveState({silent:true});
assert(saved===true,'Salvar local deve retornar sucesso.');
const queue=JSON.parse(storage.get('sgo_v12_5_operation_outbox'));
assert(queue.length===1,'Deve criar exatamente uma operação na fila.');
assert(queue[0].operationId==='OP-1','Deve preservar operationId.');
assert(queue[0].payload.expectedVersion===3,'Deve preservar versão esperada do servidor.');
assert(queue[0].predictedVersion===4,'Deve prever a próxima versão do registro.');
assert(queue[0].status==='queued','Operação deve iniciar na fila.');
assert(closedModal==='taskModal','Modal deve fechar após persistência local.');
assert(context.SGO_V10.operationContext===null,'Contexto bloqueante deve ser liberado.');
assert(lastToast && lastToast.t==='Salvo neste dispositivo','Usuário deve receber confirmação local correta.');

// v12.17: uma segunda edição ANTES do aceite do servidor deve coalescer na mesma operação.
context.SGO_V10.operationContext={operationId:'OP-2-COALESCE',module:'tasks',modalId:'',taskAction:'update',pending:true,successTitle:'Salvar'};
context.v10BuildDiff=function(){return {changes:[{collection:'tasks',id:'T-1',expectedVersion:4,data:{...newTask,titulo:'Terceira edição',_recordVersion:4},deleted:false}],systemPatch:{}};};
context.v10SaveState({silent:true});
let queue2=JSON.parse(storage.get('sgo_v12_5_operation_outbox'));
assert(queue2.length===1,'Segunda edição ainda não aceita deve coalescer na operação existente.');
assert(queue2[0].operationId==='OP-1','Coalescimento deve preservar o operationId já persistido.');
assert(queue2[0].payload.task.titulo==='Terceira edição','Coalescimento deve atualizar o snapshot pendente.');

// Depois que QUALQUER tentativa de rede começou, mesmo sem resposta/aceite confirmado,
// a operação antiga fica imutável: o servidor pode tê-la recebido. A nova edição B
// precisa de outro operationId para não trocar silenciosamente o payload no cliente.
queue2[0].serverAccepted=false; queue2[0].status='retry_wait'; queue2[0].attempts=1; queue2[0].lastAttemptAt=Date.now();
storage.set('sgo_v12_5_operation_outbox',JSON.stringify(queue2));
context.SGO_V10.operationContext={operationId:'OP-2',module:'tasks',modalId:'',taskAction:'update',pending:true,successTitle:'Salvar'};
context.v10BuildDiff=function(){return {changes:[{collection:'tasks',id:'T-1',expectedVersion:4,data:{...newTask,titulo:'Quarta edição',_recordVersion:4},deleted:false}],systemPatch:{}};};
context.v10SaveState({silent:true});
queue2=JSON.parse(storage.get('sgo_v12_5_operation_outbox'));
assert(queue2.length===2,'Edição após uma tentativa de rede deve ser uma nova operação, mesmo se a resposta se perdeu.');
assert(queue2[1].payload.expectedVersion===4,'Segunda ação deve esperar a versão prevista pela primeira.');
assert(queue2[0].entityKeys[0]===queue2[1].entityKeys[0],'Ações da mesma tarefa devem compartilhar a chave de ordenação.');

// v12.5: rejeição de validação não pode bloquear nem deixar versão fantasma na próxima operação.
context.__SGO_QUEUE_DEBUG__.setFailure(queue2[0], {success:false,confirmed:false,errorCode:'DELAY_REASON_REQUIRED',message:'Informe a justificativa de atraso.'}, null);
const afterReject=JSON.parse(storage.get('sgo_v12_5_operation_outbox'));
const rejected=afterReject.find(item=>item.operationId==='OP-1');
const rebased=afterReject.find(item=>item.operationId==='OP-2');
assert(rejected.status==='rejected','Operação inválida deve ficar para correção.');
assert(rebased.payload.expectedVersion===3,'Operação posterior deve voltar à versão real do servidor após rejeição.');
assert(rebased.predictedVersion===4,'Previsão posterior deve ser recalculada sem versão fantasma.');
assert(context.__SGO_QUEUE_DEBUG__.nextEligible(afterReject).operationId==='OP-2','Rejeição de validação não pode causar deadlock na fila.');

// Efeitos locais produzidos pelo código legado da tarefa não podem virar um commit genérico.
context.SGO_V10.operationContext={operationId:'OP-3',module:'tasks',modalId:'',taskAction:'update',pending:true,successTitle:'Tarefa atualizada'};
context.v10BuildDiff=function(){return {changes:[
  {collection:'tasks',id:'T-2',expectedVersion:0,data:{id:'T-2',titulo:'Nova',status:'Em andamento',_recordVersion:0,timeTracking:{state:'paused'}},deleted:false},
  {collection:'activity',id:'LOG-1',expectedVersion:0,data:{id:'LOG-1',text:'efeito local'},deleted:false},
  {collection:'securityLog',id:'SEC-1',expectedVersion:0,data:{id:'SEC-1',detail:'efeito local'},deleted:false},
  {collection:'notifications',id:'NOT-1',expectedVersion:0,data:{id:'NOT-1',message:'efeito local'},deleted:false},
  {collection:'audits',id:'AUD-1',expectedVersion:0,data:{id:'AUD-1',taskId:'T-2'},deleted:false}
],systemPatch:{}};};
context.v10SaveState({silent:true});
const queue3=JSON.parse(storage.get('sgo_v12_5_operation_outbox'));
assert(queue3.length===3,'Tarefa + efeitos locais devem gerar somente uma nova operação dedicada.');
assert(queue3[2].kind==='task','A nova operação precisa usar o fluxo dedicado de tarefas.');
assert(!queue3.some(item=>item.kind==='generic'&&item.module==='tasks'),'Efeitos da tarefa não podem gerar commit genérico.');
// v12.9: tarefa inexistente no servidor nunca pode iniciar a cadeia com START.
const unsaved={id:'T-NEW',titulo:'Cronometrada nova',empresa:'Empresa',area:'Tecnologia',responsavelId:'U-1',prioridade:'Normal',status:'Em andamento',progresso:1,_recordVersion:0,timeTracking:{enabled:true,state:'running',activeStartedAt:new Date().toISOString()}};
context.state.tasks.push(unsaved);
context.SGO_V10.serverState.tasks=context.SGO_V10.serverState.tasks.filter(t=>t.id!=='T-NEW');
context.SGO_V10.operationContext={operationId:'OP-NEW-START',module:'tasks',modalId:'',taskId:'T-NEW',taskAction:'start',pending:true,successTitle:'Iniciar'};
context.v10BuildDiff=function(){return {changes:[{collection:'tasks',id:'T-NEW',expectedVersion:0,data:{...unsaved},deleted:false}],systemPatch:{settings:{accidental:true}}};};
context.v10SaveState({silent:true});
const queue4=JSON.parse(storage.get('sgo_v12_5_operation_outbox'));
const newOp=queue4.find(item=>item.entityId==='T-NEW');
assert(newOp && newOp.action==='create','Tarefa ainda inexistente no servidor deve começar por CREATE.');
assert(newOp.payload.task.titulo==='Cronometrada nova','CREATE precisa carregar o snapshot completo da tarefa.');
assert(!queue4.some(item=>item.kind==='generic'&&item.module==='tasks'),'SystemPatch acidental durante tarefa não pode gerar commit genérico.');

// v12.17: cronômetro compacta CREATE + COMPLETE antes da primeira tentativa de rede.
// Os testes anteriores já validaram a ordenação genérica; isolamos aqui somente a cadeia do timer.
for (const key of Array.from(storage.keys())) { if (key==='sgo_v12_5_operation_outbox' || String(key).startsWith('sgo_v12_15_outbox_op_') || String(key).startsWith('sgo_v12_15_outbox_tombstone_')) storage.delete(key); }
context.SGO_V10.queueMemory=[];
storage.set('sgo_v12_5_operation_outbox','[]');
let timerOpSeq=0;
context.v10OperationId=function(){ timerOpSeq+=1; return 'TIMER-OP-'+timerOpSeq; };
const timedCreate={id:'T-TIMER-1',code:'SGO-TIMER-1',titulo:'Cronometrada',tipo:'Tarefa cronometrada',empresa:'Empresa',area:'Tecnologia',responsavelId:'U-1',estimativa:1,prioridade:'Normal',status:'Em andamento',progresso:25,prazo:'',prazoManual:false,prazoAutomatico:false,evidencia:'',justificativaAtraso:'',approvalStatus:'not_required',timeTracking:{enabled:true,state:'running',totalMs:0,activeStartedAt:new Date().toISOString(),startedAt:new Date().toISOString(),completedAt:'',lastChangedAt:new Date().toISOString(),sessions:[]}};
context.__SGO_QUEUE_DEBUG__.timerEnqueue(timedCreate,'create',new Date().toISOString());
let timerQueue=context.__SGO_QUEUE_DEBUG__.read().filter(item=>item.entityId==='T-TIMER-1');
assert(timerQueue.length===1 && timerQueue[0].action==='create','timer create should produce one local operation');
const timedDone={...timedCreate,status:'Concluída',progresso:100,evidencia:'Cronômetro',concluidoEm:new Date().toISOString(),timeTracking:{...timedCreate.timeTracking,state:'completed',activeStartedAt:'',completedAt:new Date().toISOString(),lastChangedAt:new Date().toISOString()}};
context.__SGO_QUEUE_DEBUG__.timerEnqueue(timedDone,'complete',new Date().toISOString());
timerQueue=context.__SGO_QUEUE_DEBUG__.read().filter(item=>item.entityId==='T-TIMER-1');
assert(timerQueue.length===1,'CREATE + COMPLETE not attempted should compact into one timer operation');
assert(timerQueue[0].action==='create' && timerQueue[0].payload.task.status==='Concluída','compacted timer create must carry final completed snapshot');
assert(timerQueue[0].timerCompactedAction==='complete','compacted timer operation should record latest local action');

// A próxima tarefa pode ser aceita no servidor mesmo enquanto a anterior aguarda processamento.
const timedSecond={...timedCreate,id:'T-TIMER-2',code:'SGO-TIMER-2',titulo:'Cronometrada 2'};
context.__SGO_QUEUE_DEBUG__.timerEnqueue(timedSecond,'create',new Date().toISOString());
let fullTimer=context.__SGO_QUEUE_DEBUG__.read();
const firstTimer=fullTimer.find(item=>item.entityId==='T-TIMER-1');
const secondTimer=fullTimer.find(item=>item.entityId==='T-TIMER-2');
assert(secondTimer.payload.dependsOnOperationId===firstTimer.operationId,'next timer task must persist dependency on previous timer operation');
firstTimer.serverAccepted=true;firstTimer.status='server_received';firstTimer.nextAttemptAt=Date.now()+60000;
for(const item of fullTimer){ if(item.operationId===firstTimer.operationId) Object.assign(item,firstTimer); }
storage.set('sgo_v12_5_operation_outbox',JSON.stringify(fullTimer));
const preaccept=context.__SGO_QUEUE_DEBUG__.nextEligible(fullTimer);
assert(preaccept && preaccept.operationId===secondTimer.operationId,'dependent timer operation should be eligible for early server acceptance');
secondTimer.serverAccepted=true;secondTimer.status='server_received';secondTimer.nextAttemptAt=0;
for(const item of fullTimer){ if(item.operationId===secondTimer.operationId) Object.assign(item,secondTimer); }
assert(context.__SGO_QUEUE_DEBUG__.nextEligible(fullTimer)===null,'server-accepted dependent operation must not process locally before predecessor finishes');

console.log('V12_QUEUE_BEHAVIOR_TESTS_OK', JSON.stringify({tests:31, queued:fullTimer.length}));
