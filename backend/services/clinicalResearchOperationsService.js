const { databaseQuery } = require('../db');
const {
  CLINICAL_RESEARCH_MODES, loadClinicalResearchPilotConfig,
} = require('../config/clinicalResearchPilot');

const MODE_LABELS = Object.freeze({
  [CLINICAL_RESEARCH_MODES.DISABLED]:'ปิด',
  [CLINICAL_RESEARCH_MODES.DEIDENTIFIED_PILOT]:'ทดลองแบบไม่ระบุตัวตน',
  [CLINICAL_RESEARCH_MODES.CONTROLLED_LIVE]:'ใช้งานจริงแบบควบคุม',
});

function safeAggregate(row = {}) {
  const count = (value) => Math.max(0, Number(value) || 0);
  return Object.freeze({
    requests:count(row.requests),
    successful:count(row.successful),
    failed:count(row.failed),
    webSearches:count(row.web_searches),
    approximateTokens:count(row.approximate_tokens),
  });
}

function createClinicalResearchOperationsService({
  queryFn = databaseQuery, env = process.env, windowDays = 7,
} = {}) {
  const days = Math.min(30, Math.max(1, Number(windowDays) || 7));
  return {
    async getStatus() {
      const config = loadClinicalResearchPilotConfig(env);
      const result = await queryFn(
        `SELECT
           COUNT(*)::int AS requests,
           COUNT(*) FILTER (WHERE result_status IN ('success', 'needs_review'))::int AS successful,
           COUNT(*) FILTER (WHERE result_status = 'error')::int AS failed,
           COALESCE(SUM(web_search_calls), 0)::bigint AS web_searches,
           COALESCE(SUM(total_tokens), 0)::bigint AS approximate_tokens
         FROM ai_interaction_audit
         WHERE purpose = 'pharmacist_clinical_research'
           AND requested_at >= CURRENT_TIMESTAMP - ($1::int * INTERVAL '1 day')`,
        [days]
      );
      return Object.freeze({
        featureName:'พี่หมอ Clinical Research',
        mode:config.mode,
        modeLabel:MODE_LABELS[config.mode],
        windowDays:days,
        metrics:safeAggregate(result.rows[0]),
        emergencyGuidance:'ปิด Clinical Research ผ่านการตั้งค่าฝั่งเซิร์ฟเวอร์ PHARMACIST_AI_RESEARCH_ENABLED=false',
      });
    },
  };
}

module.exports = { MODE_LABELS, safeAggregate, createClinicalResearchOperationsService };
