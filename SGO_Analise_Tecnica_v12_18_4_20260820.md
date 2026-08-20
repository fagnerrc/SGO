# SGO — Análise Técnica do Código (v12.18.4)
Grupo Quintão | Análise realizada em 20/08/2026, a partir do pacote `SGO_v12_18_4_FINAL_COMPLETO.zip` e do histórico consolidado `SGO_Historico_Evolucao_Completo_20260820.pdf`.

## Como ler este relatório

O SGO já passou por mais de 30 releases de hardening específico contra concorrência, e isso aparece no código: idempotência, versionamento otimista, proteção de estado terminal e outbox local-first estão, na maior parte, bem implementados. Os problemas abaixo não são sinal de que o projeto está mal feito — são os pontos que ainda escaparam desse processo, e vários deles explicam de forma plausível o "ainda dá muitos erros" que você mencionou. Quando você mandar o relatório de erros real, vou cruzar com esta lista para confirmar quais destes estão realmente acontecendo e priorizar.

Cada achado indica arquivo, função/linha aproximada, o cenário concreto que dispara o problema e a severidade. No fim há uma seção do que foi checado e **está correto**, para não passar a impressão de que tudo está quebrado.

---

## Resumo executivo — o que eu resolveria primeiro

1. **Confirmar agora qual arquivo está publicado no Apps Script.** Existem três versões do frontend no pacote (`Index.html`, `Index_assembled_preview.html`, `tests/assembled_frontend.js`) e as duas últimas estão uma versão atrás (v12.18.3), sem a proteção que impede uma tarefa concluída de "reaparecer" na tela. Se o arquivo errado foi publicado por engano, isso sozinho explicaria parte dos erros relatados.
2. **Dois gatilhos automáticos (tarefas diárias e notificações de prazo) não têm proteção contra erro no nível mais alto.** Se falharem repetidamente, o Google os desativa sozinho, sem avisar na tela — as tarefas recorrentes e os avisos de prazo param de ser gerados silenciosamente.
3. **O botão de "restaurar cópia automática" restaura um backup congelado da migração inicial**, não o estado recente. Se alguém apertar esse botão hoje, provavelmente sobrescreveria meses de dados.
4. **A criação de notificações refaz uma varredura completa da tabela de notificações a cada notificação enviada, dentro do lock de escrita** — isso piora sozinho conforme a base cresce, e é um forte candidato a causa raiz do `SERVER_BUSY` que aumenta com o tempo.
5. **O limite de tentativas de login (PIN) tem uma falha de concorrência** que permite tentar várias senhas em paralelo sem ser bloqueado.

---

## Achados críticos

### C1. Frontend publicado pode não ser o mais recente/seguro
**Arquivos:** `Index.html` (produção, v12.18.4) vs. `Index_assembled_preview.html` e `tests/assembled_frontend.js` (ambos ainda em v12.18.3).

Os dois últimos não têm a função `queueTaskTerminalV12184_`/`queueWouldResurrectTerminalV12184_`, que impede uma resposta de rede atrasada de "ressuscitar" visualmente uma tarefa já concluída/cancelada. Também reintroduzem uma segunda chamada ao servidor (accept → process) que a v12.18.4 eliminou justamente por causar contenção no lock.

**Cenário:** um usuário conclui uma tarefa cronometrada; segundos depois uma resposta atrasada de outra operação chega e a tarefa volta a aparecer "em execução" na tela — se o preview/testes forem, por engano, o que está publicado.

**Ação:** confirmar no editor do Apps Script se o `Index.html` publicado corresponde de fato ao arquivo v12.18.4 do pacote (comparar `SGO_BUILD_VERSION`). Considerar apagar ou renomear claramente `Index_assembled_preview.html` como "NÃO USAR EM PRODUÇÃO" para evitar publicação acidental.

### C2. Gatilhos automáticos sem tratamento de erro no nível mais alto
**Arquivos:** `V12_TimerDaily.gs` (`generateDailyTasksV1214`, linha ~369) e `V10_Communication.gs` (`generateDeadlineNotificationsV10`/`generateDeadlineNotificationsV1215_`, linhas ~224-308).

A leitura inicial de tarefas/processos dentro dessas funções não está protegida por `try/catch`, e os handlers dos gatilhos também não. O Apps Script desativa automaticamente um gatilho que falha repetidamente, avisando só por e-mail ao dono do script — nada aparece na interface do SGO.

