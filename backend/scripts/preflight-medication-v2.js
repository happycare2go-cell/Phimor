require('dotenv').config();
const { Pool } = require('pg');

const REQUIRED_TABLES = ['medicationSnapshots', 'medications', 'careProfiles'];

const CHECK_SQL = `
WITH eligible_snapshots AS (
  SELECT
    data,
    data->>'snapshot_id' AS snapshot_id,
    data->>'care_profile_id' AS care_profile_id,
    CASE WHEN (data->>'version_no') ~ '^[0-9]+$' THEN (data->>'version_no')::bigint ELSE 0 END AS version_no,
    COALESCE(NULLIF(data->>'recorded_at','')::timestamptz, created_at) AS authority_time
  FROM "medicationSnapshots"
  WHERE lower(COALESCE(data->>'status','active')) NOT IN
    ('cancelled','revoked','deleted','invalid','superseded','old','archived','inactive')
), ranked AS (
  SELECT *, dense_rank() OVER (
    PARTITION BY care_profile_id ORDER BY version_no DESC, authority_time DESC
  ) AS authority_rank
  FROM eligible_snapshots
), latest AS (
  SELECT * FROM ranked WHERE authority_rank = 1
), linked_items AS (
  SELECT
    data->>'snapshot_id' AS snapshot_id,
    lower(regexp_replace(normalize(COALESCE(data->>'name',''), NFC), '\\s+', ' ', 'g')) AS normalized_name,
    NULLIF(lower(btrim(COALESCE(data->>'stable_medication_id',''))),'') AS stable_id
  FROM medications
  WHERE NULLIF(data->>'snapshot_id','') IS NOT NULL
), embedded_items AS (
  SELECT
    snapshot.snapshot_id,
    lower(regexp_replace(normalize(COALESCE(item->>'name',''), NFC), '\\s+', ' ', 'g')) AS normalized_name,
    NULLIF(lower(btrim(COALESCE(item->>'stable_medication_id', item->>'stableMedicationId', ''))),'') AS stable_id
  FROM eligible_snapshots snapshot
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(snapshot.data->'items') = 'array' THEN snapshot.data->'items' ELSE '[]'::jsonb END
  ) item
), effective_latest_items AS (
  SELECT latest.care_profile_id, latest.snapshot_id, item.normalized_name, item.stable_id
  FROM latest
  CROSS JOIN LATERAL (
    SELECT linked.normalized_name, linked.stable_id
    FROM linked_items linked
    WHERE linked.snapshot_id = latest.snapshot_id
    UNION ALL
    SELECT embedded.normalized_name, embedded.stable_id
    FROM embedded_items embedded
    WHERE embedded.snapshot_id = latest.snapshot_id
      AND NOT EXISTS (SELECT 1 FROM linked_items linked WHERE linked.snapshot_id = latest.snapshot_id)
  ) item
), duplicate_names AS (
  SELECT care_profile_id, snapshot_id, normalized_name
  FROM effective_latest_items
  WHERE normalized_name <> ''
  GROUP BY care_profile_id, snapshot_id, normalized_name HAVING count(*) > 1
), duplicate_stable_ids AS (
  SELECT care_profile_id, snapshot_id, stable_id
  FROM effective_latest_items
  WHERE stable_id IS NOT NULL
  GROUP BY care_profile_id, snapshot_id, stable_id HAVING count(*) > 1
), timestamp_ties AS (
  SELECT care_profile_id, authority_time
  FROM eligible_snapshots
  GROUP BY care_profile_id, authority_time HAVING count(*) > 1
), linked_embedded_mismatch AS (
  SELECT snapshot.snapshot_id
  FROM eligible_snapshots snapshot
  WHERE EXISTS (SELECT 1 FROM linked_items linked WHERE linked.snapshot_id = snapshot.snapshot_id)
    AND EXISTS (SELECT 1 FROM embedded_items embedded WHERE embedded.snapshot_id = snapshot.snapshot_id)
    AND (
      (SELECT count(*) FROM linked_items linked WHERE linked.snapshot_id = snapshot.snapshot_id)
        <> (SELECT count(*) FROM embedded_items embedded WHERE embedded.snapshot_id = snapshot.snapshot_id)
      OR EXISTS (
        (SELECT normalized_name, stable_id FROM linked_items linked WHERE linked.snapshot_id = snapshot.snapshot_id
         EXCEPT ALL
         SELECT normalized_name, stable_id FROM embedded_items embedded WHERE embedded.snapshot_id = snapshot.snapshot_id)
      )
      OR EXISTS (
        (SELECT normalized_name, stable_id FROM embedded_items embedded WHERE embedded.snapshot_id = snapshot.snapshot_id
         EXCEPT ALL
         SELECT normalized_name, stable_id FROM linked_items linked WHERE linked.snapshot_id = snapshot.snapshot_id)
      )
    )
), orphan_linked AS (
  SELECT 1 FROM medications medication
  WHERE NULLIF(medication.data->>'snapshot_id','') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM "medicationSnapshots" snapshot
      WHERE snapshot.data->>'snapshot_id' = medication.data->>'snapshot_id'
    )
), unsnapshotted AS (
  SELECT 1 FROM medications WHERE NULLIF(data->>'snapshot_id','') IS NULL
), equally_authoritative AS (
  SELECT care_profile_id FROM latest GROUP BY care_profile_id HAVING count(*) > 1
)
SELECT
  (SELECT count(*)::int FROM duplicate_names) AS duplicate_normalized_name_groups,
  (SELECT count(*)::int FROM duplicate_stable_ids) AS duplicate_stable_id_groups,
  (SELECT count(*)::int FROM timestamp_ties) AS timestamp_tie_groups,
  (SELECT count(*)::int FROM linked_embedded_mismatch) AS linked_embedded_mismatch_snapshots,
  (SELECT count(*)::int FROM orphan_linked) AS orphan_linked_medication_rows,
  (SELECT count(*)::int FROM unsnapshotted) AS unsnapshotted_legacy_medication_rows,
  (SELECT count(*)::int FROM equally_authoritative) AS equally_authoritative_care_profiles
`;

