import { computePlan, blockers, earliestFeasibleDate, nextWorkingDay, workingDaysBetween, pct, STEPS } from './engine.js';

// Friendlier layout (v2.1): delivery picker on top, progress of the chosen delivery, every delivery at a glance,
// and a simulator built around the team of each station. Numbers come only from engine.js (unchanged).
// Anonymized demo data: same hours, dates and statuses as a real PLM download; names are not real.
const DATA_URL = './data/demo-data.json';
const MAX_PEOPLE = { cad: 4, cutting: 6, preparation: 6, assembly: 8 }; // people per station
const MAX_OVERTIME = 4; // h per person per day
const OT_STEP = 0.5;
const MAX_SHIFT = 15;   // working days a delivery can be moved
const AXIS = 2.5;       // station bars run from 0 to 250%
const PIECES_VISIBLE = 6;

const STATION_INFO = {
  cad: 'Digital pattern and cutting file',
  cutting: 'Leather and materials are cut',
  preparation: 'Pieces prepared for sewing',
  assembly: 'The piece is assembled and finished',
};
// Where a piece is today, in process order (currentStep in the data).
const STAGES = [
  { key: 'CAD / DXF', label: 'Pattern (CAD / DXF)', kind: 'work' },
  { key: 'Waiting materials', label: 'Waiting for materials', kind: 'wait' },
  { key: 'Cutting', label: 'Cutting', kind: 'work' },
  { key: 'Preparation', label: 'Preparation', kind: 'work' },
  { key: 'Waiting accessories', label: 'Waiting for accessories', kind: 'wait' },
  { key: 'Assembly', label: 'Assembly', kind: 'work' },
  { key: 'Finished', label: 'Finished', kind: 'done' },
];
// Plain words next to the Excel state codes (the codes stay, as in version 1).
const PLAIN = { GREEN: 'On track', AMBER: 'Tight', RED: 'At risk', LATE: 'Late', DONE: 'Done' };

const $ = (id) => document.getElementById(id);
let data, labels, basePlan, baseline;
const emptyScenario = () => ({ people: {}, overtime: {}, dateShifts: {} });
const state = { scenario: emptyScenario(), selected: null, moveTarget: null, showAllPieces: false };

// ---------- formats ----------
const fmt = (iso, opts) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...opts }).format(new Date(iso + 'T00:00:00Z'));
const dm = (iso) => fmt(iso, { day: 'numeric', month: 'short' });                       // 8 Dec
const wdm = (iso) => fmt(iso, { weekday: 'short', day: 'numeric', month: 'short' });    // Mon 8 Dec
const dMonth = (iso) => fmt(iso, { day: 'numeric', month: 'long' });                    // 8 December
const longDate = (iso) => fmt(iso, { weekday: 'long', day: 'numeric', month: 'long' }); // Monday 8 December
const NBSP = ' ';
const hrs = (x) => `${Math.round(x).toLocaleString('en-GB')}${NBSP}h`;
const h1 = (x) => Number(x).toFixed(1);
const p = (u) => (Number.isFinite(u) ? `${pct(u)}%` : 'no capacity');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const people = (n) => plural(n, 'person', 'people');
const list = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const word = (n) => WORDS[n] ?? String(n);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const nb = (s) => s.replace(/ \/ /g, ' / ');
const ceil1 = (x) => Math.ceil(x * 10 - 1e-9) / 10;
const short = (d) => STEPS.filter((s) => d.missingHours[s] > 0);
const tone = (u) => (!Number.isFinite(u) || u > 1 ? 'is-red' : u >= data.config.thresholds.amber ? 'is-amber' : '');
const isRisk = (d) => d.trafficLight === 'RED' || d.trafficLight === 'LATE';
const stateTag = (light, was) => `<span class="state" data-light="${light}"><span class="sq"></span><span class="label">${light}</span><span class="plain">${PLAIN[light]}</span>${was ? `<span class="label was">was ${was}</span>` : ''}</span>`;
const icons = (n, added = 0) => {
  const base = Math.max(0, n - Math.max(0, added));
  return `${'<i class="pi"></i>'.repeat(base)}${'<i class="pi is-new"></i>'.repeat(Math.max(0, Math.min(added, n)))}`;
};

// ---------- scenario helpers ----------
const sc = () => state.scenario;
const dirty = () => STEPS.some((s) => sc().people[s] || sc().overtime[s]) || Object.keys(sc().dateShifts).length > 0;
const netPeople = () => STEPS.reduce((t, s) => t + (sc().people[s] || 0), 0);

function changes() {
  const out = [];
  for (const s of STEPS) {
    const dp = sc().people[s] || 0;
    if (dp) out.push(`${dp > 0 ? '+' : '−'}${people(Math.abs(dp))} in ${labels[s]}`);
  }
  for (const s of STEPS) if (sc().overtime[s]) out.push(`+${sc().overtime[s]}${NBSP}h overtime in ${labels[s]}`);
  for (const [orig, date] of Object.entries(sc().dateShifts)) out.push(`${dm(orig)} moved to ${dm(date)}`);
  return out;
}

