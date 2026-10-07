// Fleet Observatory background swarm (Mike, 2026-10-07, R4).
//
// A faint swarm of dots behind the widgets, one color for each bot in view
// (the bot's role-family color from app.css). Each dot links to its nearest
// neighbors, and three dots that all link to each other fill a faint
// triangle, so the swarm draws a moving net (a simplicial complex). The dots
// flock: separation, alignment and cohesion with neighbors of every color, a
// cruising speed so no dot stops, a soft cursor field with hard contact, and
// an acceleration cap (the oasis-welcome homepage swarm's glide).
//
// The bot bar does not set the dots directly. It sends the bots in view
// ("observatory:bots"), and each bot's dots then fly in from the screen
// edges or leave through them over a second or two. A new choice while dots
// are still flying turns them around: entering dots leave again, and leaving
// dots rejoin.
//
// The swarm stops while the tab is hidden. With "reduce motion" set, it draws
// still dots and never animates.
(function () {
  "use strict";

  const TOTAL = 180; // dots shared by the bots in view
  const PER_BOT_MIN = 24;
  const PER_BOT_MAX = 60;
  const SPAWN_EVERY_MS = 40; // per bot, while it is short of dots
  const LEAVE_STAGGER_MS = 900;
  const SETTLE_MS = 900; // an entering dot joins the swarm after this long on screen

  const DOT_R = 1.8;
  const SEP_DIST = 24;
  const W_SEP = 0.5;
  const FLOCK_DIST = 70; // alignment and cohesion reach
  const W_ALIGN = 0.05;
  const W_ALIGN_OTHER = 0.02; // a dot also follows dots of other bots, more weakly
  const W_COHESION = 0.0035;
  const W_HOME = 0.00035;
  const W_HOME_ENTER = 0.0026;
  const W_WANDER = 0.06;
  const V_CRUISE = 0.75; // a dot speeds back up toward this, so the swarm never freezes
  const W_CRUISE = 0.03;
  const LINK_K = 3; // links per dot, to its nearest neighbors
  const LINK_DIST = 95;
  const MOUSE_DIST = 140;
  const MOUSE_R = 30;
  const W_MOUSE = 1.4;
  const CURSOR_REST = 0.25;
  const CURSOR_MIN_OUT = 0.8;
  const DAMPING = 0.985;
  const ACC_CAP = 0.22;
  const V_CAP = 1.6;
  const V_CAP_FLIGHT = 2.8;
  const EXIT_SPEED = 2.4;
  const EDGE_OUT = 14; // a dot spawns and despawns this far past the edge
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

  /** @type {{key:string,x:number,y:number,vx:number,vy:number,state:"in"|"live"|"out",born:number,leaveAt:number,exitX:number,exitY:number,phase:number}[]} */
  let dots = [];
  /** key → { family, color, want, lastSpawn, slot } */
  const bots = new Map();
  let order = []; // keys in view, in bot-bar order (sets each bot's home slot)
  let mx = -9999;
  let my = -9999;
  let mvx = 0;
  let mvy = 0;
  let raf = 0;
  let lastT = 0;
  let clock = 0;

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
    if (reduceMotion.matches) placeStill();
  }

  /** The swarm's centre drifts slowly over the page. */
  function centre(t) {
    return {
      x: W * (0.5 + 0.3 * Math.sin(t * 0.00011)),
      y: H * (0.52 + 0.24 * Math.sin(t * 0.00017 + 1.3)),
    };
  }

  /** Each bot's dots gather loosely around one point on a slow wheel around
   *  the centre, so the colors group but still mix at the borders. */
  function home(key, t) {
    const c = centre(t);
    const b = bots.get(key);
    const n = Math.max(order.length, 1);
    const ring = order.length > 1 ? Math.min(W, H) * 0.2 : 0;
    const a = ((b?.slot ?? 0) / n) * TAU + t * 0.00009;
    return { x: c.x + ring * Math.cos(a), y: c.y + ring * Math.sin(a) };
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
    const want = order.length ? Math.max(PER_BOT_MIN, Math.min(PER_BOT_MAX, Math.round(TOTAL / order.length))) : 0;
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
        // Leave with the dots farthest from home first, a few at a time.
        const h = home(key, clock);
        staying
          .sort((p, q) => Math.hypot(q.x - h.x, q.y - h.y) - Math.hypot(p.x - h.x, p.y - h.y))
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

  function spawn(key) {
    const p = edgePoint();
    const h = home(key, clock);
    const dx = h.x - p.x;
    const dy = h.y - p.y;
    const d = Math.hypot(dx, dy) || 1;
    dots.push({
      key,
      x: p.x,
      y: p.y,
      vx: (dx / d) * V_CAP_FLIGHT * 0.8,
      vy: (dy / d) * V_CAP_FLIGHT * 0.8,
      state: "in",
      born: clock,
      leaveAt: 0,
      exitX: 0,
      exitY: 0,
      phase: Math.random() * TAU,
      near: [],
    });
  }

  // ── motion ───────────────────────────────────────────────────────────────

  function step(dt) {
    clock += dt;
    const f = dt / 16.67; // the forces are tuned per 60 Hz frame

    // Remove departed dots first: the neighbor indices built below must
    // match the array that draw() reads.
    // A dot that left the screen is gone. A dot that is "out" but still
    // waiting to leave stays until its turn.
    dots = dots.filter((d) => !(d.state === "out" && clock >= d.leaveAt && offscreen(d)));
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

    const homes = new Map(order.map((key) => [key, home(key, clock)]));
    const n = dots.length;
    for (let i = 0; i < n; i++) {
      const d = dots[i];
      let fx = 0;
      let fy = 0;

      if (d.state === "out" && clock >= d.leaveAt) {
        // Steer for the exit.
        const ex = d.exitX - d.x;
        const ey = d.exitY - d.y;
        const el = Math.hypot(ex, ey) || 1;
        fx += ((ex / el) * EXIT_SPEED - d.vx) * 0.06;
        fy += ((ey / el) * EXIT_SPEED - d.vy) * 0.06;
      } else {
        const h = homes.get(d.key) ?? centre(clock);
        const w = d.state === "in" ? W_HOME_ENTER : W_HOME;
        fx += (h.x - d.x) * w;
        fy += (h.y - d.y) * w;
        if (d.state === "in" && clock - d.born > SETTLE_MS && !offscreen(d)) d.state = "live";
      }

      // Wander: a slowly turning heading for each dot.
      d.phase += (Math.random() - 0.5) * 0.3 * f;
      fx += Math.cos(d.phase) * W_WANDER;
      fy += Math.sin(d.phase) * W_WANDER;

      // Neighbors: separation from every dot; alignment and cohesion with
      // nearby dots (own bot stronger); and the nearest LINK_K for the net.
      let ax = 0;
      let ay = 0;
      let aw = 0;
      let cx = 0;
      let cy = 0;
      let cn = 0;
      const near = d.near;
      near.length = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const o = dots[j];
        const sx = d.x - o.x;
        const sy = d.y - o.y;
        const s2 = sx * sx + sy * sy;
        if (s2 < SEP_DIST * SEP_DIST && s2 > 0) {
          const s = Math.sqrt(s2);
          const str = (SEP_DIST - s) / SEP_DIST;
          fx += (sx / s) * str * W_SEP;
          fy += (sy / s) * str * W_SEP;
        }
        if (s2 < FLOCK_DIST * FLOCK_DIST) {
          const w = o.key === d.key ? 1 : W_ALIGN_OTHER / W_ALIGN;
          ax += o.vx * w;
          ay += o.vy * w;
          aw += w;
          cx += o.x;
          cy += o.y;
          cn++;
        }
        if (s2 < LINK_DIST * LINK_DIST) {
          if (near.length < LINK_K * 2) {
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
      if (aw) {
        fx += (ax / aw - d.vx) * W_ALIGN;
        fy += (ay / aw - d.vy) * W_ALIGN;
      }
      if (cn) {
        fx += (cx / cn - d.x) * W_COHESION;
        fy += (cy / cn - d.y) * W_COHESION;
      }
      // Cruise: speed up a slow dot, so the net keeps moving.
      if (d.state === "live") {
        const sp0 = Math.hypot(d.vx, d.vy) || 1e-6;
        const k = (V_CRUISE - sp0) * W_CRUISE;
        fx += (d.vx / sp0) * k;
        fy += (d.vy / sp0) * k;
      }

      // Cursor: a soft field, then a hard contact that pushes the dot out.
      const mdx = d.x - mx;
      const mdy = d.y - my;
      const md = Math.hypot(mdx, mdy) || 1;
      if (md < MOUSE_DIST) {
        const ms = (MOUSE_DIST - md) / MOUSE_DIST;
        fx += (mdx / md) * ms * W_MOUSE;
        fy += (mdy / md) * ms * W_MOUSE;
      }

      // Integrate with a cap on the change of velocity (a glide, not a snap).
      let dvx = fx * f;
      let dvy = fy * f;
      const dv = Math.hypot(dvx, dvy);
      const acc = ACC_CAP * f * (d.state === "live" ? 1 : 2);
      if (dv > acc) {
        dvx *= acc / dv;
        dvy *= acc / dv;
      }
      let vx = d.vx + dvx;
      let vy = d.vy + dvy;
      if (md < MOUSE_R + DOT_R) {
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
        d.x = mx + nx * (MOUSE_R + DOT_R + 2);
        d.y = my + ny * (MOUSE_R + DOT_R + 2);
      }
      const cap = d.state === "live" ? V_CAP : V_CAP_FLIGHT;
      const sp = Math.hypot(vx, vy);
      if (sp > cap) {
        vx *= cap / sp;
        vy *= cap / sp;
      }
      const damp = d.state === "live" ? Math.pow(DAMPING, f) : 1;
      d.x += vx * f;
      d.y += vy * f;
      d.vx = vx * damp;
      d.vy = vy * damp;
    }
    mvx *= 0.5;
    mvy *= 0.5;

  }

  /** The net: a link from each dot to its nearest neighbors (fading with
   *  distance), and a faint triangle where three dots link to each other.
   *  A link inside one bot's dots takes that bot's color; a link between two
   *  bots is neutral. */
  function drawNet(strength) {
    const neutral = darkScheme.matches ? "rgb(200,198,190)" : "rgb(110,108,100)";
    const linked = new Set();
    const key = (a, b) => (a < b ? a * 65536 + b : b * 65536 + a);
    for (let i = 0; i < dots.length; i++) {
      const nb = dots[i].near;
      for (let q = 0; q < nb.length; q += 2) linked.add(key(i, nb[q]));
    }
    // Triangles first, under the links.
    ctx.globalAlpha = 0.035 * strength;
    for (let i = 0; i < dots.length; i++) {
      const nb = dots[i].near;
      for (let p = 0; p < nb.length; p += 2) {
        for (let q = p + 2; q < nb.length; q += 2) {
          const j = nb[p];
          const k = nb[q];
          if (!(i < j && i < k) || !linked.has(key(j, k))) continue;
          const a = dots[i];
          const b = dots[j];
          const c = dots[k];
          if (!b || !c) continue;
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
    ctx.lineWidth = 0.7;
    for (const lk of linked) {
      const a = dots[Math.floor(lk / 65536)];
      const b = dots[lk % 65536];
      if (!a || !b) continue;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      ctx.globalAlpha = 0.16 * strength * Math.max(0, 1 - dist / LINK_DIST);
      ctx.strokeStyle = a.key === b.key ? bots.get(a.key)?.color ?? neutral : neutral;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    const strength = darkScheme.matches ? 1.25 : 1;
    drawNet(strength);
    ctx.globalAlpha = darkScheme.matches ? 0.3 : 0.24;
    for (const key of new Set(dots.map((d) => d.key))) {
      ctx.fillStyle = bots.get(key)?.color ?? "rgb(128,128,128)";
      ctx.beginPath();
      for (const d of dots) {
        if (d.key !== key) continue;
        ctx.moveTo(d.x + DOT_R, d.y);
        ctx.arc(d.x, d.y, DOT_R, 0, TAU);
      }
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /** Reduce motion: still dots near each bot's home, no flight. */
  function placeStill() {
    stop();
    dots = [];
    for (const key of order) {
      const b = bots.get(key);
      const h = home(key, 0);
      for (let k = 0; k < b.want; k++) {
        const a = Math.random() * TAU;
        const r = Math.sqrt(Math.random()) * Math.min(W, H) * 0.14;
        dots.push({ key, x: h.x + r * Math.cos(a), y: h.y + r * Math.sin(a), vx: 0, vy: 0, state: "live", born: 0, leaveAt: 0, exitX: 0, exitY: 0, phase: 0, near: [] });
      }
    }
    for (const key of [...bots.keys()]) if (!order.includes(key)) bots.delete(key);
    draw();
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
  });
  document.addEventListener("pointerleave", () => {
    mx = -9999;
    my = -9999;
  });
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  reduceMotion.addEventListener("change", () => (reduceMotion.matches ? placeStill() : (dots = [], start())));
  darkScheme.addEventListener("change", () => {
    recolor();
    if (reduceMotion.matches) draw();
  });

  // For a reader of the page (and for checks): how many dots each bot has.
  window.observatorySwarm = {
    stats: () =>
      Object.fromEntries(
        [...bots.keys()].map((key) => {
          const mine = dots.filter((d) => d.key === key);
          return [key, { want: bots.get(key).want, in: mine.filter((d) => d.state === "in").length, live: mine.filter((d) => d.state === "live").length, out: mine.filter((d) => d.state === "out").length }];
        }),
      ),
    running: () => raf !== 0,
    meanSpeed: () => (dots.length ? dots.reduce((a, d) => a + Math.hypot(d.vx, d.vy), 0) / dots.length : 0),
  };
})();
