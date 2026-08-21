# Prompt de migração — SGO para Supabase (reescrita completa)

> Este documento é o "prompt" de referência para reescrever o SGO do zero em cima do Supabase,
> aproveitando a estrutura, os módulos e o layout do sistema atual (Google Apps Script + Google
> Sheets), mas com uma implementação nova, específica para Postgres/Supabase — não uma tradução
> literal linha a linha. Serve tanto para eu (Claude) executar quanto para outra sessão/agente
> retomar o trabalho depois.

## 0. Regras de execução

- **Novo projeto isolado.** Todo o código novo vive em `SGO_Supabase/`, uma pasta irmã de
  `SGO_v12_18_4_FINAL/` dentro do mesmo repositório (`fagnerrc/SGO`, público).
- **Nunca tocar no código antigo.** Nenhum commit desta migração pode alterar, mover ou apagar
  nada dentro de `SGO_v12_18_4_FINAL/` ou dos arquivos na raiz do repo. O sistema em produção
  continua rodando no Apps Script normalmente enquanto a migração acontece.
- **Commits exclusivos.** Cada commit desta migração só deve tocar arquivos dentro de
  `SGO_Supabase/`.
- **Sem credenciais reais.** Nunca hardcodar URL/chaves reais do Supabase. Usar variáveis de
  ambiente (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) e documentar no
  README que o usuário precisa criar seu próprio projeto Supabase e preenchê-las.
- **Não precisa terminar tudo de uma vez.** É um projeto grande — trabalhar em fases (ver seção
  8), sempre deixando um `PROGRESS.md` atualizado dizendo o que foi feito e o que falta.

---

## 1. Objetivo

Reescrever o SGO — sistema de gestão de tarefas do Grupo Quintão — trocando a base
Apps Script + Google Sheets por Supabase (Postgres + Auth + Row Level Security + Realtime +
Edge Functions), mantendo todas as funcionalidades e a organização por módulos de hoje, mas
com uma arquitetura de dados de verdade (transações, constraints, índices) em vez das
adaptações que a planilha e o `ScriptLock` global exigiam.

---

## 2. Visão geral do sistema atual, por módulo

### 2.1 Núcleo de dados e permissões — `V10_Database.gs`
Camada de acesso à "planilha como banco de dados": leitura/escrita de registros por coleção,
versionamento otimista (`_recordVersion`), idempotência por `operationId`, matriz de permissões
por coleção (`canWriteRecordV10_`), backups e restauração.

**Coleções hoje** (cada uma é uma aba da planilha):
`tasks` (SGO_TAREFAS), `messages` (SGO_MENSAGENS), `feedbacks` (SGO_FEEDBACKS),
`notifications` (SGO_NOTIFICACOES), `collaborators` (SGO_USUARIOS), `processes` (SGO_PROCESSOS),
`audits` (SGO_AUDITORIAS), `activity`/`securityLog` (SGO_EVENTOS, coleções irmãs na mesma aba),
`errors` (SGO_ERROS), mais `conversations` e `conversationReads` (chat) e um bloco de
configuração singleton: `companies`, `settings`, `organization`, `security`, `branding`.

### 2.2 Operações de tarefas e cronômetro — `V12_TaskOperations.gs` (o módulo mais complexo)
- CRUD de tarefas com máquina de estado de cronômetro: `start → pause/resume → wait/approval_wait
  → complete`, sessões de trabalho (`timeTracking.sessions`).
- Checklist, evidência de execução, justificativa de atraso, fluxo de aprovação
  (`approvalStatus`, `aprovadorId`).
- Autorização por perfil (colaborador dono / gestor da área / diretoria / auditoria).
- Detecção de idempotência semântica (uma ação reenviada com outro `operationId` não deve
  duplicar efeito).
