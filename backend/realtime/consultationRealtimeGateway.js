const { WebSocket, WebSocketServer } = require('ws');
const { projectCase, projectMessage } = require('../services/consultationReadService');
const { createConsultationRepository } = require('../services/consultationRepository');
const { createConsultationRealtimeAccessService } = require('../services/consultationRealtimeAccessService');
const { consultationRealtimeBus, safeCaseReference } = require('../services/consultationRealtimeBus');
const { loadConsultationRealtimeConfig } = require('../config/consultationRealtimeConfig');

function configuredOrigins(env = process.env) {
  const raw = env.CONSULTATION_REALTIME_ALLOWED_ORIGINS || env.ALLOWED_ORIGINS || '';
  return String(raw).split(',').map((value) => value.trim()).filter(Boolean).filter((value) => {
    try {
      const parsed = new URL(value);
      return parsed.origin === value && !parsed.username && !parsed.password;
    } catch (_) { return false; }
  });
}

function isLoopbackOrigin(parsed) {
  return ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
    && ['http:', 'https:'].includes(parsed.protocol);
}

function allowedOrigin(origin, env = process.env) {
  if (typeof origin !== 'string' || !origin) return false;
  let parsed;
  try { parsed = new URL(origin); } catch (_) { return false; }
  if (parsed.origin !== origin || parsed.username || parsed.password) return false;
  if (configuredOrigins(env).includes(origin)) return true;
  return env.NODE_ENV !== 'production' && isLoopbackOrigin(parsed);
}

function secureWebSocketRequest(request, env = process.env) {
  if (env.NODE_ENV !== 'production') return true;
  if (request?.socket?.encrypted === true) return true;
  const value = Array.isArray(request?.headers?.['x-forwarded-proto'])
    ? request.headers['x-forwarded-proto'][0] : request?.headers?.['x-forwarded-proto'];
  return typeof value === 'string' && value.split(',')[0].trim().toLowerCase() === 'https';
}

