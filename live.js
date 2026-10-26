import { computePlan, pct, STEPS } from './engine.js';
import {
  createLine, tick, dayOf, clockOf, queueOf, setPeople, snapshot, DAY_HOURS,
  present, absences, reportAbsence, clearAbsences, absentHours,
} from './live-sim.js';

// Live line tab: the workshop as it runs, station by station, as if the page were connected to the PLM.
// In this demo the feed is simulated from the PLM snapshot (live-sim.js); the forecast reuses engine.js.
const DATA_URL = './data/demo-data.json';
const SPEEDS = [{ x: 60, label: '1 min/s' }, { x: 600, label: '10 min/s' }, { x: 3600, label: '1 h/s' }];
const MAX_PEOPLE = { cad: 4, cutting: 6, preparation: 6, assembly: 8 };
const SQUARES = 48;     // pieces drawn per queue, the rest as "+N"
const FEED = 12;        // events shown
const PAINT_MS = 250;   // repaint at most 4 times a second
const DURATIONS = [{ days: 1, label: 'Today' }, { days: 2, label: '2 days' }, { days: 5, label: '1 week' }];
const REASONS = ['Sick', 'On holiday', 'In training'];
const CATEGORY = { Bags: 'Bags', 'Small leather goods': 'Small leather goods', Luggage: 'Luggage', Belts: 'Belts' };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (iso, opts) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...opts }).format(new Date(iso + 'T00:00:00Z'));
const dm = (iso) => fmt(iso, { day: 'numeric', month: 'short' });
const wdm = (iso) => fmt(iso, { weekday: 'short', day: 'numeric', month: 'short' });
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const share = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const PLAIN = { GREEN: 'On track', AMBER: 'Tight', RED: 'At risk', LATE: 'Late', DONE: 'Done' };
const stateTag = (light) => `<span class="state" data-light="${light}"><span class="sq"></span><span class="label">${light}</span><span class="plain">${PLAIN[light]}</span></span>`;
const WAIT = { materials: 'Waiting for materials', accessories: 'Waiting for accessories' };
const isRisk = (light) => light === 'RED' || light === 'LATE';

let data, labels, line, plan, normal;
const live = { playing: false, speed: 600, last: 0, painted: 0, built: false, alerts: new Set(), lights: new Map() };

// ---------- tabs ----------
function showTab() {
  const isLive = location.hash === '#live';
  $('view-overview').hidden = isLive;
  $('view-live').hidden = !isLive;
  document.querySelectorAll('.tab').forEach((t) => {
    if ((t.dataset.tab === 'live') === isLive) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  });
  if (isLive && data) { build(); paint(true); if (!live.started) { live.started = true; play(true); } }
  else play(false);
}

// ---------- loop ----------
function play(on) {
  live.playing = on;
  live.last = performance.now();
  if (on) requestAnimationFrame(frame);
  if (live.built) paintControls();
}
function frame(now) {
  if (!live.playing) return;
  const dt = Math.min(0.25, (now - live.last) / 1000) * live.speed / 3600; // working hours
  live.last = now;
  tick(line, dt);
  watch();
  if (now - live.painted > PAINT_MS) paint();
  requestAnimationFrame(frame);
}

function restart() {
  line = createLine(data);
  live.alerts.clear(); live.lights.clear();
  forecast();
  for (const d of plan.deliveries) live.lights.set(d.originalDate, d.trafficLight);
  if (live.built) { paintPeople(); paint(true); }
}

// ---------- forecast: normal conditions, then the same with today's absences ----------
// engine.js gives the plan with everybody in; each absence removes its hours before each delivery date.
function forecast() {
  normal = computePlan(snapshot(line));
  if (!absences(line).length) { plan = normal; return; }
  const { amber, red } = data.config.thresholds;
  const deliveries = normal.deliveries.map((d) => {
    const hoursAvailable = {}, usage = {}, missingHours = {};
    for (const s of STEPS) {
      const need = d.hoursNeededCumulative[s];
      hoursAvailable[s] = Math.max(0, d.hoursAvailable[s] - absentHours(line, s, d.date));
      usage[s] = hoursAvailable[s] > 0 ? need / hoursAvailable[s] : need > 0 ? Infinity : 0;
      missingHours[s] = Math.max(0, Math.round((need - hoursAvailable[s]) * 10) / 10);
    }
    const bottleneck = STEPS.reduce((a, b) => (usage[b] > usage[a] ? b : a));
    const u = usage[bottleneck];
    const trafficLight = d.trafficLight === 'DONE' || d.trafficLight === 'LATE' ? d.trafficLight : u > red ? 'RED' : u >= amber ? 'AMBER' : 'GREEN';
    const missingHoursTotal = STEPS.reduce((t, s) => t + missingHours[s], 0);
    return { ...d, hoursAvailable, usage, missingHours, missingHoursTotal, bottleneck, maxUsage: u, trafficLight };
  });
  plan = { ...normal, deliveries };
}

