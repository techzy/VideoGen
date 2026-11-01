/*
 * Motion presets for this edit. Every animation in the composition calls one
 * of these by name (the "Motion preset" column of plan/edl.md), so changing a
 * preset here changes every use of it. Tune timings to match analysis/style.md.
 *
 * Signature: preset(tl, el, at, opts)
 *   tl   the scene's paused GSAP timeline
 *   el   the element (or array of elements) to animate
 *   at   start time in seconds on that timeline
 *   opts { duration, end, ...preset-specific }
 *
 * Rules (HyperFrames renders by seeking): only fromTo/to/set at absolute
 * times, no repeat: -1, no timers, no randomness.
 */
(function () {
  const pick = (el, sel) => {
    const kids = [].concat(el).flatMap((e) => Array.from(e.querySelectorAll(sel)));
    return kids.length ? kids : el;
  };

  /* Entrances: in.<name> */
  const IN = {
    cut(tl, el, at) {
      tl.fromTo(el, { opacity: 0 }, { opacity: 1, duration: 0.01 }, at);
    },
    fadeIn(tl, el, at, o = {}) {
      tl.fromTo(el, { opacity: 0 }, { opacity: 1, duration: o.duration ?? 0.3, ease: "power1.out" }, at);
    },
    fadeUp(tl, el, at, o = {}) {
      tl.fromTo(el, { opacity: 0, y: o.distance ?? 40 }, { opacity: 1, y: 0, duration: o.duration ?? 0.35, ease: "power3.out" }, at);
    },
    popIn(tl, el, at, o = {}) {
      tl.fromTo(el, { opacity: 0, scale: 0.85, y: 20 }, { opacity: 1, scale: 1, y: 0, duration: o.duration ?? 0.16, ease: "back.out(2)" }, at);
    },
    // text slams in from below and overshoots slightly
    slamUp(tl, el, at, o = {}) {
      tl.fromTo(el, { opacity: 0, y: o.distance ?? 120, scale: 0.92 }, { opacity: 1, y: 0, scale: 1, duration: o.duration ?? 0.35, ease: "back.out(1.7)" }, at);
    },
    slamDown(tl, el, at, o = {}) {
      tl.fromTo(el, { opacity: 0, y: -(o.distance ?? 120), scale: 1.08 }, { opacity: 1, y: 0, scale: 1, duration: o.duration ?? 0.35, ease: "back.out(1.7)" }, at);
    },
    slideLeft(tl, el, at, o = {}) {
      tl.fromTo(el, { opacity: 0, x: o.distance ?? 160 }, { opacity: 1, x: 0, duration: o.duration ?? 0.4, ease: "power3.out" }, at);
    },
    slideRight(tl, el, at, o = {}) {
      tl.fromTo(el, { opacity: 0, x: -(o.distance ?? 160) }, { opacity: 1, x: 0, duration: o.duration ?? 0.4, ease: "power3.out" }, at);
    },
    scaleIn(tl, el, at, o = {}) {
      tl.fromTo(el, { opacity: 0, scale: 0.6 }, { opacity: 1, scale: 1, duration: o.duration ?? 0.35, ease: "power3.out" }, at);
    },
    // b-roll: settles from a slight zoom
    zoomIn(tl, el, at, o = {}) {
      tl.fromTo(el, { opacity: 0, scale: 1.18 }, { opacity: 1, scale: 1, duration: o.duration ?? 0.45, ease: "power2.out" }, at);
    },
    whipLeft(tl, el, at, o = {}) {
      tl.fromTo(el, { x: "100%" }, { x: "0%", duration: o.duration ?? 0.22, ease: "expo.out" }, at);
    },
    whipRight(tl, el, at, o = {}) {
      tl.fromTo(el, { x: "-100%" }, { x: "0%", duration: o.duration ?? 0.22, ease: "expo.out" }, at);
    },
    // one word after another (spans with class "w")
    wordStagger(tl, el, at, o = {}) {
      tl.fromTo(pick(el, ".w"), { opacity: 0, y: 60, rotation: 4 }, { opacity: 1, y: 0, rotation: 0, duration: o.duration ?? 0.35, stagger: o.stagger ?? 0.07, ease: "power4.out" }, at);
    },
    // letters bounce in (spans with class "ch")
    letterPop(tl, el, at, o = {}) {
      tl.fromTo(pick(el, ".ch"), { opacity: 0, y: 80, scale: 0.6 }, { opacity: 1, y: 0, scale: 1, duration: o.duration ?? 0.4, stagger: o.stagger ?? 0.03, ease: "back.out(1.8)" }, at);
    },
    typewriter(tl, el, at, o = {}) {
      const chars = pick(el, ".ch");
      const step = o.stagger ?? 0.035;
      chars.forEach((c, i) => tl.fromTo(c, { opacity: 0 }, { opacity: 1, duration: 0.01 }, at + i * step));
    },
    // SVG strokes draw themselves (paths with pathLength="1")
    drawOn(tl, el, at, o = {}) {
      tl.fromTo(pick(el, ".draw"), { strokeDasharray: 1, strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: o.duration ?? 0.6, stagger: o.stagger ?? 0.08, ease: "power2.inOut" }, at);
    },
  };

  /* Exits: out.<name>, placed so they finish at `at` + duration */
  const OUT = {
    cut(tl, el, at) {
      tl.to(el, { opacity: 0, duration: 0.01 }, at);
    },
    fadeOut(tl, el, at, o = {}) {
      tl.to(el, { opacity: 0, duration: o.duration ?? 0.2, ease: "power1.in" }, at);
    },
    slideDownOut(tl, el, at, o = {}) {
      tl.to(el, { opacity: 0, y: 60, duration: o.duration ?? 0.25, ease: "power2.in" }, at);
    },
    liftOut(tl, el, at, o = {}) {
      tl.to(el, { opacity: 0, y: -40, scale: 0.96, duration: o.duration ?? 0.3, ease: "power2.in" }, at);
    },
    popOut(tl, el, at, o = {}) {
      tl.to(el, { opacity: 0, scale: 0.8, duration: o.duration ?? 0.15, ease: "back.in(2)" }, at);
    },
    whipOutLeft(tl, el, at, o = {}) {
      tl.to(el, { x: "-100%", duration: o.duration ?? 0.2, ease: "expo.in" }, at);
    },
  };
  // how long each exit takes, so the composer can start it early enough
  const OUT_DURATION = { cut: 0.01, fadeOut: 0.2, slideDownOut: 0.25, liftOut: 0.3, popOut: 0.15, whipOutLeft: 0.2 };

  /* Framing for main-footage cuts: frame.<name>, over [at, opts.end] */
  const FRAME = {
    none(tl, el, at) {
      tl.set(el, { scale: 1, x: 0, y: 0 }, at);
    },
    // hard punch-in for jump cuts
    punchIn(tl, el, at, o = {}) {
      tl.set(el, { scale: o.scale ?? 1.12, x: 0, y: 0 }, at);
    },
    // slow push in across the shot
    slowPush(tl, el, at, o = {}) {
      tl.fromTo(el, { scale: 1 }, { scale: o.scale ?? 1.06, duration: Math.max(0.1, (o.end ?? at + 2) - at), ease: "none" }, at);
    },
    slowPull(tl, el, at, o = {}) {
      tl.fromTo(el, { scale: o.scale ?? 1.08 }, { scale: 1, duration: Math.max(0.1, (o.end ?? at + 2) - at), ease: "none" }, at);
    },
    // quick zoom bump on emphasis, settling back
    zoomBump(tl, el, at, o = {}) {
      tl.fromTo(el, { scale: 1 }, { scale: o.scale ?? 1.1, duration: 0.12, ease: "power2.out" }, at);
      tl.to(el, { scale: 1.04, duration: 0.5, ease: "power2.inOut" }, at + 0.12);
    },
  };

  /* Caption word states: word.<name>(tl, el, start, end, opts) */
  const WORD = {
    // active word changes colour and grows a little
    color(tl, el, at, end, o = {}) {
      tl.fromTo(el, { color: o.color, scale: 1 }, { color: o.activeColor, scale: o.scale ?? 1.06, duration: 0.08, ease: "power2.out", immediateRender: false, overwrite: "auto" }, at);
      tl.to(el, { color: o.color, scale: 1, duration: 0.1, ease: "power1.out", overwrite: "auto" }, end);
    },
    // a coloured box sweeps in behind the active word (a child with class "hl")
    box(tl, el, at, end, o = {}) {
      const bg = el.querySelector(".hl");
      if (!bg) return;
      tl.fromTo(bg, { scaleX: 0, opacity: 0 }, { scaleX: 1, opacity: 1, duration: 0.1, ease: "power2.out", immediateRender: false, overwrite: "auto" }, at);
      tl.to(bg, { opacity: 0, duration: 0.08, overwrite: "auto" }, end);
    },
    none() {},
  };

  window.VG_MOTION = { in: IN, out: OUT, outDuration: OUT_DURATION, frame: FRAME, word: WORD };
})();
