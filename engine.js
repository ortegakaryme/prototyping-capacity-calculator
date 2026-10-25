// Prototyping Capacity Calculator · calculation engine (v2)
// Pure functions: (data, scenario) -> plan. No DOM, runs in the browser and in Node.
// Reproduces the original Excel logic exactly (cumulative usage per station), then layers
// the what-if scenario on top (people, overtime, moved dates).

export const STEPS = ['cad', 'cutting', 'preparation', 'assembly'];

// ---------- dates (ISO strings, UTC, no timezone drift) ----------
const toDate = (iso) => new Date(iso + 'T00:00:00Z');
const toIso = (d) => d.toISOString().slice(0, 10);
const addDays = (iso, n) => { const d = toDate(iso); d.setUTCDate(d.getUTCDate() + n); return toIso(d); };

export function nonWorkingReason(iso, holidays) {
  const h = holidays.find((x) => x.date === iso);
  if (h) return h.name;
  const dow = toDate(iso).getUTCDay();
  if (dow === 6) return 'Saturday';
  if (dow === 0) return 'Sunday';
  return null;
}

// Working days from today to the delivery date, both included (matches the Excel).
export function workingDaysBetween(today, date, holidays) {
  let n = 0;
  for (let d = today; d <= date; d = addDays(d, 1)) if (!nonWorkingReason(d, holidays)) n++;
  return n;
}

export function nextWorkingDay(iso, holidays) {
  let d = addDays(iso, 1);
  while (nonWorkingReason(d, holidays)) d = addDays(d, 1);
  return d;
}

const round = (x, p) => Math.round(x * 10 ** p) / 10 ** p;
// Banker's rounding (ties to even), as in the reference data: 0.15625 -> 0.1562, 162.5% -> 162%.
export function roundHalfEven(x, p = 0) {
  if (!Number.isFinite(x)) return x;
  const m = 10 ** p, v = x * m, f = Math.floor(v), diff = v - f;
  const eps = 1e-9;
  const n = Math.abs(diff - 0.5) < eps ? (f % 2 === 0 ? f : f + 1) : Math.round(v);
  return n / m;
}
// Usage as a whole percentage for display, same rounding as the brief (CAD 218%, Prep 162%).
export const pct = (usage) => roundHalfEven(usage * 100, 0);
const zero = () => Object.fromEntries(STEPS.map((s) => [s, 0]));

// ---------- scenario ----------
// scenario = {
//   people:    { cad: +1, assembly: +2 }        delta of people per station
//   overtime:  { assembly: 1.5 }                extra hours per person per working day
//   dateShifts:{ '2025-12-10': '2025-12-12' }   original delivery date -> new date
// }
export function normalizeScenario(s = {}) {
  return {
    people: { ...zero(), ...(s.people || {}) },
    overtime: { ...zero(), ...(s.overtime || {}) },
    dateShifts: { ...(s.dateShifts || {}) },
  };
}

// Capacity per station for one working day under a scenario.
export function capacity(config, scenario) {
  const sc = normalizeScenario(scenario);
  const out = {};
  for (const s of STEPS) {
    const people = Math.max(0, config.people[s] + sc.people[s]);
    const hoursPerPerson = config.hoursPerPerson + sc.overtime[s];
    out[s] = { people, hoursPerPerson, hoursPerDay: people * hoursPerPerson };
  }
  return out;
}

function trafficLight(maxUsage, { amber, red }) {
  if (maxUsage > red) return 'RED';
  if (maxUsage >= amber) return 'AMBER';
  return 'GREEN';
}

// ---------- core: one plan for a scenario ----------
export function computeDeliveries(data, scenario = {}) {
  const { config, items } = data;
  const sc = normalizeScenario(scenario);
  const cap = capacity(config, sc);
  const today = config.today;
  const effective = (orig) => sc.dateShifts[orig] || orig;

  const originals = [...new Set(items.map((i) => i.delivery))].sort();

  return originals
    .map((orig) => {
      const date = effective(orig);
      const own = items.filter((i) => i.delivery === orig);
      // Cumulative: every item whose (effective) delivery is on or before this one.
      const cumulative = items.filter((i) => effective(i.delivery) <= date);

      const hoursNeededCumulative = zero();
      for (const i of cumulative) for (const s of STEPS) hoursNeededCumulative[s] += i.hoursToDo[s];

      const workingDaysLeft = workingDaysBetween(today, date, config.holidays);
      const hoursAvailable = {}, usage = {}, missingHours = {}, extraPeople = {}, overtimeNeeded = {};
      for (const s of STEPS) {
        const need = round(hoursNeededCumulative[s], 1);
        hoursNeededCumulative[s] = need;
        hoursAvailable[s] = round(workingDaysLeft * cap[s].hoursPerDay, 1);
        usage[s] = hoursAvailable[s] > 0 ? roundHalfEven(need / hoursAvailable[s], 4) : (need > 0 ? Infinity : 0);
        missingHours[s] = round(Math.max(0, need - hoursAvailable[s]), 1);
        const perPersonPeriod = workingDaysLeft * cap[s].hoursPerPerson;
        extraPeople[s] = missingHours[s] > 0 ? (perPersonPeriod > 0 ? Math.ceil(missingHours[s] / perPersonPeriod) : Infinity) : 0;
        // Overtime per person per day that would close the gap with today's team (v2 addition).
        const personDays = workingDaysLeft * cap[s].people;
        overtimeNeeded[s] = missingHours[s] > 0 ? (personDays > 0 ? round(missingHours[s] / personDays, 2) : Infinity) : 0;
      }

      const bottleneck = STEPS.reduce((a, b) => (usage[b] > usage[a] ? b : a));
      const maxUsage = usage[bottleneck];
      const open = own.filter((i) => !i.status.assembled);
      let light;
      if (open.length === 0) light = 'DONE';
      else if (date < today) light = 'LATE';
      else light = trafficLight(maxUsage, config.thresholds);

      return {
        date,
        originalDate: orig,
        moved: date !== orig,
        workingDaysLeft,
        items: own.length,
        finished: own.length - open.length,
        ready: open.filter((i) => i.readyToWork).length,
        hoursToDoThisDelivery: round(own.reduce((t, i) => t + i.hoursToDoTotal, 0), 1),
        hoursNeededCumulative,
        hoursAvailable,
        usage,
        bottleneck,
        maxUsage,
        missingHours,
        missingHoursTotal: round(STEPS.reduce((t, s) => t + missingHours[s], 0), 1),
        extraPeople,
        extraPeopleTotal: STEPS.reduce((t, s) => t + extraPeople[s], 0),
        overtimeNeeded,
        trafficLight: light,
        nonWorkingDay: nonWorkingReason(date, config.holidays),
      };
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.originalDate < b.originalDate ? -1 : 1));
}

