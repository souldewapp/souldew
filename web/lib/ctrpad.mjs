// On-screen gamepad of the built-in 3DS player (phones and tablets): Circle Pad, D-pad, A B X Y, L R, Start, Select.
// It sits on the edges of the page, over the black space beside the picture (landscape) or below it (portrait), and is
// see-through. Every control follows its own finger (pointer events with capture), so several can be held at once.
// The Game Boy / DS player gets its pad from EmulatorJS; this player has no EmulatorJS, hence this file.
//
// mountPad(parent, onChange): onChange({ bits, lx, ly }) – `bits` the libretro joypad bits (as ctrplayer.mjs BIT), lx / ly
// the Circle Pad, -0x7fff…0x7fff (down / right positive).

const BIT = { b: 0, y: 1, select: 2, start: 3, up: 4, down: 5, left: 6, right: 7, a: 8, x: 9, l: 10, r: 11 };
const DEAD = 0.14; // the Circle Pad's dead zone (share of its radius)

const CSS = `
#pad { position: fixed; inset: 0; pointer-events: none; z-index: 5; --u: min(11vh, 11vw, 64px); user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
#pad * { box-sizing: border-box; touch-action: none; user-select: none; -webkit-user-select: none; }
#pad .c { position: absolute; pointer-events: auto; opacity: .5; color: #fff; font: 700 calc(var(--u) * .34)/1 system-ui, sans-serif; }
#pad .c.on { opacity: .85; }
#pad .btn { display: grid; place-items: center; width: calc(var(--u) * 1.15); height: calc(var(--u) * 1.15); border-radius: 50%; background: rgba(40, 40, 52, .75); border: 2px solid rgba(255, 255, 255, .55); }
#pad .btn.on { background: rgba(255, 255, 255, .5); }
#pad .pill { display: grid; place-items: center; width: calc(var(--u) * 1.5); height: calc(var(--u) * .62); border-radius: 999px; background: rgba(40, 40, 52, .75); border: 2px solid rgba(255, 255, 255, .55); font-size: calc(var(--u) * .26); }
#pad .shoulder { display: grid; place-items: center; width: calc(var(--u) * 2); height: calc(var(--u) * .8); border-radius: calc(var(--u) * .3); background: rgba(40, 40, 52, .75); border: 2px solid rgba(255, 255, 255, .55); }
#pad .dpad { width: calc(var(--u) * 2.9); height: calc(var(--u) * 2.9); border-radius: 50%; background: rgba(40, 40, 52, .45); border: 2px solid rgba(255, 255, 255, .4); }
#pad .dpad i { position: absolute; width: 34%; height: 34%; background: rgba(255, 255, 255, .22); border-radius: 18%; display: block; pointer-events: none; }
#pad .dpad i.on { background: rgba(255, 255, 255, .7); }
#pad .circle { width: calc(var(--u) * 3.1); height: calc(var(--u) * 3.1); border-radius: 50%; background: rgba(40, 40, 52, .45); border: 2px solid rgba(255, 255, 255, .4); }
#pad .circle i { position: absolute; left: 50%; top: 50%; width: 42%; height: 42%; margin: -21% 0 0 -21%; border-radius: 50%; background: rgba(255, 255, 255, .45); pointer-events: none; }
`;