**Cenário:** uma falha transitória do Google Sheets (cota, instabilidade momentânea) se repete algumas vezes seguidas; o gatilho horário de tarefas recorrentes e/ou o de notificação de prazo é desativado silenciosamente. Ninguém percebe até notar que tarefas diárias pararam de aparecer.

**Ação:** envolver o corpo dessas funções em `try/catch`, registrando o erro (`registerServerErrorV10_`) e retornando graciosamente.

### C3. Restauração de backup devolve um snapshot desatualizado
**Arquivos:** `Code.gs` (`restoreServerBackup`, linha ~107) usando `V10_Database.gs` (`restoreStateSnapshotV12_`).

`SGO_BACKUP` só é escrita na migração inicial para v10 ou em um rollback manual — não no dia a dia. Um admin que use "restaurar cópia automática" pelo Web App hoje receberia de volta esse snapshot antigo, sobrescrevendo tudo que foi feito desde então (a única salvaguarda é que o estado atual é salvo antes, mas não há uma função pública para desfazer isso de uma vez só — teria que restaurar registro por registro).

**Ação:** desativar esse botão/RPC até existir uma restauração real a partir de `V10_BACKUPS_SHEET`, ou pelo menos mostrar ao admin a data do backup antes de confirmar.

### C4. Criação de notificações faz varredura completa por notificação criada, dentro do lock
**Arquivo:** `V10_Communication.gs`, `createAutomaticNotifications_`, linhas ~47-56.

Para cada notificação gerada (ex.: 3 participantes de uma tarefa = 3 notificações), o código relê e faz parse de **toda** a tabela de notificações para checar duplicidade — dentro do caminho crítico de salvamento, que também seria coberto pelo lock de escrita. Essa tabela não tem expurgo automático, então o custo cresce indefinidamente com o histórico da empresa.

**Ação:** ler a coleção de notificações **uma vez** antes do laço, indexar em memória por chave, e checar ali.

### C5. Recuperação de operação repetida faz varredura completa dentro do lock global
**Arquivo:** `V12_TaskOperations.gs`, `appendChangeOnceV12_` (linhas ~689-701), acionada dentro de `mutateTaskServer` sempre que uma operação é reenviada após falha parcial.

Usa busca textual (`createTextFinder`) em toda a coluna de operação do changelog, **dentro do ScriptLock**, que é global — bloqueia todos os usuários do sistema enquanto roda. Em uma tabela de changelog grande, isso pode segurar o lock por segundos.

**Ação:** usar cache de linha (como já existe em outros pontos do código, ex. `v1210GetCachedRow_`) em vez de varredura textual dentro do lock.

### C6. Cronômetros em conflito não são corrigidos automaticamente
**Arquivo:** `V12_TimerDaily.gs`, `rebuildTimerSlotsV1215_` (linhas ~377-414).

Quando a manutenção detecta duas tarefas do mesmo responsável marcadas como "rodando" ao mesmo tempo, o sistema escolhe uma para manter o cronômetro ativo e **apenas registra** o conflito — as demais continuam com `timeTracking.state = 'running'` indefinidamente, sem que ninguém detecte de novo o conflito. É provavelmente uma causa real dos "cronômetros congelados" que o próprio time já tentou mitigar com a função de descarte manual.

**Ação:** corrigir automaticamente as tarefas "perdedoras" (ex.: pausá-las com marcador de auditoria) em vez de só logar.

### C7. Rate limit de login tem condição de corrida (permite força bruta paralela)
**Arquivo:** `V12_SecuritySync.gs`, `authenticateSessionServer` (linhas ~269-317) e `readLoginAttemptV1215_`/`writeLoginAttemptV1215_` (linhas ~188-208).

O ciclo ler-tentativas → validar PIN → incrementar → gravar não usa nenhum lock. Chamadas simultâneas ao mesmo e-mail com PINs diferentes leem o mesmo contador antes de qualquer uma escrever de volta — a última escrita vence e as demais se perdem. Na prática, um lote de dezenas de tentativas em paralelo conta como muito menos que isso, e o bloqueio raramente é atingido.

**Ação:** usar um lock curto (`tryWriteLockV12_`, ~300-500ms) em volta do ciclo leitura-incremento-escrita, chaveado por e-mail.

### C8. Tarefa pode ser cancelada sem passar pela regra de terminalidade
**Arquivo:** `V12_TaskOperations.gs`, `validateTaskActionAuthorizationV1215_` (linhas ~772-785) e `preserveTerminalTimerStateV12184_` (linhas ~930-951).