- Proteção de estado terminal (`Concluída`/`Auditada`/`Cancelada` não pode ser reaberta por um
  `update` genérico — hoje só implementada para tarefas cronometradas, ver bug #5 na seção 6).
- Geração de código sequencial da tarefa (`SGO-000123`), compactação/arquivamento de campos que
  crescem demais (`historico`, `comentarios`, `links`, sessões de cronômetro) para não estourar o
  limite de célula da planilha.

### 2.3 Tarefas recorrentes e manutenção diária — `V12_TimerDaily.gs`
- Geração diária de tarefas a partir de modelos recorrentes (gatilho horário do Apps Script).
- Reparo de cronômetros em conflito (dois "em execução" do mesmo responsável).
- Reparo de dependências entre operações na fila (para garantir ordem de execução).
- Funções de finalização/checagem de deploy (`finalizeV12184Deployment` e cadeia de aliases).

### 2.4 Autenticação, sessões e sincronização — `V12_SecuritySync.gs`
- Login por PIN (hash com pepper), limite de tentativas com bloqueio temporário.
- Sessões com TTL, tokens opacos.
- Matriz de visibilidade: quem pode ver qual tarefa/conversa/registro, por empresa/área/perfil.
- Sincronização incremental (`getChangesSinceServer`) — o cliente pede "o que mudou desde a
  versão X" em vez de baixar tudo de novo.
- Reset de PIN por admin, migração de hash fraco legado para hash forte.

### 2.5 Comunicação — `V10_Communication.gs` + `V12_Communication.gs`
- Notificações automáticas por evento (tarefa atribuída, feedback recebido, mensagem, menção) —
  **hoje código morto, nunca chamado (bug #6)** — e notificações por gatilho diário (prazo
  vencendo/vencido, aprovação pendente).
- Chat interno: conversas 1-a-1, por tarefa e por área, com marcação de lido
  (`conversationReads`).

### 2.6 Diagnóstico e observabilidade — `V12_Diagnostics.gs`
- Log estruturado de eventos/erros do servidor, buffer em memória com flush periódico para a
  planilha, função de diagnóstico de performance de salvamento de tarefa.

### 2.7 Gateway de RPC — `V12_RpcGateway.gs`
- Ponto único de entrada (`sgoRpcGateway`) que despacha para as funções de servidor, com
  try/catch uniforme e log de exceção. Hoje **6 funções pulam esse gateway** e são chamadas
  direto (bug #10).

### 2.8 Frontend — `Index.html` (+ `V10_Core.html`/`V10_Styles.html`, hoje já incorporados)
SPA em JavaScript puro, sem framework. Características a preservar no layout/UX:
- **Local-first**: toda ação do usuário entra numa fila local (outbox) antes de depender da
  rede — queda de conexão não perde o clique.
- Sincronização por polling (intervalo fixo, sem backoff em alguns pontos — oportunidade de
  melhoria com Supabase Realtime).
- Telas: login, lista/kanban de tarefas, detalhe de tarefa com cronômetro e checklist, chat,
  central de notificações, painel de administração (usuários, processos, backup), diagnóstico.

---

## 3. Princípios da reescrita (o que muda de arquitetura)

| Hoje (Apps Script + Sheets) | Na reescrita (Supabase) |
|---|---|
| Cada coleção é uma aba de planilha | Tabela Postgres própria, com tipos e índices reais |
| `ScriptLock` global (bloqueia o sistema inteiro) | Transações Postgres + locks de linha (`SELECT ... FOR UPDATE`) só no registro afetado |
| `canWriteRecordV10_` / `visibilityForRecordV12_` (funções JS reimplementando permissão) | **Row Level Security (RLS)** nativa do Postgres, policy por tabela |
| `google.script.run` + `V12_RpcGateway.gs` | Supabase client (`supabase-js`) chamando **Postgres functions (RPC)** ou **Edge Functions**, todas atrás de uma camada de erro única |
| Polling de tela em intervalo fixo | **Supabase Realtime** (subscriptions em mudanças de tabela) |
| Gatilhos horários do Apps Script (`installV10Triggers`) | **pg_cron** ou Edge Function agendada (Supabase Scheduled Functions) |
| Hash de PIN + tabela de tentativas feita à mão | Tabela de credenciais própria + Supabase Auth (custom claims) ou JWT próprio emitido por Edge Function, mantendo o login por PIN que o usuário já conhece |
| `_recordVersion` comparado manualmente (optimistic concurrency) | Pode continuar existindo como coluna, mas as transições ilegais (reabrir tarefa terminal, pular aprovação) viram **CHECK constraints / triggers**, não só checagem em JS |
| Varredura de planilha inteira dentro do lock (`createTextFinder`, `getValues()`) | Query indexada normal — deixa de existir esse problema por natureza |

---

## 4. Modelo de dados — mapeamento das coleções

Desenhar uma tabela Postgres por coleção abaixo (nomes sugeridos, ajustar durante a implementação):

- `companies` — antes um campo de configuração singleton; virar tabela de verdade (multi-empresa
  já existe no sistema: `empresa`, `empresasAcesso` aparecem em várias coleções).
- `collaborators` (`profiles`) — usuários: nome, email, perfil (colaborador/gestor/diretoria/
  auditoria/admin), área, empresa, empresas de acesso, ativo/inativo, hash de credencial.
- `processes` — processos de negócio (usados por tarefas para segregação de função
  conferente/aprovador).
- `tasks` — a tabela central: título, descrição, tipo (inclui `'Tarefa cronometrada'`), empresa,
  área, processo, solicitante, responsável, participantes, prazo, estimativa, prioridade, risco,
  status (enum!), progresso, campos de espera (`aguardandoQuem`/`aguardandoDesde`/
  `motivoEspera`), evidência, justificativa de atraso, checklist (jsonb ou tabela filha),
  histórico (tabela filha `task_history`, não array/json, para poder consultar), comentários e
  links (tabelas filhas), `timeTracking` (colunas próprias: state, totalMs, activeStartedAt,
  startedAt, completedAt — e `task_timer_sessions` como tabela filha em vez de array),
  `approvalStatus`/`approvedBy`/`approvedAt`, código sequencial (`code`), soft-delete
  (`excluido`).
- `messages`, `conversations`, `conversation_reads` — chat.
- `feedbacks` — feedback entre colaboradores.
- `notifications` — tipo, destinatário, tarefa relacionada (FK real, não fallback fabricado —
  corrige bug #7), lida/não lida.
- `activity`, `audits`, `security_log` — hoje três nomes para praticamente a mesma coisa/mesma
  aba; decidir na implementação se viram uma tabela só com uma coluna `kind` ou tabelas
  separadas — o importante é ter FK de usuário validada (corrige bug #7 e bug #8 abaixo).
- `errors` — log de erro do servidor (pode virar apenas linhas em `security_log`/tabela de log,
  ou usar uma ferramenta de observabilidade externa integrada via Edge Function).
- Enums Postgres para: `task_status`, `task_type`, `user_role`, `notification_type` — em vez de
  strings soltas comparadas por igualdade em JS.

Toda tabela com dono/participantes ganha **RLS policy** equivalente ao que
`canWriteRecordV10_`/`visibilityForRecordV12_` faziam hoje, mas declarativo e testável.

---

## 5. Lógica de negócio — o que vira o quê

- `mutateTaskServer`/`completeTaskServer`/`updateTaskServer` (`V12_TaskOperations.gs`) →
  uma função Postgres `mutate_task(...)` (ou algumas menores por ação) rodando dentro de uma
  transação, com os "guards" de autorização e de transição de estado expressos como
  `CHECK`/`EXISTS` na própria query ou em triggers `BEFORE UPDATE`.
- A máquina de estado do cronômetro (`enforceTaskActionV12_`) → um `CASE`/conjunto de funções
  por ação (`start_task`, `pause_task`, `resume_task`, `complete_task`, ...), cada uma validando
  a transição permitida a partir do estado atual lido com `FOR UPDATE` (substitui o lock global
  por um lock só na linha da tarefa).
- Idempotência (`taskSemanticNoopV1218_`, `appendChangeOnceV12_`) → uma tabela `operations`
  com `operation_id UNIQUE` e `ON CONFLICT DO NOTHING`/`RETURNING`, sem precisar varrer nada.
- Geração diária de tarefas (`generateDailyTasksV1215_`) → Edge Function agendada via pg_cron,
  chamando uma função Postgres que faz o `INSERT ... SELECT` a partir dos modelos recorrentes
  numa transação só (sem lock global, sem scan de participante por participante).
- Notificações de prazo (`generateDeadlineNotificationsV1215_`) → Edge Function agendada
  equivalente, usando comparação de data/hora correta (timezone explícito, sem o bug de datas
  sem hora sendo lidas como UTC — bug relacionado ao #6/#7).
- Notificações por evento (`createAutomaticNotifications_`, hoje morta) → **implementar de
  verdade** via trigger Postgres (`AFTER INSERT` em tasks/feedbacks/messages) ou chamada
  explícita no fim de cada função de mutação — não pode ficar sem uso como está hoje.
- Login por PIN (`authenticateSessionServer`) → Edge Function que verifica hash+pepper, grava
  tentativa numa tabela `login_attempts` com `locked_until` cuja validade **não** depende de TTL
  de armazenamento (corrige bug #2), e emite sessão (JWT do Supabase Auth via
  `admin.createUser`/custom token, ou tabela `sessions` própria com invalidação real no reset de
  PIN — corrige bug #1).
- Sincronização incremental (`getChangesSinceServer`) → substituída por **Realtime**
  (subscription em INSERT/UPDATE/DELETE por tabela, filtrada por RLS) + uma query inicial de
  bootstrap; o conceito de "sequência global" deixa de ser necessário.
- Backup/restore (`commitStateChangesServer`, `restoreStateSnapshotV12_`) → `pg_dump`/point-in-time
  recovery nativo do Postgres/Supabase substitui a lógica de backup manual; se quiser manter um
  botão de "restaurar" no app, ele deve rodar dentro de uma transação (corrige bug #9).
- Gateway de RPC (`V12_RpcGateway.gs`) → toda Edge Function/RPC do projeto novo passa por um
  wrapper comum de tratamento de erro e log, desde o primeiro dia (corrige bug #10) — nenhuma
  função de escrita deve ser chamada direto do cliente sem passar por ele.

---

## 6. Bugs conhecidos no sistema atual — não repetir na reescrita

(Lista completa da auditoria de código feita em 2026-08-20; os 10 abaixo são os mais graves de
28 achados confirmados.)

1. Reset de PIN por admin não invalidava sessões antigas — a reescrita deve invalidar sessão ao
   trocar credencial.
2. Bloqueio de login configurável (ex.: 24h) era truncado silenciosamente para 8h por um TTL de
   armazenamento — a duração do bloqueio deve ser a fonte de verdade, sem cap escondido.
3. Autorização de gestor checava só o estado *antes* da mutação (área/responsável), não depois —
   permitia mover tarefa para fora da alçada. Checar sempre o estado resultante também.
4. `update` genérico conseguia setar status protegidos (`Cancelada`, `Reprovada/devolvida`) ou
   forjar campos de cronômetro (`totalMs`, `activeStartedAt`) sem passar pelas ações dedicadas —
   usar constraints/triggers para tornar essas transições estruturalmente impossíveis fora do
   caminho certo, não só checagem em código de aplicação.
5. Proteção contra "ressurreição" de tarefa concluída só existia para tarefas cronometradas —
   aplicar a mesma regra para todos os tipos de tarefa.
6. Notificações de tarefa atribuída/feedback/mensagem/menção nunca disparavam (função morta,
   sem nenhuma chamada) — só o aviso de prazo funcionava. Implementar e testar de verdade cada
   gatilho de notificação.
7. Registro sem tarefa vinculada usava o próprio id como "taskId" falso, ficando invisível para
   todo mundo (inclusive admin) na sincronização — usar FK real e nula quando não há vínculo,
   nunca um fallback fabricado.
8. Checagem de permissão de operação/erro liberava por padrão quando faltava o campo de dono —
   deve **negar por padrão** quando a informação de dono está ausente.
9. Restauração de backup podia falhar no meio, deixando o banco parcialmente restaurado e sem
   nenhum erro registrado — usar transação (o Postgres já garante atomicidade "de graça" aqui).
10. Vários pontos de entrada do servidor pulavam o gateway central de erro, vazando exceção crua
    pro cliente sem log — todo Edge Function/RPC deve passar pelo mesmo wrapper de erro desde o
    início.

Há mais ~18 achados de severidade menor (código morto — `V10_Core.html`/`V10_Styles.html`
inteiros, função `init()` duplicada, endpoints de migração sem uso —, e padrões de "varredura de
planilha inteira dentro do lock" repetidos em vários módulos). Não existem na arquitetura nova
por natureza (não há "planilha" nem "lock global" para variar), mas servem de lembrete do tipo de
problema a evitar: proteção aplicada num lugar só quando deveria ser regra geral.

---

## 7. Estrutura de pastas sugerida para `SGO_Supabase/`

```
SGO_Supabase/
├── README.md                 — visão geral, como rodar, como mapeia pro sistema antigo
├── PROGRESS.md                — o que está feito, o que falta, decisões em aberto
├── supabase/
│   ├── migrations/            — arquivos SQL versionados (schema, RLS, triggers, enums)
│   └── functions/              — Edge Functions (Deno), uma por operação/grupo de operações
├── src/                        — frontend (mantendo layout/telas atuais)
│   ├── lib/supabase.ts         — client
│   └── ...                     — telas: tarefas, cronômetro, chat, notificações, admin
└── .env.example                 — SUPABASE_URL, SUPABASE_ANON_KEY (placeholders, nunca reais)
```

---

## 8. Fases sugeridas (não precisa fazer tudo de uma vez)

1. **Schema + RLS** — todas as tabelas da seção 4, políticas de RLS básicas, enums.
2. **Núcleo de tarefas** — CRUD + máquina de estado do cronômetro + autorização (o módulo mais
   arriscado do sistema antigo, prioridade).
3. **Autenticação e sessões** — login por PIN, bloqueio, reset, corrigindo bugs #1 e #2.
4. **Comunicação** — chat, feedback, notificações (implementando de verdade o que hoje é código
   morto).
5. **Automação recorrente** — geração diária de tarefas e notificações de prazo via pg_cron.
6. **Frontend completo** ligado a tudo acima, com Realtime substituindo o polling.
7. **Diagnóstico/observabilidade** e ferramentas de admin (backup via transação, painel de
   usuários).

Cada fase termina com `PROGRESS.md` atualizado e commits específicos daquela fase.