// ---------- what the line looks like now ----------
function station(s) {
  const ws = line.workers[s];
  const busy = ws.filter((w) => w.piece !== null);
  const queue = queueOf(line, s);
  const inWork = busy.reduce((t, w) => t + line.pieces[w.piece - 1].left[s], 0);
  const queued = queue.reduce((t, p) => t + p.left[s], 0);
  const here = present(line, s);
  const days = here ? (inWork + queued) / (here * DAY_HOURS) : Infinity;
  const today = Math.floor(line.t / DAY_HOURS + 1e-9) * DAY_HOURS;
  const doneToday = line.events.filter((e) => e.station === s && e.t >= today).length;
  return { ws, busy, queue, queued, days, here, doneToday };
}
const nextOpen = () => plan.deliveries.find((d) => d.trafficLight !== 'DONE' && d.date >= dayOf(line)) || plan.deliveries.find((d) => d.trafficLight !== 'DONE');
const risky = () => new Set(plan.deliveries.filter((d) => isRisk(d.trafficLight)).map((d) => d.originalDate));
const daysTone = (d) => (d > 3 ? 'is-red' : d > 1.5 ? 'is-amber' : '');
const daysText = (d) => (Number.isFinite(d) ? `${d.toFixed(1)} days` : 'nobody in');

// Alerts a supervisor would want pushed, each said once until the situation changes.
function watch() {
  forecast();
  for (const d of plan.deliveries) {
    const was = live.lights.get(d.originalDate);
    if (was && was !== d.trafficLight) {
      line.events.push({ t: line.t, kind: isRisk(d.trafficLight) ? 'alert' : 'good', text: `Delivery ${dm(d.originalDate)} turned ${d.trafficLight} · ${PLAIN[d.trafficLight].toLowerCase()}` });
    }
    live.lights.set(d.originalDate, d.trafficLight);
  }
  for (const s of STEPS) {
    const st = station(s);
    const key = `q:${s}`;
    if (st.days > 3 && !live.alerts.has(key)) { live.alerts.add(key); line.events.push({ t: line.t, kind: 'alert', text: `${labels[s]} queue above 3 days of work` }); }
    if (st.days < 2) live.alerts.delete(key);
    const idle = st.here - st.busy.length, ikey = `i:${s}:${dayOf(line)}`;
    if (idle > 0 && !st.queue.length && !live.alerts.has(ikey) && line.pieces.some((p) => STAGES_BEFORE[s].includes(p.stage))) {
      live.alerts.add(ikey);
      line.events.push({ t: line.t, kind: 'warn', text: `${labels[s]}: ${plural(idle, 'person', 'people')} idle, no piece ready` });
    }
  }
}
const STAGES_BEFORE = { cad: [], cutting: ['cad', 'materials'], preparation: ['cad', 'materials', 'cutting'], assembly: ['cad', 'materials', 'cutting', 'preparation', 'accessories'] };

