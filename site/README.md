# souldew website

The project page for GitHub Pages – static HTML, CSS and vanilla JS, no build step, no frameworks, no external
requests except one call to the GitHub API for the latest release. Concept: **the link cable** – two players,
one run. A dark stage, one bright LCD section, the pixel type and player colours from the README graphics
(`build/readme/art.html`), and exactly one pinned moment: Ember and Chomp hang on a link cable that snaps when Ember
faints (`#link`, scroll-driven on desktop, plays by itself on phones and with reduced motion).

Address: **https://souldewapp.github.io/souldew/** (English) and **/de/** (German).

## What's where

| Path | Contents |
|---|---|
| `index.html`, `de/index.html` | The landing page in English and German. Identical markup, only the text differs – **change both** when content changes (German paths are prefixed with `../`). |
| `impressum.html`, `datenschutz.html` | Legal notice and privacy policy (German). |
| `404.html` | Served by GitHub Pages for unknown paths (absolute links to `/souldew/`). |
| `assets/css/site.css` | All styles: tokens, type scale, hero, the pinned link cable, LCD code section, annotated board with zoom lenses, feature index, stream scene, responsive rules, reduced motion, legal pages. |
| `assets/js/site.js` | Progressive enhancement: OS-aware download buttons + latest release (GitHub API), the link-cable story, the feature index, the word-by-word statement, the pixel-art route scene, the LCD scan reveal. Strings for both languages are at the top. |
| `assets/img/icons.svg` | Pixel icon sprite, generated from `web/lib/icons.mjs` (each icon is a 16×16 `#` bitmap) plus `star`, `code`, `arrow`, `menu`, `spark` and the chain mark. |
| `assets/img/shots/` | App screenshots from `build/readme/shots/` – 2880×1800 originals and 1440×900 versions (`cwebp -resize 1440 0`) for `srcset`; the 2880 ones also feed the zoom lenses and the demo sprites. |
| `assets/img/overlays/` | The real OBS overlays from `build/readme/overlays/` (transparent WebP). |
| `assets/img/og-image.png` | Social preview (1280×640) – a copy of `docs/media/social-preview.png`. |
| `assets/fonts/` | Self-hosted fonts (Pixelify Sans and IBM Plex under the SIL OFL, texts included; Pixel Digits is made by this project). |
| `robots.txt`, `sitemap.xml`, `.nojekyll` | For search engines / GitHub Pages. |

Deployment: `.github/workflows/pages.yml` uploads this folder on every push to `main` that touches `site/**`
(or by hand via *Run workflow*).

## Before going live

1. `impressum.html` and `datenschutz.html` carry the operator's details (taken from kapischka.de/impressum). Keep them
   in sync if those change, and update the date in the privacy policy when its content changes. Not legal advice.
2. Repository **Settings › Pages › Build and deployment › Source: "GitHub Actions"**. After that the workflow publishes
   the site; the first run can also be started from the Actions tab.
3. If the address ever changes (custom domain, other repository name), update the absolute URLs: `canonical`,
   `hreflang`, `og:url`, `og:image`, `twitter:image` in both `index.html` files, `sitemap.xml`, `robots.txt` and the
   `/souldew/` paths in `404.html`.

## How the download buttons work

- Without JavaScript every download button links to `https://github.com/souldewapp/souldew/releases/latest`.
- `site.js` detects the visitor's system (`navigator.userAgentData.platform`, falling back to the user agent): the
  header and hero buttons say "Download for Windows" on Windows, "Download for Linux" on Linux (Steam Deck included)
  and "Download for macOS" everywhere else, and the matching platform panel in the download section moves first and
  gets a green outline.
- It then asks `https://api.github.com/repos/souldewapp/souldew/releases/latest` (cached for 30 minutes in
  `sessionStorage`) and picks the assets by name: `souldew-<v>-arm64.dmg`, `souldew-<v>-win-x64-setup.exe`,
  `souldew-<v>-linux-x86_64.AppImage` and `souldew-<v>-linux-amd64.deb` (the second link in the Linux panel). The
  buttons link straight to the files and show version and size. If a release has no Windows or Linux asset, that
  button says it's coming and links to the releases page.

## Preview locally

```sh
python3 -m http.server 8000 --directory site
```

Then open http://localhost:8000/ (use any free port). Opening the HTML files directly from disk mostly works too, but
the icon sprite (`<use href="assets/img/icons.svg#…">`) needs a server in some browsers.

## Content notes

- Everything on the page is taken from the README and `docs/STREAMING.md` – keep it in sync when features change
  (e.g. the Windows details once 2.1 ships, the supported-games table, the FAQ).
- The screenshots show demo runs (`Robin & Kim`, `Johto Trio`, `Kim's Nuzlocke`). Pokémon sprites appear only inside
  those screenshots/overlays (the demo crops them from `shots/board.webp`); no box art or official artwork is used.
- The privacy policy mentions the GitHub API call and the `sessionStorage` cache. If you add anything that contacts a
  third party (analytics, embeds, web fonts from a CDN …), update `datenschutz.html` first.
