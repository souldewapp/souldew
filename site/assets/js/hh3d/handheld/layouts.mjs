// The play view's screen shapes on the game's own pixel grid (what the launch animation's last frame lands on and the
// placeholder picture is drawn in): GB 160×144, GBA 240×160, DS two 256×192 screens, 3DS 400×240 + 320×240.
// The 3DS rectangles are shared/ctrlayout.mjs's LAYOUTS (1× units); the DS ones are the player's 256×192 screens,
// stacked ('tb') or side by side ('lr'), with no gap – exactly what play.mjs sizes the frame with (arn).
const R = (x, y, w, h) => ({ x, y, w, h });
export const LAYOUTS = {
  gb: { W: 160, H: 144, screens: [R(0, 0, 160, 144)] },
  gba: { W: 240, H: 160, screens: [R(0, 0, 240, 160)] },
  'ds-tb': { W: 256, H: 384, screens: [R(0, 0, 256, 192), R(0, 192, 256, 192)] },
  'ds-lr': { W: 512, H: 192, screens: [R(0, 0, 256, 192), R(256, 0, 256, 192)] },
  '3ds-tb': { W: 400, H: 480, screens: [R(0, 0, 400, 240), R(40, 240, 320, 240)] },
  '3ds-bt': { W: 400, H: 480, screens: [R(0, 240, 400, 240), R(40, 0, 320, 240)] },
  '3ds-lr': { W: 720, H: 240, screens: [R(0, 0, 400, 240), R(400, 0, 320, 240)] },
  '3ds-large': { W: 560, H: 240, screens: [R(0, 0, 400, 240), R(400, 120, 160, 120)] },
  '3ds-top': { W: 400, H: 240, screens: [R(0, 0, 400, 240)] },
};
/** play.mjs's target.system + its DS / 3DS layout setting → a LAYOUTS key */
export function layoutKey(system, dsLayout = 'tb', ctrLayout = 'tb') {
  if (system === 'gba') return 'gba';
  if (system === 'nds') return dsLayout === 'lr' ? 'ds-lr' : 'ds-tb';
  if (system === '3ds') return `3ds-${LAYOUTS[`3ds-${ctrLayout}`] ? ctrLayout : 'tb'}`;
  return 'gb';
}
