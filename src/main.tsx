import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { io, Socket } from 'socket.io-client';
import {
  BadgeDollarSign,
  Brackets,
  Check,
  CirclePause,
  CirclePlay,
  Database,
  Dices,
  Gavel,
  LayoutDashboard,
  ListChecks,
  MonitorUp,
  RotateCcw,
  Search,
  Shield,
  Shuffle,
  Trophy,
  UserRound,
  Wallet,
  Users,
} from 'lucide-react';
import './styles.css';

type Player = {
  id: string;
  rank: number;
  name: string;
  overallRating: number;
  position: string;
  club: string;
  nation: string;
  league: string;
  gender: string;
  avatarUrl: string;
  shieldUrl: string;
  stats: { pac: number | null; sho: number | null; pas: number | null; dri: number | null; def: number | null; phy: number | null };
  playStyles: { id: string; label: string; type: string }[];
};

type Participant = {
  id: string;
  name: string;
  teamName: string;
  group: 'A' | 'B';
  startingBudget: number;
  remainingBudget: number;
  joinedAt?: string;
};

type Purchase = { id: string; playerId: string; purchasePrice: number; purchasedAt: string };
type UserRole = 'admin' | 'player';
type AppUser = { id: string; name: string; role: UserRole; createdAt?: string; lastSeenAt?: string; updatedAt?: string };
type Fixture = {
  id: string;
  round: string;
  stage: 'group' | 'knockout';
  group: 'A' | 'B' | 'knockout';
  playerAId: string | null;
  playerBId: string | null;
  playerAScore: number | null;
  playerBScore: number | null;
  winnerId: string | null;
  status: 'pending' | 'completed';
  sort: number;
};

type AppState = {
  tournament: { name: string; status: string; format: string; platform: string };
  settings: {
    auctionBudget: number;
    minimumBid: number;
    bidIncrement: number;
    squadSize: number;
    auctionTimer: number;
    lateBidExtension: number;
    thirdPlace: boolean;
  };
  users: AppUser[];
  participants: Participant[];
  squads: Record<string, Purchase[]>;
  auction: {
    status: string;
    currentPlayerId: string | null;
    currentBid: number;
    highestBidderId: string | null;
    timerRemaining: number;
    bidLog: { id: string; playerId: string; participantId: string; bidAmount: number; timestamp: string }[];
    history: { id: string; type: string; playerId: string; participantId?: string; amount?: number; timestamp: string }[];
    unsoldQueue: string[];
  };
  fixtures: Fixture[];
  updatedAt: string;
};

type Payload = {
  state: AppState;
  playersMeta: { source: string; sourceLabel: string; count: number; generatedAt: string; note: string };
  players: Player[];
};

type Standing = {
  participantId: string;
  P: number;
  W: number;
  D: number;
  L: number;
  GF: number;
  GA: number;
  GD: number;
  Pts: number;
};

const serverUrl = import.meta.env.DEV ? `http://${window.location.hostname}:4000` : window.location.origin;
const money = new Intl.NumberFormat('en-US');
const compactMoney = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });

const nav = [
  ['Dashboard', LayoutDashboard],
  ['Player', UserRound],
  ['Setup', Users],
  ['Auction', Gavel],
  ['Players', Database],
  ['Squads', Shield],
  ['Fixtures', ListChecks],
  ['Standings', Trophy],
  ['Bracket', Brackets],
  ['Viewer', MonitorUp],
] as const;

type NavItem = (typeof nav)[number][0];
const playerNav: NavItem[] = ['Player', 'Players', 'Squads', 'Fixtures', 'Standings', 'Bracket', 'Viewer'];

function formatCoins(value: number) {
  return `${compactMoney.format(value)} coins`;
}