function changePhrases() {
  const out = [];
  for (const s of STEPS) {
    const dp = sc().people[s] || 0;
    if (dp > 0) out.push(`${word(dp)} more ${dp === 1 ? 'person' : 'people'} in ${labels[s]}`);
    if (dp < 0) out.push(`${word(-dp)} ${dp === -1 ? 'person' : 'people'} fewer in ${labels[s]}`);
  }
  for (const s of STEPS) if (sc().overtime[s]) out.push(`${sc().overtime[s]}${NBSP}h overtime in ${labels[s]}`);
  for (const [orig, date] of Object.entries(sc().dateShifts)) out.push(`moving ${dm(orig)} to ${dm(date)}`);
  return out;
}

function shiftDate(orig, n) {
  let d = orig;
  for (let k = 0; k < n; k++) d = nextWorkingDay(d, data.config.holidays);
  return d;
}
const shiftOf = (orig) => {
  const date = sc().dateShifts[orig];
  return date ? workingDaysBetween(nextWorkingDay(orig, data.config.holidays), date, data.config.holidays) : 0;
};
function setShift(orig, date) {
  if (!date || date === orig) delete sc().dateShifts[orig];
  else sc().dateShifts[orig] = date;
}

// ---------- options for the selected delivery (same rules as the morning brief) ----------
function optionsFor(d) {
  const stations = short(d), b = d.bottleneck, opts = [];
  if (!stations.length || d.trafficLight === 'DONE') return opts;
  if (Number.isFinite(d.extraPeople[b])) opts.push({ label: `Try +${d.extraPeople[b]} in ${labels[b]}`, apply: { people: { [b]: d.extraPeople[b] } } });
  const ot = Object.fromEntries(stations.map((s) => [s, ceil1(d.overtimeNeeded[s])]));
  if (stations.every((s) => Number.isFinite(ot[s]) && ot[s] <= MAX_OVERTIME)) {
    const top = Math.max(...stations.map((s) => ot[s]));
    opts.push({ label: stations.length === 1 ? `Try ${top}${NBSP}h overtime` : `Try up to ${top}${NBSP}h overtime`, apply: { overtime: ot } });
  }
  if (d.trafficLight === 'RED') {
    const mv = earliestFeasibleDate(data, sc(), d.originalDate);
    if (mv) opts.push({ label: `Try moving to ${dm(mv.date)}`, apply: { move: { orig: d.originalDate, date: mv.date } } });
  }
  return opts;
}

function applyOption(a) {
  for (const [s, n] of Object.entries(a.people || {})) sc().people[s] = (sc().people[s] || 0) + n;
  for (const [s, h] of Object.entries(a.overtime || {})) sc().overtime[s] = Math.min(MAX_OVERTIME, Math.round(((sc().overtime[s] || 0) + h) * 10) / 10);
  if (a.move) { setShift(a.move.orig, a.move.date); state.moveTarget = a.move.orig; }
}

// One sentence for the selected delivery: state, cause, decision (principle 1 of 02-design).
function sentence(d) {
  const b = d.bottleneck, name = nb(labels[b]);
  if (d.trafficLight === 'DONE') return { risk: `Every piece of ${dMonth(d.date)} is finished.`, cause: '', decision: '' };
  if (d.trafficLight === 'LATE') return { risk: `${longDate(d.date)} has passed.`, cause: `${plural(d.items - d.finished, 'piece')} still open.`, decision: 'Agree a new date.' };
  if (d.trafficLight === 'GREEN') return { risk: `${longDate(d.date)} is on track.`, cause: `The busiest station, ${name}, uses ${p(d.usage[b])} of its hours.`, decision: 'No decision needed.' };
  if (d.trafficLight === 'AMBER') return { risk: `${longDate(d.date)} is tight.`, cause: `${name} will use ${p(d.usage[b])} of its hours.`, decision: 'No hours are missing yet: keep an eye on it.' };
  const st = short(d);
  if (st.length === 1) {
    const n = d.extraPeople[b];
    return { risk: `${longDate(d.date)} is at risk.`, cause: `${name} is ${Math.round(d.missingHours[b])} hours short.`, decision: Number.isFinite(n) ? `Add ${word(n)} ${n === 1 ? 'person' : 'people'} to ${name}, or move the date.` : `${name} has no one assigned.` };
  }
  return { risk: `${longDate(d.date)} is at risk.`, cause: `${hrs(d.missingHoursTotal)} short across ${list(st.map((s) => nb(labels[s])))}.`, decision: Number.isFinite(d.extraPeopleTotal) ? `It needs ${d.extraPeopleTotal} more people, or a new date.` : 'A station has no one assigned.' };
}

// ---------- render ----------
let currentOptions = [];

function render() {
  const plan = computePlan(data, sc());
  if (!plan.deliveries.some((d) => d.originalDate === state.selected)) state.selected = plan.deliveries[0].originalDate;
  const sel = plan.deliveries.find((d) => d.originalDate === state.selected);
  document.body.classList.toggle('is-scenario', dirty());
  renderTopbar();
  renderHero(plan);
  renderSelector(plan);
  renderFocus(sel, plan);
  renderOverview(plan);
  syncSim(plan, sel);
  renderPreview(plan, sel);
}

