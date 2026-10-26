// Live line · simulation of the PLM feed (pure, no DOM, runs in the browser and in Node).
// Starts from the PLM snapshot and moves every piece through the stations in working time:
// each person takes the next piece of their station (earliest delivery first) and works its standard hours.
// Connected to the real PLM, these events would come from the status changes instead of from this clock.
import { STEPS, nextWorkingDay, workingDaysBetween } from './engine.js';

export const DAY_HOURS = 8;
// Where a piece can be, in process order. Waiting stages have no people: they end when the delivery arrives.
export const STAGES = ['cad', 'materials', 'cutting', 'preparation', 'accessories', 'assembly', 'done'];
const FROM_PLM = {
  'CAD / DXF': 'cad', 'Waiting materials': 'materials', Cutting: 'cutting', Preparation: 'preparation',
  'Waiting accessories': 'accessories', Assembly: 'assembly', Finished: 'done',
};
// Supplier lead times in working hours (not in the PLM download, so they are assumed): [min, max].
const LEAD = { materials: [8, 32], accessories: [4, 24], materialsNow: [0, 24], accessoriesNow: [0, 16] };

// Same seed, same day: a replay always looks the same.
function rand(seed) {
  let t = (seed + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const between = ([a, b], r) => a + (b - a) * r;

export function createLine(data) {
  const pieces = data.items.map((i) => {
    const stage = FROM_PLM[i.currentStep] || 'cad';
    const p = {
      id: i.id, name: i.item, delivery: i.delivery, category: i.category, type: i.type, difficulty: i.difficulty, stage,
      left: { ...i.hoursToDo }, std: { ...i.hoursToDo },
      arriveAt: null, doneAt: stage === 'done' ? -1 : null, worker: null,
    };
    if (stage === 'materials') p.arriveAt = between(LEAD.materialsNow, rand(i.id));
    if (stage === 'accessories') p.arriveAt = between(LEAD.accessoriesNow, rand(i.id * 7));
    return p;
  });
  const line = {
    data, pieces, t: 0, events: [], days: [data.config.today],
    workers: Object.fromEntries(STEPS.map((s) => [s, Array.from({ length: data.config.people[s] }, () => ({ piece: null, absent: null }))])),
  };
  for (const p of pieces) settle(line, p);
  return line;
}

// ---------- clock: t counts working hours since the snapshot (08:00 of the cut-off day) ----------
export function dayOf(line, t = line.t) {
  const k = Math.floor(t / DAY_HOURS + 1e-9);
  while (line.days.length <= k) line.days.push(nextWorkingDay(line.days[line.days.length - 1], line.data.config.holidays));
  return line.days[k];
}
// 08:00–12:00, lunch, 13:00–17:00.
export function clockOf(t) {
  const h = t - Math.floor(t / DAY_HOURS + 1e-9) * DAY_HOURS;
  const mins = Math.round((h < 4 ? 8 + h : 9 + h) * 60);
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

function log(line, kind, text, extra = {}) {
  line.events.push({ t: line.t, kind, text, ...extra });
  if (line.events.length > 200) line.events.splice(0, line.events.length - 200);
}

// Move a piece forward while there is nothing to do where it is (0 h steps, materials already in).
function settle(line, p) {
  for (;;) {
    if (STEPS.includes(p.stage) && p.left[p.stage] <= 1e-9) advance(line, p, false);
    else return;
  }
}

function advance(line, p, announce = true) {
  const from = p.stage;
  if (STEPS.includes(from)) p.left[from] = 0;
  const next = STAGES[STAGES.indexOf(from) + 1];
  if (next === 'materials' || next === 'accessories') {
    const r = rand(p.id * 31 + Math.round(line.t * 10));
    p.arriveAt = line.t + between(LEAD[next], r);
  }
  p.stage = next;
  if (next === 'done') {
    p.doneAt = line.t;
    if (announce) log(line, 'done', `${p.name} finished`, { piece: p.id, delivery: p.delivery });
  } else if (announce && STEPS.includes(from)) {
    log(line, 'step', `${p.name} · ${label(line, from)} done`, { piece: p.id, station: from });
  }
  if (STEPS.includes(next) && p.left[next] <= 1e-9) advance(line, p, false);
}

const label = (line, s) => line.data.config.steps.find((x) => x.key === s)?.label || s;
const byPriority = (a, b) => (a.delivery < b.delivery ? -1 : a.delivery > b.delivery ? 1 : a.id - b.id);
export const queueOf = (line, s) => line.pieces.filter((p) => p.stage === s && p.worker === null).sort(byPriority);

// Advance the line by dt working hours, in small steps so hand-overs happen at the right time.
export function tick(line, dt) {
  const end = line.t + dt;
  while (line.t < end - 1e-9) {
    const h = Math.min(0.05, end - line.t);
    for (const p of line.pieces) {
      if ((p.stage === 'materials' || p.stage === 'accessories') && p.arriveAt <= line.t) {
        log(line, 'arrive', `${p.stage === 'materials' ? 'Materials' : 'Accessories'} in for ${p.name}`, { piece: p.id });
        p.arriveAt = null;
        advance(line, p, false);
      }
    }
    for (const s of STEPS) {
      const ws = line.workers[s];
      for (let k = 0; k < ws.length; k++) {
        const w = ws[k];
        if (w.absent) {
          if (line.t < w.absent.until - 1e-9) continue;
          log(line, 'team', `${label(line, s)}: ${w.absent.who} is back`);
          w.absent = null;
        }
        if (w.piece === null) {
          const next = queueOf(line, s)[0];
          if (!next) continue;
          w.piece = next.id; next.worker = `${s}:${k}`;
        }
        const p = line.pieces[w.piece - 1];
        p.left[s] -= h;
        if (p.left[s] <= 1e-9) {
          p.worker = null; w.piece = null;
          advance(line, p);
        }
      }
    }
    const day = Math.floor(line.t / DAY_HOURS + 1e-9);
    line.t += h;
    if (Math.floor(line.t / DAY_HOURS + 1e-9) > day) log(line, 'day', `New working day · ${dayOf(line)}`);
  }
}

// Change the team of a station while the line runs. A person who leaves puts the piece back in the queue.
export function setPeople(line, s, n) {
  const ws = line.workers[s];
  while (ws.length < n) ws.push({ piece: null, absent: null });
  while (ws.length > n) {
    const w = ws.pop();
    if (w.piece !== null) line.pieces[w.piece - 1].worker = null;
  }
}

// ---------- absences: normal conditions = everybody in ----------
const startOfDay = (t) => Math.floor(t / DAY_HOURS + 1e-9) * DAY_HOURS;
export const present = (line, s) => line.workers[s].filter((w) => !w.absent).length;
export const absences = (line) => STEPS.flatMap((s) => line.workers[s].filter((w) => w.absent).map((w) => ({ station: s, ...w.absent })));

// One person of the station is out from now until the end of the day `days` working days from today.
// Their piece goes back to the queue, so the rest of the team picks it up.
export function reportAbsence(line, s, days, reason) {
  const ws = line.workers[s];
  const w = [...ws].reverse().find((x) => !x.absent && x.piece === null) || [...ws].reverse().find((x) => !x.absent);
  if (!w) return false;
  if (w.piece !== null) { line.pieces[w.piece - 1].worker = null; w.piece = null; }
  const n = ws.indexOf(w) + 1;
  w.absent = { who: `Artisan ${n}`, reason, from: line.t, until: startOfDay(line.t) + days * DAY_HOURS };
  log(line, 'alert', `${label(line, s)}: ${w.absent.who} ${reason.toLowerCase()} · out ${days === 1 ? 'today' : `${days} working days`}`);
  return true;
}
export function clearAbsences(line) {
  for (const s of STEPS) for (const w of line.workers[s]) w.absent = null;
  log(line, 'good', 'Back to normal conditions: everyone is in');
}

// Hours a station loses to absences between the start of today and the end of `date`.
// engine.js counts today's hours in full, so the loss is counted from the start of today too.
export function absentHours(line, s, date) {
  const from = startOfDay(line.t);
  const end = from + workingDaysBetween(dayOf(line), date, line.data.config.holidays) * DAY_HOURS;
  return line.workers[s].reduce((t, w) => t + (w.absent ? Math.max(0, Math.min(w.absent.until, end) - from) : 0), 0);
}

// The same data as the PLM download, rebuilt from the live state: lets engine.js forecast every delivery now.
export function snapshot(line) {
  const { data } = line;
  const items = data.items.map((i, k) => {
    const p = line.pieces[k];
    const hoursToDo = Object.fromEntries(STEPS.map((s) => [s, Math.max(0, Math.round(p.left[s] * 100) / 100)]));
    return {
      ...i,
      status: { ...i.status, assembled: p.stage === 'done' },
      hoursToDo,
      hoursToDoTotal: STEPS.reduce((t, s) => t + hoursToDo[s], 0),
      readyToWork: STEPS.includes(p.stage),
    };
  });
  const people = Object.fromEntries(STEPS.map((s) => [s, line.workers[s].length]));
  return { ...data, items, config: { ...data.config, today: dayOf(line), people } };
}
