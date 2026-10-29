// Marpora landing page: scroll reveals, hero tilt, the syntax demo, the theme wipe,
// counters and copy buttons. No dependencies.
(() => {
  "use strict";

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  const still = () => reduce.matches;
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];

  /* Split headings into words for a staggered entrance. */
  for (const el of $$("[data-split]")) {
    const words = [];
    const walk = (node, parent) => {
      for (const child of [...node.childNodes]) {
        if (child.nodeType === Node.TEXT_NODE) {
          const frag = document.createDocumentFragment();
          for (const part of child.textContent.split(/(\s+)/)) {
            if (!part) continue;
            if (/^\s+$/.test(part)) frag.append(" ");
            else {
              const span = document.createElement("span");
              span.className = "word";
              span.textContent = part;
              words.push(span);
              frag.append(span);
            }
          }
          parent.replaceChild(frag, child);
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          walk(child, child);
        }
      }
    };
    walk(el, el);
    // An italic run keeps its gradient on each word.
    words.forEach((w, i) => w.style.setProperty("--d", `${80 + i * 70}ms`));
  }

  /* Reveal on scroll. */
  const revealables = $$("[data-reveal], [data-split]");
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.classList.add("is-in");
          io.unobserve(e.target);
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.12 },
    );
    revealables.forEach((el) => io.observe(el));
  } else {
    revealables.forEach((el) => el.classList.add("is-in"));
  }

  /* Nav background once the page scrolls. */
  const nav = $(".nav");
  const onScrollNav = () => nav.classList.toggle("is-scrolled", window.scrollY > 8);

  /* Hero window: tilted back, flattens as it scrolls into place. */
  const tilt = $("[data-tilt]");
  const applyTilt = () => {
    if (!tilt) return;
    if (still()) {
      tilt.style.transform = "";
      return;
    }
    const vh = window.innerHeight;
    const top = tilt.getBoundingClientRect().top;
    // 0 when the window's top sits low in the viewport, 1 once it reaches the upper third.
    const p = Math.min(1, Math.max(0, (vh * 0.95 - top) / (vh * 0.6)));
    const e = 1 - Math.pow(1 - p, 3);
    const rx = 16 * (1 - e);
    const s = 0.93 + 0.07 * e;
    const ty = 30 * (1 - e);
    tilt.style.transform = `translate3d(0, ${ty}px, 0) rotateX(${rx}deg) scale(${s})`;
  };

  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      onScrollNav();
      applyTilt();
      ticking = false;
    });
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll, { passive: true });
  onScrollNav();
  applyTilt();

  /* Spotlight that follows the pointer on cards. */
  for (const card of $$(".card")) {
    card.addEventListener("pointermove", (e) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty("--mx", `${e.clientX - r.left}px`);
      card.style.setProperty("--my", `${e.clientY - r.top}px`);
    });
  }

  /* Syntax demo: a caret moves between words; their Markdown shows only around it. */
  const demo = $(".demo");
  if (demo) {
    const caret = document.createElement("span");
    caret.className = "caret";
    const states = ["h", "em", "b"];
    let i = 2;
    const show = (key) => {
      $$(".tok", demo).forEach((t) => t.classList.toggle("on", t.dataset.t === key));
      const word = $(`.w[data-w="${key}"]`, demo);
      const len = word.textContent.length;
      // Put the caret partway into the word.
      const ratio = key === "h" ? 1 : 0.5;
      word.append(caret);
      caret.style.left = "0";
      const range = document.createRange();
      const text = word.firstChild;
      const at = Math.round(len * ratio);
      range.setStart(text, at);
      range.setEnd(text, at);
      const wr = word.getBoundingClientRect();
      const rr = range.getBoundingClientRect();
      caret.style.left = `${rr.left - wr.left}px`;
    };
    show(states[i]);
    let timer = null;
    const start = () => {
      if (timer || still()) return;
      timer = setInterval(() => {
        i = (i + 1) % states.length;
        show(states[i]);
      }, 2200);
    };
    const stop = () => {
      clearInterval(timer);
      timer = null;
    };
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(([e]) => (e.isIntersecting ? start() : stop()), { threshold: 0.3 }).observe(demo);
    }
    window.addEventListener("resize", () => show(states[i]), { passive: true });
    document.fonts?.ready.then(() => show(states[i]));
  }

  /* Theme compare: drag, keys (range input) or an automatic sweep on first view. */
  const compare = $("[data-compare]");
  if (compare) {
    const range = $(".compare__range", compare);
    const stage = $(".compare__stage", compare);
    const set = (v) => {
      const pos = Math.min(100, Math.max(0, v));
      compare.style.setProperty("--pos", `${pos}%`);
      range.value = String(Math.round(pos));
    };
    range.addEventListener("input", () => set(Number(range.value)));
    let dragging = false;
    const fromPointer = (e) => {
      const r = stage.getBoundingClientRect();
      set(((e.clientX - r.left) / r.width) * 100);
    };
    stage.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" || e.pointerType === "pen") {
        dragging = true;
        stage.setPointerCapture(e.pointerId);
        fromPointer(e);
      }
    });
    stage.addEventListener("pointermove", (e) => dragging && fromPointer(e));
    const end = () => (dragging = false);
    stage.addEventListener("pointerup", end);
    stage.addEventListener("pointercancel", end);

    let swept = false;
    const sweep = () => {
      if (swept || still()) return;
      swept = true;
      const t0 = performance.now();
      const dur = 2200;
      const frame = (t) => {
        if (dragging) return;
        const p = Math.min(1, (t - t0) / dur);
        // 50 → 82 → 18 → 50
        const v = 50 + 32 * Math.sin(p * Math.PI * 2) * (1 - p * 0.15);
        set(p < 1 ? v : 50);
        if (p < 1) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    };
    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver(([e]) => {
        if (e.isIntersecting) {
          setTimeout(sweep, 500);
          io.disconnect();
        }
      }, { threshold: 0.6 });
      io.observe(compare);
    }
  }

  /* Count the numbers up when they come into view. */
  const counters = $$("[data-count]");
  if (counters.length && "IntersectionObserver" in window && !still()) {
    const run = (el) => {
      const target = Number(el.dataset.count);
      const decimals = Number(el.dataset.decimals ?? 0);
      const t0 = performance.now();
      const dur = 1400;
      const frame = (t) => {
        const p = Math.min(1, (t - t0) / dur);
        const e = 1 - Math.pow(1 - p, 4);
        el.textContent = (target * e).toFixed(decimals);
        if (p < 1) requestAnimationFrame(frame);
        else el.textContent = target.toFixed(decimals);
      };
      requestAnimationFrame(frame);
    };
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        run(e.target);
        io.unobserve(e.target);
      }
    }, { threshold: 0.6 });
    counters.forEach((el) => io.observe(el));
  }

  /* Copy buttons. */
  for (const btn of $$("[data-copy]")) {
    const label = btn.textContent;
    btn.addEventListener("click", async () => {
      const text = btn.dataset.copy;
      let ok = false;
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.append(ta);
        ta.select();
        try {
          ok = document.execCommand("copy");
        } catch {
          ok = false;
        }
        ta.remove();
      }
      btn.textContent = ok ? "Copied" : "Press ⌘C";
      btn.classList.toggle("is-done", ok);
      setTimeout(() => {
        btn.textContent = label;
        btn.classList.remove("is-done");
      }, 1800);
    });
  }
})();
