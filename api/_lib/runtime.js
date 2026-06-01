const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const pg = require('pg');

const ROOT = process.cwd();
const PLAYER_FILE = path.join(ROOT, 'data', 'fc26-players-81-plus.json');
const SUPABASE_STATE_TABLE = process.env.SUPABASE_STATE_TABLE || 'fc26_app_state';
const SUPABASE_PLAYER_TABLE = process.env.SUPABASE_PLAYER_TABLE || 'fc26_players';
const SUPABASE_STATE_KEY = process.env.SUPABASE_STATE_KEY || 'default';
const DATABASE_URL = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || '';
const ENSURE_SCHEMA = process.env.ENSURE_SCHEMA === 'true' || process.env.NODE_ENV !== 'production';
const LOAD_REMOTE_PLAYERS = process.env.LOAD_REMOTE_PLAYERS === 'true';

const playerPayload = JSON.parse(fs.readFileSync(PLAYER_FILE, 'utf8'));
let players = playerPayload.players;
let playerById = new Map(players.map((player) => [player.id, player]));
let remotePlayersLoaded = false;
let pool;
let schemaReady;
let cachedState = null;
let cachedStateUntil = 0;
const STATE_CACHE_MS = Number(process.env.STATE_CACHE_MS || 1500);

function db() {
  if (!DATABASE_URL) throw new Error('DATABASE_URL is not configured.');
  if (!pool) {
    pool = new pg.Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 1,
      idleTimeoutMillis: 1_000,
      connectionTimeoutMillis: 8_000,
      maxLifetimeSeconds: 30,
      allowExitOnIdle: true,
    });
  }
  return pool;
}

function isConnectionPressure(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('max client connections') || message.includes('too many clients') || message.includes('emaxconn');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withConnectionRetry(operation) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isConnectionPressure(error)) throw error;
      await sleep(120 * (attempt + 1) + Math.floor(Math.random() * 80));
    }
  }
  throw lastError;
}

function rememberState(state) {
  cachedState = state;
  cachedStateUntil = Date.now() + STATE_CACHE_MS;
  return state;
}

function cloneState(state) {
  return typeof structuredClone === 'function' ? structuredClone(state) : JSON.parse(JSON.stringify(state));
}

