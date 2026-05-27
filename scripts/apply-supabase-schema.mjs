import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;

if (!connectionString) {
  console.error('Missing DATABASE_URL or SUPABASE_DB_URL.');
  process.exit(1);
}

const sql = await readFile('supabase/schema.sql', 'utf8');
const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

try {
  await pool.query(sql);
  const result = await pool.query(`
    select table_name
    from information_schema.tables
    where table_schema = 'public'
      and table_name in ('fc26_app_state', 'fc26_players')
    order by table_name
  `);
  console.log(`Created/verified tables: ${result.rows.map((row) => row.table_name).join(', ')}`);
} finally {
  await pool.end();
}