/** Is this a touch screen as the main pointer? (`?touch=1` / `?touch=0` in the address overrides, like lib/platform.mjs.) */
export function isTouchScreen(search = location.search) {
  const forced = new URLSearchParams(search).get('touch');
  if (forced) return forced === '1';
  try {
    return navigator.maxTouchPoints > 0 && matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

export function mountPad(parent, onChange) {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  const root = document.createElement('div');
  root.id = 'pad';
  parent.appendChild(root);

  const held = {}; // button name → number of fingers on it (a finger moving across the D-pad changes buttons)
  let lx = 0;
  let ly = 0;
  const emit = () => {
    let bits = 0;
    for (const [n, c] of Object.entries(held)) if (c > 0) bits |= 1 << BIT[n];
    onChange({ bits, lx, ly });
  };
  const el = (cls, css, text = '') => {
    const e = document.createElement('div');
    e.className = `c ${cls}`;
    Object.assign(e.style, css);
    e.textContent = text;
    root.appendChild(e);
    return e;
  };
  const stop = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  // a plain button: down while a finger is on it
  const button = (name, cls, css, text) => {
    const e = el(cls, css, text);
    const down = new Set();
    e.addEventListener('pointerdown', (ev) => {
      stop(ev);
      e.setPointerCapture(ev.pointerId);
      down.add(ev.pointerId);
      held[name] = (held[name] || 0) + 1;
      e.classList.add('on');
      emit();
    });
    const up = (ev) => {
      if (!down.delete(ev.pointerId)) return;
      held[name] = Math.max(0, (held[name] || 1) - 1);
      if (!down.size) e.classList.remove('on');
      emit();
    };
    e.addEventListener('pointerup', up);
    e.addEventListener('pointercancel', up);
    e.addEventListener('contextmenu', stop);
    return e;
  };

  // shoulder buttons: top corners (the right one leaves room for the app's menu button)
  button('l', 'shoulder', { left: '2.5%', top: '3%' }, 'L');
  button('r', 'shoulder', { right: 'max(14%, 70px)', top: '3%' }, 'R');

  // left: D-pad above, Circle Pad below (the Circle Pad walks in Sun / Moon; Gen 6 walks with either)
  const dpad = el('dpad', { left: '2.5%', bottom: 'calc(var(--u) * 3.4 + 6%)' });
  const arms = { up: ['33%', '2%'], down: ['33%', '64%'], left: ['2%', '33%'], right: ['64%', '33%'] };
  const armEls = {};
  for (const [n, [x, y]] of Object.entries(arms)) {
    const i = document.createElement('i');
    i.style.left = x;
    i.style.top = y;
    dpad.appendChild(i);
    armEls[n] = i;
  }
  const dir = new Map(); // pointerId → the direction names it holds
  const setDir = (id, names) => {
    for (const n of dir.get(id) || []) {
      held[n] = Math.max(0, (held[n] || 1) - 1);
      armEls[n].classList.remove('on');
    }
    if (names) {
      dir.set(id, names);
      for (const n of names) {
        held[n] = (held[n] || 0) + 1;
        armEls[n].classList.add('on');
      }
    } else dir.delete(id);
    emit();
  };
  const dirsAt = (ev) => {
    const r = dpad.getBoundingClientRect();
    const x = (ev.clientX - r.left) / r.width - 0.5;
    const y = (ev.clientY - r.top) / r.height - 0.5;
    if (Math.hypot(x, y) < 0.1) return [];
    const out = [];
    if (Math.abs(x) > 0.15) out.push(x > 0 ? 'right' : 'left');
    if (Math.abs(y) > 0.15) out.push(y > 0 ? 'down' : 'up');
    return out;
  };
  dpad.addEventListener('pointerdown', (ev) => {
    stop(ev);
    dpad.setPointerCapture(ev.pointerId);
    setDir(ev.pointerId, dirsAt(ev));
  });
  dpad.addEventListener('pointermove', (ev) => dir.has(ev.pointerId) && setDir(ev.pointerId, dirsAt(ev)));
  const dpadUp = (ev) => dir.has(ev.pointerId) && setDir(ev.pointerId, null);
  dpad.addEventListener('pointerup', dpadUp);
  dpad.addEventListener('pointercancel', dpadUp);

  const circle = el('circle', { left: '2.5%', bottom: '4%' });
  const knob = document.createElement('i');
  circle.appendChild(knob);
  let stickId = null;
  const moveStick = (ev) => {
    const r = circle.getBoundingClientRect();
    let x = (ev.clientX - (r.left + r.width / 2)) / (r.width / 2);
    let y = (ev.clientY - (r.top + r.height / 2)) / (r.height / 2);
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    knob.style.transform = `translate(${x * 45}%, ${y * 45}%)`;
    const mag = Math.hypot(x, y);
    if (mag < DEAD) {
      lx = 0;
      ly = 0;
    } else {
      const k = (mag - DEAD) / (1 - DEAD) / mag; // from the dead zone's edge, full tilt at the rim
      lx = Math.round(x * k * 0x7fff);
      ly = Math.round(y * k * 0x7fff);
    }
    emit();
  };
  circle.addEventListener('pointerdown', (ev) => {
    stop(ev);
    if (stickId !== null) return;
    stickId = ev.pointerId;
    circle.setPointerCapture(ev.pointerId);
    circle.classList.add('on');
    moveStick(ev);
  });
  circle.addEventListener('pointermove', (ev) => ev.pointerId === stickId && moveStick(ev));
  const stickUp = (ev) => {
    if (ev.pointerId !== stickId) return;
    stickId = null;
    knob.style.transform = '';
    circle.classList.remove('on');
    lx = 0;
    ly = 0;
    emit();
  };
  circle.addEventListener('pointerup', stickUp);
  circle.addEventListener('pointercancel', stickUp);

  // right: A B X Y as a diamond (A right, B below, X above, Y left – the Nintendo layout), Start / Select at the bottom
  const place = (name, dx, dy) => button(name, 'btn', { right: `calc(3.5% + var(--u) * ${1.2 + dx})`, bottom: `calc(4% + var(--u) * ${1.2 + dy})` }, name.toUpperCase());
  place('a', 1.2, 0);
  place('b', 0, -1.2);
  place('x', 0, 1.2);
  place('y', -1.2, 0);
  button('select', 'pill', { left: '50%', bottom: '2.5%', marginLeft: 'calc(var(--u) * -1.65)' }, 'SELECT');
  button('start', 'pill', { left: '50%', bottom: '2.5%', marginLeft: 'calc(var(--u) * .15)' }, 'START');

  return {
    /** Release everything (the page lost focus). */
    reset() {
      for (const k of Object.keys(held)) held[k] = 0;
      lx = 0;
      ly = 0;
      root.querySelectorAll('.on').forEach((n) => n.classList.remove('on'));
      knob.style.transform = '';
      stickId = null;
      dir.clear();
      emit();
    },
    root,
  };
}
