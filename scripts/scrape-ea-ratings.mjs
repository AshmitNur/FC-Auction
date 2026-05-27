import { mkdir, writeFile } from 'node:fs/promises';

const BASE_URL = 'https://www.ea.com/games/ea-sports-fc/ratings';
const MIN_OVR = 81;
const PAGE_SIZE = 100;
const GENDER_FILTER = "Men's Football";

async function fetchPage(page) {
  const response = await fetch(`${BASE_URL}?page=${page}`, {
    headers: { 'user-agent': 'Mozilla/5.0 FC26 LAN Tournament Builder' },
  });

  if (!response.ok) {
    throw new Error(`EA ratings request failed for page ${page}: ${response.status}`);
  }

  const html = await response.text();
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) {
    throw new Error(`Could not find __NEXT_DATA__ payload on page ${page}`);
  }

  const payload = JSON.parse(match[1]);
  return payload.props.pageProps.ratingDetails.items;
}

function nameFor(item) {
  return item.commonName || [item.firstName, item.lastName].filter(Boolean).join(' ');
}

function stat(item, key) {
  return item.stats?.[key]?.value ?? null;
}

function normalize(item) {
  return {
    id: String(item.id),
    fc26PlayerId: String(item.id),
    rank: item.rank,
    name: nameFor(item),
    firstName: item.firstName || '',
    lastName: item.lastName || '',
    overallRating: item.overallRating,
    position: item.position?.shortLabel || '',
    positionLabel: item.position?.label || '',
    positionType: item.position?.positionType?.name || '',
    alternatePositions: (item.alternatePositions || []).map((position) => position.shortLabel),
    club: item.team?.label || '',
    clubId: item.team?.id ?? null,
    clubImageUrl: item.team?.imageUrl || '',
    nation: item.nationality?.label || '',
    nationId: item.nationality?.id ?? null,
    nationImageUrl: item.nationality?.imageUrl || '',
    league: item.leagueName || '',
    gender: item.gender?.label || '',
    avatarUrl: item.avatarUrl || '',
    shieldUrl: item.shieldUrl || '',
    height: item.height ?? null,
    weight: item.weight ?? null,
    skillMoves: item.skillMoves ?? null,
    weakFootAbility: item.weakFootAbility ?? null,
    preferredFoot: item.preferredFoot === 1 ? 'Left' : item.preferredFoot === 2 ? 'Right' : '',
    stats: {
      pac: stat(item, 'pac'),
      sho: stat(item, 'sho'),
      pas: stat(item, 'pas'),
      dri: stat(item, 'dri'),
      def: stat(item, 'def'),
      phy: stat(item, 'phy'),
    },
    playStyles: (item.playerAbilities || []).map((ability) => ({
      id: ability.id,
      label: ability.label,
      type: ability.type?.label || '',
    })),
  };
}

async function main() {
  await mkdir('data', { recursive: true });

  const players = [];
  for (let page = 1; ; page += 1) {
    const items = await fetchPage(page);
    const selected = items
      .filter((item) => item.overallRating >= MIN_OVR && item.gender?.label === GENDER_FILTER)
      .map(normalize);
    players.push(...selected);

    const last = items.at(-1);
    console.log(`page ${page}: ranks ${items[0]?.rank}-${last?.rank}, selected ${selected.length}`);

    if (!last || last.overallRating < MIN_OVR || items.length < PAGE_SIZE) {
      break;
    }
  }

  players.sort((a, b) => b.overallRating - a.overallRating || a.rank - b.rank || a.name.localeCompare(b.name));

  const generatedAt = new Date().toISOString();
  const payload = {
    meta: {
      source: BASE_URL,
      sourceLabel: 'EA SPORTS FC 26 Player Ratings Reveal',
      generatedAt,
      minimumOverallRating: MIN_OVR,
      genderFilter: GENDER_FILTER,
      count: players.length,
      note: `Official EA launch Ultimate Team ratings table filtered to ${GENDER_FILTER} players at OVR 81+. Special items, Icons, Heroes, campaign items, and live form updates are outside this table.`,
    },
    players,
  };

  await writeFile('data/fc26-players-81-plus.json', `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await writeFile(
    'data/source-facts.md',
    [
      '# FC 26 Player Data Source',
      '',
      `Generated: ${generatedAt}`,
      '',
      `Primary source: ${BASE_URL}`,
      '',
      '- EA describes the ratings page as the complete ratings and PlayStyles table for 17,000+ FC 26 players.',
      `- The local seed filters the official launch ratings table to ${GENDER_FILTER} players at OVR 81+ for the auction pool.`,
      '- EA states the ratings table reflects Gold, Silver, and Bronze Ultimate Team 26 player items at launch and excludes Heroes, Icons, Campaign items, later special items, and live-form updates in other modes.',
      `- Local filtered player count: ${players.length}.`,
      '',
    ].join('\n'),
    'utf8',
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
