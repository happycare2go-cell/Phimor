const DEFAULT_TICKET_TTL_SECONDS = 60;
const DEFAULT_HEARTBEAT_SECONDS = 30;
const DEFAULT_AUTHENTICATION_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 2_048;
const DEFAULT_MAX_CONNECTIONS = 500;
const DEFAULT_MAX_CONNECTIONS_PER_ACTOR = 3;
const MINIMUM_SECRET_LENGTH = 32;

function hasSecret(value) {
  return typeof value === 'string' && value.trim().length >= MINIMUM_SECRET_LENGTH;
}

function loadConsultationRealtimeConfig(env = process.env) {
  const ticketSecret = typeof env.CONSULTATION_REALTIME_TICKET_SECRET === 'string'
    ? env.CONSULTATION_REALTIME_TICKET_SECRET.trim() : '';
  return Object.freeze({
    configured: hasSecret(ticketSecret),
    ticketSecret,
    ticketTtlSeconds: DEFAULT_TICKET_TTL_SECONDS,
    heartbeatSeconds: DEFAULT_HEARTBEAT_SECONDS,
    authenticationTimeoutMs: DEFAULT_AUTHENTICATION_TIMEOUT_MS,
    maxPayloadBytes: DEFAULT_MAX_PAYLOAD_BYTES,
    maxConnections: DEFAULT_MAX_CONNECTIONS,
    maxConnectionsPerActor: DEFAULT_MAX_CONNECTIONS_PER_ACTOR,
    websocketPath: '/api/consultations/realtime',
  });
}

module.exports = {
  DEFAULT_TICKET_TTL_SECONDS,
  DEFAULT_HEARTBEAT_SECONDS,
  DEFAULT_AUTHENTICATION_TIMEOUT_MS,
  DEFAULT_MAX_PAYLOAD_BYTES,
  DEFAULT_MAX_CONNECTIONS,
  DEFAULT_MAX_CONNECTIONS_PER_ACTOR,
  MINIMUM_SECRET_LENGTH,
  hasSecret,
  loadConsultationRealtimeConfig,
};
