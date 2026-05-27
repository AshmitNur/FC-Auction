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

const playerPayload = JSON.parse(fs.readFileSync(PLAYER_FILE, 'utf8'));
let players = playerPayload.players;
let playerById = new Map(players.map((player) => [player.id, player]));
let remotePlayersLoaded = false;
let pool;

function db() {
  if (!DATABASE_URL) throw new Error('DATABASE_URL is not configured.');
  if (!pool) {
    pool = new pg.Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 2,
      idleTimeoutMillis: 10_000,
    });
  }
  return pool;
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
  await db().query(`
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
  `);
}

async function loadPlayers() {
  if (remotePlayersLoaded) return;
  await initSchema();
  const result = await db().query(`
    select player
    from public.${SUPABASE_PLAYER_TABLE}
    order by overall_rating desc, rank asc
  `);
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
  const client = await db().connect();
  try {
    await client.query('begin');
    const state = await seedStateIfNeeded(client);
    const nextState = applyTimer(state);
    if (nextState.changed) {
      await saveState(client, nextState.state);
    }
    await client.query('commit');
    return nextState.state;
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
  const client = await db().connect();
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
    return state;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function saveState(client, state) {
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
  if (remaining === state.auction.timerRemaining) return { state, changed: false };
  state.auction.timerRemaining = remaining;
  if (remaining <= 0) sellCurrent(state);
  return { state, changed: true };
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

function validateBid(state, participantId, amount) {
  normalizeBudgets(state);
  const participant = participantById(state, participantId);
  const playerId = state.auction.currentPlayerId;
  const numericAmount = Number(amount);

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

function placeBid(state, participantId, amount) {
  const message = validateBid(state, participantId, amount);
  if (message) throw new Error(message);

  state.auction.currentBid = Number(amount);
  state.auction.highestBidderId = participantId;
  state.auction.bidLog.unshift({
    id: id('bid'),
    playerId: state.auction.currentPlayerId,
    participantId,
    bidAmount: Number(amount),
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

  return rows.sort((a, b) => b.Pts - a.Pts || b.GD - a.GD || b.GF - a.GF || a.GA - b.GA);
}

function generateKnockout(state) {
  const a = tableFor(state, 'A');
  const b = tableFor(state, 'B');
  if (a.length < 4 || b.length < 4) throw new Error('Both groups need four ranked teams.');

  const existingGroups = state.fixtures.filter((fixture) => fixture.stage === 'group');
  const bracket = [
    ['qf1', 'Quarter-final', a[0].participantId, b[3].participantId],
    ['qf2', 'Quarter-final', b[0].participantId, a[3].participantId],
    ['qf3', 'Quarter-final', a[1].participantId, b[2].participantId],
    ['qf4', 'Quarter-final', b[1].participantId, a[2].participantId],
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
    byId.get('sf1').playerBId = fixtureWinner(byId.get('qf3'));
  }
  if (byId.has('sf2')) {
    byId.get('sf2').playerAId = fixtureWinner(byId.get('qf2'));
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
  const participant = participantById(state, data.id);
  if (!participant) throw new Error('Participant not found.');
  participant.name = data.name ?? participant.name;
  participant.teamName = data.teamName ?? participant.teamName;
  participant.group = data.group ?? participant.group;
}

function joinParticipant(state, data) {
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

  participant.name = name;
  participant.teamName = teamName || `${name} FC`;
  participant.group = group;
  participant.joinedAt = new Date().toISOString();
}

function updateSettings(state, data) {
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
    'participant:update': () => updateParticipant(state, data),
    'participant:join': () => joinParticipant(state, data),
    'settings:update': () => updateSettings(state, data),
    'auction:start': () => {
      state.auction.status = 'running';
      state.tournament.status = 'auction';
      if (state.auction.currentPlayerId) setDeadline(state);
    },
    'auction:pause': () => {
      state.auction.status = 'paused';
      state.auction.deadlineAt = null;
    },
    'auction:nominate': () => nominatePlayer(state, data.playerId),
    'auction:randomNominate': () => randomNominate(state),
    'auction:bid': () => placeBid(state, data.participantId, data.amount),
    'auction:sell': () => sellCurrent(state),
    'auction:releasePlayer': () => releasePlayer(state, data),
    'auction:skip': () => skipCurrent(state),
    'auction:undoLastSale': () => undoLastSale(state),
    'fixtures:generate': () => generateFixtures(state),
    'fixtures:generateKnockout': () => generateKnockout(state),
    'fixture:updateResult': () => updateFixtureResult(state, data),
    'tournament:reset': () => Object.assign(state, defaultState()),
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
