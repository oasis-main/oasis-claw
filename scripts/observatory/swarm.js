// Fleet Observatory background swarm (Mike, 2026-10-07, R4).
//
// A faint swarm of rings behind the widgets, one color for each bot in view
// (the bot's role-family color from app.css). Each ring links to its nearest
// neighbors, so the swarm draws a moving net. The links stop at the ring edge:
// the ring interiors are cut out of the net before the rings are drawn.
//
// Revision 3 (Mike, 2026-10-08: "too much simplex shading … an oscillating
// energy wave / field … slightly too little cursor responsiveness … much less
// alive than we would like"). The v2 swarm moved as one field because every
// dot had the same speed and aligned with every dot near it. Now each dot is
// its own small animal:
//
//   - a temperament set at birth: its cruise pace, how fast it turns, its
//     size, and whether it is shy or curious about the cursor;
//   - modes that change on its own clock: roam, follow (trail another dot of
//     its bot, so short chains form and break), and rest;
//   - darts: a short sprint on a new heading every few seconds. A dart can
//     startle the dots next to it, and they dart too (two steps at most);
//   - the cursor: shy dots flee, and a fast sweep startles them; curious dots
//     come to circle the cursor and lose interest when it stops moving. A
//     resting cursor keeps only a small clear space round it;
//   - a ring is brighter when its dot moves fast and dimmer when it rests.
//
// Alignment acts only between dots of one bot, at short range. A weak long
// range spread keeps the dots over the whole page. Only small triangles of
// the net get a fill, and that fill is very faint.
//
// The bot bar does not set the dots directly. It sends the bots in view
// ("observatory:bots"), and each bot's dots then fly in from the screen
// edges or leave through them over a second or two. A new choice while dots
// are still flying turns them around: entering dots leave again, and leaving
// dots rejoin.
//
// The settings page (Mike, 2026-10-08) changes the parameters in SPEC while
// the swarm runs, through window.observatorySwarm.set().
//
// The swarm stops while the tab is hidden. With "reduce motion" set, it draws
// still rings and never animates.
(function () {
  "use strict";

  // Fixed timings and forces (not on the settings page).
  const TOTAL_MIN = 70;
  const SPAWN_EVERY_MS = 40; // per bot, while it is short of dots
  const LEAVE_STAGGER_MS = 900;
  const SETTLE_MS = 900; // an entering dot joins the swarm after this long on screen
  const W_HOME_ENTER = 0.0026; // an entering dot heads for its own target point
  const WALL_PAD = 36;
  const W_WALL = 0.012;
  const FOLLOW_REACH = 150;
  const DART_MS_MIN = 260;
  const DART_MS_MAX = 560;
  const W_DART = 0.14;
  const CURSOR_REST = 0.25;
  const CURSOR_MIN_OUT = 0.8;
  const ACC_CAP = 0.2;
  const ACC_CAP_ACTIVE = 0.55; // darting, or near the cursor
  const V_CAP_FLIGHT = 2.8;
  const EXIT_SPEED = 2.4;
  const EDGE_OUT = 14; // a dot spawns and despawns this far past the edge

  // The parameters the settings page can change (Mike, 2026-10-08):
  // [name, default, min, max, step, group, label, hint]. P holds the current values;
  // window.observatorySwarm.set() changes them while the swarm runs.
  const SPEC = [
    ["AREA_PER_DOT", 11000, 3000, 40000, 500, "Count", "Window area for each dot (px²)", "How much window area each dot gets. Lower gives more dots; the page count still stays between the fewest and most limits."],
    ["TOTAL_MAX", 240, 30, 500, 10, "Count", "Most dots on the page", "The upper limit on dots for all bots together, whatever the window size."],
    ["PER_BOT_MIN", 12, 2, 40, 1, "Count", "Fewest dots for each bot", "Each bot in view gets at least this many dots, even in a small window."],
    ["FILLED", 0, 0, 1, 1, "Bodies", "Filled dots instead of rings", "On: solid dots. Off: hollow rings. Links never cross the inside of either."],
    ["RING_MIN", 2.2, 0.8, 8, 0.1, "Bodies", "Smallest radius (px)", "Each dot gets a random radius between the smallest and the largest at birth."],
    ["RING_MAX", 3.8, 0.8, 10, 0.1, "Bodies", "Largest radius (px)", "Each dot gets a random radius between the smallest and the largest at birth."],
    ["RING_WIDTH", 1.1, 0.3, 3, 0.1, "Bodies", "Ring line width (px)", "The line width of a hollow ring."],
    ["RING_ALPHA", 0.26, 0.03, 1, 0.01, "Bodies", "Opacity at rest", "How visible a dot is when it moves slowly. Dark mode adds a little."],
    ["RING_SPEED_GLOW", 0.32, 0, 0.8, 0.01, "Bodies", "Extra opacity at full speed", "Extra visibility for a fast dot, so darts and chases stand out."],
    ["RING_GAP", 1.6, 0, 6, 0.1, "Bodies", "Clear space round each body (px)", "Empty space between a dot's edge and the links that reach it."],
    ["LINK_K", 3, 0, 8, 1, "Net", "Links from each dot", "How many nearest neighbors each dot links to. 0 removes the net."],
    ["LINK_DIST", 140, 40, 300, 5, "Net", "Longest link (px)", "Dots further apart than this never link. A link fades as it gets longer."],
    ["LINK_ALPHA", 0.15, 0, 0.6, 0.01, "Net", "Link opacity", "How visible a short link is. A link between a follower and its lead is brighter."],
    ["LINK_WIDTH", 0.7, 0.2, 2.5, 0.1, "Net", "Link width (px)", "The line width of each link."],
    ["TRI_ALPHA", 0.014, 0, 0.12, 0.002, "Net", "Triangle fill opacity", "Shading inside a small triangle of three linked dots. 0 removes all shading."],
    ["TRI_EDGE", 80, 0, 300, 5, "Net", "Longest side of a filled triangle (px)", "Only triangles with every side shorter than this get shading."],
    ["SEP_DIST", 44, 5, 150, 1, "Spacing", "Personal space (px)", "Inside this distance, dots push each other away firmly."],
    ["W_SEP", 0.22, 0, 1, 0.01, "Spacing", "Personal space push", "How hard dots push away inside their personal space."],
    ["SPREAD_DIST", 115, 0, 300, 5, "Spacing", "Spread reach (px)", "A weak push that reaches further and keeps the dots spread over the page."],
    ["W_SPREAD", 0.03, 0, 0.3, 0.005, "Spacing", "Spread push", "How hard the long-range spread pushes. Higher gives an even grid; lower lets groups form."],
    ["ALIGN_DIST", 60, 0, 200, 5, "Spacing", "Same-bot alignment reach (px)", "Dots of one bot within this distance turn toward each other's direction."],
    ["W_ALIGN", 0.02, 0, 0.2, 0.005, "Spacing", "Same-bot alignment strength", "How strongly dots of one bot match direction. High values make the swarm move like one field."],
    ["PACE_MIN", 0.35, 0, 3, 0.05, "Motion", "Slowest cruise (px/frame)", "Each dot gets its own cruise speed between the slowest and the fastest."],
    ["PACE_MAX", 1.05, 0, 3, 0.05, "Motion", "Fastest cruise (px/frame)", "Each dot gets its own cruise speed between the slowest and the fastest."],
    ["REST_PACE", 0.1, 0, 1, 0.02, "Motion", "Resting speed (px/frame)", "The speed of a dot that rests."],
    ["W_STEER", 0.045, 0.005, 0.3, 0.005, "Motion", "Steering strength", "How quickly a dot turns toward where it wants to go. Low is lazy; high is twitchy."],
    ["DAMPING", 0.99, 0.9, 1, 0.001, "Motion", "Glide (1 = no drag)", "How much speed a dot keeps each frame. 1 means it never slows by itself."],
    ["V_CAP", 1.8, 0.2, 6, 0.1, "Motion", "Top cruise speed (px/frame)", "No dot cruises faster than this (darts and cursor escapes may go faster)."],
    ["FOLLOW_SHARE", 0.32, 0, 1, 0.01, "Motion", "Chance a new mode is follow", "When a dot picks a new mode, the chance that it follows another dot of its bot. Chains form from this."],
    ["REST_SHARE", 0.14, 0, 1, 0.01, "Motion", "Chance a new mode is rest", "When a dot picks a new mode, the chance that it rests for a moment."],
    ["FOLLOW_GAP", 20, 0, 100, 1, "Motion", "Follow distance (px)", "How far behind its lead a following dot stays."],
    ["DART_EVERY_MIN", 6000, 500, 60000, 500, "Darts", "Shortest time between darts (ms)", "Each dot sprints at a random time between the shortest and the longest interval."],
    ["DART_EVERY_MAX", 22000, 500, 90000, 500, "Darts", "Longest time between darts (ms)", "Each dot sprints at a random time between the shortest and the longest interval."],
    ["DART_SPEED_MIN", 2.3, 0.5, 8, 0.1, "Darts", "Slowest dart (px/frame)", "Each sprint gets a speed between the slowest and the fastest."],
    ["DART_SPEED_MAX", 3.3, 0.5, 8, 0.1, "Darts", "Fastest dart (px/frame)", "Each sprint gets a speed between the slowest and the fastest."],
    ["V_CAP_DART", 3.6, 0.5, 10, 0.1, "Darts", "Top dart speed (px/frame)", "No sprint goes faster than this."],
    ["STARTLE_P", 0.35, 0, 1, 0.01, "Darts", "Chance a neighbor darts too", "When a dot sprints, the chance that each of its linked neighbors sprints with it."],
    ["STARTLE_DEPTH", 2, 0, 6, 1, "Darts", "Steps a startle spreads", "How many steps a startle can pass on: 1 means only direct neighbors, 0 means none."],
    ["SHY_SHARE", 0.4, 0, 1, 0.01, "Cursor", "Share of shy dots", "The share of dots that flee the cursor and get startled by fast cursor moves."],
    ["CURIOUS_SHARE", 0.35, 0, 1, 0.01, "Cursor", "Share of curious dots", "The share of dots that come to circle a moving cursor. The rest only step aside."],
    ["CURSOR_FAR", 240, 0, 600, 10, "Cursor", "Reach of a moving cursor (px)", "How far a moving cursor pushes shy and ordinary dots."],
    ["CURSOR_NEAR", 90, 0, 400, 5, "Cursor", "Reach of a resting cursor (px)", "How far a cursor that has stopped still pushes dots, so a resting cursor does not keep a big hole."],
    ["CURSOR_SETTLE_MS", 1500, 0, 10000, 100, "Cursor", "Time until the cursor counts as resting (ms)", "How long the cursor must stay still before its reach shrinks to the resting reach."],
    ["W_FLEE", 1.7, 0, 5, 0.05, "Cursor", "Shy flee strength", "How hard shy dots flee the cursor."],
    ["W_NEUTRAL", 1.1, 0, 5, 0.05, "Cursor", "Other dots' push strength", "How hard ordinary dots step aside from the cursor."],
    ["V_CAP_CURSOR", 2.7, 0.2, 8, 0.1, "Cursor", "Top speed near the cursor (px/frame)", "Dots near the cursor may move up to this speed."],
    ["STARTLE_CURSOR", 5, 1, 40, 1, "Cursor", "Cursor speed that startles (px/frame)", "A cursor that moves faster than this startles shy dots into a sprint. Lower startles more easily."],
    ["CURIOUS_FAR", 360, 0, 900, 10, "Cursor", "Curious dots notice from (px)", "Curious dots notice a moving cursor from this far away."],
    ["ORBIT_R", 62, 10, 300, 2, "Cursor", "Orbit radius (px)", "The distance at which curious dots circle the cursor."],
    ["W_ORBIT_RADIAL", 0.13, 0, 0.6, 0.01, "Cursor", "Orbit pull", "How strongly curious dots hold their circling distance."],
    ["W_ORBIT_SPIN", 0.1, 0, 0.6, 0.01, "Cursor", "Orbit spin", "How fast curious dots circle round the cursor."],
    ["INTEREST_MS", 2500, 0, 15000, 100, "Cursor", "Curious interest after the cursor stops (ms)", "Curious dots lose interest this long after the cursor stops."],
    ["MOUSE_R", 26, 0, 120, 1, "Cursor", "Hard contact radius (px)", "Dots bounce off the cursor at this distance."],
  ];
  const DEFAULTS = Object.fromEntries(SPEC.map((r) => [r[0], r[1]]));
  const P = { ...DEFAULTS };
  const TAU = Math.PI * 2;

  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const darkScheme = matchMedia("(prefers-color-scheme: dark)");

  const canvas = document.createElement("canvas");
  canvas.id = "swarm-bg";
  canvas.setAttribute("aria-hidden", "true");
  const ctx = canvas.getContext("2d");
  let dpr = 1;
  let W = 0;
  let H = 0;

  let dots = [];
  /** key → { family, color, want, lastSpawn, slot } */
  const bots = new Map();
  let order = []; // keys in view, in bot-bar order
  let mx = -9999;
  let my = -9999;
  let mvx = 0;
  let mvy = 0;
  let mouseMovedAt = -1e9;
  let raf = 0;
  let lastT = 0;
  let clock = 0;

  const rand = (a, b) => a + Math.random() * (b - a);

  // ── colors ───────────────────────────────────────────────────────────────
  // The family color is read from app.css, so the swarm follows the theme.
  const probe = document.createElement("span");
  probe.style.display = "none";

  function familyColor(family) {
    probe.className = `fam-${family}`;
    const raw = getComputedStyle(probe).getPropertyValue("--fam").trim();
    const m = raw.match(/^#([0-9a-f]{6})$/i);
    if (!m) return [128, 128, 128];
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  /** Two bots of one family get two shades of the family color. */
  function recolor() {
    const seen = new Map();
    for (const key of order) {
      const b = bots.get(key);
      const rank = seen.get(b.family) ?? 0;
      seen.set(b.family, rank + 1);
      const [r, g, bl] = familyColor(b.family);
      const toward = darkScheme.matches ? 255 : 0;
      const t = Math.min(0.5, rank * 0.28);
      const mix = (c) => Math.round(c + (toward - c) * t);
      b.color = `rgb(${mix(r)},${mix(g)},${mix(bl)})`;
    }
  }

  // ── geometry ─────────────────────────────────────────────────────────────

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (order.length) {
      const want = wantPerBot();
      for (const key of order) bots.get(key).want = want;
      rebalance(false);
    }
    if (reduceMotion.matches) placeStill();
    else start();
  }

  /** A random point well inside the window: where an entering dot heads. */
  function interior() {
    return {
      x: WALL_PAD + Math.random() * Math.max(1, W - 2 * WALL_PAD),
      y: WALL_PAD + Math.random() * Math.max(1, H - 2 * WALL_PAD),
    };
  }

  /** Dots for each bot in view, from the window area. */
  function wantPerBot() {
    if (!order.length) return 0;
    const total = Math.min(P.TOTAL_MAX, Math.max(TOTAL_MIN, Math.round((W * H) / P.AREA_PER_DOT)));
    return Math.max(P.PER_BOT_MIN, Math.round(total / order.length));
  }

  function edgePoint() {
    const side = Math.floor(Math.random() * 4);
    const u = Math.random();
    if (side === 0) return { x: -EDGE_OUT, y: u * H };
    if (side === 1) return { x: W + EDGE_OUT, y: u * H };
    if (side === 2) return { x: u * W, y: -EDGE_OUT };
    return { x: u * W, y: H + EDGE_OUT };
  }

  /** The nearest way off the screen for a dot at (x, y). */
  function exitFor(x, y) {
    const d = [x, W - x, y, H - y];
    const i = d.indexOf(Math.min(...d));
    const far = EDGE_OUT * 3;
    if (i === 0) return { x: -far, y };
    if (i === 1) return { x: W + far, y };
    if (i === 2) return { x, y: -far };
    return { x, y: H + far };
  }

  const offscreen = (d) => d.x < -EDGE_OUT * 2 || d.x > W + EDGE_OUT * 2 || d.y < -EDGE_OUT * 2 || d.y > H + EDGE_OUT * 2;

  // ── the bots in view ─────────────────────────────────────────────────────

  function setView(list) {
    const keep = new Set();
    order = [];
    for (const { key, family } of list) {
      keep.add(key);
      order.push(key);
      const b = bots.get(key) ?? { lastSpawn: 0 };
      b.family = family || "other";
      bots.set(key, b);
    }
    const want = wantPerBot();
    order.forEach((key, i) => {
      const b = bots.get(key);
      b.slot = i;
      b.want = want;
    });
    for (const [key, b] of bots) {
      if (!keep.has(key)) b.want = 0;
    }
    recolor();
    rebalance(true);
    if (reduceMotion.matches) placeStill();
    else start();
  }

  /** Turn dots around so each bot heads for its wanted count. Spawning new
   *  dots happens in step(), a few at a time. */
  function rebalance(now) {
    for (const [key, b] of bots) {
      const mine = dots.filter((d) => d.key === key);
      const staying = mine.filter((d) => d.state !== "out");
      if (staying.length > b.want) {
        // The dots nearest an edge leave first, a few at a time.
        const edge = (d) => Math.min(d.x, W - d.x, d.y, H - d.y);
        staying
          .sort((p, q) => edge(p) - edge(q))
          .slice(0, staying.length - b.want)
          .forEach((d) => {
            d.state = "out";
            d.leaveAt = clock + (now ? Math.random() * LEAVE_STAGGER_MS : 0);
            const e = exitFor(d.x, d.y);
            d.exitX = e.x;
            d.exitY = e.y;
          });
      } else if (staying.length < b.want) {
        // A dot on its way out rejoins before a new one spawns.
        mine
          .filter((d) => d.state === "out")
          .slice(0, b.want - staying.length)
          .forEach((d) => {
            d.state = "live";
          });
      }
      if (!b.want && !mine.length && !order.includes(key)) bots.delete(key);
    }
  }

  /** A new dot with its own temperament. */
  function makeDot(key, x, y, vx, vy, state) {
    const bold = rand(-1, 1);
    return {
      key,
      x,
      y,
      vx,
      vy,
      state,
      born: clock,
      leaveAt: 0,
      exitX: 0,
      exitY: 0,
      tx: x,
      ty: y,
      near: [],
      // temperament
      r: rand(P.RING_MIN, P.RING_MAX),
      pace: rand(P.PACE_MIN, P.PACE_MAX),
      turn: rand(0.12, 0.45), // wander turn rate
      bold, // < 0 shy of the cursor, > 0 curious about it
      spin: Math.random() < 0.5 ? -1 : 1, // which way it circles the cursor
      // behavior
      heading: Math.atan2(vy, vx) || rand(0, TAU),
      mode: "roam",
      until: clock + rand(1500, 5000),
      lead: null,
      dartUntil: 0,
      dartX: 0,
      dartY: 0,
      dartSpeed: 0,
      nextDart: clock + rand(P.DART_EVERY_MIN * 0.3, P.DART_EVERY_MAX),
      startleAt: 0,
      startleX: 0,
      startleY: 0,
      depth: 0,
      gone: false,
    };
  }

  function spawn(key) {
    const p = edgePoint();
    const h = interior();
    const dx = h.x - p.x;
    const dy = h.y - p.y;
    const dist = Math.hypot(dx, dy) || 1;
    const d = makeDot(key, p.x, p.y, (dx / dist) * V_CAP_FLIGHT * 0.8, (dy / dist) * V_CAP_FLIGHT * 0.8, "in");
    d.tx = h.x;
    d.ty = h.y;
    dots.push(d);
  }

  // ── behavior ─────────────────────────────────────────────────────────────

  /** Pick the next mode when the current one runs out. */
  function nextMode(d, i) {
    const roll = Math.random();
    d.lead = null;
    if (roll < P.FOLLOW_SHARE) {
      // Follow the nearest dot of the same bot that is in reach.
      let best = null;
      let bestD = FOLLOW_REACH * FOLLOW_REACH;
      for (let j = 0; j < dots.length; j++) {
        const o = dots[j];
        if (j === i || o.key !== d.key || o.state !== "live" || o.lead === d) continue;
        const s2 = (o.x - d.x) ** 2 + (o.y - d.y) ** 2;
        if (s2 < bestD) {
          bestD = s2;
          best = o;
        }
      }
      if (best) {
        d.mode = "follow";
        d.lead = best;
        d.until = clock + rand(2000, 6000);
        return;
      }
    }
    if (roll > 1 - P.REST_SHARE) {
      d.mode = "rest";
      d.until = clock + rand(800, 2600);
      return;
    }
    d.mode = "roam";
    d.until = clock + rand(1800, 6000);
    d.heading += rand(-1, 1);
  }

  /** A short sprint in the direction (ux, uy). Returns true if it started. */
  function dart(d, ux, uy, depth) {
    if (clock < d.dartUntil) return false;
    const l = Math.hypot(ux, uy) || 1;
    d.dartX = ux / l;
    d.dartY = uy / l;
    d.dartSpeed = rand(P.DART_SPEED_MIN, P.DART_SPEED_MAX);
    d.dartUntil = clock + rand(DART_MS_MIN, DART_MS_MAX);
    d.nextDart = clock + rand(P.DART_EVERY_MIN, P.DART_EVERY_MAX);
    d.heading = Math.atan2(d.dartY, d.dartX);
    d.depth = depth;
    if (d.mode === "rest") nextMode(d, -1);
    return true;
  }

  // ── motion ───────────────────────────────────────────────────────────────

  function step(dt) {
    clock += dt;
    const f = dt / 16.67; // the forces are tuned per 60 Hz frame

    // Remove departed dots first: the neighbor indices built below must
    // match the array that draw() reads.
    // A dot that left the screen is gone. A dot that is "out" but still
    // waiting to leave stays until its turn.
    dots = dots.filter((d) => {
      const gone = d.state === "out" && clock >= d.leaveAt && offscreen(d);
      if (gone) d.gone = true;
      return !gone;
    });
    for (const [key, b] of bots) {
      if (!b.want && !order.includes(key) && !dots.some((d) => d.key === key)) bots.delete(key);
    }

    for (const [key, b] of bots) {
      const staying = dots.reduce((n, d) => n + (d.key === key && d.state !== "out" ? 1 : 0), 0);
      if (staying < b.want && clock - b.lastSpawn >= SPAWN_EVERY_MS) {
        spawn(key);
        b.lastSpawn = clock;
      }
    }

    const cursorSpeed = Math.hypot(mvx, mvy);
    const cursorIdle = clock - mouseMovedAt;
    // A resting cursor (over a widget, say) keeps only a small clear space,
    // so it does not hold a hole open in the swarm.
    const reach = P.CURSOR_NEAR + (P.CURSOR_FAR - P.CURSOR_NEAR) * Math.max(0, 1 - cursorIdle / P.CURSOR_SETTLE_MS);
    const darted = []; // dots that started a dart this frame, for the startle below

    const n = dots.length;
    for (let i = 0; i < n; i++) {
      const d = dots[i];
      let fx = 0;
      let fy = 0;
      let active = false;
      const leaving = d.state === "out" && clock >= d.leaveAt;
      const live = d.state === "live" || (d.state === "out" && !leaving);

      if (leaving) {
        // Steer for the exit.
        const ex = d.exitX - d.x;
        const ey = d.exitY - d.y;
        const el = Math.hypot(ex, ey) || 1;
        fx += ((ex / el) * EXIT_SPEED - d.vx) * 0.06;
        fy += ((ey / el) * EXIT_SPEED - d.vy) * 0.06;
      } else if (d.state === "in") {
        fx += (d.tx - d.x) * W_HOME_ENTER;
        fy += (d.ty - d.y) * W_HOME_ENTER;
        if (clock - d.born > SETTLE_MS && !offscreen(d)) d.state = "live";
      }

      if (live) {
        // Soft walls: turn back before the edge.
        if (d.x < WALL_PAD) fx += (WALL_PAD - d.x) * W_WALL;
        else if (d.x > W - WALL_PAD) fx += (W - WALL_PAD - d.x) * W_WALL;
        if (d.y < WALL_PAD) fy += (WALL_PAD - d.y) * W_WALL;
        else if (d.y > H - WALL_PAD) fy += (H - WALL_PAD - d.y) * W_WALL;

        // Its own clock: a new mode, a startle from a neighbor, a dart.
        if (clock >= d.until || (d.mode === "follow" && (!d.lead || d.lead.gone || d.lead.state !== "live"))) nextMode(d, i);
        if (d.startleAt && clock >= d.startleAt) {
          if (dart(d, d.startleX, d.startleY, d.depth + 1)) darted.push(i);
          d.startleAt = 0;
        } else if (clock >= d.nextDart) {
          const a = d.heading + rand(-1.9, 1.9);
          if (dart(d, Math.cos(a), Math.sin(a), 0)) darted.push(i);
        }

        // Where it wants to go, by mode.
        d.heading += (Math.random() - 0.5) * d.turn * f;
        let want = d.pace;
        let hx = Math.cos(d.heading);
        let hy = Math.sin(d.heading);
        let gain = P.W_STEER;
        if (clock < d.dartUntil) {
          hx = d.dartX;
          hy = d.dartY;
          want = d.dartSpeed;
          gain = W_DART;
          active = true;
        } else if (d.mode === "follow" && d.lead) {
          const L = d.lead;
          const ls = Math.hypot(L.vx, L.vy) || 1;
          const px = L.x - (L.vx / ls) * P.FOLLOW_GAP - d.x;
          const py = L.y - (L.vy / ls) * P.FOLLOW_GAP - d.y;
          const pl = Math.hypot(px, py) || 1;
          hx = px / pl;
          hy = py / pl;
          want = Math.min(P.V_CAP, ls + pl * 0.03);
          gain = P.W_STEER * 1.6;
          d.heading = Math.atan2(hy, hx);
          if (pl > FOLLOW_REACH * 1.4) d.until = clock; // lost it
        } else if (d.mode === "rest") {
          want = P.REST_PACE;
        }
        fx += (hx * want - d.vx) * gain;
        fy += (hy * want - d.vy) * gain;
      }

      // Neighbors: a firm push close by, a weak spread further out, alignment
      // with own-bot dots close by, and the nearest P.LINK_K for the net.
      let ax = 0;
      let ay = 0;
      let aw = 0;
      const near = d.near;
      near.length = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const o = dots[j];
        const sx = d.x - o.x;
        const sy = d.y - o.y;
        const s2 = sx * sx + sy * sy;
        if (s2 > 0 && s2 < P.SPREAD_DIST * P.SPREAD_DIST) {
          const s = Math.sqrt(s2);
          let str = ((P.SPREAD_DIST - s) / P.SPREAD_DIST) * P.W_SPREAD;
          if (s < P.SEP_DIST && o !== d.lead) str += ((P.SEP_DIST - s) / P.SEP_DIST) * P.W_SEP;
          fx += (sx / s) * str;
          fy += (sy / s) * str;
        }
        if (live && o.key === d.key && s2 < P.ALIGN_DIST * P.ALIGN_DIST) {
          ax += o.vx;
          ay += o.vy;
          aw += 1;
        }
        if (s2 < P.LINK_DIST * P.LINK_DIST) {
          if (near.length < P.LINK_K * 2) {
            near.push(j, s2);
          } else {
            let worst = 1;
            for (let q = 3; q < near.length; q += 2) if (near[q] > near[worst]) worst = q;
            if (s2 < near[worst]) {
              near[worst - 1] = j;
              near[worst] = s2;
            }
          }
        }
      }
      if (aw && d.mode === "roam" && clock >= d.dartUntil) {
        fx += (ax / aw - d.vx) * P.W_ALIGN;
        fy += (ay / aw - d.vy) * P.W_ALIGN;
      }

      // Cursor: shy dots flee (and a fast sweep startles them), curious dots
      // circle it until it stops moving for a while, the rest step aside.
      const mdx = d.x - mx;
      const mdy = d.y - my;
      const md = Math.hypot(mdx, mdy) || 1;
      const curious = d.bold > 1 - 2 * P.CURIOUS_SHARE && cursorIdle < P.INTEREST_MS && live;
      if ((md < reach || (curious && md < P.CURIOUS_FAR)) && !leaving) {
        const nx = mdx / md;
        const ny = mdy / md;
        const close = Math.max(0, 1 - md / reach);
        active = true;
        if (live && d.mode === "rest") d.until = clock; // the cursor wakes a resting dot
        if (curious) {
          const zeal = Math.max(0.3, Math.abs(d.bold)); // how keen this dot is
          const r = P.ORBIT_R * (1.4 - zeal * 0.6);
          const radial = Math.max(-1, Math.min(1, (md - r) / r));
          const keen = zeal * (1 - cursorIdle / Math.max(1, P.INTEREST_MS));
          fx -= nx * radial * P.W_ORBIT_RADIAL * keen * 2;
          fy -= ny * radial * P.W_ORBIT_RADIAL * keen * 2;
          fx += -ny * d.spin * P.W_ORBIT_SPIN * keen;
          fy += nx * d.spin * P.W_ORBIT_SPIN * keen;
        } else if (d.bold < -1 + 2 * P.SHY_SHARE) {
          const push = Math.pow(close, 1.5) * P.W_FLEE * (0.5 - d.bold);
          fx += nx * push;
          fy += ny * push;
          if (live && cursorSpeed > P.STARTLE_CURSOR && md < reach * 0.85) {
            if (dart(d, nx + rand(-0.4, 0.4), ny + rand(-0.4, 0.4), 0)) darted.push(i);
          }
        } else {
          const push = Math.pow(close, 1.5) * P.W_NEUTRAL;
          fx += nx * push;
          fy += ny * push;
          if (live && cursorSpeed > P.STARTLE_CURSOR * 2 && md < reach * 0.6) {
            if (dart(d, nx, ny, 0)) darted.push(i);
          }
        }
      }

      // Integrate with a cap on the change of velocity (a glide, not a snap).
      let dvx = fx * f;
      let dvy = fy * f;
      const dv = Math.hypot(dvx, dvy);
      const acc = (active ? ACC_CAP_ACTIVE : ACC_CAP) * f * (live ? 1 : 2);
      if (dv > acc) {
        dvx *= acc / dv;
        dvy *= acc / dv;
      }
      let vx = d.vx + dvx;
      let vy = d.vy + dvy;
      if (md < P.MOUSE_R + d.r) {
        const nx = mdx / md;
        const ny = mdy / md;
        const dot = vx * nx + vy * ny;
        vx -= (1 + CURSOR_REST) * dot * nx;
        vy -= (1 + CURSOR_REST) * dot * ny;
        vx += mvx * 0.3;
        vy += mvy * 0.3;
        const out = vx * nx + vy * ny;
        if (out < CURSOR_MIN_OUT) {
          vx += nx * (CURSOR_MIN_OUT - out);
          vy += ny * (CURSOR_MIN_OUT - out);
        }
        d.x = mx + nx * (P.MOUSE_R + d.r + 2);
        d.y = my + ny * (P.MOUSE_R + d.r + 2);
      }
      const cap = !live ? V_CAP_FLIGHT : clock < d.dartUntil ? P.V_CAP_DART : md < reach ? P.V_CAP_CURSOR : P.V_CAP;
      const sp = Math.hypot(vx, vy);
      if (sp > cap) {
        vx *= cap / sp;
        vy *= cap / sp;
      }
      const damp = live ? Math.pow(P.DAMPING, f) : 1;
      d.x += vx * f;
      d.y += vy * f;
      d.vx = vx * damp;
      d.vy = vy * damp;
    }

    // A dart startles some of the darting dot's nearest neighbors. They dart
    // a moment later, in about the same direction (P.STARTLE_DEPTH steps at most).
    for (const i of darted) {
      const d = dots[i];
      if (d.depth >= P.STARTLE_DEPTH) continue;
      for (let q = 0; q < d.near.length; q += 2) {
        const o = dots[d.near[q]];
        if (!o || o.state !== "live" || o.startleAt || clock < o.dartUntil || Math.random() > P.STARTLE_P) continue;
        o.startleAt = clock + rand(60, 220);
        o.startleX = d.dartX + rand(-0.5, 0.5);
        o.startleY = d.dartY + rand(-0.5, 0.5);
        o.depth = d.depth;
      }
    }

    mvx *= 0.5;
    mvy *= 0.5;
  }

  // ── drawing ──────────────────────────────────────────────────────────────

  /** The net: a link from each dot to its nearest neighbors (fading with
   *  distance), and a very faint fill in small closed triangles. A link
   *  inside one bot's dots takes that bot's color; a link between two bots is
   *  neutral. A link between a follower and its lead is brighter. */
  function drawNet(strength) {
    const neutral = darkScheme.matches ? "rgb(200,198,190)" : "rgb(110,108,100)";
    const linked = new Set();
    const key = (a, b) => (a < b ? a * 65536 + b : b * 65536 + a);
    for (let i = 0; i < dots.length; i++) {
      const nb = dots[i].near;
      for (let q = 0; q < nb.length; q += 2) linked.add(key(i, nb[q]));
    }
    ctx.globalAlpha = P.TRI_ALPHA * strength;
    const tri2 = P.TRI_EDGE * P.TRI_EDGE;
    for (let i = 0; P.TRI_ALPHA > 0 && i < dots.length; i++) {
      const nb = dots[i].near;
      for (let p = 0; p < nb.length; p += 2) {
        for (let q = p + 2; q < nb.length; q += 2) {
          const j = nb[p];
          const k = nb[q];
          if (!(i < j && i < k) || nb[p + 1] > tri2 || nb[q + 1] > tri2 || !linked.has(key(j, k))) continue;
          const a = dots[i];
          const b = dots[j];
          const c = dots[k];
          if (!b || !c || (b.x - c.x) ** 2 + (b.y - c.y) ** 2 > tri2) continue;
          ctx.fillStyle = a.key === b.key && b.key === c.key ? bots.get(a.key)?.color ?? neutral : neutral;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.lineTo(c.x, c.y);
          ctx.closePath();
          ctx.fill();
        }
      }
    }
    ctx.lineWidth = P.LINK_WIDTH;
    for (const lk of linked) {
      const a = dots[Math.floor(lk / 65536)];
      const b = dots[lk % 65536];
      if (!a || !b) continue;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (dist <= a.r + b.r + 2 * P.RING_GAP) continue;
      const tie = a.lead === b || b.lead === a ? 1.9 : 1;
      ctx.globalAlpha = Math.min(0.4, P.LINK_ALPHA * strength * tie * Math.max(0, 1 - dist / P.LINK_DIST));
      ctx.strokeStyle = a.key === b.key ? bots.get(a.key)?.color ?? neutral : neutral;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    // Cut the ring interiors (and a small gap round each ring) out of the net,
    // so no link or fill crosses the inside of a ring.
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    for (const d of dots) {
      const r = d.r + P.RING_GAP;
      ctx.moveTo(d.x + r, d.y);
      ctx.arc(d.x, d.y, r, 0, TAU);
    }
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
  }

  /** The rings (or filled dots). A fast dot is brighter; a resting dot is
   *  dimmer. */
  function drawRings(strength, still) {
    const base = P.RING_ALPHA + (darkScheme.matches ? 0.04 : 0);
    const filled = P.FILLED >= 0.5;
    ctx.lineWidth = P.RING_WIDTH;
    for (const d of dots) {
      const sp = still ? 0.5 : Math.hypot(d.vx, d.vy);
      const color = bots.get(d.key)?.color ?? "rgb(128,128,128)";
      ctx.globalAlpha = Math.max(0, Math.min(1, (base + P.RING_SPEED_GLOW * Math.min(1, sp / 2.6) - (sp < 0.25 ? 0.08 : 0)) * strength));
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, TAU);
      if (filled) {
        ctx.fillStyle = color;
        ctx.fill();
      } else {
        ctx.strokeStyle = color;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  function draw(still = false) {
    ctx.clearRect(0, 0, W, H);
    const strength = darkScheme.matches ? 1.2 : 1;
    if (!still) drawNet(strength);
    drawRings(strength, still);
  }

  /** Reduce motion: still rings spread over the page, no flight, no net. */
  function placeStill() {
    stop();
    dots = [];
    for (const key of order) {
      const b = bots.get(key);
      for (let k = 0; k < b.want; k++) {
        const p = interior();
        dots.push(makeDot(key, p.x, p.y, 0, 0, "live"));
      }
    }
    for (const key of [...bots.keys()]) if (!order.includes(key)) bots.delete(key);
    draw(true);
  }

  // ── loop ─────────────────────────────────────────────────────────────────

  function frame(t) {
    raf = 0;
    const dt = lastT ? Math.min(t - lastT, 48) : 16.67;
    lastT = t;
    step(dt);
    draw();
    // Stop when nothing is left to move (no bot in view, no dot in flight).
    if (dots.length || order.length) raf = requestAnimationFrame(frame);
  }

  function start() {
    if (raf || document.hidden || reduceMotion.matches) return;
    lastT = 0;
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  // ── parameters from the settings page ────────────────────────────────────

  const RANGE = new Map(SPEC.map(([name, , min, max]) => [name, [min, max]]));

  function setParams(patch) {
    const changed = new Set();
    for (const [name, raw] of Object.entries(patch ?? {})) {
      const range = RANGE.get(name);
      const v = Number(raw);
      if (!range || !Number.isFinite(v)) continue;
      const next = Math.min(range[1], Math.max(range[0], v));
      if (next !== P[name]) {
        P[name] = next;
        changed.add(name);
      }
    }
    if (!changed.size) return;
    // A new range applies to the dots already on the page, not only to new ones.
    const lo = (a, b) => Math.min(P[a], P[b]);
    const hi = (a, b) => Math.max(P[a], P[b]);
    for (const d of dots) {
      if (changed.has("RING_MIN") || changed.has("RING_MAX")) d.r = rand(lo("RING_MIN", "RING_MAX"), hi("RING_MIN", "RING_MAX"));
      if (changed.has("PACE_MIN") || changed.has("PACE_MAX")) d.pace = rand(lo("PACE_MIN", "PACE_MAX"), hi("PACE_MIN", "PACE_MAX"));
      if ((changed.has("DART_EVERY_MIN") || changed.has("DART_EVERY_MAX")) && d.nextDart > clock + hi("DART_EVERY_MIN", "DART_EVERY_MAX")) {
        d.nextDart = clock + rand(lo("DART_EVERY_MIN", "DART_EVERY_MAX"), hi("DART_EVERY_MIN", "DART_EVERY_MAX"));
      }
    }
    if (["AREA_PER_DOT", "TOTAL_MAX", "PER_BOT_MIN"].some((n) => changed.has(n)) && order.length) {
      const want = wantPerBot();
      for (const key of order) bots.get(key).want = want;
      rebalance(false);
    }
    if (reduceMotion.matches) placeStill();
    else start();
  }

  // ── wiring ───────────────────────────────────────────────────────────────

  function mount() {
    document.body.prepend(canvas);
    document.body.append(probe);
    resize();
  }
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });

  window.addEventListener("observatory:bots", (e) => setView(Array.isArray(e.detail) ? e.detail : []));
  window.addEventListener("resize", resize);
  window.addEventListener("pointermove", (e) => {
    if (mx > -9000) {
      mvx = e.clientX - mx;
      mvy = e.clientY - my;
    }
    mx = e.clientX;
    my = e.clientY;
    mouseMovedAt = clock;
  });
  document.addEventListener("pointerleave", () => {
    mx = -9999;
    my = -9999;
  });
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  reduceMotion.addEventListener("change", () => (reduceMotion.matches ? placeStill() : ((dots = []), start())));
  darkScheme.addEventListener("change", () => {
    recolor();
    if (reduceMotion.matches) draw(true);
  });

  // For a reader of the page (and for checks): how many dots each bot has,
  // and what the dots are doing.
  window.observatorySwarm = {
    stats: () =>
      Object.fromEntries(
        [...bots.keys()].map((key) => {
          const mine = dots.filter((d) => d.key === key);
          return [key, { want: bots.get(key).want, in: mine.filter((d) => d.state === "in").length, live: mine.filter((d) => d.state === "live").length, out: mine.filter((d) => d.state === "out").length }];
        }),
      ),
    modes: () => {
      const m = { roam: 0, follow: 0, rest: 0, dart: 0 };
      for (const d of dots) {
        if (d.state !== "live") continue;
        m[clock < d.dartUntil ? "dart" : d.mode]++;
      }
      return m;
    },
    running: () => raf !== 0,
    /** The settings page: the parameter table, the current values, and the
     *  defaults. */
    params: () => ({ spec: SPEC.map(([name, def, min, max, step, group, label, hint]) => ({ name, def, min, max, step, group, label, hint })), values: { ...P }, defaults: { ...DEFAULTS } }),
    /** Change parameters while the swarm runs. Unknown names are ignored and
     *  each value is held inside its range. Returns the values now in use. */
    set: (patch) => {
      setParams(patch);
      return { ...P };
    },
    reset: () => {
      setParams(DEFAULTS);
      return { ...P };
    },
    meanSpeed: () => (dots.length ? dots.reduce((a, d) => a + Math.hypot(d.vx, d.vy), 0) / dots.length : 0),
  };
})();
