module.exports = function handler(_request, response) {
  response.status(200).json({
    mode: process.env.DATABASE_URL || process.env.SUPABASE_DB_URL ? 'supabase-postgres' : 'unconfigured',
    supabaseConnected: Boolean(process.env.DATABASE_URL || process.env.SUPABASE_DB_URL),
    stateTable: process.env.SUPABASE_STATE_TABLE || 'fc26_app_state',
    playerTable: process.env.SUPABASE_PLAYER_TABLE || 'fc26_players',
  });
};