A exigência de "ação explícita" (com evidência/justificativa) cobre `Concluída`, `Auditada`, `Aguardando aprovação/terceiro` — mas não existe uma ação dedicada `cancel`, nem a mesma exigência para `Cancelada`. Um `update` comum com `status:'Cancelada'` no payload passa sem checklist, sem evidência e sem trilha de auditoria específica, e `preserveTerminalTimerStateV12184_` não reverte essa transição porque o destino também é um estado "terminal".

**Ação:** criar uma ação `cancel` explícita, com sua própria checagem de permissão/justificativa, e bloquear `Cancelada` como destino de `update` genérico — do mesmo jeito que já é feito para `Concluída`/`Auditada`.

---

## Achados de severidade alta

**A1. Lote de mudanças não é atômico** (`V10_Database.gs`, `commitStateChangesServer`, linhas ~84-190) — se a execução for interrompida no meio de um lote (timeout de 6 min, erro pontual), alguns registros já ficam gravados mas a operação não é marcada `COMPLETED` nem a versão do banco avança; reenviar o mesmo lote gera um `VERSION_CONFLICT` falso, como se outra pessoa tivesse mexido.

**A2. Manutenção de backups pode apagar todos eles** (`V10_Database.gs`, `maintainBackupsV1215_`, linhas ~691-710) — faz `clearContent()` e depois regrava; se falhar no meio (perto do limite de tempo de execução), a aba de backups fica vazia. E a exceção é engolida silenciosamente (`catch(ignoredRetention){}`), sem log — a perda pode passar despercebida até alguém precisar restaurar algo.

**A3. Código morto em camadas no frontend** (`Index.html`) — a função de "commit" de mudanças foi reescrita três vezes ao longo da evolução (`v10CommitPendingChanges` legado → versão "v10" com diff completo → versão final via fila/outbox) e, como são reatribuições simples em JavaScript, só a última realmente executa. Isso deixa ~120 linhas de lógica de conflito/retry (`v12CommitTaskChanges`, `v10ShowTaskConflict`) inalcançáveis. Risco real: se alguém tentar corrigir um bug nesse trecho "morto", a correção não terá efeito nenhum em produção.

**A4. Sincronização incremental não revoga acesso a chat/mensagens quando a visibilidade muda** (`V12_SecuritySync.gs`, `changeVisibleToUserV12_`) — a revogação por "delete sintético" só existe para `tasks`; para `messages`, `conversations`, `feedbacks`, `audits` não existe. Um usuário que perde acesso a uma tarefa continua vendo o histórico de chat já carregado localmente até um refresh completo.

**A5. Notificação de "tarefa atualizada" é suprimida para sempre após a primeira** (`V10_Communication.gs`) — a chave de deduplicação usa o id da própria tarefa (constante) em vez de algo específico da edição; a primeira notificação bloqueia todas as futuras da mesma tarefa/destinatário, mesmo dias depois.

**A6. Falhas na matriz de permissões** (`V10_Database.gs`, `canWriteRecordV10_`) — o autor de uma mensagem pode editar qualquer campo dela depois de enviada (inclusive destinatários/tarefa), sem revalidar escopo; e qualquer colaborador comum pode criar uma tarefa atribuída a qualquer área/pessoa, sem checagem de relação. Vale confirmar se isso é intencional.

**A7. Polling de leitura sem backoff** (`Index.html`, `scheduleSync`/`v12ScheduleChatPolling`) — ao contrário da fila de escrita (que já tem backoff), a sincronização de leitura e o polling de chat continuam no mesmo intervalo fixo mesmo quando as chamadas estão falhando, agravando picos de degradação do backend em vez de aliviar.

**A8. Diagnóstico de performance pode estar cego para os mecanismos mais novos** (`V12_Diagnostics.gs`) — a whitelist de "passos" analisados por `diagnoseV1216TaskSavePerformance` (reaproveitada por todos os aliases v1217→v12.18.4) ainda lista só nomes de passo de versões antigas; vale confirmar se os mecanismos novos (recuperação de cronômetro congelado, antiduplicação, identidade de tarefa, agendador de fila) gravam passos com esses mesmos nomes — senão, o próprio diagnóstico usado para investigar produção está incompleto.

---

## Achados de severidade média