function normalizedName(value: string) {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function participantSlot(participant: Participant) {
  return Number(participant.id.match(/\d+$/)?.[0] || 0);
}

function sortParticipantsByGroup(participants: Participant[]) {
  return [...participants].sort((a, b) => a.group.localeCompare(b.group) || participantSlot(a) - participantSlot(b) || a.teamName.localeCompare(b.teamName));
}

function nameFor(participants: Participant[], idValue: string | null | undefined) {
  const participant = participants.find((item) => item.id === idValue);
  return participant ? participant.teamName || participant.name : 'TBD';
}

function calculateStandings(state: AppState, group: 'A' | 'B'): Standing[] {
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

  state.fixtures
    .filter((fixture) => fixture.stage === 'group' && fixture.group === group && fixture.status === 'completed')
    .forEach((fixture) => {
      const a = byId.get(fixture.playerAId || '');
      const b = byId.get(fixture.playerBId || '');
      if (!a || !b || fixture.playerAScore === null || fixture.playerBScore === null) return;
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
    });

  return rows.sort((a, b) => b.Pts - a.Pts || b.GD - a.GD || b.GF - a.GF || a.GA - b.GA);
}

function useTournament(authUser: AppUser | null) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [error, setError] = useState('');

  const fetchState = useCallback(async (silent = false) => {
    try {
      const response = await fetch(`${serverUrl}/api/state`);
      const nextPayload = await response.json();
      if (!response.ok) throw new Error(nextPayload.error || 'Unable to load tournament state.');
      setPayload(nextPayload);
      if (!silent) setError('');
    } catch (requestError) {
      if (!silent) setError(requestError instanceof Error ? requestError.message : 'Unable to load tournament state.');
    }
  }, []);

  useEffect(() => {
    fetchState();

    const nextSocket = io(serverUrl, { timeout: 3000 });
    nextSocket.on('state', setPayload);
    nextSocket.on('action-error', ({ message }) => setError(message));
    setSocket(nextSocket);
    const poll = window.setInterval(() => {
      if (!nextSocket.connected) fetchState(true);
    }, 1500);
    return () => {
      window.clearInterval(poll);
      nextSocket.close();
    };
  }, [fetchState]);

  async function login(name: string, role: UserRole) {
    setError('');
    try {
      const response = await fetch(`${serverUrl}/api/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'user:login', data: { name, role } }),
      });
      const nextPayload = await response.json();
      if (!response.ok) throw new Error(nextPayload.error || 'Sign in failed.');
      setPayload(nextPayload);
      const user = nextPayload.state.users.find((item: AppUser) => item.name.toLowerCase() === name.trim().toLowerCase());
      if (!user) throw new Error('User profile was not created.');
      return user as AppUser;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Sign in failed.');
      return null;
    }
  }

  async function send(event: string, data: unknown = {}) {
    setError('');
    const actionData = {
      ...(typeof data === 'object' && data !== null ? data : {}),
      actor: authUser,
    };
    if (socket?.connected) {
      socket.emit(event, actionData);
      return;
    }

    try {
      const response = await fetch(`${serverUrl}/api/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event, data: actionData }),
      });
      const nextPayload = await response.json();
      if (!response.ok) throw new Error(nextPayload.error || 'Action failed.');
      setPayload(nextPayload);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Action failed.');
    }
  }

  return { payload, send, login, error, setError };
}

