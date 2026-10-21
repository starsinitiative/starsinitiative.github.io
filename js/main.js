/* ============================================================
   STARS — shared interaction layer
   nav indicator · mobile menu · reveals · counters · ticker
   ============================================================ */
(function () {
  "use strict";
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- header scroll state ---------- */
  var header = document.querySelector(".site-header");
  function onScroll() {
    if (!header) return;
    header.setAttribute("data-scrolled", window.scrollY > 24 ? "true" : "false");
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ---------- nav sliding underline ---------- */
  var nav = document.querySelector(".site-nav");
  var indicator = document.querySelector(".nav-indicator");
  if (nav && indicator) {
    var links = nav.querySelectorAll(".nav-link");
    var current = nav.querySelector(".nav-link.is-active");
    function move(el, sticky) {
      if (!el) { indicator.style.opacity = "0"; return; }
      var r = el.getBoundingClientRect();
      var nr = nav.getBoundingClientRect();
      indicator.style.left = (r.left - nr.left + 14) + "px";
      indicator.style.width = (r.width - 28) + "px";
      indicator.style.opacity = "1";
    }
    links.forEach(function (l) {
      l.addEventListener("mouseenter", function () { move(l); });
      l.addEventListener("focus", function () { move(l); });
    });
    nav.addEventListener("mouseleave", function () { move(current); });
    if (current) { move(current); window.addEventListener("resize", function () { move(current); }); }
  }

  /* ---------- mobile menu ---------- */
  var toggle = document.querySelector(".nav-toggle");
  var menu = document.querySelector(".mobile-menu");
  if (toggle && menu) {
    toggle.addEventListener("click", function () {
      var open = menu.classList.toggle("open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      document.body.style.overflow = open ? "hidden" : "";
    });
    /* backdrop close: a tap/click on the menu itself (empty overlay area,
       not a link) closes it — prevents the touch trap (Critique A1) */
    menu.addEventListener("click", function (e) {
      if (e.target === menu) {
        menu.classList.remove("open");
        toggle.setAttribute("aria-expanded", "false");
        document.body.style.overflow = "";
      }
    });
    menu.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", function () {
        menu.classList.remove("open");
        toggle.setAttribute("aria-expanded", "false");
        document.body.style.overflow = "";
      });
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && menu.classList.contains("open")) {
        menu.classList.remove("open");
        toggle.setAttribute("aria-expanded", "false");
        document.body.style.overflow = "";
      }
    });
  }

  /* ---------- reveal on scroll ---------- */
  var revealEls = document.querySelectorAll("[data-reveal]");
  if (revealEls.length) {
    if (reduceMotion || !("IntersectionObserver" in window)) {
      revealEls.forEach(function (el) { el.classList.add("revealed"); });
    } else {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) {
            en.target.classList.add("revealed");
            io.unobserve(en.target);
          }
        });
      }, { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });
      revealEls.forEach(function (el) {
        // stagger within groups
        var group = el.closest("[data-reveal-group]");
        if (group) {
          var kids = Array.prototype.slice.call(group.querySelectorAll("[data-reveal]"));
          el.style.setProperty("--reveal-delay", (kids.indexOf(el) * 0.09) + "s");
        }
        io.observe(el);
      });
    }
  }

  /* ---------- animated counters ---------- */
  function animateCounter(el) {
    var target = parseFloat(el.getAttribute("data-count"));
    var decimals = parseInt(el.getAttribute("data-decimals") || "0", 10);
    var dur = parseInt(el.getAttribute("data-dur") || "1800", 10);
    var start = null;
    var fmt = function (v) {
      return v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    };
    if (reduceMotion) { el.textContent = fmt(target); return; }
    function step(ts) {
      if (!start) start = ts;
      var p = Math.min((ts - start) / dur, 1);
      var eased = 1 - Math.pow(1 - p, 4);
      el.textContent = fmt(target * eased);
      if (p < 1) requestAnimationFrame(step);
      else el.textContent = fmt(target);
    }
    requestAnimationFrame(step);
  }
  var counters = document.querySelectorAll("[data-count]");
  if (counters.length) {
    if (!("IntersectionObserver" in window)) {
      counters.forEach(animateCounter);
    } else {
      var cio = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) { animateCounter(en.target); cio.unobserve(en.target); }
        });
      }, { threshold: 0.4 });
      counters.forEach(function (el) { cio.observe(el); });
    }
  }

  /* ---------- telemetry ticker (element: .ticker) ---------- */
  var ticker = document.querySelector(".ticker");
  if (ticker) {
    var items = Array.prototype.slice.call(ticker.querySelectorAll(".ticker-item"));
    var idx = 0;
    if (items.length > 1 && !reduceMotion) {
      items[0].classList.add("is-on");
      setInterval(function () {
        items[idx].classList.remove("is-on");
        idx = (idx + 1) % items.length;
        items[idx].classList.add("is-on");
      }, 3400);
    } else if (items.length) {
      items[0].classList.add("is-on");
    }
  }

  /* ---------- reading progress ---------- */
  var rp = document.querySelector(".reading-progress .rp-bar");
  if (rp) {
    var article = document.querySelector(".article-body") || document.body;
    function upd() {
      var rect = article.getBoundingClientRect();
      var total = rect.height - window.innerHeight + 200;
      var done = Math.min(Math.max(-rect.top + 160, 0) / Math.max(total, 1), 1);
      rp.style.width = (done * 100).toFixed(2) + "%";
    }
    window.addEventListener("scroll", upd, { passive: true });
    upd();
  }

  /* ---------- gentle starfield parallax (hero) ---------- */
  var px = document.querySelectorAll("[data-parallax]");
  if (px.length && !reduceMotion) {
    var ticking = false;
    window.addEventListener("scroll", function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        px.forEach(function (el) {
          var depth = parseFloat(el.getAttribute("data-parallax")) || 0.15;
          var r = el.getBoundingClientRect();
          if (r.bottom > 0) {
            el.style.transform = "translateY(" + (window.scrollY * depth * -1).toFixed(1) + "px)";
          }
        });
        ticking = false;
      });
    }, { passive: true });
  }

  /* ---------- quick-nav scrollspy (hub pages) ---------- */
  var qnav = document.querySelector(".hub-quicknav");
  if (qnav) {
    var qlinks = Array.prototype.slice.call(qnav.querySelectorAll('a[href^="#"]'));
    var sections = qlinks.map(function (a) {
      return document.getElementById(a.getAttribute("href").slice(1));
    }).filter(Boolean);
    if (sections.length && "IntersectionObserver" in window) {
      var spy = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) {
            qlinks.forEach(function (a) {
              a.removeAttribute("aria-current");
            });
            var link = qnav.querySelector('a[href="#' + en.target.id + '"]');
            if (link) link.setAttribute("aria-current", "true");
          }
        });
      }, { rootMargin: "-38% 0px -55% 0px" });
      sections.forEach(function (s) { spy.observe(s); });
    }
  }

  /* ---------- footer year clock-free: log line ---------- */
  var logline = document.querySelector(".boot-log");
  if (logline) {
    var msgs = ["LINK ESTABLISHED", "TRACKING ACTIVE", "ORBITAL DATA CURRENT"];
    var li = 0;
    if (!reduceMotion) {
      setInterval(function () {
        li = (li + 1) % msgs.length;
        logline.textContent = msgs[li];
      }, 5000);
    }
  }
})();
