// Fleet Observatory page (CLAW-108). Served by scripts/claw-observatory.mjs.
//
// Everything a bot wrote is untrusted text. This file never assigns innerHTML:
// every string reaches the DOM through h() as a text node, and h() refuses an
// href that is not a loopback address the server built.
"use strict";

// The access key lives in localStorage, which belongs to this origin only
// (127.0.0.1 and this port), so a bookmark to this address keeps working. It
// is never a cookie: a cookie would also reach every other loopback port,
// including a bot's gateway.
const KEY_STORE = "claw-observatory-key";
const VIEW_KEY = "claw-observatory-view";
const BOTS_KEY = "claw-observatory-bots";

function storeKey(value) {
  try {
    localStorage.setItem(KEY_STORE, value);
  } catch {
    try {
      sessionStorage.setItem(KEY_STORE, value);
    } catch {
      // storage is blocked; the key still works for this page load
    }
  }
}

function readToken() {
  const match = location.hash.match(/(?:^#|&)t=([A-Za-z0-9_-]{20,})/);
  if (match) {
    storeKey(match[1]);
    history.replaceState(null, "", location.pathname + location.search);
    return match[1];
  }
  try {
    return localStorage.getItem(KEY_STORE) ?? sessionStorage.getItem(KEY_STORE);
  } catch {
    return null;
  }
}

let TOKEN = readToken();

// `make observe-open` can target a tab that is already open on this address;
// a change of the fragment alone does not load the page again.
window.addEventListener("hashchange", () => {
  if (/(?:^#|&)t=/.test(location.hash)) {
    readToken();
    location.reload();
  }
});

async function api(url, { method = "GET", type, body: payload } = {}) {
  const headers = { "x-observatory-token": TOKEN ?? "" };
  if (type) headers["content-type"] = type;
  const res = await fetch(url, { method, headers, body: payload, cache: "no-store" });
  if (res.status === 204) return null;
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err = new Error(body?.error ?? `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

// Allowed fragments: the port proxy's unlock key (#k=) and the swarm
// dashboard's session token (#t=). A fragment never leaves the browser.
const LOOPBACK_HREF =
  /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}\/(?:__claw-proxy\/unlock#k=[A-Za-z0-9_-]{32,256}|#t=[A-Za-z0-9_-]{32,256})?$/;

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = String(v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "href" && !LOOPBACK_HREF.test(String(v))) continue;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

// ── formatting ────────────────────────────────────────────────────────────────

const toMs = (v) => (typeof v === "number" ? v : Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);

function ago(v) {
  const ms = toMs(v);
  if (ms == null) return "—";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 36) return `${hr} h ago`;
  return `${Math.round(hr / 24)} d ago`;
}

function when(v) {
  const ms = toMs(v);
  return ms == null ? "—" : new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function bytes(n) {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const num = (n) => (n == null ? "—" : Number(n).toLocaleString());
const cls = (s) => String(s).toLowerCase().replace(/[^a-z]+/g, "-");

function cronLabel(dreaming) {
  if (!dreaming?.frequency) return "—";
  const m = String(dreaming.frequency).match(/^(\d{1,2}) (\d{1,2}) \* \* \*$/);
  const tz = dreaming.timezone ? ` ${dreaming.timezone}` : "";
  return m ? `daily ${m[2].padStart(2, "0")}:${m[1].padStart(2, "0")}${tz}` : `${dreaming.frequency}${tz}`;
}

function shortKey(key) {
  return String(key)
    .replace(/^agent:/, "")
    .replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi, (id) => id.slice(0, 8));
}

/** Case-insensitive "contains"; an empty query matches everything. */
const matches = (query, ...texts) => {
  const q = String(query ?? "").trim().toLowerCase();
  return !q || texts.some((t) => t != null && String(t).toLowerCase().includes(q));
};

// ── small building blocks ─────────────────────────────────────────────────────

const chip = (text, tone = "") => h("span", { class: `chip ${tone}`, text });
const placeholder = (text) => h("div", { class: "placeholder muted", text });
const empty = (text) => h("div", { class: "empty muted", text });
const errorBox = (err) => h("div", { class: "error", role: "alert", text: err.message });
const fact = (label, value) => [h("dt", { text: label }), h("dd", { text: value })];
// A proxied Control UI opens through the proxy's unlock page (see /api/fleet).
const openUrlFor = (key) => botByKey(key)?.controlUi?.openUrl ?? null;
const externalLink = (href, text, className = "button") =>
  h("a", { class: className, href, target: "_blank", rel: "noopener noreferrer", text });

function section(title, subtitle, ...content) {
  return h(
    "section",
    { class: "section" },
    h("header", { class: "section-head" }, h("h2", { text: title }), subtitle ? h("p", { class: "muted", text: subtitle }) : null),
    content,
  );
}

function healthDot(bot) {
  const tone = !bot?.running ? "off" : !bot.health || bot.health === "healthy" ? "ok" : bot.health === "starting" ? "warn" : "bad";
  const label = bot ? (bot.health ? `${bot.state}, ${bot.health}` : bot.state) : "unknown";
  return h("span", { class: `dot ${tone}`, title: label, role: "img", "aria-label": label });
}

/** A text box that calls onChange as the reader types. Built once per view,
 *  so a redraw of the list below never takes the focus away. */
function filterBox(placeholderText, value, onChange) {
  const input = h("input", { type: "search", class: "filter-input", placeholder: placeholderText, "aria-label": placeholderText, value: value ?? "" });
  input.addEventListener("input", () => onChange(input.value));
  return input;
}

// ── bots: identity, role color, icon ─────────────────────────────────────────
//
// The server sends each bot's name, emoji, avatar address and role family
// (claw-observatory.mjs ROLE_FAMILIES). The family sets the color through the
// .fam-<id> classes in app.css; the avatar tells two bots of one family apart.

const botByKey = (key) => app.fleet?.bots.find((b) => b.key === key) ?? null;
const famOf = (bot) => bot?.identity?.family ?? "other";
const botLabel = (bot) => bot?.identity?.name || bot?.agentName || bot?.key || "?";
const familyLabel = (id) => app.fleet?.families?.find((f) => f.id === id)?.label ?? id;
const roleText = (bot) => (bot?.identity?.role ? `${familyLabel(famOf(bot))} · ${bot.identity.role}` : familyLabel(famOf(bot)));

// The avatar needs the access header, so it is fetched once and shown from a
// blob: address.
const avatarBlobs = new Map();
function avatarSrc(url) {
  if (!avatarBlobs.has(url)) {
    avatarBlobs.set(
      url,
      fetch(url, { headers: { "x-observatory-token": TOKEN ?? "" } })
        .then((r) => (r.ok ? r.blob() : null))
        .then((b) => (b ? URL.createObjectURL(b) : null))
        .catch(() => null),
    );
  }
  return avatarBlobs.get(url);
}

function botIcon(bot, size = "sm") {
  const el = h("span", {
    class: `bot-icon ${size} fam-${famOf(bot)}`,
    "data-bot": bot?.key ?? "",
    "data-size": size,
    title: `${botLabel(bot)} — ${roleText(bot)}`,
    "aria-hidden": "true",
    text: bot?.identity?.emoji || botLabel(bot).slice(0, 1).toUpperCase(),
  });
  const url = bot?.identity?.avatar;
  if (url) {
    avatarSrc(url).then((src) => {
      if (src) el.replaceChildren(h("img", { src, alt: "" }));
    });
  }
  return el;
}

/** Replace every icon on the page after the fleet read brought a new face or
 *  role (a bot's identity is read in the background). */
function refreshIcons() {
  for (const el of document.querySelectorAll(".bot-icon[data-bot]")) {
    const bot = botByKey(el.dataset.bot);
    if (bot) el.replaceWith(botIcon(bot, el.dataset.size));
  }
}

function controlUiLink(bot, text = "Control UI ↗") {
  if (!openUrlFor(bot?.key)) {
    return h("span", { class: "muted small", title: "No reachable Control UI", text: `Control UI: ${bot?.controlUi?.via ?? "unknown"}` });
  }
  return h("button", {
    class: "button small",
    type: "button",
    title: `Open ${botLabel(bot)}'s Control UI, signed in`,
    text,
    onclick: (event) => {
      event.stopPropagation();
      openControlUi(bot);
    },
  });
}

// ── one-click Control UI (R2) ─────────────────────────────────────────────────
// The server returns a signed-in address (gateway token in the fragment). A
// browser that the bot has not seen before then asks the gateway to pair; the
// page watches for that request and approves it. A request that came through
// the port proxy is approved at once; any other needs a click (the server
// judges both again).
const PAIR_POLL_MS = 2000;
const PAIR_QUIET_MS = 30_000;
const PAIR_MAX_MS = 3 * 60_000;
const pairWatches = new Map();

function controlUiStatus() {
  let bar = document.getElementById("cui-status");
  if (!bar) {
    bar = h("div", { id: "cui-status", class: "cui-status", role: "status", "aria-live": "polite" });
    document.body.append(bar);
  }
  return bar;
}

function setControlUiStatus(key, message, tone = "", action = null) {
  const bar = controlUiStatus();
  let row = bar.querySelector(`[data-bot="${key}"]`);
  if (!message) {
    row?.remove();
    return;
  }
  if (!row) {
    row = h("div", { class: "cui-row", "data-bot": key });
    bar.append(row);
  }
  row.className = `cui-row ${tone}`;
  row.replaceChildren(
    ...[h("span", { text: message }), action].filter(Boolean),
    h("button", { class: "cui-close", type: "button", title: "Close", text: "×", onclick: () => stopPairWatch(key, true) }),
  );
}

function stopPairWatch(key, clear = false) {
  const w = pairWatches.get(key);
  if (w) clearTimeout(w.timer);
  pairWatches.delete(key);
  if (clear) setControlUiStatus(key, null);
}

async function openControlUi(bot) {
  const name = botLabel(bot);
  // Open the tab inside the click; a tab opened after an await is a popup.
  const win = window.open("about:blank", "_blank");
  if (win) {
    win.opener = null;
    // A sandboxed bot answers docker exec in about 3 s; say so in the new tab.
    try {
      win.document.title = `Opening ${name}…`;
      win.document.body.style.cssText = "font:14px/1.5 -apple-system,system-ui,sans-serif;margin:40px;color:#6a6962";
      win.document.body.textContent = `Opening ${name}'s Control UI…`;
    } catch {
      // the tab is still usable without the message
    }
  }
  setControlUiStatus(bot.key, `Opening ${name}…`);
  let res;
  try {
    res = await api(`/api/control-ui/${encodeURIComponent(bot.key)}/open`, { method: "POST" });
  } catch (err) {
    win?.close();
    setControlUiStatus(bot.key, `${name}: ${err.message}`, "bad");
    return;
  }
  if (win) win.location.replace(res.url);
  else location.assign(res.url);
  watchPairing(bot);
}

function watchPairing(bot) {
  const name = botLabel(bot);
  stopPairWatch(bot.key);
  const started = Date.now();
  const watch = { timer: null, approving: new Set() };
  pairWatches.set(bot.key, watch);
  setControlUiStatus(bot.key, `Opened ${name}. Watching for a pairing request…`);
  const tick = async () => {
    if (pairWatches.get(bot.key) !== watch) return;
    let pending = [];
    try {
      pending = (await api(`/api/control-ui/${encodeURIComponent(bot.key)}/pairing`)).pending ?? [];
    } catch (err) {
      setControlUiStatus(bot.key, `${name}: ${err.message}`, "bad");
      stopPairWatch(bot.key);
      return;
    }
    const ok = pending.filter((r) => r.ok);
    const auto = ok.find((r) => r.viaProxy && !watch.approving.has(r.requestId));
    if (auto) {
      await approvePairing(bot, auto.requestId, watch);
      return;
    }
    const manual = ok.find((r) => !watch.approving.has(r.requestId));
    if (manual) {
      setControlUiStatus(
        bot.key,
        `${name}: a browser asks to pair (${manual.platform ?? "unknown platform"}, from ${manual.remoteIp ?? "?"}). Approve only if you just opened it.`,
        "warn",
        h("button", { class: "button small", type: "button", text: "Approve", onclick: () => approvePairing(bot, manual.requestId, watch) }),
      );
    }
    const quiet = Date.now() - started > PAIR_QUIET_MS && !pending.length;
    if (quiet) {
      setControlUiStatus(bot.key, `Opened ${name}. No pairing step was needed.`, "ok");
      stopPairWatch(bot.key);
      setTimeout(() => !pairWatches.has(bot.key) && setControlUiStatus(bot.key, null), 6000);
      return;
    }
    if (Date.now() - started > PAIR_MAX_MS) {
      setControlUiStatus(bot.key, `${name}: stopped watching for a pairing request. Open the Control UI again to retry.`, "warn");
      stopPairWatch(bot.key);
      return;
    }
    watch.timer = setTimeout(tick, PAIR_POLL_MS);
  };
  watch.timer = setTimeout(tick, PAIR_POLL_MS);
}

async function approvePairing(bot, requestId, watch) {
  const name = botLabel(bot);
  watch.approving.add(requestId);
  setControlUiStatus(bot.key, `Pairing this browser with ${name}…`);
  try {
    await api(`/api/control-ui/${encodeURIComponent(bot.key)}/approve`, {
      method: "POST",
      type: "application/json",
      body: JSON.stringify({ requestId }),
    });
  } catch (err) {
    setControlUiStatus(bot.key, `${name}: pairing refused: ${err.message}`, "bad");
    stopPairWatch(bot.key);
    return;
  }
  stopPairWatch(bot.key);
  setControlUiStatus(bot.key, `Paired with ${name}. The Control UI tab connects on its next retry.`, "ok");
  setTimeout(() => !pairWatches.has(bot.key) && setControlUiStatus(bot.key, null), 8000);
}

function loadSelection() {
  try {
    const keys = JSON.parse(localStorage.getItem(BOTS_KEY) ?? "[]");
    return new Set(Array.isArray(keys) ? keys.filter((k) => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}

/** The bots the reader chose in the bot bar; all bots when none is chosen. */
const inScope = (bots) => (app.selected.size ? bots.filter((b) => app.selected.has(b.key)) : bots);

function setSelection(keys) {
  app.selected = new Set(keys);
  try {
    localStorage.setItem(BOTS_KEY, JSON.stringify([...app.selected]));
  } catch {
    // per-viewer convenience only
  }
  renderBotBar();
  renderView();
}

function renderBotBar() {
  const bots = app.fleet.bots;
  // A saved choice can name a bot that no longer exists.
  for (const key of app.selected) if (!botByKey(key)) app.selected.delete(key);
  const present = (app.fleet.families ?? []).filter((f) => bots.some((b) => famOf(b) === f.id));
  botBarEl.replaceChildren(
    h("button", {
      type: "button",
      class: `bot-chip all${app.selected.size ? "" : " active"}`,
      "aria-pressed": String(!app.selected.size),
      text: "All bots",
      onclick: () => setSelection([]),
    }),
    ...bots.map((b) => {
      const on = app.selected.has(b.key);
      return h(
        "button",
        {
          type: "button",
          class: `bot-chip fam-${famOf(b)}${on ? " active" : ""}${b.running ? "" : " stopped"}`,
          "aria-pressed": String(on),
          title: `${botLabel(b)} — ${roleText(b)}${b.running ? "" : ` (${b.state})`}. Click to add or remove.`,
          onclick: () => {
            const next = new Set(app.selected);
            if (on) next.delete(b.key);
            else next.add(b.key);
            setSelection([...next]);
          },
        },
        botIcon(b),
        h("span", { class: "bot-chip-name", text: botLabel(b) }),
      );
    }),
    h(
      "span",
      { class: "legend", "aria-label": "Role colors" },
      present.map((f) =>
        h(
          "button",
          {
            type: "button",
            class: `legend-chip fam-${f.id}`,
            title: `Show only: ${f.label}`,
            onclick: () => setSelection(bots.filter((b) => famOf(b) === f.id).map((b) => b.key)),
          },
          h("span", { class: "swatch" }),
          f.label,
        ),
      ),
    ),
  );
  // The background swarm (swarm.js) follows the bots in view.
  window.dispatchEvent(new CustomEvent("observatory:bots", { detail: inScope(bots).map((b) => ({ key: b.key, family: famOf(b) })) }));
}

// ── app shell ─────────────────────────────────────────────────────────────────

const VIEWS = [
  { id: "work", label: "Work", sub: "System 2" },
  { id: "live", label: "Live", sub: "System 1" },
  { id: "agents", label: "Agents", sub: "System 3" },
];

function loadView() {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return VIEWS.some((x) => x.id === v) ? v : "work";
  } catch {
    return "work";
  }
}

const app = {
  view: loadView(),
  fleet: null,
  selected: loadSelection(),
  timers: [],
  profiles: new Map(),
  work: { q: "", state: "all", expanded: new Set(), colonyExpanded: new Set() },
  live: {
    session: null,
    filter: "all",
    q: "",
    tq: "",
    limit: 150,
    show: { thinking: true, call: true, result: true, text: true, event: true },
    lastSize: null,
    data: null,
    toggled: new Map(),
  },
  agents: { bot: null, tab: "identity", q: "" },
};

const tabsEl = document.getElementById("tabs");
const statusEl = document.getElementById("fleet-status");
const botBarEl = document.getElementById("bot-bar");
const mainEl = document.getElementById("main");

function every(ms, fn) {
  app.timers.push(
    setInterval(() => {
      if (document.visibilityState === "visible") fn();
    }, ms),
  );
}

function clearTimers() {
  app.timers.forEach(clearInterval);
  app.timers = [];
}

function setView(id) {
  app.view = id;
  try {
    localStorage.setItem(VIEW_KEY, id);
  } catch {
    // per-viewer convenience only
  }
  renderTabs();
  renderView();
}

function renderTabs() {
  tabsEl.replaceChildren(
    ...VIEWS.map((v) =>
      h(
        "button",
        { type: "button", class: `tab${app.view === v.id ? " active" : ""}`, "aria-pressed": String(app.view === v.id), onclick: () => setView(v.id) },
        h("span", { class: "tab-label", text: v.label }),
        h("span", { class: "tab-sub", text: v.sub }),
      ),
    ),
  );
}

/** The status-bar chip for the dot_swarm dashboard. */
function swarmChip(swarm) {
  if (swarm.running && swarm.openUrl) return externalLink(swarm.openUrl, "swarm dashboard ↗", "chip link ok");
  if (swarm.running) {
    const c = chip("swarm dashboard: started elsewhere", "warn");
    c.title = swarm.note ?? "";
    return c;
  }
  const c = chip("swarm dashboard off", "warn");
  c.title = swarm.note ?? "";
  return c;
}

function renderFleetStatus() {
  const f = app.fleet;
  const running = f.bots.filter((b) => b.running).length;
  const proxyText = f.proxy ? `port proxy ${f.proxy.state}${f.proxy.health ? `, ${f.proxy.health}` : ""}` : "port proxy not created";
  statusEl.replaceChildren(
    ...[
      chip(`${running} of ${f.bots.length} bots running`, running === f.bots.length ? "ok" : "warn"),
      chip(proxyText, f.proxy?.state === "running" ? "ok" : "warn"),
      swarmChip(f.swarm),
      chip(f.snapshot.last ? `last snapshot ${ago(f.snapshot.last.date)}` : "no snapshot yet", f.snapshot.last ? "" : "warn"),
    ].filter(Boolean),
  );
}

function renderLocked(err) {
  clearTimers();
  botBarEl.replaceChildren();
  const input = h("input", { type: "password", class: "filter-input", autocomplete: "off", placeholder: "Access key", "aria-label": "Access key" });
  const unlock = () => {
    const value = input.value.trim();
    if (!/^[A-Za-z0-9_-]{20,}$/.test(value)) return;
    storeKey(value);
    location.reload();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") unlock();
  });
  mainEl.replaceChildren(
    h(
      "div",
      { class: "fatal" },
      h("h2", { text: "This browser is not unlocked" }),
      h("p", { text: err.message }),
      h("p", { text: "Run `make observe-open` in the oasis-claw folder once. It opens this page with the access key, and the page keeps the key for this address. After that, a bookmark to this address works." }),
      h("p", { class: "muted", text: "A browser that `open` cannot reach, such as a Safari web app: run `make observe-key` (it copies the key), then paste the key here." }),
      h("div", { class: "toolbar" }, input, h("button", { type: "button", class: "button", text: "Unlock", onclick: unlock })),
    ),
  );
}

function renderFatal(err) {
  if (err.status === 401 || !TOKEN) {
    renderLocked(err);
    return;
  }
  clearTimers();
  mainEl.replaceChildren(
    h(
      "div",
      { class: "fatal" },
      h("h2", { text: "The observatory cannot read the fleet" }),
      h("p", { text: err.message }),
      h("p", { class: "muted", text: "Check that Docker is running, then reload this page." }),
    ),
  );
}

// The identity part of the fleet read changes when a face or a role arrives.
const identitySignature = (f) => f.bots.map((b) => `${b.key}:${b.running}:${b.identity?.family}:${b.identity?.avatar}:${b.identity?.name}`).join("|");

async function refreshFleet(initial) {
  try {
    const before = app.fleet ? identitySignature(app.fleet) : null;
    app.fleet = await api("/api/fleet");
    renderFleetStatus();
    if (identitySignature(app.fleet) !== before) {
      renderBotBar();
      if (!initial) refreshIcons();
    }
    return true;
  } catch (err) {
    if (initial || err.status === 401) renderFatal(err);
    else statusEl.replaceChildren(chip(`fleet read failed: ${err.message}`, "bad"));
    return false;
  }
}

function renderView() {
  clearTimers();
  mainEl.replaceChildren();
  if (!app.fleet) return;
  if (app.view === "work") renderWork();
  else if (app.view === "live") renderLive();
  else renderAgents();
}

// ── System 2: work ────────────────────────────────────────────────────────────

const WORK_STATES = ["all", "open", "in progress", "claimed", "partial", "blocked"];
const BOARD_PREVIEW = 12;

const itemMatches = (i) =>
  (app.work.state === "all" || i.state === app.work.state) && matches(app.work.q, i.id, i.title, i.section);

function itemRow(i) {
  return h("li", null, h("span", { class: "mono item-id", text: i.id }), h("span", { class: `state s-${cls(i.state)}`, text: i.state }), h("span", { class: "item-title", title: i.title, text: i.title }));
}

function boardCard(board, redraw) {
  const bot = botByKey(board.key);
  const s = board.summary;
  const tone = (state) => (state === "blocked" ? "bad" : state === "done" || state === "cancelled" ? "" : "info");
  const head = h(
    "header",
    { class: "card-head" },
    botIcon(bot, "md"),
    h("div", { class: "card-title" }, h("h3", { text: botLabel(bot) }), h("div", { class: "muted small", text: roleText(bot) })),
    controlUiLink(bot, "↗"),
  );
  if (s.error) {
    return h("article", { class: `card fam-${famOf(bot)}` }, head, errorBox(new Error(s.error)));
  }
  const items = s.open.filter(itemMatches);
  const expanded = app.work.expanded.has(board.key);
  const shown = expanded ? items : items.slice(0, BOARD_PREVIEW);
  const toggle = () => {
    if (expanded) app.work.expanded.delete(board.key);
    else app.work.expanded.add(board.key);
    redraw();
  };
  return h(
    "article",
    { class: `card fam-${famOf(bot)}` },
    head,
    h("div", { class: "path mono small", title: board.hostPath, text: board.hostPath }),
    h("div", { class: "chips" }, Object.entries(s.counts).sort().map(([state, n]) => chip(`${state} ${n}`, tone(state)))),
    s.stateUpdatedMs ? h("div", { class: "muted small", text: `state.md updated ${ago(s.stateUpdatedMs)}` }) : null,
    shown.length ? h("ul", { class: "items" }, shown.map(itemRow)) : empty(s.open.length ? "No item matches the filter." : "No open items."),
    items.length > BOARD_PREVIEW
      ? h("button", { type: "button", class: "more", text: expanded ? "Show fewer" : `Show all ${items.length}`, onclick: toggle })
      : null,
    s.openTotal > s.open.length ? h("div", { class: "muted small", text: `${s.openTotal - s.open.length} more open items are not loaded (limit ${s.open.length}).` }) : null,
  );
}

function colonyTable(data, redraw) {
  const rows = data.divisions
    .map((d) => ({ d, items: d.error ? [] : d.items.filter((i) => matches(app.work.q, i.id, i.title, d.name)) }))
    .filter(({ d, items }) => !app.work.q || items.length || matches(app.work.q, d.name, d.path))
    .sort((a, b) => b.d.active + b.d.pending - (a.d.active + a.d.pending));
  if (!rows.length) return [empty("No division matches the filter.")];
  return [
    h("div", { class: "muted small", text: `${rows.length} of ${data.divisions.length} divisions under ${data.root ?? "?"}` }),
    h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        { class: "table" },
        h("thead", null, h("tr", null, ["Division", "Active", "Pending", "Done", "Items"].map((t) => h("th", { text: t })))),
        h(
          "tbody",
          null,
          rows.map(({ d, items }) => {
            const expanded = app.work.colonyExpanded.has(d.name);
            const shown = expanded ? items : items.slice(0, 4);
            return h(
              "tr",
              null,
              h("td", null, h("div", { text: d.name ?? "?" }), h("div", { class: "muted mono small", text: d.path ?? "" })),
              h("td", { class: "num", text: d.error ? "—" : d.active }),
              h("td", { class: "num", text: d.error ? "—" : d.pending }),
              h("td", { class: "num", text: d.error ? "—" : d.done }),
              h(
                "td",
                null,
                d.error
                  ? h("span", { class: "bad-text", text: d.error })
                  : [
                      h("ul", { class: "items compact" }, shown.map((i) => h("li", null, h("span", { class: "mono item-id", text: i.id ?? "" }), h("span", { class: "item-title", title: i.title ?? "", text: i.title ?? "" })))),
                      items.length > 4
                        ? h("button", {
                            type: "button",
                            class: "more",
                            text: expanded ? "Show fewer" : `Show all ${items.length}`,
                            onclick: () => {
                              if (expanded) app.work.colonyExpanded.delete(d.name);
                              else app.work.colonyExpanded.add(d.name);
                              redraw();
                            },
                          })
                        : null,
                    ],
              ),
            );
          }),
        ),
      ),
    ),
  ];
}

function renderWork() {
  const boards = h("div", { class: "grid boards" }, placeholder("Reading bot boards…"));
  const colony = h("div", { class: "colony" }, placeholder("Reading the colony…"));
  let boardData = null;
  let colonyData = null;

  const drawBoards = () => {
    if (!boardData) return;
    const list = inScope(boardData);
    boards.replaceChildren(...(list.length ? list.map((b) => boardCard(b, drawBoards)) : [empty(boardData.length ? "No chosen bot has a board." : "No bot has a board configured.")]));
  };
  const drawColony = () => {
    if (colonyData) colony.replaceChildren(...colonyTable(colonyData, drawColony));
  };
  const drawStates = () =>
    stateBar.replaceChildren(
      ...WORK_STATES.map((st) =>
        h("button", {
          type: "button",
          class: `pill small${app.work.state === st ? " active" : ""}`,
          text: st,
          onclick: () => {
            app.work.state = st;
            drawStates();
            drawBoards();
          },
        }),
      ),
    );
  const stateBar = h("div", { class: "pill-bar" });
  const toolbar = h(
    "div",
    { class: "toolbar" },
    filterBox("Filter items and divisions by text or ID", app.work.q, (v) => {
      app.work.q = v;
      drawBoards();
      drawColony();
    }),
    stateBar,
  );
  const sw = app.fleet.swarm;
  const dashboardNote =
    sw.running && sw.openUrl
      ? h(
          "p",
          { class: "muted" },
          "Claim, finish, block and comment on an item in the ",
          externalLink(sw.openUrl, "swarm dashboard ↗", "inline-link"),
          ". The observatory started it and stops it on exit. Every read and write there needs this run's token, which the link carries in its fragment.",
        )
      : sw.running
        ? h("p", { class: "muted", text: `A swarm dashboard started outside the observatory runs on ${sw.url}. Open the URL that its own terminal printed (it ends with #t=…).` })
        : h("p", { class: "muted", text: `The swarm dashboard is not running${sw.note ? ` (${sw.note})` : ""}. Restart the observatory, or run \`make swarm-dashboard\` and open the URL it prints.` });
  mainEl.append(
    toolbar,
    section("Bot boards", "The .swarm board that each bot reads and writes (OASIS_SWARM_DIR). The bot bar above chooses the bots.", boards),
    section("Colony", "Every .swarm division under the dot_swarm root. The text filter applies here too.", dashboardNote, colony),
  );
  drawStates();
  api("/api/boards")
    .then(({ boards: list }) => {
      boardData = list;
      drawBoards();
    })
    .catch((err) => boards.replaceChildren(errorBox(err)));
  api("/api/colony")
    .then((data) => {
      colonyData = data;
      drawColony();
    })
    .catch((err) => colony.replaceChildren(errorBox(err)));
}

// ── System 1: live ────────────────────────────────────────────────────────────

function disclosure(key, defaultOpen, kind, label, content) {
  const toggled = app.live.toggled;
  const d = h("details", { class: `disc d-${kind}` }, h("summary", { text: label }), content);
  d.open = toggled.has(key) ? toggled.get(key) : defaultOpen;
  d.addEventListener("toggle", () => toggled.set(key, d.open));
  return d;
}

// Which part types the reader wants to see (the toggles above a transcript).
function partKind(part, role) {
  if (part.t === "thinking") return "thinking";
  if (part.t === "call") return "call";
  if (part.t === "text") return role === "toolResult" ? "result" : "text";
  return "text";
}

function partView(part, role, key) {
  if (part.t === "thinking") {
    return disclosure(key, true, "thinking", `thinking · ${num(part.text.length)} characters`, h("pre", { class: "thinking-text", text: part.text }));
  }
  if (part.t === "call") {
    return h("div", { class: "call" }, h("div", { class: "call-name mono", text: `→ ${part.name}` }), h("pre", { class: "mono small", text: part.args }));
  }
  if (part.t === "text") {
    return role === "toolResult"
      ? disclosure(key, false, "result", `output · ${num(part.text.length)} characters`, h("pre", { class: "mono small", text: part.text }))
      : h("div", { class: "text", text: part.text });
  }
  return h("div", { class: "muted small", text: `[${part.t}]` });
}

/** The entry with only the parts the toggles and the text filter allow, or
 *  null when nothing is left. */
function visibleEntry(entry) {
  const { show, tq } = app.live;
  if (entry.event) return show.event && matches(tq, entry.event) ? entry : null;
  const parts = entry.parts.filter((p) => show[partKind(p, entry.role)]);
  if (!parts.length) return null;
  if (!parts.some((p) => matches(tq, p.text, p.name, p.args))) return null;
  return { ...entry, parts };
}

function entryView(entry) {
  if (entry.event) {
    return h("div", { class: "event muted small", text: `${entry.event.replace(/_/g, " ")} · ${when(entry.ts)}` });
  }
  const role = entry.role;
  const baseKey = `${entry.ts}|${role}`;
  const showStop = entry.stopReason && !["stop", "toolUse", "end_turn", "tool_use"].includes(entry.stopReason);
  return h(
    "article",
    { class: `entry e-${cls(role)}` },
    h(
      "div",
      { class: "entry-meta" },
      h("span", { class: `role r-${cls(role)}`, text: role === "toolResult" ? `result · ${entry.toolName ?? "tool"}` : role }),
      entry.isError ? chip("error", "bad") : null,
      h("span", { class: "muted small", text: when(entry.ts) }),
      role === "assistant" && entry.model ? h("span", { class: "muted small", text: entry.model }) : null,
      showStop ? chip(entry.stopReason, "warn") : null,
    ),
    entry.parts.map((p, i) => partView(p, role, `${baseKey}|${i}`)),
  );
}

const LIMIT_STEPS = [150, 300, 600, 1000];
const SESSION_KINDS = ["all", "chat", "main", "subagent", "cron", "hook", "heartbeat", "dream", "other"];
const PART_TOGGLES = [
  ["thinking", "Thinking"],
  ["call", "Tool calls"],
  ["result", "Tool results"],
  ["text", "Messages"],
  ["event", "Events"],
];

function renderLive() {
  const scope = inScope(app.fleet.bots.filter((b) => b.running));
  const scopeKeys = new Set(scope.map((b) => b.key));
  if (app.live.session && !scopeKeys.has(app.live.session.botKey)) {
    app.live.session = null;
    app.live.data = null;
  }
  const kindBar = h("div", { class: "pill-bar" });
  const list = h("div", { class: "session-list" }, placeholder(`Reading sessions of ${scope.length} bot${scope.length === 1 ? "" : "s"}…`));
  const pane = h("section", { class: "transcript-pane" }, empty("Choose a session on the left."));
  const sessionFilter = filterBox("Filter sessions: key, model, status, bot", app.live.q, (v) => {
    app.live.q = v;
    drawSessions();
  });
  mainEl.append(h("div", { class: "live" }, h("aside", { class: "live-side" }, kindBar, sessionFilter, list), pane));
  if (!scope.length) {
    list.replaceChildren(empty(app.selected.size ? "None of the chosen bots is running." : "No bot is running."));
    return;
  }

  const byBot = new Map();
  const errors = new Map();

  const drawKinds = () =>
    kindBar.replaceChildren(
      ...SESSION_KINDS.map((f) =>
        h("button", {
          type: "button",
          class: `pill small${app.live.filter === f ? " active" : ""}`,
          text: f,
          onclick: () => {
            app.live.filter = f;
            drawKinds();
            drawSessions();
          },
        }),
      ),
    );

  const rowId = (botKey, s) => `${botKey}|${s.key}`;

  const sessionRow = (bot, s) =>
    h(
      "button",
      {
        type: "button",
        class: `session fam-${famOf(bot)}${app.live.session && rowId(app.live.session.botKey, app.live.session) === rowId(bot.key, s) ? " active" : ""}`,
        disabled: !s.transcript,
        title: `${botLabel(bot)} · ${s.key}`,
        onclick: () => {
          app.live.session = { ...s, botKey: bot.key };
          app.live.lastSize = null;
          app.live.limit = LIMIT_STEPS[0];
          drawSessions();
          loadTranscript(true);
        },
      },
      h("div", { class: "session-top" }, botIcon(bot), h("span", { class: `kind k-${s.kind}`, text: s.kind }), h("span", { class: "muted small push", text: ago(s.updatedAt) })),
      h("div", { class: "session-key mono small", text: shortKey(s.key) }),
      h("div", {
        class: "muted small",
        text: [scope.length > 1 ? botLabel(bot) : null, s.model, s.totalTokens != null ? `${num(s.totalTokens)} tokens` : null, s.status, s.transcript ? bytes(s.transcript.size) : "no transcript"]
          .filter(Boolean)
          .join(" · "),
      }),
    );

  function drawSessions() {
    const rows = [];
    for (const bot of scope) {
      for (const s of byBot.get(bot.key) ?? []) {
        if (app.live.filter !== "all" && s.kind !== app.live.filter) continue;
        if (!matches(app.live.q, s.key, s.model, s.status, s.kind, botLabel(bot), bot.key)) continue;
        rows.push([bot, s]);
      }
    }
    rows.sort((a, b) => (toMs(b[1].updatedAt) ?? 0) - (toMs(a[1].updatedAt) ?? 0));
    const failed = scope.filter((b) => errors.has(b.key)).map((b) => h("div", { class: "error small", text: `${botLabel(b)}: ${errors.get(b.key)}` }));
    const waiting = scope.filter((b) => !byBot.has(b.key) && !errors.has(b.key));
    list.replaceChildren(
      ...failed,
      ...(rows.length ? rows.map(([bot, s]) => sessionRow(bot, s)) : [empty(waiting.length ? "Reading sessions…" : "No session matches.")]),
      ...(waiting.length && rows.length ? [h("div", { class: "muted small", text: `Still reading: ${waiting.map(botLabel).join(", ")}` })] : []),
    );
  }

  async function loadSessionsFor(bot) {
    try {
      const data = await api(`/api/bots/${encodeURIComponent(bot.key)}/sessions`);
      byBot.set(bot.key, data.sessions);
      errors.delete(bot.key);
      const current = app.live.session;
      if (current?.botKey === bot.key) {
        const fresh = data.sessions.find((s) => s.key === current.key);
        if (fresh) app.live.session = { ...fresh, botKey: bot.key };
      }
    } catch (err) {
      errors.set(bot.key, err.message);
    }
    drawSessions();
  }

  const loadSessions = () => Promise.all(scope.map(loadSessionsFor));

  async function loadTranscript(force) {
    const s = app.live.session;
    if (!s?.sessionId) return;
    if (!force && s.transcript && app.live.lastSize === s.transcript.size) return;
    try {
      const query = `agent=${encodeURIComponent(s.agent)}&session=${encodeURIComponent(s.sessionId)}&limit=${app.live.limit}`;
      const data = await api(`/api/bots/${encodeURIComponent(s.botKey)}/transcript?${query}`);
      if (rowId(s.botKey, s) !== rowId(app.live.session?.botKey, app.live.session ?? {})) return;
      app.live.lastSize = data.size;
      app.live.data = data;
      drawTranscript(force);
    } catch (err) {
      pane.replaceChildren(errorBox(err));
    }
  }

  // Built once per session choice, so typing in the filter keeps the focus.
  let chrome = null;
  function transcriptChrome() {
    const s = app.live.session;
    const bot = botByKey(s.botKey);
    const toggles = h(
      "div",
      { class: "pill-bar" },
      PART_TOGGLES.map(([k, label]) =>
        h("button", {
          type: "button",
          class: `pill small toggle${app.live.show[k] ? " active" : ""}`,
          "aria-pressed": String(app.live.show[k]),
          text: label,
          onclick: (e) => {
            app.live.show[k] = !app.live.show[k];
            e.currentTarget.classList.toggle("active", app.live.show[k]);
            e.currentTarget.setAttribute("aria-pressed", String(app.live.show[k]));
            drawTranscript(false);
          },
        }),
      ),
    );
    const meta = h("div", { class: "muted small" });
    const head = h(
      "header",
      { class: `transcript-head fam-${famOf(bot)}` },
      botIcon(bot, "md"),
      h("div", { class: "grow" }, h("h2", { class: "mono", text: shortKey(s.key) }), meta),
      controlUiLink(bot, "Open in Control UI ↗"),
    );
    const tools = h(
      "div",
      { class: "toolbar tight" },
      toggles,
      filterBox("Filter this transcript", app.live.tq, (v) => {
        app.live.tq = v;
        drawTranscript(false);
      }),
    );
    const body = h("div", { class: "transcript" });
    pane.replaceChildren(head, tools, body);
    return { key: rowId(s.botKey, s), meta, body };
  }

  function drawTranscript(force) {
    const s = app.live.session;
    const data = app.live.data;
    if (!s || !data) return;
    if (!chrome || chrome.key !== rowId(s.botKey, s)) chrome = transcriptChrome();
    const bot = botByKey(s.botKey);
    const { meta, body } = chrome;
    const visible = data.entries.map(visibleEntry).filter(Boolean);
    meta.textContent = [botLabel(bot), s.kind, s.model, `updated ${ago(s.updatedAt)}`, bytes(data.size), `showing ${visible.length} of ${data.entries.length} entries`].filter(Boolean).join(" · ");
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 160;
    const keep = body.scrollTop;
    const canLoadMore = data.entries.length >= app.live.limit && app.live.limit < LIMIT_STEPS[LIMIT_STEPS.length - 1];
    const older = canLoadMore
      ? h("button", {
          type: "button",
          class: "more center-block",
          text: `Load older entries (now the last ${app.live.limit})`,
          onclick: () => {
            app.live.limit = LIMIT_STEPS.find((n) => n > app.live.limit) ?? app.live.limit;
            loadTranscript(true);
          },
        })
      : data.truncatedHead
        ? h("div", { class: "muted small center", text: "Older entries are outside the last 6 MB of this transcript." })
        : null;
    // replaceChildren takes nodes, not arrays, and prints null as text.
    body.replaceChildren(...[older, ...(visible.length ? visible.map(entryView) : [empty("No entry matches the toggles and the filter.")])].filter(Boolean));
    if (force || atBottom) body.scrollTop = body.scrollHeight;
    else body.scrollTop = keep;
  }

  // A docker exec can take seconds on a busy fleet. A timer never starts a
  // read while the previous one is still running.
  let sessionsBusy = false;
  let transcriptBusy = false;
  const pollSessions = async () => {
    if (sessionsBusy) return;
    sessionsBusy = true;
    try {
      await loadSessions();
    } finally {
      sessionsBusy = false;
    }
  };
  const pollTranscript = async () => {
    if (transcriptBusy) return;
    transcriptBusy = true;
    try {
      await loadTranscript(false);
    } finally {
      transcriptBusy = false;
    }
  };

  drawKinds();
  if (app.live.session && app.live.data) drawTranscript(true);
  pollSessions().then(() => loadTranscript(!app.live.data));
  // One bot every 6 s; several bots every 15 s (each read is a docker exec).
  every(scope.length > 1 ? 15_000 : 6000, pollSessions);
  every(3000, pollTranscript);
}

// ── System 3: agents ──────────────────────────────────────────────────────────

const AGENT_TABS = [
  ["identity", "Identity"],
  ["soul", "Soul"],
  ["user", "User"],
  ["memory", "Memory"],
  ["dreams", "Dreams"],
  ["notes", "Notes"],
  ["reviewer", "Reviewer"],
  ["mail", "Mail"],
  ["history", "History"],
];

/** A document, or only its lines that contain the Agents filter text. */
function docView(doc, missingName = "This file") {
  if (!doc) return empty(`${missingName} does not exist.`);
  const shown = doc.truncated
    ? ` · showing the ${doc.mode === "tail" ? "last" : "first"} ${num(doc.text.length)} of ${num(doc.text.length + doc.truncated)} characters`
    : "";
  const q = app.agents.q.trim();
  let body;
  let count = "";
  if (q) {
    const lines = doc.text.split("\n");
    const hits = lines.map((line, i) => [i + 1, line]).filter(([, line]) => matches(q, line));
    count = ` · ${hits.length} of ${lines.length} lines match`;
    body = hits.length
      ? h("pre", { class: "doc-text doc-lines" }, hits.map(([n, line]) => h("span", { class: "doc-line" }, h("span", { class: "line-no", text: String(n) }), `${line}\n`)))
      : empty("No line matches the filter.");
  } else {
    body = h("pre", { class: "doc-text", text: doc.text });
  }
  return h(
    "div",
    { class: "doc" },
    h("div", { class: "doc-meta muted small" }, h("span", { class: "mono", text: doc.name }), ` · ${bytes(doc.size)} · updated ${ago(doc.mtimeMs)}${shown}${count}`),
    body,
  );
}

function dreamsView(p) {
  const phaseCard = (phase) => {
    const info = p.phases[phase];
    const last = p.dreamEvents.lastDream[phase];
    return h(
      "article",
      { class: "card phase" },
      h("header", { class: "card-head" }, h("h3", { text: phase }), h("span", { class: "muted small push", text: `${info.count} nights` })),
      last ? h("div", { class: "muted small", text: `last run ${when(last.ts)}${last.outcome ? ` · ${last.outcome}` : ""}` }) : null,
      info.latest ? docView(info.latest) : empty("No dream of this phase yet."),
    );
  };
  const promo = p.dreamEvents.lastPromotion;
  return h(
    "div",
    { class: "stack" },
    h("p", { class: "muted", text: `Schedule ${cronLabel(p.dreaming)} · ${p.dreamEvents.promotions} memory promotions in the event log${promo ? ` · last ${when(promo.ts)} (${promo.applied ?? "?"} of ${promo.candidates ?? "?"} applied)` : ""}` }),
    h("div", { class: "grid phases" }, ["light", "rem", "deep"].map(phaseCard)),
    h("h3", { text: "Dream diary" }),
    docView(p.docs.dreams, "DREAMS.md"),
  );
}

function notesView(p) {
  const list = (title, notes) => {
    const hits = notes.filter((n) => matches(app.agents.q, n.name));
    return h(
      "div",
      { class: "note-list" },
      h("h3", { text: title }),
      hits.length
        ? h("ul", { class: "items compact" }, hits.slice().reverse().map((n) => h("li", null, h("span", { class: "mono", text: n.name }), h("span", { class: "muted small", text: ` ${bytes(n.size)} · ${ago(n.mtimeMs)}` }))))
        : empty(notes.length ? "No note name matches." : "None."),
    );
  };
  return h(
    "div",
    { class: "notes-layout" },
    h("div", null, h("h3", { text: "Latest daily note" }), docView(p.notes.latestDaily, "A daily note")),
    h("div", null, list("Daily notes", p.notes.daily), list("Topic notes", p.notes.topics)),
  );
}

function reviewerView(r) {
  const verdicts = [...new Set([...Object.keys(r.window24h), ...Object.keys(r.window7d)])].sort();
  const recent = r.recent.filter((row) => matches(app.agents.q, row.verdict, row.toolName, row.principle, row.reason));
  return h(
    "div",
    { class: "stack" },
    h("p", { class: "muted", text: `${num(r.rows)} decisions in the part of reviewer-audit.jsonl that was read.` }),
    h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        { class: "table narrow" },
        h("thead", null, h("tr", null, h("th", { text: "Verdict" }), h("th", { text: "24 h" }), h("th", { text: "7 d" }))),
        h("tbody", null, verdicts.map((v) => h("tr", null, h("td", { text: v }), h("td", { class: "num", text: num(r.window24h[v] ?? 0) }), h("td", { class: "num", text: num(r.window7d[v] ?? 0) })))),
      ),
    ),
    h("h3", { text: "Latest decisions other than allow" }),
    recent.length
      ? h(
          "div",
          { class: "table-wrap" },
          h(
            "table",
            { class: "table" },
            h("thead", null, h("tr", null, ["When", "Verdict", "Tool", "Principle", "Reason"].map((t) => h("th", { text: t })))),
            h(
              "tbody",
              null,
              recent.map((row) =>
                h(
                  "tr",
                  null,
                  h("td", { class: "nowrap", text: when(row.ts) }),
                  h("td", null, chip(row.verdict, row.verdict === "deny" ? "bad" : "warn"), row.unattended ? chip("unattended", "") : null),
                  h("td", { class: "mono small", text: row.toolName ?? "" }),
                  h("td", { class: "small", text: row.principle ?? "" }),
                  h("td", { class: "small", text: row.reason }),
                ),
              ),
            ),
          ),
        )
      : empty(r.recent.length ? "No decision matches the filter." : "No escalation or denial in the part of the log that was read."),
  );
}