function Stat({ label, value, tone = 'default' }: { label: string; value: string; tone?: string }) {
  return (
    <div className={`stat stat-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Pill({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: string }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

function BudgetList({ participants, currentParticipantId }: { participants: Participant[]; currentParticipantId?: string }) {
  const orderedParticipants = sortParticipantsByGroup(participants);
  return (
    <div className="budget-list">
      {orderedParticipants.map((participant) => (
        <div className={`budget-row ${participant.id === currentParticipantId ? 'current' : ''}`} key={participant.id}>
          <div className="budget-team">
            <span>{participant.teamName}</span>
            <small>{participant.name} / Group {participant.group}</small>
          </div>
          <strong>{formatCoins(participant.remainingBudget)}</strong>
        </div>
      ))}
      {!orderedParticipants.length && <p className="empty">No joined players yet.</p>}
    </div>
  );
}

function AuthGate({
  login,
  saveUser,
  error,
}: {
  login: (name: string, role: UserRole) => Promise<AppUser | null>;
  saveUser: (user: AppUser) => void;
  error: string;
}) {
  const [name, setName] = useState('');
  const [role, setRole] = useState<UserRole>('player');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const user = await login(name, role);
    if (!user) return;
    saveUser(user);
    localStorage.setItem('fc26-auth-user', JSON.stringify(user));
  }

  return (
    <main className="auth-shell">
      <form className="auth-card" onSubmit={submit}>
        <div className="boot-mark">FC26</div>
        <div>
          <span className="eyebrow">Auction access</span>
          <h1>Enter your name</h1>
        </div>
        <label>
          <span>Name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Ashmit" autoFocus />
        </label>
        <div className="role-toggle">
          <button type="button" className={role === 'player' ? 'active' : ''} onClick={() => setRole('player')}>Player</button>
          <button type="button" className={role === 'admin' ? 'active' : ''} onClick={() => setRole('admin')}>Admin</button>
        </div>
        <button className="primary" type="submit"><UserRound size={16} /> Continue</button>
        {error && <p className="auth-error">{error}</p>}
      </form>
    </main>
  );
}

function App() {
  const [authUser, setAuthUser] = useState<AppUser | null>(() => {
    try {
      return JSON.parse(localStorage.getItem('fc26-auth-user') || 'null');
    } catch {
      return null;
    }
  });
  const { payload, send, login, error, setError } = useTournament(authUser);
  const [active, setActive] = useState<NavItem>('Dashboard');
  const [playerSession, setPlayerSession] = useState<{ participantId: string; name: string; teamName: string; group: 'A' | 'B'; slot: number } | null>(() => {
    try {
      return JSON.parse(localStorage.getItem('fc26-player-session') || 'null');
    } catch {
      return null;
    }
  });

  const visibleNav = authUser?.role === 'admin' ? nav : nav.filter(([item]) => playerNav.includes(item));

  useEffect(() => {
    if (!authUser) return;
    if (!visibleNav.some(([item]) => item === active)) {
      setActive(authUser.role === 'admin' ? 'Dashboard' : 'Player');
    }
  }, [authUser, active, visibleNav]);

  useEffect(() => {
    if (!payload || !authUser) return;
    const userExists = payload.state.users.some((user) =>
      user.id === authUser.id || normalizedName(user.name) === normalizedName(authUser.name),
    );
    if (userExists) return;

    let cancelled = false;
    login(authUser.name, authUser.role).then((user) => {
      if (!user || cancelled) return;
      setAuthUser(user);
      localStorage.setItem('fc26-auth-user', JSON.stringify(user));
    });

    return () => {
      cancelled = true;
    };
  }, [payload?.state.updatedAt, authUser?.id, authUser?.name, authUser?.role]);

  if (!payload) {
    return (
      <main className="boot">
        <div className="boot-mark">FC26</div>
        <p>{error || 'Loading LAN control room'}</p>
      </main>
    );
  }

  const { state, players, playersMeta } = payload;
  if (!authUser) {
    return <AuthGate login={login} saveUser={setAuthUser} error={error} />;
  }

  const isAdmin = authUser.role === 'admin';
  const soldIds = new Set(Object.values(state.squads).flat().map((purchase) => purchase.playerId));
  const currentPlayer = players.find((player) => player.id === state.auction.currentPlayerId) || null;
  const highestBidder = state.participants.find((participant) => participant.id === state.auction.highestBidderId);
  const completedFixtures = state.fixtures.filter((fixture) => fixture.status === 'completed').length;
  const totalSpent = state.participants.reduce((sum, participant) => sum + (participant.startingBudget - participant.remainingBudget), 0);
  const standings = { A: calculateStandings(state, 'A'), B: calculateStandings(state, 'B') };

  function savePlayerSession(session: { participantId: string; name: string; teamName: string; group: 'A' | 'B'; slot: number } | null) {
    setPlayerSession(session);
    if (session) localStorage.setItem('fc26-player-session', JSON.stringify(session));
    else localStorage.removeItem('fc26-player-session');
  }

  function signOut() {
    setAuthUser(null);
    localStorage.removeItem('fc26-auth-user');
    setActive('Player');
  }

  return (
    <main className="app-shell">
      <aside className="rail">
        <div className="brand-block">
          <span>FC26</span>
          <strong>LAN AUCTION</strong>
        </div>
        <nav>
          {visibleNav.map(([item, Icon]) => (
            <button key={item} className={active === item ? 'active' : ''} onClick={() => setActive(item)} title={item}>
              <Icon size={18} />
              <span>{item}</span>
            </button>
          ))}
        </nav>
        <div className="rail-footer">
          <Pill tone={authUser.role === 'admin' ? 'amber' : 'neutral'}>{authUser.role}</Pill>
          <small>{authUser.name}</small>
          <button onClick={signOut}>Switch user</button>
          <Pill tone={state.auction.status === 'running' ? 'live' : 'neutral'}>{state.auction.status}</Pill>
          <small>{playersMeta.count} official men's 81+ players</small>
        </div>
      </aside>

      <section className="workbench">
        <header className="topbar">
          <div>
          <span className="eyebrow">{state.tournament.format} / Local LAN control</span>
            <h1>{state.tournament.name}</h1>
          </div>
          {isAdmin && <div className="topbar-actions">
            <button onClick={() => send('fixtures:generate')}><Shuffle size={16} /> Generate fixtures</button>
            <button onClick={() => send('auction:randomNominate')}><Dices size={16} /> Random nominate</button>
          </div>}
        </header>

        {error && (
          <div className="toast" onClick={() => setError('')}>
            {error}
          </div>
        )}

        {active === 'Dashboard' && (
          <Dashboard
            state={state}
            players={players}
            soldCount={soldIds.size}
            completedFixtures={completedFixtures}
            totalSpent={totalSpent}
            standings={standings}
            send={send}
          />
        )}
        {active === 'Player' && (
          <PlayerPortal
            state={state}
            players={players}
            currentPlayer={currentPlayer}
            session={playerSession}
            saveSession={savePlayerSession}
            send={send}
            canManage={isAdmin}
            authUser={authUser}
          />
        )}
        {active === 'Setup' && <Setup state={state} send={send} />}
        {active === 'Auction' && (
          <Auction
            state={state}
            players={players}
            currentPlayer={currentPlayer}
            highestBidder={highestBidder}
            soldIds={soldIds}
            send={send}
          />
        )}
        {active === 'Players' && <Players players={players} state={state} soldIds={soldIds} send={send} canManage={isAdmin} />}
        {active === 'Squads' && <Squads players={players} state={state} send={send} canManage={isAdmin} />}
        {active === 'Fixtures' && <Fixtures state={state} send={send} canManage={isAdmin} />}
        {active === 'Standings' && <Standings state={state} standings={standings} />}
        {active === 'Bracket' && <Bracket state={state} send={send} canManage={isAdmin} />}
        {active === 'Viewer' && (
          <Viewer state={state} players={players} currentPlayer={currentPlayer} highestBidder={highestBidder} standings={standings} />
        )}
      </section>
    </main>
  );
}

function Dashboard({
  state,
  players,
  soldCount,
  completedFixtures,
  totalSpent,
  standings,
  send,
}: {
  state: AppState;
  players: Player[];
  soldCount: number;
  completedFixtures: number;
  totalSpent: number;
  standings: { A: Standing[]; B: Standing[] };
  send: (event: string, data?: unknown) => void;
}) {
  return (
    <div className="dashboard-grid">
      <section className="command-panel">
        <div className="section-title">
          <span>01</span>
          <h2>Tournament Desk</h2>
        </div>
        <div className="command-strip">
          <button onClick={() => send('auction:start')}><CirclePlay size={16} /> Start auction</button>
          <button onClick={() => send('auction:pause')}><CirclePause size={16} /> Pause</button>
          <button onClick={() => send('fixtures:generate')}><ListChecks size={16} /> Fixtures</button>
          <button onClick={() => send('fixtures:generateKnockout')}><Brackets size={16} /> Knockout</button>
        </div>
        <div className="meter-row">
          <Stat label="Players sold" value={`${soldCount}/${players.length}`} tone="green" />
          <Stat label="Coins spent" value={formatCoins(totalSpent)} tone="amber" />
          <Stat label="Fixtures done" value={`${completedFixtures}/${state.fixtures.length || 30}`} tone="blue" />
        </div>
      </section>
      <section className="live-panel">
        <div className="section-title">
          <span>02</span>
          <h2>Auction Log</h2>
        </div>
        <div className="ledger">
          {state.auction.history.slice(0, 9).map((entry) => (
            <div key={entry.id}>
              <span>{entry.type.toUpperCase()}</span>
              <strong>{players.find((player) => player.id === entry.playerId)?.name || 'Unknown'}</strong>
              <em>{entry.amount ? formatCoins(entry.amount) : 'unsold'}</em>
            </div>
          ))}
          {!state.auction.history.length && <p className="empty">No auction actions yet.</p>}
        </div>
      </section>
      <section className="table-panel">
        <GroupMini title="Group A" rows={standings.A} state={state} />
        <GroupMini title="Group B" rows={standings.B} state={state} />
      </section>
      <section className="budget-panel">
        <div className="section-title">
          <span>03</span>
          <h2>Remaining Budgets</h2>
        </div>
        <BudgetList participants={state.participants} />
      </section>
    </div>
  );
}

function GroupMini({ title, rows, state }: { title: string; rows: Standing[]; state: AppState }) {
  return (
    <div className="mini-table">
      <h3>{title}</h3>
      {rows.slice(0, 4).map((row, index) => (
        <div key={row.participantId}>
          <span>{index + 1}</span>
          <strong>{nameFor(state.participants, row.participantId)}</strong>
          <em>{row.Pts} pts</em>
        </div>
      ))}
    </div>
  );
}

function PlayerPortal({
  state,
  players,
  currentPlayer,
  session,
  saveSession,
  send,
  canManage,
  authUser,
}: {
  state: AppState;
  players: Player[];
  currentPlayer: Player | null;
  session: { participantId: string; name: string; teamName: string; group: 'A' | 'B'; slot: number } | null;
  saveSession: (session: { participantId: string; name: string; teamName: string; group: 'A' | 'B'; slot: number } | null) => void;
  send: (event: string, data?: unknown) => void;
  canManage: boolean;
  authUser: AppUser;
}) {
  const participant = session ? state.participants.find((item) => item.id === session.participantId) : null;
  const [name, setName] = useState(session?.name || authUser.name);
  const [teamName, setTeamName] = useState(session?.teamName || '');
  const [group, setGroup] = useState<'A' | 'B'>(session?.group || 'A');
  const [slot, setSlot] = useState(session?.slot || 1);
  const nextBid = state.auction.currentBid ? state.auction.currentBid + state.settings.bidIncrement : state.settings.minimumBid;
  const [amount, setAmount] = useState(nextBid);

  useEffect(() => setAmount(nextBid), [nextBid]);

  const squad = participant ? state.squads[participant.id] || [] : [];
  const byId = new Map(players.map((player) => [player.id, player]));
  const highestBidder = state.participants.find((item) => item.id === state.auction.highestBidderId);
  const canBid = Boolean(participant && currentPlayer);

  function join() {
    const participantId = `participant_${group === 'A' ? slot : slot + 6}`;
    const cleanName = name.trim();
    const cleanTeamName = teamName.trim() || `${cleanName} FC`;
    send('participant:join', { name: cleanName, teamName: cleanTeamName, group, slot });
    saveSession({ participantId, name: cleanName, teamName: cleanTeamName, group, slot });
  }

  if (!participant) {
    return (
      <section className="player-join panel">
        <div className="section-title"><span>Player Login</span><h2>Join The Auction</h2></div>
        <div className="join-grid">
          <label>
            <span>Your name</span>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Wasif" />
          </label>
          <label>
            <span>Team name</span>
            <input value={teamName} onChange={(event) => setTeamName(event.target.value)} placeholder="Wasif FC" />
          </label>
          <label>
            <span>Group</span>
            <select value={group} onChange={(event) => setGroup(event.target.value as 'A' | 'B')}>
              <option value="A">Group A</option>
              <option value="B">Group B</option>
            </select>
          </label>
          <label>
            <span>Group number</span>
            <select value={slot} onChange={(event) => setSlot(Number(event.target.value))}>
              {[1, 2, 3, 4, 5, 6].map((item) => <option key={item} value={item}>Slot {item}</option>)}
            </select>
          </label>
        </div>
        <button className="primary join-button" onClick={join}><UserRound size={16} /> Join as bidder</button>
      </section>
    );
  }

  return (
    <div className="player-portal">
      <section className="player-bid-stage">
        <div className="player-identity">
          <div>
            <span>Signed in as</span>
            <h2>{participant.teamName}</h2>
            <p>{participant.name} / Group {participant.group} / Slot {session?.slot}</p>
          </div>
          <button onClick={() => saveSession(null)}>Change player</button>
        </div>

        {currentPlayer ? <PlayerFeature player={currentPlayer} /> : (
          <div className="empty-stage">
            <Gavel size={42} />
            <h2>Waiting for admin nomination</h2>
          </div>
        )}

        <div className="bid-console">
          <Stat label="Your budget" value={formatCoins(participant.remainingBudget)} tone="green" />
          <Stat label="Highest bidder" value={highestBidder?.teamName || 'None'} />
          <Stat label="Next valid" value={formatCoins(nextBid)} tone="amber" />
        </div>

        <div className="player-bid-controls">
          <input value={amount} onChange={(event) => setAmount(Number(event.target.value))} type="number" step={state.settings.bidIncrement} />
          <button disabled={!canBid} onClick={() => setAmount(nextBid)}>Next bid</button>
          <button disabled={!canBid} onClick={() => setAmount(nextBid + state.settings.bidIncrement)}>+10M</button>
          <button className="primary" disabled={!canBid} onClick={() => send('auction:bid', { participantId: participant.id, amount })}>
            <Wallet size={16} /> Place bid
          </button>
        </div>
      </section>

      <section className="panel budget-overview">
        <div className="section-title"><span>All Players</span><h2>Remaining Currency</h2></div>
        <BudgetList participants={state.participants} currentParticipantId={participant.id} />
      </section>

      <section className="panel">
        <div className="section-title"><span>My Squad</span><h2>{squad.length}/{state.settings.squadSize}</h2></div>
        <div className="squad-list">
          {squad.map((purchase) => {
            const player = byId.get(purchase.playerId);
            return player ? (
              <div key={purchase.id}>
                <strong>{player.name}</strong>
                <span>{player.position} / {player.club}</span>
                <em>{formatCoins(purchase.purchasePrice)}</em>
                {canManage && <button
                  className="release-button"
                  onClick={() => send('auction:releasePlayer', { participantId: participant.id, purchaseId: purchase.id })}
                  title={`Release ${player.name}`}
                >
                  <RotateCcw size={14} /> Release
                </button>}
              </div>
            ) : null;
          })}
          {!squad.length && <p className="empty">Your bought players will appear here after the admin sells a player to you.</p>}
        </div>
      </section>

      <section className="panel">
        <div className="section-title"><span>Live Log</span><h2>Recent Bids</h2></div>
        <div className="ledger compact">
          {state.auction.bidLog.slice(0, 12).map((bid) => (
            <div key={bid.id}>
              <span>{nameFor(state.participants, bid.participantId)}</span>
              <strong>{formatCoins(bid.bidAmount)}</strong>
            </div>
          ))}
          {!state.auction.bidLog.length && <p className="empty">No bids yet.</p>}
        </div>
      </section>
    </div>
  );
}

function Setup({ state, send }: { state: AppState; send: (event: string, data?: unknown) => void }) {
  return (
    <div className="split-layout">
      <section className="panel">
        <div className="section-title"><span>Rules</span><h2>Auction Settings</h2></div>
        <div className="form-grid">
          <NumberInput label="Budget" value={state.settings.auctionBudget} onCommit={(value) => send('settings:update', { auctionBudget: value })} />
          <NumberInput label="Minimum bid" value={state.settings.minimumBid} onCommit={(value) => send('settings:update', { minimumBid: value })} />
          <NumberInput label="Increment" value={state.settings.bidIncrement} onCommit={(value) => send('settings:update', { bidIncrement: value })} />
          <NumberInput label="Squad size" value={state.settings.squadSize} onCommit={(value) => send('settings:update', { squadSize: value })} />
          <NumberInput label="Timer seconds" value={state.settings.auctionTimer} onCommit={(value) => send('settings:update', { auctionTimer: value })} />
          <label className="checkline">
            <input type="checkbox" checked={state.settings.thirdPlace} onChange={(event) => send('settings:update', { thirdPlace: event.currentTarget.checked })} />
            Third-place match
          </label>
        </div>
      </section>
      <section className="panel">
        <div className="section-title"><span>Owners</span><h2>Participants</h2></div>
        <div className="participant-list">
          {state.participants.map((participant) => (
            <ParticipantEditor key={participant.id} participant={participant} send={send} />
          ))}
        </div>
      </section>
      <section className="panel access-panel">
        <div className="section-title"><span>Access</span><h2>Users</h2></div>
        <div className="participant-list">
          {(state.users || []).map((user) => (
            <div className="user-editor" key={user.id}>
              <strong>{user.name}</strong>
              <select value={user.role} onChange={(event) => send('user:update', { userId: user.id, role: event.target.value })}>
                <option value="player">Player</option>
                <option value="admin">Admin</option>
              </select>
              <button className="release-button" onClick={() => send('user:delete', { userId: user.id })}>Delete</button>
            </div>
          ))}
          {!state.users?.length && <p className="empty">No users yet.</p>}
        </div>
      </section>
    </div>
  );
}

function NumberInput({ label, value, onCommit }: { label: string; value: number; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  function commit() {
    const nextValue = Number(draft);
    if (Number.isFinite(nextValue)) onCommit(nextValue);
  }
  return (
    <label>
      <span>{label}</span>
      <input
        type="number"
        inputMode="numeric"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
        }}
      />
    </label>
  );
}

function ParticipantEditor({ participant, send }: { participant: Participant; send: (event: string, data?: unknown) => void }) {
  const [draft, setDraft] = useState(participant);
  const isDirty = draft.name !== participant.name || draft.teamName !== participant.teamName || draft.group !== participant.group;

  useEffect(() => {
    if (!isDirty) setDraft(participant);
  }, [participant.id, participant.name, participant.teamName, participant.group, participant.remainingBudget, isDirty]);

  function commit(nextDraft = draft) {
    const hasChanges = nextDraft.name !== participant.name || nextDraft.teamName !== participant.teamName || nextDraft.group !== participant.group;
    if (!hasChanges) return;
    send('participant:update', nextDraft);
  }
  return (
    <div className="participant-editor">
      <input
        value={draft.name}
        onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
        onBlur={() => commit()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
        }}
      />
      <input
        value={draft.teamName}
        onChange={(event) => setDraft((current) => ({ ...current, teamName: event.target.value }))}
        onBlur={() => commit()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
        }}
      />
      <select value={draft.group} onChange={(event) => {
        const next = { ...draft, group: event.target.value as 'A' | 'B' };
        setDraft(next);
        commit(next);
      }}>
        <option value="A">A</option>
        <option value="B">B</option>
      </select>
      <strong>{formatCoins(participant.remainingBudget)}</strong>
      <button type="button" disabled={!isDirty} onMouseDown={(event) => event.preventDefault()} onClick={() => commit()}>Save</button>
    </div>
  );
}

function Auction({
  state,
  players,
  currentPlayer,
  highestBidder,
  soldIds,
  send,
}: {
  state: AppState;
  players: Player[];
  currentPlayer: Player | null;
  highestBidder?: Participant;
  soldIds: Set<string>;
  send: (event: string, data?: unknown) => void;
}) {
  const [bidder, setBidder] = useState(state.participants[0]?.id || '');
  const [amount, setAmount] = useState(state.settings.minimumBid);
  const nextBid = state.auction.currentBid ? state.auction.currentBid + state.settings.bidIncrement : state.settings.minimumBid;

  useEffect(() => setAmount(nextBid), [nextBid]);

  return (
    <div className="auction-grid">
      <section className="auction-stage">
        <div className="auction-timer">
          <span>{state.auction.status}</span>
          <strong>{state.auction.timerRemaining}s</strong>
        </div>
        {currentPlayer ? (
          <PlayerFeature player={currentPlayer} />
        ) : (
          <div className="empty-stage">
            <Gavel size={42} />
            <h2>No player nominated</h2>
            <button onClick={() => send('auction:randomNominate')}><Dices size={16} /> Random nominate</button>
          </div>
        )}
        <div className="bid-console">
          <Stat label="Highest bid" value={formatCoins(state.auction.currentBid)} tone="green" />
          <Stat label="Highest bidder" value={highestBidder?.teamName || 'None'} />
          <Stat label="Next valid" value={formatCoins(nextBid)} tone="amber" />
        </div>
        <div className="command-strip">
          <button onClick={() => send('auction:start')}><CirclePlay size={16} /> Run</button>
          <button onClick={() => send('auction:pause')}><CirclePause size={16} /> Pause</button>
          <button onClick={() => send('auction:sell')}><Check size={16} /> Sell now</button>
          <button onClick={() => send('auction:skip')}><RotateCcw size={16} /> Unsold</button>
          <button onClick={() => send('auction:undoLastSale')}><RotateCcw size={16} /> Undo sale</button>
        </div>
      </section>
      <section className="panel bid-panel">
        <div className="section-title"><span>Bid</span><h2>Place Legal Bid</h2></div>
        <select value={bidder} onChange={(event) => setBidder(event.target.value)}>
          {state.participants.map((participant) => (
            <option value={participant.id} key={participant.id}>{participant.teamName} / {formatCoins(participant.remainingBudget)}</option>
          ))}
        </select>
        <input value={amount} onChange={(event) => setAmount(Number(event.target.value))} type="number" step={state.settings.bidIncrement} />
        <button className="primary" onClick={() => send('auction:bid', { participantId: bidder, amount })}>
          <BadgeDollarSign size={16} /> Bid {formatCoins(amount)}
        </button>
        <div className="ledger compact">
          {state.auction.bidLog.slice(0, 10).map((bid) => (
            <div key={bid.id}>
              <span>{nameFor(state.participants, bid.participantId)}</span>
              <strong>{formatCoins(bid.bidAmount)}</strong>
            </div>
          ))}
        </div>
      </section>
      <section className="panel nomination-panel">
        <div className="section-title"><span>Pool</span><h2>Top Available</h2></div>
        {players.filter((player) => !soldIds.has(player.id)).slice(0, 12).map((player) => (
          <button className="player-row" key={player.id} onClick={() => send('auction:nominate', { playerId: player.id })}>
            <strong>{player.name}</strong>
            <span>{player.position} / {player.club}</span>
            <em>{player.overallRating}</em>
          </button>
        ))}
      </section>
    </div>
  );
}

function PlayerFeature({ player }: { player: Player }) {
  return (
    <div className="player-feature">
      <img src={player.avatarUrl} alt="" />
      <div>
        <span className="rank">#{player.rank}</span>
        <h2>{player.name}</h2>
        <p>{player.position} / {player.club} / {player.nation}</p>
        <div className="rating-mark">{player.overallRating}</div>
        <div className="attribute-grid">
          {Object.entries(player.stats).map(([key, value]) => <span key={key}>{key.toUpperCase()} <strong>{value}</strong></span>)}
        </div>
      </div>
    </div>
  );
}

function Players({
  players,
  state,
  soldIds,
  send,
  canManage,
}: {
  players: Player[];
  state: AppState;
  soldIds: Set<string>;
  send: (event: string, data?: unknown) => void;
  canManage: boolean;
}) {
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState('All');
  const positions = useMemo(() => ['All', ...Array.from(new Set(players.map((player) => player.position))).sort()], [players]);
  const filtered = players.filter((player) => {
    const matchesQuery = `${player.name} ${player.club} ${player.nation}`.toLowerCase().includes(query.toLowerCase());
    const matchesPosition = position === 'All' || player.position === position;
    return matchesQuery && matchesPosition;
  });
  return (
    <section className="panel">
      <div className="toolbar">
        <label className="searchbox"><Search size={16} /><input placeholder="Search player, club, nation" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <select value={position} onChange={(event) => setPosition(event.target.value)}>{positions.map((item) => <option key={item}>{item}</option>)}</select>
        <Pill>{filtered.length} visible</Pill>
      </div>
      <div className="player-table">
        {filtered.map((player) => {
          const rowClassName = `database-row ${soldIds.has(player.id) ? 'sold' : ''} ${canManage ? '' : 'readonly'}`;
          const rowContents = (
            <>
              <img src={player.avatarUrl} alt="" />
              <strong>{player.name}</strong>
              <span>{player.position}</span>
              <span>{player.club}</span>
              <span>{player.nation}</span>
              <em>{player.overallRating}</em>
              <small>{soldIds.has(player.id) ? 'Sold' : 'Available'}</small>
            </>
          );

          return canManage ? (
            <button key={player.id} className={rowClassName} onClick={() => send('auction:nominate', { playerId: player.id })}>
              {rowContents}
            </button>
          ) : (
            <div key={player.id} className={rowClassName}>
              {rowContents}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Squads({ players, state, send, canManage }: { players: Player[]; state: AppState; send: (event: string, data?: unknown) => void; canManage: boolean }) {
  const byId = new Map(players.map((player) => [player.id, player]));
  return (
    <div className="squad-grid">
      {state.participants.map((participant) => {
        const squad = state.squads[participant.id] || [];
        const top = squad.map((purchase) => byId.get(purchase.playerId)).filter(Boolean) as Player[];
        const highest = top.sort((a, b) => b.overallRating - a.overallRating)[0];
        return (
          <section className="squad-card" key={participant.id}>
            <header>
              <span>Group {participant.group}</span>
              <h2>{participant.teamName}</h2>
              <em>{squad.length}/{state.settings.squadSize}</em>
            </header>
            <div className="squad-stats">
              <Stat label="Remaining" value={formatCoins(participant.remainingBudget)} />
              <Stat label="Best OVR" value={highest ? `${highest.name} ${highest.overallRating}` : 'None'} />
            </div>
            <div className="squad-list">
              {squad.map((purchase) => {
                const player = byId.get(purchase.playerId);
                return player ? (
                  <div key={purchase.id}>
                    <strong>{player.name}</strong>
                    <span>{player.position} / {player.club}</span>
                    <em>{formatCoins(purchase.purchasePrice)}</em>
                    {canManage && <button
                      className="release-button"
                      onClick={() => send('auction:releasePlayer', { participantId: participant.id, purchaseId: purchase.id })}
                      title={`Release ${player.name}`}
                    >
                      <RotateCcw size={14} /> Release
                    </button>}
                  </div>
                ) : null;
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function Fixtures({ state, send, canManage }: { state: AppState; send: (event: string, data?: unknown) => void; canManage: boolean }) {
  return (
    <section className="panel">
      {canManage && <div className="toolbar">
        <button onClick={() => send('fixtures:generate')}><ListChecks size={16} /> Regenerate group fixtures</button>
        <button onClick={() => send('fixtures:generateKnockout')}><Brackets size={16} /> Build knockout from table</button>
      </div>}
      <div className="fixture-list">
        {[...state.fixtures].sort((a, b) => a.sort - b.sort).map((fixture) => (
          <FixtureEditor key={fixture.id} fixture={fixture} state={state} send={send} canManage={canManage} />
        ))}
        {!state.fixtures.length && <p className="empty">Generate fixtures after assigning six participants to each group.</p>}
      </div>
    </section>
  );
}

function FixtureEditor({ fixture, state, send, canManage }: { fixture: Fixture; state: AppState; send: (event: string, data?: unknown) => void; canManage: boolean }) {
  const [a, setA] = useState(fixture.playerAScore ?? 0);
  const [b, setB] = useState(fixture.playerBScore ?? 0);
  const [winner, setWinner] = useState(fixture.winnerId || fixture.playerAId || '');
  useEffect(() => {
    setA(fixture.playerAScore ?? 0);
    setB(fixture.playerBScore ?? 0);
    setWinner(fixture.winnerId || fixture.playerAId || '');
  }, [fixture]);
  const needsWinner = fixture.stage === 'knockout' && a === b;
  if (!canManage) {
    return (
      <div className={`fixture-row ${fixture.status}`}>
        <span>{fixture.round}</span>
        <strong>{nameFor(state.participants, fixture.playerAId)} vs {nameFor(state.participants, fixture.playerBId)}</strong>
        <em>{fixture.status === 'completed' ? `${fixture.playerAScore}-${fixture.playerBScore}` : 'Pending'}</em>
      </div>
    );
  }
  return (
    <div className={`fixture-row ${fixture.status}`}>
      <span>{fixture.round}</span>
      <strong>{nameFor(state.participants, fixture.playerAId)} vs {nameFor(state.participants, fixture.playerBId)}</strong>
      <input type="number" min="0" value={a} onChange={(event) => setA(Number(event.target.value))} />
      <input type="number" min="0" value={b} onChange={(event) => setB(Number(event.target.value))} />
      {needsWinner && (
        <select value={winner} onChange={(event) => setWinner(event.target.value)}>
          {[fixture.playerAId, fixture.playerBId].filter(Boolean).map((idValue) => <option key={idValue || ''} value={idValue || ''}>{nameFor(state.participants, idValue)}</option>)}
        </select>
      )}
      <button onClick={() => send('fixture:updateResult', { fixtureId: fixture.id, playerAScore: a, playerBScore: b, winnerId: needsWinner ? winner : null })}>Save</button>
    </div>
  );
}

function Standings({ state, standings }: { state: AppState; standings: { A: Standing[]; B: Standing[] } }) {
  return (
    <div className="split-layout">
      <StandingTable group="A" rows={standings.A} state={state} />
      <StandingTable group="B" rows={standings.B} state={state} />
    </div>
  );
}

function StandingTable({ group, rows, state }: { group: 'A' | 'B'; rows: Standing[]; state: AppState }) {
  return (
    <section className="panel">
      <div className="section-title"><span>Group {group}</span><h2>Table</h2></div>
      <table>
        <thead><tr><th>#</th><th>Team</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GF</th><th>GA</th><th>GD</th><th>Pts</th></tr></thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row.participantId} className={index < 4 ? 'qualified' : ''}>
              <td>{index + 1}</td><td>{nameFor(state.participants, row.participantId)}</td><td>{row.P}</td><td>{row.W}</td><td>{row.D}</td><td>{row.L}</td><td>{row.GF}</td><td>{row.GA}</td><td>{row.GD}</td><td>{row.Pts}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function bracketPathLabel(fixtureId: string) {
  const labels: Record<string, string> = {
    qf1: 'A1 vs B4',
    qf2: 'B2 vs A3',
    qf3: 'B1 vs A4',
    qf4: 'A2 vs B3',
    sf1: 'Winner QF1 vs Winner QF2',
    sf2: 'Winner QF3 vs Winner QF4',
    final: 'Winner SF1 vs Winner SF2',
    third: 'Loser SF1 vs Loser SF2',
  };
  return labels[fixtureId] || fixtureId.toUpperCase();
}

function Bracket({ state, send, canManage }: { state: AppState; send: (event: string, data?: unknown) => void; canManage: boolean }) {
  const rounds = ['Quarter-final', 'Semi-final', 'Final', 'Third-place'];
  const fixturesByRound = rounds.map((round) => state.fixtures.filter((fixture) => fixture.stage === 'knockout' && fixture.round === round));
  return (
    <section className="panel bracket-panel">
      {canManage && <div className="toolbar">
        <button onClick={() => send('fixtures:generateKnockout')}><Brackets size={16} /> Build bracket</button>
      </div>}
      <div className="bracket">
        {fixturesByRound.map((fixtures, index) => fixtures.length ? (
          <div className="bracket-round" key={rounds[index]}>
            <h3>{rounds[index]}</h3>
            {fixtures.map((fixture) => (
              <div className="bracket-match" key={fixture.id}>
                <small>{bracketPathLabel(fixture.id)}</small>
                <span className={fixture.winnerId === fixture.playerAId ? 'winner' : ''}>{nameFor(state.participants, fixture.playerAId)}</span>
                <span className={fixture.winnerId === fixture.playerBId ? 'winner' : ''}>{nameFor(state.participants, fixture.playerBId)}</span>
                <em>{fixture.status === 'completed' ? `${fixture.playerAScore}-${fixture.playerBScore}` : 'pending'}</em>
              </div>
            ))}
          </div>
        ) : null)}
      </div>
    </section>
  );
}

function Viewer({ state, players, currentPlayer, highestBidder, standings }: { state: AppState; players: Player[]; currentPlayer: Player | null; highestBidder?: Participant; standings: { A: Standing[]; B: Standing[] } }) {
  const champion = state.fixtures.find((fixture) => fixture.id === 'final')?.winnerId;
  return (
    <section className="viewer-screen">
      <div className="viewer-main">
        <span>LIVE AUCTION DISPLAY</span>
        <h2>{currentPlayer?.name || 'Waiting for nomination'}</h2>
        <p>{currentPlayer ? `${currentPlayer.position} / ${currentPlayer.club} / OVR ${currentPlayer.overallRating}` : 'Admin control room is ready.'}</p>
        <strong>{state.auction.timerRemaining}s</strong>
      </div>
      <div className="viewer-side">
        <Stat label="Highest bid" value={formatCoins(state.auction.currentBid)} tone="green" />
        <Stat label="Bidder" value={highestBidder?.teamName || 'None'} />
        <Stat label="Sold" value={`${Object.values(state.squads).flat().length}/${players.length}`} />
        <Stat label="Champion" value={nameFor(state.participants, champion)} tone="amber" />
      </div>
      <div className="viewer-tables">
        <GroupMini title="Group A" rows={standings.A} state={state} />
        <GroupMini title="Group B" rows={standings.B} state={state} />
      </div>
    </section>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
