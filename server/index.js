const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const { createPostgresStore } = require('./postgres-store');
require('dotenv').config();

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const PLAYER_FILE = path.join(DATA_DIR, 'fc26-players-81-plus.json');
const STATE_FILE = path.join(DATA_DIR, 'tournament-state.json');
const PORT = Number(process.env.PORT || 4000);
const SUPABASE_STATE_TABLE = process.env.SUPABASE_STATE_TABLE || 'fc26_app_state';
const SUPABASE_PLAYER_TABLE = process.env.SUPABASE_PLAYER_TABLE || 'fc26_players';
const SUPABASE_STATE_KEY = process.env.SUPABASE_STATE_KEY || 'default';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const DATABASE_URL = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || '';

const playerPayload = JSON.parse(fs.readFileSync(PLAYER_FILE, 'utf8'));
let players = playerPayload.players;
let playerById = new Map(players.map((player) => [player.id, player]));
const postgresStore = DATABASE_URL
  ? createPostgresStore(DATABASE_URL, {
    stateTable: SUPABASE_STATE_TABLE,
    playerTable: SUPABASE_PLAYER_TABLE,
    stateKey: SUPABASE_STATE_KEY,
  })
  : null;
const supabase = SUPABASE_URL && SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })
  : null;
let storageMode = postgresStore ? 'supabase-postgres' : supabase ? 'supabase-rest' : 'local-json';

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
      bidLog: [],
      history: [],
      unsoldQueue: [],
    },
    fixtures: [],
    updatedAt: new Date().toISOString(),
  };
}

async function loadRemotePlayers() {
  if (postgresStore) {
    try {
      const remotePlayers = await postgresStore.loadPlayers();
      return remotePlayers.length ? remotePlayers : null;
    } catch (error) {
      console.warn(`Supabase Postgres player load skipped: ${error.message}`);
      return null;
    }
  }

  if (!supabase) return null;
  const { data, error } = await supabase
    .from(SUPABASE_PLAYER_TABLE)
    .select('player')
    .order('overall_rating', { ascending: false })
    .order('rank', { ascending: true });

  if (error) {
    console.warn(`Supabase player load skipped: ${error.message}`);
    return null;
  }

  if (!data?.length) return null;
  return data.map((row) => row.player).filter(Boolean);
}

async function loadRemoteState() {
  if (postgresStore) {
    try {
      return await postgresStore.loadState();
    } catch (error) {
      console.warn(`Supabase Postgres state load skipped: ${error.message}`);
      return null;
    }
  }

  if (!supabase) return null;
  const { data, error } = await supabase
    .from(SUPABASE_STATE_TABLE)
    .select('state')
    .eq('key', SUPABASE_STATE_KEY)
    .maybeSingle();

  if (error) {
    console.warn(`Supabase state load skipped: ${error.message}`);
    return null;
  }

  return data?.state || null;
}

async function persistRemoteState(nextState) {
  if (postgresStore) {
    await postgresStore.saveState(nextState);
    return;
  }

  if (!supabase) return;
  const { error } = await supabase
    .from(SUPABASE_STATE_TABLE)
    .upsert({
      key: SUPABASE_STATE_KEY,
      state: nextState,
      updated_at: new Date().toISOString(),
    });

  if (error) {
    console.error(`Supabase state save failed: ${error.message}`);
  }
}

async function loadState() {
  const remoteState = await loadRemoteState();
  if (remoteState) {
    normalizeUsers(remoteState);
    normalizeBudgets(remoteState);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, `${JSON.stringify(remoteState, null, 2)}\n`);
    return remoteState;
  }

  if (!fs.existsSync(STATE_FILE)) {
    const nextState = defaultState();
    saveState(nextState);
    return nextState;
  }
  const localState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  normalizeUsers(localState);
  normalizeBudgets(localState);
  return localState;
}