function mailView(mail) {
  if (!mail) return empty("This bot has no mailbox on this Mac.");
  const peers = Object.entries(mail.peers)
    .filter(([name]) => matches(app.agents.q, name))
    .sort((a, b) => b[1].sent + b[1].received - (a[1].sent + a[1].received));
  return h(
    "div",
    { class: "stack" },
    h("p", { class: "muted", text: `${num(mail.total)} messages · last ${when(mail.last)}` }),
    peers.length
      ? h(
          "div",
          { class: "table-wrap" },
          h(
            "table",
            { class: "table narrow" },
            h("thead", null, h("tr", null, h("th", { text: "Peer" }), h("th", { text: "Received" }), h("th", { text: "Sent" }))),
            h(
              "tbody",
              null,
              peers.map(([name, c]) => {
                const peer = botByKey(name);
                return h("tr", null, h("td", { class: "peer" }, peer ? botIcon(peer) : null, h("span", { class: "mono", text: name })), h("td", { class: "num", text: num(c.received) }), h("td", { class: "num", text: num(c.sent) }));
              }),
            ),
          ),
        )
      : empty(Object.keys(mail.peers).length ? "No peer matches the filter." : "No mail yet."),
  );
}

function historyView(key) {
  const wrap = h("div", { class: "stack" }, placeholder("Reading snapshot history…"));
  api(`/api/bots/${encodeURIComponent(key)}/history`)
    .then((data) => {
      const commits = data.commits.map((c) => ({ ...c, files: c.files.filter((f) => matches(app.agents.q, f.file)) })).filter((c) => c.files.length);
      if (!data.commits.length) {
        wrap.replaceChildren(empty("No snapshot yet for this agent. `make observatory-snapshot` takes one now; the nightly job takes one at 23:55."));
        return;
      }
      const diffBox = h("div", { class: "diff" });
      const loadDiff = async (sha, file) => {
        diffBox.replaceChildren(placeholder("Reading the change…"));
        try {
          const d = await api(`/api/bots/${encodeURIComponent(key)}/diff?commit=${sha}&file=${encodeURIComponent(file)}`);
          diffBox.replaceChildren(
            h("div", { class: "muted small mono", text: `${file} @ ${sha.slice(0, 8)}${d.truncated ? " (truncated)" : ""}` }),
            h(
              "pre",
              { class: "diff-text" },
              d.diff
                .split("\n")
                .slice(0, 6000)
                .map((line) => {
                  const kind = line.startsWith("@@") ? "hunk" : line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : "";
                  return h("span", { class: kind, text: `${line}\n` });
                }),
            ),
          );
          diffBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
        } catch (err) {
          diffBox.replaceChildren(errorBox(err));
        }
      };
      wrap.replaceChildren(
        h("p", { class: "muted", text: `${data.commits.length} snapshots changed this agent${app.agents.q ? `; ${commits.length} touch a file that matches the filter` : ""}. Repository: ${data.dir}` }),
        h(
          "ol",
          { class: "commits" },
          commits.map((c) =>
            h(
              "li",
              null,
              h("div", { class: "small" }, h("span", { class: "mono", text: c.sha.slice(0, 8) }), ` · ${when(c.date)}`),
              h(
                "div",
                { class: "pill-bar" },
                c.files.map((f) => h("button", { type: "button", class: "pill small", text: `${f.file} +${f.added ?? "?"} −${f.deleted ?? "?"}`, onclick: () => loadDiff(c.sha, f.file) })),
              ),
            ),
          ),
        ),
        diffBox,
      );
    })
    .catch((err) => wrap.replaceChildren(errorBox(err)));
  return wrap;
}

