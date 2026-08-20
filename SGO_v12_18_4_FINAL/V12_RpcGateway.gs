/**
 * SGO v12.10 — gateway RPC estável e tolerante a módulo ausente.
 *
 * google.script.run não é um objeto JavaScript comum e chamadas dinâmicas no
 * navegador não são confiáveis. O cliente chama somente sgoRpcGateway(). O
 * gateway usa uma whitelist explícita e, para as duas leituras de comunicação
 * mais importantes, possui fallback somente-leitura. Assim uma implantação em
 * que V12_Communication.gs não tenha sido atualizado não derruba o restante do
 * SGO nem fica produzindo RPC_GATEWAY_EXCEPTION continuamente.
 */

function rpcNormalizeAreaV1210_(value) {
  return String(value || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function rpcConversationVisibleV1210_(user, conversation, visibleTaskIds) {
  if (!conversation || conversation.active === false) return false;
  // O fallback nunca pode ser mais permissivo que a política principal.
  // Quando o módulo de segurança está disponível, reutilizamos exatamente a
  // mesma decisão; em falha, adotamos uma política conservadora.
  try {
    if (typeof userCanSeeConversationV12_ === 'function') {
      return Boolean(userCanSeeConversationV12_(user, conversation, visibleTaskIds || {}));
    }
  } catch (ignored) { return false; }
  const userId = String(user && user.id || '');
  const profile = String(user && user.perfil || '');
  if (profile === 'admin') return true;
  if (Array.isArray(conversation.participantIds) && conversation.participantIds.indexOf(userId) >= 0) return true;
  if (String(conversation.type || '') === 'area') {
    return rpcNormalizeAreaV1210_(conversation.area || conversation.areaKey) === rpcNormalizeAreaV1210_(user && user.area || '');
  }
  if (String(conversation.type || '') === 'task' && conversation.taskId) {
    return Boolean(visibleTaskIds && visibleTaskIds[String(conversation.taskId)]);
  }
  return false;
}

function rpcFallbackVisibleTaskIdsV1210_(spreadsheet, user) {
  const ids = {};
  readCollectionRecords_(spreadsheet, 'tasks', false).forEach(function (task) {
    let visible = false;
    try {
      if (typeof userCanSeeTaskV12_ === 'function') {
        visible = Boolean(userCanSeeTaskV12_(user, task));
      } else {
        const profile = String(user && user.perfil || 'colaborador');
        const userId = String(user && user.id || '');
        const companies = Array.isArray(user && user.empresasAcesso) ? user.empresasAcesso : [];
        if (['admin','diretoria','auditoria'].indexOf(profile) >= 0) visible = true;
        else if (companies.length && task.empresa && companies.indexOf(task.empresa) < 0) visible = false;
        else if (profile === 'gestor' && rpcNormalizeAreaV1210_(task.area || '') === rpcNormalizeAreaV1210_(user && user.area || '')) visible = true;
        else visible = String(task.responsavelId || '') === userId
          || String(task.aprovadorId || '') === userId
          || String(task.solicitanteId || '') === userId
          || (Array.isArray(task.participantes) && task.participantes.indexOf(userId) >= 0);
      }
    } catch (ignored) { visible = false; }
    if (visible && task && task.id) ids[String(task.id)] = true;
  });
  return ids;
}

function rpcFallbackCommunicationBootstrapV1210_(payload) {
  let auth;
  try { auth = requireSessionV12_(payload || {}, true); }
  catch (error) { return errorResponse_('SESSION_INVALID', 'Sua sessão expirou.', getDatabaseVersion_(), Utilities.getUuid()); }
  const spreadsheet = getSpreadsheet_();
  const visibleTaskIds = rpcFallbackVisibleTaskIdsV1210_(spreadsheet, auth.user);
  const conversations = readCollectionRecords_(spreadsheet, 'conversations', false).filter(function (conversation) {
    return rpcConversationVisibleV1210_(auth.user, conversation, visibleTaskIds);
  });
  const conversationIds = {};
  conversations.forEach(function (conversation) { conversationIds[String(conversation.id || '')] = true; });
  const reads = readCollectionRecords_(spreadsheet, 'conversationReads', false).filter(function (read) {
    return String(read.userId || '') === String(auth.user.id);
  });
  const messages = readCollectionRecords_(spreadsheet, 'messages', false).filter(function (message) {
    return Boolean(conversationIds[String(message.conversationId || '')]);
  }).sort(function (a, b) {
    return new Date(a.createdAt || a._serverUpdatedAt || 0).getTime() - new Date(b.createdAt || b._serverUpdatedAt || 0).getTime();
  }).slice(-300);
  const notifications = readCollectionRecords_(spreadsheet, 'notifications', false).filter(function (notification) {
    return String(notification.userId || notification.destinatarioId || '') === String(auth.user.id);
  }).slice(-200);
  return successResponse_({ operationId:Utilities.getUuid(), databaseVersion:getDatabaseVersion_(), data:{
    conversations:conversations, conversationReads:reads, messages:messages,
    notifications:notifications, sequence:getChangeSequenceV12_(), fallback:true
  }});
}

function rpcFallbackMessagesSinceV1210_(payload) {
  payload = payload || {};
  let auth;
  try { auth = requireSessionV12_(payload, true); }
  catch (error) { return errorResponse_('SESSION_INVALID', 'Sua sessão expirou.', getDatabaseVersion_(), Utilities.getUuid()); }
  const spreadsheet = getSpreadsheet_();
  const visibleTaskIds = rpcFallbackVisibleTaskIdsV1210_(spreadsheet, auth.user);
  const conversations = readCollectionRecords_(spreadsheet, 'conversations', false).filter(function (conversation) {
    return rpcConversationVisibleV1210_(auth.user, conversation, visibleTaskIds);
  });
  const allowed = {};
  conversations.forEach(function (conversation) { allowed[String(conversation.id || '')] = true; });
  const conversationId = String(payload.conversationId || '');
  const limit = Math.max(1, Math.min(200, Number(payload.limit || 100)));
  const messages = readCollectionRecords_(spreadsheet, 'messages', false).filter(function (message) {
    const cid = String(message.conversationId || '');
    return Boolean(allowed[cid]) && (!conversationId || cid === conversationId);
  }).sort(function (a, b) {
    const sa = Number(a._messageSequence || 0), sb = Number(b._messageSequence || 0);
    if (sa || sb) return sa - sb;
    return new Date(a.createdAt || a._serverUpdatedAt || 0).getTime() - new Date(b.createdAt || b._serverUpdatedAt || 0).getTime();
  }).slice(-limit);
  return successResponse_({ operationId:Utilities.getUuid(), databaseVersion:getDatabaseVersion_(), data:{
    messages:messages, sequence:getChangeSequenceV12_(), hasMore:false, fallback:true
  }});
}

function sgoRpcGateway(request) {
  request = request || {};
  const method = String(request.method || '');
  const payload = request.payload && typeof request.payload === 'object' ? request.payload : {};
  try {
    switch (method) {
      case 'acceptTaskOperationServer': return acceptTaskOperationServer(payload);
      case 'acceptTaskOperationBatchServer': return acceptTaskOperationBatchServer(payload);
      case 'abandonTimedTaskServer': return abandonTimedTaskServer(payload);
      case 'discardPendingClientOperationsServer': return discardPendingClientOperationsServer(payload);
      case 'approveTaskOperationServer': return approveTaskOperationServer(payload);
      case 'auditTaskServer': return auditTaskServer(payload);
      case 'completeTaskServer': return completeTaskServer(payload);
      case 'createTaskServer': return createTaskServer(payload);
      case 'deleteTaskServer': return deleteTaskServer(payload);
      case 'pauseTaskServer': return pauseTaskServer(payload);
      case 'resumeTaskServer': return resumeTaskServer(payload);
      case 'startTaskServer': return startTaskServer(payload);
      case 'updateTaskServer': return updateTaskServer(payload);
      case 'waitTaskServer': return waitTaskServer(payload);
      case 'authenticateSessionServer': return authenticateSessionServer(payload);
      case 'commitStateChangesServer': return commitStateChangesServer(payload);
      case 'createConversationServer': return createConversationServer(payload);
      case 'getChangesSinceServer': return getChangesSinceServer(payload);
      case 'getConversationMessagesServer': return getConversationMessagesServer(payload);
      case 'getDiagnosticBundleServer': return getDiagnosticBundleServer(payload);
      case 'getMessagesSinceServer':
        return typeof getMessagesSinceServer === 'function' ? getMessagesSinceServer(payload) : rpcFallbackMessagesSinceV1210_(payload);
      case 'getOperationStatusServer': return getOperationStatusServer(payload);
      case 'getPresenceServer': return getPresenceServer(payload);
      case 'getSyncSnapshotServer': return getSyncSnapshotServer(payload);
      case 'heartbeatServer': return heartbeatServer(payload);
      case 'loadCommunicationBootstrapServer':
        return typeof loadCommunicationBootstrapServer === 'function' ? loadCommunicationBootstrapServer(payload) : rpcFallbackCommunicationBootstrapV1210_(payload);
      case 'loadDeferredBootstrapServer': return loadDeferredBootstrapServer(payload);
      case 'migrateMyCredentialAfterLoginServer': return migrateMyCredentialAfterLoginServer(payload);
      case 'loadPublicBootstrapServer': return loadPublicBootstrapServer(payload);
      case 'logoutSessionServer': return logoutSessionServer(payload);
      case 'markConversationReadServer': return markConversationReadServer(payload);
      case 'preflightWriteServer': return preflightWriteServer(payload);
      case 'processTaskOperationQueueServer': return processTaskOperationQueueServer(payload);
      case 'reportClientErrorServer': return reportClientErrorServer(payload);
      case 'resetUserPinServer': return resetUserPinServer(payload);
      case 'resumeSessionServer': return resumeSessionServer(payload);
      case 'sendMessageServer': return sendMessageServer(payload);
      default:
        return errorResponse_('RPC_METHOD_NOT_ALLOWED', 'A operação solicitada não está disponível.', getDatabaseVersion_(), String(payload.operationId || ''));
    }
  } catch (error) {
    try {
      if (typeof logDiagnosticV128_ === 'function') {
        logDiagnosticV128_({
          level:'ERROR', origin:'server', module:'rpc', step:'RPC_GATEWAY_EXCEPTION',
          errorCode:'RPC_GATEWAY_EXCEPTION', message:safeErrorMessage_(error),
          operationId:String(payload.operationId || ''), context:{ method:method }
        });
      }
    } catch (ignored) {}
    return errorResponse_('RPC_GATEWAY_EXCEPTION', safeErrorMessage_(error), getDatabaseVersion_(), String(payload.operationId || ''));
  }
}
