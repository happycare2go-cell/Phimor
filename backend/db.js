const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pool.on('error', (err) => {
    console.error('Unexpected error on idle client', err);
});

const initTable = async (tableName) => {
    const query = `
        CREATE TABLE IF NOT EXISTS "${tableName}" (
            id VARCHAR PRIMARY KEY,
            data JSONB NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `;
    try {
        await pool.query(query);
    } catch (err) {
        console.error(`Error initializing table ${tableName}:`, err);
    }
};

const makeTable = (tableName) => {
    initTable(tableName);

    return {
        insert: async (record) => {
            const id = record.id || uuidv4();
            const recordWithId = { ...record, id };
            await pool.query(`INSERT INTO "${tableName}" (id, data) VALUES ($1, $2)`, [id, recordWithId]);
            return recordWithId;
        },
        findAll: async () => {
            const res = await pool.query(`SELECT data FROM "${tableName}" ORDER BY created_at DESC`);
            return res.rows.map(row => row.data);
        },
        findWhere: async (predicate) => {
            const res = await pool.query(`SELECT data FROM "${tableName}"`);
            const allData = res.rows.map(row => row.data);
            return allData.filter(predicate);
        },
        findOne: async (predicate) => {
            const res = await pool.query(`SELECT data FROM "${tableName}"`);
            const allData = res.rows.map(row => row.data);
            return allData.find(predicate);
        },
        update: async (id, updates) => {
            const res = await pool.query(`SELECT data FROM "${tableName}" WHERE id = $1`, [id]);
            if (res.rows.length === 0) return null;
            const updatedRecord = { ...res.rows[0].data, ...updates };
            await pool.query(`UPDATE "${tableName}" SET data = $1 WHERE id = $2`, [updatedRecord, id]);
            return updatedRecord;
        },
        remove: async (id) => {
            await pool.query(`DELETE FROM "${tableName}" WHERE id = $1`, [id]);
            return true;
        }
    };
};

module.exports = { makeTable };