function cardHead(bot, size) {
  return h(
    "header",
    { class: "card-head" },
    healthDot(bot),
    botIcon(bot, size),
    h("div", { class: "card-title" }, h("h3", { text: botLabel(bot) }), h("div", { class: "muted small", text: roleText(bot) })),
  );
}

function fillAgentCard(card, data) {
  const p = data.profile;
  const b = botByKey(data.bot.key) ?? data.bot;
  const days = p.createdAtMs ? Math.floor((Date.now() - p.createdAtMs) / 86_400_000) : null;
  const lastDeep = p.dreamEvents.lastDream.deep?.ts ?? p.phases.deep.latest?.mtimeMs;
  const r7 = p.reviewer.window7d;
  const peers = data.mail
    ? Object.entries(data.mail.peers)
        .map(([name, c]) => [name, c.sent + c.received])
        .sort((x, y) => y[1] - x[1])
        .slice(0, 4)
    : [];
  card.replaceChildren(
    cardHead(b, "lg"),
    h(
      "dl",
      { class: "facts" },
      fact("Age", days == null ? "—" : `${days} days · born ${when(p.createdAtMs)}`),
      fact("Model", p.model ?? "—"),
      fact("Dreams", `${cronLabel(p.dreaming)}${lastDeep ? ` · last deep ${ago(lastDeep)}` : ""}`),
      fact("Memory", p.docs.memory ? `${bytes(p.docs.memory.size)} · updated ${ago(p.docs.memory.mtimeMs)}` : "none"),
      fact("Reviewer, 7 d", ["allow", "escalate", "deny"].map((v) => `${v} ${num(r7[v] ?? 0)}`).join(" · ")),
      fact("Mail", peers.length ? peers.map(([name, n]) => `${name} ${n}`).join(" · ") : "—"),
    ),
  );
}