function cachedReadableState() {
  if (!cachedState || Date.now() > cachedStateUntil) return null;
  const nextState = cloneState(cachedState);
  const timed = applyTimer(nextState);
  return timed.changed ? null : timed.state;
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

function defaultParticipants() {
  return Array.from({ length: 12 }, (_, index) => ({
    id: `participant_${index + 1}`,
    name: `Player ${index + 1}`,
    teamName: index < 6 ? `Group A ${index + 1}` : `Group B ${index - 5}`,
    group: index < 6 ? 'A' : 'B',
    startingBudget: 2_000_000_000,
    remainingBudget: 2_000_000_000,
    createdAt: new Date().toISOString(),
  }));
}

function defaultState() {
  return {
    tournament: {
      id: id('tournament'),
      name: 'FC 26 LAN Night',
      format: '2 Groups + Knockout',
      platform: 'PS5 / PC / Xbox',
      status: 'draft',
      locked: false,
    },
    settings: {
      participantCount: 12,
      auctionBudget: 2_000_000_000,
      minimumBid: 10_000_000,
      bidIncrement: 10_000_000,
      squadSize: 18,
      minimumSquadSize: 11,
      auctionTimer: 30,
      lateBidExtension: 5,
      thirdPlace: false,
      autoSkipNoBid: true,
      unsoldReauction: true,
    },
    users: [],
    participants: defaultParticipants(),
    squads: {},
    auction: {
      status: 'draft',
      currentPlayerId: null,
      currentBid: 0,
      highestBidderId: null,
      timerRemaining: 30,
      deadlineAt: null,
      bidLog: [],
      history: [],
      unsoldQueue: [],
    },
    fixtures: [],
    updatedAt: new Date().toISOString(),
  };
}

async function initSchema() {
  if (!ENSURE_SCHEMA) return;
  if (!schemaReady) {
    schemaReady = withConnectionRetry(() => db().query(`
    create table if not exists public.${SUPABASE_STATE_TABLE} (
      key text primary key,
      state jsonb not null,
      updated_at timestamptz not null default now()
    );

    create table if not exists public.${SUPABASE_PLAYER_TABLE} (
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
    `)).catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

async function loadPlayers() {
  if (remotePlayersLoaded) return;
  if (!LOAD_REMOTE_PLAYERS) {
    remotePlayersLoaded = true;
    return;
  }
  await initSchema();
  let result;
  try {
    result = await withConnectionRetry(() => db().query(`
    select player
    from public.${SUPABASE_PLAYER_TABLE}
    order by overall_rating desc, rank asc
  `));
  } catch (error) {
    if (!isConnectionPressure(error)) throw error;
    remotePlayersLoaded = true;
    return;
  }
  if (result.rows.length) {
    players = result.rows.map((row) => row.player).filter(Boolean);
    playerById = new Map(players.map((player) => [player.id, player]));
    remotePlayersLoaded = true;
  }
}

async function seedStateIfNeeded(client) {
  const existing = await client.query(
    `select state from public.${SUPABASE_STATE_TABLE} where key = $1`,
    [SUPABASE_STATE_KEY],
  );
  if (existing.rows[0]?.state) return existing.rows[0].state;

  const nextState = defaultState();
  await client.query(
    `
      insert into public.${SUPABASE_STATE_TABLE} (key, state, updated_at)
      values ($1, $2::jsonb, now())
      on conflict (key) do update set state = excluded.state, updated_at = now()
    `,
    [SUPABASE_STATE_KEY, JSON.stringify(nextState)],
  );
  return nextState;
}

async function readState() {
  await initSchema();
  await loadPlayers();
  const cached = cachedReadableState();
  if (cached) return cached;

  const result = await withConnectionRetry(() => db().query(
    `select state from public.${SUPABASE_STATE_TABLE} where key = $1`,
    [SUPABASE_STATE_KEY],
  ));
  const state = result.rows[0]?.state;
  if (state) {
    const nextState = applyTimer(state);
    if (!nextState.changed) return rememberState(nextState.state);
  }

  const client = await withConnectionRetry(() => db().connect());
  try {
    await client.query('begin');
    const locked = await client.query(
      `select state from public.${SUPABASE_STATE_TABLE} where key = $1 for update`,
      [SUPABASE_STATE_KEY],
    );
    const lockedState = locked.rows[0]?.state || (await seedStateIfNeeded(client));
    const nextState = applyTimer(lockedState);
    if (nextState.changed) {
      await saveState(client, nextState.state);
    }
    await client.query('commit');
    return rememberState(nextState.state);
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function mutateState(event, data = {}) {
  await initSchema();
  await loadPlayers();
  const client = await withConnectionRetry(() => db().connect());
  try {
    await client.query('begin');
    const result = await client.query(
      `select state from public.${SUPABASE_STATE_TABLE} where key = $1 for update`,
      [SUPABASE_STATE_KEY],
    );
    let state = result.rows[0]?.state || defaultState();
    state = applyTimer(state).state;
    applyAction(state, event, data);
    await saveState(client, state);
    await client.query('commit');
    return rememberState(state);
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function saveState(client, state) {
  normalizeUsers(state);
  normalizeBudgets(state);
  state.updatedAt = new Date().toISOString();
  await client.query(
    `
      insert into public.${SUPABASE_STATE_TABLE} (key, state, updated_at)
      values ($1, $2::jsonb, now())
      on conflict (key) do update set state = excluded.state, updated_at = now()
    `,
    [SUPABASE_STATE_KEY, JSON.stringify(state)],
  );
}

function payload(state) {
  normalizeUsers(state);
  normalizeBudgets(state);
  return {
    state,
    playersMeta: { ...playerPayload.meta, count: players.length, storage: 'supabase' },
    players,
  };
}

function participantById(state, participantId) {
  return state.participants.find((participant) => participant.id === participantId);
}

function cleanName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ');
}

function normalizedName(name) {
  return cleanName(name).toLowerCase();
}

function userIdFor(name) {
  return `user_${crypto.createHash('sha1').update(normalizedName(name)).digest('hex').slice(0, 10)}`;
}

function participantSlot(participant) {
  const numericId = Number(String(participant.id || '').replace('participant_', ''));
  if (Number.isInteger(numericId) && numericId >= 1) {
    return participant.group === 'B' ? numericId - 6 : numericId;
  }
  return null;
}

function userFromParticipant(participant) {
  const name = cleanName(participant.name);
  return {
    id: userIdFor(name),
    name,
    role: 'player',
    participantId: participant.id,
    teamName: participant.teamName,
    group: participant.group,
    slot: participantSlot(participant),
    createdAt: participant.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function normalizeUsers(state) {
  state.users = Array.isArray(state.users) ? state.users : [];
  const adminsByName = new Map();
  state.users
    .filter((user) => user?.role === 'admin' && cleanName(user.name))
    .forEach((user) => {
      adminsByName.set(normalizedName(user.name), {
        ...user,
        id: userIdFor(user.name),
        name: cleanName(user.name),
        role: 'admin',
      });
    });

  const playersByName = new Map();
  (state.participants || [])
    .filter((participant) => cleanName(participant.name))
    .forEach((participant) => {
      const key = normalizedName(participant.name);
      const existing = state.users.find((user) => user?.role === 'player' && normalizedName(user.name) === key);
      playersByName.set(key, {
        ...userFromParticipant(participant),
        createdAt: existing?.createdAt || participant.createdAt || new Date().toISOString(),
        lastSeenAt: existing?.lastSeenAt,
      });
    });

  state.users = [...adminsByName.values(), ...playersByName.values()];
  return state;
}

function loginUser(state, data) {
  normalizeUsers(state);
  const name = cleanName(data.name);
  if (!name) throw new Error('Name is required.');

  const role = data.role === 'admin' ? 'admin' : 'player';
  if (role === 'admin') {
    const existingAdmin = state.users.find((user) => user.role === 'admin' && normalizedName(user.name) === normalizedName(name));
    if (existingAdmin) {
      existingAdmin.lastSeenAt = new Date().toISOString();
      return existingAdmin;
    }
    if (state.users.some((user) => user.role === 'admin')) {
      throw new Error('Admin access already exists. Sign in with an existing admin name.');
    }
  }
  if (role === 'player' && !state.participants.some((participant) => normalizedName(participant.name) === normalizedName(name))) {
    throw new Error('Player access is limited to the configured owners in Setup.');
  }
  const existing = state.users.find((user) => user.role === role && normalizedName(user.name) === normalizedName(name));
  if (existing) {
    existing.lastSeenAt = new Date().toISOString();
    return existing;
  }

  const user = {
    id: userIdFor(name),
    name,
    role,
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  };
  state.users.push(user);
  return user;
}

function actorFrom(state, data) {
  normalizeUsers(state);
  const actor = data.actor || {};
  const user = state.users.find((item) =>
    (actor.id && item.id === actor.id) ||
    (actor.name && normalizedName(item.name) === normalizedName(actor.name)),
  );
  if (!user) throw new Error('Sign in required.');
  return user;
}

function requireAdmin(state, data) {
  const actor = actorFrom(state, data);
  if (actor.role !== 'admin') throw new Error('Admin access required.');
  return actor;
}

function requireSignedIn(state, data) {
  return actorFrom(state, data);
}

function canActForParticipant(actor, participant) {
  return actor.role === 'admin' || normalizedName(actor.name) === normalizedName(participant.name);
}

function updateUser(state, data) {
  const actor = requireAdmin(state, data);
  const user = state.users.find((item) => item.id === data.userId);
  if (!user) throw new Error('User not found.');
  user.role = data.role === 'admin' ? 'admin' : 'player';
  user.name = cleanName(data.name || user.name);
  user.id = userIdFor(user.name);
  user.updatedAt = new Date().toISOString();
  if (user.id === actor.id) data.actor.id = user.id;
}

function deleteUser(state, data) {
  const actor = requireAdmin(state, data);
  if (data.userId === actor.id) throw new Error('You cannot delete your own active admin user.');
  state.users = state.users.filter((user) => user.id !== data.userId);
}

function normalizeBudgets(state) {
  const budget = Number(state.settings.auctionBudget);
  state.participants = state.participants.map((participant) => {
    const purchases = state.squads[participant.id] || [];
    const spent = purchases.reduce((sum, purchase) => sum + Number(purchase.purchasePrice || 0), 0);
    const startingBudget = Number.isFinite(participant.startingBudget) ? Number(participant.startingBudget) : budget;
    return {
      ...participant,
      startingBudget,
      remainingBudget: startingBudget - spent,
    };
  });
  return state;
}

function soldPlayerIds(state) {
  return new Set(Object.values(state.squads).flat().map((purchase) => purchase.playerId));
}

function availablePlayers(state) {
  const sold = soldPlayerIds(state);
  return players.filter((player) => !sold.has(player.id) && player.id !== state.auction.currentPlayerId);
}

function setDeadline(state) {
  state.auction.deadlineAt = new Date(Date.now() + state.auction.timerRemaining * 1000).toISOString();
}

function applyTimer(state) {
  if (state.auction.status !== 'running' || !state.auction.currentPlayerId || !state.auction.deadlineAt) {
    return { state, changed: false };
  }
  const remaining = Math.max(0, Math.ceil((new Date(state.auction.deadlineAt).getTime() - Date.now()) / 1000));
  state.auction.timerRemaining = remaining;
  if (remaining <= 0) sellCurrent(state);
  return { state, changed: remaining <= 0 };
}

function nominatePlayer(state, playerId) {
  const player = playerById.get(String(playerId));
  if (!player) throw new Error('Player not found in FC 26 81+ pool.');
  if (soldPlayerIds(state).has(player.id)) throw new Error('Player has already been sold.');
  if (state.auction.currentPlayerId) throw new Error('Finish or skip the current player before nominating another.');

  state.auction.currentPlayerId = player.id;
  state.auction.currentBid = 0;
  state.auction.highestBidderId = null;
  state.auction.timerRemaining = state.settings.auctionTimer;
  state.auction.status = state.auction.status === 'paused' ? 'paused' : 'running';
  state.tournament.status = 'auction';
  setDeadline(state);
}

function randomNominate(state) {
  const pool = availablePlayers(state);
  if (!pool.length) throw new Error('No available players left to nominate.');
  nominatePlayer(state, pool[Math.floor(Math.random() * pool.length)].id);
}

function nextValidBid(state) {
  return state.auction.currentBid ? state.auction.currentBid + state.settings.bidIncrement : state.settings.minimumBid;
}

function bidAmountFor(state, amount, autoNext) {
  return autoNext ? nextValidBid(state) : Number(amount);
}

function validateBid(state, participantId, amount, autoNext = false) {
  normalizeBudgets(state);
  const participant = participantById(state, participantId);
  const playerId = state.auction.currentPlayerId;
  const numericAmount = bidAmountFor(state, amount, autoNext);

  if (!participant) return 'Participant not found.';
  if (!playerId) return 'No player is currently nominated.';
  if (soldPlayerIds(state).has(playerId)) return 'This player has already been sold.';
  if (!Number.isFinite(numericAmount)) return 'Bid must be a number.';
  if (numericAmount < state.settings.minimumBid) return 'Bid is below the minimum opening bid.';
  if (numericAmount % state.settings.bidIncrement !== 0) return 'Bid must follow the bid increment.';
  if (numericAmount <= state.auction.currentBid) return 'Bid must be higher than the current bid.';
  if (state.auction.currentBid && numericAmount < state.auction.currentBid + state.settings.bidIncrement) {
    return 'Bid must be at least one increment higher than the current bid.';
  }
  if (numericAmount > participant.remainingBudget) return 'Bid exceeds participant budget.';
  if ((state.squads[participant.id] || []).length >= state.settings.squadSize) return 'Participant squad is already full.';
  return null;
}

function placeBid(state, participantId, amount, autoNext = false) {
  const bidAmount = bidAmountFor(state, amount, autoNext);
  const message = validateBid(state, participantId, bidAmount, false);
  if (message) throw new Error(message);

  state.auction.currentBid = bidAmount;
  state.auction.highestBidderId = participantId;
  state.auction.bidLog.unshift({
    id: id('bid'),
    playerId: state.auction.currentPlayerId,
    participantId,
    bidAmount,
    timestamp: new Date().toISOString(),
  });

  if (
    state.auction.status === 'running' &&
    state.auction.timerRemaining <= state.settings.lateBidExtension
  ) {
    state.auction.timerRemaining += state.settings.lateBidExtension;
  }
  setDeadline(state);
}

function clearCurrentAuction(state) {
  state.auction.currentPlayerId = null;
  state.auction.currentBid = 0;
  state.auction.highestBidderId = null;
  state.auction.timerRemaining = state.settings.auctionTimer;
  state.auction.deadlineAt = null;
}

function sellCurrent(state) {
  const playerId = state.auction.currentPlayerId;
  if (!playerId) throw new Error('No current player to sell.');

  if (!state.auction.highestBidderId) {
    if (!state.auction.unsoldQueue.includes(playerId)) state.auction.unsoldQueue.push(playerId);
    state.auction.history.unshift({
      id: id('unsold'),
      type: 'unsold',
      playerId,
      timestamp: new Date().toISOString(),
    });
    clearCurrentAuction(state);
    return;
  }

  const participant = participantById(state, state.auction.highestBidderId);
  if (!participant) throw new Error('Winning participant not found.');

  state.squads[participant.id] = state.squads[participant.id] || [];
  state.squads[participant.id].push({
    id: id('squad_player'),
    playerId,
    purchasePrice: state.auction.currentBid,
    purchasedAt: new Date().toISOString(),
  });

  state.auction.unsoldQueue = state.auction.unsoldQueue.filter((item) => item !== playerId);
  state.auction.history.unshift({
    id: id('sale'),
    type: 'sale',
    playerId,
    participantId: participant.id,
    amount: state.auction.currentBid,
    timestamp: new Date().toISOString(),
  });
  normalizeBudgets(state);
  clearCurrentAuction(state);
}

function undoLastSale(state) {
  const saleIndex = state.auction.history.findIndex((entry) => entry.type === 'sale');
  if (saleIndex === -1) throw new Error('No sale is available to undo.');

  const sale = state.auction.history[saleIndex];
  state.squads[sale.participantId] = (state.squads[sale.participantId] || []).filter(
    (purchase) => purchase.playerId !== sale.playerId,
  );
  state.auction.history.splice(saleIndex, 1);
  normalizeBudgets(state);
}

function releasePlayer(state, data) {
  const participant = participantById(state, data.participantId);
  if (!participant) throw new Error('Participant not found.');

  const squad = state.squads[participant.id] || [];
  const purchase = squad.find((item) => item.id === data.purchaseId || item.playerId === data.playerId);
  if (!purchase) throw new Error('Player purchase not found in this squad.');

  state.squads[participant.id] = squad.filter((item) => item.id !== purchase.id);
  state.auction.history.unshift({
    id: id('release'),
    type: 'release',
    playerId: purchase.playerId,
    participantId: participant.id,
    amount: purchase.purchasePrice,
    timestamp: new Date().toISOString(),
  });
  normalizeBudgets(state);
}

function roundRobin(groupParticipants, group) {
  const list = [...groupParticipants];
  const rounds = [];
  for (let round = 0; round < list.length - 1; round += 1) {
    const pairs = [];
    for (let index = 0; index < list.length / 2; index += 1) {
      pairs.push({ home: list[index], away: list[list.length - 1 - index] });
    }
    rounds.push(pairs);
    list.splice(1, 0, list.pop());
  }

  return rounds.flatMap((pairs, roundIndex) =>
    pairs.map(({ home, away }, matchIndex) => ({
      id: id('fixture'),
      round: `Group ${group} - Round ${roundIndex + 1}`,
      stage: 'group',
      group,
      playerAId: home.id,
      playerBId: away.id,
      playerAScore: null,
      playerBScore: null,
      winnerId: null,
      status: 'pending',
      sort: roundIndex * 10 + matchIndex,
    })),
  );
}

function generateFixtures(state) {
  const groupA = state.participants.filter((participant) => participant.group === 'A');
  const groupB = state.participants.filter((participant) => participant.group === 'B');
  if (groupA.length !== 6 || groupB.length !== 6) {
    throw new Error('Default fixture generation requires exactly six participants in each group.');
  }
  state.fixtures = [...roundRobin(groupA, 'A'), ...roundRobin(groupB, 'B')];
  state.tournament.status = 'active';
}

function tableFor(state, group) {
  const rows = state.participants
    .filter((participant) => participant.group === group)
    .map((participant) => ({
      participantId: participant.id,
      P: 0,
      W: 0,
      D: 0,
      L: 0,
      GF: 0,
      GA: 0,
      GD: 0,
      Pts: 0,
    }));
  const byId = new Map(rows.map((row) => [row.participantId, row]));

  for (const fixture of state.fixtures.filter((item) => item.stage === 'group' && item.group === group)) {
    if (fixture.status !== 'completed') continue;
    const a = byId.get(fixture.playerAId);
    const b = byId.get(fixture.playerBId);
    if (!a || !b) continue;
    a.P += 1;
    b.P += 1;
    a.GF += fixture.playerAScore;
    a.GA += fixture.playerBScore;
    b.GF += fixture.playerBScore;
    b.GA += fixture.playerAScore;
    if (fixture.playerAScore > fixture.playerBScore) {
      a.W += 1;
      b.L += 1;
      a.Pts += 3;
    } else if (fixture.playerBScore > fixture.playerAScore) {
      b.W += 1;
      a.L += 1;
      b.Pts += 3;
    } else {
      a.D += 1;
      b.D += 1;
      a.Pts += 1;
      b.Pts += 1;
    }
    a.GD = a.GF - a.GA;
    b.GD = b.GF - b.GA;
  }

  return rows.sort((a, b) => {
    if (b.Pts !== a.Pts) return b.Pts - a.Pts;
    if (b.GD !== a.GD) return b.GD - a.GD;
    if (b.GF !== a.GF) return b.GF - a.GF;
    if (a.Pts === b.Pts) {
      const h2h = state.fixtures.find(
        (fixture) =>
          fixture.stage === 'group' &&
          fixture.status === 'completed' &&
          ((fixture.playerAId === a.participantId && fixture.playerBId === b.participantId) ||
            (fixture.playerAId === b.participantId && fixture.playerBId === a.participantId)),
      );
      if (h2h && h2h.playerAScore !== h2h.playerBScore) {
        const winner = h2h.playerAScore > h2h.playerBScore ? h2h.playerAId : h2h.playerBId;
        if (winner === a.participantId) return -1;
        if (winner === b.participantId) return 1;
      }
    }
    if (a.GA !== b.GA) return a.GA - b.GA;
    return a.participantId.localeCompare(b.participantId);
  });
}

function requireCompletedGroupFixtures(state) {
  for (const group of ['A', 'B']) {
    const fixtures = state.fixtures.filter((fixture) => fixture.stage === 'group' && fixture.group === group);
    if (!fixtures.length || fixtures.some((fixture) => fixture.status !== 'completed')) {
      throw new Error(`Complete all Group ${group} fixtures before building the bracket.`);
    }
  }
}

function generateKnockout(state) {
  requireCompletedGroupFixtures(state);
  const a = tableFor(state, 'A');
  const b = tableFor(state, 'B');
  if (a.length < 4 || b.length < 4) throw new Error('Both groups need four ranked teams.');

  const existingGroups = state.fixtures.filter((fixture) => fixture.stage === 'group');
  const bracket = [
    ['qf1', 'Quarter-final', a[0].participantId, b[3].participantId],
    ['qf2', 'Quarter-final', b[1].participantId, a[2].participantId],
    ['qf3', 'Quarter-final', b[0].participantId, a[3].participantId],
    ['qf4', 'Quarter-final', a[1].participantId, b[2].participantId],
    ['sf1', 'Semi-final', null, null],
    ['sf2', 'Semi-final', null, null],
    ['final', 'Final', null, null],
  ];
  if (state.settings.thirdPlace) bracket.push(['third', 'Third-place', null, null]);

  state.fixtures = [
    ...existingGroups,
    ...bracket.map(([idValue, round, playerAId, playerBId], index) => ({
      id: idValue,
      round,
      stage: 'knockout',
      group: 'knockout',
      playerAId,
      playerBId,
      playerAScore: null,
      playerBScore: null,
      winnerId: null,
      status: 'pending',
      sort: 1000 + index,
    })),
  ];
}

function fixtureWinner(fixture) {
  if (!fixture || fixture.status !== 'completed') return null;
  return fixture.winnerId || (fixture.playerAScore > fixture.playerBScore ? fixture.playerAId : fixture.playerBId);
}

function fixtureLoser(fixture) {
  const winner = fixtureWinner(fixture);
  if (!winner) return null;
  return fixture.playerAId === winner ? fixture.playerBId : fixture.playerAId;
}

function progressBracket(state) {
  const byId = new Map(state.fixtures.map((fixture) => [fixture.id, fixture]));
  if (byId.has('sf1')) {
    byId.get('sf1').playerAId = fixtureWinner(byId.get('qf1'));
    byId.get('sf1').playerBId = fixtureWinner(byId.get('qf2'));
  }
  if (byId.has('sf2')) {
    byId.get('sf2').playerAId = fixtureWinner(byId.get('qf3'));
    byId.get('sf2').playerBId = fixtureWinner(byId.get('qf4'));
  }
  if (byId.has('final')) {
    byId.get('final').playerAId = fixtureWinner(byId.get('sf1'));
    byId.get('final').playerBId = fixtureWinner(byId.get('sf2'));
  }
  if (byId.has('third')) {
    byId.get('third').playerAId = fixtureLoser(byId.get('sf1'));
    byId.get('third').playerBId = fixtureLoser(byId.get('sf2'));
  }
}

function updateFixtureResult(state, data) {
  const fixture = state.fixtures.find((item) => item.id === data.fixtureId);
  if (!fixture) throw new Error('Fixture not found.');
  const aScore = Number(data.playerAScore);
  const bScore = Number(data.playerBScore);
  if (!Number.isInteger(aScore) || !Number.isInteger(bScore) || aScore < 0 || bScore < 0) {
    throw new Error('Scores must be non-negative whole numbers.');
  }
  if (fixture.stage === 'knockout' && aScore === bScore && !data.winnerId) {
    throw new Error('Knockout draws need a selected winner.');
  }

  fixture.playerAScore = aScore;
  fixture.playerBScore = bScore;
  fixture.winnerId = data.winnerId || (aScore === bScore ? null : aScore > bScore ? fixture.playerAId : fixture.playerBId);
  fixture.status = 'completed';
  progressBracket(state);
}

function updateParticipant(state, data) {
  requireAdmin(state, data);
  const participant = participantById(state, data.id);
  if (!participant) throw new Error('Participant not found.');
  participant.name = data.name ?? participant.name;
  participant.teamName = data.teamName ?? participant.teamName;
  participant.group = data.group ?? participant.group;
}

function joinParticipant(state, data) {
  const actor = requireSignedIn(state, data);
  const group = data.group === 'B' ? 'B' : 'A';
  const slot = Number(data.slot);
  if (!Number.isInteger(slot) || slot < 1 || slot > 6) {
    throw new Error('Choose a group slot from 1 to 6.');
  }

  const index = group === 'A' ? slot - 1 : slot + 5;
  const participant = state.participants[index];
  if (!participant) throw new Error('Participant slot not found.');

  const name = String(data.name || '').trim();
  const teamName = String(data.teamName || '').trim();
  if (!name) throw new Error('Name is required to join the auction.');
  if (actor.role !== 'admin' && normalizedName(name) !== normalizedName(actor.name)) {
    throw new Error('Players can only join with their signed-in name.');
  }

  participant.name = name;
  participant.teamName = teamName || `${name} FC`;
  participant.group = group;
  participant.joinedAt = new Date().toISOString();
}

function updateSettings(state, data) {
  requireAdmin(state, data);
  state.settings = { ...state.settings, ...data };
  const budget = Number(state.settings.auctionBudget);
  state.participants = state.participants.map((participant) => {
    const spent = (state.squads[participant.id] || []).reduce((sum, purchase) => sum + purchase.purchasePrice, 0);
    return { ...participant, startingBudget: budget, remainingBudget: budget - spent };
  });
}

function skipCurrent(state) {
  if (state.auction.currentPlayerId && !state.auction.unsoldQueue.includes(state.auction.currentPlayerId)) {
    state.auction.unsoldQueue.push(state.auction.currentPlayerId);
  }
  clearCurrentAuction(state);
}

function applyAction(state, event, data) {
  const actions = {
    'user:login': () => loginUser(state, data),
    'user:update': () => updateUser(state, data),
    'user:delete': () => deleteUser(state, data),
    'participant:update': () => updateParticipant(state, data),
    'participant:join': () => joinParticipant(state, data),
    'settings:update': () => updateSettings(state, data),
    'auction:start': () => {
      requireAdmin(state, data);
      state.auction.status = 'running';
      state.tournament.status = 'auction';
      if (state.auction.currentPlayerId) setDeadline(state);
    },
    'auction:pause': () => {
      requireAdmin(state, data);
      state.auction.status = 'paused';
      state.auction.deadlineAt = null;
    },
    'auction:nominate': () => {
      requireAdmin(state, data);
      nominatePlayer(state, data.playerId);
    },
    'auction:randomNominate': () => {
      requireAdmin(state, data);
      randomNominate(state);
    },
    'auction:bid': () => {
      const actor = requireSignedIn(state, data);
      const participant = participantById(state, data.participantId);
      if (!participant) throw new Error('Participant not found.');
      if (!canActForParticipant(actor, participant)) throw new Error('Players can only bid for their own slot.');
      placeBid(state, data.participantId, data.amount, data.autoNext === true);
    },
    'auction:sell': () => {
      requireAdmin(state, data);
      sellCurrent(state);
    },
    'auction:releasePlayer': () => {
      requireAdmin(state, data);
      releasePlayer(state, data);
    },
    'auction:skip': () => {
      requireAdmin(state, data);
      skipCurrent(state);
    },
    'auction:undoLastSale': () => {
      requireAdmin(state, data);
      undoLastSale(state);
    },
    'fixtures:generate': () => {
      requireAdmin(state, data);
      generateFixtures(state);
    },
    'fixtures:generateKnockout': () => {
      requireAdmin(state, data);
      generateKnockout(state);
    },
    'fixture:updateResult': () => {
      requireAdmin(state, data);
      updateFixtureResult(state, data);
    },
    'tournament:reset': () => {
      requireAdmin(state, data);
      Object.assign(state, defaultState(), { users: state.users });
    },
  };

  const action = actions[event];
  if (!action) throw new Error(`Unsupported action: ${event}`);
  action();
}

module.exports = {
  defaultState,
  mutateState,
  payload,
  readState,
};
