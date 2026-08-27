# Clemson Firefox New Tab

A fully custom Firefox "new tab" page: an animated Clemson-themed skyline
wallpaper that reacts to window size, cycles sky color with real
sunrise/sunset times, layers in live weather effects (Open-Meteo), and shows
a small set of personal bookmark shortcuts you manage with an in-page editor.

There's no build step and no dependencies — a small `index.html` shell plus
`style.css` and `app.js` (vanilla JS), a folder of image assets, and a
`bookmarks.json` file the page edits for you (or you edit by hand).

## Why this exists

Firefox's built-in New Tab page supports a background image and a bookmarks
toolbar, but:

- You can't animate or react to window size with it.
- Once you override the new tab with a custom page (via an extension),
  Firefox's "Only show the bookmarks toolbar on New Tab" setting stops
  applying, and a plain hosted webpage has no access to the WebExtensions
  bookmarks API to render its own toolbar.
- WebExtensions also has no API to auto-focus/select the address bar on a
  new tab ([Mozilla bug](https://bugzilla.mozilla.org/show_bug.cgi?id=1345920)),
  so you lose "just start typing a search" muscle memory.

This project works around both: bookmarks are defined in a simple JSON file
— edited from the page itself — and rendered as grouped link cards, and an
autofocused search box in the center of the page replaces the
address-bar-typing habit (use `Cmd+L` / `Ctrl+L` if you want the real address
bar).

## Features

- **Reactive layout** — the Clemson logo, tiger paw, and mountain skyline
  layers resize and re-nest based on window width/height so nothing crops
  off-screen; layers compress together ("squash") as the window gets short.
- **Time-of-day sky** — background sky color cycles through
  night → dawn → day → dusk → night, anchored to your browser's real
  geolocation (falls back to Clemson, SC if location access is denied).
- **Live weather** — fetches current conditions from the free
  [Open-Meteo](https://open-meteo.com/) API and animates matching effects:
  drifting clouds (cloudy/fog), rain, snow, and darker fast-moving storm
  clouds — plus a small time + weather text widget.
- **Bookmarks section** — reads `bookmarks.json`, groups links by category,
  and renders them as cards with favicons (vendored local copies first,
  Google's favicon service as fallback, a Clemson paw as last resort).
  Links can carry a one-character **speedkey**, opened with Alt+key from
  anywhere on the page. Cards hide automatically if the window gets too
  short to fit them without colliding with the search box, and stack into
  a single scrollable column on narrow windows.
- **In-page editing** — a settings gear opens a panel for search engine,
  clock format, temperature unit, weather effects, and location (all
  persisted to `localStorage`), plus a bookmark editor that adds, removes,
  and reorders links and saves them back to `bookmarks.json` through the
  bundled server.
- **Search box** — autofocused input in place of relying on the
  (new-tab-inaccessible) address bar; the engine is selectable in settings.

## Requirements

- Firefox, or a Chromium-family browser (Chrome/Edge — each option in
  step 3 notes its Chromium equivalent)
- A way to point new tabs at this page's URL — three options, all covered
  in step 3: the
  [New Tab Override](https://addons.mozilla.org/firefox/addon/new-tab-override/)
  extension, a self-signed WebExtension this repo can build for you, or
  (with root access to the Firefox install) the extension-free autoconfig
  method
- Somewhere to host the files over `http(s)://` — see [Hosting](#hosting) below

## Setup

### 1. Get the files somewhere they can be served over HTTP(S)

Firefox blocks `fetch()` (used to load `bookmarks.json`) under `file://`, so
this page needs to be served, not opened directly from disk. Any static web
host works — GitHub Pages, a university web space, Netlify, a local dev
server, etc. — though the in-page bookmark editor can only save on a host
that accepts its PUTs, which the vendored server below does.

Clone the repo onto that host:

```bash
git clone <this-repo-url>
```

#### Hosting

Any static file host is fine as long as the whole folder (not just
`index.html`) is uploaded, so `style.css`, `app.js`, `resources/`, and
`bookmarks.json` stay alongside it with the same relative paths.

The recommended host for a personal machine is the vendored
`scripts/firefox-newtab-serve`: a loopback-only Python server tuned for
this page — keep-alive, version-stamped immutable assets (a warm new tab
transfers a few KB instead of re-downloading everything), and the guarded
PUT endpoint the bookmark editor saves through. Run it from a systemd user
unit for something permanent. There's also an opt-in offline fallback:
`localStorage.setItem('newtab-offline-fallback', 'on')` in the page's
console registers `sw.js`, which keeps the new tab rendering from cache if
the server is ever down (off by default because the service-worker hop
costs a few milliseconds per tab).

For a quick look without any of that:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000/index.html
```

### 2. Edit your bookmarks

Use the in-page editor — the settings gear, then **Edit links…** — or edit
`bookmarks.json` directly. Copy `bookmarks.example.json` to `bookmarks.json`
to start; the real file is gitignored so your links stay on your machine.

```json
{
  "version": 1,
  "categories": [
    {
      "name": "School",
      "links": [
        { "title": "Canvas", "url": "https://example.instructure.com/courses", "key": "c" }
      ]
    }
  ]
}
```

- `categories` render as one card each, in array order. Array order *is*
  display order — the editor's arrows reorder in place.
- `title` is the link text; `url` is the destination.
- `key` is optional: a single character that opens the link with
  **Alt+key** from anywhere on the page, shown as a badge on the card.
  Alt rather than a bare letter because the search box holds focus by
  design. Avoid `f e v s b t h` (Firefox's Linux menu-bar accelerators)
  and digits (some window managers claim `Alt+<number>` first). The editor
  refuses duplicates.

Favicons are served from `resources/favicons/`, populated by
`scripts/firefox-newtab-favicons`. It tries each site's own icon before
falling back to Google's service, which matters for self-hosted things
Google has never crawled. Re-run it after adding bookmarks; anything not
yet vendored falls back to Google's service and then to the paw. Domains
under `NO_FAVICON_DOMAIN_SUFFIXES` (near the bookmarks code in
`app.js`) skip the lookup entirely and use the paw.

### 3. Point Firefox's new tab at your hosted page

Three ways to do this, in increasing order of setup effort:

| | Root needed | New-tab flash | Page edits need |
|---|---|---|---|
| A: New Tab Override | no | yes | nothing |
| B: your own extension | no | no | rebuild + re-sign |
| C: autoconfig | yes | no | nothing |

The instructions below are written for Firefox, but A and B have direct
Chromium equivalents (noted inline), and C's Chromium analog is an
enterprise policy. Safari has no new-tab override mechanism at all — the
page works there only as a homepage.

#### Option A: New Tab Override extension (easiest)

1. Install [New Tab Override](https://addons.mozilla.org/firefox/addon/new-tab-override/).
2. In its settings, choose "Custom URL" and enter the URL where you hosted
   `index.html` (e.g. `https://your-host.example.com/index.html`).
3. Open a new tab — you should see the page load with the search box
   autofocused.

One cost to know about: New Tab Override works by opening its own extension
page and then *navigating* it to your URL, so every new tab pays a double
navigation — visible as a brief flash before the page appears.

#### Option B: build your own extension — no flash, no root

This repo can package the page as a proper WebExtension that overrides the
new tab directly (`chrome_url_overrides`), which removes the redirect hop:
Firefox loads — and preloads — the page itself, and extension new-tab pages
receive keyboard focus natively, so the search box works as designed.

1. Edit `extension/manifest.json` and change the `gecko.id` to something
   unique to you (any email-shaped string works).
2. If you host `bookmarks.json` anywhere other than the loopback server on
   port 8787, change `DATA_BASE` near the top of `app.js` — when running
   as an extension, the page bundles all its assets but still fetches (and
   the editor still saves) `bookmarks.json` from your server. The vendored
   server already accepts editor saves from extension pages; a different
   host needs to allow PUTs from `moz-extension://` origins.
3. Build the package: `scripts/firefox-newtab-xpi` stages the page plus
   assets and produces an unsigned `.xpi` under `extension/`.
4. Release Firefox only installs signed extensions, but self-signing is
   free and needs no review: create API credentials at
   <https://addons.mozilla.org/developers/addon/api/key/>, then

   ```bash
   npx web-ext sign --channel unlisted --source-dir extension/build \
     --api-key "$AMO_JWT_ISSUER" --api-secret "$AMO_JWT_SECRET"
   ```

   and install the signed `.xpi` it drops in `web-ext-artifacts/` via
   `about:addons` → gear menu → *Install Add-on From File*.
5. Disable New Tab Override if you had it — one new-tab owner at a time.

On Firefox flavors that allow unsigned extensions (Developer Edition,
Nightly, and ESR, via `xpinstall.signatures.required=false` in
`about:config`), you can skip step 4 and install the unsigned `.xpi`
directly.

**Chrome / Edge:** the build script also produces a Chromium build (MV3,
from `extension/manifest.chrome.json`) — no signing or store account
needed for personal use: open `chrome://extensions`, enable Developer
mode, and *Load unpacked* pointing at `extension/build-chrome/`. The
`DATA_BASE` note in step 2 applies the same way; the vendored server
accepts editor saves from `chrome-extension://` origins too.

The trade-off: the extension bundles a copy of the page, so every edit to
`index.html`/`app.js`/`style.css` needs a rebuild, a version bump in the
manifest, a re-sign, and a reinstall. Pick this road once your page has
stopped changing daily; while you're still tweaking, Option A or C keeps
edits instant.

#### Option C: autoconfig — no extension, no flash (needs root)

Firefox's [autoconfig](https://support.mozilla.org/kb/customizing-firefox-using-autoconfig)
mechanism can point the *native* new tab straight at the page. The tab loads
your URL directly — no intermediate extension page — and Firefox preloads
its new-tab page in a hidden browser, so the page is typically already
rendered before you press Ctrl+T.

Create two root-owned files in the Firefox install directory (commonly
`/usr/lib/firefox` on Linux; adjust for your distro — this does not work
for snap/flatpak Firefox, whose install dirs are read-only images):

`defaults/pref/autoconfig.js`:

```js
pref("general.config.filename", "firefox.cfg");
pref("general.config.obscure_value", 0);
pref("general.config.sandbox_enabled", false);
```

`firefox.cfg` — note the first line **must** be a comment; the parser
always skips it:

```js
// first line is skipped by the autoconfig parser - keep this comment
try {
  let AboutNewTab;
  try {
    ({ AboutNewTab } = ChromeUtils.importESModule("resource:///modules/AboutNewTab.sys.mjs"));
  } catch (e) {
    // older Firefox module layout
    ({ AboutNewTab } = ChromeUtils.import("resource:///modules/AboutNewTab.jsm"));
  }
  AboutNewTab.newTabURL = "https://your-host.example.com/index.html";
  // Let the page keep keyboard focus (its search box) instead of the URL
  // bar. Firefox keeps focus in the URL bar for the configured new-tab
  // URL unless this flag is set - it's the same mechanism extension
  // new-tab pages use to receive focus.
  AboutNewTab.willNotifyUser = true;
} catch (e) {
  Components.utils.reportError("newtab autoconfig failed: " + e);
}
```

Then restart Firefox (`about:profiles` → "Restart normally…"). If you had
New Tab Override installed, disable it first so the two don't fight over
the new tab.

Caveats, honestly stated:

- `general.config.sandbox_enabled=false` is required for the cfg to reach
  `ChromeUtils` — the cfg then runs with browser privileges. Keep both
  files root-owned (`chmod 644`, owner `root`), which adds no real
  exposure: anyone who can write to the Firefox install dir already owns
  your browser.
- A Firefox package update can drop the two files (package managers
  usually leave unowned files alone, but a layout change won't). If a
  stock new tab ever reappears after an update, re-create them.
- To revert, delete both files and restart Firefox.
- Focus behavior flips: typing after Ctrl+T goes to the page's search box,
  so reaching the real address bar is Ctrl+L (same as under the extension).

The Chromium-family analog of this option is the
[`NewTabPageLocation`](https://chromeenterprise.google/policies/#NewTabPageLocation)
enterprise policy (a registry key on Windows, a plist on macOS, a JSON
file under `/etc/opt/chrome/policies/managed/` on Linux) — same idea:
the browser's native new tab points at your URL, no extension involved.

### 4. (Optional) Allow location access

The first time the page loads, your browser may prompt for location
permission — allow it to get accurate local sunrise/sunset times and
weather. If you deny it, the page falls back to Clemson, SC's coordinates.

## Project structure

```
index.html               Markup shell (the server stamps versioned asset URLs into it)
style.css                All styles
app.js                   All logic (vanilla JS, no build step)
sw.js                    Opt-in offline-fallback service worker (off by default)
bookmarks.json           Your bookmark links (gitignored — see the example below)
bookmarks.example.json   Schema reference: categories, links, optional speedkeys
extension/               WebExtension packaging of the page (step 3, option B)
scripts/
  firefox-newtab-serve        Loopback-only static server, plus PUT for the editor
  firefox-newtab-favicons     Vendors bookmark favicons into resources/favicons/
  firefox-newtab-clouds       Regenerates the cloud sprites from the masters
  firefox-newtab-xpi          Builds the unsigned extension .xpi
  firefox-newtab-profile      Headless-Firefox load-time profiler (needs selenium)
  firefox-newtab-profile-net  curl replay of a new tab's request set
resources/
  ClemsonUniversity_RGB__Orange.png   Clemson wordmark logo
  Paw_RGB__Orange.png                 Tiger paw graphic
  paw-orange.png                      Small paw icon (favicon + bookmark fallback)
  Footer_Layer1.png ... Footer_Layer4.png   Mountain/skyline layers (back to front)
  zoomBG.png                          Original static background this project replaced
  favicons/                           Vendored bookmark icons (gitignored, generated)
  clouds/
    cloud1.png, cloud2.png                    Source cloud art (peak alpha 13/255)
    cloud1-fx.png, cloud2-fx.png               Generated: full-range alpha, 4x, used for cloudy/fog
    cloud1-storm.png, cloud2-storm.png         Generated: same alpha, purple-tinted, used for storms
```

## Customizing

Styles live in `style.css` (CSS custom properties), logic in `app.js`
(small, independent functions) — there's no build step, so just edit and
reload. When serving through `scripts/firefox-newtab-serve`, edits show up
on the very next tab: the server stamps asset URLs with each file's mtime,
so nothing stale can ever be cached. A few starting points:

- **Sky colors** — see the keyframe tables near `buildSkyKeyframes()`.
- **Mountain squash behavior** — `updateLayout()` and the `LAYERS` table.
- **Weather effects** — `spawnClouds()`, `spawnRain()`, `spawnSnow()`,
  `applyWeatherFX()`, and the `CLOUD_IMAGES`/`STORM_CLOUD_IMAGES` arrays.
- **Testing time-of-day changes quickly** — open the browser console and
  call `startTimeDemo()` to rapidly cycle through a full day (`stopTimeDemo()`
  to stop), instead of waiting for real time to pass.
- **Bookmark card styling** — `.bookmark-category`, `.bookmark-link`,
  `.bookmark-category-title` in `style.css`.

## Known limitations

- Requires being served over `http(s)://` — `bookmarks.json` won't load
  under `file://`.
- Weather and astronomical calculations depend on browser geolocation;
  without it, both fall back to Clemson, SC.
- On very short windows, bookmark cards intentionally sink behind the front
  mountain layer as a visual effect — content covered that way is not
  reachable by scrolling. This is a deliberate tradeoff, not a bug.

## License

Copyright (C) 2026 Alex Adkins

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License along with
this program. If not, see <https://www.gnu.org/licenses/>.

### Trademarks and brand assets

The license above covers the code in this repository. It does **not** grant any
rights to Clemson University's trademarks or brand assets, which are not the
author's to license:

- `resources/ClemsonUniversity_RGB__Orange.png` — Clemson University wordmark
- `resources/Paw_RGB__Orange.png`, `resources/paw-orange.png` — Clemson tiger paw

These remain the property of Clemson University. Anyone redistributing a
modified version of this project should substitute their own artwork.