function renderAgents() {
  const all = inScope(app.fleet.bots);
  const bots = all.filter((b) => b.running);
  const stopped = all.filter((b) => !b.running);
  const grid = h("div", { class: "grid agents" });
  const detail = h("section", { class: "agent-detail" });
  mainEl.append(section("Agents", "Who each agent is. Profiles refresh each minute. The History tab uses the nightly snapshot.", grid), detail);
  if (app.agents.bot && !bots.some((b) => b.key === app.agents.bot)) app.agents.bot = null;

  const cards = new Map();
  const selectAgent = (key) => {
    app.agents.bot = key;
    for (const [k, card] of cards) card.classList.toggle("active", k === key);
    drawDetail();
    detail.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  for (const b of bots) {
    const card = h("article", { class: `card agent-card fam-${famOf(b)}`, tabindex: "0", role: "button", "aria-label": `Show ${botLabel(b)}` }, cardHead(b, "lg"), placeholder("Reading…"));
    card.addEventListener("click", () => selectAgent(b.key));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectAgent(b.key);
      }
    });
    cards.set(b.key, card);
    grid.append(card);
    if (app.profiles.has(b.key)) fillAgentCard(card, app.profiles.get(b.key));
  }
  for (const b of stopped) {
    grid.append(h("article", { class: `card agent-card stopped fam-${famOf(b)}` }, cardHead(b, "lg"), empty(`${b.container} is ${b.state}. Its profile needs a running container.`)));
  }
  if (!all.length) grid.append(empty("No chosen bot."));

  // Built once per chosen agent, so typing keeps the focus in the filter.
  let body = null;
  let tabs = null;
  function drawBody() {
    const key = app.agents.bot;
    const data = app.profiles.get(key);
    if (!body || !data) return;
    const p = data.profile;
    const views = {
      identity: () => [docView(p.docs.identity, "IDENTITY.md"), docView(p.docs.heartbeat, "HEARTBEAT.md")],
      soul: () => docView(p.docs.soul, "SOUL.md"),
      user: () => docView(p.docs.user, "USER.md"),
      memory: () => docView(p.docs.memory, "MEMORY.md"),
      dreams: () => dreamsView(p),
      notes: () => notesView(p),
      reviewer: () => reviewerView(p.reviewer),
      mail: () => mailView(data.mail),
      history: () => historyView(key),
    };
    body.replaceChildren(...[views[app.agents.tab]?.() ?? []].flat());
  }
  function drawTabs() {
    tabs.replaceChildren(
      ...AGENT_TABS.map(([id, label]) =>
        h("button", {
          type: "button",
          class: `subtab${app.agents.tab === id ? " active" : ""}`,
          text: label,
          onclick: () => {
            app.agents.tab = id;
            drawTabs();
            drawBody();
          },
        }),
      ),
    );
  }
  function drawDetail() {
    const key = app.agents.bot;
    if (!key) {
      detail.replaceChildren();
      body = null;
      return;
    }
    const bot = botByKey(key);
    if (!app.profiles.get(key)) {
      detail.replaceChildren(placeholder("Reading…"));
      body = null;
      return;
    }
    tabs = h("nav", { class: "subtabs", "aria-label": "Agent detail" });
    body = h("div", { class: "detail-body" });
    detail.className = `agent-detail fam-${famOf(bot)}`;
    detail.replaceChildren(
      h(
        "header",
        { class: "detail-head" },
        botIcon(bot, "lg"),
        h("div", { class: "grow" }, h("h2", { text: botLabel(bot) }), h("div", { class: "muted small", text: roleText(bot) })),
        filterBox("Filter lines in this tab", app.agents.q, (v) => {
          app.agents.q = v;
          drawBody();
        }),
        controlUiLink(bot),
      ),
      tabs,
      body,
    );
    drawTabs();
    drawBody();
  }

  const load = () =>
    Promise.all(
      bots.map((b) =>
        api(`/api/bots/${encodeURIComponent(b.key)}/profile`)
          .then((data) => {
            const firstLoad = !app.profiles.has(b.key);
            app.profiles.set(b.key, data);
            fillAgentCard(cards.get(b.key), data);
            // Redraw an open detail only on its first load, so a refresh does
            // not reset the reader's scroll position or an open diff.
            if (app.agents.bot === b.key && firstLoad) drawDetail();
          })
          .catch((err) => cards.get(b.key)?.replaceChildren(cardHead(b, "lg"), errorBox(err))),
      ),
    );

  if (app.agents.bot) {
    cards.get(app.agents.bot)?.classList.add("active");
    drawDetail();
  }
  let loading = null;
  const loadOnce = () => (loading ??= load().finally(() => (loading = null)));
  loadOnce();
  every(60_000, loadOnce);
}