// ---------- build once (buttons and selects stay put while the numbers change) ----------
function build() {
  if (live.built) return;
  live.built = true;
  const card = (s, k) => `
    <article class="lc" data-station="${s}">
      <header class="lc-head">
        <span class="flow-num">${k + 1}</span>
        <span class="lc-name">${esc(labels[s])}</span>
        <span class="lc-light" id="lc-light-${s}"></span>
      </header>
      <div class="benches" id="lc-benches-${s}"></div>
      <div class="lc-team">
        <span class="small muted" id="lc-team-${s}"></span>
        <span class="lc-step">
          <button class="sbtn" data-live-people="${s}" data-d="-1" aria-label="One bench fewer in ${esc(labels[s])}">−</button>
          <button class="sbtn" data-live-people="${s}" data-d="1" aria-label="One more bench in ${esc(labels[s])}">+</button>
        </span>
      </div>
      <div class="lc-body" id="lc-body-${s}"></div>
    </article>`;
  const wait = (w) => `
    <article class="lw" data-wait="${w}">
      <span class="label">${WAIT[w]}</span>
      <div id="lw-body-${w}"></div>
    </article>`;
  const arrow = '<span class="larrow" aria-hidden="true">→</span>';
  $('view-live').innerHTML = `
    <section class="lhero">
      <div class="lhero-top">
        <p class="label eyebrow"><span class="live-dot" aria-hidden="true"></span>Live line · Leather goods prototyping</p>
        <p class="label muted" id="live-source"></p>
      </div>
      <h1 class="hero-title" id="live-title" aria-live="polite"></h1>
      <div class="lbar">
        <div class="lclock"><span class="lclock-t num" id="live-clock"></span><span class="small muted" id="live-day"></span></div>
        <div class="lctl" id="live-ctl"></div>
      </div>
    </section>
    <div class="kpis" id="live-kpis"></div>

    <section class="cond" id="cond" aria-label="Conditions today">
      <div class="cond-state" id="cond-state" aria-live="polite"></div>
      <div class="cond-form">
        <span class="label ink">Report an absence</span>
        <label class="cond-f"><span class="label muted">Station</span>
          <select class="select" id="abs-station">${STEPS.map((s) => `<option value="${s}">${esc(labels[s])}</option>`).join('')}</select></label>
        <label class="cond-f"><span class="label muted">Reason</span>
          <select class="select" id="abs-reason">${REASONS.map((r) => `<option>${r}</option>`).join('')}</select></label>
        <span class="cond-f"><span class="label muted">For</span>
          <span class="lspeed" role="group" aria-label="How long">${DURATIONS.map((d, k) => `<button class="chip-s ${k === 0 ? 'is-on' : ''}" data-abs-days="${d.days}" aria-pressed="${k === 0}">${d.label}</button>`).join('')}</span></span>
        <button class="btn btn-primary" data-live="absent">Report</button>
        <button class="link small" data-live="normal" id="abs-clear">Back to normal conditions</button>
      </div>
      <div class="cond-impact" id="cond-impact" aria-live="polite"></div>
    </section>

    <section class="floor" id="floor" aria-label="The production line now">
      <div class="floor-head"><span class="section">The line</span><span class="small muted">One bench per artisan · pieces move left to right</span></div>
      <div class="line">
        ${card('cad', 0)}${arrow}${wait('materials')}${arrow}${card('cutting', 1)}${arrow}${card('preparation', 2)}${arrow}
        ${wait('accessories')}${arrow}${card('assembly', 3)}${arrow}
        <article class="lw lw-done"><span class="label">Finished</span><div id="lw-body-done"></div></article>
      </div>
      <div class="belt" aria-hidden="true"></div>
      <p class="small muted lkey"><i class="pi is-busy"></i> working <i class="pi is-idle"></i> free, no piece ready <i class="pi is-absent"></i> absent <span class="sqk is-risk"></span> piece of a delivery at risk <span class="sqk"></span> other piece</p>
    </section>

    <section class="block mix" aria-label="What is on the line">
      <div class="block-head"><span class="section">What is on the line</span><span class="label muted">Same ${data.items.length} pieces as the overview</span></div>
      <h2 class="sim-title" id="mix-title"></h2>
      <div class="mix-rows" id="mix-rows"></div>
    </section>

    <div class="lgrid">
      <section class="panel">
        <div class="panel-head"><h3 class="panel-title">What is happening</h3><p class="small muted">Status changes as the PLM would send them, newest first.</p></div>
        <ol class="feed" id="live-feed"></ol>
      </section>
      <section class="panel">
        <div class="panel-head"><h3 class="panel-title">Deliveries, forecast now</h3><p class="small muted">Same rules as the overview, recalculated with every change on the line and every absence.</p></div>
        <div id="live-del"></div>
      </section>
    </div>
    <section class="block" aria-label="How the live line works">
      <div class="block-head"><span class="section">How it would connect to the PLM</span></div>
      <div class="notes">
        <p>Each status change in the PLM (pattern done, materials in, cut, prepared, accessories in, assembled) is an event. Connected, the page would receive those events and update in seconds, with no download.</p>
        <p>In this demo the feed is simulated: it starts from the PLM snapshot and each artisan works the next piece of their station, earliest delivery first, for its standard hours. Material and accessory arrivals are assumed (half a day to four days).</p>
        <p>Normal conditions means every artisan is in. Report an absence and that person's bench stops: their piece goes back to the queue, the station loses those hours, and the forecast shows which deliveries change.</p>
        <p>Use + and − to add or remove a bench while the line runs. Next step with real data: attendance from the HR system and measured times per piece instead of standard ones.</p>
      </div>
    </section>`;
  paintPeople();
}

