// Website copy of the app's cosmetics state (web/lib/cosmetics/state.mjs), cut down to what the 3D handheld needs:
// the free banners only (the free Plain Dusk wrap is made from one). No souldew+ content is ever loaded here.
import FREE_BANNERS from './content/banners-free.mjs';

export const content = { banners: new Map(FREE_BANNERS.map((b) => [b.id, b])), handheld: null };
export const state = { generation: 0 };
