'use strict';
const fs=require('fs'), path=require('path'), assert=require('assert'), vm=require('vm'), crypto=require('crypto');
const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'Index.html'),'utf8');
const task=fs.readFileSync(path.join(root,'V12_TaskOperations.gs'),'utf8');
const daily=fs.readFileSync(path.join(root,'V12_TimerDaily.gs'),'utf8');
const comm=fs.readFileSync(path.join(root,'V10_Communication.gs'),'utf8');
const sec=fs.readFileSync(path.join(root,'V12_SecuritySync.gs'),'utf8');
const diag=fs.readFileSync(path.join(root,'V12_Diagnostics.gs'),'utf8');
let tests=0;
function ok(value,message){assert(value,message);tests++;}
function eq(actual,expected,message){assert.strictEqual(actual,expected,message);tests++;}
function count(text,re){return (text.match(re)||[]).length;}

// Contratos visuais e de produto.
ok(html.includes('>v12.18.3</span>'),'build badge v12.18.3 missing');
ok(html.includes('<option value="Tarefa diária">Tarefa diária</option>'),'daily task option missing');
ok(html.includes('taskDueControl.disabled = false;'),'timed task deadline is still disabled');
ok(html.includes('taskDueControl.required = !timedQuickTask;'),'timed task deadline is not optional');
ok(html.includes("dailyTypeOption.disabled = currentProfile !== 'admin';"),'daily task option is not restricted in UI');
ok(html.includes('Somente administradores podem criar ou ativar uma tarefa diária.'),'daily task client validation missing');
ok(html.includes("estimativa:1") || html.includes("estimativa: 1"),'timed task does not default to one hour');
ok(html.includes("prazo:'', prazoManual:false, prazoAutomatico:false") || html.includes("prazo: '', prazoManual: false"),'timed task does not start without a manual deadline');
ok(html.includes('return Boolean(task.prazo && task.prazoAutomatico !== true);'),'legacy manual deadline inference missing');