// ---------- paint ----------
function paintControls() {
  $('live-ctl').innerHTML = `
    <button class="btn ${live.playing ? '' : 'btn-primary'}" data-live="toggle">${live.playing ? 'Pause' : 'Play'}</button>
    <span class="lspeed" role="group" aria-label="Replay speed">${SPEEDS.map((s) => `<button class="chip-s ${s.x === live.speed ? 'is-on' : ''}" data-live-speed="${s.x}" aria-pressed="${s.x === live.speed}">${s.label}</button>`).join('')}</span>
    <button class="link small" data-live="restart">Restart from PLM snapshot</button>`;
  $('floor').classList.toggle('is-running', live.playing);
}
function paintPeople() {
  for (const s of STEPS) {
    const n = line.workers[s].length;
    document.querySelectorAll(`[data-live-people="${s}"]`).forEach((b) => {
      b.disabled = Number(b.dataset.d) < 0 ? n <= 0 : n >= MAX_PEOPLE[s];
    });
  }
  $('abs-clear').disabled = !absences(line).length;
}

function squares(ps, risk) {
  const shown = ps.slice(0, SQUARES).map((p) => `<i class="sqk ${risk.has(p.delivery) ? 'is-risk' : ''}" title="${esc(p.name)} · ${dm(p.delivery)}"></i>`).join('');
  return `<span class="sqs">${shown}${ps.length > SQUARES ? `<span class="small muted">+${ps.length - SQUARES}</span>` : ''}</span>`;
}

// One bench per artisan: who is there, what they are working on, how far along.
function bench(s, w, k, risk) {
  if (w.absent) {
    return `<div class="bench is-absent"><i class="pi is-absent"></i><div class="desk">
      <span class="desk-top"><span>Artisan ${k + 1}</span><span class="small">${esc(w.absent.reason)}</span></span>
      <span class="small muted">Back ${wdm(dayOf(line, w.absent.until))}</span></div></div>`;
  }
  if (w.piece === null) {
    return `<div class="bench is-idle"><i class="pi is-idle"></i><div class="desk">
      <span class="desk-top"><span class="muted">Artisan ${k + 1}</span></span><span class="small muted">Free · no piece ready</span></div></div>`;
  }
  const p = line.pieces[w.piece - 1];
  const done = p.std[s] > 0 ? Math.min(1, 1 - p.left[s] / p.std[s]) : 1;
  return `<div class="bench is-busy ${risk.has(p.delivery) ? 'is-risk' : ''}"><i class="pi is-busy"></i><div class="desk">
    <span class="desk-top"><span class="ink">${esc(p.name)}</span><span class="small muted num">${dm(p.delivery)}</span></span>
    <span class="lprog"><i style="width:${Math.round(done * 100)}%"></i></span></div></div>`;
}