function renderTopbar() {
  const brand = 'Prototyping Capacity';
  $('topbar').innerHTML = dirty()
    ? `<span class="brand">${brand}</span><span class="label">Scenario · not the plan</span><button class="link" data-action="reset">Reset to plan</button>`
    : `<span class="brand">${brand}</span><span class="label">Prototyping workshop · Florence</span><span class="label">Data from PLM · ${fmt(data.config.today, { day: 'numeric', month: 'short', year: 'numeric' })}</span>`;
}

// Public demo: says who built it and that the data is anonymized.
function renderDemoNote() {
  if (!data.meta?.anonymized) return;
  const note = document.createElement('div');
  note.className = 'demo-note small';
  note.innerHTML = `<span><span class="label ink">Portfolio case study</span> · Built by ${esc(data.meta.author)}, industrial engineer, for a luxury leather goods prototyping workshop in Florence.</span><span class="muted">Data anonymized: piece names, models and collections are not real. Hours, dates and statuses follow a real PLM download.</span>`;
  $('topbar').after(note);
}

function renderHero({ deliveries, capacity }) {
  const items = data.items.length, open = data.items.filter((i) => !i.status.assembled).length;
  const risk = deliveries.filter(isRisk).length, tight = deliveries.filter((d) => d.trafficLight === 'AMBER').length;
  const attention = risk
    ? `${word(risk) === String(risk) ? risk : cap(word(risk))} ${risk === 1 ? 'needs' : 'need'} attention.`
    : tight ? `None at risk, ${word(tight)} tight.` : 'All on track.';
  const flow = STEPS.map((s, k) => {
    const dp = sc().people[s] || 0, n = capacity[s].people;
    return `<li class="flow-step">
      <span class="flow-num">${k + 1}</span>
      <span class="flow-name">${esc(labels[s])}</span>
      <span class="small muted">${esc(STATION_INFO[s])}</span>
      <span class="people-row" aria-label="${people(n)}">${icons(n, dp)}</span>
      <span class="small ink">${people(n)}${dp ? ` <span class="muted">(${dp > 0 ? '+' : '−'}${Math.abs(dp)})</span>` : ''} · ${hrs(capacity[s].hoursPerDay)} a day</span>
    </li>`;
  }).join('<li class="flow-arrow" aria-hidden="true">→</li>');
  $('hero').innerHTML = `
    <p class="label eyebrow">Current production · Leather goods prototyping</p>
    <h1 class="hero-title">${items} pieces in production across ${deliveries.length} delivery dates. <span class="cause">${esc(attention)}</span></h1>
    <p class="lead">Every new bag, wallet, belt or suitcase is first made by hand as a prototype or sample. Each piece goes through four stations in order. This page compares the work still to do (${plural(open, 'open piece')}) with the hours the team has before each delivery date.</p>
    <ol class="flow" aria-label="The four stations and their team">${flow}</ol>`;
}

function renderSelector({ deliveries }) {
  const chips = deliveries.map((d) => {
    const on = d.originalDate === state.selected, done = d.items ? d.finished / d.items : 1;
    return `<button class="chip ${on ? 'is-selected' : ''}" data-select="${d.originalDate}" data-light="${d.trafficLight}" aria-pressed="${on}" aria-label="${longDate(d.date)}, ${PLAIN[d.trafficLight]}">
      <span class="chip-date">${wdm(d.date)}${d.nonWorkingDay ? '*' : ''}</span>
      <span class="chip-state"><span class="sq"></span>${PLAIN[d.trafficLight]}</span>
      <span class="chip-bar"><i style="width:${Math.round(done * 100)}%"></i></span>
      <span class="chip-meta small">${d.finished}/${d.items} finished${d.moved ? ` · from ${dm(d.originalDate)}` : ''}</span>
    </button>`;
  }).join('');
  $('selector').innerHTML = `<span class="label selector-label">Choose a delivery</span><div class="chips">${chips}</div>`;
}

// ---------- selected delivery ----------
const sbars = {};
function buildStationBars() {
  $('sbars').innerHTML = `<span class="sbar-100" style="left:${100 / AXIS}%"><span class="label ink">100% of the hours</span></span>`;
  for (const s of STEPS) {
    const row = document.createElement('div');
    row.className = 'sbar';
    row.innerHTML = `
      <div class="sbar-top"><span class="sbar-name"><span class="label ink">${esc(labels[s])}</span><span class="small muted" data-r="team"></span></span><span class="sbar-right"><span class="label muted" data-r="was"></span><span class="sbar-pct num" data-r="pct"></span></span></div>
      <div class="sbar-track"><span class="sbar-plan" data-r="plan"></span><span class="sbar-fill" data-r="fill"></span><span class="sbar-over" data-r="over" style="left:${100 / AXIS}%"></span></div>
      <p class="small num" data-r="detail"></p>`;
    sbars[s] = Object.fromEntries([...row.querySelectorAll('[data-r]')].map((n) => [n.dataset.r, n]));
    $('sbars').insertBefore(row, $('sbars').lastElementChild);
  }
}

