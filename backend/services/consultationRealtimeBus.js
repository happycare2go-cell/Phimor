const { EventEmitter } = require('node:events');
const { createHash, randomUUID } = require('node:crypto');
const { databaseQuery, acquireDatabaseClient } = require('../db');

const CHANNEL = 'phimor_consultation_realtime';
const EVENT_TYPES = Object.freeze(['message.created', 'read.updated', 'case.updated']);

function safeCaseReference(caseId) {
  return createHash('sha256').update(String(caseId || '')).digest('hex').slice(0, 12);
}

function reconnectDelay(attempt, random = Math.random) {
  const base = Math.min(30_000, 1_000 * (2 ** Math.min(5, Math.max(0, attempt))));
  return base + Math.floor(Math.max(0, Math.min(1, Number(random()) || 0)) * 250);
}

function normalizeSignal(input, eventIdFactory = randomUUID) {
  if (!input || !EVENT_TYPES.includes(input.eventType) || typeof input.caseId !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.caseId)) {
    throw new Error('INVALID_CONSULTATION_REALTIME_SIGNAL');
  }
  const signal = { eventId:input.eventId || eventIdFactory(), eventType:input.eventType, caseId:input.caseId };
  if (typeof signal.eventId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(signal.eventId)) {
    throw new Error('INVALID_CONSULTATION_REALTIME_SIGNAL');
  }
  if (input.eventType === 'message.created') {
    const sequence = Number(input.sequence);
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('INVALID_REALTIME_SEQUENCE');
    signal.sequence = sequence;
  }
  if (input.eventType === 'read.updated') {
    const sequence = Number(input.sequence);
    if (!['customer', 'pharmacist'].includes(input.reader)
        || !Number.isSafeInteger(sequence) || sequence < 0) throw new Error('INVALID_REALTIME_READ_SIGNAL');
    signal.reader = input.reader;
    signal.sequence = sequence;
  }
  if (input.eventType === 'case.updated') {
    if (!['queued', 'active', 'resolved', 'closed'].includes(input.state)) {
      throw new Error('INVALID_REALTIME_CASE_SIGNAL');
    }
    signal.state = input.state;
  }
  return Object.freeze(signal);
}

function createConsultationRealtimeBus({
  queryFn = databaseQuery,
  acquireClient = acquireDatabaseClient,
  logger = console,
  testMode = process.env.NODE_ENV === 'test',
  schedule = setTimeout,
  cancelSchedule = clearTimeout,
  random = Math.random,
} = {}) {
  const emitter = new EventEmitter();
  const recentlySeen = new Map();
  let client = null;
  let started = false;
  let available = testMode;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let connectionGeneration = 0;
  let hadFailure = false;

  function remember(eventId) {
    const now = Date.now();
    recentlySeen.set(eventId, now);
    for (const [key, at] of recentlySeen) if (now - at > 120_000) recentlySeen.delete(key);
  }

  function deliver(signal) {
    if (recentlySeen.has(signal.eventId)) return false;
    remember(signal.eventId);
    emitter.emit('signal', signal);
    return true;
  }

  async function publish(input) {
    const signal = normalizeSignal(input);
    deliver(signal);
    if (testMode) return { local:true, distributed:false, signal };
    try {
      await queryFn('SELECT pg_notify($1, $2)', [CHANNEL, JSON.stringify(signal)]);
      return { local:true, distributed:true, signal };
    } catch (_) {
      logger.warn?.({
        event:'consultation_realtime_publish_failed',
        eventType:signal.eventType,
        caseReference:safeCaseReference(signal.caseId),
      });
      return { local:true, distributed:false, signal };
    }
  }

  function releaseClient(active) {
    if (!active) return;
    try { active.release?.(true); } catch (_) { /* best effort */ }
  }

  function scheduleReconnect() {
    if (!started || testMode || reconnectTimer !== null) return;
    const delay = reconnectDelay(reconnectAttempt++, random);
    reconnectTimer = schedule(() => {
      reconnectTimer = null;
      connect().catch(() => { /* connect schedules the next attempt */ });
    }, delay);
    reconnectTimer?.unref?.();
  }

  function connectionLost(active, generation) {
    if (!started || generation !== connectionGeneration || client !== active) return;
    client = null;
    available = false;
    hadFailure = true;
    releaseClient(active);
    logger.warn?.({ event:'consultation_realtime_bus_unavailable' });
    scheduleReconnect();
  }

  async function connect() {
    if (!started || testMode) return { available };
    const generation = ++connectionGeneration;
    let next = null;
    try {
      next = await acquireClient();
      if (!started || generation !== connectionGeneration) {
        releaseClient(next);
        return { available:false };
      }
      next.on('notification', (notification) => {
        if (notification.channel !== CHANNEL || typeof notification.payload !== 'string') return;
        try { deliver(normalizeSignal(JSON.parse(notification.payload))); }
        catch (_) { logger.warn?.({ event:'consultation_realtime_signal_rejected' }); }
      });
      next.on('error', () => connectionLost(next, generation));
      next.on('end', () => connectionLost(next, generation));
      await next.query(`LISTEN ${CHANNEL}`);
      if (!started || generation !== connectionGeneration) {
        releaseClient(next);
        return { available:false };
      }
      client = next;
      available = true;
      reconnectAttempt = 0;
      if (hadFailure) {
        hadFailure = false;
        emitter.emit('status', Object.freeze({ status:'recovered' }));
      }
      return { available:true };
    } catch (_) {
      if (next && client !== next) releaseClient(next);
      available = false;
      hadFailure = true;
      logger.warn?.({ event:'consultation_realtime_bus_unavailable' });
      scheduleReconnect();
      return { available:false };
    }
  }

  async function start() {
    if (started || testMode) { started = true; return { available }; }
    started = true;
    return connect();
  }

  async function stop() {
    started = false;
    available = testMode;
    connectionGeneration += 1;
    if (reconnectTimer !== null) cancelSchedule(reconnectTimer);
    reconnectTimer = null;
    reconnectAttempt = 0;
    const active = client;
    client = null;
    if (!active) return;
    try { await active.query(`UNLISTEN ${CHANNEL}`); } catch (_) { /* best effort */ }
    releaseClient(active);
  }

  function subscribe(listener) {
    emitter.on('signal', listener);
    return () => emitter.off('signal', listener);
  }

  function subscribeStatus(listener) {
    emitter.on('status', listener);
    return () => emitter.off('status', listener);
  }

  function health() {
    return Object.freeze({
      started, available, channel:CHANNEL,
      reconnecting:started && !available && reconnectTimer !== null,
    });
  }

  return { publish, start, stop, subscribe, subscribeStatus, health, deliver };
}

const consultationRealtimeBus = createConsultationRealtimeBus();

module.exports = {
  CHANNEL,
  EVENT_TYPES,
  safeCaseReference,
  reconnectDelay,
  normalizeSignal,
  createConsultationRealtimeBus,
  consultationRealtimeBus,
};
