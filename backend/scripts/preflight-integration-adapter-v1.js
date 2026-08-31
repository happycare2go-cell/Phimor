require('dotenv').config();
const {Pool}=require('pg');
const PREFLIGHT_SQL=`SELECT
  to_regclass('public.integration_clients') IS NOT NULL AS integration_clients_present,
  (to_regclass('public.integration_adapter_profiles') IS NOT NULL)::int AS existing_adapter_profiles_table,
  (to_regclass('public.integration_adapter_samples') IS NOT NULL)::int AS existing_adapter_samples_table`;
function printResult(row){
  console.log('PHIMOR_FIELD_PICKER_ADAPTER_0017_PREFLIGHT');
  console.log(`required_integration_clients: ${row.integration_clients_present?'PASS':'BLOCKED'}`);
  console.log(`existing_adapter_profiles_table: ${Number(row.existing_adapter_profiles_table)||0}`);
  console.log(`existing_adapter_samples_table: ${Number(row.existing_adapter_samples_table)||0}`);
  const safe=row.integration_clients_present&&!Number(row.existing_adapter_profiles_table)&&!Number(row.existing_adapter_samples_table);
  console.log(`RESULT: ${safe?'SAFE_TO_MIGRATE':'BLOCKED'}`);
  if(!safe)console.log('reason: required Integration schema is missing or a partial Adapter schema requires review');
  return safe;
}
async function main(){if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL_REQUIRED');const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});try{const result=await pool.query(PREFLIGHT_SQL);if(!printResult(result.rows[0]))process.exitCode=1;}finally{await pool.end();}}
if(require.main===module)main().catch((error)=>{console.error('PHIMOR_FIELD_PICKER_ADAPTER_0017_PREFLIGHT');console.error('RESULT: BLOCKED');console.error(`reason: ${String(error?.code||'PREFLIGHT_QUERY_FAILED').replace(/[^A-Z0-9_]/gi,'_').slice(0,80)}`);process.exitCode=1;});
module.exports={PREFLIGHT_SQL,printResult,main};