// Earliest date this delivery could move to and stop being RED, all else equal.
export function earliestFeasibleDate(data, scenario, originalDate, horizonDays = 90) {
  const sc = normalizeScenario(scenario);
  const start = sc.dateShifts[originalDate] || originalDate;
  let d = start;
  for (let n = 0; n < horizonDays; n++) {
    d = nextWorkingDay(d, data.config.holidays);
    const trial = { ...sc, dateShifts: { ...sc.dateShifts, [originalDate]: d } };
    const row = computeDeliveries(data, trial).find((x) => x.originalDate === originalDate);
    if (row.maxUsage <= data.config.thresholds.red) return { date: d, usage: row.maxUsage, workingDaysAdded: workingDaysBetween(addDays(start, 1), d, data.config.holidays) };
  }
  return null;
}

// Open pieces of one delivery, heaviest at the bottleneck first.
export function blockers(data, originalDate, bottleneck) {
  return data.items
    .filter((i) => i.delivery === originalDate && !i.status.assembled)
    .map((i) => ({
      id: i.id,
      item: i.item,
      model: i.model,
      category: i.category,
      type: i.type,
      currentStep: i.currentStep,
      readyToWork: i.readyToWork,
      waitingMaterials: !i.status.materialsArrived,
      waitingAccessories: !i.status.accessoriesArrived,
      hoursAtBottleneck: i.hoursToDo[bottleneck],
      hoursToDoTotal: i.hoursToDoTotal,
      dataIssues: i.dataIssues,
    }))
    .sort((a, b) => b.hoursAtBottleneck - a.hoursAtBottleneck || b.hoursToDoTotal - a.hoursToDoTotal);
}

// Data quality: non-working delivery dates, PLM incoherences, blocked work counted as workable.
export function dataWarnings(data, deliveries) {
  const open = data.items.filter((i) => !i.status.assembled);
  return {
    nonWorkingDeliveries: deliveries.filter((d) => d.nonWorkingDay).map((d) => ({ date: d.date, reason: d.nonWorkingDay })),
    plmIssues: data.items.filter((i) => i.dataIssues.length).map((i) => ({ id: i.id, item: i.item, delivery: i.delivery, issues: i.dataIssues })),
    blockedCountedAsWorkable: {
      withoutMaterials: data.items.filter((i) => !i.status.materialsArrived).length,
      withoutAccessories: data.items.filter((i) => !i.status.accessoriesArrived).length,
      openWithoutMaterials: open.filter((i) => !i.status.materialsArrived).length,
      openWithoutAccessories: open.filter((i) => !i.status.accessoriesArrived).length,
    },
  };
}

// Morning brief: the first delivery at risk, its cause and the options to fix it.
export function morningBrief(data, deliveries, scenario) {
  const active = deliveries.filter((d) => d.trafficLight !== 'DONE');
  const focus = active.find((d) => d.trafficLight === 'LATE' || d.trafficLight === 'RED') || active.find((d) => d.trafficLight === 'AMBER') || null;
  if (!focus) return { status: 'CLEAR', focus: null };
  const s = focus.bottleneck;
  const cap = capacity(data.config, scenario);
  const redCount = deliveries.filter((d) => d.trafficLight === 'RED').length;
  return {
    status: focus.trafficLight,
    focus,
    bottleneck: s,
    redCount,
    options: {
      addPeople: { station: s, people: focus.extraPeople[s], allStations: focus.extraPeople, total: focus.extraPeopleTotal },
      overtime: { station: s, hoursPerPersonPerDay: focus.overtimeNeeded[s], currentPeople: cap[s].people },
      moveDate: focus.trafficLight === 'RED' ? earliestFeasibleDate(data, scenario, focus.originalDate) : null,
    },
  };
}

// One call for the UI.
export function computePlan(data, scenario = {}) {
  const sc = normalizeScenario(scenario);
  const deliveries = computeDeliveries(data, sc);
  return {
    today: data.config.today,
    scenario: sc,
    capacity: capacity(data.config, sc),
    deliveries,
    brief: morningBrief(data, deliveries, sc),
    warnings: dataWarnings(data, deliveries),
  };
}
