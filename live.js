import { computePlan, pct, STEPS } from './engine.js';
import { createLine, tick, dayOf, clockOf, queueOf, setPeople, snapshot, DAY_HOURS } from './live-sim.js';

// Live line tab: the workshop as it runs, station by station, as if the page were connected to the PLM.
// In this demo the feed is simulated from the PLM snapshot (live-sim.js); the forecast reuses engine.js.
const DATA_URL = './data/demo-data.json';
const SPEEDS = [{ x: 60, label: '1 min/s' }, { x: 600, label: '10 min/s' }, { x: 3600, label: '1 h/s' }];
const MAX_PEOPLE = { cad: 4, cutting: 6, preparation: 6, assembly: 8 };
const SQUARES = 48;     // pieces drawn per queue, the rest as "+N"
const FEED = 14;        // events shown
const PAINT_MS = 250;   // repaint at most 4 times a second

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (iso, opts) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...opts }).format(new Date(iso + 'T00:00:00Z'));
const dm = (iso) => fmt(iso, { day: 'numeric', month: 'short' });
const wdm = (iso) => fmt(iso, { weekday: 'short', day: 'numeric', month: 'short' });
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const PLAIN = { GREEN: 'On track', AMBER: 'Tight', RED: 'At risk', LATE: 'Late', DONE: 'Done' };
const stateTag = (light) => `<span class="state" data-light="${light}"><span class="sq"></span><span class="label">${light}</span><span class="plain">${PLAIN[light]}</span></span>`;
const WAIT = { materials: 'Waiting for materials', accessories: 'Waiting for accessories' };

let data, labels, line, plan;
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
  plan = computePlan(snapshot(line));
  for (const d of plan.deliveries) live.lights.set(d.originalDate, d.trafficLight);
  if (live.built) { paintPeople(); paint(true); }
}

// ---------- what the line looks like now ----------
function station(s) {
  const ws = line.workers[s];
  const busy = ws.filter((w) => w.piece !== null);
  const queue = queueOf(line, s);
  const inWork = busy.reduce((t, w) => t + line.pieces[w.piece - 1].left[s], 0);
  const queued = queue.reduce((t, p) => t + p.left[s], 0);
  const days = ws.length ? (inWork + queued) / (ws.length * DAY_HOURS) : Infinity;
  const today = Math.floor(line.t / DAY_HOURS + 1e-9) * DAY_HOURS;
  const doneToday = line.events.filter((e) => e.station === s && e.t >= today).length;
  return { ws, busy, queue, queued, days, doneToday };
}
const nextOpen = () => plan.deliveries.find((d) => d.trafficLight !== 'DONE' && d.date >= dayOf(line)) || plan.deliveries.find((d) => d.trafficLight !== 'DONE');
const risky = () => new Set(plan.deliveries.filter((d) => d.trafficLight === 'RED' || d.trafficLight === 'LATE').map((d) => d.originalDate));
const daysTone = (d) => (d > 3 ? 'is-red' : d > 1.5 ? 'is-amber' : '');
const daysText = (d) => (Number.isFinite(d) ? `${d.toFixed(1)} days` : 'nobody here');

// Alerts a supervisor would want pushed, each said once until the situation changes.
function watch() {
  plan = computePlan(snapshot(line));
  for (const d of plan.deliveries) {
    const was = live.lights.get(d.originalDate);
    if (was && was !== d.trafficLight) {
      line.events.push({ t: line.t, kind: d.trafficLight === 'RED' || d.trafficLight === 'LATE' ? 'alert' : 'good', text: `Delivery ${dm(d.originalDate)} turned ${d.trafficLight} · ${PLAIN[d.trafficLight].toLowerCase()}` });
    }
    live.lights.set(d.originalDate, d.trafficLight);
  }
  for (const s of STEPS) {
    const st = station(s);
    const key = `q:${s}`;
    if (st.days > 3 && !live.alerts.has(key)) { live.alerts.add(key); line.events.push({ t: line.t, kind: 'alert', text: `${labels[s]} queue above 3 days of work` }); }
    if (st.days < 2) live.alerts.delete(key);
    const idle = st.ws.length - st.busy.length, ikey = `i:${s}:${dayOf(line)}`;
    if (idle > 0 && !st.queue.length && !live.alerts.has(ikey) && line.pieces.some((p) => STAGES_BEFORE[s].includes(p.stage))) {
      live.alerts.add(ikey);
      line.events.push({ t: line.t, kind: 'warn', text: `${labels[s]}: ${plural(idle, 'person', 'people')} idle, no piece ready` });
    }
  }
}
const STAGES_BEFORE = { cad: [], cutting: ['cad', 'materials'], preparation: ['cad', 'materials', 'cutting'], assembly: ['cad', 'materials', 'cutting', 'preparation', 'accessories'] };

