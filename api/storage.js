module.exports = function handler(_request, response) {
  const restReadConfigured = Boolean(
    process.env.SUPABASE_URL &&
    (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY) &&
    process.env.FORCE_POSTGRES_READS !== 'true',
  );
  const postgresConfigured = Boolean(process.env.DATABASE_URL || process.env.SUPABASE_DB_URL);
  response.status(200).json({
    mode: restReadConfigured ? 'supabase-rest-read-postgres-write' : postgresConfigured ? 'supabase-postgres' : 'unconfigured',
    supabaseConnected: restReadConfigured || postgresConfigured,
    restReadConfigured,
    postgresConfigured,
    stateTable: process.env.SUPABASE_STATE_TABLE || 'fc26_app_state',
    playerTable: process.env.SUPABASE_PLAYER_TABLE || 'fc26_players',
  });
};
