// Run from the project root: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computePlan, computeDeliveries, earliestFeasibleDate, pct, STEPS } from '../engine.js';

const data = JSON.parse(readFileSync(new URL('../data/demo-data.json', import.meta.url)));
const FIELDS = ['workingDaysLeft', 'items', 'finished', 'ready', 'hoursToDoThisDelivery', 'missingHoursTotal', 'bottleneck', 'trafficLight', 'nonWorkingDay'];
const PER_STEP = ['hoursNeededCumulative', 'hoursAvailable', 'usage', 'missingHours', 'extraPeople'];

test('baseline matches every precomputed delivery exactly', () => {
  const got = computeDeliveries(data);
  assert.equal(got.length, data.deliveries.length);
  data.deliveries.forEach((want, k) => {
    const row = got[k];
    assert.equal(row.date, want.date);
    for (const f of FIELDS) assert.deepEqual(row[f], want[f], `${want.date} ${f}`);
    for (const f of PER_STEP) for (const s of STEPS) assert.equal(row[f][s], want[f][s], `${want.date} ${f}.${s}`);
  });
});

test('10 Dec headline numbers from the brief', () => {
  const d = computeDeliveries(data).find((x) => x.date === '2025-12-10');
  assert.deepEqual(STEPS.map((s) => pct(d.usage[s])), [218, 80, 162, 201]);
  assert.equal(d.missingHoursTotal, 455);
  assert.equal(d.extraPeopleTotal, 9);
});

test('morning brief points at 8 Dec, assembly', () => {
  const { brief } = computePlan(data);
  assert.equal(brief.status, 'RED');
  assert.equal(brief.focus.date, '2025-12-08');
  assert.equal(brief.bottleneck, 'assembly');
  assert.equal(brief.options.addPeople.people, 1);
});

test('data warnings: 2 non-working dates, 13 PLM issues, 144/175 blocked', () => {
  const { warnings } = computePlan(data);
  assert.deepEqual(warnings.nonWorkingDeliveries.map((w) => w.reason), ['Saturday', 'Immacolata']);
  assert.equal(warnings.plmIssues.length, 13);
  assert.equal(warnings.blockedCountedAsWorkable.withoutMaterials, 144);
  assert.equal(warnings.blockedCountedAsWorkable.withoutAccessories, 175);
});

test('what-if: one more assembler turns 8 Dec from RED', () => {
  const d = computeDeliveries(data, { people: { assembly: 1 } }).find((x) => x.originalDate === '2025-12-08');
  assert.notEqual(d.trafficLight, 'RED');
  assert.equal(d.hoursAvailable.assembly, 240);
});

test('what-if: overtime adds hours per person per day', () => {
  const d = computeDeliveries(data, { overtime: { assembly: 2 } }).find((x) => x.originalDate === '2025-12-08');
  assert.equal(d.hoursAvailable.assembly, 6 * 4 * 10);
});

test('what-if: moving a date re-sorts and changes the cumulative', () => {
  const rows = computeDeliveries(data, { dateShifts: { '2025-12-08': '2025-12-12' } });
  const moved = rows.find((x) => x.originalDate === '2025-12-08');
  assert.equal(moved.date, '2025-12-12');
  assert.equal(moved.moved, true);
  const dec10 = rows.find((x) => x.originalDate === '2025-12-10');
  const base10 = data.deliveries.find((x) => x.date === '2025-12-10');
  assert.ok(dec10.hoursNeededCumulative.assembly < base10.hoursNeededCumulative.assembly);
});

test('earliest feasible date for 8 Dec is a working day that clears RED', () => {
  const r = earliestFeasibleDate(data, {}, '2025-12-08');
  assert.ok(r && r.usage <= 1);
});