function paintConditions() {
  const out = absences(line);
  const total = STEPS.reduce((t, s) => t + line.workers[s].length, 0);
  $('cond').classList.toggle('is-off', out.length > 0);
  $('cond-state').innerHTML = out.length
    ? `<span class="cond-dot"></span><span><span class="ink strong">${plural(out.length, 'person', 'people')} out</span> · ${out.map((a) => `${esc(labels[a.station])}: ${esc(a.who)} ${esc(a.reason.toLowerCase())}, back ${wdm(dayOf(line, a.until))}`).join(' · ')}</span>`
    : `<span class="cond-dot"></span><span><span class="ink strong">Normal conditions</span> · all ${total} artisans in. The forecast assumes everybody works their 8 hours.</span>`;
  if (!out.length) { $('cond-impact').innerHTML = ''; return; }
  // What the absences change, compared with the same moment in normal conditions.
  const lost = STEPS.map((s) => [s, absentHours(line, s, dayOf(line))]).filter(([, h]) => h > 0);
  const changed = plan.deliveries.map((d, k) => [normal.deliveries[k], d])
    .filter(([a, b]) => b.trafficLight !== 'DONE' && b.trafficLight !== 'LATE' && (a.trafficLight !== b.trafficLight || b.missingHoursTotal - a.missingHoursTotal >= 0.5));
  const rows = changed.map(([a, b]) => `<li class="imp"><span class="ink num">${wdm(b.date)}</span>
    ${a.trafficLight === b.trafficLight ? stateTag(b.trafficLight) : `${stateTag(a.trafficLight)}<span class="muted">→</span>${stateTag(b.trafficLight)}`}
    <span class="small">${b.missingHoursTotal > 0 ? `${Math.round(b.missingHoursTotal)} h short${a.missingHoursTotal > 0 ? ` (was ${Math.round(a.missingHoursTotal)} h)` : ''}` : `${labels[b.bottleneck]} at ${pct(b.maxUsage)}%`}</span></li>`).join('');
  $('cond-impact').innerHTML = `
    <p class="small"><span class="ink strong">Impact.</span> Today ${lost.map(([s, h]) => `${esc(labels[s])} loses ${Math.round(h)} h of ${Math.round(present(line, s) * DAY_HOURS + h)} h`).join(', ') || 'no hours are lost'}.
    ${changed.length ? `${plural(changed.length, 'delivery', 'deliveries')} ${changed.length === 1 ? 'changes' : 'change'}:` : 'No delivery changes state: the team absorbs it.'}</p>
    ${rows ? `<ol class="imps">${rows}</ol>` : ''}`;
}