// ── feedback: change requests ─────────────────────────────────────────────────
//
// A drawer on the right edge of every view. It takes text and screenshots and
// queues them as a change request (scripts/claw-observatory-feedback.mjs).
// `make feedback-pull` writes the new requests to .swarm/feedback/.
//
// Screenshots come three ways, because no single way works everywhere:
//   Capture screen  getDisplayMedia; desktop browsers only. The drawer hides
//                   itself for the frame, so it is not in the picture.
//   Add image       a file picker.
//   Paste           an image on the clipboard, into the text box.
// Each image is made smaller before upload: longest side at most 2560 px, and
// PNG, JPEG or WebP only.

const FB_MAX_CHARS = 4000;
const FB_MAX_FILES = 6;
const FB_MAX_BYTES = 10 * 1024 * 1024;
const FB_MAX_SIDE = 2560;
const FB_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const FB_OPEN_KEY = "claw-observatory-feedback-open";
const FB_DRAFT_KEY = "claw-observatory-feedback-draft";
const FB_STATUS_TEXT = { new: "received", queued: "queued", in_progress: "in progress", done: "done", declined: "declined" };

function remember(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // storage can be blocked; the drawer still works
  }
}

function recall(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function canvasBlob(canvas, type, quality) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("could not encode the image"))), type, quality),
  );
}

