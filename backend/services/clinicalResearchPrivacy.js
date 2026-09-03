const SAFE_IDENTIFIER_PATTERNS = Object.freeze([
  /\b[UCR][0-9a-f]{16,}\b/i,
  /\b(?:CP|CAREPROFILE|RES|RESIDENT|CASE|CONSULTATION|CENTER|CTR)[-_][A-Za-z0-9_-]{2,}\b/i,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /(?:\+?66|0)[\s-]?[1-9](?:[\s-]?\d){7,8}\b/,
]);

function normalized(value) {
  return String(value || '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function privacyViolation(value, { blockedTerms = [], conversationTexts = [] } = {}) {
  const query = normalized(value);
  if (!query || query.length > 500) return 'INVALID_RESEARCH_QUERY';
  if (SAFE_IDENTIFIER_PATTERNS.some((pattern) => pattern.test(query))) return 'IDENTIFIER_IN_RESEARCH_QUERY';
  if (blockedTerms.some((term) => {
    const blocked = normalized(term);
    return blocked.length >= 3 && query.includes(blocked);
  })) return 'PRIVATE_TERM_IN_RESEARCH_QUERY';
  if (conversationTexts.some((text) => {
    const source = normalized(text);
    return source.length >= 20 && query.includes(source);
  })) return 'COPIED_CONVERSATION_IN_RESEARCH_QUERY';
  return null;
}

function sanitizeResearchPlan(plan, privacy = {}) {
  const acceptedTopics = [];
  const rejectedTopics = [];
  for (const topic of (plan?.researchTopics || []).slice(0, 4)) {
    const fields = [topic.question, ...(topic.deidentifiedSearchTerms || [])];
    const reason = fields.map((value) => privacyViolation(value, privacy)).find(Boolean);
    if (reason) {
      rejectedTopics.push(Object.freeze({ type:topic.type, reason:'RESEARCH_QUERY_PRIVACY_REJECTED' }));
      continue;
    }
    acceptedTopics.push(Object.freeze({
      type:topic.type,
      question:normalized(topic.question).slice(0, 500),
      deidentifiedSearchTerms:Object.freeze(topic.deidentifiedSearchTerms.map((term) => normalized(term).slice(0, 240))),
    }));
  }
  return Object.freeze({
    acceptedTopics:Object.freeze(acceptedTopics),
    rejectedTopics:Object.freeze(rejectedTopics),
    errorCode:rejectedTopics.length ? 'RESEARCH_QUERY_PRIVACY_REJECTED' : null,
  });
}

module.exports = {
  SAFE_IDENTIFIER_PATTERNS, normalized, privacyViolation, sanitizeResearchPlan,
};
