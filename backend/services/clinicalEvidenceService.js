const NO_INTERACTION_PATTERN = /(?:ไม่มี|ไม่พบ).{0,20}(?:drug\s*)?interaction|\bno\s+(?:drug\s+)?interaction\b/i;

function allowedHost(hostname, allowedDomains) {
  const normalized = String(hostname || '').toLowerCase();
  return allowedDomains.some((domain) => normalized === domain || normalized.endsWith(`.${domain}`));
}

function evidenceUrlKey(value) {
  let url;
  try { url = new URL(value); } catch (_) { return null; }
  if (url.protocol !== 'https:') return null;
  url.hash = '';
  url.hostname = url.hostname.replace(/^www\./i, '');
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_.+|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.toString();
}

function buildEvidenceBundle(rawEvidence, metadata, {
  allowedDomains = [], accessedAt = new Date(), maxSources = 8,
} = {}) {
  const unique = new Map();
  for (const source of Array.isArray(metadata?.sources) ? metadata.sources : []) {
    if (unique.size >= maxSources) break;
    let url;
    try { url = new URL(source.url); } catch (_) { continue; }
    if (url.protocol !== 'https:' || !allowedHost(url.hostname, allowedDomains)) continue;
    const key = evidenceUrlKey(url);
    if (!key || unique.has(key)) continue;
    {
      unique.set(key, Object.freeze({
        referenceId:`SRC-${unique.size + 1}`,
        title:String(source.title || url.hostname).normalize('NFC').trim().slice(0, 300) || url.hostname,
        url:url.toString(), domain:url.hostname.toLowerCase(),
        publishedAt:source.publishedAt || null,
        accessedAt:new Date(accessedAt).toISOString(),
      }));
    }
  }
  const findings = [];
  const limitations = [...(rawEvidence?.limitations || [])];
  for (const finding of rawEvidence?.findings || []) {
    if (NO_INTERACTION_PATTERN.test(finding.summary)) {
      limitations.push('INSUFFICIENT_INTERACTION_EVIDENCE');
      continue;
    }
    const evidenceRefs = [...new Set((finding.citationUrls || [])
      .map((url) => unique.get(evidenceUrlKey(url))?.referenceId).filter(Boolean))];
    if (!evidenceRefs.length) {
      limitations.push('EVIDENCE_WITHOUT_VERIFIED_CITATION_REJECTED');
      continue;
    }
    findings.push(Object.freeze({
      topicType:finding.topicType,
      summary:finding.summary,
      evidenceRefs:Object.freeze(evidenceRefs),
      conflictDetected:finding.conflictDetected === true,
      limitation:finding.limitation || null,
    }));
  }
  if ((rawEvidence?.findings || []).length && !findings.length) {
    limitations.push('NO_VERIFIED_EVIDENCE_SOURCE');
  }
  const usedReferences = new Set(findings.flatMap((finding) => finding.evidenceRefs));
  const acceptedSources = [...unique.values()].filter((source) => usedReferences.has(source.referenceId));
  return Object.freeze({
    findings:Object.freeze(findings),
    sources:Object.freeze(acceptedSources),
    limitations:Object.freeze([...new Set(limitations)].slice(0, 20)),
  });
}

function createUsageAccumulator() {
  const metrics = {
    inputTokens:{ sum:0, seen:false }, outputTokens:{ sum:0, seen:false },
    totalTokens:{ sum:0, seen:false }, reasoningTokens:{ sum:0, seen:false },
  };
  let webSearchCalls = 0;
  return {
    record(metadata) {
      for (const [field, state] of Object.entries(metrics)) {
        const value = metadata?.usage?.[field];
        if (Number.isSafeInteger(value) && value >= 0) { state.sum += value; state.seen = true; }
      }
      if (Number.isSafeInteger(metadata?.webSearchCalls) && metadata.webSearchCalls >= 0) {
        webSearchCalls += metadata.webSearchCalls;
      }
    },
    snapshot() {
      return Object.freeze({
        inputTokens:metrics.inputTokens.seen ? metrics.inputTokens.sum : null,
        outputTokens:metrics.outputTokens.seen ? metrics.outputTokens.sum : null,
        totalTokens:metrics.totalTokens.seen ? metrics.totalTokens.sum : null,
        reasoningTokens:metrics.reasoningTokens.seen ? metrics.reasoningTokens.sum : null,
        webSearchCalls,
      });
    },
  };
}

module.exports = {
  NO_INTERACTION_PATTERN, allowedHost, evidenceUrlKey, buildEvidenceBundle, createUsageAccumulator,
};