function printResult(counts) {
  console.log('PHIMOR_MEDICATION_V2_PREFLIGHT');
  console.log('required_tables: PASS');
  for (const [key, value] of Object.entries(counts)) console.log(`${key}: ${value}`);
  const blocking = Number(counts.duplicate_normalized_name_groups)
    + Number(counts.duplicate_stable_id_groups)
    + Number(counts.equally_authoritative_care_profiles);
  console.log(`RESULT: ${blocking === 0 ? 'SAFE_FOR_CONTROLLED_V2_ROLLOUT' : 'BLOCKED_REVIEW_REQUIRED'}`);
  if (blocking) console.log('reason: duplicate or ambiguous authoritative current medication state requires controlled review');
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString:process.env.DATABASE_URL, ssl:{ rejectUnauthorized:false } });
  try {
    const tableResult = await pool.query(
      `SELECT requested.table_name, to_regclass(format('%I', requested.table_name)) IS NOT NULL AS present
       FROM unnest($1::text[]) requested(table_name) ORDER BY requested.table_name`,
      [REQUIRED_TABLES]
    );
    const missing = tableResult.rows.filter((row) => !row.present).length;
    if (missing) {
      console.log('PHIMOR_MEDICATION_V2_PREFLIGHT');
      console.log('required_tables: BLOCKED');
      console.log(`missing_required_table_count: ${missing}`);
      console.log('RESULT: BLOCKED_REVIEW_REQUIRED');
      return;
    }
    const result = await pool.query(CHECK_SQL);
    printResult(result.rows[0]);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('PHIMOR_MEDICATION_V2_PREFLIGHT');
    console.error('RESULT: BLOCKED_REVIEW_REQUIRED');
    console.error(`reason: ${error.code || 'PREFLIGHT_QUERY_FAILED'}`);
    process.exitCode = 1;
  });
}

module.exports = { REQUIRED_TABLES, CHECK_SQL, printResult, main };