async function decodeImage(blob) {
  try {
    return await createImageBitmap(blob);
  } catch {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } catch {
      throw new Error("the browser cannot read this image");
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

async function normaliseImage(blob) {
  const img = await decodeImage(blob);
  const scale = Math.min(1, FB_MAX_SIDE / Math.max(img.width, img.height));
  if (scale === 1 && FB_TYPES.has(blob.type) && blob.size <= FB_MAX_BYTES) return blob;
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  let out = await canvasBlob(c, blob.type === "image/png" ? "image/png" : "image/jpeg", 0.9);
  if (out.size > FB_MAX_BYTES) out = await canvasBlob(c, "image/jpeg", 0.8);
  if (out.size > FB_MAX_BYTES) throw new Error("the image is too large, also after resizing");
  return out;
}

async function grabScreen(hide) {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: "browser" },
    audio: false,
    preferCurrentTab: true,
    selfBrowserSurface: "include",
  });
  const video = document.createElement("video");
  try {
    hide(true);
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    // Two frames for the drawer to go, then a short wait for the browser's
    // "sharing this tab" bar.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise((r) => setTimeout(r, 250));
    const c = document.createElement("canvas");
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.getContext("2d").drawImage(video, 0, 0);
    return await canvasBlob(c, "image/png");
  } finally {
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
    hide(false);
  }
}

