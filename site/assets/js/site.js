/* souldew website – progressive enhancement only: without JS every link works, every text and picture is there. */
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const root = document.documentElement;
  const reducedQ = window.matchMedia('(prefers-reduced-motion: reduce)');
  const reduced = reducedQ.matches;
  if (!reduced) root.classList.add('motion');
  const DE = root.lang === 'de';
  const REPO = 'souldewapp/souldew';
  const RELEASES = `https://github.com/${REPO}/releases/latest`;
  const THANKS = 'https://accounts.souldew.app/v1/thanks';
  const script = $('script[src*="site.js"]');
  const ASSETS = new URL('../', script ? script.src : location.href).href; // …/assets/
  const T = DE ? {
    free: 'Kostenlos · Open Source (GPL-3.0)',
    peel: 'Sticker abziehen', stick: 'Sticker aufkleben',
    tiers: { supporter: 'Supporter', plus: 'souldew+', legend: 'Legend', coffee: 'Kaffee' },
    more: (n) => `und ${n} weitere`,
    first: 'Deiner könnte der erste sein.',
    since: (d) => `dabei seit ${d}`,
  } : {
    free: 'Free · open source (GPL-3.0)',
    peel: 'Peel the stickers off', stick: 'Stick them on',
    tiers: { supporter: 'Supporter', plus: 'souldew+', legend: 'Legend', coffee: 'Coffee' },
    more: (n) => `and ${n} more`,
    first: 'Yours could be the first.',
    since: (d) => `since ${d}`,
  };
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const onView = (el, fn, opts = { threshold: 0.35 }) => {
    if (!el) return;
    const io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { io.disconnect(); fn(); } }, opts);
    io.observe(el);
  };

  // ---------- nav ----------
  const nav = $('[data-nav]');
  const onNav = () => nav && nav.classList.toggle('scrolled', window.scrollY > 24);
  onNav();
  window.addEventListener('scroll', onNav, { passive: true });
  const menu = $('[data-nav-dl]');
  if (menu) {
    const close = () => { menu.open = false; };
    document.addEventListener('click', (e) => { if (menu.open && !menu.contains(e.target)) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menu.open) { close(); $('summary', menu).focus(); } });
    for (const a of $$('a', menu)) a.addEventListener('click', close);
  }

  // ---------- reveal: staggered by order among siblings ----------
  const revealIO = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); revealIO.unobserve(e.target); }
  }, { rootMargin: '0px 0px -6% 0px' });
  for (const el of $$('[data-reveal]')) {
    const sibs = [...el.parentElement.children].filter((c) => c.hasAttribute('data-reveal'));
    el.style.setProperty('--i', String(Math.min(sibs.indexOf(el), 6)));
    revealIO.observe(el);
  }

  // ---------- hero: the heart pops between the two players while the hero is on screen ----------
  const emote = $('[data-emote]');
  if (emote && !reduced) {
    new IntersectionObserver(([e]) => emote.classList.toggle('pop', e.isIntersecting), { threshold: 0.1 }).observe(emote);
  }

  // ---------- the link line draws itself ----------
  const linkStage = $('[data-link]');
  onView(linkStage, () => linkStage.classList.add('in'), { threshold: 0.3 });

  // ---------- raid: one shared pool, three players' hits ----------
  const pool = $('[data-pool]');
  if (pool) {
    const fill = $('[data-pool-fill]', pool), num = $('[data-pool-n]', pool), hits = $('[data-pool-hits]', pool), again = $('[data-pool-again]', pool);
    const NAMES = { p1: 'Marius', p2: 'Tim', p3: 'Lena' };
    const SEQ = [['p1', 14], ['p2', 22], ['p3', 9], ['p2', 18], ['p1', 11], ['p3', 12], ['p2', 14]];
    let timers = [];
    const set = (hp) => {
      pool.style.setProperty('--pool', String(hp / 100));
      num.textContent = String(Math.round(hp));
      pool.toggleAttribute('data-low', hp <= 50 && hp > 20);
      pool.toggleAttribute('data-crit', hp <= 20);
    };
    const run = () => {
      for (const t of timers) clearTimeout(t);
      timers = [];
      hits.textContent = '';
      pool.removeAttribute('data-done');
      again.hidden = true;
      set(100);
      let hp = 100;
      SEQ.forEach(([who, dmg], i) => {
        timers.push(setTimeout(() => {
          hp = Math.max(0, hp - dmg);
          set(hp);
          const h = document.createElement('span');
          h.className = 'hit';
          h.style.left = `${clamp(hp, 6, 94)}%`;
          h.style.color = `var(--${who})`;
          h.textContent = `${NAMES[who]} −${dmg} %`;
          hits.append(h);
          setTimeout(() => h.remove(), 1400);
          if (i === SEQ.length - 1) timers.push(setTimeout(() => { pool.setAttribute('data-done', ''); again.hidden = false; }, 500));
        }, 500 + i * 760));
      });
    };
    if (reduced) { set(0); pool.setAttribute('data-done', ''); }
    else onView(pool, run, { threshold: 0.6 });
    again.addEventListener('click', run);
  }

  // ---------- souldew+ · the launch: frames of the real 3D handheld scene ----------
  const launch = $('[data-launch]');
  if (launch && !reduced) {
    const canvas = $('[data-launch-canvas]', launch);
    const ctx = canvas.getContext('2d');
    const again = $('[data-launch-again]', launch);
    const bar = $('[data-launch-bar]', launch);
    const N = 52;
    const wideQ = window.matchMedia('(min-width: 901px)');
    const size = () => ((canvas.clientWidth || 640) * (window.devicePixelRatio || 1) > 820 ? 1400 : 760);
    const frames = new Array(N);
    let width = 0, current = -1, loading = false;
    const src = (i) => `${ASSETS}img/30/unfold/${width}/f${String(i).padStart(2, '0')}.webp`;
    const draw = (i) => {
      i = clamp(Math.round(i), 0, N - 1);
      let k = i;
      while (k >= 0 && !frames[k]) k--;
      if (k < 0) { k = i; while (k < N && !frames[k]) k++; }
      if (k >= N || k === current) return;
      current = k;
      const im = frames[k];
      if (canvas.width !== im.naturalWidth) { canvas.width = im.naturalWidth; canvas.height = im.naturalHeight; }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(im, 0, 0);
    };
    let want = 0;
    const load = () => {
      if (loading) return;
      loading = true;
      width = size();
      // the first frame, then every fourth, then the rest: a coarse scrub is ready almost at once
      const order = [0];
      for (let s = 4; s >= 1; s = s === 4 ? 2 : s === 2 ? 1 : 0) for (let i = 0; i < N; i += s) if (!order.includes(i)) order.push(i);
      let at = 0;
      const next = () => {
        if (at >= order.length) return;
        const i = order[at++];
        const im = new Image();
        im.decoding = 'async';
        im.onload = () => { frames[i] = im; if (Math.abs(i - want) < 3 || current < 0) { current = -1; draw(want); } next(); };
        im.onerror = next;
        im.src = src(i);
      };
      for (let k = 0; k < 4; k++) next();
    };
    new IntersectionObserver(([e]) => { if (e.isIntersecting) load(); }, { rootMargin: '150% 0px' }).observe(launch);

    const phaseOf = (f) => (f < 12 ? 0 : f < 30 ? 1 : 2);
    let pinned = false;
    const scrub = () => {
      const r = launch.getBoundingClientRect();
      const p = clamp(-r.top / Math.max(1, r.height - window.innerHeight), 0, 1);
      want = clamp(p / 0.86, 0, 1) * (N - 1);
      draw(want);
      launch.dataset.phase = String(phaseOf(want));
      if (bar) bar.parentElement.style.setProperty('--p', p.toFixed(4));
      bar && (bar.style.transform = `scaleX(${p.toFixed(4)})`);
    };
    let ticking = false;
    const onScroll = () => { if (!pinned || ticking) return; ticking = true; requestAnimationFrame(() => { ticking = false; scrub(); }); };
    window.addEventListener('scroll', onScroll, { passive: true });
    // phones and narrow windows: no pin – it plays once like the real thing, and again on request
    let playing = 0;
    const play = () => {
      cancelAnimationFrame(playing);
      again.hidden = true;
      const t0 = performance.now();
      const tick = (t) => {
        want = Math.min(N - 1, ((t - t0) / 1000) * 24);
        draw(want);
        if (want < N - 1) playing = requestAnimationFrame(tick);
        else again.hidden = false;
      };
      playing = requestAnimationFrame(tick);
    };
    again.addEventListener('click', play);
    const setup = () => {
      pinned = wideQ.matches;
      launch.classList.toggle('pinned', pinned);
      if (pinned) { again.hidden = true; scrub(); }
      else { launch.dataset.phase = '0'; draw(0); }
    };
    setup();
    wideQ.addEventListener('change', setup);
    new IntersectionObserver(([e], io) => {
      if (e.isIntersecting && !pinned) { load(); play(); io.disconnect(); }
    }, { threshold: 0.55 }).observe($('.launch-dev', launch));
  }

  // ---------- souldew+ · your handheld: skins and stickers ----------
  const hh = $('[data-hh]');
  const skins = $('[data-skins]');
  if (hh && skins) {
    const NAMES = {};
    for (const l of $$('label', skins)) {
      const inp = $('input', l);
      const n = $('.sw-n', l);
      NAMES[inp.value] = { name: n.firstChild.textContent.trim(), tier: $('small', n).textContent.trim() };
    }
    let a = $('[data-hh-img]', hh), b = $('[data-hh-img2]', hh);
    const cap = $('[data-hh-cap]', hh);
    const capFor = (id) => {
      const { name, tier } = NAMES[id];
      cap.textContent = name + ' ';
      const pill = document.createElement('span');
      pill.className = `pill${tier === 'souldew+' ? ' pill-gold' : ''}`;
      pill.textContent = tier;
      cap.append(pill);
    };
    capFor('golden-wheat');
    let token = 0;
    skins.addEventListener('change', (e) => {
      const id = e.target.value;
      const my = ++token;
      const w = (a.clientWidth || 700) * (window.devicePixelRatio || 1) > 800 ? 1400 : 760;
      const im = new Image();
      im.onload = () => {
        if (my !== token) return;
        b.src = im.src;
        b.alt = DE ? `Dein Handheld im Skin ${NAMES[id].name}.` : `Your handheld in the ${NAMES[id].name} skin.`;
        b.removeAttribute('aria-hidden');
        a.setAttribute('aria-hidden', 'true');
        b.classList.add('is-on');
        a.classList.remove('is-on');
        [a, b] = [b, a];
        capFor(id);
      };
      im.src = `${ASSETS}img/30/hh/${id}-${w}.webp`;
    });
    const layer = $('[data-stk-layer]', hh);
    const btn = $('[data-stk-toggle]');
    const label = $('[data-stk-label]');
    let on = true;
    const show = (v) => {
      on = v;
      btn.setAttribute('aria-pressed', String(v));
      label.textContent = v ? T.peel : T.stick;
      if (reduced) { layer.classList.toggle('static', v); layer.classList.toggle('off', !v); return; }
      layer.classList.remove('on', 'off');
      void layer.offsetWidth;
      layer.classList.add(v ? 'on' : 'off');
    };
    if (reduced) layer.classList.add('static');
    else onView(hh, () => show(true), { threshold: 0.45 });
    btn.addEventListener('click', () => show(!on));
  }

  // ---------- souldew+ · colour themes ----------
  const themes = $('[data-themes]');
  if (themes) {
    const img = $('[data-theme-img]', themes), name = $('[data-theme-name]', themes);
    const btns = $$('[data-theme]', themes);
    const pick = (b, focus) => {
      for (const o of btns) { o.setAttribute('aria-checked', String(o === b)); o.tabIndex = o === b ? 0 : -1; }
      if (focus) b.focus();
      const id = b.dataset.theme;
      const next = new Image();
      img.classList.add('swap');
      next.onload = () => { img.src = next.src; img.alt = img.alt.replace(/ the .+ theme\.| im Theme .+\./, DE ? ` im Theme ${b.getAttribute('aria-label')}.` : ` the ${b.getAttribute('aria-label')} theme.`); img.classList.remove('swap'); };
      next.src = `${ASSETS}img/30/themes/${id}.webp`;
      name.textContent = b.getAttribute('aria-label');
    };
    for (const b of btns) {
      b.tabIndex = b.getAttribute('aria-checked') === 'true' ? 0 : -1;
      b.addEventListener('click', () => pick(b));
      b.addEventListener('keydown', (e) => {
        const i = btns.indexOf(b);
        const k = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (k) { e.preventDefault(); pick(btns[(i + k + btns.length) % btns.length], true); }
      });
    }
  }

  // ---------- souldew+ · banners drift (only while on screen) ----------
  for (const row of $$('[data-marquee]')) {
    if (reduced) break;
    for (const c of [...row.children]) { const d = c.cloneNode(true); d.setAttribute('aria-hidden', 'true'); for (const i of $$('img', d)) i.alt = ''; row.append(d); }
    row.style.setProperty('--dur', `${Math.round(row.children.length * 9)}s`);
    new IntersectionObserver(([e]) => row.classList.toggle('run', e.isIntersecting)).observe(row);
  }

  // ---------- souldew+ · thank you: live names from accounts.souldew.app, never in the way ----------
  const thanks = $('[data-thanks]');
  if (thanks) {
    const loadThanks = async () => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      try {
        const res = await fetch(THANKS, { signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
        if (!res.ok) return;
        const d = await res.json();
        const counts = d && typeof d.counts === 'object' ? d.counts : {};
        const n = (k) => (Number.isFinite(counts[k]) && counts[k] > 0 ? Math.floor(counts[k]) : 0);
        const total = Number.isFinite(d.total) ? d.total : ['coffee', 'supporter', 'plus', 'legend'].reduce((s, k) => s + n(k), 0);
        const people = Array.isArray(d.people) ? d.people.filter((p) => p && typeof p.name === 'string' && p.name.trim()) : [];
        if (!total && !people.length) {
          const p = $('[data-thanks-empty] p', thanks);
          if (p) { p.append(document.createElement('br')); p.append(T.first); }
          return;
        }
        const cl = $('[data-thanks-counts]', thanks);
        for (const k of ['legend', 'plus', 'supporter', 'coffee']) {
          const el = $(`[data-count="${k}"]`, cl);
          if (n(k)) el.textContent = String(n(k)); else el.parentElement.remove();
        }
        cl.hidden = !cl.children.length;
        const wall = $('[data-thanks-wall]', thanks);
        const MAX = 90;
        for (const p of people.slice(0, MAX)) {
          const tier = ['legend', 'plus', 'supporter', 'coffee'].includes(p.tier) ? p.tier : 'supporter';
          const li = document.createElement('li');
          li.className = `t-${tier}`;
          const av = document.createElement('span');
          av.className = 'av';
          // pictures only from souldew's own service – nothing else is contacted
          if (typeof p.avatar === 'string' && p.avatar.startsWith('https://accounts.souldew.app/')) {
            const im = document.createElement('img');
            im.src = p.avatar; im.alt = ''; im.loading = 'lazy'; im.referrerPolicy = 'no-referrer';
            im.width = 26; im.height = 26;
            im.onerror = () => { im.remove(); av.textContent = [...p.name.trim()][0].toUpperCase(); };
            av.append(im);
          } else av.textContent = [...p.name.trim()][0].toUpperCase();
          const nm = document.createElement('span');
          nm.textContent = p.name.trim().slice(0, 32);
          li.append(av, nm);
          li.title = `${T.tiers[tier]}${typeof p.since === 'string' && /^\d{4}-\d{2}/.test(p.since) ? ` · ${T.since(p.since.slice(0, 7))}` : ''}`;
          wall.append(li);
        }
        const rest = Math.max(0, (Number.isFinite(d.total) ? d.total : people.length) - Math.min(people.length, MAX));
        if (rest > 0 && wall.children.length) { const li = document.createElement('li'); li.className = 'more'; li.textContent = T.more(rest); wall.append(li); }
        wall.hidden = !wall.children.length;
        $('[data-thanks-empty]', thanks).hidden = true;
      } catch { /* offline or not live yet: the static wall stays */ } finally { clearTimeout(t); }
    };
    new IntersectionObserver(([e], io) => { if (e.isIntersecting) { io.disconnect(); loadThanks(); } }, { rootMargin: '600px 0px' }).observe(thanks);
  }

  // ---------- downloads: every system side by side in a fixed order – no guessing the visitor's OS ----------
  // The links point at the releases page until the GitHub API names the files; a missing file keeps that link.
  const mb = (bytes) => `${Math.round(bytes / 1048576)} MB`;
  const apply = (rel) => {
    for (const key of ['mac', 'win', 'linux', 'deb']) {
      const asset = rel[key];
      for (const a of $$(`[data-dl="${key}"]`)) a.href = asset ? asset.url : RELEASES;
      for (const m of $$(`[data-dl-size="${key}"]`)) m.textContent = asset ? mb(asset.size) : '';
      for (const m of $$(`[data-dl-meta="${key}"]`)) if (asset) m.textContent = `${asset.name} · v${rel.version} · ${mb(asset.size)}`;
    }
    for (const v of $$('[data-dl-version]')) v.textContent = `v${rel.version} · ${T.free}`;
  };
  const CACHE_KEY = 'souldew-release-v3';
  const loadRelease = async () => {
    try {
      const cached = JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null');
      if (cached && Date.now() - cached.t < 30 * 60 * 1000) return cached.rel;
    } catch { /* storage blocked – ask the API */ }
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) return null;
    const data = await res.json();
    const assets = Array.isArray(data.assets) ? data.assets : [];
    const find = (re) => { const x = assets.find((a) => re.test(a.name)); return x ? { url: x.browser_download_url, size: x.size, name: x.name } : null; };
    const rel = { version: String(data.tag_name || '').replace(/^v/, ''), mac: find(/^souldew-.+-arm64\.dmg$/i), win: find(/^souldew-.+-win-x64-setup\.exe$/i),
      linux: find(/^souldew-.+-linux-x86_64\.AppImage$/i), deb: find(/^souldew-.+-linux-amd64\.deb$/i) };
    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), rel })); } catch { /* fine */ }
    return rel;
  };
  loadRelease().then((rel) => { if (rel && rel.version) apply(rel); }).catch(() => { /* offline: links keep pointing at the releases page */ });
})();