function paintMix() {
  const groups = {};
  for (const p of line.pieces) {
    const g = (groups[p.category] ||= { n: 0, done: 0, hours: 0, std: 0, types: {}, diff: {} });
    g.n++;
    if (p.stage === 'done') g.done++;
    g.hours += STEPS.reduce((t, s) => t + Math.max(0, p.left[s]), 0);
    const st = data.standardTimes.find((x) => x.type === p.type && x.category === p.category && x.difficulty === p.difficulty);
    g.std += st ? STEPS.reduce((t, s) => t + st[s], 0) : 0;
    g.types[p.type] = (g.types[p.type] || 0) + 1;
    g.diff[p.difficulty] = (g.diff[p.difficulty] || 0) + 1;
  }
  const all = line.pieces.length, hoursAll = Object.values(groups).reduce((t, g) => t + g.hours, 0);
  const order = Object.entries(groups).sort((a, b) => b[1].n - a[1].n);
  const most = order[0][1].n;
  const [top, g] = order[0];
  const topType = Object.entries(g.types).sort((a, b) => b[1] - a[1])[0];
  const heavy = [...order].sort((a, b) => b[1].std / b[1].n - a[1].std / a[1].n)[0];
  $('mix-title').innerHTML = `Mostly ${esc((CATEGORY[top] || top).toLowerCase())}: ${g.n} of ${all} pieces (${share(g.n, all)}%), most of them ${esc(topType[0].toLowerCase())}s.${heavy[0] !== top ? ` <span class="cause">${esc(heavy[0])}: fewer pieces, but the most hours per piece.</span>` : ''}`;
  $('mix-rows').innerHTML = order.map(([cat, x]) => {
    const types = Object.entries(x.types).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${n} ${t.toLowerCase()}${n === 1 ? '' : 's'}`).join(', ');
    const diff = Object.entries(x.diff).sort((a, b) => b[1] - a[1])[0][0];
    return `<div class="mrow">
      <span class="mrow-name"><span class="ink">${esc(cat)}</span><span class="small muted">${types} · ${esc(diff.toLowerCase())}</span></span>
      <span class="mix-bar" aria-label="${x.done} of ${x.n} finished"><span class="mix-all" style="width:${share(x.n, most)}%"><i style="width:${share(x.done, x.n)}%"></i></span></span>
      <span class="num ink mrow-n">${x.n}<span class="small muted"> · ${share(x.n, all)}%</span></span>
      <span class="small muted num">${x.done} finished · ${Math.round(x.hours)} h left (${share(x.hours, hoursAll)}% of the work)</span>
    </div>`;
  }).join('');
}

function paint(full = false) {
  live.painted = performance.now();
  if (full) paintControls();
  const day = dayOf(line), risk = risky(), next = nextOpen();
  const today = Math.floor(line.t / DAY_HOURS + 1e-9) * DAY_HOURS;
  const stations = Object.fromEntries(STEPS.map((s) => [s, station(s)]));
  const worst = STEPS.reduce((a, b) => (stations[b].days > stations[a].days ? b : a));

  $('live-source').textContent = `PLM feed · simulated from the ${fmt(data.config.today, { day: 'numeric', month: 'short', year: 'numeric' })} snapshot`;
  $('live-clock').textContent = clockOf(line.t);
  $('live-day').textContent = `${fmt(day, { weekday: 'long', day: 'numeric', month: 'long' })}${line.t < DAY_HOURS ? ' · day of the PLM snapshot' : ''}`;
  const w = stations[worst];
  $('live-title').innerHTML = next
    ? `${esc(labels[worst])} is the bottleneck right now: ${daysText(w.days)} of work waiting. <span class="cause">Next delivery ${dm(next.date)} is ${PLAIN[next.trafficLight].toLowerCase()}.</span>`
    : 'Every delivery is finished.';

  const finishedToday = line.pieces.filter((p) => p.doneAt !== null && p.doneAt >= today && p.doneAt >= 0).length;
  const people = STEPS.reduce((t, s) => t + stations[s].here, 0);
  const busy = STEPS.reduce((t, s) => t + stations[s].busy.length, 0);
  const out = absences(line).length;
  const waiting = line.pieces.filter((p) => p.stage === 'materials' || p.stage === 'accessories').length;
  const done = line.pieces.filter((p) => p.stage === 'done').length;
  const kpi = (v, label, sub = '', cls = '') => `<div class="kpi ${cls}"><span class="label muted">${label}</span><span class="kpi-v num">${v}</span><span class="small muted">${sub}</span></div>`;
  $('live-kpis').innerHTML = [
    kpi(finishedToday, 'Finished today', `${done} of ${line.pieces.length} pieces finished in total`),
    kpi(`${busy}<span class="kpi-of">/${people}</span>`, 'Artisans working now', [out ? `${out} absent` : '', busy < people ? `${people - busy} without a piece ready` : 'everyone in has a piece'].filter(Boolean).join(' · '), out ? 'is-warn' : ''),
    kpi(waiting, 'Waiting for suppliers', 'materials or accessories'),
    next ? kpi(dm(next.date), 'Next delivery', `${plural(next.items - next.finished, 'piece')} open · ${plural(next.workingDaysLeft, 'working day')} left`, isRisk(next.trafficLight) ? 'is-bad' : next.trafficLight === 'AMBER' ? 'is-warn' : '') : kpi('—', 'Next delivery'),
    kpi(`${plan.deliveries.filter((d) => risk.has(d.originalDate)).length}<span class="kpi-of">/${plan.deliveries.length}</span>`, 'Deliveries at risk', out ? 'forecast with today’s absences' : 'forecast with the line as it is now', risk.size ? 'is-bad' : ''),
  ].join('');

  paintConditions();
  for (const s of STEPS) {
    const st = stations[s];
    $(`lc-light-${s}`).innerHTML = `<span class="lc-days ${daysTone(st.days)}">${daysText(st.days)} of work</span>`;
    $(`lc-benches-${s}`).innerHTML = st.ws.map((x, k) => bench(s, x, k, risk)).join('') || '<p class="small muted">No benches</p>';
    const absent = st.ws.length - st.here;
    $(`lc-team-${s}`).innerHTML = `${plural(st.ws.length, 'bench', 'benches')}${absent ? ` · <span class="st-absent">${absent} absent</span>` : ''}`;
    $(`lc-body-${s}`).innerHTML = `
      <p class="label muted lq">Queue · ${plural(st.queue.length, 'piece')} · ${Math.round(st.queued)} h</p>
      ${squares(st.queue, risk)}
      <p class="small muted lc-foot">${plural(st.doneToday, 'piece')} through today</p>`;
  }
  for (const wt of ['materials', 'accessories']) {
    const ps = line.pieces.filter((p) => p.stage === wt).sort((a, b) => a.arriveAt - b.arriveAt);
    const soon = ps[0] ? Math.max(0, ps[0].arriveAt - line.t) : null;
    $(`lw-body-${wt}`).innerHTML = `<span class="lw-n num">${ps.length}</span>${squares(ps, risk)}<span class="small muted">${soon === null ? 'Nothing pending' : soon < 1 ? 'Next arrival within the hour' : `Next arrival in ${Math.round(soon)} h`}</span>`;
  }
  $('lw-body-done').innerHTML = `<span class="lw-n num">${done}</span><span class="small muted">${plural(finishedToday, 'piece')} today</span>`;
  paintMix();

  $('live-feed').innerHTML = line.events.slice(-FEED).reverse().map((e) => `
    <li class="fe fe-${e.kind}"><span class="num muted">${e.kind === 'day' ? '' : `${wdm(dayOf(line, e.t))} ${clockOf(e.t)}`}</span><span>${esc(e.text)}</span></li>`).join('') || '<li class="small muted">The line just started. Events appear here.</li>';

  $('live-del').innerHTML = plan.deliveries.map((d) => {
    const part = d.items ? d.finished / d.items : 0;
    return `<div class="ldel ${next && d.originalDate === next.originalDate ? 'is-next' : ''}">
      <span class="ink num">${wdm(d.date)}</span>${stateTag(d.trafficLight)}
      <span class="chip-bar" aria-label="${d.finished} of ${d.items} finished"><i style="width:${Math.round(part * 100)}%"></i></span>
      <span class="small muted num">${d.finished}/${d.items} · ${d.trafficLight === 'DONE' ? 'all finished' : d.trafficLight === 'LATE' ? `${d.items - d.finished} still open` : `${esc(labels[d.bottleneck])} ${Number.isFinite(d.usage[d.bottleneck]) ? pct(d.usage[d.bottleneck]) + '%' : '—'}`}</span>
    </div>`;
  }).join('');
}

// ---------- interaction ----------
let absDays = 1;
document.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t || t.disabled || !line) return;
  if (t.dataset.live === 'toggle') play(!live.playing);
  else if (t.dataset.live === 'restart') restart();
  else if (t.dataset.liveSpeed) { live.speed = Number(t.dataset.liveSpeed); paintControls(); }
  else if (t.dataset.absDays) {
    absDays = Number(t.dataset.absDays);
    document.querySelectorAll('[data-abs-days]').forEach((b) => { b.classList.toggle('is-on', b === t); b.setAttribute('aria-pressed', String(b === t)); });
  } else if (t.dataset.live === 'absent' || t.dataset.live === 'normal') {
    const s = $('abs-station').value;
    if (t.dataset.live === 'normal') clearAbsences(line);
    else if (!reportAbsence(line, s, absDays, $('abs-reason').value)) line.events.push({ t: line.t, kind: 'warn', text: `${labels[s]}: everybody is already out` });
    paintPeople(); watch(); paint();
  } else if (t.dataset.livePeople) {
    const s = t.dataset.livePeople;
    setPeople(line, s, line.workers[s].length + Number(t.dataset.d));
    line.events.push({ t: line.t, kind: 'team', text: `${labels[s]} now has ${plural(line.workers[s].length, 'bench', 'benches')}` });
    paintPeople(); watch(); paint();
  }
});
window.addEventListener('hashchange', showTab);
document.addEventListener('visibilitychange', () => { live.last = performance.now(); });

// ---------- boot ----------
(async () => {
  data = await (await fetch(DATA_URL)).json();
  labels = Object.fromEntries(data.config.steps.map((s) => [s.key, s.label]));
  restart();
  showTab();
})();