function rejectUpgrade(socket, status = 401) {
  const label = status === 400 ? 'Bad Request' : status === 403 ? 'Forbidden'
    : status === 404 ? 'Not Found' : status === 429 ? 'Too Many Requests'
      : status === 503 ? 'Service Unavailable' : 'Unauthorized';
  socket.write(`HTTP/1.1 ${status} ${label}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function createConsultationRealtimeGateway({
  repository = createConsultationRepository(),
  access = null,
  bus = consultationRealtimeBus,
  config = loadConsultationRealtimeConfig(),
  logger = console,
  env = process.env,
  schedule = setTimeout,
  cancelSchedule = clearTimeout,
} = {}) {
  const accessService = access || createConsultationRealtimeAccessService({ repository });
  const maxPayloadBytes = Number(config.maxPayloadBytes) || 2_048;
  const authenticationTimeoutMs = Number(config.authenticationTimeoutMs) || 5_000;
  const maxConnections = Number(config.maxConnections) || 500;
  const maxConnectionsPerActor = Number(config.maxConnectionsPerActor) || 3;
  const wss = new WebSocketServer({ noServer:true, maxPayload:maxPayloadBytes, clientTracking:true });
  const metadata = new WeakMap();
  const rooms = new Map();
  const actorSockets = new Map();
  let server = null;
  let heartbeatTimer = null;
  let unsubscribe = null;
  let unsubscribeStatus = null;
  let attached = false;

  function addToRoom(ws, meta) {
    if (!rooms.has(meta.payload.caseId)) rooms.set(meta.payload.caseId, new Set());
    rooms.get(meta.payload.caseId).add(ws);
    if (!actorSockets.has(meta.actorKey)) actorSockets.set(meta.actorKey, new Set());
    actorSockets.get(meta.actorKey).add(ws);
    metadata.set(ws, meta);
  }

  function removeFromRoom(ws) {
    const meta = metadata.get(ws);
    if (!meta) return;
    if (meta.authTimer) cancelSchedule(meta.authTimer);
    const room = meta.payload ? rooms.get(meta.payload.caseId) : null;
    room?.delete(ws);
    if (room?.size === 0) rooms.delete(meta.payload.caseId);
    const actorRoom = meta.actorKey ? actorSockets.get(meta.actorKey) : null;
    actorRoom?.delete(ws);
    if (actorRoom?.size === 0) actorSockets.delete(meta.actorKey);
    metadata.delete(ws);
  }

  function send(ws, value) {
    if (ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(value));
    return true;
  }

  function safeCaseEvent(accessResult) {
    return projectCase(accessResult.row, {
      viewerRole:accessResult.role,
      includeClassification:accessResult.role === 'pharmacist',
    });
  }

  async function projectSignal(signal, accessResult) {
    if (signal.eventType === 'message.created') {
      const row = await repository.findMessageBySequence(signal.caseId, signal.sequence);
      if (!row) return null;
      return { type:'message.created', caseId:signal.caseId, sequence:signal.sequence, message:projectMessage(row) };
    }
    if (signal.eventType === 'read.updated') {
      return { type:'read.updated', caseId:signal.caseId, reader:signal.reader, sequence:signal.sequence };
    }
    if (signal.eventType === 'case.updated') {
      return { type:'case.updated', caseId:signal.caseId, case:safeCaseEvent(accessResult) };
    }
    return null;
  }

  async function reauthorizeSocket(ws, meta) {
    try { return await accessService.authorizeTicket(meta.payload); }
    catch (_) {
      logger.warn?.({
        event:'consultation_realtime_room_authorization_denied',
        actorType:meta.payload.role,
        caseReference:safeCaseReference(meta.payload.caseId),
      });
      ws.close(1008, 'room authorization changed');
      return null;
    }
  }

  async function deliverSignal(signal) {
    const room = rooms.get(signal.caseId);
    if (!room?.size) return;
    await Promise.all([...room].map(async (ws) => {
      const meta = metadata.get(ws);
      if (!meta || meta.phase !== 'authenticated' || ws.readyState !== WebSocket.OPEN) return;
      const authorization = await reauthorizeSocket(ws, meta);
      if (!authorization) return;
      const event = await projectSignal(signal, authorization);
      if (event) send(ws, event);
    }));
  }

  async function requestClientRecovery() {
    await Promise.all([...wss.clients].map(async (ws) => {
      const meta = metadata.get(ws);
      if (!meta || meta.phase !== 'authenticated' || ws.readyState !== WebSocket.OPEN) return;
      if (!await reauthorizeSocket(ws, meta)) return;
      send(ws, { type:'recovery.required', caseId:meta.payload.caseId });
    }));
  }

  async function reauthorizeAndHeartbeat() {
    await Promise.all([...wss.clients].map(async (ws) => {
      const meta = metadata.get(ws);
      if (!meta || meta.phase !== 'authenticated') return;
      if (ws.isAlive === false) { ws.terminate(); return; }
      ws.isAlive = false;
      if (!await reauthorizeSocket(ws, meta)) return;
      ws.ping();
    }));
  }

  async function authenticateSocket(ws, data, isBinary) {
    const pending = metadata.get(ws);
    if (!pending || pending.phase !== 'pending' || pending.authenticationAttempted) {
      ws.close(1008, 'unsupported realtime frame');
      return;
    }
    pending.authenticationAttempted = true;
    if (isBinary || Buffer.byteLength(data) > maxPayloadBytes) {
      ws.close(1009, 'realtime frame too large');
      return;
    }
    let frame;
    try { frame = JSON.parse(String(data)); } catch (_) {
      ws.close(1008, 'invalid realtime protocol');
      return;
    }
    const keys = frame && typeof frame === 'object' && !Array.isArray(frame) ? Object.keys(frame) : [];
    if (keys.length !== 2 || !keys.includes('type') || !keys.includes('ticket')
        || frame.type !== 'authenticate' || typeof frame.ticket !== 'string') {
      ws.close(1008, 'invalid realtime protocol');
      return;
    }
    try {
      const authorization = await accessService.consumeTicket(frame.ticket);
      if (ws.readyState !== WebSocket.OPEN) return;
      const actorKey = `${authorization.payload.role}:${authorization.payload.actorRef}`;
      if ((actorSockets.get(actorKey)?.size || 0) >= maxConnectionsPerActor) {
        ws.close(1008, 'realtime connection limit');
        return;
      }
      cancelSchedule(pending.authTimer);
      const meta = { phase:'authenticated', payload:authorization.payload, actorKey, authTimer:null };
      ws.isAlive = true;
      addToRoom(ws, meta);
      logger.info?.({
        event:'consultation_realtime_socket_connected', actorType:authorization.role,
        caseReference:safeCaseReference(authorization.row.case_id),
      });
      send(ws, {
        type:'connection.ready', caseId:authorization.row.case_id, role:authorization.role,
        serverTime:new Date().toISOString(), case:safeCaseEvent(authorization),
      });
    } catch (error) {
      logger.warn?.({
        event:'consultation_realtime_ticket_rejected',
        safeErrorCode:error?.code || 'REALTIME_TICKET_INVALID',
      });
      ws.close(1008, 'realtime authentication rejected');
    }
  }

  async function handleUpgrade(request, socket, head) {
    let url;
    try { url = new URL(request.url, 'http://localhost'); }
    catch (_) { rejectUpgrade(socket); return; }
    if (url.pathname !== config.websocketPath) { rejectUpgrade(socket, 404); return; }
    if (url.search) { rejectUpgrade(socket, 400); return; }
    if (!config.configured) { rejectUpgrade(socket, 503); return; }
    if (!secureWebSocketRequest(request, env)) { rejectUpgrade(socket, 403); return; }
    if (!allowedOrigin(request.headers.origin, env)) { rejectUpgrade(socket, 403); return; }
    if (wss.clients.size >= maxConnections) { rejectUpgrade(socket, 429); return; }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  }

  wss.on('connection', (ws) => {
    const pending = {
      phase:'pending', payload:null, actorKey:null, authenticationAttempted:false,
      authTimer:schedule(() => ws.close(1008, 'realtime authentication timeout'), authenticationTimeoutMs),
    };
    metadata.set(ws, pending);
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data, isBinary) => {
      const meta = metadata.get(ws);
      if (meta?.phase === 'authenticated') {
        ws.close(1008, 'server-push-only channel');
        return;
      }
      authenticateSocket(ws, data, isBinary).catch(() => ws.close(1011, 'realtime unavailable'));
    });
    ws.on('close', () => {
      const meta = metadata.get(ws);
      if (meta?.phase === 'authenticated') {
        logger.info?.({
          event:'consultation_realtime_socket_disconnected', actorType:meta.payload.role,
          caseReference:safeCaseReference(meta.payload.caseId),
        });
      }
      removeFromRoom(ws);
    });
    ws.on('error', () => removeFromRoom(ws));
  });

  function attach(httpServer) {
    if (attached) return;
    attached = true;
    server = httpServer;
    server.on('upgrade', handleUpgrade);
  }

  async function start() {
    if (!attached) throw new Error('CONSULTATION_REALTIME_GATEWAY_NOT_ATTACHED');
    if (!unsubscribe) unsubscribe = bus.subscribe((signal) => { deliverSignal(signal).catch(() => {
      logger.warn?.({event:'consultation_realtime_delivery_failed',eventType:signal.eventType});
    }); });
    if (!unsubscribeStatus && typeof bus.subscribeStatus === 'function') {
      unsubscribeStatus = bus.subscribeStatus((status) => {
        if (status?.status === 'recovered') requestClientRecovery().catch(() => {
          logger.warn?.({event:'consultation_realtime_recovery_signal_failed'});
        });
      });
    }
    const busHealth = await bus.start();
    if (!heartbeatTimer) {
      heartbeatTimer = setInterval(
        () => { reauthorizeAndHeartbeat().catch(() => logger.warn?.({event:'consultation_realtime_heartbeat_failed'})); },
        config.heartbeatSeconds * 1000
      );
      heartbeatTimer.unref?.();
    }
    return { configured:config.configured, bus:busHealth };
  }

  async function stop() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    unsubscribe?.(); unsubscribe = null;
    unsubscribeStatus?.(); unsubscribeStatus = null;
    if (server) server.off('upgrade', handleUpgrade);
    for (const ws of wss.clients) ws.close(1001, 'server shutdown');
    await bus.stop();
    attached = false; server = null;
  }

  function health() {
    return Object.freeze({
      configured:config.configured,
      connections:wss.clients.size,
      authenticatedConnections:[...actorSockets.values()].reduce((total, sockets) => total + sockets.size, 0),
      rooms:rooms.size,
      bus:bus.health(),
    });
  }

  return { attach, start, stop, health, wss, deliverSignal, requestClientRecovery, reauthorizeAndHeartbeat };
}

module.exports = {
  configuredOrigins,
  allowedOrigin,
  secureWebSocketRequest,
  rejectUpgrade,
  createConsultationRealtimeGateway,
};
