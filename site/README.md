# souldew website

The project page for GitHub Pages – static HTML, CSS and vanilla JS, no build step, no frameworks. Version 3.0
(“the link”): two players, one world, no cable. A dark stage, souldew's own 3D handheld as the object, souldew's real
interface as the proof, the two player colours (P1 blue, P2 pink) only where two players are meant, gold only for
souldew+. One pinned moment: the 3D launch animation, scrubbed frame by frame (desktop with motion; on phones it
plays once, with reduced motion it is one still).

Address: **https://souldew.app/** (English) and **/de/** (German).

## What's where

| Path | Contents |
|---|---|
| `index.html`, `de/index.html` | The landing page in English and German. Identical markup, only the text differs – **change both** when content changes (German paths are prefixed with `../`). |
| `privacy.html` | Privacy policy in English (website + app, incl. account, souldew+, thank-you wall). Comments marked `REVIEW(owner)` need the owner's check. |
| `code-signing.html`, `de/code-signing.html` | The code signing policy SignPath Foundation asks for (Windows builds only). |
| `impressum.html`, `datenschutz.html` | Legal notice and privacy policy (German, binding). |
| `404.html` | Served by GitHub Pages for unknown paths (absolute links). |
| `assets/css/site.css` | All styles: tokens, type, hero, link stage, Shared World, raid pool, friends, souldew+ (launch pin, handheld, looks, themes, tiers, thanks), also-new list, downloads, FAQ, legal pages, responsive rules, reduced motion. |
| `assets/js/site.js` | Progressive enhancement: download links + latest release (GitHub API), reveals, the hero emote, the link line, the raid pool demo, the launch scrub/autoplay, skins and stickers, colour themes, the banner drift, the thank-you wall. Strings for both languages are at the top. |
| `assets/img/30/hero/` | The two handhelds of the hero (rendered from the app's own 3D scene, `web/lib/handheld/scene.mjs`). |
| `assets/img/30/unfold/{1400,760}/f00–f51.webp` | The 3D launch (DS, Golden Wheat) as 52 frames, transparent – the scrub. |
| `assets/img/30/hh/` | “Your handheld”: one still per skin (`<skin>-1400/760.webp`, no stickers) and each sticker cut out (`stk-*.webp`, difference-matted from two skins), positioned in % in the HTML. |
| `assets/img/30/ui/` | Crops of souldew's real interface (2× screenshots from the e2e scripts), rounded corners cut. |
| `assets/img/30/looks/` | souldew+ preview media (the public previews the accounts service hands out): animated banners and nameplates (native pixel size, scaled with `image-rendering: pixelated`), frames. |
| `assets/img/30/themes/` | The app's settings in each of the 16 colour themes (public previews). |
| `assets/img/shots/` | The board screenshot (2880×1800 and 1440 wide). |
| `assets/img/og-30.png`, `og-30-de.png` | Social previews (1200×630). |
| `assets/fonts/` | Self-hosted fonts (Pixelify Sans and IBM Plex under the SIL OFL, texts included; Pixel Digits is made by this project). |
| `robots.txt`, `sitemap.xml`, `.nojekyll` | For search engines / GitHub Pages. |

No box art, logos or official artwork. Game graphics appear only as a player's own game inside souldew's interface:
`ui/world-game.webp` (Shared World) and the party icons on the board screenshot.

Deployment: `.github/workflows/pages.yml` uploads this folder on every push to `main` that touches `site/**`
(or by hand via *Run workflow*). **The 3.0 site lives on `feat/30-site` and must not reach `main` before the 3.0 launch.**

## The thank-you wall

`site.js` asks `GET https://accounts.souldew.app/v1/thanks` once the section is near (no cookies, no referrer, 6 s
timeout) and expects `{ updated, total, counts: { coffee, supporter, plus, legend }, people: [{ name, tier, since, avatar? }] }`.
Names are set as text; an avatar is shown only when its URL starts with `https://accounts.souldew.app/`. When the
request fails (not deployed, offline, CORS) the static text stays – nothing waits for it. The endpoint must answer with
`Access-Control-Allow-Origin: https://souldew.app`.

## Before going live

1. `impressum.html`, `datenschutz.html` and `privacy.html` carry the operator's details. Resolve the `REVIEW(owner)`
   comments and update the dates when their content changes. Not legal advice.
2. Repository **Settings › Pages › Build and deployment › Source: "GitHub Actions"**.
3. If the address ever changes, update the absolute URLs: `canonical`, `hreflang`, `og:url`, `og:image`,
   `twitter:image` in both `index.html` files and the other pages, `sitemap.xml`, `robots.txt` and `404.html`.

## Regenerating the pictures

The 3D renders come from the app itself: `~/souldew-promo/trailer30/tools/hh-studio.mjs` (hidden Electron window,
scratch data folder, dev souldew+ pack) plus a small site shot (`site`) for the unfold, the skins and the stickers;
the sticker layers are separated by difference matting against two skins. The UI crops come from the screenshots that
`scripts/whatsnew-media.mjs` uses. Never commit the screenshots or a pack.

## How the download buttons work

- Without JavaScript every download button links to `https://github.com/souldewapp/souldew/releases/latest`.
- The page doesn't guess the visitor's system. Every download sits side by side in one fixed order – macOS (.dmg),
  Windows (.exe), Linux (AppImage), Linux (.deb) – as four tiles in the hero and as a menu behind the "Download"
  button in the nav (a `<details>`, so it opens without JavaScript too). The download section keeps its three
  platform panels in the same order.
- `site.js` asks `https://api.github.com/repos/souldewapp/souldew/releases/latest` (cached for 30 minutes in
  `sessionStorage`) and picks the assets by name: `souldew-<v>-arm64.dmg`, `souldew-<v>-win-x64-setup.exe`,
  `souldew-<v>-linux-x86_64.AppImage` and `souldew-<v>-linux-amd64.deb`. Tiles, menu and panels then link straight
  to the files and show their size; the version goes next to "Free · open source". A file a release lacks keeps
  its link to the releases page.

## Preview locally

```sh
python3 -m http.server 8000 --directory site
```

Then open http://localhost:8000/ (use any free port). Opening the HTML files directly from disk mostly works too, but
the icon sprite (`<use href="assets/img/icons.svg#…">`) needs a server in some browsers.

## Content notes

- Every claim on the page is taken from `CHANGELOG.md` (## 3.0.0), the README and the app's own souldew+ texts – keep
  it in sync when features change. Save import/export is marked as a `TODO(3.0)` in the “also new” list.
- The screenshots show demo runs and test names (`Robin & Kim`, `Marius`, `Tim`, `Lena`). No box art or official artwork.
- The privacy policies mention the GitHub API call, the `sessionStorage` cache and the thank-you wall request. If you add anything that contacts a
  third party (analytics, embeds, web fonts from a CDN …), update `datenschutz.html` first.