function renderFocus(d, plan) {
  const base = baseline.get(d.originalDate);
  const was = dirty() && base.trafficLight !== d.trafficLight ? base.trafficLight : '';
  const s = sentence(d);
  currentOptions = optionsFor(d);
  $('focus-head').innerHTML = `
    <div class="focus-top">
      <p class="label">Delivery · ${fmt(d.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}${d.moved ? ` · moved from ${dm(d.originalDate)}` : ''}</p>
      ${stateTag(d.trafficLight, was)}
    </div>
    <h2 class="focus-line">${esc(s.risk)}${s.cause ? ` <span class="cause">${esc(s.cause)}</span>` : ''}${s.decision ? ` ${esc(s.decision)}` : ''}</h2>
    ${currentOptions.length ? `<div class="try"><span class="label muted">Test an option</span>${currentOptions.map((o, k) => `<button class="btn ${k === 0 ? 'btn-primary' : ''}" data-try="${k}">${esc(o.label)}</button>`).join('')}</div>` : ''}`;

  const blocked = d.items - d.finished - d.ready;
  const missing = d.missingHoursTotal;
  const kpi = (k, v, sub, cls = '') => `<div class="kpi ${cls}"><span class="label muted">${k}</span><span class="kpi-v num">${v}</span><span class="small muted">${sub}</span></div>`;
  $('kpis').innerHTML = [
    kpi('Finished', `${d.finished}<span class="kpi-of">/${d.items}</span>`, `${d.items ? Math.round((d.finished / d.items) * 100) : 100}% of the pieces`),
    kpi('Ready to work', String(d.ready), 'materials and accessories in'),
    kpi('Blocked', String(blocked), 'waiting for materials or accessories', blocked ? 'is-warn' : ''),
    kpi('Working days left', String(d.workingDaysLeft), `until ${wdm(d.date)}`),
    kpi('Hours missing', missing > 0 ? hrs(missing) : '0', missing > 0 ? `across ${plural(short(d).length, 'station')}` : 'the team has enough hours', missing > 0 ? 'is-bad' : ''),
  ].join('');

  renderProgress(d);
  updateStationBars(d, plan);
  renderPieces(d);
}

function renderProgress(d) {
  const own = data.items.filter((i) => i.delivery === d.originalDate);
  const n = own.length;
  const counts = STAGES.map((st) => ({ ...st, count: own.filter((i) => i.currentStep === st.key).length }));
  const seg = counts.filter((c) => c.count).map((c) => `<span class="seg seg-${c.kind} seg-${c.key.replace(/[^a-z]/gi, '').toLowerCase()}" style="flex:${c.count}" title="${esc(c.label)}: ${c.count}"></span>`).join('');
  const cols = counts.map((c, k) => `
    <div class="stage ${c.count ? '' : 'is-empty'}">
      <span class="stage-key seg-${c.kind} seg-${c.key.replace(/[^a-z]/gi, '').toLowerCase()}"></span>
      <span class="stage-n num">${c.count}</span>
      <span class="small ${c.kind === 'wait' && c.count ? 'ink' : 'muted'}">${esc(c.label)}</span>
    </div>${k < counts.length - 1 ? '<span class="stage-arrow" aria-hidden="true">→</span>' : ''}`).join('');
  const waiting = counts.filter((c) => c.kind === 'wait').reduce((t, c) => t + c.count, 0);
  const done = counts.find((c) => c.kind === 'done').count;
  $('progress').innerHTML = `
    <div class="panel-head">
      <h3 class="panel-title">Where the pieces are today</h3>
      <p class="small muted">${n} pieces for ${wdm(d.date)}, by the step they are at. Left to right is the order of work.</p>
    </div>
    <div class="pbar" role="img" aria-label="${done} of ${n} finished">${seg}</div>
    <div class="pbar-scale small muted"><span>Not started</span><span><span class="ink strong">${n ? Math.round((done / n) * 100) : 100}% finished</span></span></div>
    <div class="stages">${cols}</div>
    ${waiting ? `<p class="small note"><span class="hatch"></span>${plural(waiting, 'piece')} cannot move on until materials or accessories arrive.</p>` : ''}`;
}