const clip = (v, n = 200) => (v == null ? null : String(v).slice(0, n));

/** Where the request was written. The server adds the build. */
function feedbackContext() {
  const ctx = {
    view: app.view,
    viewport: `${innerWidth}x${innerHeight}`,
    pixelRatio: devicePixelRatio,
    colorScheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  };
  if (app.fleet) {
    ctx.fleet = `${app.fleet.bots.filter((b) => b.running).length} of ${app.fleet.bots.length} bots running`;
  }
  if (app.selected.size) ctx.chosenBots = [...app.selected].slice(0, 12);
  if (app.view === "work") {
    if (app.work.q) ctx.filter = clip(app.work.q);
    if (app.work.state !== "all") ctx.itemState = app.work.state;
  } else if (app.view === "live") {
    ctx.kind = app.live.filter;
    if (app.live.q) ctx.filter = clip(app.live.q);
    if (app.live.session) {
      ctx.bot = clip(app.live.session.botKey);
      ctx.session = clip(app.live.session.key, 300);
      ctx.sessionKind = clip(app.live.session.kind);
      ctx.transcriptLimit = app.live.limit;
    }
  } else if (app.view === "agents") {
    ctx.bot = clip(app.agents.bot);
    ctx.agentTab = app.agents.tab;
  }
  return ctx;
}