// ---------- build once (buttons stay put while the numbers change) ----------
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
      <div class="lc-team">
        <span class="people-row big" id="lc-people-${s}"></span>
        <span class="lc-step">
          <button class="sbtn" data-live-people="${s}" data-d="-1" aria-label="One person fewer in ${esc(labels[s])}">−</button>
          <button class="sbtn" data-live-people="${s}" data-d="1" aria-label="One more person in ${esc(labels[s])}">+</button>
        </span>
      </div>
      <div class="lc-body" id="lc-body-${s}"></div>
    </article>`;
  const wait = (w) => `
    <article class="lw" data-wait="${w}">
      <span class="label">${WAIT[w]}</span>
      <div id="lw-body-${w}"></div>
    </article>`;
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
    <section class="line" aria-label="The production line now">
      ${card('cad', 0)}<span class="larrow" aria-hidden="true">→</span>${wait('materials')}<span class="larrow" aria-hidden="true">→</span>
      ${card('cutting', 1)}<span class="larrow" aria-hidden="true">→</span>${card('preparation', 2)}<span class="larrow" aria-hidden="true">→</span>
      ${wait('accessories')}<span class="larrow" aria-hidden="true">→</span>${card('assembly', 3)}<span class="larrow" aria-hidden="true">→</span>
      <article class="lw lw-done"><span class="label">Finished</span><div id="lw-body-done"></div></article>
    </section>
    <p class="small muted lkey"><span class="sqk is-risk"></span> piece of a delivery at risk <span class="sqk"></span> other piece <span class="pi is-busy"></span> working <span class="pi is-idle"></span> free</p>
    <div class="lgrid">
      <section class="panel">
        <div class="panel-head"><h3 class="panel-title">What is happening</h3><p class="small muted">Status changes as the PLM would send them, newest first.</p></div>
        <ol class="feed" id="live-feed"></ol>
      </section>
      <section class="panel">
        <div class="panel-head"><h3 class="panel-title">Deliveries, forecast now</h3><p class="small muted">Same rules as the overview, recalculated with every change on the line.</p></div>
        <div id="live-del"></div>
      </section>
    </div>
    <section class="block" aria-label="How the live line works">
      <div class="block-head"><span class="section">How it would connect to the PLM</span></div>
      <div class="notes">
        <p>Each status change in the PLM (pattern done, materials in, cut, prepared, accessories in, assembled) is an event. Connected, the page would receive those events and update in seconds, with no download.</p>
        <p>In this demo the feed is simulated: it starts from the PLM snapshot and each person works the next piece of their station, earliest delivery first, for its standard hours. Material and accessory arrivals are assumed (half a day to four days).</p>
        <p>Use + and − to move people between stations while the line runs: the queues, the alerts and the delivery forecast react at once.</p>
        <p>Next step with real data: measured times per piece replace the standard times, so the forecast learns from the workshop.</p>
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
}
function paintPeople() {
  for (const s of STEPS) {
    const n = line.workers[s].length;
    document.querySelectorAll(`[data-live-people="${s}"]`).forEach((b) => {
      b.disabled = Number(b.dataset.d) < 0 ? n <= 0 : n >= MAX_PEOPLE[s];
    });
  }
}

function squares(ps, risk) {
  const shown = ps.slice(0, SQUARES).map((p) => `<i class="sqk ${risk.has(p.delivery) ? 'is-risk' : ''}" title="${esc(p.name)} · ${dm(p.delivery)}"></i>`).join('');
  return `<span class="sqs">${shown}${ps.length > SQUARES ? `<span class="small muted">+${ps.length - SQUARES}</span>` : ''}</span>`;
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
  const people = STEPS.reduce((t, s) => t + stations[s].ws.length, 0);
  const busy = STEPS.reduce((t, s) => t + stations[s].busy.length, 0);
  const waiting = line.pieces.filter((p) => p.stage === 'materials' || p.stage === 'accessories').length;
  const done = line.pieces.filter((p) => p.stage === 'done').length;
  const kpi = (v, label, sub = '', cls = '') => `<div class="kpi ${cls}"><span class="label muted">${label}</span><span class="kpi-v num">${v}</span><span class="small muted">${sub}</span></div>`;
  $('live-kpis').innerHTML = [
    kpi(finishedToday, 'Finished today', `${done} of ${line.pieces.length} pieces finished in total`),
    kpi(`${busy}<span class="kpi-of">/${people}</span>`, 'People working now', busy < people ? `${plural(people - busy, 'person', 'people')} without a piece ready` : 'Everyone has a piece'),
    kpi(waiting, 'Waiting for suppliers', 'materials or accessories'),
    next ? kpi(dm(next.date), 'Next delivery', `${plural(next.items - next.finished, 'piece')} open · ${plural(next.workingDaysLeft, 'working day')} left`, next.trafficLight === 'RED' || next.trafficLight === 'LATE' ? 'is-bad' : next.trafficLight === 'AMBER' ? 'is-warn' : '') : kpi('—', 'Next delivery'),
    kpi(`${plan.deliveries.filter((d) => risk.has(d.originalDate)).length}<span class="kpi-of">/${plan.deliveries.length}</span>`, 'Deliveries at risk', 'forecast with the line as it is now', risk.size ? 'is-bad' : ''),
  ].join('');

  for (const s of STEPS) {
    const st = stations[s];
    $(`lc-light-${s}`).innerHTML = `<span class="lc-days ${daysTone(st.days)}">${daysText(st.days)} of work</span>`;
    $(`lc-people-${s}`).innerHTML = st.ws.map((x) => `<i class="pi ${x.piece !== null ? 'is-busy' : 'is-idle'}"></i>`).join('') || '<span class="small muted">Nobody</span>';
    const now = st.busy.map((x) => {
      const p = line.pieces[x.piece - 1];
      const done = p.std[s] > 0 ? Math.min(1, 1 - p.left[s] / p.std[s]) : 1;
      return `<li class="lnow ${risk.has(p.delivery) ? 'is-risk' : ''}"><span class="lnow-top"><span class="ink">${esc(p.name)}</span><span class="small muted num">${dm(p.delivery)}</span></span><span class="lprog"><i style="width:${Math.round(done * 100)}%"></i></span></li>`;
    }).join('');
    $(`lc-body-${s}`).innerHTML = `
      <p class="label muted">Working on</p>
      <ol class="lnows">${now || '<li class="small muted">No piece ready</li>'}</ol>
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

  $('live-feed').innerHTML = line.events.slice(-FEED).reverse().map((e) => `
    <li class="fe fe-${e.kind}"><span class="num muted">${e.kind === 'day' ? '' : `${wdm(dayOf(line, e.t))} ${clockOf(e.t)}`}</span><span>${esc(e.text)}</span></li>`).join('') || '<li class="small muted">The line just started. Events appear here.</li>';

  $('live-del').innerHTML = plan.deliveries.map((d) => {
    const share = d.items ? d.finished / d.items : 0;
    return `<div class="ldel ${next && d.originalDate === next.originalDate ? 'is-next' : ''}">
      <span class="ink num">${wdm(d.date)}</span>${stateTag(d.trafficLight)}
      <span class="chip-bar" aria-label="${d.finished} of ${d.items} finished"><i style="width:${Math.round(share * 100)}%"></i></span>
      <span class="small muted num">${d.finished}/${d.items} · ${d.trafficLight === 'DONE' ? 'all finished' : d.trafficLight === 'LATE' ? `${d.items - d.finished} still open` : `${esc(labels[d.bottleneck])} ${Number.isFinite(d.usage[d.bottleneck]) ? pct(d.usage[d.bottleneck]) + '%' : '—'}`}</span>
    </div>`;
  }).join('');
}

// ---------- interaction ----------
document.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t || t.disabled || !line) return;
  if (t.dataset.live === 'toggle') play(!live.playing);
  else if (t.dataset.live === 'restart') restart();
  else if (t.dataset.liveSpeed) { live.speed = Number(t.dataset.liveSpeed); paintControls(); }
  else if (t.dataset.livePeople) {
    const s = t.dataset.livePeople;
    setPeople(line, s, line.workers[s].length + Number(t.dataset.d));
    line.events.push({ t: line.t, kind: 'team', text: `${labels[s]} now has ${plural(line.workers[s].length, 'person', 'people')}` });
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