function updateStationBars(d, { capacity }) {
  const base = baseline.get(d.originalDate);
  const changed = dirty() && (JSON.stringify(base.usage) !== JSON.stringify(d.usage) || base.date !== d.date);
  $('cap-sub').textContent = `Work still to do in each station vs. the hours its team has until ${wdm(d.date)} (${plural(d.workingDaysLeft, 'working day')}). It includes earlier deliveries, because the same people must finish those first.`;
  const W = (u) => (Math.min(Number.isFinite(u) ? u : AXIS, AXIS) / AXIS) * 100;
  for (const s of STEPS) {
    const r = sbars[s], u = d.usage[s], bu = base.usage[s], moved = changed && bu !== u, dp = sc().people[s] || 0;
    r.team.textContent = `${people(capacity[s].people)}${dp ? ` (${dp > 0 ? '+' : '−'}${Math.abs(dp)})` : ''}${sc().overtime[s] ? ` · +${sc().overtime[s]}${NBSP}h overtime` : ''}`;
    r.was.textContent = moved ? `was ${p(bu)}` : '';
    r.pct.textContent = p(u);
    r.pct.className = `sbar-pct num ${tone(u)}`;
    r.plan.hidden = !moved;
    r.plan.style.width = `${W(bu)}%`;
    r.fill.style.width = `${W(Math.min(u, 1))}%`;
    r.over.style.width = `${Math.max(0, W(u) - W(1))}%`;
    const miss = d.missingHours[s];
    r.detail.innerHTML = `${hrs(d.hoursNeededCumulative[s])} of work / ${hrs(d.hoursAvailable[s])} available${miss > 0 ? ` · <span class="red strong">${hrs(miss)} short</span>` : ` · <span class="muted">${hrs(d.hoursAvailable[s] - d.hoursNeededCumulative[s])} to spare</span>`}`;
  }
  $('cap-foot').textContent = 'Optimistic: assumes the four stations work in parallel the whole time. See the notes at the bottom.';
}

function statusOf(b) {
  if (b.readyToWork) return 'Ready';
  if (b.waitingMaterials && b.waitingAccessories) return 'Waiting for materials and accessories';
  return b.waitingMaterials ? 'Waiting for materials' : 'Waiting for accessories';
}

function renderPieces(d) {
  const rows = blockers(data, d.originalDate, d.bottleneck);
  const shown = state.showAllPieces ? rows : rows.slice(0, PIECES_VISIBLE);
  const ready = rows.filter((r) => r.readyToWork).length;
  const b = labels[d.bottleneck];
  $('pieces').innerHTML = `
    <div class="panel-head pieces-head">
      <h3 class="panel-title">Open pieces for ${dm(d.originalDate)} · ${rows.length}</h3>
      ${rows.length ? `<p class="small muted">Heaviest in ${esc(b)} first · ${ready} ready to work</p>` : ''}
    </div>
    ${rows.length ? `<table class="pieces">
      <thead><tr><th class="label muted">Piece</th><th class="label muted">Category</th><th class="label muted">Step</th><th class="label muted">Status</th><th class="label muted r">${esc(b)} h</th><th class="label muted r">Total h</th></tr></thead>
      <tbody>${shown.map((r) => `<tr>
        <td class="ink piece">${esc(r.item)}</td><td>${esc(r.category)}</td><td>${esc(r.currentStep)}</td>
        <td><span class="pill ${r.readyToWork ? 'is-ready' : 'is-wait'}">${statusOf(r)}</span>${r.dataIssues.length ? `<span class="flag small muted">PLM: ${esc(r.dataIssues.join(', '))}</span>` : ''}</td>
        <td class="r num">${h1(r.hoursAtBottleneck)}</td><td class="r num">${h1(r.hoursToDoTotal)}</td></tr>`).join('')}</tbody>
    </table>
    ${rows.length > PIECES_VISIBLE ? `<button class="link more" data-action="toggle-pieces">${state.showAllPieces ? 'Show fewer' : `Show all ${rows.length} pieces`}</button>` : ''}`
    : '<p class="small">Every piece is assembled.</p>'}`;
}

// ---------- all deliveries ----------
function renderOverview({ deliveries }) {
  const counts = ['RED', 'LATE', 'AMBER', 'GREEN', 'DONE'].map((k) => [k, deliveries.filter((d) => d.trafficLight === k).length]).filter(([, n]) => n);
  const rows = deliveries.map((d) => {
    const base = baseline.get(d.originalDate), done = d.items ? d.finished / d.items : 1, on = d.originalDate === state.selected;
    const was = dirty() && base.trafficLight !== d.trafficLight ? base.trafficLight : '';
    const W = Math.min(Number.isFinite(d.maxUsage) ? d.maxUsage : AXIS, AXIS) / AXIS * 100;
    return `<button class="orow ${on ? 'is-selected' : ''}" data-select="${d.originalDate}" role="row">
      <span class="o-date" role="cell"><span class="ink strong">${wdm(d.date)}${d.nonWorkingDay ? '*' : ''}</span>${d.moved ? `<span class="small muted">from ${dm(d.originalDate)}</span>` : ''}</span>
      <span role="cell">${stateTag(d.trafficLight, was)}</span>
      <span class="num" role="cell">${d.items}</span>
      <span class="o-prog" role="cell"><span class="mbar"><i style="width:${Math.round(done * 100)}%"></i></span><span class="num small">${Math.round(done * 100)}%</span></span>
      <span class="o-load" role="cell"><span class="mbar mbar-load"><i style="width:${Math.min(W, 100 / AXIS)}%"></i><b style="left:${100 / AXIS}%;width:${Math.max(0, W - 100 / AXIS)}%"></b><s style="left:${100 / AXIS}%"></s></span><span class="num small ${tone(d.maxUsage)}">${d.trafficLight === 'DONE' ? '—' : p(d.maxUsage)}</span></span>
      <span class="small" role="cell">${d.trafficLight === 'DONE' ? '—' : esc(labels[d.bottleneck])}</span>
      <span class="num ${d.missingHoursTotal > 0 ? 'red strong' : 'muted'}" role="cell">${d.missingHoursTotal > 0 ? hrs(d.missingHoursTotal) : '—'}</span>
    </button>`;
  }).join('');
  const nwd = deliveries.filter((d) => d.nonWorkingDay);
  $('overview').innerHTML = `
    <div class="block-head"><span class="section">All deliveries</span><span class="label muted">${counts.map(([k, n]) => `${n} ${PLAIN[k].toLowerCase()}`).join(' · ')}</span></div>
    <h2 class="sim-title">How every delivery looks today.</h2>
    <div class="otable" role="table" aria-label="All deliveries">
      <div class="orow ohead" role="row">
        <span class="label muted" role="columnheader">Delivery</span><span class="label muted" role="columnheader">Status</span><span class="label muted" role="columnheader">Pieces</span>
        <span class="label muted" role="columnheader">Finished</span><span class="label muted" role="columnheader">Busiest station load</span><span class="label muted" role="columnheader">Busiest station</span><span class="label muted" role="columnheader">Hours missing</span>
      </div>
      ${rows}
    </div>
    <p class="small muted footnote">Click a row to open it at the top. Load over 100% (in red) means the station needs more hours than its team has.${nwd.length ? ` * ${nwd.map((n) => (n.nonWorkingDay === 'Saturday' || n.nonWorkingDay === 'Sunday' ? `${dm(n.date)} is a ${n.nonWorkingDay}.` : `${dm(n.date)} is a public holiday (${n.nonWorkingDay}).`)).join(' ')} Confirm the real dates with planning.` : ''}</p>`;
}

