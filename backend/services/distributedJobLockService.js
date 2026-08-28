const { acquireDatabaseClient } = require('../db');

function createDistributedJobLockService({acquireClient=acquireDatabaseClient}={}) {
  async function runWithLock(lockKey, task) {
    if (typeof lockKey!=='string'||!lockKey.trim()||typeof task!=='function') {
      throw new Error('DISTRIBUTED_JOB_LOCK_INPUT_REQUIRED');
    }
    const client=await acquireClient();let acquired=false;
    try {
      const result=await client.query(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',[lockKey.trim()]
      );
      acquired=result.rows?.[0]?.acquired===true;
      if (!acquired) return {acquired:false,skipped:true};
      return {acquired:true,skipped:false,result:await task()};
    } finally {
      if (acquired) {
        try { await client.query('SELECT pg_advisory_unlock(hashtext($1))',[lockKey.trim()]); }
        catch (_) { /* releasing the client also releases a session lock */ }
      }
      try { client.release(); } catch (_) { /* a lost session already released its lock */ }
    }
  }
  return {runWithLock};
}

module.exports={createDistributedJobLockService};
