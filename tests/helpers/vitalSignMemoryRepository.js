function createVitalSignMemoryRepository({ dailyCareState = null } = {}) {
  const state = { sets:[], observations:[], events:[] };
  let tick = 0;
  const stamp = () => new Date(Date.UTC(2026, 7, 27, 1, 0, tick++)).toISOString();
  const clone = (row) => row ? { ...row } : null;

  return {
    state,
    async insertSet(record) {
      const row = {
        vital_set_id:record.vitalSetId, organization_id:record.organizationId,
        center_id:record.centerId, resident_id:record.residentId,
        care_profile_id:record.careProfileId, status:'recorded',
        occurred_at:record.occurredAt, recorded_at:stamp(), received_at:stamp(),
        recorded_by_actor_type:record.actorType,
        recorded_by_actor_reference:record.actorReference,
        source_type:record.sourceType, source_system:record.sourceSystem,
        integration_client_id:record.integrationClientId,
        integration_event_id:record.integrationEventId,
        external_record_id:record.externalRecordId,
        external_staff_id:record.externalStaffId,
        external_staff_display_name:record.externalStaffDisplayName,
        voided_at:null, voided_by_actor_reference:null, void_reason:null,
      };
      state.sets.push(row); return clone(row);
    },
    async insertObservation(record) {
      const row = {
        vital_observation_id:record.vitalObservationId,
        vital_set_id:record.vitalSetId, source_ordinal:record.sourceOrdinal,
        measurement_type:record.measurementType,
        source_value_text:record.sourceValueText,
        numeric_value:record.numericValue, source_unit:record.sourceUnit,
        canonical_unit:record.canonicalUnit,
        measurement_context:record.measurementContext || null,
      };
      state.observations.push(row); return clone(row);
    },
    async insertEvent(record) {
      const row = {
        vital_event_id:record.vitalEventId, vital_set_id:record.vitalSetId,
        event_type:record.eventType, actor_type:record.actorType,
        actor_reference:record.actorReference, metadata:{ ...(record.metadata || {}) },
        occurred_at:stamp(),
      };
      state.events.push(row); return clone(row);
    },
    async findSet(vitalSetId) {
      return clone(state.sets.find((row) => row.vital_set_id === vitalSetId));
    },
    async findByExternalRecord(clientId, externalRecordId) {
      return clone(state.sets.find((row) => row.integration_client_id === clientId
        && row.external_record_id === externalRecordId));
    },
    async listObservations(vitalSetId) {
      return state.observations.filter((row) => row.vital_set_id === vitalSetId)
        .sort((a, b) => a.source_ordinal - b.source_ordinal).map(clone);
    },
    async voidSet({ vitalSetId, actorReference, reason }) {
      const row = state.sets.find((item) => item.vital_set_id === vitalSetId && item.status === 'recorded');
      if (!row) return null;
      Object.assign(row, { status:'voided', voided_at:stamp(),
        voided_by_actor_reference:actorReference, void_reason:reason });
      return clone(row);
    },
    async listHistory({ careProfileId, centerId, from, to, cursor, limit }) {
      return state.sets.filter((row) => row.status === 'recorded'
        && row.care_profile_id === careProfileId
        && (!dailyCareState || (() => {
          const links = dailyCareState.links.filter((link) => link.vital_set_id === row.vital_set_id);
          if (links.length === 0) return true;
          return links.some((link) => {
            const report = dailyCareState.reports.find((item) => item.daily_report_id === link.daily_report_id);
            if (!report || report.status !== 'finalized') return false;
            const latest = Math.max(...dailyCareState.reports.filter((item) => item.report_group_id === report.report_group_id
              && (item.status === 'finalized' || (item.status === 'voided' && item.finalized_at)))
              .map((item) => Number(item.version_no)));
            return Number(report.version_no) === latest;
          });
        })())
        && (!centerId || row.center_id === centerId)
        && (!from || row.occurred_at >= from) && (!to || row.occurred_at <= to)
        && (!cursor || row.occurred_at < cursor.occurredAt
          || (row.occurred_at === cursor.occurredAt && row.vital_set_id < cursor.vitalSetId)))
        .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at)
          || b.vital_set_id.localeCompare(a.vital_set_id))
        .slice(0, limit + 1)
        .map((row) => ({ ...clone(row), observations:state.observations
          .filter((item) => item.vital_set_id === row.vital_set_id)
          .sort((a, b) => a.source_ordinal - b.source_ordinal).map(clone) }));
    },
  };
}

module.exports = { createVitalSignMemoryRepository };