- **Reparo de dependências órfãs só roda quando a fila está totalmente vazia** — em picos constantes de uso, nunca roda (`V12_TaskOperations.gs`, `repairOrphanQueueDependenciesV12184_`).
- **Instalação do gatilho diário fora do lock** pode duplicar o gatilho horário sob concorrência — sem causar tarefas duplicadas (a geração é idempotente), mas desperdiça cota de execução (`V12_TaskOperations.gs`/`V12_TimerDaily.gs`).
- **Fallback de notificação de prazo roda a geração diária incondicionalmente**, mesmo com o gatilho dedicado já instalado — dobra a varredura de tarefas sem necessidade (`V10_Communication.gs`).
- **Credencial legada (hash fraco, sem pepper) pode persistir indefinidamente** se o cliente nunca disparar a migração automática — não há re-hash obrigatório no servidor (`V12_SecuritySync.gs`).
- **`appendChangeWithSequenceV1210_` não valida posse do lock** como sua função irmã `appendChangeV12_` valida — risco de manutenção futura corromper a ordenação do changelog sem perceber.
- **Extração de horário por regex não trata timestamps em UTC ("Z")** — se `prazo` alguma vez for gravado em UTC, o horário-modelo da recorrência sairia 3h adiantado (`V12_TimerDaily.gs`, `v1214TimeKeyFromDeadline_`).
- **Buffer de diagnóstico em cache (60 eventos) pode descartar eventos justamente durante picos de erro**, antes do flush para a planilha.
- **`securityLog` pode ser editado pelo próprio usuário sem proteção de campo**, comprometendo a integridade da trilha de auditoria de segurança.
- **`initializeHeaders_` pode apagar linhas de dados sem backup prévio** se o cabeçalho estiver em branco (cenário raro, mas sem proteção).

## Achados de severidade baixa

- Comparação de hash de credencial não é *constant-time* (risco teórico, baixo impacto prático dado o HMAC-SHA256).
- `setHotMetaValuesV1217_` sem `try/catch` pode gerar um `COMMIT_FAILURE` falso com dado já persistido, mesma classe do item A1 com outro gatilho.

---

## O que foi verificado e está correto

Para não deixar a impressão de que o sistema é frágil como um todo — o que **não** é o caso:

- Idempotência por `operationId` e idempotência semântica (duas operações diferentes representando a mesma intenção) estão bem implementadas.
- Campos de propriedade do servidor (aprovação, código de tarefa, permissões) estão protegidos contra `update` genérico tanto no cliente quanto no servidor.
- O slot de cronômetro é checado e gravado dentro da mesma seção crítica — sem corrida entre verificar e confirmar.
- O gateway de RPC usa `switch/case` fixo, sem risco de chamada de função arbitrária vinda do cliente.
- Sessão expirada é tratada corretamente em todos os pontos verificados (nunca aceita silenciosamente).
- O versionamento otimista usa comparação de igualdade estrita — detecta corretamente cliente desatualizado.
- Geração de tarefas diárias é idempotente mesmo que o gatilho seja acionado em duplicidade.
- Mensagens de chat não duplicam em caso de reenvio (idempotência por `operationId`).
- O frontend é genuinamente *local-first*: toda ação do usuário entra na fila local antes de depender da rede — uma queda de conexão não perde o clique.
- A proteção contra "ressurreição" de tarefa concluída existe e funciona — só está ausente nas cópias desatualizadas do frontend (achado C1).
- Não há XSS por inserção de texto do usuário sem escape, nem segredos/credenciais expostos no código do frontend.

---

## Plano de ação sugerido

**Fase 1 — correções pontuais, baixo risco, resolvem rápido (dias):**
C1 (confirmar build publicado), C2 (try/catch nos gatilhos), C3 (desativar restore de backup obsoleto), C7 (lock no rate limit de login), A5 (chave de deduplicação de notificação).

**Fase 2 — mudanças de maior superfície, precisam de teste antes de publicar (1-2 semanas):**
C4, C5, C6, C8, A1, A2, A3, A4, A6, A7, A8.

**Fase 3 — processo, já recomendado no histórico do projeto e reforçado por esta análise:**
Transformar os cenários acima em testes automatizados obrigatórios (o projeto já tem uma boa base de testes em `tests/`, é questão de estender); homologação real com múltiplos usuários antes de cada publicação (os próprios relatórios de validação da v12.18.4 dizem que isso ainda depende de confirmação em produção); e manter no radar a migração futura de persistência para Postgres/Supabase, que resolveria de forma definitiva a família de problemas ligada ao `ScriptLock` único e às varreduras de planilha sob concorrência (itens C4, C5, C6, A1).

---

*Próximo passo: quando você mandar o relatório de erros de produção, vou cruzar cada erro relatado com os achados acima para confirmar quais realmente estão acontecendo e ajustar a prioridade.*
