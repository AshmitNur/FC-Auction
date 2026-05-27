const { Pool } = require('pg');

function createPostgresStore(connectionString, options = {}) {
  const stateTable = options.stateTable || 'fc26_app_state';
  const playerTable = options.playerTable || 'fc26_players';
  const stateKey = options.stateKey || 'default';
  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 4,
    idleTimeoutMillis: 30_000,
  });

  async function init() {
    await pool.query(`
      create table if not exists public.${stateTable} (
        key text primary key,
        state jsonb not null,
        updated_at timestamptz not null default now()
      );

      create table if not exists public.${playerTable} (
        id text primary key,
        rank integer not null,
        name text not null,
        overall_rating integer not null,
        position text,
        club text,
        nation text,
        gender text,
        player jsonb not null,
        updated_at timestamptz not null default now()
      );

      create index if not exists ${playerTable}_rating_rank_idx
        on public.${playerTable} (overall_rating desc, rank asc);

      alter table public.${stateTable} enable row level security;
      alter table public.${playerTable} enable row level security;

      drop policy if exists "${playerTable}_read" on public.${playerTable};
      create policy "${playerTable}_read"
        on public.${playerTable}
        for select
        to anon, authenticated
        using (true);

      grant usage on schema public to anon, authenticated;
      grant select on public.${playerTable} to anon, authenticated;
    `);
  }

  async function loadPlayers() {
    const result = await pool.query(`
      select player
      from public.${playerTable}
      order by overall_rating desc, rank asc
    `);
    return result.rows.map((row) => row.player).filter(Boolean);
  }

  async function seedPlayers(players) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      for (const player of players) {
        await client.query(
          `
            insert into public.${playerTable}
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
            player.id,
            player.rank,
            player.name,
            player.overallRating,
            player.position,
            player.club,
            player.nation,
            player.gender,
            JSON.stringify(player),
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
  }

  async function loadState() {
    const result = await pool.query(
      `select state from public.${stateTable} where key = $1`,
      [stateKey],
    );
    return result.rows[0]?.state || null;
  }

  async function saveState(state) {
    await pool.query(
      `
        insert into public.${stateTable} (key, state, updated_at)
        values ($1, $2::jsonb, now())
        on conflict (key) do update set
          state = excluded.state,
          updated_at = now()
      `,
      [stateKey, JSON.stringify(state)],
    );
  }

  async function close() {
    await pool.end();
  }

  return { init, loadPlayers, seedPlayers, loadState, saveState, close };
}

module.exports = { createPostgresStore };
