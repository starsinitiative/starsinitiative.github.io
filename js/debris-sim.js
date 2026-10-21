/* ============================================================
   STARS — ORBITAL DEBRIS EXPLORER · debris-sim.js  (ENGINE)
   ------------------------------------------------------------
   Scientifically-grounded 3D visualization of Earth's orbital
   debris environment: ~21,500-object statistically representative
   catalog · Keplerian two-body propagation (Newton-Raphson) ·
   custom three.js shaders (day/night Earth, atmosphere, points).
   Units: 1 unit = 1 km.  R = 6371 km.  μ = 398600.4418 km³/s².

   This file is the SIMULATION ENGINE only. The HTML instrument
   UI (Agent E2) drives everything through the public surface:

     window.DEBRIS_SIM = {
       onReady(cb)                        → off
       setTimeWarp(w)  getTimeWarp()        1 | 60 | 600 | 3600
       setSimTime(t)   getSimTime()         seconds since T0
       pause(bool)     isPaused()
       getCatalogStats()                    static catalog info
       selectObject(n) deselect() getSelected() onSelect(cb)
       classVisibility(name, bool) getClassVisibility(name)
       setAltitudeFilter(km) getAltitudeFilter()
       focusEvent(name)                     fragmentation events
       onHover(cb)                          pointer hover feed
       getOverlayState()                    per-frame overlay data
     }

   Full field documentation at the bottom of the file.
   ============================================================ */
