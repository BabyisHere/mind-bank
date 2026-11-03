import assert from 'node:assert/strict';
import { tagsOf, streak, weekDays, matches, peaks, takeRemote, shiftDay, fmtDuration } from './logic.js';

assert.deepEqual(tagsOf('slept badly #Work and #work, #family-time. not#this? yes #this'), ['work', 'family-time', 'this']);

const at = (y, m, d, h = 9) => ({ data: { created_at: new Date(y, m - 1, d, h).toISOString() } });
const now = new Date(2026, 10, 3, 20); // Tue 3 Nov 2026
assert.equal(streak([at(2026, 11, 3), at(2026, 11, 2), at(2026, 11, 1), at(2026, 10, 30)], now), 3);
assert.equal(streak([at(2026, 11, 2), at(2026, 11, 1)], now), 2, 'today empty keeps streak');
assert.equal(streak([at(2026, 11, 1)], now), 0);
assert.equal(shiftDay('2026-03-01', -1), '2026-02-28');

assert.deepEqual(weekDays(now), ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']);
assert.equal(weekDays(new Date(2026, 10, 8))[0], '2026-11-02', 'Sunday belongs to the week that started Monday');

const e = { data: { text: 'call mum', transcript: 'feeling stuck', mood: 'low', tags: ['family'] } };
assert.ok(matches(e, '#family low'));
assert.ok(matches(e, 'STUCK'));
assert.ok(!matches(e, '#fam'));
assert.ok(matches({ data: { text: 'buy milk' } }, ''));

assert.deepEqual(peaks([0, 1, 0, 1], 2), [1, 1]);
assert.equal(peaks([], 5).length, 5);
assert.equal(peaks([0.1, 0.2], 4).length, 4);

assert.ok(takeRemote(undefined, { updated_at: '2026-01-01T00:00:00Z' }));
assert.ok(!takeRemote({ updated_at: '2026-01-02T00:00:00.000Z' }, { updated_at: '2026-01-01T00:00:00+00:00' }));
assert.ok(takeRemote({ updated_at: '2026-01-01T00:00:00.000Z' }, { updated_at: '2026-01-01T00:00:00+00:00' }));

assert.equal(fmtDuration(65), '1:05');
assert.equal(fmtDuration(3725), '1h 2m');
console.log('logic ok');
