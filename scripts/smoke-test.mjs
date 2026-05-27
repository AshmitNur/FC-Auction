import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const payload = JSON.parse(await readFile('data/fc26-players-81-plus.json', 'utf8'));

assert.equal(payload.meta.minimumOverallRating, 81);
assert.equal(payload.meta.genderFilter, "Men's Football");
assert.equal(payload.meta.count, payload.players.length);
assert.ok(payload.players.length >= 300, 'Expected a complete male 81+ pool, not a sample list.');
assert.ok(payload.players.every((player) => player.overallRating >= 81), 'All auction players must be OVR 81+.');
assert.ok(payload.players.every((player) => player.gender === "Men's Football"), 'Auction pool must be male-only.');
assert.ok(payload.players.some((player) => player.name === 'Mohamed Salah' && player.overallRating === 91));
assert.ok(payload.players.some((player) => player.name === 'Kylian Mbappé' && player.overallRating === 91));

const ids = new Set(payload.players.map((player) => player.id));
assert.equal(ids.size, payload.players.length, 'Player IDs must be unique.');

console.log(`Smoke test passed: ${payload.players.length} male FC 26 players at OVR 81+.`);