(function () {
  "use strict";

  /* ══════════════ 0 · CONSTANTS / HELPERS ══════════════ */
  var R_EARTH = 6371,
      MU = 398600.4418,
      TAU = Math.PI * 2,
      D2R = Math.PI / 180,
      EARTH_ROT = 7.2921159e-5,          // rad/s sidereal spin
      GEO_R = 42164,                      // geostationary radius (km)
      MIN_DIST = 7200, MAX_DIST = 400000, // camera clamp (km from centre)
      ALT_MIN = 300, ALT_MAX = 40000,     // altitude scrub range (km)
      reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function $(id) { return document.getElementById(id); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function fmt(n) { return Math.round(n).toLocaleString("en-US"); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  function easeInOut(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function fmtT(sec) {
    sec = Math.max(0, Math.floor(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    function p2(n) { return (n < 10 ? "0" : "") + n; }
    return p2(h) + ":" + p2(m) + ":" + p2(s);
  }

  /* deterministic PRNG (mulberry32) — reproducible catalog */
  var _seed = 20240117;
  function rnd() {
    _seed |= 0; _seed = (_seed + 0x6D2B79F5) | 0;
    var t = Math.imul(_seed ^ (_seed >>> 15), 1 | _seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function rr(a, b) { return a + (b - a) * rnd(); }
  function rgauss() { return (rnd() + rnd() + rnd()) / 3; }   // ~N(0.5,σ≈.095) on 0..1

  /* event-listener sets for the public API */
  function makeBus() {
    var list = [];
    return {
      on: function (cb) {
        if (typeof cb !== "function") return function () {};
        list.push(cb);
        return function () {
          var i = list.indexOf(cb);
          if (i >= 0) list.splice(i, 1);
        };
      },
      fire: function (arg) {
        for (var i = 0; i < list.length; i++) {
          try { list[i](arg); } catch (e) { /* UI-layer errors must not kill the loop */ }
        }
      }
    };
  }

  /* ══════════════ FALLBACK + PUBLIC STUB (WebGL absent) ══════════════ */
  function showFallback() {
    try {
      var veil = $("dvLoading"), fb = $("dvFallback");
      if (veil) veil.style.display = "none";
      if (fb) fb.hidden = false;
    } catch (e) { /* noop */ }
  }
  function stubAPI(err) {
    var bus = makeBus();
    return {
      version: "1.0", ready: false, error: String(err && err.message || err || "init failed"),
      onReady: function (cb) { if (typeof cb === "function") { try { cb(false); } catch (e) {} } return function () {}; },
      setTimeWarp: function () {}, getTimeWarp: function () { return 0; },
      setSimTime: function () {}, getSimTime: function () { return 0; },
      pause: function () {}, isPaused: function () { return true; },
      getCatalogStats: function () { return { total: 0, classes: {}, featured: [], events: [] }; },
      selectObject: function () { return null; }, deselect: function () {},
      getSelected: function () { return null; }, onSelect: bus.on,
      classVisibility: function () {}, getClassVisibility: function () { return false; },
      setAltitudeFilter: function () {}, getAltitudeFilter: function () { return ALT_MAX; },
      focusEvent: function () { return null; }, onHover: bus.on,
      getOverlayState: function () { return { ready: false, simTime: 0, warp: 0, paused: true, total: 0, camera: null, selected: null, featured: [] }; }
    };
  }

  /* ══════════════ ENGINE ══════════════ */
  var engine = null;
  try { engine = createEngine(); }
  catch (e) { engine = null; }
  if (!engine) { showFallback(); window.DEBRIS_SIM = stubAPI(e); return; }
  window.DEBRIS_SIM = engine.api;

  function createEngine() {

    /* ───────── 1 · DOM ───────── */
    var stage = document.querySelector(".debris-stage"),
        canvas = $("debris-canvas");
    if (!canvas) throw new Error("missing canvas#debris-canvas");
    var dvLoading = $("dvLoading"), dvLoadFill = $("dvLoadFill"), dvLoadPct = $("dvLoadPct"),
        dvFallback = $("dvFallback");
    if (dvLoading) dvLoading.hidden = false;          // veil visible during build

    if (typeof THREE === "undefined") throw new Error("THREE not loaded");

    /* WebGL capability probe (before touching the big renderer) */
    try {
      var probe = document.createElement("canvas");
      var glc = probe.getContext("webgl2", { failIfMajorPerformanceCaveat: false }) ||
                probe.getContext("webgl", { failIfMajorPerformanceCaveat: false }) ||
                probe.getContext("experimental-webgl");
      if (!glc) throw new Error("no webgl context");
    } catch (e) { throw e; }

    /* ───────── 2 · RENDERER / SCENE / CAMERA ───────── */
    var renderer = new THREE.WebGLRenderer({
      canvas: canvas, antialias: true, logarithmicDepthBuffer: true
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.setClearColor(0x02040A, 1);
    var MAX_PR = Math.min(window.devicePixelRatio || 1, 2);   // DPR cap 2
    renderer.setPixelRatio(MAX_PR);

    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(45, 1, 60, 1.2e6);
    camera.position.set(0, 0, 46000);
    var maxAniso = renderer.capabilities.getMaxAnisotropy();
    var DPR = MAX_PR;

    /* ───────── 3 · SUN + FILL ───────── */
    var sunDir = new THREE.Vector3(1, 0.18, 0.42).normalize();
    var sunLight = new THREE.DirectionalLight(0xfff2e0, 2.2);   // warm key
    sunLight.position.copy(sunDir).multiplyScalar(1e5);
    scene.add(sunLight);
    scene.add(new THREE.AmbientLight(0x223044, 0.35));

    /* ───────── 4 · EARTH — day/night custom shader ───────── */
    var texLoader = new THREE.TextureLoader();
    var loadSteps = 0, LOAD_TOTAL = 8;                 // 4 textures + catalog + 3 frames
    function stepProgress() {
      loadSteps++;
      var pct = clamp(Math.round(loadSteps / LOAD_TOTAL * 100), 0, 100);
      if (dvLoadFill) dvLoadFill.style.width = pct + "%";
      if (dvLoadPct) dvLoadPct.textContent = pct + "%";
    }
    function loadTex(url, srgb) {
      var t = texLoader.load(url, stepProgress, undefined, stepProgress);
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = Math.min(8, maxAniso);
      return t;
    }
    var dayMap = loadTex("images/textures/earth-blue-marble.jpg", true),
        nightMap = loadTex("images/textures/earth-night.jpg", true),
        topoMap = loadTex("images/textures/earth-topology.png", false),
        waterMap = loadTex("images/textures/earth-water.png", false);

    var earthUniforms = {
      dayMap: { value: dayMap }, nightMap: { value: nightMap },
      topoMap: { value: topoMap }, waterMap: { value: waterMap },
      sunDir: { value: sunDir }, uR: { value: R_EARTH },
      uTexel: { value: new THREE.Vector2(1 / 2048, 1 / 1024) }   // topology texel
    };

    var earthMat = new THREE.ShaderMaterial({
      uniforms: earthUniforms,
      vertexShader: [
        "varying vec2 vUv; varying vec3 vN; varying vec3 vWPos;",
        "#include <common>",
        "#include <logdepthbuf_pars_vertex>",
        "void main(){",
        "  vUv = uv;",
        "  vN = normalize(mat3(modelMatrix) * normal);",
        "  vec4 wp = modelMatrix * vec4(position, 1.0);",
        "  vWPos = wp.xyz;",
        "  gl_Position = projectionMatrix * viewMatrix * wp;",
        "  #include <logdepthbuf_vertex>",
        "}"
      ].join("\n"),
      fragmentShader: [
        "uniform sampler2D dayMap, nightMap, topoMap, waterMap;",
        "uniform vec3 sunDir; uniform float uR; uniform vec2 uTexel;",
        "varying vec2 vUv; varying vec3 vN; varying vec3 vWPos;",
        "#include <common>",
        "#include <logdepthbuf_pars_fragment>",
        "void main(){",
        "  #include <logdepthbuf_fragment>",
        "  vec3 N0 = normalize(vN);",
        "  vec3 V = normalize(cameraPosition - vWPos);",
        /* topographic bump: gradient of topology map perturbs the normal */
        "  float h0 = texture2D(topoMap, vUv).r;",
        "  float hx = texture2D(topoMap, vUv + vec2(uTexel.x, 0.0)).r;",
        "  float hy = texture2D(topoMap, vUv + vec2(0.0, uTexel.y)).r;",
        "  vec3 ref = abs(N0.y) > 0.95 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);",
        "  vec3 T = normalize(cross(ref, N0));",
        "  vec3 B = cross(N0, T);",
        "  vec3 N = normalize(N0 - (T * (hx - h0) + B * (hy - h0)) * 16.0);",
        "  float ndl = dot(N, sunDir);",
        "  float ndl0 = dot(N0, sunDir);",
        /* terminator — physical soft transition */
        "  float dayMix = smoothstep(-0.12, 0.18, ndl0);",
        "  float diff = clamp(ndl, 0.0, 1.0);",
        "  float waterM = texture2D(waterMap, vUv).r;",
        /* day side: gentle contrast + saturation; oceans deepened toward
           abyssal blue so ocean/land read as different materials */
        "  vec3 dayCol = texture2D(dayMap, vUv).rgb;",
        "  dayCol = clamp((dayCol - 0.5) * 1.14 + 0.5, 0.0, 1.0);",
        "  float dlum = dot(dayCol, vec3(0.299, 0.587, 0.114));",
        "  dayCol = clamp(mix(vec3(dlum), dayCol, 1.18), 0.0, 1.0);",
        "  dayCol *= mix(vec3(1.0), vec3(0.55, 0.78, 1.12), waterM * 0.55);",
        "  vec3 day = dayCol * (0.05 + 1.6 * diff);",
        /* warm city lights on the night side — luminance gate keeps the
           night ocean truly dark and makes light cores crisper */
        "  vec3 nightCol = texture2D(nightMap, vUv).rgb;",
        "  float nl = dot(nightCol, vec3(0.299, 0.587, 0.114));",
        "  float nightGate = smoothstep(0.045, 0.30, nl);",
        "  vec3 night = nightCol * vec3(1.0, 0.82, 0.55) * (0.55 + 2.6 * nightGate);",
        /* ocean specular glint */
        "  vec3 R = reflect(-sunDir, N);",
        "  float spec = pow(clamp(dot(R, V), 0.0, 1.0), 60.0) * waterM * dayMix * 0.75;",
        "  vec3 col = mix(night, day, dayMix) + vec3(1.0, 0.93, 0.80) * spec;",
        /* subtle warm twilight band hugging the terminator */
        "  float tw = smoothstep(0.22, 0.02, abs(ndl0));",
        "  col += vec3(0.42, 0.16, 0.05) * tw * 0.22;",
        /* thin rayleigh limb on the lit side */
        "  float fres = pow(1.0 - clamp(dot(N0, V), 0.0, 1.0), 3.2);",
        "  col += vec3(0.13, 0.26, 0.44) * fres * (0.20 + 0.80 * dayMix) * 0.45;",
        "  gl_FragColor = vec4(col, 1.0);",
        "  #include <tonemapping_fragment>",
        "  #include <colorspace_fragment>",
        "}"
      ].join("\n")
    });
    var earth = new THREE.Mesh(new THREE.SphereGeometry(R_EARTH, 96, 96), earthMat);
    earth.rotation.order = "YXZ";
    var EARTH_PHI0 = 110 * D2R;   // aligns the Americas to the initial camera view
    earth.rotation.y = EARTH_PHI0;
    scene.add(earth);

    /* atmosphere: thin back-side fresnel haze (r = R·1.024) */
    var ATMO_R = R_EARTH * 1.024;
    var atmoMat = new THREE.ShaderMaterial({
      uniforms: {
        sunDir: { value: sunDir },
        uR: { value: R_EARTH }, uS: { value: ATMO_R },
        uColor: { value: new THREE.Color(0x6EA8D8) }
      },
      side: THREE.BackSide,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      vertexShader: [
        "varying vec3 vWPos;",
        "#include <common>",
        "#include <logdepthbuf_pars_vertex>",
        "void main(){",
        "  vec4 wp = modelMatrix * vec4(position, 1.0);",
        "  vWPos = wp.xyz;",
        "  gl_Position = projectionMatrix * viewMatrix * wp;",
        "  #include <logdepthbuf_vertex>",
        "}"
      ].join("\n"),
      fragmentShader: [
        "uniform vec3 sunDir; uniform float uR, uS; uniform vec3 uColor;",
        "varying vec3 vWPos;",
        "#include <common>",
        "#include <logdepthbuf_pars_fragment>",
        "void main(){",
        "  #include <logdepthbuf_fragment>",
        "  vec3 dir = normalize(vWPos - cameraPosition);",
        "  float b = length(cross(vWPos, dir));",      // impact parameter vs Earth centre
        "  float t = clamp((b - uR) / (uS - uR), 0.0, 1.0);",
        "  float density = exp(-t * 7.0);",            // exponential falloff
        "  float dayF = clamp(dot(normalize(vWPos), sunDir) * 1.45 + 0.42, 0.0, 1.0);",
        "  float a = density * dayF * 0.58;",
        "  gl_FragColor = vec4(uColor, a);",
        "}"
      ].join("\n")
    });
    var atmo = new THREE.Mesh(new THREE.SphereGeometry(ATMO_R, 96, 96), atmoMat);
    atmo.renderOrder = 1;
    scene.add(atmo);

    /* ───────── 5 · STARFIELD (r 7.6e5 shell · no attenuation) ───────── */
    var starUniforms = { uPR: { value: DPR } };
    var starMat = new THREE.ShaderMaterial({
      uniforms: starUniforms,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      vertexShader: [
        "attribute float aSize; attribute vec3 aColor; attribute float aAlpha;",
        "uniform float uPR;",
        "varying vec3 vColor; varying float vAlpha;",
        "#include <common>",
        "#include <logdepthbuf_pars_vertex>",
        "void main(){",
        "  vColor = aColor; vAlpha = aAlpha;",
        "  gl_PointSize = aSize * uPR;",
        "  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);",
        "  #include <logdepthbuf_vertex>",
        "}"
      ].join("\n"),
      fragmentShader: [
        "varying vec3 vColor; varying float vAlpha;",
        "#include <common>",
        "#include <logdepthbuf_pars_fragment>",
        "void main(){",
        "  #include <logdepthbuf_fragment>",
        "  float d = length(gl_PointCoord - vec2(0.5));",
        "  float a = smoothstep(0.5, 0.12, d) * vAlpha;",
        "  if (a < 0.004) discard;",
        "  gl_FragColor = vec4(vColor, a);",
        "}"
      ].join("\n")
    });
    (function buildStars() {
      var N = 5500, pos = new Float32Array(N * 3), col = new Float32Array(N * 3),
          siz = new Float32Array(N), alp = new Float32Array(N);
      var c = new THREE.Color();
      for (var i = 0; i < N; i++) {
        var u = rnd() * 2 - 1, ph = rnd() * TAU, rq = Math.sqrt(1 - u * u), r = 7.6e5;
        pos[i * 3] = r * rq * Math.cos(ph);
        pos[i * 3 + 1] = r * u;
        pos[i * 3 + 2] = r * rq * Math.sin(ph);
        var t = rnd();
        if (t < 0.62) c.setRGB(1, 1, 1);
        else if (t < 0.82) c.setRGB(0.72, 0.82, 1.0);   // blue-white
        else if (t < 0.95) c.setRGB(1.0, 0.88, 0.72);   // warm
        else c.setRGB(1.0, 0.62, 0.55);                 // orange giant
        var lum = 0.35 + Math.pow(rnd(), 2.6) * 0.65;
        col[i * 3] = c.r * lum; col[i * 3 + 1] = c.g * lum; col[i * 3 + 2] = c.b * lum;
        siz[i] = 0.9 + Math.pow(rnd(), 3.0) * 1.8;
        alp[i] = 0.4 + rnd() * 0.6;
      }
      var g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      g.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
      g.setAttribute("aSize", new THREE.BufferAttribute(siz, 1));
      g.setAttribute("aAlpha", new THREE.BufferAttribute(alp, 1));
      var pts = new THREE.Points(g, starMat);
      pts.frustumCulled = false;
      scene.add(pts);
    })();

    /* ───────── 6 · POPULATION POINTS MATERIAL ───────── */
    var pointUniforms = { uPR: { value: DPR } };
    var pointMat = new THREE.ShaderMaterial({
      uniforms: pointUniforms,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      vertexShader: [
        "attribute float aSize; attribute vec3 aColor; attribute float aAlpha;",
        "uniform float uPR;",
        "varying vec3 vColor; varying float vAlpha;",
        "#include <common>",
        "#include <logdepthbuf_pars_vertex>",
        "void main(){",
        "  vColor = aColor; vAlpha = aAlpha;",
        "  vec4 mv = modelViewMatrix * vec4(position, 1.0);",
        "  gl_PointSize = clamp(aSize * (300.0 / max(-mv.z, 1.0)), 1.5, 9.0) * uPR;",
        "  gl_Position = projectionMatrix * mv;",
        "  #include <logdepthbuf_vertex>",
        "}"
      ].join("\n"),
      fragmentShader: [
        "varying vec3 vColor; varying float vAlpha;",
        "#include <common>",
        "#include <logdepthbuf_pars_fragment>",
        "void main(){",
        "  #include <logdepthbuf_fragment>",
        "  float d = length(gl_PointCoord - vec2(0.5));",
        "  float a = smoothstep(0.5, 0.18, d) * vAlpha;",
        "  if (a < 0.004) discard;",
        "  gl_FragColor = vec4(vColor, a);",
        "}"
      ].join("\n")
    });

    /* ───────── 7 · CATALOG — statistically representative ─────────
       classes: 0 active · 1 constellation · 2 geo/MEO · 3 debris
                4 breakup fragments · 5 rocket bodies             */
    var CLS_ACTIVE = 0, CLS_CONST = 1, CLS_GEO = 2, CLS_DEBRIS = 3, CLS_BREAKUP = 4, CLS_ROCKET = 5;
    var NCLS = 6;
    var B = [];
    for (var ci = 0; ci < NCLS; ci++) {
      B.push({ a: [], e: [], bb: [], M0: [], n: [], P: [], Q: [], incl: [], size: [], col: [], alp: [] });
    }
    var _c = new THREE.Color();

    /* Per object we precompute the perifocal→scene rotation matrix in
       compressed form: its first two columns P (toward perigee) and Q
       (90° ahead in the orbital plane).  position = X·P + Y·Q, exactly
       the 3×3 matrix product with the third column unused (z ≡ 0). */
    function push(cls, a, e, incDeg, raanDeg, argpDeg, M0deg, size, hex, alpha) {
      var o = B[cls];
      var i = incDeg * D2R, O = raanDeg * D2R, w = argpDeg * D2R;
      var ci_ = Math.cos(i), si = Math.sin(i), cO = Math.cos(O), sO = Math.sin(O), cw = Math.cos(w), sw = Math.sin(w);
      o.a.push(a); o.e.push(e); o.bb.push(a * Math.sqrt(1 - e * e));
      o.M0.push(M0deg * D2R); o.n.push(Math.sqrt(MU / (a * a * a)));
      /* Scene axes are Y-up (three.js). Standard ECI is Z-north, so the
         perifocal basis is mapped (x,y,z)eci → (x,z,−y)scene: inclinations
         are then measured from the scene equator (x–z plane = Earth's spin
         equator), rotations about scene +Y equal ECI Z-rotations, and the
         GEO belt lies in Earth's equatorial plane as it must. */
      o.P.push(cO * cw - sO * sw * ci_, sw * si, -(sO * cw + cO * sw * ci_));
      o.Q.push(-cO * sw - sO * cw * ci_, cw * si, -(-sO * sw + cO * cw * ci_));
      o.incl.push(incDeg);
      o.size.push(size);
      _c.setHex(hex);
      o.col.push(_c.r, _c.g, _c.b);
      o.alp.push(alpha);
    }

    var COL = { active: 0x7FB2C9, const: 0xA8C6D8, geo: 0x7FB2C9, debris: 0xE3A94F, breakup: 0xC94F42, rocket: 0x9AA3B2 };
    var COL_HI = { active: 0xA9D6E8, const: 0xC6E0EE, geo: 0xA9D6E8, debris: 0xF0C778, breakup: 0xE07B6E, rocket: 0xC4CCD8 };
    var ALP = { active: 0.85, const: 0.5, geo: 0.8, debris: 0.55, breakup: 0.5, rocket: 0.7 };
    var featured = [];    // { id,name,cls,idx,a,e,incl,n,raan,argp,regime,altKm }
    var cloudReg = {};    // breakup cloud registry

    function addFeatured(name, cls, a, e, inc, raan, argp, M0, regime, altKm) {
      push(cls, a, e, inc, raan, argp, M0, 640,
           [COL_HI.active, COL_HI.const, COL_HI.geo, COL_HI.debris, COL_HI.breakup, COL_HI.rocket][cls], 1.0);
      featured.push({
        id: featured.length, name: name, cls: cls, idx: B[cls].a.length - 1,
        a: a, e: e, incl: inc, raan: raan, argp: argp,
        n: Math.sqrt(MU / (a * a * a)), regime: regime, altKm: altKm
      });
    }

    /* Walker-style constellation shells: even Ω spacing, even M within plane */
    function shell(cls, planes, per, alt, inc, size, hex, alpha, altJit, incJit) {
      for (var p = 0; p < planes; p++) {
        var raan = p * 360 / planes;
        for (var s = 0; s < per; s++) {
          var M0 = (s / per) * 360 + (p / planes) * (360 / per);
          push(cls, R_EARTH + alt + rr(-altJit, altJit), rr(0, 0.0009),
               inc + rr(-incJit, incJit), raan + rr(-0.4, 0.4), rr(0, 360), (M0 + rr(-0.5, 0.5)) % 360,
               size, hex, alpha);
        }
      }
    }
    shell(CLS_CONST, 28, 175, 550, 53.0, 235, COL.const, ALP.const, 2, 0.15);   // Starlink shell 1
    shell(CLS_CONST, 12, 125, 540, 53.2, 225, COL.const, ALP.const, 2, 0.15);   // Starlink shell 2
    shell(CLS_CONST, 24, 25, 560, 97.6, 225, COL.const, ALP.const, 2, 0.15);    // Starlink polar
    shell(CLS_CONST, 12, 50, 1200, 87.9, 245, COL.const, ALP.const, 8, 0.1);    // OneWeb

    /* GNSS (slightly larger sprites so MEO reads at distance) */
    shell(CLS_GEO, 6, 31, 20180, 55.0, 430, COL.geo, 0.85, 45, 0.3);            // GPS
    shell(CLS_GEO, 3, 24, 19100, 63.0, 420, COL.geo, 0.85, 45, 0.3);            // GLONASS
    shell(CLS_GEO, 3, 26, 23222, 56.0, 430, COL.geo, 0.85, 45, 0.3);            // Galileo

    /* GEO belt — clustered at preferred longitudes */
    (function geoBelt() {
      var slots = [-135, -118, -102, -89, -75, -61, -45, -30, -12, 3, 16, 32, 48, 64, 78, 95, 110, 125, 140, 155];
      var per = Math.round(560 / slots.length);
      for (var k = 0; k < slots.length; k++) {
        for (var j = 0; j < per; j++) {
          var lam = slots[k] + rgauss() * 36 - 18;    // clustered jitter
          var inc = rr(0.05, 0.15);
          /* Ω = ω = 0 so the sub-satellite longitude is set by M0 alone —
             GEO slots hold station over their clustered longitudes */
          push(CLS_GEO, GEO_R + rr(-4, 4), rr(0, 0.004), inc, 0, 0, lam, 350, COL.geo, 0.8);
        }
      }
      /* GEO graveyard disposal ring: 250–350 km above GEO, slight incl */
      for (var g = 0; g < 400; g++) {
        push(CLS_GEO, GEO_R + rr(250, 350), rr(0.002, 0.012), rr(2, 8), rr(0, 360), rr(0, 360), rr(0, 360),
             265, COL.debris, 0.6);
      }
      /* Molniya — highly elliptical, apogee dwell over the north */
      for (var m = 0; m < 40; m++) {
        push(CLS_GEO, 26562 + rr(-90, 90), rr(0.735, 0.745), 63.4 + rr(-0.4, 0.4), rr(0, 360), 270 + rr(-2, 2), rr(0, 360),
             380, COL.geo, 0.8);
      }
      /* GTO rocket bodies */
      for (var t = 0; t < 250; t++) {
        push(CLS_ROCKET, 24400 + rr(-700, 700), rr(0.715, 0.735), rr(6, 28), rr(0, 360), rr(0, 360), rr(0, 360),
             300, COL.rocket, ALP.rocket);
      }
    })();

    /* LEO active satellites — mixed inclinations, near-circular */
    (function leoActive() {
      var pool = [51.6, 51.6, 51.6, 53.0, 53.0, 53.0, 97.4, 97.8, 98.2, 98.6, 63.4, 74.0, 86.4, 28.5, 45.0, 70.0, 0.1, 82.0];
      for (var k = 0; k < 1600; k++) {
        var alt = 400 + 800 * Math.pow(rnd(), 1.6);
        push(CLS_ACTIVE, R_EARTH + alt, rr(0, 0.018), pool[(rnd() * pool.length) | 0] + rr(-1.2, 1.2),
             rr(0, 360), rr(0, 360), rr(0, 360), 300, COL.active, ALP.active);
      }
      /* sun-synchronous Earth-observation cluster */
      for (var s = 0; s < 800; s++) {
        push(CLS_ACTIVE, R_EARTH + rr(500, 800), rr(0, 0.008), rr(97.5, 98.7),
             rr(0, 360), rr(0, 360), rr(0, 360), 300, COL.active, ALP.active);
      }
    })();

    /* rocket bodies in LEO: near-circular + dumped transfer stages */
    (function rocketLEO() {
      for (var k = 0; k < 1800; k++) {
        push(CLS_ROCKET, R_EARTH + rr(450, 1000), rr(0, 0.015), rr(35, 100),
             rr(0, 360), rr(0, 360), rr(0, 360), 295, COL.rocket, ALP.rocket);
      }
      for (var d = 0; d < 300; d++) {                    // elliptical dumped stages
        var rp = R_EARTH + rr(200, 600), ra = R_EARTH + rr(2500, 9500);
        var a = (rp + ra) / 2, e = (ra - rp) / (ra + rp);
        push(CLS_ROCKET, a, e, rr(35, 100), rr(0, 360), rr(0, 360), rr(0, 360), 295, COL.rocket, ALP.rocket);
      }
    })();

    /* breakup fragmentation clouds (parent orbit + spread) */
    function breakupCloud(name, count, alt, inc, dA, dI, dO) {
      var start = B[CLS_BREAKUP].a.length;
      var raan0 = rr(0, 360);
      for (var k = 0; k < count; k++) {
        push(CLS_BREAKUP,
             R_EARTH + alt + (rgauss() * 2 - 1) * dA,
             rr(0, 0.02),
             inc + (rgauss() * 2 - 1) * dI,
             raan0 + (rgauss() * 2 - 1) * dO,
             rr(0, 360),
             rr(0, 360),
             205, COL.breakup, ALP.breakup);
      }
      cloudReg[name] = { cls: CLS_BREAKUP, start: start, count: count, alt: alt, inc: inc };
    }
    breakupCloud("fy1c", 2800, 850, 99.0, 60, 1.2, 4);     // Fengyun-1C 2007
    breakupCloud("c2251", 1400, 780, 74.0, 55, 1.2, 4);    // Cosmos-2251 2009
    breakupCloud("iridium", 900, 780, 86.4, 55, 1.0, 4);   // Iridium-33 2009
    breakupCloud("c1408", 400, 480, 82.6, 40, 1.0, 4);     // Cosmos-1408 2021
    breakupCloud("shakti", 90, 300, 96.6, 30, 1.0, 4);     // Mission Shakti 2019

    /* general debris (brass): scattered LEO + some elliptical */
    (function generalDebris() {
      for (var k = 0; k < 2200; k++) {
        if (rnd() < 0.76) {
          push(CLS_DEBRIS, R_EARTH + rr(350, 1400), rr(0, 0.02), rr(0, 100),
               rr(0, 360), rr(0, 360), rr(0, 360), 225, COL.debris, ALP.debris);
        } else {
          var rp = R_EARTH + rr(300, 700), ra = rp + rr(400, 3200);
          var a = (rp + ra) / 2, e = (ra - rp) / (ra + rp);
          push(CLS_DEBRIS, a, e, rr(0, 100), rr(0, 360), rr(0, 360), rr(0, 360), 225, COL.debris, ALP.debris);
        }
      }
    })();

    /* featured objects — real published parameters */
    addFeatured("ISS", CLS_ACTIVE, 6793, 0.0013, 51.64, 120, 40, 245, "LEO — LOW EARTH ORBIT", 415);
    addFeatured("HUBBLE", CLS_ACTIVE, 6906, 0.0003, 28.47, 80, 200, 130, "LEO — LOW EARTH ORBIT", 535);
    addFeatured("STARLINK-1007", CLS_CONST, 6921, 0.0004, 53.0, 137.1, 90, 20, "LEO — CONSTELLATION SHELL", 550);
    addFeatured("NOAA-19", CLS_ACTIVE, 7241, 0.0014, 98.7, 210, 65, 300, "LEO — SUN-SYNCHRONOUS", 870);
    addFeatured("ENVISAT", CLS_DEBRIS, 7139, 0.0001, 98.4, 97, 130, 45, "LEO — LARGEST DEBRIS OBJECT", 768);
    addFeatured("GPS IIF-10", CLS_GEO, 26551, 0.001, 55.0, 45, 60, 120, "MEO — NAVIGATION SHELL", 20180);
    addFeatured("GOES-16", CLS_GEO, GEO_R, 0.0002, 0.1, 0, 0, 34.8, "GEO — GEOSTATIONARY BELT", 35786);
    addFeatured("MOLNIYA 3-51", CLS_GEO, 26562, 0.74, 63.4, 250, 270, 10, "HEO — HIGHLY ELLIPTICAL", 500);

    /* finalize class buffers → typed arrays + one Points object per class */
    var classes = [], TOTAL = 0;
    for (var k2 = 0; k2 < NCLS; k2++) {
      var o = B[k2], N = o.a.length; TOTAL += N;
      var pos = new Float32Array(N * 3);
      var aA = new Float32Array(o.a), eA = new Float32Array(o.e), bA = new Float32Array(o.bb),
          mA = new Float32Array(o.M0), nA = new Float32Array(o.n),
          PA = new Float32Array(o.P), QA = new Float32Array(o.Q),
          inclA = new Float32Array(o.incl), sizeA = new Float32Array(o.size),
          colA = new Float32Array(o.col), alpA = new Float32Array(o.alp),
          alphaA = new Float32Array(alpA);
      var g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute("aColor", new THREE.BufferAttribute(colA, 3));
      g.setAttribute("aSize", new THREE.BufferAttribute(sizeA, 1).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute("aAlpha", new THREE.BufferAttribute(alphaA, 1).setUsage(THREE.DynamicDrawUsage));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 46600);
      var pts = new THREE.Points(g, pointMat);
      pts.frustumCulled = false;
      pts.renderOrder = 2;
      scene.add(pts);
      classes.push({
        N: N, pos: pos, a: aA, e: eA, b: bA, M0: mA, n: nA, P: PA, Q: QA,
        incl: inclA, size: sizeA, baseSize: sizeA.slice(0), col: colA, alp: alpA, alpha: alphaA,
        geo: g, points: pts,
        posAttr: g.attributes.position, sizeAttr: g.attributes.aSize, alphaAttr: g.attributes.aAlpha
      });
      B[k2] = null;
    }
    var breakupCls = classes[CLS_BREAKUP];
    var idBase = [10000, 32000, 52000, 74000, 76000, 82000];   // pseudo catalog IDs

    /* feature lookup: cls*1e7 + idx → featured record */
    var featMap = {};
    featured.forEach(function (f) { featMap[f.cls * 1e7 + f.idx] = f; });

    /* ───────── 8 · KEPLER PROPAGATION (zero allocation) ───────── */
    var simTime = 0, warp = reduceMotion ? 1 : 60, playing = true, simDirty = true;

    function propagate() {
      for (var c = 0; c < NCLS; c++) {
        var K = classes[c], N = K.N, pos = K.pos,
            aA = K.a, eA = K.e, bA = K.b, mA = K.M0, nA = K.n, PA = K.P, QA = K.Q;
        for (var i = 0; i < N; i++) {
          var M = mA[i] + nA[i] * simTime;
          M %= TAU; if (M < 0) M += TAU;
          var X, Y, e = eA[i], a = aA[i];
          if (e <= 0.02) {
            /* near-circular: closed form (the vast majority of objects) */
            X = a * Math.cos(M); Y = a * Math.sin(M);
          } else {
            /* elliptical: Newton-Raphson on M = E − e·sinE */
            var E = M + e * Math.sin(M);
            for (var it = 0; it < 6; it++) {
              var f = E - e * Math.sin(E) - M;
              var d = f / (1 - e * Math.cos(E));
              E -= d;
              if (d * d < 1e-14) break;
            }
            X = a * (Math.cos(E) - e);
            Y = bA[i] * Math.sin(E);
          }
          var j = i * 3;
          pos[j]     = PA[j]     * X + QA[j]     * Y;
          pos[j + 1] = PA[j + 1] * X + QA[j + 1] * Y;
          pos[j + 2] = PA[j + 2] * X + QA[j + 2] * Y;
        }
        K.posAttr.needsUpdate = true;
      }
    }
    propagate();

    /* ───────── 9 · FEATURED ORBIT LINES / REFERENCE GRID / FX ───────── */
    var orbitGroup = new THREE.Group();
    scene.add(orbitGroup);

    function orbitPositions(cls, idx, steps) {
      var K = classes[cls], a = K.a[idx], e = K.e[idx], b = K.b[idx],
          PA = K.P, QA = K.Q, p = idx * 3;
      var arr = new Float32Array(steps * 3);
      for (var s = 0; s < steps; s++) {
        var E = (s / steps) * TAU;
        var X = a * (Math.cos(E) - e), Y = b * Math.sin(E);
        arr[s * 3]     = PA[p] * X + QA[p] * Y;
        arr[s * 3 + 1] = PA[p + 1] * X + QA[p + 1] * Y;
        arr[s * 3 + 2] = PA[p + 2] * X + QA[p + 2] * Y;
      }
      return arr;
    }
    var featLines = [];
    featured.forEach(function (f) {
      var g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(orbitPositions(f.cls, f.idx, 256), 3));
      var line = new THREE.LineLoop(g, new THREE.LineBasicMaterial({
        color: 0x7FB2C9, transparent: true, opacity: 0.16, depthWrite: false
      }));
      orbitGroup.add(line);
      featLines.push(line);
    });
    /* orbit lines follow the altitude band too — the microscope scrub
       must clear high shells completely, lines included */
    function syncOrbitLines() {
      for (var i = 0; i < featLines.length; i++) {
        var inBand = altFilterKm >= ALT_MAX ||
                     Math.abs((featured[i].a - R_EARTH) - altFilterKm) / altFilterKm <= 0.25;
        featLines[i].visible = vis.orbits && inBand;
      }
      if (selLine) selLine.visible = !!selected;
    }

    /* selected-object orbit path (bright) */
    var selLine = null;
    function showOrbit(f) {
      var g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(orbitPositions(f.cls, f.idx, 256), 3));
      selLine = new THREE.LineLoop(g, new THREE.LineBasicMaterial({
        color: 0x7FB2C9, transparent: true, opacity: 0.55, depthWrite: false
      }));
      orbitGroup.add(selLine);
    }
    function hideOrbit() {
      if (selLine) { orbitGroup.remove(selLine); selLine.geometry.dispose(); selLine.material.dispose(); selLine = null; }
    }

    /* faint equatorial reference grid at GEO radius (off by default) */
    var gridObj = (function () {
      var verts = [], RG = GEO_R, segs = 128;
      function ring(rad, y) {
        for (var s = 0; s < segs; s++) {
          var a0 = s / segs * TAU, a1 = (s + 1) / segs * TAU;
          verts.push(Math.cos(a0) * rad, y, Math.sin(a0) * rad, Math.cos(a1) * rad, y, Math.sin(a1) * rad);
        }
      }
      function meridian(raan) {
        var cO = Math.cos(raan), sO = Math.sin(raan);
        for (var s = 0; s < segs; s++) {
          var a0 = s / segs * TAU, a1 = (s + 1) / segs * TAU;
          var x0 = Math.cos(a0) * RG, y0 = Math.sin(a0) * RG, x1 = Math.cos(a1) * RG, y1 = Math.sin(a1) * RG;
          verts.push(cO * x0, y0, sO * x0, cO * x1, y1, sO * x1);
        }
      }
      [-60, -30, 0, 30, 60].forEach(function (la) {
        var lr = la * D2R;
        ring(RG * Math.cos(lr), RG * Math.sin(lr));
      });
      for (var m = 0; m < 6; m++) meridian(m * 30 * D2R);
      var g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
      var obj = new THREE.LineSegments(g, new THREE.LineBasicMaterial({
        color: 0x7FB2C9, transparent: true, opacity: 0.12, depthWrite: false
      }));
      obj.visible = false;
      scene.add(obj);
      return obj;
    })();

    /* shockwave rings + cloud size pulses (fragmentation events) */
    var rings = [];
    for (var r0 = 0; r0 < 3; r0++) {
      var rm = new THREE.Mesh(
        new THREE.RingGeometry(0.9, 1.0, 96),
        new THREE.MeshBasicMaterial({ color: 0xC94F42, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })
      );
      rm.visible = false; rm.frustumCulled = false;
      scene.add(rm);
      rings.push({ mesh: rm, t0: 0, on: false });
    }
    function spawnRing(x, y, z) {
      for (var i = 0; i < rings.length; i++) {
        if (!rings[i].on) {
          rings[i].on = true; rings[i].t0 = performance.now();
          rings[i].mesh.position.set(x, y, z);
          rings[i].mesh.visible = true;
          return;
        }
      }
    }
    var pulses = [];   // {start, count, t0}
    function spawnPulse(cloud) {
      pulses.push({ start: cloud.start, count: cloud.count, t0: performance.now() });
    }

    /* ───────── 10 · CAMERA + CONTROLS (custom damped orbit) ───────── */
    var cam = { lon: -40 * D2R, lat: 18 * D2R, dist: 46000, tLon: -40 * D2R, tLat: 18 * D2R, tDist: 46000 };
    var vLon = 0, vLat = 0, lastInput = performance.now();
    var camTween = null, intro = null;

    function applyCamera() {
      var cl = Math.cos(cam.lat);
      camera.position.set(
        cam.dist * cl * Math.cos(cam.lon),
        cam.dist * Math.sin(cam.lat),
        cam.dist * cl * Math.sin(cam.lon)
      );
      camera.lookAt(0, 0, 0);
    }
    function cancelAuto() {
      lastInput = performance.now();
      if (intro) intro = null;
      if (camTween) { camTween = null; cam.tLon = cam.lon; cam.tLat = cam.lat; cam.tDist = cam.dist; }
      vLon = 0; vLat = 0;
    }

    function updateCamera(dt, now) {
      if (intro) {
        var p = clamp((now - intro.t0) / intro.dur, 0, 1), e = easeOutCubic(p);
        cam.lon = cam.tLon = lerp(intro.fromLon, intro.toLon, e);
        cam.lat = cam.tLat = lerp(intro.fromLat, intro.toLat, e);
        cam.dist = cam.tDist = lerp(intro.fromDist, intro.toDist, e);
        if (p >= 1) intro = null;
      } else if (camTween) {
        var pt = clamp((now - camTween.t0) / camTween.dur, 0, 1), et = easeInOut(pt);
        cam.lon = cam.tLon = lerp(camTween.fromLon, camTween.toLon, et);
        cam.lat = cam.tLat = lerp(camTween.fromLat, camTween.toLat, et);
        cam.dist = cam.tDist = lerp(camTween.fromDist, camTween.toDist, et);
        if (pt >= 1) camTween = null;
      } else {
        /* release inertia */
        if (Math.abs(vLon) > 1e-6 || Math.abs(vLat) > 1e-6) {
          cam.tLon += vLon * dt;
          cam.tLat = clamp(cam.tLat + vLat * dt, -1.45, 1.45);
          var decay = Math.exp(-5.2 * dt);
          vLon *= decay; vLat *= decay;
        }
        /* idle auto-rotate: 0.02°/frame ≈ 1.2°/s after 10 s idle */
        if (!reduceMotion && now - lastInput > 10000) cam.tLon += 1.2 * D2R * dt;
        /* damped approach (lerp ≈ .08/frame @60 fps) */
        var kR = 1 - Math.exp(-5.2 * dt);
        var kZ = 1 - Math.exp(-9.5 * dt);
        cam.lon += (cam.tLon - cam.lon) * kR;
        cam.lat += (cam.tLat - cam.lat) * kR;
        cam.dist += (cam.tDist - cam.dist) * kZ;
      }
      applyCamera();
    }

    /* pointer / wheel / touch / keyboard */
    var pointers = new Map(), dragBtn = -1, downX = 0, downY = 0, downT = 0,
        lastX = 0, lastY = 0, lastMoveT = 0, moved = 0, pinchD = 0;

    function rotSpeed() { return 0.0045 * clamp(cam.dist / 46000, 0.22, 1.5); }

    canvas.addEventListener("pointerdown", function (e) {
      cancelAuto();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        dragBtn = e.pointerId; downX = lastX = e.clientX; downY = lastY = e.clientY;
        downT = lastMoveT = performance.now(); moved = 0;
      } else if (pointers.size === 2) {
        var pts = Array.from(pointers.values());
        pinchD = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      }
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
      canvas.focus({ preventScroll: true });
      e.preventDefault();
    });
    canvas.addEventListener("pointermove", function (e) {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        var pts = Array.from(pointers.values());
        var d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (pinchD > 0 && d > 0) cam.tDist = clamp(cam.tDist * pinchD / d, MIN_DIST, MAX_DIST);
        pinchD = d;
        cancelAuto();
        return;
      }
      if (e.pointerId === dragBtn) {
        var now = performance.now();
        var dx = e.clientX - lastX, dy = e.clientY - lastY;
        lastX = e.clientX; lastY = e.clientY;
        moved += Math.abs(dx) + Math.abs(dy);
        var sp = rotSpeed(), mdt = Math.max(now - lastMoveT, 4) / 1000;
        lastMoveT = now;
        cam.tLon += dx * sp;
        cam.tLat = clamp(cam.tLat + dy * sp, -1.45, 1.45);
        vLon = vLon * 0.5 + (dx * sp / mdt) * 0.5;
        vLat = vLat * 0.5 + (dy * sp / mdt) * 0.5;
        vLon = clamp(vLon, -2.5, 2.5); vLat = clamp(vLat, -2.5, 2.5);
        lastInput = now;
      } else {
        /* hover tracking (no buttons) */
        hoverX = e.clientX; hoverY = e.clientY; hoverFresh = true;
      }
    });
    function endPointer(e) {
      pointers.delete(e.pointerId);
      if (e.pointerId === dragBtn) {
        dragBtn = -1;
        var now = performance.now();
        if (moved < 6 && now - downT < 600) doPick(e.clientX, e.clientY);
        if (now - lastMoveT > 90) { vLon = 0; vLat = 0; }   // stop stale flings
      }
      if (pointers.size < 2) pinchD = 0;
    }
    canvas.addEventListener("pointerup", endPointer);
    canvas.addEventListener("pointercancel", endPointer);

    canvas.addEventListener("wheel", function (e) {
      cancelAuto();
      var f = e.deltaY > 0 ? 1.06 : 0.94;               // multiplicative zoom
      cam.tDist = clamp(cam.tDist * f, MIN_DIST, MAX_DIST);
      e.preventDefault();
    }, { passive: false });

    canvas.addEventListener("keydown", function (e) {
      var k = e.key, handled = true;
      if (k === "ArrowLeft") { cancelAuto(); cam.tLon -= 2.4 * D2R; }
      else if (k === "ArrowRight") { cancelAuto(); cam.tLon += 2.4 * D2R; }
      else if (k === "ArrowUp") { cancelAuto(); cam.tLat = clamp(cam.tLat + 1.8 * D2R, -1.45, 1.45); }
      else if (k === "ArrowDown") { cancelAuto(); cam.tLat = clamp(cam.tLat - 1.8 * D2R, -1.45, 1.45); }
      else if (k === "+" || k === "=") { cancelAuto(); cam.tDist = clamp(cam.tDist * 0.88, MIN_DIST, MAX_DIST); }
      else if (k === "-" || k === "_") { cancelAuto(); cam.tDist = clamp(cam.tDist * 1.14, MIN_DIST, MAX_DIST); }
      else if (k === " ") { setPlaying(!playing); }
      else handled = false;
      if (handled) e.preventDefault();
    });

    /* ───────── 11 · RAYCAST — HOVER / SELECT FEED ───────── */
    var raycaster = new THREE.Raycaster();
    var ndc = new THREE.Vector2();
    var hoverX = -1, hoverY = -1, hoverFresh = false, hoverObj = null, hoverFeat = null;
    var _castObjs = [];

    function castAll(cx, cy) {
      var rect = canvas.getBoundingClientRect();
      ndc.set(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      raycaster.params.Points.threshold = clamp(cam.dist * 0.004, 22, 280);
      _castObjs.length = 0;
      for (var c = 0; c < NCLS; c++) if (classes[c].points.visible) _castObjs.push(classes[c].points);
      return raycaster.intersectObjects(_castObjs, false);
    }

    /* featured objects win over nearer anonymous objects lying on the same
       ray — otherwise random LEO neighbours would swallow every click */
    function pickFromHits(hits) {
      var out = { feat: null, plain: null, cls: -1, idx: -1 };
      for (var h = 0; h < hits.length; h++) {
        var hit = hits[h], ci2 = -1;
        for (var c = 0; c < NCLS; c++) if (classes[c].points === hit.object) { ci2 = c; break; }
        if (ci2 < 0) continue;
        if (classes[ci2].alpha[hit.index] < 0.12) continue;   // faded out by altitude filter
        var ff = featMap[ci2 * 1e7 + hit.index];
        if (ff) { out.feat = ff; out.cls = ci2; out.idx = hit.index; break; }
        if (!out.plain) { out.plain = hit; out.cls = ci2; out.idx = hit.index; }
      }
      return out;
    }

    function hoverPayload(cls, idx, feat) {
      var K = classes[cls], i = idx;
      var x = K.pos[i * 3], y = K.pos[i * 3 + 1], z = K.pos[i * 3 + 2];
      var r = Math.sqrt(x * x + y * y + z * z);
      return {
        id: feat ? feat.name : "OBJ " + (idBase[cls] + i),
        cls: CLS_NAMES[cls],
        featured: !!feat,
        altKm: Math.max(r - R_EARTH, 0),
        inclDeg: K.incl[i]
      };
    }

    function doHover() {
      if (dragBtn !== -1 || hoverX < 0) {
        if (hoverObj) { hoverObj = null; hoverFeat = null; canvas.style.cursor = "grab"; hoverBus.fire(null); }
        return;
      }
      var pick = pickFromHits(castAll(hoverX, hoverY));
      if (pick.feat || pick.plain) {
        var same = hoverObj && hoverObj.c === pick.cls && hoverObj.i === pick.idx;
        if (!same) {
          hoverObj = { c: pick.cls, i: pick.idx };
          hoverFeat = pick.feat || null;
          canvas.style.cursor = "pointer";
          hoverBus.fire(hoverPayload(pick.cls, pick.idx, pick.feat));
        }
      } else if (hoverObj) {
        hoverObj = null; hoverFeat = null;
        canvas.style.cursor = "grab";
        hoverBus.fire(null);
      }
    }

    function doPick(cx, cy) {
      var pick = pickFromHits(castAll(cx, cy));
      if (pick.feat) selectFeatured(pick.feat);
      else deselect();
    }

    /* ───────── 12 · SELECTION (orbit line + point highlight) ───────── */
    var selected = null, selBoost = null;
    var selectBus = makeBus(), hoverBus = makeBus(), readyBus = makeBus();

    function featuredLive(f) {
      var K = classes[f.cls], i = f.idx;
      var x = K.pos[i * 3], y = K.pos[i * 3 + 1], z = K.pos[i * 3 + 2];
      var r = Math.sqrt(x * x + y * y + z * z);
      var v = Math.sqrt(MU * (2 / Math.max(r, 1) - 1 / f.a));
      var periodMin = TAU / f.n / 60;
      return {
        id: f.id, name: f.name, regime: f.regime, cls: CLS_NAMES[f.cls],
        altKm: Math.max(r - R_EARTH, 0),          // live altitude
        altKmPublished: f.altKm,
        inclDeg: f.incl, ecc: f.e,
        periodMin: periodMin,
        velKms: v,
        raanDeg: f.raan, argpDeg: f.argp,
        perigeeKm: f.a * (1 - f.e) - R_EARTH,
        apogeeKm: f.a * (1 + f.e) - R_EARTH,
        screen: selected === f && selScr.visible ? { x: selScr.x, y: selScr.y, visible: true } : null
      };
    }

    function selectFeatured(f) {
      if (selected === f) return featuredLive(f);
      if (selBoost) restoreBoost();
      selected = f;
      hideOrbit(); showOrbit(f);
      boostPoint(f.cls, f.idx, 2.1);
      selectBus.fire(featuredLive(f));
      return featuredLive(f);
    }
    function boostPoint(cls, idx, mult) {
      var K = classes[cls];
      K.size[idx] = K.baseSize[idx] * mult;
      K.sizeAttr.needsUpdate = true;
      selBoost = { cls: cls, idx: idx };
    }
    function restoreBoost() {
      if (!selBoost) return;
      var K = classes[selBoost.cls];
      K.size[selBoost.idx] = K.baseSize[selBoost.idx];
      K.sizeAttr.needsUpdate = true;
      selBoost = null;
    }
    function deselect() {
      if (!selected) return null;
      selected = null;
      restoreBoost();
      hideOrbit();
      selectBus.fire(null);
      return null;
    }

    /* ───────── 13 · LAYER VISIBILITY ───────── */
    var CLS_NAMES = ["active", "const", "geo", "debris", "breakup", "rocket"];
    var vis = { active: true, const: true, geo: true, debris: true, breakup: true, rocket: true,
                orbits: true, labels: true, grid: false };
    var CLS_ALIAS = {
      active: "active", activesat: "active", activesatellites: "active", satellites: "active",
      const: "const", constellation: "const", constellations: "const", starlink: "const", oneweb: "const",
      geo: "geo", geobelt: "geo", gnss: "geo", meo: "geo",
      debris: "debris", fragments: "debris", fragment: "debris", general: "debris",
      breakup: "breakup", breakupevents: "breakup", breakupdebris: "breakup", events: "breakup",
      rocket: "rocket", rocketbodies: "rocket", rockets: "rocket",
      orbits: "orbits", featurorbits: "orbits", featuredorbits: "orbits", orbitlines: "orbits",
      labels: "labels", label: "labels", featuredlabels: "labels",
      grid: "grid", equatorialgrid: "grid", geogrid: "grid"
    };
    function resolveLayer(name) {
      var k = String(name || "").toLowerCase().replace(/[\s_-]/g, "");
      return CLS_ALIAS[k] || null;
    }
    function setLayer(name, on) {
      var key = resolveLayer(name);
      if (!key) return false;
      on = !!on;
      vis[key] = on;
      if (key === "orbits") { orbitGroup.visible = on; syncOrbitLines(); }
      else if (key === "grid") gridObj.visible = on;
      else if (key === "labels") { /* UI-layer flag — read via getClassVisibility('labels') */ }
      else {
        var clsIdx = CLS_NAMES.indexOf(key);
        if (clsIdx >= 0) classes[clsIdx].points.visible = on;
      }
      return true;
    }
    function getLayer(name) {
      var key = resolveLayer(name);
      return key ? !!vis[key] : false;
    }

    /* ───────── 14 · ALTITUDE FILTER (±25 % band, alpha fade) ───────── */
    var altFilterKm = ALT_MAX;    // cleared state = full catalog
    function applyAltFilter(v) {
      for (var c = 0; c < NCLS; c++) {
        var K = classes[c], N = K.N, aA = K.a, alp = K.alp, alpha = K.alpha;
        for (var i = 0; i < N; i++) {
          var rel = Math.abs((aA[i] - R_EARTH) - v) / v;   // mean-altitude offset
          var f = rel <= 0.19 ? 1 : (rel >= 0.25 ? 0 : 1 - (rel - 0.19) / 0.06);
          alpha[i] = alp[i] * f;
        }
        K.alphaAttr.needsUpdate = true;
      }
      syncOrbitLines();
    }
    function clearAltFilter() {
      altFilterKm = ALT_MAX;
      for (var c = 0; c < NCLS; c++) {
        var K = classes[c];
        K.alpha.set(K.alp);
        K.alphaAttr.needsUpdate = true;
      }
      syncOrbitLines();
    }

    /* ───────── 15 · FRAGMENTATION EVENTS ───────── */
    var EVENTS = [
      { id: "sputnik", year: 1957, label: "SPUTNIK 1 · FIRST OBJECT", count: 1, clouds: [],
        info: "FIRST ARTIFICIAL SATELLITE · ALT 577 KM · PERIOD 96.2 MIN" },
      { id: "fy1c", year: 2007, label: "FENGYUN-1C ASAT", count: 2800, clouds: ["fy1c"],
        info: "ASAT TEST · ALT 850 KM · INCL 99.0°" },
      { id: "collision", year: 2009, label: "IRIDIUM 33 × COSMOS 2251", count: 2300, clouds: ["c2251", "iridium"],
        info: "ON-ORBIT COLLISION · ALT 780 KM" },
      { id: "c1408", year: 2021, label: "COSMOS 1408 ASAT", count: 400, clouds: ["c1408"],
        info: "ASAT TEST · ALT 480 KM · INCL 82.6°" },
      { id: "shakti", year: 2019, label: "MISSION SHAKTI ASAT", count: 90, clouds: ["shakti"],
        info: "ASAT TEST · ALT 300 KM · INCL 96.6°" }
    ];
    var CLOUD_ALIAS = { c2251: "collision", iridium: "collision", "iridium33": "collision", fy1c: "fy1c",
                        fengyun: "fy1c", "fengyun1c": "fy1c", c1408: "c1408", cosmos1408: "c1408",
                        shakti: "shakti", sputnik: "sputnik", collision: "collision", "2009": "collision" };

    /* Clouds wrap the entire parent orbit — aim the camera off the orbit-plane
       normal so the debris ring reads face-on-ish, and anchor the shockwave
       ring at the cloud point nearest that viewing direction. */
    function cloudFocus(cloud) {
      var K = classes[cloud.cls], N = cloud.count;
      var p0 = cloud.start * 3;
      var Px = K.P[p0], Py = K.P[p0 + 1], Pz = K.P[p0 + 2];
      var Qx = K.Q[p0], Qy = K.Q[p0 + 1], Qz = K.Q[p0 + 2];
      var nx = Py * Qz - Pz * Qy, ny = Pz * Qx - Px * Qz, nz = Px * Qy - Py * Qx;
      var nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }   // prefer northern view
      var cA = Math.cos(62 * D2R), sA = Math.sin(62 * D2R);
      var vx = nx * cA + Px * sA, vy = ny * cA + Py * sA, vz = nz * cA + Pz * sA;
      var vl = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
      vx /= vl; vy /= vl; vz /= vl;
      var sr = 0, best = -2, bx = 0, by = 0, bz = 0;
      for (var i = cloud.start; i < cloud.start + N; i++) {
        var x = K.pos[i * 3], y = K.pos[i * 3 + 1], z = K.pos[i * 3 + 2];
        var r = Math.sqrt(x * x + y * y + z * z);
        sr += r;
        var dot = (x * vx + y * vy + z * vz) / r;
        if (dot > best) { best = dot; bx = x; by = y; bz = z; }
      }
      return { vx: vx, vy: vy, vz: vz, r: sr / N, bx: bx, by: by, bz: bz };
    }

    function focusEventById(ev) {
      if (!ev.clouds.length) return ev;              // 1957 — info only
      var vx = 0, vy = 0, vz = 0, rBar = 0;
      ev.clouds.forEach(function (cn) {
        var cloud = cloudReg[cn];
        if (!cloud) return;
        spawnPulse(cloud);
        var fo = cloudFocus(cloud);
        vx += fo.vx; vy += fo.vy; vz += fo.vz; rBar += fo.r;
        spawnRing(fo.bx, fo.by, fo.bz);
      });
      var nn = ev.clouds.length;
      vx /= nn; vy /= nn; vz /= nn; rBar /= nn;
      var vl = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
      var toDist = clamp(rBar * 2.35, MIN_DIST, MAX_DIST);
      var toLat = clamp(Math.asin(clamp(vy / vl, -1, 1)), -1.45, 1.45);
      var toLon = Math.atan2(vz, vx);
      while (toLon - cam.lon > Math.PI) toLon -= TAU;   // shortest longitude path
      while (toLon - cam.lon < -Math.PI) toLon += TAU;
      camTween = {
        t0: performance.now(), dur: 1900,
        fromLon: cam.lon, toLon: toLon,
        fromLat: cam.lat, toLat: toLat,
        fromDist: cam.dist, toDist: toDist
      };
      lastInput = performance.now();
      return ev;
    }

    /* ───────── 16 · OVERLAY PROJECTION (labels / reticle feed) ───────── */
    var _proj = new THREE.Vector3();
    var featScrX = new Float32Array(featured.length),
        featScrY = new Float32Array(featured.length),
        featScrV = new Uint8Array(featured.length);
    var selScr = { x: 0, y: 0, visible: false };

    function occludedByEarth(x, y, z) {
      var cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
      var dx = x - cx, dy = y - cy, dz = z - cz;
      var L2 = dx * dx + dy * dy + dz * dz;
      var s = -(cx * dx + cy * dy + cz * dz) / Math.max(L2, 1);   // param of closest approach
      if (s < 0 || s > 1) return false;
      var qx = cx + dx * s, qy = cy + dy * s, qz = cz + dz * s;
      return (qx * qx + qy * qy + qz * qz) < R_EARTH * R_EARTH * 0.997;
    }

    function projectPoint(x, y, z, W, H) {
      /* view-space depth gate, then full projection */
      _proj.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
      if (_proj.z > -70) return null;
      _proj.set(x, y, z).project(camera);
      if (_proj.x < -1.06 || _proj.x > 1.06 || _proj.y < -1.1 || _proj.y > 1.1) return null;
      return { x: (_proj.x + 1) / 2 * W, y: (1 - _proj.y) / 2 * H };
    }

    function updateOverlay() {
      var W = canvas.clientWidth, H = canvas.clientHeight;
      for (var i = 0; i < featured.length; i++) {
        var f = featured[i], K = classes[f.cls], idx = f.idx;
        var x = K.pos[idx * 3], y = K.pos[idx * 3 + 1], z = K.pos[idx * 3 + 2];
        var ok = K.points.visible && K.alpha[idx] > 0.45 && !occludedByEarth(x, y, z);
        if (ok) {
          var sp = projectPoint(x, y, z, W, H);
          if (sp) { featScrX[i] = sp.x; featScrY[i] = sp.y; featScrV[i] = 1; }
          else featScrV[i] = 0;
        } else featScrV[i] = 0;
      }
      if (selected) {
        var Ks = classes[selected.cls], is = selected.idx;
        var px = Ks.pos[is * 3], py = Ks.pos[is * 3 + 1], pz = Ks.pos[is * 3 + 2];
        var vis2 = !occludedByEarth(px, py, pz);
        if (vis2) {
          var sp2 = projectPoint(px, py, pz, W, H);
          if (sp2) { selScr.x = sp2.x; selScr.y = sp2.y; selScr.visible = true; }
          else vis2 = false;
        }
        selScr.visible = vis2;
      }
    }

    /* ───────── 17 · RESIZE / VISIBILITY / CONTEXT ───────── */
    function resize() {
      var w = stage ? (stage.clientWidth || 800) : 800;
      var h = stage ? (stage.clientHeight || 600) : 600;
      var pr = Math.min(window.devicePixelRatio || 1, 2);
      if (pr !== MAX_PR) {
        MAX_PR = pr; renderer.setPixelRatio(pr);
        pointUniforms.uPR.value = pr; starUniforms.uPR.value = pr;
      }
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    }
    window.addEventListener("resize", resize);
    resize();

    var raf = 0, lastT = performance.now();
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
      } else if (!raf) {
        lastT = performance.now();
        raf = requestAnimationFrame(frame);
      }
    });
    canvas.addEventListener("webglcontextlost", function (e) { e.preventDefault(); showFallback(); });

    /* ───────── 18 · LOADING / INTRO / MAIN LOOP ───────── */
    var revealed = false, frames = 0, hoverClock = 0, sunClock = 0;

    function reveal() {
      if (revealed) return;
      revealed = true;
      if (dvLoading) {
        dvLoading.classList.add("is-done");
        setTimeout(function () { if (dvLoading) dvLoading.style.display = "none"; }, 900);
      }
      if (stage) stage.classList.add("is-ready");
      api.ready = true;
      readyBus.fire(true);
      /* intro flight: 3.2 s easeOutCubic 160,000 → 46,000 km */
      if (reduceMotion) {
        cam.lon = cam.tLon = -40 * D2R; cam.lat = cam.tLat = 18 * D2R; cam.dist = cam.tDist = 46000;
      } else {
        intro = {
          t0: performance.now(), dur: 3200,
          fromLon: -64 * D2R, toLon: -40 * D2R,
          fromLat: 32 * D2R, toLat: 18 * D2R,
          fromDist: 160000, toDist: 46000
        };
        cam.lon = -64 * D2R; cam.lat = 32 * D2R; cam.dist = 160000;
      }
      applyCamera();
    }
    stepProgress();                                   // catalog built
    var forceTimer = setTimeout(reveal, 7000);        // never hang

    function setPlaying(p) { playing = p; }

    function updateRings(now) {
      for (var i = 0; i < rings.length; i++) {
        var R = rings[i];
        if (!R.on) continue;
        var p = (now - R.t0) / 2000;
        if (p >= 1) { R.on = false; R.mesh.visible = false; continue; }
        var s = lerp(160, 3400, easeOutCubic(p));
        R.mesh.scale.set(s, s, s);
        R.mesh.material.opacity = 0.85 * Math.pow(1 - p, 1.8);
        R.mesh.quaternion.copy(camera.quaternion);
      }
    }
    function updatePulses(now) {
      for (var i = pulses.length - 1; i >= 0; i--) {
        var P = pulses[i], p = (now - P.t0) / 2000;
        var K = breakupCls;
        if (p >= 1) {
          for (var j = P.start; j < P.start + P.count; j++) K.size[j] = K.baseSize[j];
          K.sizeAttr.needsUpdate = true;
          pulses.splice(i, 1);
          continue;
        }
        var mult = 1 + 0.35 * Math.pow(1 - p, 2);
        for (var j2 = P.start; j2 < P.start + P.count; j2++) K.size[j2] = K.baseSize[j2] * mult;
        K.sizeAttr.needsUpdate = true;
      }
    }

    function frame(now) {
      var dt = Math.min((now - lastT) / 1000, 0.05);
      lastT = now;

      if (playing) { simTime += dt * warp; simDirty = true; }
      if (simDirty) { propagate(); simDirty = false; }

      /* Earth sidereal spin (1 rev / sidereal day, tracks sim clock) */
      earth.rotation.y = EARTH_PHI0 + EARTH_ROT * simTime;
      /* slow living sunlight — rotate the sun vector about Y at 0.02°/s */
      if (!reduceMotion) {
        sunClock += dt;
        var dA = sunClock * 0.02 * D2R;
        var sx0 = Math.cos(dA) * 1.0 + Math.sin(dA) * 0.42;
        var sz0 = -Math.sin(dA) * 1.0 + Math.cos(dA) * 0.42;
        sunDir.set(sx0, 0.18, sz0).normalize();
        sunLight.position.copy(sunDir).multiplyScalar(1e5);
      }

      updateCamera(dt, now);
      updateRings(now);
      updatePulses(now);

      hoverClock += dt;
      if (hoverFresh && hoverClock > 0.08) { hoverClock = 0; hoverFresh = false; doHover(); }

      renderer.render(scene, camera);
      updateOverlay();                                // after render → matrices current

      frames++;
      if (frames === 1) stepProgress();
      if (frames === 2) stepProgress();
      if (frames === 3) { stepProgress(); clearTimeout(forceTimer); reveal(); }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    /* ───────── 19 · STATIC CATALOG INFO (for the UI layer) ───────── */
    var CLASS_INFO = [
      { key: "active", label: "ACTIVE SATELLITES", color: "#7FB2C9", count: classes[0].N },
      { key: "const", label: "CONSTELLATIONS", color: "#A8C6D8", count: classes[1].N },
      { key: "geo", label: "GEO / MEO SHELLS", color: "#7FB2C9", count: classes[2].N },
      { key: "debris", label: "DEBRIS FRAGMENTS", color: "#E3A94F", count: classes[3].N },
      { key: "breakup", label: "BREAKUP EVENTS", color: "#C94F42", count: classes[4].N },
      { key: "rocket", label: "ROCKET BODIES", color: "#9AA3B2", count: classes[5].N }
    ];
    var FEATURED_INFO = featured.map(function (f) {
      var periodMin = TAU / f.n / 60;
      return {
        id: f.id, name: f.name, regime: f.regime, cls: CLS_NAMES[f.cls],
        altKm: f.altKm, inclDeg: f.incl, ecc: f.e, periodMin: periodMin,
        raanDeg: f.raan, argpDeg: f.argp,
        perigeeKm: f.a * (1 - f.e) - R_EARTH,
        apogeeKm: f.a * (1 + f.e) - R_EARTH
      };
    });
    var catalogStats = {
      total: TOTAL,
      reducedMotion: reduceMotion,
      defaultWarp: reduceMotion ? 1 : 60,
      altitudeRange: { min: ALT_MIN, max: ALT_MAX },
      classes: CLASS_INFO,
      featured: FEATURED_INFO,
      events: EVENTS
    };

    /* ───────── 20 · PUBLIC API ───────── */
    var api;
    api = {
      version: "1.0",
      ready: false,

      /* engine ready → cb(true) once (after loading veil) */
      onReady: function (cb) {
        if (api.ready) { if (typeof cb === "function") { try { cb(true); } catch (e) {} } return function () {}; }
        return readyBus.on(cb);
      },

      /* — simulation clock — */
      setTimeWarp: function (w) {
        w = Number(w);
        if (!isFinite(w) || w <= 0) return warp;
        warp = clamp(w, 1, 3600);
        return warp;
      },
      getTimeWarp: function () { return warp; },
      setSimTime: function (t) {
        t = Number(t);
        if (!isFinite(t)) return simTime;
        simTime = Math.max(0, t);
        simDirty = true;
        return simTime;
      },
      getSimTime: function () { return simTime; },
      pause: function (p) { playing = !p; return !playing; },
      isPaused: function () { return !playing; },

      /* — catalog (read-only; treat as immutable) — */
      getCatalogStats: function () { return catalogStats; },

      /* — selection — */
      selectObject: function (n) {
        if (n === null || n === undefined) return deselect();
        var f = null;
        if (typeof n === "number") {
          if (n >= 0 && n < featured.length && Math.floor(n) === n) f = featured[n];
        } else if (typeof n === "string") {
          var q = n.toUpperCase();
          for (var i = 0; i < featured.length; i++) {
            if (featured[i].name === q || featured[i].name.toUpperCase() === q) { f = featured[i]; break; }
          }
        }
        if (!f) return null;
        return selectFeatured(f);
      },
      deselect: deselect,
      getSelected: function () { return selected ? featuredLive(selected) : null; },
      onSelect: function (cb) { return selectBus.on(cb); },

      /* — layer visibility — */
      classVisibility: function (name, on) { return setLayer(name, on); },
      getClassVisibility: function (name) { return getLayer(name); },

      /* — altitude scrub (mean-altitude band ±25 %, alpha fade) — */
      setAltitudeFilter: function (km) {
        km = Number(km);
        if (!isFinite(km)) return altFilterKm;
        if (km >= ALT_MAX) { clearAltFilter(); return ALT_MAX; }
        var v = clamp(km, ALT_MIN, ALT_MAX);
        altFilterKm = v;
        applyAltFilter(v);
        return v;
      },
      getAltitudeFilter: function () { return altFilterKm; },

      /* — fragmentation events —
         name: 'sputnik'|'fy1c'|'collision'|'c1408'|'shakti' (cloud aliases
         like 'iridium' or 'c2251' resolve to the 2009 collision), or the
         numeric index 0-4.  Returns the event record; camera eases to the
         cloud(s) and the fragments pulse. */
      focusEvent: function (name) {
        var ev = null;
        if (typeof name === "number") {
          if (name >= 0 && name < EVENTS.length && Math.floor(name) === name) ev = EVENTS[name];
        } else if (typeof name === "string") {
          var k = String(name).toLowerCase().replace(/[\s_-]/g, "");
          var id = CLOUD_ALIAS[k] || k;
          for (var i = 0; i < EVENTS.length; i++) if (EVENTS[i].id === id) { ev = EVENTS[i]; break; }
        }
        if (!ev) return null;
        return focusEventById(ev);
      },

      /* — pointer hover feed — */
      onHover: function (cb) { return hoverBus.on(cb); },

      /* — per-frame overlay data (poll from a rAF/interval loop) — */
      getOverlayState: function () {
        var out = {
          ready: api.ready,
          simTime: simTime,
          simTimeLabel: "T+ " + fmtT(simTime),
          warp: warp,
          paused: !playing,
          total: TOTAL,
          camera: {
            distKm: cam.dist,
            latDeg: cam.lat / D2R,
            lonDeg: cam.lon / D2R
          },
          selected: null,
          featured: []
        };
        for (var i = 0; i < featured.length; i++) {
          out.featured.push({
            id: featured[i].id, name: featured[i].name, regime: featured[i].regime,
            x: featScrX[i], y: featScrY[i], visible: !!featScrV[i]
          });
        }
        if (selected) {
          var live = featuredLive(selected);
          live.screen = selScr.visible ? { x: selScr.x, y: selScr.y, visible: true } : { x: 0, y: 0, visible: false };
          out.selected = live;
        }
        return out;
      }
    };

    return { api: api };
    }

})();
