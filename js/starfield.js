/* ============================================================
   STARS — ambient animated starfield
   Procedural canvas: twinkling stars, milky-way band, faint
   nebula haze, ultra-slow drift, rare meteors. Seeded per
   page-load (no repetition). 30fps, pauses when hidden,
   disabled under prefers-reduced-motion (CSS static fallback).
   ============================================================ */
(function () {
  "use strict";
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (document.body.dataset.page === "debris") return; // sim page has its own stars

  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  var rand = mulberry32((Date.now() ^ (Math.random() * 0xffff)) & 0xffffffff);

  var canvas = document.createElement("canvas");
  canvas.className = "ambient-starfield";
  canvas.setAttribute("aria-hidden", "true");
  var ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return;

  var W = 0, H = 0, DPR = 1;
  var stars = [], meteors = [], nebula = null;
  var running = false, lastFrame = 0, lastMeteor = 0;

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 1.75);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    buildStars();
    buildNebula();
  }

  /* milky-way diagonal band, gentle slope */
  function bandY(x) { return H * 0.72 - (x / Math.max(W, 1)) * H * 0.34; }

  function buildStars() {
    stars = [];
    var area = W * H;
    var count = Math.min(950, Math.max(320, Math.round(area / 2100)));
    var i, x, y, r, inBand;
    for (i = 0; i < count; i++) {
      x = rand() * W;
      inBand = rand() < 0.42;
      if (inBand) {
        y = bandY(x) + (rand() + rand() + rand() - 1.5) * H * 0.075; // gaussian-ish
        y = Math.min(Math.max(y, 2), H - 2);
      } else {
        y = rand() * H;
      }
      var depth = 0.35 + rand() * 0.65;                 // parallax depth 0.35–1
      var sizeRoll = rand();
      r = sizeRoll > 0.965 ? 1.5 + rand() * 0.9         // rare bright
        : sizeRoll > 0.8 ? 0.9 + rand() * 0.5
        : 0.35 + rand() * 0.55;                          // majority: faint
      var tint = rand();
      var col = tint < 0.72 ? "232,238,248"             // white-blue
        : tint < 0.87 ? "246,228,192"                   // warm
        : "198,216,246";                                // cool blue
      stars.push({
        x: x, y: y, r: r,
        base: 0.28 + rand() * 0.6,                      // base opacity
        amp: 0.12 + rand() * 0.3,                       // twinkle amplitude
        spd: 0.15 + rand() * 0.85,                      // twinkle speed
        ph: rand() * Math.PI * 2,
        dx: (rand() - 0.5) * 0.022 * depth,             // ultra-slow drift
        dy: (rand() - 0.5) * 0.012 * depth,
        col: col,
        bright: sizeRoll > 0.965
      });
    }
  }

  function buildNebula() {
    /* static haze layer painted once: faint nebulae + milky-way glow */
    var off = document.createElement("canvas");
    off.width = Math.round(W * DPR); off.height = Math.round(H * DPR);
    var c = off.getContext("2d");
    c.setTransform(DPR, 0, 0, DPR, 0, 0);
    function blob(cx, cy, rx, ry, col, a) {
      var g = c.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rx, ry));
      g.addColorStop(0, "rgba(" + col + "," + a + ")");
      g.addColorStop(1, "rgba(" + col + ",0)");
      c.fillStyle = g;
      c.save();
      c.translate(cx, cy); c.scale(rx / Math.max(rx, ry), ry / Math.max(rx, ry));
      c.beginPath(); c.arc(0, 0, Math.max(rx, ry), 0, Math.PI * 2); c.fill();
      c.restore();
    }
    blob(W * 0.78, H * 0.22, W * 0.34, W * 0.2, "30,48,92", 0.16);
    blob(W * 0.16, H * 0.78, W * 0.38, W * 0.22, "24,40,76", 0.14);
    blob(W * 0.52, H * 0.5, W * 0.5, W * 0.3, "18,28,54", 0.10);
    blob(W * 0.88, H * 0.86, W * 0.24, W * 0.16, "60,44,28", 0.07);
    /* milky-way elongated haze along the band */
    var steps = 7;
    for (var i = 0; i < steps; i++) {
      var t = i / (steps - 1);
      var bx = t * W, by = bandY(bx);
      blob(bx, by, W * 0.16, H * 0.09, "26,34,52", 0.075);
    }
    nebula = off;
  }

  function spawnMeteor(now) {
    if (meteors.length > 0) return;
    if (now - lastMeteor < 9000 + rand() * 14000) return;
    lastMeteor = now;
    var fromLeft = rand() < 0.5;
    var x = fromLeft ? -60 : W + 60;
    var y = rand() * H * 0.4;
    var ang = (fromLeft ? 0.42 : Math.PI - 0.42) + (rand() - 0.5) * 0.2;
    var speed = 580 + rand() * 260; // px/s
    meteors.push({
      x: x, y: y,
      vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed,
      life: 0, ttl: 0.7 + rand() * 0.35
    });
  }

  function drawMeteor(m, dt) {
    m.life += dt;
    m.x += m.vx * dt; m.y += m.vy * dt;
    var fade = Math.sin(Math.min(m.life / m.ttl, 1) * Math.PI);
    var a = 0.32 * fade;
    if (a <= 0.01) return false;
    var tailX = m.x - m.vx * 0.14, tailY = m.y - m.vy * 0.14;
    var g = ctx.createLinearGradient(tailX, tailY, m.x, m.y);
    g.addColorStop(0, "rgba(200,215,240,0)");
    g.addColorStop(1, "rgba(235,242,252," + a.toFixed(3) + ")");
    ctx.strokeStyle = g;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(tailX, tailY); ctx.lineTo(m.x, m.y); ctx.stroke();
    ctx.fillStyle = "rgba(240,246,255," + (a * 0.9).toFixed(3) + ")";
    ctx.beginPath(); ctx.arc(m.x, m.y, 1.1, 0, Math.PI * 2); ctx.fill();
    return m.life < m.ttl;
  }

  function frame(now) {
    if (!running) return;
    requestAnimationFrame(frame);
    if (now - lastFrame < 33) return; // ~30fps
    var dt = Math.min((now - lastFrame) / 1000, 0.12);
    lastFrame = now;
    var t = now / 1000;

    ctx.clearRect(0, 0, W, H);
    // a zero-size window (hidden tab/iframe) leaves a 0x0 haze canvas, which drawImage rejects
    if (nebula && nebula.width && nebula.height) ctx.drawImage(nebula, 0, 0, W, H);

    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      s.x += s.dx; s.y += s.dy;
      if (s.x < -4) s.x = W + 4; else if (s.x > W + 4) s.x = -4;
      if (s.y < -4) s.y = H + 4; else if (s.y > H + 4) s.y = -4;
      var a = s.base + Math.sin(t * s.spd + s.ph) * s.amp;
      if (a <= 0.02) continue;
      ctx.fillStyle = "rgba(" + s.col + "," + a.toFixed(3) + ")";
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
      if (s.bright) { // soft halo on rare bright stars
        ctx.fillStyle = "rgba(" + s.col + "," + (a * 0.14).toFixed(3) + ")";
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r * 3.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    spawnMeteor(now);
    for (var j = meteors.length - 1; j >= 0; j--) {
      if (!drawMeteor(meteors[j], dt)) meteors.splice(j, 1);
    }
  }

  function start() {
    if (running) return;
    running = true;
    lastFrame = performance.now();
    requestAnimationFrame(frame);
  }
  function stop() { running = false; }

  document.addEventListener("visibilitychange", function () {
    document.hidden ? stop() : start();
  });

  var resizeTimer = null;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 180);
  }, { passive: true });

  resize();
  document.body.classList.add("has-canvas-stars");
  document.body.insertBefore(canvas, document.body.firstChild);
  start();
})();
