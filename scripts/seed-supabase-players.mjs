import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const PLAYER_TABLE = process.env.SUPABASE_PLAYER_TABLE || 'fc26_players';

if (!DATABASE_URL && (!SUPABASE_URL || !SUPABASE_KEY)) {
  console.error('Missing DATABASE_URL, or SUPABASE_URL plus SUPABASE_SERVICE_ROLE_KEY/SUPABASE_ANON_KEY.');
  process.exit(1);
}

const payload = JSON.parse(await readFile('data/fc26-players-81-plus.json', 'utf8'));

const rows = payload.players.map((player) => ({
  id: player.id,
  rank: player.rank,
  name: player.name,
  overall_rating: player.overallRating,
  position: player.position,
  club: player.club,
  nation: player.nation,
  gender: player.gender,
  player,
  updated_at: new Date().toISOString(),
}));

if (DATABASE_URL) {
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  try {
    for (let index = 0; index < rows.length; index += 100) {
      const chunk = rows.slice(index, index + 100);
      const client = await pool.connect();
      try {
        await client.query('begin');
        for (const row of chunk) {
          await client.query(
            `
              insert into public.${PLAYER_TABLE}
                (id, rank, name, overall_rating, position, club, nation, gender, player, updated_at)
              values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, now())
              on conflict (id) do update set
                rank = excluded.rank,
                name = excluded.name,
                overall_rating = excluded.overall_rating,
                position = excluded.position,
                club = excluded.club,
                nation = excluded.nation,
                gender = excluded.gender,
                player = excluded.player,
                updated_at = now()
            `,
            [
              row.id,
              row.rank,
              row.name,
              row.overall_rating,
              row.position,
              row.club,
              row.nation,
              row.gender,
              JSON.stringify(row.player),
            ],
          );
        }
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
      console.log(`Seeded ${Math.min(index + chunk.length, rows.length)}/${rows.length}`);
    }
  } finally {
    await pool.end();
  }
} else {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
  for (let index = 0; index < rows.length; index += 100) {
    const chunk = rows.slice(index, index + 100);
    const { error } = await supabase.from(PLAYER_TABLE).upsert(chunk);
    if (error) {
      console.error(error);
      process.exit(1);
    }
    console.log(`Seeded ${Math.min(index + chunk.length, rows.length)}/${rows.length}`);
  }
}

console.log(`Seeded ${rows.length} FC 26 players into ${PLAYER_TABLE}.`);