// ---------- simulator: built once, values updated on every change ----------
function buildSim() {
  $('stations').innerHTML = STEPS.map((s, k) => `
    <div class="scard" id="scard-${s}">
      <div class="scard-top"><span class="flow-num">${k + 1}</span><span class="flow-name">${esc(labels[s])}</span></div>
      <p class="small muted">${esc(STATION_INFO[s])}</p>
      <div class="people-row big" id="pi-${s}"></div>
      <div class="stepper">
        <span class="small ink">People</span>
        <span class="step-ctl"><button class="sbtn" data-step="people" data-s="${s}" data-d="-1" aria-label="One person fewer in ${esc(labels[s])}">−</button><span class="step-v num" id="pp-${s}"></span><button class="sbtn" data-step="people" data-s="${s}" data-d="1" aria-label="One more person in ${esc(labels[s])}">+</button></span>
      </div>
      <div class="stepper">
        <span class="small ink">Overtime per person</span>
        <span class="step-ctl"><button class="sbtn" data-step="overtime" data-s="${s}" data-d="-1" aria-label="Less overtime in ${esc(labels[s])}">−</button><span class="step-v num" id="ot-${s}"></span><button class="sbtn" data-step="overtime" data-s="${s}" data-d="1" aria-label="More overtime in ${esc(labels[s])}">+</button></span>
      </div>
      <p class="small scard-eff" id="eff-${s}"></p>
    </div>`).join('');
  $('move').innerHTML = `
    <div class="scard move-card">
      <div class="scard-top"><span class="flow-name">Move a delivery</span></div>
      <p class="small muted">Give a delivery more working days. Later deliveries keep their place.</p>
      <div class="move-row">
        <select id="move-target" class="select" aria-label="Delivery to move">
          ${basePlan.deliveries.map((d) => `<option value="${d.originalDate}">${wdm(d.originalDate)}</option>`).join('')}
        </select>
        <span class="step-ctl"><button class="sbtn" data-step="shift" data-d="-1" aria-label="One working day earlier">−</button><span class="step-v num wide" id="shift-v"></span><button class="sbtn" data-step="shift" data-d="1" aria-label="One working day later">+</button></span>
      </div>
      <p class="small" id="shift-note"></p>
    </div>`;
  $('move-target').addEventListener('change', (e) => { state.moveTarget = e.target.value; render(); });
}

function step(kind, s, dir) {
  if (kind === 'people') {
    const base = data.config.people[s], now = Math.max(0, base + (sc().people[s] || 0));
    const next = Math.min(MAX_PEOPLE[s], Math.max(0, now + dir));
    sc().people[s] = next - base;
  } else if (kind === 'overtime') {
    const now = sc().overtime[s] || 0;
    const next = dir > 0 ? Math.floor(now / OT_STEP + 1e-9) * OT_STEP + OT_STEP : Math.ceil(now / OT_STEP - 1e-9) * OT_STEP - OT_STEP;
    sc().overtime[s] = Math.min(MAX_OVERTIME, Math.max(0, Math.round(next * 10) / 10));
  } else if (kind === 'shift') {
    const t = state.moveTarget, n = Math.min(MAX_SHIFT, Math.max(0, shiftOf(t) + dir));
    setShift(t, shiftDate(t, n));
  }
}

