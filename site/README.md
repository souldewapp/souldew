# souldew website

The project page for GitHub Pages – static HTML, CSS and vanilla JS, no build step, no frameworks.

- **Home** (`index.html`, `de/index.html`): the souldew site as it was for 2.8 (“the link cable”, `assets/css/site.css`,
  `assets/js/site.js`) plus one short band near the top that leads to the 3.0 page (`.v3`, styles at the end of
  `site.css`), a “3.0” link in the nav and the privacy / code-signing links in the footer and under the downloads.
- **souldew 3.0** (`3/index.html`, `de/3/index.html` – https://souldew.app/3/ and /de/3/): its own page, own styles and
  script (`assets/css/site30.css`, `assets/js/site30.js`). Two handhelds lit like the 3.0 film, turned inward and cut by the viewport
  around the headline; trade and battle as a built, animated sequence of souldew's interface; Shared World; a raid's
  shared pool with hit chips; friends; souldew+ – the 3D launch scrubbed frame by frame (plays once on phones, one still
  with reduced motion), “Your handheld” as a carousel of every skin with stickers, banners, frames, themes, tiers,
  the thank-you wall. The hero handhelds drift with a gentle parallax (off with reduced motion).

Names on the page are neutral (Sam, Tim, Lena, Kim, Robin, Noor, Finn, Lou) – never a real person's.

## What's where

| Path | Contents |
|---|---|
| `index.html`, `de/index.html` | Home (2.8 site + the 3.0 band). Change both when content changes. |
| `3/index.html`, `de/3/index.html` | The 3.0 page. The German one is the English one with the texts swapped – change both. |
| `privacy.html` | Privacy policy in English (website + desktop app, incl. account, souldew+, thank-you wall; section 4: the iPhone app). `REVIEW(owner)` comments need the owner's check. |
| `support.html`, `de/support.html` | Support for the iPhone app and the desktop app (Discord, tickets, bug reports, FAQ). The App Store's Support URL. Change both. |
| `code-signing.html`, `de/code-signing.html` | The code signing policy SignPath Foundation asks for (Windows builds only). |
| `impressum.html`, `datenschutz.html` | Legal notice and privacy policy (German, binding; section 8: the iPhone app). |
| `assets/img/30/hero2/` | The two hero handhelds (`l|r-1400|720.webp`), rendered from the app's scene with the trailer's light rig; also used by the home band. |
| `assets/img/30/unfold/{1400,760}/` | The 3D launch (DS, Golden Wheat) as 53 frames, transparent – the scrub uses 2…52. |
| `assets/img/30/hh/` | The skin carousel: a picture of every skin (no stickers, `-1400/-760/-thumb`) and each sticker cut out (difference-matted), positioned in % in the HTML. |
| `assets/img/30/ui/` | Crops of souldew's real interface (friends, Shared World game view). |
| `assets/img/30/looks/`, `themes/` | souldew+ public preview media: banners, nameplates, frames, the 16 colour themes. |
| `assets/img/og-30.png`, `og-30-de.png` | Social previews of the 3.0 page (1200×630); the home keeps `og-image.png`. |

Deployment: `.github/workflows/pages.yml` uploads this folder on every push to `main` that touches `site/**`.
**The 3.0 site lives on `feat/30-site` and must not reach `main` before the 3.0 launch.**

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
scratch data folder, dev souldew+ pack) plus site shots (`site`, `site2` with the trailer's light rig) for the hero,
the unfold, the skins and the stickers – the screens show the app's placeholder picture with its roof drawn the right way up;
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
- The screenshots show demo runs and test names (`Robin & Kim`, `Sam`, `Tim`, `Lena`). No box art or official artwork.
- The privacy policies mention the GitHub API call, the `sessionStorage` cache and the thank-you wall request. If you add anything that contacts a
  third party (analytics, embeds, web fonts from a CDN …), update `datenschutz.html` first.
