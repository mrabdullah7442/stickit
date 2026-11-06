// Stickit: twist the dial to say when, stick the task, and your phone rings on time.
(() => {
  "use strict";

  const KEY = "stickit.v1";
  const SNOOZE_MIN = 10;
  const SPAN_MIN = 720;               // the dial shows the next twelve hours
  const NTFY = "https://ntfy.sh";
  const NTFY_MAX_MS = 3 * 24 * 3600e3 - 60e3;
  const $ = (id) => document.getElementById(id);
  const SVGNS = "http://www.w3.org/2000/svg";
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  const els = {
    list: $("list"), tpl: $("sticker-tpl"), empty: $("sheet-empty"), count: $("sheet-count"),
    doneWrap: $("done-wrap"), doneList: $("done-list"), clearDone: $("clear-done"),
    form: $("add-form"), name: $("add-name"), when: $("add-when"), start: $("add-start"),
    dial: $("dial"), hit: $("dial-hit"), ticks: $("dial-ticks"), pins: $("dial-pins"), sweep: $("dial-sweep"),
    handle: $("dial-handle"), arm: $("dial-arm"), knob: $("dial-knob"),
    nextLabel: $("next-label"), nextBig: $("next-big"), nextSub: $("next-sub"),
    runLabel: $("run-label"), runClock: $("run-clock"), runName: $("run-name"),
    setBig: $("set-big"), setAt: $("set-at"),
    runbar: $("runbar"), runPause: $("run-pause"), runDone: $("run-done"),
    total: $("today-total"), sound: $("sound-toggle"), toasts: $("toasts"), storageError: $("storage-error"),
    phone: $("phone"), phoneState: $("phone-state"), phoneTopic: $("phone-topic"), phoneCopy: $("phone-copy"),
    phoneTest: $("phone-test"), phoneOn: $("phone-on"), phoneNew: $("phone-new"),
  };

  // ---------- state ----------
  let state = { tasks: [], lastId: null, sound: true, phone: { on: false, topic: "" } };
  let storageOk = true;
  let pendingMin = 0;     // the ring being dialled, in minutes from now
  let dragging = false;

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) state = Object.assign(state, JSON.parse(raw));
    } catch { storageOk = false; }
    state.phone = Object.assign({ on: false, topic: "" }, state.phone);
    if (!state.phone.topic) state.phone.topic = newTopic();
    state.tasks.forEach((t, i) => { if (t.tilt == null) t.tilt = tiltFor(i); if (!t.sessions) t.sessions = []; });
  }
  function save() {
    if (!storageOk) return;
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { storageOk = false; els.storageError.hidden = false; }
  }
  function newTopic() {
    const abc = "abcdefghijkmnpqrstuvwxyz23456789", b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return "stickit-" + [...b].map((x) => abc[x % abc.length]).join("");
  }

  const uid = () => Math.random().toString(36).slice(2, 10);
  const byId = (id) => state.tasks.find((t) => t.id === id);
  const running = () => state.tasks.find((t) => t.runningSince);
  const open = () => state.tasks.filter((t) => !t.done);
  const tiltFor = (i) => [-1.6, 1.2, -0.8, 1.8, -1.2, 0.8][i % 6];

  function tracked(t, now = Date.now()) {
    let ms = 0;
    for (const s of t.sessions) ms += s.end - s.start;
    if (t.runningSince) ms += now - t.runningSince;
    return ms;
  }
  function trackedToday(now = Date.now()) {
    const midnight = new Date(now).setHours(0, 0, 0, 0);
    let ms = 0;
    for (const t of state.tasks) {
      const spans = t.sessions.slice();
      if (t.runningSince) spans.push({ start: t.runningSince, end: now });
      for (const s of spans) if (s.end > midnight) ms += s.end - Math.max(s.start, midnight);
    }
    return ms;
  }

  // ---------- formatting ----------
  const pad = (n) => String(n).padStart(2, "0");
  function clock(ms, forceHours = false) {
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h || forceHours ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  }
  function spoken(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s} s`;
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h ? `${h} h ${pad(m)} min` : `${m} min`;
  }
  function untilShort(min) {
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60), m = min % 60;
    return m ? `${h}h ${pad(m)}` : `${h} hr`;
  }
  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  function whenLabel(ts) {
    const d = new Date(ts), today = new Date();
    const tomorrow = new Date(); tomorrow.setDate(today.getDate() + 1);
    const t = timeFmt.format(d);
    if (d.toDateString() === today.toDateString()) return t;
    if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow ${t}`;
    return d.toLocaleDateString(undefined, { weekday: "short" }) + " " + t;
  }
  const ringTime = (min) => { const d = new Date(Date.now() + min * 60000); d.setSeconds(0, 0); return d.getTime(); };

  // ---------- sound (synthesised, no files) ----------
  let ctx = null;
  function audio() {
    if (!state.sound) return null;
    try { ctx = ctx || new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }
  function tone(freq, start, dur, type = "sine", vol = 0.18, slideTo) {
    const a = audio(); if (!a) return;
    const o = a.createOscillator(), g = a.createGain(), t0 = a.currentTime + start;
    o.type = type; o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(a.destination); o.start(t0); o.stop(t0 + dur + 0.02);
  }
  let lastClick = 0;
  const sfx = {
    ratchet: (onHour) => {
      const now = performance.now(); if (now - lastClick < 28) return; lastClick = now;
      tone(onHour ? 2400 : 3200, 0, 0.018, "square", onHour ? 0.06 : 0.035);
      if (navigator.vibrate) navigator.vibrate(onHour ? 8 : 3);
    },
    slap: () => { tone(180, 0, 0.12, "triangle", 0.25, 70); tone(900, 0, 0.04, "square", 0.04); },
    peel: () => { tone(300, 0, 0.22, "sawtooth", 0.05, 1400); },
    start: () => { tone(660, 0, 0.08, "triangle", 0.12); tone(990, 0.07, 0.1, "triangle", 0.12); },
    pause: () => { tone(990, 0, 0.08, "triangle", 0.1); tone(660, 0.07, 0.1, "triangle", 0.1); },
    ding: () => { [784, 988, 1175, 1568].forEach((f, i) => tone(f, i * 0.12, 0.5, "sine", 0.14)); },
  };

  // ---------- phone rings (ntfy) ----------
  const seq = (t) => "stk-" + t.id;
  async function ntfyPost(body) {
    const r = await fetch(NTFY + "/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ topic: state.phone.topic, ...body }) });
    if (!r.ok) throw new Error("ntfy " + r.status);
  }
  async function ntfyDelete(t, topic = state.phone.topic) {
    try { await fetch(`${NTFY}/${topic}/${seq(t)}`, { method: "DELETE" }); } catch { /* offline: the ring may still come */ }
  }
  const appUrl = () => (location.protocol === "https:" ? location.origin + location.pathname : undefined);

  async function book(t) {
    if (!state.phone.on || t.done || !t.remindAt) return;
    const lead = t.remindAt - Date.now();
    if (lead < 15e3) return;
    if (lead > NTFY_MAX_MS) { t.push = "later"; save(); return; }
    if (t.push === "booked" && t.pushAt === t.remindAt && t.pushTopic === state.phone.topic) return;
    try {
      if (t.push === "booked") await ntfyDelete(t, t.pushTopic);
      await ntfyPost({ title: "Stickit", message: t.name, priority: 5, tags: ["alarm_clock"], delay: String(Math.floor(t.remindAt / 1000)), sequence_id: seq(t), click: appUrl() });
      t.push = "booked"; t.pushAt = t.remindAt; t.pushTopic = state.phone.topic;
    } catch { t.push = "retry"; }
    save(); render();
  }
  async function unbook(t) {
    if (t.push !== "booked") { t.push = null; return; }
    const topic = t.pushTopic; t.push = null; t.pushAt = null; save();
    await ntfyDelete(t, topic);
  }
  function syncRings() {
    for (const t of state.tasks) {
      if (t.done) { if (t.push === "booked") unbook(t); continue; }
      if (state.phone.on && t.remindAt && t.remindAt > Date.now()) book(t);
    }
  }

  function paintPhone() {
    els.phoneTopic.textContent = state.phone.topic;
    els.phoneOn.checked = state.phone.on;
    els.phone.dataset.on = state.phone.on;
    els.phoneState.textContent = state.phone.on ? "On" : "Off";
  }

  // ---------- actions ----------
  function startTask(id) {
    const now = Date.now(), cur = running();
    if (cur && cur.id !== id) stopClock(cur, now);
    const t = byId(id); if (!t || t.done) return;
    t.runningSince = now; t.due = false; state.lastId = id;
    sfx.start(); save(); render();
  }
  function stopClock(t, now = Date.now()) {
    if (!t.runningSince) return;
    if (now - t.runningSince >= 1000) t.sessions.push({ start: t.runningSince, end: now });
    t.runningSince = null;
  }
  function pauseTask(id) { const t = byId(id); if (!t) return; stopClock(t); state.lastId = id; sfx.pause(); save(); render(); }
  function toggleTask(id) { const t = byId(id); if (t) t.runningSince ? pauseTask(id) : startTask(id); }

  function completeTask(id) {
    const t = byId(id); if (!t || t.done) return;
    stopClock(t); t.done = true; t.due = false; t.doneAt = Date.now();
    if (state.lastId === id) state.lastId = null;
    unbook(t); save(); sfx.peel();
    const li = els.list.querySelector(`[data-id="${id}"]`);
    if (li && !reduced()) {
      li.classList.add("is-peeling");
      let finished = false;
      const finish = () => { if (!finished) { finished = true; render({ landed: id }); } };
      li.addEventListener("animationend", (e) => { if (e.target === li) finish(); });
      setTimeout(finish, 500);
    } else render({ landed: id });
  }

  function removeTask(id) {
    const idx = state.tasks.findIndex((t) => t.id === id); if (idx < 0) return;
    const [t] = state.tasks.splice(idx, 1);
    stopClock(t); unbook(t);
    if (state.lastId === id) state.lastId = null;
    save(); render();
    toast({ title: `Removed "${t.name}"`, actions: [{ label: "Undo", primary: true, run: () => { state.tasks.splice(idx, 0, t); save(); render(); book(t); } }] });
  }

  function clearDone() {
    const gone = state.tasks.filter((t) => t.done); if (!gone.length) return;
    state.tasks = state.tasks.filter((t) => !t.done);
    save(); render();
    toast({ title: `Cleared ${gone.length} from the pile`, actions: [{ label: "Undo", primary: true, run: () => { state.tasks.push(...gone); save(); render(); } }] });
  }

  function addTask(name, remindAt, startNow) {
    const t = { id: uid(), name, remindAt, reminded: false, due: false, sessions: [], runningSince: null, done: false, created: Date.now(), tilt: tiltFor(state.tasks.length) };
    state.tasks.unshift(t);
    save(); sfx.slap();
    if (startNow) startTask(t.id); else render();
    const li = els.list.querySelector(`[data-id="${t.id}"]`);
    if (li) { li.classList.add("is-new"); setTimeout(() => li.classList.remove("is-new"), 500); }
    book(t);
    return t;
  }

  function snooze(id) {
    const t = byId(id); if (!t) return;
    t.remindAt = ringTime(SNOOZE_MIN); t.reminded = false; t.due = false;
    save(); render(); book(t);
  }
  function dismissDue(id) { const t = byId(id); if (t) { t.due = false; save(); render(); } }

  // ---------- in-page reminders ----------
  function checkReminders(now = Date.now()) {
    for (const t of state.tasks) {
      if (t.done || t.reminded || !t.remindAt || now < t.remindAt) continue;
      t.reminded = true; t.due = true; t.push = null;
      save(); render(); sfx.ding();
      toast({
        kind: "due", title: t.name, lead: `Rang at ${timeFmt.format(new Date(t.remindAt))}`, sticky: true, onDismiss: () => dismissDue(t.id),
        actions: [
          { label: t.runningSince ? "Keep going" : "Start it", primary: true, run: () => (t.runningSince ? dismissDue(t.id) : startTask(t.id)) },
          { label: `Snooze ${SNOOZE_MIN} min`, run: () => snooze(t.id) },
        ],
      });
    }
  }

  // ---------- toasts ----------
  function toast({ kind, title, lead, actions = [], sticky = false, onDismiss }) {
    const el = document.createElement("div");
    el.className = "toast" + (kind === "due" ? " toast--due" : "");
    el.setAttribute("role", kind === "due" ? "alert" : "status");
    const h = document.createElement("p"); h.className = "toast__title"; h.textContent = title; el.append(h);
    if (lead) { const p = document.createElement("p"); p.textContent = lead; el.append(p); }
    const row = document.createElement("div"); row.className = "toast__actions";
    const close = () => el.remove();
    for (const a of actions) {
      const b = document.createElement("button"); b.type = "button";
      b.className = "btn " + (a.primary ? "btn--light" : "btn--ghost-light");
      b.textContent = a.label; b.addEventListener("click", () => { a.run(); close(); });
      row.append(b);
    }
    const x = document.createElement("button"); x.type = "button"; x.className = "btn btn--ghost-light"; x.textContent = "Dismiss";
    x.addEventListener("click", () => { onDismiss?.(); close(); });
    row.append(x); el.append(row);
    els.toasts.append(el);
    if (!sticky) setTimeout(close, 6000);
    if (kind === "due") row.firstElementChild?.focus({ preventScroll: true });
  }

  // ---------- the dial ----------
  const C = 200, R = 150;
  const pt = (deg, r) => { const a = (deg * Math.PI) / 180; return [C + r * Math.sin(a), C - r * Math.cos(a)]; };
  const minToDeg = (min) => (min / SPAN_MIN) * 360;
  const svg = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };

  function arcPath(deg) {
    if (deg <= 0.2) return "";
    if (deg >= 359.8) { const [x, y] = pt(180, R); return `M ${C} ${C - R} A ${R} ${R} 0 1 1 ${x} ${y} A ${R} ${R} 0 1 1 ${C} ${C - R}`; }
    const [x, y] = pt(deg, R);
    return `M ${C} ${C - R} A ${R} ${R} 0 ${deg > 180 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}`;
  }

  function paintFace(now = Date.now()) {
    // Hour ticks and labels sit at real clock hours, so the face turns as the day goes by.
    els.ticks.replaceChildren();
    const first = new Date(now); first.setMinutes(0, 0, 0);
    for (let q = 1; q <= 48; q++) {
      const ts = first.getTime() + q * 15 * 60000, min = (ts - now) / 60000;
      if (min <= 4 || min > SPAN_MIN) continue;
      const deg = minToDeg(min), hour = q % 4 === 0;
      const [x1, y1] = pt(deg, hour ? 134 : 158), [x2, y2] = pt(deg, 166);
      els.ticks.append(svg("line", { class: "dial__tick" + (hour ? "" : " dial__tick--minor"), x1, y1, x2, y2 }));
      if (hour) {
        const [lx, ly] = pt(deg, 112), h = new Date(ts).getHours();
        const label = svg("text", { class: "dial__hour", x: lx, y: ly }); label.textContent = h % 12 || 12;
        els.ticks.append(label);
      }
    }
    // Upcoming rings as stickers on the rim.
    els.pins.replaceChildren();
    const pins = open().filter((t) => t.remindAt && (t.due || (t.remindAt > now && t.remindAt - now <= SPAN_MIN * 60000)))
      .sort((a, b) => b.remindAt - a.remindAt);
    for (const t of pins) {
      const deg = t.due ? 0 : minToDeg((t.remindAt - now) / 60000);
      const [x, y] = pt(deg, R);
      els.pins.append(svg("circle", { class: "dial__pin-shadow", cx: x + 3, cy: y + 4, r: 17 }));
      els.pins.append(svg("circle", { class: "dial__pin" + (t.due ? " dial__pin--due" : ""), cx: x, cy: y, r: 17 }));
      const tx = svg("text", { class: "dial__pin-text", x, y: y + 1 }); tx.textContent = [...t.name.trim()][0]?.toUpperCase() || "";
      els.pins.append(tx);
    }
  }

  function dialMode() {
    if (pendingMin > 0 || dragging) return "set";
    const r = running(); if (r) return "live";
    const last = state.lastId && byId(state.lastId);
    return last && !last.done ? "paused" : "idle";
  }

  function paintDial(now = Date.now()) {
    const mode = dialMode();
    els.dial.dataset.mode = mode;
    els.handle.toggleAttribute("hidden", mode !== "set"); // SVG elements have no .hidden property
    let sweepDeg = 0;
    const upcoming = open().filter((t) => t.remindAt && t.remindAt > now).sort((a, b) => a.remindAt - b.remindAt)[0];

    if (mode === "set") {
      sweepDeg = minToDeg(pendingMin);
      const [kx, ky] = pt(sweepDeg, R), [ax, ay] = pt(sweepDeg, R - 24);
      els.knob.setAttribute("cx", kx); els.knob.setAttribute("cy", ky);
      els.arm.setAttribute("x2", ax); els.arm.setAttribute("y2", ay);
      els.setBig.textContent = pendingMin ? untilShort(pendingMin) : "0 min";
      els.setAt.textContent = pendingMin ? `at ${timeFmt.format(new Date(ringTime(pendingMin)))}` : "Let go at zero for no ring";
    } else {
      if (upcoming && upcoming.remindAt - now <= SPAN_MIN * 60000) sweepDeg = minToDeg((upcoming.remindAt - now) / 60000);
      if (mode === "live" || mode === "paused") {
        const t = running() || byId(state.lastId);
        els.runLabel.textContent = mode === "live" ? "Now timing" : "Paused, tap to resume";
        els.runName.textContent = t.name;
        els.runClock.textContent = clock(tracked(t, now));
      } else if (upcoming) {
        const mins = Math.max(1, Math.ceil((upcoming.remindAt - now) / 60000));
        els.nextLabel.textContent = "Next ring in";
        els.nextBig.textContent = untilShort(mins);
        els.nextSub.textContent = upcoming.name;
      } else {
        els.nextLabel.textContent = "Nothing on the clock";
        els.nextBig.textContent = "Free";
        els.nextSub.textContent = "Type a task, then twist the dial";
      }
    }
    els.sweep.setAttribute("d", arcPath(sweepDeg));
    els.hit.setAttribute("aria-valuenow", pendingMin);
    els.hit.setAttribute("aria-valuetext", pendingMin ? `Ring in ${untilShort(pendingMin)}, at ${timeFmt.format(new Date(ringTime(pendingMin)))}` : "No ring set");
    els.runbar.hidden = !(mode === "live" || mode === "paused");
    if (!els.runbar.hidden) els.runPause.textContent = mode === "live" ? "Pause" : "Resume";
  }

  function setPending(min, { sound = true } = {}) {
    min = Math.max(0, Math.min(SPAN_MIN, Math.round(min / 5) * 5));
    if (min === pendingMin) return;
    if (sound) sfx.ratchet(min % 60 === 0);
    pendingMin = min;
    paintDial(); paintWhen();
  }

  let spinRaf = 0;
  function spinTo(target) {
    cancelAnimationFrame(spinRaf);
    if (reduced()) { setPending(target, { sound: false }); return; }
    const from = pendingMin, t0 = performance.now(), dur = 380 + Math.min(400, Math.abs(target - from) * 2);
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      setPending(from + (target - from) * e);
      if (k < 1) spinRaf = requestAnimationFrame(step); else setPending(target);
    };
    spinRaf = requestAnimationFrame(step);
    // Frames pause in a background tab; land on the target regardless.
    setTimeout(() => { if (pendingMin !== target && !dragging) { cancelAnimationFrame(spinRaf); setPending(target, { sound: false }); } }, dur + 120);
  }

  function pointerMin(e) {
    const r = els.hit.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    let deg = (Math.atan2(dx, -dy) * 180) / Math.PI; if (deg < 0) deg += 360;
    return { min: (deg / 360) * SPAN_MIN, dist: Math.hypot(dx, dy) / (r.width / 2) };
  }
  els.hit.addEventListener("pointerdown", (e) => {
    const { min, dist } = pointerMin(e);
    if (dist < 0.42) { centerTap(); return; }
    e.preventDefault();
    cancelAnimationFrame(spinRaf);
    dragging = true; els.dial.classList.add("is-dragging");
    els.hit.setPointerCapture(e.pointerId);
    setPending(min);
  });
  els.hit.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    let { min } = pointerMin(e);
    // Do not wrap through twelve o'clock: pin to the end the finger came from.
    if (pendingMin > 540 && min < 180) min = SPAN_MIN;
    else if (pendingMin < 180 && min > 540) min = 0;
    setPending(min);
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false; els.dial.classList.remove("is-dragging");
    paintDial(); paintWhen();
    if (pendingMin && !els.name.value.trim()) els.name.focus({ preventScroll: true });
  };
  els.hit.addEventListener("pointerup", endDrag);
  els.hit.addEventListener("pointercancel", endDrag);
  els.hit.addEventListener("keydown", (e) => {
    const steps = { ArrowUp: 5, ArrowRight: 5, ArrowDown: -5, ArrowLeft: -5, PageUp: 60, PageDown: -60 };
    if (e.key in steps) { e.preventDefault(); setPending(pendingMin + steps[e.key]); }
    else if (e.key === "Home") { e.preventDefault(); setPending(0); }
    else if (e.key === "End") { e.preventDefault(); setPending(SPAN_MIN); }
  });

  function centerTap() {
    const mode = dialMode();
    els.dial.classList.remove("is-nudged"); void els.dial.offsetWidth; els.dial.classList.add("is-nudged");
    if (mode === "live" || mode === "paused") { const id = running()?.id || state.lastId; if (id) toggleTask(id); }
    else if (mode === "set") { spinTo(0); }
    else els.name.focus();
  }
  els.dial.addEventListener("animationend", () => els.dial.classList.remove("is-nudged"));

  // ---------- render ----------
  function render(opts = {}) {
    const now = Date.now(), todo = open();
    els.list.replaceChildren(...todo.map((t) => stickerEl(t, now)));
    els.empty.hidden = todo.length > 0 || state.tasks.some((t) => t.done);
    els.count.textContent = `${todo.length} to do`;

    const done = state.tasks.filter((t) => t.done).sort((a, b) => b.doneAt - a.doneAt);
    els.doneWrap.hidden = !done.length;
    els.doneList.replaceChildren(...done.map((t) => {
      const li = document.createElement("li"); li.className = "done__item" + (opts.landed === t.id ? " is-new" : "");
      const s = document.createElement("s"); s.textContent = t.name;
      const span = document.createElement("span"); span.className = "num"; span.textContent = tracked(t) ? spoken(tracked(t)) : "untimed";
      li.append(s, span); return li;
    }));

    paintFace(now); paintDial(now); paintPhone();
    els.storageError.hidden = storageOk;
    tick();
  }

  function stickerEl(t, now) {
    const li = els.tpl.content.firstElementChild.cloneNode(true);
    li.dataset.id = t.id;
    li.style.setProperty("--tilt", `${t.tilt}deg`);
    li.dataset.running = !!t.runningSince;
    li.dataset.due = !!t.due;
    li.querySelector(".sticker__name").textContent = t.name;
    const tag = li.querySelector(".tag");
    if (t.remindAt) {
      tag.hidden = false;
      tag.textContent = t.due ? "Due now" : whenLabel(t.remindAt);
      if (t.push === "booked") tag.title = "Your phone will ring";
    }
    li.querySelector(".sticker__time").textContent = timeText(t, now);
    const toggle = li.querySelector('[data-act="toggle"]');
    toggle.textContent = t.runningSince ? "Pause" : tracked(t, now) ? "Resume" : "Start";
    toggle.setAttribute("aria-label", `${toggle.textContent} ${t.name}`);
    li.querySelector('[data-act="done"]').setAttribute("aria-label", `Mark ${t.name} done`);
    li.querySelector('[data-act="remove"]').setAttribute("aria-label", `Remove ${t.name}`);
    return li;
  }
  function timeText(t, now) {
    const ms = tracked(t, now);
    if (t.runningSince) return `${clock(ms)} and counting`;
    const base = ms ? `${spoken(ms)} tracked` : "Not started yet";
    return t.push === "booked" && !t.due ? `${base}, phone will ring` : base;
  }

  let lastMinute = -1;
  function tick() {
    const now = Date.now(), r = running();
    if (r) {
      const ms = tracked(r, now);
      const li = els.list.querySelector(`[data-id="${r.id}"] .sticker__time`);
      if (li) li.textContent = timeText(r, now);
      document.title = `${clock(ms)} ${r.name}`;
    } else document.title = "Stickit, a task timer that rings your phone";
    els.total.textContent = clock(trackedToday(now), true);
    const minute = Math.floor(now / 60000);
    if (minute !== lastMinute) { lastMinute = minute; paintFace(now); }
    if (!dragging) paintDial(now);
  }

  // ---------- form ----------
  function paintWhen() {
    els.when.hidden = !(pendingMin > 0 || els.name.value.trim() || document.activeElement === els.name);
    els.form.querySelectorAll("[data-quick]").forEach((b) => b.setAttribute("aria-pressed", Number(b.dataset.quick) === pendingMin && (pendingMin > 0 || b.dataset.quick === "0")));
  }
  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = els.name.value.trim();
    if (!name) { els.name.setAttribute("aria-invalid", "true"); els.name.focus(); return; }
    els.name.removeAttribute("aria-invalid");
    addTask(name, pendingMin ? ringTime(pendingMin) : null, els.start.checked);
    els.form.reset(); pendingMin = 0; paintDial(); paintWhen();
    els.name.blur();
  });
  els.name.addEventListener("input", () => { els.name.removeAttribute("aria-invalid"); paintWhen(); });
  els.name.addEventListener("focus", paintWhen);
  els.name.addEventListener("blur", () => setTimeout(paintWhen, 150));
  els.form.querySelectorAll("[data-quick]").forEach((b) => b.addEventListener("click", () => spinTo(Number(b.dataset.quick))));

  // ---------- events ----------
  els.list.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    const id = b.closest(".sticker").dataset.id;
    ({ toggle: toggleTask, done: completeTask, remove: removeTask })[b.dataset.act](id);
  });
  els.runPause.addEventListener("click", () => { const id = running()?.id || state.lastId; if (id) toggleTask(id); });
  els.runDone.addEventListener("click", () => { const id = running()?.id || state.lastId; if (id) completeTask(id); });
  els.clearDone.addEventListener("click", clearDone);
  els.sound.addEventListener("click", () => { state.sound = !state.sound; save(); paintSound(); if (state.sound) sfx.start(); });
  function paintSound() { els.sound.setAttribute("aria-pressed", state.sound); els.sound.textContent = state.sound ? "Sound on" : "Sound off"; }

  els.phoneCopy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(state.phone.topic); els.phoneCopy.textContent = "Copied"; }
    catch { getSelection().selectAllChildren(els.phoneTopic); els.phoneCopy.textContent = "Selected"; }
    setTimeout(() => (els.phoneCopy.textContent = "Copy"), 1600);
  });
  els.phoneTest.addEventListener("click", async () => {
    els.phoneTest.disabled = true; els.phoneTest.textContent = "Sending";
    try {
      await ntfyPost({ title: "Stickit", message: "Test ring. Your tasks will sound like this.", priority: 5, tags: ["alarm_clock"], click: appUrl() });
      toast({ title: "Test ring sent", lead: "It should reach your phone within a few seconds. Nothing? Check the channel name in ntfy." });
    } catch { toast({ title: "Could not reach ntfy", lead: "Check your connection and try again." }); }
    els.phoneTest.disabled = false; els.phoneTest.textContent = "Send a test ring";
  });
  els.phoneOn.addEventListener("change", () => {
    state.phone.on = els.phoneOn.checked; save(); paintPhone();
    if (state.phone.on) syncRings(); else state.tasks.forEach((t) => unbook(t));
    render();
  });
  els.phoneNew.addEventListener("click", () => {
    state.tasks.forEach((t) => unbook(t));
    state.phone.topic = newTopic(); save(); paintPhone();
    toast({ title: "New channel made", lead: "Subscribe to it in ntfy; the old one gets no more rings." });
    syncRings();
  });

  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest("input, textarea, select, [contenteditable], [role=slider]")) return;
    if (e.key === "n" || e.key === "N") { e.preventDefault(); els.name.focus(); }
    else if (e.key === " " && !e.target.closest("button, summary")) {
      const id = running()?.id || state.lastId;
      if (id) { e.preventDefault(); toggleTask(id); }
    }
  });

  // ---------- boot ----------
  load();
  els.hit.tabIndex = 0;
  paintSound(); render(); paintWhen();
  checkReminders(); syncRings();
  setInterval(() => { tick(); checkReminders(); }, 1000);
  setInterval(syncRings, 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { tick(); checkReminders(); syncRings(); } });
  if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});
})();