function syncSim({ capacity, deliveries }, sel) {
  const base = baseline.get(sel.originalDate);
  for (const s of STEPS) {
    const b = data.config.people[s], dp = sc().people[s] || 0, n = capacity[s].people, ot = sc().overtime[s] || 0;
    $(`pi-${s}`).innerHTML = icons(n, dp);
    $(`pi-${s}`).setAttribute('aria-label', people(n));
    $(`pp-${s}`).textContent = String(n);
    $(`ot-${s}`).textContent = `${ot}${NBSP}h`;
    $(`scard-${s}`).classList.toggle('is-changed', Boolean(dp || ot));
    document.querySelector(`[data-step="people"][data-s="${s}"][data-d="-1"]`).disabled = n <= 0;
    document.querySelector(`[data-step="people"][data-s="${s}"][data-d="1"]`).disabled = n >= MAX_PEOPLE[s];
    document.querySelector(`[data-step="overtime"][data-s="${s}"][data-d="-1"]`).disabled = ot <= 0;
    document.querySelector(`[data-step="overtime"][data-s="${s}"][data-d="1"]`).disabled = ot >= MAX_OVERTIME;
    const u = sel.usage[s], bu = base.usage[s];
    const eff = sel.trafficLight === 'DONE' ? `${wdm(sel.date)} is finished.` : `For ${wdm(sel.date)}: <span class="num strong ${tone(u)}">${p(u)}</span> of its hours${dirty() && bu !== u ? ` <span class="muted">(was ${p(bu)})</span>` : ''}`;
    $(`eff-${s}`).innerHTML = `${hrs(capacity[s].hoursPerDay)} a day${b !== n || ot ? ` <span class="muted">(plan ${hrs(data.config.people[s] * data.config.hoursPerPerson)})</span>` : ''} · ${eff}`;
  }
  const t = state.moveTarget, n = shiftOf(t), date = sc().dateShifts[t] || t;
  $('move-target').value = t;
  $('shift-v').textContent = n ? `+${n} days · ${wdm(date)}` : `stays ${wdm(t)}`;
  document.querySelector('[data-step="shift"][data-d="-1"]').disabled = n <= 0;
  document.querySelector('[data-step="shift"][data-d="1"]').disabled = n >= MAX_SHIFT;

  // Earliest date is measured from the original date, with every other lever as it is now.
  const others = { ...sc(), dateShifts: { ...sc().dateShifts } };
  delete others.dateShifts[t];
  const row = computePlan(data, others).deliveries.find((d) => d.originalDate === t);
  let note;
  if (row.trafficLight !== 'RED') note = baseline.get(t).trafficLight === 'RED' ? `${wdm(t)} is no longer at risk. No need to move it.` : `${wdm(t)} is not at risk. No need to move it.`;
  else {
    const r = earliestFeasibleDate(data, others, t);
    note = r ? `Earliest date without risk: ${wdm(r.date)} (+${r.workingDaysAdded} working days).` : 'No date in the next 90 days removes the risk.';
  }
  $('shift-note').textContent = note;
}

function renderPreview({ deliveries }, sel) {
  const reds = deliveries.filter(isRisk), baseReds = basePlan.deliveries.filter(isRisk);
  let line;
  if (!dirty()) line = `<p class="preview-line muted">Nothing changed yet. Add a person, some overtime, or press “Test an option” above to see the effect here.</p>`;
  else {
    const ph = changePhrases(), subject = ph.length <= 2 ? cap(list(ph)) : `These ${ph.length} changes`, one = ph.length === 1;
    const baseSel = baseline.get(sel.originalDate);
    let s1 = '';
    if (isRisk(baseSel)) s1 = isRisk(sel) ? `${subject} ${one ? 'does' : 'do'} not save ${dMonth(sel.date)} yet.` : `${subject} ${one ? 'saves' : 'save'} ${dMonth(sel.date)}.`;
    const others = reds.filter((d) => d.originalDate !== sel.originalDate);
    const s2 = !reds.length ? 'No delivery is at risk.' : others.length ? `${list(others.map((d) => dm(d.date)))} ${others.length === 1 ? 'is' : 'are'} still at risk.` : '';
    line = `<p class="preview-line">${esc([s1, s2].filter(Boolean).join(' ') || `${subject} ${one ? 'changes' : 'change'} the plan.`)}</p>`;
  }
  const rows = deliveries.map((d) => {
    const b = baseline.get(d.originalDate), changed = dirty() && b.trafficLight !== d.trafficLight;
    return `<div class="pv-row ${d.originalDate === sel.originalDate ? 'is-selected' : ''}"><span class="small ink">${wdm(d.date)}</span><span class="pv-states">${changed ? `<span class="pv-was" data-light="${b.trafficLight}"><span class="sq"></span>${PLAIN[b.trafficLight]}</span><span class="muted">→</span>` : ''}<span class="pv-now st-text" data-light="${d.trafficLight}"><span class="sq"></span>${PLAIN[d.trafficLight]}</span></span></div>`;
  }).join('');
  const missingNow = deliveries.reduce((t, d) => Math.max(t, d.missingHoursTotal), 0);
  const missingBase = basePlan.deliveries.reduce((t, d) => Math.max(t, d.missingHoursTotal), 0);
  const cmp = [
    ['Deliveries at risk', String(baseReds.length), String(reds.length)],
    ['Largest gap in hours', hrs(missingBase), hrs(missingNow)],
    ['People added', '0', `${netPeople() > 0 ? '+' : ''}${netPeople()}`],
  ];
  $('preview').innerHTML = `
    <div class="preview-head"><span class="label ink">${dirty() ? 'Scenario' : "Today's plan"}</span>${dirty() ? `<button class="link small" data-action="reset">Reset to plan</button>` : ''}</div>
    ${dirty() ? `<p class="small muted pv-changes">${esc(changes().join(' · '))}</p>` : ''}
    ${line}
    <dl class="cmp">${cmp.map(([k, a, b]) => `<div><dt>${esc(k)}</dt><dd class="num">${dirty() ? `<span class="cmp-plan">${a} →</span> ${b}` : b}</dd></div>`).join('')}</dl>
    <p class="label muted pv-head">Every delivery</p>
    <div class="pv-list">${rows}</div>`;
}