function mountFeedback() {
  const shots = [];
  let busy = false;
  const canCapture = typeof navigator.mediaDevices?.getDisplayMedia === "function";

  const tab = h("button", { type: "button", class: "fb-tab", title: "Request a change to the observatory", text: "feedback" });
  const text = h("textarea", {
    class: "fb-text",
    maxlength: String(FB_MAX_CHARS),
    rows: "6",
    "aria-label": "What should change",
    placeholder: "What should change? What did you expect to see? Paste a screenshot here.",
  });
  text.value = recall(FB_DRAFT_KEY) ?? "";
  const counter = h("span", { class: "muted small" });
  const fileInput = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/*", multiple: true, hidden: true });
  const captureBtn = canCapture ? h("button", { type: "button", class: "button", text: "Capture screen" }) : null;
  const addBtn = h("button", { type: "button", class: "button", text: "Add image" });
  const shotList = h("ul", { class: "fb-shots" });
  const contextBtn = h("button", { type: "button", class: "fb-link", text: "Show what is attached automatically" });
  const contextBox = h("pre", { class: "fb-context mono small", hidden: true });
  // R5: the bots that get this request by console mail. Starts on the
  // server's default (the primary Oasis-X bots) once the fleet is known.
  let recipients = null;
  const toRow = h("div", { class: "fb-to", role: "group", "aria-label": "Send to" });
  const renderTo = () => {
    const bots = app.fleet?.bots ?? [];
    recipients ??= app.fleet ? new Set(app.fleet.feedback?.defaultTo ?? []) : null;
    toRow.replaceChildren(
      h("span", { class: "muted small", text: "Send to" }),
      ...bots.map((b) => {
        const on = recipients?.has(b.key) ?? false;
        return h(
          "button",
          {
            type: "button",
            class: `bot-chip small fam-${famOf(b)}${on ? " active" : ""}`,
            "aria-pressed": String(on),
            title: on ? `${botLabel(b)} gets this request by mail. Click to remove.` : `Click to send this request to ${botLabel(b)} too.`,
            onclick: () => {
              recipients ??= new Set();
              if (on) recipients.delete(b.key);
              else recipients.add(b.key);
              renderTo();
            },
          },
          botIcon(b),
          h("span", { class: "bot-chip-name", text: botLabel(b) }),
        );
      }),
    );
  };
  const sendBtn = h("button", { type: "button", class: "button fb-send", text: "Send" });
  const notice = h("span", { class: "fb-notice small", role: "status" });
  const recentList = h("ul", { class: "fb-recent" });
  const closeBtn = h("button", { type: "button", class: "fb-x", "aria-label": "Close", text: "×" });
  const drawer = h(
    "aside",
    { class: "fb-drawer", role: "dialog", "aria-label": "Request a change", hidden: true },
    h("header", { class: "fb-head" }, h("strong", { text: "Request a change" }), closeBtn),
    text,
    h("div", { class: "fb-row" }, counter, h("span", { class: "fb-spacer" }), h("span", { class: "muted small", text: "⌘↵ sends · esc closes" })),
    h("div", { class: "fb-row" }, captureBtn, addBtn, fileInput),
    shotList,
    toRow,
    h("p", { class: "muted small", text: "The chosen bots get the text and the page context by console mail. Screenshots stay on this Mac, in a folder that no bot mounts. `make feedback-pull` copies only the text to oasis-claw/.swarm/feedback/, which House and Yes Man can read." }),
    contextBtn,
    contextBox,
    h("div", { class: "fb-row" }, sendBtn, notice),
    h("section", null, h("h3", { class: "fb-recent-head", text: "Recent requests" }), recentList),
  );
  document.body.append(tab, drawer);

  const say = (message, tone) => {
    notice.textContent = message ?? "";
    notice.className = `fb-notice small${tone ? ` ${tone}` : ""}`;
  };

  const refresh = () => {
    counter.textContent = `${text.value.length} / ${FB_MAX_CHARS}`;
    const full = shots.length >= FB_MAX_FILES;
    if (captureBtn) captureBtn.disabled = busy || full;
    addBtn.disabled = busy || full;
    sendBtn.disabled = busy || !text.value.trim();
    shotList.replaceChildren(
      ...shots.map((s) =>
        h(
          "li",
          null,
          h("img", { src: s.url, alt: s.name }),
          h("button", { type: "button", class: "fb-x", "aria-label": `Remove ${s.name}`, text: "×", onclick: () => removeShot(s.id) }),
          h("span", { class: "muted small", text: bytes(s.blob.size) }),
        ),
      ),
    );
    if (!contextBox.hidden) contextBox.textContent = JSON.stringify(feedbackContext(), null, 1);
  };

  const removeShot = (id) => {
    const i = shots.findIndex((s) => s.id === id);
    if (i >= 0) {
      URL.revokeObjectURL(shots[i].url);
      shots.splice(i, 1);
    }
    refresh();
  };

  async function addBlobs(items) {
    say(null);
    for (const item of items) {
      if (shots.length >= FB_MAX_FILES) {
        say(`At most ${FB_MAX_FILES} images.`, "bad-text");
        break;
      }
      try {
        const blob = await normaliseImage(item.blob);
        const ext = blob.type === "image/jpeg" ? "jpg" : blob.type.split("/")[1];
        const name = `${item.name.replace(/\.[^.]+$/, "") || "image"}.${ext}`;
        shots.push({ id: crypto.randomUUID(), blob, name, url: URL.createObjectURL(blob) });
      } catch (err) {
        say(`${item.name}: ${err.message}`, "bad-text");
      }
    }
    refresh();
  }

  async function loadRecent() {
    try {
      const { feedback } = await api("/api/feedback?limit=8");
      recentList.replaceChildren(
        ...(feedback.length
          ? feedback.map((f) =>
              h(
                "li",
                { title: f.body },
                h("span", { class: `chip fb-${cls(f.status)}`, text: FB_STATUS_TEXT[f.status] ?? f.status }),
                h("span", { class: "mono small", text: f.ref }),
                h("span", { class: "fb-first", text: f.body.split("\n")[0] }),
                f.attachments.length ? h("span", { class: "muted small", text: `${f.attachments.length} img` }) : null,
                f.deliveries?.some((d) => d.mailId)
                  ? h("span", { class: "muted small", title: f.deliveries.filter((d) => d.mailId).map((d) => d.bot).join(", "), text: `→ ${f.deliveries.filter((d) => d.mailId).length} bots` })
                  : null,
                f.status === "new"
                  ? h("button", { type: "button", class: "fb-link", text: "withdraw", onclick: () => withdraw(f) })
                  : null,
              ),
            )
          : [h("li", { class: "muted small", text: "None yet." })]),
      );
    } catch (err) {
      recentList.replaceChildren(h("li", { class: "bad-text small", text: err.message }));
    }
  }

  async function withdraw(f) {
    if (!confirm(`Withdraw ${f.ref}? The text and its images are deleted.`)) return;
    try {
      await api(`/api/feedback/${f.id}`, { method: "DELETE" });
      say(`${f.ref} withdrawn.`, "ok-text");
    } catch (err) {
      say(`Not withdrawn: ${err.message}`, "bad-text");
    }
    loadRecent();
  }

  async function send() {
    const body = text.value.trim();
    if (!body || busy) return;
    busy = true;
    refresh();
    say("Sending…");
    try {
      const created = await api("/api/feedback", {
        method: "POST",
        type: "application/json",
        body: JSON.stringify({
          body,
          context: feedbackContext(),
          files: shots.map((s) => ({ name: s.name, contentType: s.blob.type, bytes: s.blob.size })),
          ...(recipients ? { to: [...recipients] } : {}),
        }),
      });
      for (let i = 0; i < shots.length; i++) {
        say(`Uploading image ${i + 1} of ${shots.length}…`);
        await api(`/api/feedback/${created.id}/files/${i + 1}`, { method: "PUT", type: shots[i].blob.type, body: shots[i].blob });
      }
      const done = await api(`/api/feedback/${created.id}/submit`, { method: "POST" });
      shots.splice(0).forEach((s) => URL.revokeObjectURL(s.url));
      text.value = "";
      remember(FB_DRAFT_KEY, null);
      const mailed = (done.deliveries ?? []).filter((d) => d.mailId).map((d) => botLabel(botByKey(d.bot) ?? { key: d.bot }));
      const failed = (done.deliveries ?? []).filter((d) => d.error).map((d) => `${d.bot} (${d.error})`);
      if (failed.length) say(`${done.ref} is in the queue. Mail failed for ${failed.join(", ")}.`, "bad-text");
      else if (mailed.length) say(`${done.ref} sent to ${mailed.join(", ")}.`, "ok-text");
      else say(`${done.ref} is in the queue. No bot was chosen, so no mail went out.`, "ok-text");
      loadRecent();
    } catch (err) {
      say(`Not sent: ${err.message}`, "bad-text");
    } finally {
      busy = false;
      refresh();
    }
  }

  const setOpen = (open) => {
    drawer.hidden = !open;
    tab.hidden = open;
    remember(FB_OPEN_KEY, open ? "1" : null);
    if (open) {
      if (!busy) say(null);
      renderTo();
      refresh();
      loadRecent();
      requestAnimationFrame(() => text.focus());
    }
  };

  tab.addEventListener("click", () => setOpen(true));
  // The drawer can open (restored from the last visit) before the fleet read
  // arrives; draw the recipients again once the bot bar has the fleet.
  window.addEventListener("observatory:bots", () => {
    if (!drawer.hidden) renderTo();
  });
  closeBtn.addEventListener("click", () => setOpen(false));
  addBtn.addEventListener("click", () => fileInput.click());
  sendBtn.addEventListener("click", send);
  captureBtn?.addEventListener("click", async () => {
    try {
      const blob = await grabScreen((hidden) => drawer.classList.toggle("fb-hidden", hidden));
      await addBlobs([{ blob, name: `screen-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}.png` }]);
    } catch (err) {
      if (err.name !== "NotAllowedError") say(`Capture failed: ${err.message}`, "bad-text");
    }
  });
  fileInput.addEventListener("change", () => {
    const files = [...(fileInput.files ?? [])];
    fileInput.value = "";
    addBlobs(files.map((f) => ({ blob: f, name: f.name })));
  });
  contextBtn.addEventListener("click", () => {
    contextBox.hidden = !contextBox.hidden;
    contextBtn.textContent = `${contextBox.hidden ? "Show" : "Hide"} what is attached automatically`;
    refresh();
  });
  text.addEventListener("input", () => {
    remember(FB_DRAFT_KEY, text.value || null);
    refresh();
  });
  text.addEventListener("paste", (e) => {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
    if (files.length) {
      e.preventDefault();
      addBlobs(files.map((f, i) => ({ blob: f, name: f.name || `pasted-${i + 1}.png` })));
    }
  });
  drawer.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") setOpen(false);
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  });

  setOpen(recall(FB_OPEN_KEY) === "1");
}

// ── boot ──────────────────────────────────────────────────────────────────────

async function boot() {
  renderTabs();
  if (!TOKEN) {
    renderLocked(new Error("This page has no access key yet."));
    return;
  }
  mountFeedback();
  // The first fleet read runs docker ps/inspect and can take several seconds.
  mainEl.replaceChildren(placeholder("Reading the fleet…"));
  if (!(await refreshFleet(true))) return;
  renderView();
  // Every 15 s; every 3 s while a bot's face and role are still being read.
  let fleetBusy = false;
  let lastRead = Date.now();
  setInterval(async () => {
    if (document.visibilityState !== "visible" || fleetBusy) return;
    const reading = app.fleet?.bots.some((b) => b.identity?.reading);
    if (!reading && Date.now() - lastRead < 15_000) return;
    fleetBusy = true;
    try {
      await refreshFleet(false);
      lastRead = Date.now();
    } finally {
      fleetBusy = false;
    }
  }, 3000);
}

boot();