// Apenas uma camada ativa v12.14 por ação, além da declaração-base capturada no legado.
for (const name of ['startTimedTask','pauseTimedTask','resumeTimedTask','saveTimerWait','completeTimedTask']) {
  eq(count(html,new RegExp('function\\s+'+name+'\\s*\\(','g')),1,`base declaration count invalid for ${name}`);
  eq(count(html,new RegExp('\\b'+name+'\\s*=\\s*function\\s*\\(','g')),1,`final v12.14 override count invalid for ${name}`);
}
ok(!/V10_LEGACY\.(startTimedTask|pauseTimedTask|resumeTimedTask|saveTimerWait|completeTimedTask)\s*\(/.test(html),'old timer wrapper is still active');
ok(!html.includes('SGO v12.6 — conclusão cronometrada transacional'),'v12.6 timer overlay still present');

const timerStart=html.indexOf('SGO v12.18.3 — cronômetro local-first com compactação e dependências duráveis no servidor.');
const timerEnd=html.indexOf('window.__SGO_QUEUE_DEBUG__',timerStart);
const timerBlock=html.slice(timerStart,timerEnd);
ok(timerStart>=0 && timerBlock.length>1000,'v12.18.3 timer module missing');
ok(timerBlock.includes('var entityKeys=[taskKey,slotKey];') && timerBlock.includes('dependsOnOperationId:dependsOnOperationId'),'timer operations do not preserve slot ordering with durable dependencies');
const enqueueStart=timerBlock.indexOf('function timerV1214EnqueueTask');
const enqueueEnd=timerBlock.indexOf('function timerV1214RollbackTask',enqueueStart);
const enqueueBlock=timerBlock.slice(enqueueStart,enqueueEnd);
const newTimerOpStart=enqueueBlock.indexOf('var predictedBefore');
const newTimerOpBlock=enqueueBlock.slice(newTimerOpStart);
ok(newTimerOpBlock.indexOf('queueAdd(item)') < newTimerOpBlock.indexOf('timerV1214RequireDurableLocal(operationId)'),'durable queue is not written before release check');
ok(newTimerOpBlock.indexOf('timerV1214RequireDurableLocal(operationId)') < newTimerOpBlock.indexOf("queueMarkOptimistic('tasks'"),'new timer operation can become optimistic before durable local confirmation');
ok(timerBlock.includes('queueStorageItemV1215'),'timer handoff does not verify durable per-operation storage');
ok(timerBlock.includes("task.timeTracking.activeStartedAt='';task.timeTracking.lastChangedAt=actionAt"),'pause does not clear activeStartedAt');
ok(timerBlock.includes("task.timeTracking.activeStartedAt='';task.timeTracking.lastChangedAt=actionAt;task.status=waitAction"),'wait does not clear activeStartedAt');
ok(timerBlock.includes("current.timeTracking.state='completed';current.timeTracking.activeStartedAt=''"),'completion does not release active timer locally');
ok(timerBlock.includes("timerV1214EnqueueTask(current,'complete',actionAt)"),'completion is not placed directly in timer outbox');
ok(timerBlock.includes("timerV1214EnqueueTask(task,'create',actionAt)"),'new timer task is not placed directly in timer outbox');
ok(timerBlock.includes('Você já pode iniciar outra tarefa'),'immediate next-task behavior is not surfaced');
ok(timerBlock.includes("sgo_v12_14_timer_dock_position"),'movable timer position is not persisted');
ok(timerBlock.includes("event.target.closest('.timer-dock-head')"),'timer dock header is not draggable');
ok(html.includes('window.__sgoReapplyQueueOverlaysV1214'),'pending local timer overlay cannot survive server snapshots');

// Servidor: relógio do clique, deadline e slot único entre dispositivos.
ok(task.includes('resolveTaskActionTimeV1214_(payload, now, action)'),'server ignores client action timestamp');
ok(task.includes('checkTimerSlotV1214_(spreadsheet, auth.user, currentTask, nextTask, deleted)'),'server timer slot validation missing');
ok(task.includes('commitTimerSlotV1214_(auth.user, currentTask, storedTask, deleted)'),'server timer slot commit missing');
const mutateStartV12183=task.indexOf('function mutateTaskServer'); const timerCheckV12183=task.indexOf('checkTimerSlotV1214_',mutateStartV12183); const taskWriteV12183=task.indexOf("upsertRecord_(spreadsheet, 'tasks', taskId",timerCheckV12183); ok(timerCheckV12183>=0 && taskWriteV12183>timerCheckV12183,'timer slot is checked after persistence');
ok(task.includes("errorCode:'TIMER_ALREADY_ACTIVE'" ) || daily.includes("errorCode:'TIMER_ALREADY_ACTIVE'"),'cross-device active timer error missing');
ok(task.includes('taskHasManualDeadlineV1214_'),'manual/automatic deadline helper missing on server');
ok(task.includes('task.prazoManual = false;') && task.includes('task.prazoAutomatico = true;'),'automatic completion deadline flags missing');
ok(task.includes("clientActionAt:String(payload.clientActionAt || \'\')"),'queue sanitizer drops clientActionAt');
ok(daily.includes('recoverTimerSlotV1214_'),'legacy timer-slot migration recovery missing');
ok(daily.includes("readCollectionRecords_(spreadsheet, 'tasks', false)"),'legacy timer-slot recovery does not inspect persisted tasks');

// Recorrência diária.
ok(daily.includes("DAILY_TASK_ADMIN_ONLY"),'server admin-only rule for daily task missing');
ok(daily.includes("isTemplate:true"),'daily recurrence template flag missing');
ok(daily.includes("deterministicIdV12_('daily'"),'daily occurrence ID is not deterministic');
ok(count(daily,/getRecordMeta_\(spreadsheet,'tasks',occurrenceId\)/g)>=2,'daily generation lacks double idempotency check');
ok(!daily.includes('SGO_DAILY_TASKS_LAST_SUCCESS_DATE'),'global daily guard can suppress templates created later the same day');
ok(daily.includes('retryNeeded = true'),'daily generator does not retry after lock/error');
ok(comm.includes("generateDailyTasksV1214"),'daily trigger is not installed by communication setup');
ok(comm.includes("everyHours(1)"),'daily task contingency trigger is not hourly');
ok(comm.includes("typeof generateDailyTasksV1214 === 'function'"),'existing deadline trigger does not provide daily-task fallback');
ok(task.includes('DAILY_AUTOMATION_UNAVAILABLE'),'daily recurrence can still be persisted without automation guarantee');
const dailyAutomationCheckV12183=task.indexOf('const dailyAutomation = ensureDailyTaskTriggerV1214_()',mutateStartV12183); const taskWriteAfterDailyV12183=task.indexOf("upsertRecord_(spreadsheet, 'tasks', taskId",dailyAutomationCheckV12183); ok(dailyAutomationCheckV12183>=0 && taskWriteAfterDailyV12183>dailyAutomationCheckV12183,'daily automation is verified only after template persistence');
ok(daily.includes('dailyAutomationStatusV1214_'),'daily automation verification helper missing');
ok(daily.includes('function finalizeV1215Deployment()'),'one-time final deployment migration helper missing');
ok(sec.includes("const SGO_APP_VERSION_V1215 = '12.18.3'") && sec.includes("setMetaValue_('APP_VERSION', SGO_APP_VERSION_V1215)"),'server metadata build version missing');
ok(diag.includes("'v12.18.3'"),'diagnostic build version missing');

// Behavioral checks for new isolated server helper module.
const properties=Object.create(null), records=Object.create(null), triggers=[];
function propService(){return {
  getProperty:k=>Object.prototype.hasOwnProperty.call(properties,k)?properties[k]:null,
  setProperty(k,v){properties[k]=String(v);return this;}, deleteProperty(k){delete properties[k];return this;}
};}
const ctx={
  console, Date, JSON, Math, String, Number, Boolean, Array, Object, RegExp, Error,
  Session:{getScriptTimeZone:()=> 'America/Bahia'},
  Utilities:{formatDate:(date,_tz,format)=>{const d=new Date(date);if(format==='yyyy-MM-dd') return d.toISOString().slice(0,10);if(format==='HH:mm') return d.toISOString().slice(11,16);return d.toISOString();}},
  PropertiesService:{getScriptProperties:propService},
  ScriptApp:{getProjectTriggers:()=>triggers.slice(),newTrigger:(handler)=>({timeBased(){return this;},everyHours(){return this;},create(){const t={getHandlerFunction:()=>handler};triggers.push(t);return t;}})},
  cloneObject_:v=>JSON.parse(JSON.stringify(v)),
  sha256V12_:v=>crypto.createHash('sha256').update(String(v)).digest('hex'),
  deterministicIdV12_:(prefix,a,b)=>String(prefix)+'_'+crypto.createHash('sha256').update(String(a)+'|'+String(b)).digest('hex').slice(0,28),
  getRecordMeta_:(_sheet,_collection,id)=>records[id]||null,
  readCollectionRecords_:()=>Object.values(records).filter(Boolean).filter(meta=>!meta.deleted).map(meta=>meta.data).filter(Boolean)
};
vm.createContext(ctx); vm.runInContext(daily,ctx,{filename:'V12_TimerDaily.gs'});
const serverNow='2026-08-10T15:00:00.000Z';
eq(ctx.resolveTaskActionTimeV1214_({clientActionAt:'2026-08-10T14:59:00.000Z'},serverNow,'pause'),'2026-08-10T14:59:00.000Z','valid client action time was not preserved');
eq(ctx.resolveTaskActionTimeV1214_({clientActionAt:'2026-07-01T00:00:00.000Z'},serverNow,'pause'),serverNow,'stale client clock should fall back to server');

const user={id:'u1',perfil:'colaborador'};
const a={id:'A',tipo:'Tarefa cronometrada',responsavelId:'u1',timeTracking:{enabled:true,state:'running',activeStartedAt:'2026-08-10T14:00:00Z'}};
const b={id:'B',tipo:'Tarefa cronometrada',responsavelId:'u1',timeTracking:{enabled:true,state:'running',activeStartedAt:'2026-08-10T14:05:00Z'}};
records.A={deleted:false,data:a};
Object.keys(properties).forEach(k=>delete properties[k]);
const migratedBlocked=ctx.checkTimerSlotV1214_({},user,null,b,false);
eq(migratedBlocked.success,false,'legacy running timer was not recovered when slot was empty');
eq(migratedBlocked.activeTaskId,'A','legacy timer-slot migration recovered wrong task');
ok(Object.values(properties).includes('A'),'legacy running timer was not written into the recovered slot');
Object.keys(properties).forEach(k=>delete properties[k]);
ctx.commitTimerSlotV1214_(user,null,a,false);
const blocked=ctx.checkTimerSlotV1214_({},user,null,b,false);
eq(blocked.success,false,'second cross-device timer was not blocked');
eq(blocked.errorCode,'TIMER_ALREADY_ACTIVE','wrong cross-device timer error');
const pausedA=JSON.parse(JSON.stringify(a)); pausedA.timeTracking.state='paused'; pausedA.timeTracking.activeStartedAt='';
records.A={deleted:false,data:pausedA};
ctx.commitTimerSlotV1214_(user,a,pausedA,false);
eq(ctx.checkTimerSlotV1214_({},user,null,b,false).success,true,'timer slot was not released after persisted pause/wait/complete state');

const nonAdminDaily={id:'D1',tipo:'Tarefa diária',prazo:'2026-08-10T09:30',empresa:'GQ',area:'TI',titulo:'Checklist diário',responsavelId:'u1',estimativa:1,prioridade:'Normal',risco:'Baixo',checklist:[]};
const denied=ctx.prepareDailyTaskMutationV1214_({id:'u1',perfil:'colaborador'},'create',null,JSON.parse(JSON.stringify(nonAdminDaily)),serverNow);
eq(denied.success,false,'non-admin can create daily template');
const adminTask=JSON.parse(JSON.stringify(nonAdminDaily));
const allowed=ctx.prepareDailyTaskMutationV1214_({id:'admin',perfil:'admin'},'create',null,adminTask,serverNow);
eq(allowed.success,true,'admin cannot create daily template');
eq(adminTask.dailyRecurrence.isTemplate,true,'admin daily task was not converted to template');
eq(adminTask.dailyRecurrence.dueTime,'09:30','daily due time was not preserved');
const attemptedEdit=JSON.parse(JSON.stringify(adminTask)); attemptedEdit.tipo='Demanda operacional'; attemptedEdit.dailyRecurrence={enabled:false};
ctx.prepareDailyTaskMutationV1214_({id:'u1',perfil:'colaborador'},'update',adminTask,attemptedEdit,serverNow);
eq(attemptedEdit.tipo,'Tarefa diária','non-admin altered daily recurrence type');
eq(attemptedEdit.dailyRecurrence.enabled,true,'non-admin disabled recurrence');
const occ1=ctx.buildDailyOccurrenceV1214_(adminTask,'2026-08-11',serverNow);
const occ2=ctx.buildDailyOccurrenceV1214_(adminTask,'2026-08-11',serverNow);
const occ3=ctx.buildDailyOccurrenceV1214_(adminTask,'2026-08-12',serverNow);
eq(occ1.id,occ2.id,'same daily template/date produced different IDs');
ok(occ1.id!==occ3.id,'different daily dates produced same occurrence ID');
eq(occ1.prazo,'2026-08-11T09:30','generated daily deadline is wrong');
eq(occ1.dailyRecurrence.isTemplate,false,'generated daily occurrence became a template');
ctx.ensureDailyTaskTriggerV1214_(); ctx.ensureDailyTaskTriggerV1214_();
eq(triggers.filter(t=>t.getHandlerFunction()==='generateDailyTasksV1214').length,1,'daily trigger setup is not idempotent');
eq(ctx.dailyAutomationStatusV1214_().guaranteed,true,'dedicated daily trigger is not recognized as guaranteed');

// Se a criação do gatilho falhar e não houver fallback, a recorrência deve ser recusada.
triggers.length=0;
const originalNewTrigger=ctx.ScriptApp.newTrigger;
ctx.ScriptApp.newTrigger=()=>({timeBased(){return this;},everyHours(){return this;},create(){throw new Error('permission denied');}});
const noAutomation=ctx.ensureDailyTaskTriggerV1214_();
eq(noAutomation.success,false,'daily automation failure was silently accepted');
eq(noAutomation.errorCode,'DAILY_AUTOMATION_UNAVAILABLE','wrong daily automation failure code');
// O gatilho de prazo existente é um fallback válido e explícito.
triggers.push({getHandlerFunction:()=> 'generateDeadlineNotificationsV10'});
const fallbackAutomation=ctx.ensureDailyTaskTriggerV1214_();
eq(fallbackAutomation.success,true,'deadline trigger fallback was not accepted');
eq(fallbackAutomation.mode,'deadline-fallback','wrong daily fallback mode');
ctx.ScriptApp.newTrigger=originalNewTrigger;

console.log('V12_14_REGRESSION_TESTS_OK',JSON.stringify({tests}));