// ---------- notes ----------
function renderNotes({ warnings }) {
  const w = warnings, b = w.blockedCountedAsWorkable;
  const dates = w.nonWorkingDeliveries.map((n) => (n.reason === 'Saturday' || n.reason === 'Sunday' ? `${dm(n.date)} is a ${n.reason}` : `${dm(n.date)} is a public holiday (${n.reason})`));
  const glossary = [
    ['Load', 'Work still to do in a station ÷ the hours its team has until the date. Under 85%: on track. 85–100%: tight. Over 100%: at risk.'],
    ['Hours missing', 'How many more hours a station would need to finish on time.'],
    ['Ready to work', 'The materials and the accessories have arrived, so the piece can go through every station.'],
    ['Earlier deliveries count', 'The same people make every delivery, so the work of earlier dates is added before each one.'],
  ];
  const notes = [
    dates.length ? `${list(dates)}. Confirm the real delivery dates with planning.` : '',
    `${b.withoutMaterials} pieces without materials and ${b.withoutAccessories} without accessories are counted as workable, as in the Excel.`,
    'Extra people assumes trained artisans available from tomorrow at full speed.',
    `${w.plmIssues.length} pieces have inconsistent PLM data, for example assembled without accessories. They are flagged in the piece list.`,
    'The four stations are assumed to work in parallel. A piece cannot reach Assembly before the earlier steps, so the real risk is higher.',
    'Difficulty comes from the category (small leather goods easy, bags medium, luggage hard), not from the piece.',
  ].filter(Boolean);
  $('notes').innerHTML = `
    <div class="block-head"><span class="section">How to read this page</span></div>
    <dl class="gloss">${glossary.map(([k, v]) => `<div><dt class="label ink">${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
    <div class="block-head notes-head"><span class="section">Data notes and assumptions</span></div>
    <div class="notes">${notes.map((x) => `<p>${esc(x)}</p>`).join('')}</div>`;
}

// ---------- interaction ----------
function select(orig) {
  state.selected = orig;
  state.moveTarget = orig;
  state.showAllPieces = false;
}

const smooth = () => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

document.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t || t.disabled) return;
  if (t.dataset.select) {
    select(t.dataset.select);
    render();
    if (t.classList.contains('orow')) $('focus').scrollIntoView({ behavior: smooth(), block: 'start' });
    return;
  }
  if (t.dataset.try) {
    applyOption(currentOptions[Number(t.dataset.try)].apply);
    render();
    $('simulator').scrollIntoView({ behavior: smooth() });
    return;
  }
  if (t.dataset.step) step(t.dataset.step, t.dataset.s, Number(t.dataset.d));
  else if (t.dataset.action === 'reset') state.scenario = emptyScenario();
  else if (t.dataset.action === 'toggle-pieces') state.showAllPieces = !state.showAllPieces;
  else return;
  render();
});

document.addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(e.key) || e.target.closest('input, select, textarea') || $('view-overview').hidden) return;
  const order = computePlan(data, sc()).deliveries.map((d) => d.originalDate);
  const k = order.indexOf(state.selected) + (e.key === 'ArrowRight' ? 1 : -1);
  if (k < 0 || k >= order.length) return;
  e.preventDefault();
  select(order[k]);
  render();
});

// ---------- boot ----------
(async () => {
  data = await (await fetch(DATA_URL)).json();
  labels = Object.fromEntries(data.config.steps.map((s) => [s.key, s.label]));
  basePlan = computePlan(data);
  baseline = new Map(basePlan.deliveries.map((d) => [d.originalDate, d]));
  // Open on the next delivery that is not finished yet (the user picks any other one at the top).
  const next = basePlan.deliveries.find((d) => d.trafficLight !== 'DONE' && d.date >= data.config.today) || basePlan.deliveries[0];
  select(next.originalDate);
  buildStationBars();
  buildSim();
  renderDemoNote();
  renderNotes(basePlan);
  render();
})();
