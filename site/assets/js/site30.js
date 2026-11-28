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
  const script = $('script[src*="site30.js"]');
  const ASSETS = new URL('../', script ? script.src : location.href).href; // …/assets/
  const T = DE ? {
    free: 'Kostenlos · Open Source (GPL-3.0)',
    peel: 'Ohne Sticker', stick: 'Mit Stickern', alt: (n) => `Dein Handheld im Skin ${n}, mit sechs Stickern.`,
    tiers: { supporter: 'Supporter', plus: 'souldew+', legend: 'Legend', coffee: 'Kaffee' },
    more: (n) => `und ${n} weitere`,
    first: 'Deiner könnte der erste sein.',
    since: (d) => `dabei seit ${d}`,
  } : {
    free: 'Free · open source (GPL-3.0)',
    peel: 'Without stickers', stick: 'With stickers', alt: (n) => `Your handheld in the ${n} skin, with six stickers.`,
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

  // ---------- hero: the heart pops between the two players; the handhelds drift with the scroll ----------
  const emote = $('[data-emote]');
  if (emote && !reduced) {
    new IntersectionObserver(([e]) => emote.classList.toggle('pop', e.isIntersecting), { threshold: 0.1 }).observe(emote);
  }
  // the two handhelds drift a little slower than the headline as the page scrolls (not with reduced motion)
  const par = $('[data-parallax]');
  if (par && !reduced) {
    let ticking = false;
    const move = () => {
      ticking = false;
      const y = Math.min(window.scrollY, window.innerHeight * 1.2);
      par.style.transform = `translate3d(0, ${(y * 0.2).toFixed(1)}px, 0)`;
    };
    window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(move); } }, { passive: true });
    move();
  }

  // ---------- trade and battle: invite, linked, settled – in order, once it is on screen ----------
  const seq = $('[data-seq]');
  if (seq) {
    const steps = $$('[data-step]', seq), press = $('[data-press]', seq), ms = $('[data-ms]', seq), score = $('[data-score]', seq), again = $('[data-seq-again]', seq);
    let timers = [];
    const reset = () => { for (const t of timers) clearTimeout(t); timers = []; steps.forEach((el) => el.classList.remove('on', 'wired')); press.classList.remove('pressed'); score.textContent = '0'; ms.textContent = '0'; again.hidden = true; };
    const at = (t, fn) => timers.push(setTimeout(fn, t));
    const run = () => {
      reset();
      at(100, () => steps[0].classList.add('on'));
      at(900, () => press.classList.add('pressed'));
      at(1250, () => { press.classList.remove('pressed'); steps[0].classList.add('wired'); });
      at(1900, () => steps[1].classList.add('on'));
      at(2300, () => { ms.textContent = '0'; });
      at(2900, () => steps[1].classList.add('wired'));
      at(3550, () => steps[2].classList.add('on'));
      at(4200, () => { score.textContent = '1'; again.hidden = false; });
    };
    if (reduced) { steps.forEach((el) => el.classList.add('on', 'wired')); score.textContent = '1'; }
    else onView(seq, run, { threshold: 0.45 });
    again.addEventListener('click', run);
  }

  // ---------- raid: one shared pool, three players' hits as chips that never collide ----------
  const pool = $('[data-pool]');
  if (pool) {
    const num = $('[data-pool-n]', pool), feed = $('[data-pool-feed]', pool), again = $('[data-pool-again]', pool);
    const NAMES = { p1: 'Sam', p2: 'Tim', p3: 'Lena' };
    const SEQ = [['p1', 14], ['p2', 22], ['p3', 9], ['p2', 18], ['p1', 11], ['p3', 12], ['p2', 14]];
    let timers = [];
    const set = (hp) => {
      pool.style.setProperty('--pool', String(hp / 100));
      num.textContent = String(Math.round(hp));
      pool.toggleAttribute('data-low', hp <= 50 && hp > 20);
      pool.toggleAttribute('data-crit', hp <= 20);
    };
    const chip = (who, dmg) => {
      const li = document.createElement('li');
      const d = document.createElement('i'); d.className = `dot d-${who}`;
      const n = document.createElement('b'); n.textContent = NAMES[who]; n.style.color = `var(--${who})`; n.style.fontWeight = '600';
      const v = document.createElement('span'); v.textContent = `−${dmg} %`;
      li.append(d, n, v);
      feed.prepend(li);
      while (feed.children.length > 3) feed.lastElementChild.remove();
    };
    const run = () => {
      for (const t of timers) clearTimeout(t);
      timers = [];
      feed.textContent = '';
      pool.removeAttribute('data-done');
      again.hidden = true;
      set(100);
      let hp = 100;
      SEQ.forEach(([who, dmg], i) => {
        timers.push(setTimeout(() => {
          hp = Math.max(0, hp - dmg);
          set(hp);
          chip(who, dmg);
          if (i === SEQ.length - 1) timers.push(setTimeout(() => { pool.setAttribute('data-done', ''); again.hidden = false; }, 500));
        }, 500 + i * 820));
      });
    };
    if (reduced) { set(0); chip('p2', 14); chip('p3', 12); chip('p1', 11); pool.setAttribute('data-done', ''); }
    else onView(pool, run, { threshold: 0.6 });
    again.addEventListener('click', run);
  }

  // ---------- souldew+ · the launch: frames of the real 3D handheld scene ----------
  const launch = $('[data-launch]');
  if (launch && !reduced) {
    const canvas = $('[data-launch-canvas]', launch);
    const ctx = canvas.getContext('2d');
    const again = $('[data-launch-again]', launch);
    const beats = $$('[data-beat]', launch);
    const N = 51, OFF = 2; // frames 2…52: the first two only show the closed lid
    const wideQ = window.matchMedia('(min-width: 901px)');
    const size = () => ((canvas.clientWidth || 640) * (window.devicePixelRatio || 1) > 820 ? 1400 : 760);
    const frames = new Array(N);
    let width = 0, current = -1, loading = false;
    const src = (i) => `${ASSETS}img/30/unfold/${width}/f${String(i + OFF).padStart(2, '0')}.webp`;
    const beatOf = (f) => (f + OFF < 13 ? 0 : f + OFF < 24 ? 1 : 2);
    const mark = (f) => beats.forEach((b, k) => b.classList.toggle('on', k <= beatOf(f)));
    const draw = (i) => {
      i = clamp(Math.round(i), 0, N - 1);
      mark(i);
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
      const order = [0];
      for (const st of [4, 2, 1]) for (let i = 0; i < N; i += st) if (!order.includes(i)) order.push(i);
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
    let pinned = false;
    const scrub = () => {
      const r = launch.getBoundingClientRect();
      const p = clamp(-r.top / Math.max(1, r.height - window.innerHeight), 0, 1);
      want = clamp(p / 0.88, 0, 1) * (N - 1);
      draw(want);
    };
    let ticking = false;
    window.addEventListener('scroll', () => { if (!pinned || ticking) return; ticking = true; requestAnimationFrame(() => { ticking = false; scrub(); }); }, { passive: true });
    let playing = 0;
    const play = () => {
      cancelAnimationFrame(playing);
      again.hidden = true;
      const t0 = performance.now();
      const tick = (t) => {
        want = Math.min(N - 1, ((t - t0) / 1000) * 30);
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
      if (pinned) { again.hidden = true; scrub(); } else draw(0);
    };
    setup();
    wideQ.addEventListener('change', setup);
    new IntersectionObserver(([e], io) => {
      if (e.isIntersecting && !pinned) { load(); play(); io.disconnect(); }
    }, { threshold: 0.55 }).observe($('.launch-dev', launch));
  } else if (launch) $$('[data-beat]', launch).forEach((b) => b.classList.add('on'));

  // ---------- souldew+ · your handheld: every skin in one carousel, stickers on or off ----------
  const hh = $('[data-hh]');
  const skins = $('[data-skins]');
  if (hh && skins) {
    const items = $$('[data-skin]', skins);
    let a = $('[data-hh-img]', hh), b = $('[data-hh-img2]', hh);
    const cap = $('[data-hh-cap]', hh), layer = $('[data-stk-layer]', hh);
    const btn = $('[data-stk-toggle]'), label = $('[data-stk-label]');
    let at = 0, on = true, token = 0;
    const capFor = (el) => {
      cap.textContent = el.dataset.name + ' ';
      const pill = document.createElement('span');
      pill.className = `pill${el.dataset.tier === 'souldew+' ? ' pill-gold' : ''}`;
      pill.textContent = el.dataset.tier;
      cap.append(pill);
    };
    const go = (i, focus) => {
      at = (i + items.length) % items.length;
      const el = items[at];
      items.forEach((x, k) => { x.setAttribute('aria-checked', String(k === at)); x.tabIndex = k === at ? 0 : -1; });
      if (focus) el.focus();
      capFor(el);
      const my = ++token;
      const w = (a.clientWidth || 700) * (window.devicePixelRatio || 1) > 800 ? 1400 : 760;
      const im = new Image();
      im.onload = () => {
        if (my !== token) return;
        b.src = im.src;
        b.alt = T.alt(el.dataset.name);
        b.removeAttribute('aria-hidden');
        a.setAttribute('aria-hidden', 'true');
        b.classList.add('is-on');
        a.classList.remove('is-on');
        [a, b] = [b, a];
      };
      im.src = `${ASSETS}img/30/hh/${el.dataset.skin}-${w}.webp`;
    };
    capFor(items[0]);
    items.forEach((el, k) => {
      el.addEventListener('click', () => go(k));
      el.addEventListener('keydown', (e) => {
        const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (d) { e.preventDefault(); go(at + d, true); }
      });
    });
    $('[data-hh-prev]', hh).addEventListener('click', () => go(at - 1));
    $('[data-hh-next]', hh).addEventListener('click', () => go(at + 1));
    // swipe on touch screens
    let sx = null;
    const pic = $('[data-hh-pic]', hh);
    pic.addEventListener('pointerdown', (e) => { sx = e.clientX; });
    pic.addEventListener('pointerup', (e) => { if (sx != null && Math.abs(e.clientX - sx) > 40) go(at + (e.clientX < sx ? 1 : -1)); sx = null; });
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
    for (const key of ['mac', 'macx64', 'win', 'linux', 'deb']) {
      const asset = rel[key];
      for (const a of $$(`[data-dl="${key}"]`)) a.href = asset ? asset.url : RELEASES;
      for (const m of $$(`[data-dl-size="${key}"]`)) m.textContent = asset ? mb(asset.size) : '';
      for (const m of $$(`[data-dl-meta="${key}"]`)) if (asset) m.textContent = `${asset.name} · v${rel.version} · ${mb(asset.size)}`;
    }
    for (const v of $$('[data-dl-version]')) v.textContent = `v${rel.version} · ${T.free}`;
  };
  const CACHE_KEY = 'souldew-release-v4'; // v4: with the Intel Mac DMG
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
    const rel = { version: String(data.tag_name || '').replace(/^v/, ''), mac: find(/^souldew-.+-arm64\.dmg$/i), macx64: find(/^souldew-.+-x64\.dmg$/i), win: find(/^souldew-.+-win-x64-setup\.exe$/i),
      linux: find(/^souldew-.+-linux-x86_64\.AppImage$/i), deb: find(/^souldew-.+-linux-amd64\.deb$/i) };
    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), rel })); } catch { /* fine */ }
    return rel;
  };
  loadRelease().then((rel) => { if (rel && rel.version) apply(rel); }).catch(() => { /* offline: links keep pointing at the releases page */ });
})();
