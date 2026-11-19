/* souldew website – progressive enhancement only: without JS every link still works and every text is visible. */
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const DE = document.documentElement.lang === 'de';
  const REPO = 'souldewapp/souldew';
  const RELEASES = `https://github.com/${REPO}/releases/latest`;
  const T = DE ? {
    free: 'Kostenlos · Open Source (GPL-3.0)',
    status: ['Verlinkt auf Route 29', 'Ein Geodude eines Trainers greift an!', 'Ember wurde besiegt.', 'Das Link-Kabel reißt.', 'Chomp ist auch weg. Route 29 ist verloren.'],
  } : {
    free: 'Free · open source (GPL-3.0)',
    status: ['Linked on Route 29', 'A trainer’s Geodude attacks!', 'Ember fainted.', 'The link cable snaps.', 'Chomp is gone too. Route 29 is lost.'],
  };
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

  // ---------- nav background once the page moves ----------
  const nav = $('[data-nav]');
  const onNav = () => nav && nav.classList.toggle('scrolled', window.scrollY > 24);
  onNav();
  window.addEventListener('scroll', onNav, { passive: true });

  // ---------- reveal: LCD scan line ----------
  const revealIO = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); revealIO.unobserve(e.target); }
  }, { rootMargin: '0px 0px -8% 0px' });
  for (const el of $$('[data-reveal]')) revealIO.observe(el);

  // ---------- feature index: one row open at a time ----------
  for (const list of $$('[data-findex]')) {
    const buttons = $$('button', list);
    for (const b of buttons) {
      b.addEventListener('click', () => {
        for (const o of buttons) o.setAttribute('aria-expanded', String(o === b));
      });
    }
  }

  // ---------- the link cable snaps ----------
  const pin = $('[data-pin]');
  if (pin) {
    const hpBar = $('[data-hp-bar]', pin);
    const hpNum = $('[data-hp]', pin);
    const status = $('[data-pin-status]', pin);
    const replay = $('[data-pin-replay]', pin);
    const card = $('[data-mon="a"]', pin);
    let shown = '';
    const render = (state, hp, msg) => {
      pin.dataset.state = state;
      card.style.setProperty('--hp', String(hp));
      hpNum.textContent = String(hp);
      pin.toggleAttribute('data-hp-low', hp <= 9);
      if (msg !== shown) { status.textContent = msg; shown = msg; }
    };
    const fromProgress = (p) => {
      if (p < 0.04) return render('linked', 34, T.status[0]);
      if (p < 0.5) return render('hit', Math.max(1, Math.round(34 * (1 - (p - 0.04) / 0.46))), T.status[1]);
      if (p < 0.62) return render('fainted', 0, T.status[2]);
      if (p < 0.8) return render('snapped', 0, T.status[3]);
      return render('gone', 0, T.status[4]);
    };
    void hpBar;
    const wide = window.matchMedia('(min-width: 901px)');
    let timers = [];
    const play = () => {
      for (const t of timers) clearTimeout(t);
      timers = [];
      const steps = [[0, 0], [700, 0.2], [1300, 0.32], [1900, 0.46], [2700, 0.55], [3700, 0.7], [4800, 0.9]];
      for (const [ms, p] of steps) timers.push(setTimeout(() => fromProgress(p), reduced.matches ? ms / 3 : ms));
    };
    const setup = () => {
      const pinned = wide.matches && !reduced.matches;
      pin.classList.toggle('pinned', pinned);
      replay.hidden = pinned;
      fromProgress(pinned ? 0 : 0);
    };
    setup();
    wide.addEventListener('change', setup);
    let ticking = false;
    window.addEventListener('scroll', () => {
      if (!pin.classList.contains('pinned') || ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        const r = pin.getBoundingClientRect();
        fromProgress(clamp(-r.top / (r.height - window.innerHeight), 0, 1));
      });
    }, { passive: true });
    new IntersectionObserver((entries, io) => {
      if (entries[0].isIntersecting && !pin.classList.contains('pinned')) { play(); io.disconnect(); }
    }, { threshold: 0.5 }).observe($('.cable-scene', pin));
    replay.addEventListener('click', play);
  }

  // ---------- statement: words light up as it scrolls through ----------
  const statement = $('[data-words]');
  if (statement && !reduced.matches) {
    statement.innerHTML = statement.textContent.trim().split(/\s+/).map((w) => `<span class="w">${w}</span>`).join(' ');
    const words = $$('.w', statement);
    let ticking = false;
    const update = () => {
      ticking = false;
      const r = statement.getBoundingClientRect();
      const vh = window.innerHeight;
      const p = clamp((vh * 0.92 - r.top) / (vh * 0.62), 0, 1);
      const lit = p * words.length;
      words.forEach((w, i) => w.style.setProperty('--o', String(clamp(0.22 + (lit - i) * 0.78, 0.22, 1))));
    };
    update();
    window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
  }

  // ---------- pixel-art route behind the stream overlays (320×180, scaled up) ----------
  const route = $('[data-route]');
  if (route) paintRoute(route);
  function paintRoute(cv) {
    const g = cv.getContext('2d');
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const px = (x, y, c, w = 1, h = 1) => { g.fillStyle = c; g.fillRect(x, y, w, h); };
    const bayer = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
    const sky = ['#5f9fd6', '#77b2e0', '#93c6ea', '#b4dbf1', '#d3ecf6'];
    for (let y = 0; y < 100; y++) for (let x = 0; x < 320; x++) {
      const t = Math.min(y, 91) / 92 * (sky.length - 1); const i = Math.floor(t); const f = t - i;
      px(x, y, f * 16 > bayer[y % 4][x % 4] ? sky[Math.min(i + 1, sky.length - 1)] : sky[i]);
    }
    const CLOUD = ['......####..........', '....########...###..', '...###########OOOO#.', '.#################OO', '####################', 'oooooooooooooooooooo'];
    const cloud = (cx, cy) => CLOUD.forEach((row, y) => [...row].forEach((ch, x) => { if (ch !== '.') px(cx + x, cy + y, ch === '#' ? '#ffffff' : ch === 'O' ? '#f1f8fd' : '#cfe6f5'); }));
    cloud(150, 8); cloud(214, 40); cloud(60, 52);
    for (let x = 0; x < 320; x++) { const h = 86 - Math.round(6 * Math.sin(x / 23) + 4 * Math.sin(x / 9 + 1)); px(x, h, '#7fb46a', 1, 100 - h); }
    const tree = ['....##....', '...####...', '..######..', '.########.', '..######..', '.########.', '##########', '.########.', '....##....', '....##....'];
    for (let tx = -6; tx < 320; tx += 9) {
      const ty = 84 + Math.round(rnd() * 3);
      tree.forEach((row, y) => [...row].forEach((ch, x) => { if (ch === '#') px(tx + x, ty + y, y > 7 ? '#5a3b26' : (x + y) % 5 === 0 ? '#3f8a45' : y < 3 ? '#4f9e52' : '#2f6e3a'); }));
    }
    const meadow = ['#9fd07a', '#8cc46a', '#79b65c', '#679f4c'];
    for (let y = 96; y < 180; y++) for (let x = 0; x < 320; x++) {
      const t = (y - 96) / 84 * 3; const i = Math.floor(t); const f = t - i;
      px(x, y, f * 16 > bayer[y % 4][x % 4] ? meadow[Math.min(i + 1, 3)] : meadow[i]);
    }
    for (let y = 100; y < 180; y++) {
      const c = 210 + Math.round(18 * Math.sin(y / 14)) - (y - 100) * 0.35; const w = 18 + (y - 100) * 0.42;
      px(Math.round(c - w / 2), y, '#e6d6a0', Math.round(w), 1); px(Math.round(c - w / 2), y, '#cdb983'); px(Math.round(c + w / 2), y, '#cdb983');
    }
    const tuft = ['.#..#.', '##.##.', '.####.', '######'];
    for (let i = 0; i < 70; i++) {
      const x = Math.round(rnd() * 300); const y = 104 + Math.round(rnd() * 70);
      tuft.forEach((row, dy) => [...row].forEach((ch, dx) => { if (ch === '#') px(x + dx, y + dy, dy === 0 ? '#c4ec98' : '#3f8f40'); }));
    }
    for (let i = 0; i < 26; i++) { const x = Math.round(rnd() * 318); const y = 100 + Math.round(rnd() * 76); px(x, y, rnd() > 0.5 ? '#ffe36b' : '#ff9ccf'); px(x, y + 1, '#2f6e3a'); }
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

  // the download menu in the nav: closes on Escape, on a click outside it and after a pick
  const menu = $('[data-nav-dl]');
  if (menu) {
    const close = () => { menu.open = false; };
    document.addEventListener('click', (e) => { if (menu.open && !menu.contains(e.target)) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menu.open) { close(); $('summary', menu).focus(); } });
    for (const a of $$('a', menu)) a.addEventListener('click', close);
  }
  const CACHE_KEY = 'souldew-release-v3'; // v3: with the Linux assets
  const load = async () => {
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
  load().then((rel) => { if (rel && rel.version) apply(rel); }).catch(() => { /* offline: links keep pointing at the releases page */ });
})();