function saveState(nextState = state) {
  normalizeUsers(nextState);
  normalizeBudgets(nextState);
  nextState.updatedAt = new Date().toISOString();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(nextState, null, 2)}\n`);
  persistRemoteState(nextState).catch((error) => {
    console.error(`Supabase state save failed: ${error.message}`);
  });
}

let state;
let timer = null;

function participantById(participantId) {
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

function normalizeUsers(nextState = state) {
  nextState.users = Array.isArray(nextState.users) ? nextState.users : [];
  return nextState;
}

function loginUser(payload) {
  normalizeUsers();
  const name = cleanName(payload.name);
  if (!name) throw new Error('Name is required.');

  const role = payload.role === 'admin' ? 'admin' : 'player';
  const existing = state.users.find((user) => normalizedName(user.name) === normalizedName(name));
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

function actorFrom(payload) {
  normalizeUsers();
  const actor = payload.actor || {};
  const user = state.users.find((item) =>
    (actor.id && item.id === actor.id) ||
    (actor.name && normalizedName(item.name) === normalizedName(actor.name)),
  );
  if (!user) throw new Error('Sign in required.');
  return user;
}

function requireAdmin(payload) {
  const actor = actorFrom(payload);
  if (actor.role !== 'admin') throw new Error('Admin access required.');
  return actor;
}

function requireSignedIn(payload) {
  return actorFrom(payload);
}

function canActForParticipant(actor, participant) {
  return actor.role === 'admin' || normalizedName(actor.name) === normalizedName(participant.name);
}

function updateUser(payload) {
  const actor = requireAdmin(payload);
  const user = state.users.find((item) => item.id === payload.userId);
  if (!user) throw new Error('User not found.');
  user.role = payload.role === 'admin' ? 'admin' : 'player';
  user.name = cleanName(payload.name || user.name);
  user.id = userIdFor(user.name);
  user.updatedAt = new Date().toISOString();
  if (user.id === actor.id) payload.actor.id = user.id;
}

function deleteUser(payload) {
  const actor = requireAdmin(payload);
  if (payload.userId === actor.id) throw new Error('You cannot delete your own active admin user.');
  state.users = state.users.filter((user) => user.id !== payload.userId);
}

function normalizeBudgets(nextState = state) {
  const budget = Number(nextState.settings.auctionBudget);
  nextState.participants = nextState.participants.map((participant) => {
    const purchases = nextState.squads[participant.id] || [];
    const spent = purchases.reduce((sum, purchase) => sum + Number(purchase.purchasePrice || 0), 0);
    const startingBudget = Number.isFinite(participant.startingBudget) ? Number(participant.startingBudget) : budget;
    return {
      ...participant,
      startingBudget,
      remainingBudget: startingBudget - spent,
    };
  });
  return nextState;
}

function soldPlayerIds() {
  return new Set(Object.values(state.squads).flat().map((purchase) => purchase.playerId));
}

function publicState() {
  normalizeUsers();
  normalizeBudgets();
  return {
    state,
    playersMeta: playerPayload.meta,
    players,
  };
}

function emitState() {
  saveState();
  io.emit('state', publicState());
}

function error(socket, message) {
  socket.emit('action-error', { message });
}

function availablePlayers() {
  const sold = soldPlayerIds();
  return players.filter((player) => !sold.has(player.id) && player.id !== state.auction.currentPlayerId);
}

function nominatePlayer(playerId) {
  const player = playerById.get(String(playerId));
  if (!player) throw new Error('Player not found in FC 26 81+ pool.');
  if (soldPlayerIds().has(player.id)) throw new Error('Player has already been sold.');
  if (state.auction.currentPlayerId) throw new Error('Finish or skip the current player before nominating another.');

  state.auction.currentPlayerId = player.id;
  state.auction.currentBid = 0;
  state.auction.highestBidderId = null;
  state.auction.timerRemaining = state.settings.auctionTimer;
  state.auction.status = state.auction.status === 'paused' ? 'paused' : 'running';
  state.tournament.status = 'auction';
}

function randomNominate() {
  const pool = availablePlayers();
  if (!pool.length) throw new Error('No available players left to nominate.');
  nominatePlayer(pool[Math.floor(Math.random() * pool.length)].id);
}

function validateBid(participantId, amount) {
  normalizeBudgets();
  const participant = participantById(participantId);
  const playerId = state.auction.currentPlayerId;
  const numericAmount = Number(amount);

  if (!participant) return 'Participant not found.';
  if (!playerId) return 'No player is currently nominated.';
  if (soldPlayerIds().has(playerId)) return 'This player has already been sold.';
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

function placeBid(participantId, amount) {
  const message = validateBid(participantId, amount);
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
}

function clearCurrentAuction() {
  state.auction.currentPlayerId = null;
  state.auction.currentBid = 0;
  state.auction.highestBidderId = null;
  state.auction.timerRemaining = state.settings.auctionTimer;
}

function sellCurrent() {
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
    clearCurrentAuction();
    return;
  }

  const participant = participantById(state.auction.highestBidderId);
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
  normalizeBudgets();
  clearCurrentAuction();
}

function undoLastSale() {
  const saleIndex = state.auction.history.findIndex((entry) => entry.type === 'sale');
  if (saleIndex === -1) throw new Error('No sale is available to undo.');

  const sale = state.auction.history[saleIndex];
  state.squads[sale.participantId] = (state.squads[sale.participantId] || []).filter(
    (purchase) => purchase.playerId !== sale.playerId,
  );
  state.auction.history.splice(saleIndex, 1);
  normalizeBudgets();
}

function releasePlayer(payload) {
  const participant = participantById(payload.participantId);
  if (!participant) throw new Error('Participant not found.');

  const squad = state.squads[participant.id] || [];
  const purchase = squad.find((item) => item.id === payload.purchaseId || item.playerId === payload.playerId);
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
  normalizeBudgets();
}

function startTimer() {
  if (timer) return;
  timer = setInterval(() => {
    if (state.auction.status !== 'running' || !state.auction.currentPlayerId) return;
    state.auction.timerRemaining -= 1;
    if (state.auction.timerRemaining <= 0) {
      try {
        sellCurrent();
      } catch (auctionError) {
        console.error(auctionError);
      }
    }
    emitState();
  }, 1000);
}

function roundRobin(groupParticipants, group) {
  const list = [...groupParticipants];
  const rounds = [];
  for (let round = 0; round < list.length - 1; round += 1) {
    const pairs = [];
    for (let index = 0; index < list.length / 2; index += 1) {
      const home = list[index];
      const away = list[list.length - 1 - index];
      pairs.push({ home, away });
    }
    rounds.push(pairs);
    list.splice(1, 0, list.pop());
  }

  return rounds.flatMap((pairs, roundIndex) =>
    pairs.map(({ home, away }, matchIndex) => ({
      id: id('fixture'),
      round: `Group ${group} · Round ${roundIndex + 1}`,
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

function generateFixtures() {
  const groupA = state.participants.filter((participant) => participant.group === 'A');
  const groupB = state.participants.filter((participant) => participant.group === 'B');
  if (groupA.length !== 6 || groupB.length !== 6) {
    throw new Error('Default fixture generation requires exactly six participants in each group.');
  }
  state.fixtures = [...roundRobin(groupA, 'A'), ...roundRobin(groupB, 'B')];
  state.tournament.status = 'active';
}

function tableFor(group) {
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

function generateKnockout() {
  const a = tableFor('A');
  const b = tableFor('B');
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

function progressBracket() {
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

function updateFixtureResult(payload) {
  const fixture = state.fixtures.find((item) => item.id === payload.fixtureId);
  if (!fixture) throw new Error('Fixture not found.');
  const aScore = Number(payload.playerAScore);
  const bScore = Number(payload.playerBScore);
  if (!Number.isInteger(aScore) || !Number.isInteger(bScore) || aScore < 0 || bScore < 0) {
    throw new Error('Scores must be non-negative whole numbers.');
  }
  if (fixture.stage === 'knockout' && aScore === bScore && !payload.winnerId) {
    throw new Error('Knockout draws need a selected winner.');
  }

  fixture.playerAScore = aScore;
  fixture.playerBScore = bScore;
  fixture.winnerId = payload.winnerId || (aScore === bScore ? null : aScore > bScore ? fixture.playerAId : fixture.playerBId);
  fixture.status = 'completed';
  progressBracket();
}

function updateParticipant(payload) {
  requireAdmin(payload);
  const participant = participantById(payload.id);
  if (!participant) throw new Error('Participant not found.');
  participant.name = payload.name ?? participant.name;
  participant.teamName = payload.teamName ?? participant.teamName;
  participant.group = payload.group ?? participant.group;
}

function joinParticipant(payload) {
  const actor = requireSignedIn(payload);
  const group = payload.group === 'B' ? 'B' : 'A';
  const slot = Number(payload.slot);
  if (!Number.isInteger(slot) || slot < 1 || slot > 6) {
    throw new Error('Choose a group slot from 1 to 6.');
  }

  const index = group === 'A' ? slot - 1 : slot + 5;
  const participant = state.participants[index];
  if (!participant) throw new Error('Participant slot not found.');

  const name = String(payload.name || '').trim();
  const teamName = String(payload.teamName || '').trim();
  if (!name) throw new Error('Name is required to join the auction.');
  if (actor.role !== 'admin' && normalizedName(name) !== normalizedName(actor.name)) {
    throw new Error('Players can only join with their signed-in name.');
  }

  participant.name = name;
  participant.teamName = teamName || `${name} FC`;
  participant.group = group;
  participant.joinedAt = new Date().toISOString();
}

function updateSettings(payload) {
  requireAdmin(payload);
  state.settings = { ...state.settings, ...payload };
  const budget = Number(state.settings.auctionBudget);
  state.participants = state.participants.map((participant) => {
    const spent = (state.squads[participant.id] || []).reduce((sum, purchase) => sum + purchase.purchasePrice, 0);
    return { ...participant, startingBudget: budget, remainingBudget: budget - spent };
  });
}

function resetTournament() {
  const users = state.users || [];
  state = { ...defaultState(), users };
}

function applyAction(event, payload = {}) {
  const actions = {
    'user:login': () => loginUser(payload),
    'user:update': () => updateUser(payload),
    'user:delete': () => deleteUser(payload),
    'participant:update': () => updateParticipant(payload),
    'participant:join': () => joinParticipant(payload),
    'settings:update': () => updateSettings(payload),
    'auction:start': () => {
      requireAdmin(payload);
      state.auction.status = 'running';
      state.tournament.status = 'auction';
    },
    'auction:pause': () => {
      requireAdmin(payload);
      state.auction.status = 'paused';
    },
    'auction:nominate': () => {
      requireAdmin(payload);
      nominatePlayer(payload.playerId);
    },
    'auction:randomNominate': () => {
      requireAdmin(payload);
      randomNominate();
    },
    'auction:bid': () => {
      const actor = requireSignedIn(payload);
      const participant = participantById(payload.participantId);
      if (!participant) throw new Error('Participant not found.');
      if (!canActForParticipant(actor, participant)) throw new Error('Players can only bid for their own slot.');
      placeBid(payload.participantId, payload.amount);
    },
    'auction:sell': () => {
      requireAdmin(payload);
      sellCurrent();
    },
    'auction:releasePlayer': () => {
      requireAdmin(payload);
      releasePlayer(payload);
    },
    'auction:skip': () => {
      requireAdmin(payload);
      if (state.auction.currentPlayerId && !state.auction.unsoldQueue.includes(state.auction.currentPlayerId)) {
        state.auction.unsoldQueue.push(state.auction.currentPlayerId);
      }
      clearCurrentAuction();
    },
    'auction:undoLastSale': () => {
      requireAdmin(payload);
      undoLastSale();
    },
    'fixtures:generate': () => {
      requireAdmin(payload);
      generateFixtures();
    },
    'fixtures:generateKnockout': () => {
      requireAdmin(payload);
      generateKnockout();
    },
    'fixture:updateResult': () => {
      requireAdmin(payload);
      updateFixtureResult(payload);
    },
    'tournament:reset': () => {
      requireAdmin(payload);
      resetTournament();
    },
  };

  const action = actions[event];
  if (!action) throw new Error(`Unsupported action: ${event}`);
  action();
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

app.use(express.json());

app.get('/api/state', (_request, response) => response.json(publicState()));
app.get('/api/storage', (_request, response) => response.json({
  mode: storageMode,
  supabaseConnected: Boolean(postgresStore || supabase),
  stateTable: postgresStore || supabase ? SUPABASE_STATE_TABLE : null,
  playerTable: postgresStore || supabase ? SUPABASE_PLAYER_TABLE : null,
}));
app.get('/api/standings', (_request, response) => response.json({ A: tableFor('A'), B: tableFor('B') }));
app.post('/api/action', (request, response) => {
  try {
    const { event, data = {} } = request.body || {};
    applyAction(event, data);
    emitState();
    response.json(publicState());
  } catch (actionError) {
    response.status(400).json({ error: actionError.message });
  }
});
app.post('/api/reset', (_request, response) => {
  response.status(400).json({ error: 'Use /api/action with tournament:reset and an admin user.' });
});

const distDir = path.join(ROOT, 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.use((request, response, next) => {
    if (request.method !== 'GET' || request.path.startsWith('/api') || request.path.startsWith('/socket.io')) {
      next();
      return;
    }
    response.sendFile(path.join(distDir, 'index.html'));
  });
}

io.on('connection', (socket) => {
  socket.emit('state', publicState());

  const wrap = (event) => (payload = {}) => {
    try {
      applyAction(event, payload);
      emitState();
    } catch (handlerError) {
      error(socket, handlerError.message);
    }
  };

  socket.on('user:login', wrap('user:login'));
  socket.on('user:update', wrap('user:update'));
  socket.on('user:delete', wrap('user:delete'));
  socket.on('participant:update', wrap('participant:update'));
  socket.on('participant:join', wrap('participant:join'));
  socket.on('settings:update', wrap('settings:update'));
  socket.on('auction:start', wrap('auction:start'));
  socket.on('auction:pause', wrap('auction:pause'));
  socket.on('auction:nominate', wrap('auction:nominate'));
  socket.on('auction:randomNominate', wrap('auction:randomNominate'));
  socket.on('auction:bid', wrap('auction:bid'));
  socket.on('auction:sell', wrap('auction:sell'));
  socket.on('auction:releasePlayer', wrap('auction:releasePlayer'));
  socket.on('auction:skip', wrap('auction:skip'));
  socket.on('auction:undoLastSale', wrap('auction:undoLastSale'));
  socket.on('fixtures:generate', wrap('fixtures:generate'));
  socket.on('fixtures:generateKnockout', wrap('fixtures:generateKnockout'));
  socket.on('fixture:updateResult', wrap('fixture:updateResult'));
  socket.on('tournament:reset', wrap('tournament:reset'));
});

async function bootstrap() {
  if (postgresStore) {
    await postgresStore.init();
    const existingPlayers = await postgresStore.loadPlayers();
    if (!existingPlayers.length) {
      await postgresStore.seedPlayers(players);
      console.log(`Seeded ${players.length} players into Supabase Postgres.`);
    }
  }

  const remotePlayers = await loadRemotePlayers();
  if (remotePlayers?.length) {
    players = remotePlayers;
    playerPayload.players = remotePlayers;
    playerPayload.meta = {
      ...playerPayload.meta,
      count: remotePlayers.length,
      storage: 'supabase',
    };
  }
  playerById = new Map(players.map((player) => [player.id, player]));
  state = await loadState();

  server.listen(PORT, '0.0.0.0', () => {
    startTimer();
    console.log(`FC 26 LAN server listening on http://localhost:${PORT}`);
    console.log(`Storage mode: ${storageMode}`);
  });
}

bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});
