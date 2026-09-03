    // This same file runs in two homes: served from the loopback server,
    // or bundled into a WebExtension (moz-extension:// in Firefox,
    // chrome-extension:// in Chromium). Static assets are relative either
    // way, but bookmarks.json is live data owned by the server, so the
    // extension page must reach across origins for it.
    const IS_EXTENSION = /^(moz|chrome)-extension:$/.test(location.protocol);
    const DATA_BASE = IS_EXTENSION ? 'http://127.0.0.1:8787/' : '';

    const SQUASH_REF_HEIGHT = 700;

    // Each layer's own rendered height (width:100vw; height:auto, so this
    // is fixed regardless of window height) in vw at the 1920px reference,
    // now that layers 1-4 are cropped tight to their content:
    //   layer1: 141px -> 7.34vw   layer3: 355px -> 18.49vw
    //   layer2: 253px -> 13.18vw  layer4: 335px -> 17.45vw
    // That height totally dominates a sub-1vw "bottom" nudge, which is
    // why small nested offsets barely moved anything visible. The nested
    // target for each layer is instead solved backwards from the TOP edge
    // we actually want (a fixed 1vw peek over the layer in front), via
    // offset = desiredTopEdge - ownHeight - which goes solidly negative
    // for the taller back layers, sinking them down behind the front one.
    const OWN_HEIGHT_VW = { l1: 7.34, l2: 13.18, l3: 18.49, l4: 17.45 };
    const PEEK_VW = 1; // each layer's top edge peeks this far above the one just in front, chain built off layer1

    // layer3/4 chain off layer1 exactly as before (1vw peek each step),
    // regardless of where layer2 ends up - only layer2 itself moves.
    let topEdge = OWN_HEIGHT_VW.l1 + PEEK_VW; // reference point one peek above layer1
    const nestedOffsets = { l1: 0 };
    for (const key of ['l3', 'l4']) {
      topEdge += PEEK_VW;
      nestedOffsets[key] = topEdge - OWN_HEIGHT_VW[key];
    }

    // layer2 gets its own, smaller peek above layer1 so it tucks down
    // lower, independent of the layer3/4 chain above.
    const LAYER2_PEEK_VW = 0.2;
    nestedOffsets.l2 = (OWN_HEIGHT_VW.l1 + LAYER2_PEEK_VW) - OWN_HEIGHT_VW.l2;

    // Resting (tall-window) vs. nested-stack (short-window) vw-coefficient
    // for each layer's "bottom" gap.
    const LAYERS = {
      l1: { full: 0,     nested: nestedOffsets.l1 },
      l2: { full: 0.16,  nested: nestedOffsets.l2 },
      l3: { full: 3.33,  nested: nestedOffsets.l3 },
      l4: { full: 8.23,  nested: nestedOffsets.l4 },
    };

    function updateLayout() {
      const ratio = Math.min(1, Math.max(0, window.innerHeight / SQUASH_REF_HEIGHT));
      const t = ratio * ratio;
      const root = document.documentElement.style;
      for (const [key, { full, nested }] of Object.entries(LAYERS)) {
        root.setProperty(`--${key}-vw`, nested + (full - nested) * t);
      }
    }

    updateLayout();
    window.addEventListener('resize', updateLayout);

    // Belt-and-suspenders on top of the autofocus attribute, in case the
    // page is navigated to (rather than freshly loaded) by the new-tab
    // extension.
    document.getElementById('search-input').focus();

    // Under the autoconfig setup Firefox preloads this page in a hidden
    // browser before the tab exists, so the focus() above runs while
    // hidden. Re-assert it once, on the first transition to visible -
    // and only if nothing else holds focus, so it can never yank focus
    // from the bookmark editor or anything the user clicked.
    if (document.visibilityState !== 'visible') {
      document.addEventListener('visibilitychange', function refocus() {
        if (document.visibilityState !== 'visible') return;
        document.removeEventListener('visibilitychange', refocus);
        const active = document.activeElement;
        if (!active || active === document.body) {
          document.getElementById('search-input').focus();
        }
      });
    }

    // Bookmarks section: edit bookmarks.json (categories, each with links)
    // to change what shows up here - it's a plain data file, not synced
    // with Firefox's real bookmarks (a regular webpage can't read those,
    // only extension code can). Icons come from the linked site's own
    // favicon via Google's favicon service, since fetching an arbitrary
    // site's favicon.ico directly runs into inconsistent paths/CORS.
    // Categories render in first-seen order, each as its own column.
    // Google's favicon service returns a generic globe icon with a
    // successful HTTP 200 for domains it hasn't crawled a real favicon
    // for - since that's a *successful* image load, the <img> onerror
    // fallback below can never catch it (there's no error to catch).
    // These institutional domain suffixes are known to only ever get
    // that generic globe, so they skip Google's service entirely and go
    // straight to the paw icon instead.
    const NO_FAVICON_DOMAIN_SUFFIXES = ['clemson.edu', 'eab.com'];

    function hostnameMatchesSuffix(hostname, suffix) {
      return hostname === suffix || hostname.endsWith(`.${suffix}`);
    }

    // Shapes whatever is in the file into a predictable structure. Throws on
    // a document that isn't usable at all, so loadBookmarks can leave the
    // existing cards alone rather than replacing them with nothing - CSV
    // used to fail one line at a time, JSON fails all at once.
    // A speedkey is a single character matched case-insensitively against
    // the keyboard event. Anything else in the file - empty, multi-character,
    // punctuation - is dropped rather than treated as an error: a malformed
    // key shouldn't cost you the bookmark it belongs to.
    function normalizeSpeedkey(value) {
      if (typeof value !== 'string') return '';
      const ch = value.trim().charAt(0).toLowerCase();
      return /[a-z0-9]/.test(ch) ? ch : '';
    }

    // key -> the <a> it activates. Rebuilt on every render so it can never
    // outlive the DOM nodes it points at.
    const speedkeyLinks = new Map();

    function parseBookmarksDoc(doc) {
      if (!doc || !Array.isArray(doc.categories)) {
        throw new Error('bookmarks.json has no categories array');
      }
      return doc.categories.map((category) => ({
        name: typeof category.name === 'string' ? category.name : '',
        links: Array.isArray(category.links)
          ? category.links
              .filter((link) => link && typeof link.url === 'string')
              .map((link) => ({
                title: typeof link.title === 'string' ? link.title : '',
                url: link.url,
                key: normalizeSpeedkey(link.key),
              }))
          : [],
      }));
    }

    const BOOKMARKS_CACHE_KEY = 'newtab-bookmarks';

    function readBookmarksCache() {
      try {
        const doc = JSON.parse(localStorage.getItem(BOOKMARKS_CACHE_KEY));
        // Shaped through the same parser the file goes through, so an
        // entry written by an older version of this page can't render
        // something the current code doesn't expect.
        return doc ? parseBookmarksDoc(doc) : null;
      } catch (err) {
        return null;
      }
    }

    function writeBookmarksCache(categories) {
      try {
        localStorage.setItem(BOOKMARKS_CACHE_KEY,
          JSON.stringify({ version: 1, categories }));
      } catch (err) {
        /* caching is an optimisation; never let it break the page */
      }
    }

    function renderBookmarks(categories) {
      const section = document.getElementById('bookmarks-section');
      section.innerHTML = '';
      speedkeyLinks.clear();

      for (const category of categories) {
        const column = document.createElement('div');
        column.className = 'bookmark-category';

        const heading = document.createElement('h3');
        heading.className = 'bookmark-category-title';
        heading.textContent = category.name;
        column.appendChild(heading);

        for (const { title, url, key } of category.links) {
          let hostname = '';
          try { hostname = new URL(url).hostname; } catch { /* skip favicon if url is malformed */ }

          const link = document.createElement('a');
          link.className = 'bookmark-link';
          link.href = url;
          if (loadSettings().linkTarget === 'new') {
            link.target = '_blank';
            // noopener so the opened page can't reach back through
            // window.opener; noreferrer keeps the referrer off too.
            link.rel = 'noopener noreferrer';
          }

          if (hostname) {
            const icon = document.createElement('img');
            icon.className = 'bookmark-icon';
            icon.alt = '';

            if (NO_FAVICON_DOMAIN_SUFFIXES.some((suffix) => hostnameMatchesSuffix(hostname, suffix))) {
              icon.src = 'resources/paw-orange.png';
            } else {
              // Vendored copy first: it comes off loopback in about a
              // millisecond and paints with the layout. Google's service
              // costs a 301 plus an image fetch, sends
              // cache-control: max-age=1800 so the whole set re-expires
              // every half hour, and is handed this machine's bookmark
              // list every time it does. It stays on as the fallback so a
              // bookmark added since the last firefox-newtab-favicons run
              // still gets a real icon.
              icon.src = `resources/favicons/${encodeURIComponent(hostname)}.png`;
              icon.onerror = () => {
                icon.onerror = () => {
                  icon.onerror = null; // avoid a loop if the fallback itself 404s
                  icon.src = 'resources/paw-orange.png';
                };
                icon.src = `https://www.google.com/s2/favicons?sz=64&domain=${hostname}`;
              };
            }
            link.appendChild(icon);
          }

          const label = document.createElement('span');
          label.textContent = title || hostname || url;
          link.appendChild(label);

          if (key) {
            if (speedkeyLinks.has(key)) {
              // The editor refuses duplicates, but a hand-edited file can
              // still contain them. First one wins; say so rather than
              // leaving the later link mysteriously dead.
              console.warn(`Duplicate speedkey "${key}" ignored for ${url}`);
            } else {
              speedkeyLinks.set(key, link);
              link.setAttribute('aria-keyshortcuts', `Alt+${key.toUpperCase()}`);
              const badge = document.createElement('span');
              badge.className = 'bookmark-key';
              badge.textContent = key;
              badge.setAttribute('aria-hidden', 'true');
              link.appendChild(badge);
            }
          }

          column.appendChild(link);
        }

        section.appendChild(column);
      }

      updateBookmarksVisibility();
    }

    async function loadBookmarks() {
      // Paint the cached copy first. This runs before the first await, so
      // the cards are in the DOM in the same task the script executes in
      // rather than a frame or two later when the fetch resolves.
      const cached = readBookmarksCache();
      if (cached) renderBookmarks(cached);

      let categories;
      try {
        const res = await fetch(DATA_BASE + 'bookmarks.json', { cache: 'no-store' });
        categories = parseBookmarksDoc(await res.json());
      } catch (err) {
        // Parse before touching the DOM: a malformed file should leave
        // whatever is already rendered in place, not wipe it - which now
        // also means a bad file leaves the cached copy on screen.
        console.error('Bookmarks load failed, keeping what is rendered:', err);
        return;
      }

      // Re-render only on an actual change: both sides have been through
      // parseBookmarksDoc, so their shapes are directly comparable, and
      // skipping the no-op avoids tearing down and rebuilding identical
      // DOM (which would also restart every favicon load).
      if (!cached || JSON.stringify(categories) !== JSON.stringify(cached)) {
        renderBookmarks(categories);
        writeBookmarksCache(categories);
      }
    }

    // The bookmarks card's "top" is pinned directly to the search bar's
    // measured bottom edge (plus a fixed pixel margin) rather than an
    // independent vh value - #search-form's height is fixed px (padding
    // + font-size), so a vh-based gap between two independently-vh-
    // positioned elements shrinks much faster than it looks like it
    // should as the window gets shorter. Pinning removes that gap from
    // the equation, so it can never collide with the search bar.
    //
    // Height is capped generously against the viewport bottom (with
    // internal scrolling for overflow, in case the list ever grows long
    // enough to need it) rather than stopping before layer1 - layer1's
    // z-index (65 < 70, see CSS) now sits in front of this section, so
    // its jagged silhouette visually sinks over whatever the mountain
    // has risen high enough to cover on short windows. That's a
    // deliberate trade-off: content under the mountain's opaque pixels
    // can't be scrolled back into view, since layer1 is fixed on screen
    // and scrolling only pans this box's own content past it.
    const GAP_BELOW_SEARCH_BAR_PX = 24;
    const GAP_ABOVE_VIEWPORT_BOTTOM_PX = 16;
    const MIN_BOOKMARKS_HEIGHT_PX = 160;
    const NARROW_WIDTH_PX = 600; // must match the media query breakpoint above

    function updateBookmarksVisibility() {
      const section = document.getElementById('bookmarks-section');
      // The show/hide setting outranks the fit calculation below. It has to
      // be checked here rather than at the call sites, because this also
      // runs on every resize (see the listener below) and would otherwise
      // put the cards straight back.
      if (loadSettings().showBookmarks === 'off') {
        section.style.display = 'none';
        return;
      }
      if (!section.childElementCount) return; // nothing loaded yet

      const searchRect = document.getElementById('search-form').getBoundingClientRect();
      const top = searchRect.bottom + GAP_BELOW_SEARCH_BAR_PX;
      section.style.top = `${top}px`;

      const availableHeight = window.innerHeight - GAP_ABOVE_VIEWPORT_BOTTOM_PX - top;

      if (availableHeight < MIN_BOOKMARKS_HEIGHT_PX) {
        section.style.display = 'none';
        return;
      }

      section.style.display = 'flex';
      const columns = section.querySelectorAll('.bookmark-category');

      if (window.innerWidth <= NARROW_WIDTH_PX) {
        // Stacked into one column (see the media query above) - a single
        // shared scroll on the section itself, not per-category. Sized
        // relative to the search bar's own measured width (rather than
        // an independent clamp()) so it's guaranteed to stay narrower
        // than it at any viewport size, not just where the two clamps
        // happen to line up.
        section.style.width = `${searchRect.width * 0.9}px`;
        section.style.maxHeight = `${availableHeight}px`;
        section.scrollTop = 0; // guard against scroll-anchoring nudging this once icons load async
        columns.forEach((column) => { column.style.maxHeight = ''; });
      } else {
        // Side-by-side cards, each scrolling independently - a short
        // column (e.g. Advising) shouldn't need to scroll just because a
        // longer one (e.g. CPSC 1050) does.
        section.style.width = '';
        section.style.maxHeight = '';
        columns.forEach((column) => {
          column.style.maxHeight = `${availableHeight}px`;
          column.style.overflowY = 'auto';
          column.scrollTop = 0;
        });
      }
    }

    window.addEventListener('resize', updateBookmarksVisibility);

    loadBookmarks();

    // Sky color cycles with the time of day: each keyframe gives the
    // zenith (top of sky) and horizon (just above the mountains) color
    // at a given hour, and the current color is linearly interpolated
    // between the two nearest keyframes. Colors stay in the same
    // purple/orange family as the artwork rather than going true blue,
    // so daytime doesn't clash with the fixed-color mountain layers.
    // The hours themselves aren't fixed - sunriseHour/sunsetHour are
    // computed below from real sunrise/sunset for today, and everything
    // else is placed relative to those two anchors.
    const CLEMSON_SC = { lat: 34.6834, lng: -82.8374 }; // fallback if geolocation isn't available

    // `night` (0-1) rides the same interpolation and drives the star field
    // and moon (see updateNightSky): stars come out over the two hours
    // after sunset and are gone by sunrise.
    function buildSkyKeyframes(sunriseHour, sunsetHour) {
      return [
        { hour: 0,                zenith: '#0F0A24', horizon: '#1D1440', night: 1 }, // midnight
        { hour: sunriseHour - 1.5, zenith: '#150F30', horizon: '#241748', night: 1 }, // late night
        { hour: sunriseHour,      zenith: '#3B2E63', horizon: '#D97A4D', night: 0 }, // sunrise
        { hour: sunriseHour + 2.5, zenith: '#5A76AE', horizon: '#E3A874', night: 0 }, // morning
        { hour: (sunriseHour + sunsetHour) / 2, zenith: '#6F8FC2', horizon: '#C9A8D9', night: 0 }, // midday
        { hour: sunsetHour - 2.5, zenith: '#5A76AE', horizon: '#E3A874', night: 0 }, // afternoon
        { hour: sunsetHour,       zenith: '#3B2E63', horizon: '#D9633F', night: 0 }, // sunset
        { hour: sunsetHour + 2,   zenith: '#1B1440', horizon: '#2E1A55', night: 1 }, // dusk -> night
        { hour: 24,                zenith: '#0F0A24', horizon: '#1D1440', night: 1 }, // wraps to midnight
      ];
    }

    // Self-contained sunrise/sunset calculation (standard solar-position
    // formulas per the NOAA/"sunrise equation" approach), so this works
    // offline instead of depending on a third-party API on every new tab.
    function getSunriseSunsetHours(date, lat, lng) {
      const rad = Math.PI / 180;
      const dayMs = 864e5;
      const J1970 = 2440588, J2000 = 2451545;
      const e = rad * 23.4397; // obliquity of the Earth

      const toDays = (d) => d.valueOf() / dayMs - 0.5 + J1970 - J2000;
      const solarMeanAnomaly = (d) => rad * (357.5291 + 0.98560028 * d);
      const eclipticLongitude = (M) => {
        const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
        return M + C + rad * 102.9372 + Math.PI;
      };
      const declination = (L) => Math.asin(Math.sin(L) * Math.sin(e));
      const julianCycle = (d, lw) => Math.round(d - 0.0009 - lw / (2 * Math.PI));
      const approxTransit = (Ht, lw, n) => 0.0009 + (Ht + lw) / (2 * Math.PI) + n;
      const solarTransitJ = (ds, M, L) => J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
      const hourAngle = (h, phi, dec) => Math.acos((Math.sin(h) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec)));

      const lw = rad * -lng;
      const phi = rad * lat;
      const d = toDays(date);
      const n = julianCycle(d, lw);
      const ds = approxTransit(0, lw, n);
      const M = solarMeanAnomaly(ds);
      const L = eclipticLongitude(M);
      const dec = declination(L);
      const Jnoon = solarTransitJ(ds, M, L);

      const h0 = rad * -0.833; // standard sunrise/sunset angle (refraction + solar radius)
      const w = hourAngle(h0, phi, dec);
      const Jset = solarTransitJ(approxTransit(w, lw, n), M, L);
      const Jrise = Jnoon - (Jset - Jnoon);

      const julianToHour = (J) => {
        const d2 = new Date((J + 0.5 - J1970) * dayMs);
        return d2.getHours() + d2.getMinutes() / 60;
      };
      return { sunriseHour: julianToHour(Jrise), sunsetHour: julianToHour(Jset) };
    }

    let SKY_KEYFRAMES = buildSkyKeyframes(6.5, 19); // sane default until real sunrise/sunset resolve

    // WMO weather codes (used by Open-Meteo) -> label/icon/overlay category.
    const WEATHER_CODES = {
      0:  { label: 'Clear',            emojiDay: '☀️', emojiNight: '🌙', category: 'clear' },
      1:  { label: 'Mostly Clear',     emojiDay: '🌤️', emojiNight: '🌙', category: 'clear' },
      2:  { label: 'Partly Cloudy',    emojiDay: '⛅', emojiNight: '☁️', category: 'cloudy' },
      3:  { label: 'Overcast',         emojiDay: '☁️', emojiNight: '☁️', category: 'cloudy' },
      45: { label: 'Fog',              emojiDay: '🌫️', emojiNight: '🌫️', category: 'fog' },
      48: { label: 'Fog',              emojiDay: '🌫️', emojiNight: '🌫️', category: 'fog' },
      51: { label: 'Light Drizzle',    emojiDay: '🌦️', emojiNight: '🌧️', category: 'rain' },
      53: { label: 'Drizzle',          emojiDay: '🌦️', emojiNight: '🌧️', category: 'rain' },
      55: { label: 'Heavy Drizzle',    emojiDay: '🌧️', emojiNight: '🌧️', category: 'rain' },
      56: { label: 'Freezing Drizzle', emojiDay: '🌧️', emojiNight: '🌧️', category: 'rain' },
      57: { label: 'Freezing Drizzle', emojiDay: '🌧️', emojiNight: '🌧️', category: 'rain' },
      61: { label: 'Light Rain',       emojiDay: '🌦️', emojiNight: '🌧️', category: 'rain' },
      63: { label: 'Rain',             emojiDay: '🌧️', emojiNight: '🌧️', category: 'rain' },
      65: { label: 'Heavy Rain',       emojiDay: '🌧️', emojiNight: '🌧️', category: 'rain' },
      66: { label: 'Freezing Rain',    emojiDay: '🌧️', emojiNight: '🌧️', category: 'rain' },
      67: { label: 'Freezing Rain',    emojiDay: '🌧️', emojiNight: '🌧️', category: 'rain' },
      71: { label: 'Light Snow',       emojiDay: '🌨️', emojiNight: '🌨️', category: 'snow' },
      73: { label: 'Snow',             emojiDay: '❄️', emojiNight: '❄️', category: 'snow' },
      75: { label: 'Heavy Snow',       emojiDay: '❄️', emojiNight: '❄️', category: 'snow' },
      77: { label: 'Snow Grains',      emojiDay: '❄️', emojiNight: '❄️', category: 'snow' },
      80: { label: 'Rain Showers',     emojiDay: '🌦️', emojiNight: '🌧️', category: 'rain' },
      81: { label: 'Rain Showers',     emojiDay: '🌧️', emojiNight: '🌧️', category: 'rain' },
      82: { label: 'Heavy Showers',    emojiDay: '🌧️', emojiNight: '🌧️', category: 'rain' },
      85: { label: 'Snow Showers',     emojiDay: '🌨️', emojiNight: '🌨️', category: 'snow' },
      86: { label: 'Snow Showers',     emojiDay: '🌨️', emojiNight: '🌨️', category: 'snow' },
      95: { label: 'Thunderstorm',     emojiDay: '⛈️', emojiNight: '⛈️', category: 'storm' },
      96: { label: 'Thunderstorm',     emojiDay: '⛈️', emojiNight: '⛈️', category: 'storm' },
      99: { label: 'Thunderstorm',     emojiDay: '⛈️', emojiNight: '⛈️', category: 'storm' },
    };

    // Translucent wash applied over the sky per weather category - kept
    // light now that clouds/rain/snow do most of the visual work below.
    const WEATHER_TINTS = {
      clear:  'rgba(0, 0, 0, 0)',
      cloudy: 'rgba(90, 95, 110, 0.18)',
      fog:    'rgba(170, 175, 185, 0.4)',
      rain:   'rgba(40, 50, 70, 0.3)',
      snow:   'rgba(210, 215, 230, 0.15)',
      storm:  'rgba(25, 25, 40, 0.4)',
    };

    function clearWeatherFX() {
      document.querySelectorAll('.weather-cloud').forEach((el) => el.remove());
      document.getElementById('precip-layer').innerHTML = '';
    }

    // Two hand-drawn cloud silhouettes (resources/clouds/), alpha-boosted
    // from the user's very-low-opacity source art so they actually read
    // against the sky. Native aspect ratios, used to size each spawn.
    const CLOUD_IMAGES = [
      { src: 'resources/clouds/cloud1-fx.png', aspect: 263 / 72 },
      { src: 'resources/clouds/cloud2-fx.png', aspect: 145 / 23 },
    ];

    // Purple-gray pre-tinted variants for storm, generated the same way
    // as the alpha boost above (same aspect ratios).
    const STORM_CLOUD_IMAGES = [
      { src: 'resources/clouds/cloud1-storm.png', aspect: 263 / 72 },
      { src: 'resources/clouds/cloud2-storm.png', aspect: 145 / 23 },
    ];

    // z-index a cloud can land on when it should be allowed to drift in
    // front of the mountains (fog, storm), each value tucked just above a
    // different layer (see the layer z-indexes above: layer4=20, layer3=40,
    // layer2=50) - always below layer1 (70), so the closest ridge never
    // disappears behind cloud cover.
    const INTERLEAVED_CLOUD_Z = [21, 41, 51];

    // The default opacity range is centred on 0.8 rather than the old
    // 0.35-0.7. The cloud sprites are an even haze with no fully opaque
    // core (see firefox-newtab-clouds), so a cloud that rolled a low
    // opacity dissolved into the sky and read as blurry rather than
    // distant. The spread is kept so clouds still vary; only the centre
    // moved. Per-weather overrides below are deliberately not shifted:
    // fog is meant to be faint, and storm already sits at 0.85-1.
    function spawnClouds(count, { top = [5, 45], width = [14, 26], opacity = [0.7, 0.9], duration = [60, 110], zIndex = [10], allowReverseDrift = true, images = CLOUD_IMAGES } = {}) {
      // Clouds are appended directly into .scene (not a separate
      // positioned wrapper) so each one's z-index is compared directly
      // against the mountain layers, letting fog clouds interleave.
      const scene = document.querySelector('.scene');
      for (let i = 0; i < count; i++) {
        const cloud = document.createElement('div');
        cloud.className = 'weather-cloud';
        const art = document.createElement('div');
        art.className = 'weather-cloud-art' + (Math.random() < 0.5 ? ' flipped' : '');
        const img = images[Math.floor(Math.random() * images.length)];
        art.style.backgroundImage = `url(${img.src})`;
        cloud.appendChild(art);

        const w = width[0] + Math.random() * (width[1] - width[0]);
        const d = duration[0] + Math.random() * (duration[1] - duration[0]);
        cloud.style.aspectRatio = img.aspect;
        cloud.style.width = `${w}vw`;
        cloud.style.top = `${top[0] + Math.random() * (top[1] - top[0])}vh`;
        cloud.style.setProperty('--cloud-opacity', (opacity[0] + Math.random() * (opacity[1] - opacity[0])).toFixed(2));
        cloud.style.animationName = (allowReverseDrift && Math.random() < 0.5) ? 'drift-cloud-reverse' : 'drift-cloud';
        cloud.style.animationDuration = `${d}s`;
        cloud.style.animationDelay = `${-Math.random() * d}s`;
        cloud.style.zIndex = zIndex[Math.floor(Math.random() * zIndex.length)];
        scene.appendChild(cloud);
      }
    }

    function spawnRain(count, { duration = [0.4, 0.8] } = {}) {
      const layer = document.getElementById('precip-layer');
      for (let i = 0; i < count; i++) {
        const drop = document.createElement('div');
        drop.className = 'raindrop';
        const d = duration[0] + Math.random() * (duration[1] - duration[0]);
        drop.style.left = `${Math.random() * 100}vw`;
        drop.style.animationDuration = `${d}s`;
        drop.style.animationDelay = `${-Math.random() * d}s`;
        layer.appendChild(drop);
      }
    }

    function spawnSnow(count) {
      const layer = document.getElementById('precip-layer');
      for (let i = 0; i < count; i++) {
        const flake = document.createElement('div');
        flake.className = 'snowflake';
        const size = 2 + Math.random() * 4;
        const d = 8 + Math.random() * 10;
        flake.style.width = flake.style.height = `${size}px`;
        flake.style.left = `${Math.random() * 100}vw`;
        flake.style.animationDuration = `${d}s`;
        flake.style.animationDelay = `${-Math.random() * d}s`;
        layer.appendChild(flake);
      }
    }

    function applyWeatherFX(category) {
      clearWeatherFX();
      // Off still clears: the toggle has to be able to tear down effects
      // that are already drifting, not just skip spawning new ones.
      if (loadSettings().weatherFX === 'off') return;
      switch (category) {
        case 'cloudy': spawnClouds(6, { allowReverseDrift: false }); break;
        case 'fog':    spawnClouds(9, { top: [10, 55], width: [28, 50], opacity: [0.25, 0.45], duration: [220, 340], zIndex: INTERLEAVED_CLOUD_Z }); break;
        case 'rain':   spawnClouds(4, { opacity: [0.45, 0.75], duration: [35, 55] }); spawnRain(70); break;
        case 'storm':  spawnClouds(6, { opacity: [0.85, 1], width: [26, 46], duration: [50, 75], zIndex: INTERLEAVED_CLOUD_Z, images: STORM_CLOUD_IMAGES }); spawnRain(130, { duration: [0.3, 0.5] }); break;
        case 'snow':   spawnClouds(4, { opacity: [0.4, 0.7], duration: [75, 115] }); spawnSnow(60); break;
        // 'clear': nothing to spawn
      }
    }

    // Weather is only fetched every 30 min (see below), but the clock
    // needs to tick every minute - so the widget's text is rebuilt from
    // the current time plus whatever weather summary was last fetched,
    // rather than being fully set inside updateWeather() alone.
    let weatherSummary = '';
    // Remembered so a weather-effects toggle can re-apply without another
    // fetch, and so the temperature-unit toggle knows what to re-request.
    let lastWeatherCategory = 'clear';
    let lastCloudCover = null; // percent from the last fetch, null if unknown
    let lastCoords = null;

    function renderWeatherWidget() {
      const time = formatClock(new Date());
      const widget = document.getElementById('weather-widget');
      // The clock needs no network at all, but the weather behind it can
      // take a geolocation round trip (up to the 5s timeout below) plus the
      // Open-Meteo request. Showing the time straight away and letting the
      // summary append when it lands beats hiding the whole widget - which
      // is what an early return on empty weatherSummary used to do.
      widget.textContent = weatherSummary ? `${time} · ${weatherSummary}` : time;
      widget.classList.add('visible');
    }

    // Open-Meteo is this page's only slow dependency - roughly half a
    // second - and it used to be re-requested on every single new tab.
    // Cache the last reading, paint it immediately, and refresh in the
    // background once it has aged past the TTL.
    // Kept separate from the weather entry on purpose: this is written
    // the moment geolocation resolves, so a last known position survives
    // a weather fetch that failed or a machine that was offline.
    const LOCATION_CACHE_KEY = 'newtab-location';

    function readLocationCache() {
      try {
        const v = JSON.parse(localStorage.getItem(LOCATION_CACHE_KEY));
        return v && typeof v.lat === 'number' && typeof v.lng === 'number' ? v : null;
      } catch (err) {
        return null;
      }
    }

    function writeLocationCache(lat, lng) {
      try {
        localStorage.setItem(LOCATION_CACHE_KEY, JSON.stringify({ lat, lng }));
      } catch (err) {
        /* caching is an optimisation; never let it break the page */
      }
    }

    const WEATHER_CACHE_KEY = 'newtab-weather';
    const WEATHER_TTL_MS = 10 * 60 * 1000;

    function readWeatherCache() {
      // Same reasoning as loadSettings: storage can throw outright rather
      // than return null, and a missing cache is never fatal here.
      try {
        return JSON.parse(localStorage.getItem(WEATHER_CACHE_KEY));
      } catch (err) {
        return null;
      }
    }

    function writeWeatherCache(entry) {
      try {
        localStorage.setItem(WEATHER_CACHE_KEY, JSON.stringify(entry));
      } catch (err) {
        /* caching is an optimisation; never let it break the widget */
      }
    }

    function applyWeather(summary, category, cloudCover = null) {
      weatherSummary = summary;
      renderWeatherWidget();
      lastWeatherCategory = category;
      lastCloudCover = Number.isFinite(cloudCover) ? cloudCover : null;
      document.documentElement.style.setProperty('--weather-tint', WEATHER_TINTS[category]);
      applyWeatherFX(category);
      updateNightSky();
    }

    async function updateWeather(lat, lng) {
      // Open-Meteo converts server-side and returns a single unit, so a
      // unit change means re-requesting rather than converting locally.
      const celsius = loadSettings().tempUnit === 'celsius';
      // Coordinates are rounded into the key so metres of GPS jitter
      // between loads can't miss an otherwise usable cache entry.
      const cacheKey = `${lat.toFixed(2)},${lng.toFixed(2)},${celsius ? 'c' : 'f'}`;
      const cached = readWeatherCache();
      if (cached && cached.key === cacheKey) {
        // Paint a stale reading rather than nothing: a temperature a few
        // minutes old beats a widget that stays empty for half a second.
        applyWeather(cached.summary, cached.category, cached.cloudCover);
        if (Date.now() - cached.ts < WEATHER_TTL_MS) return;
      }
      try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
          `&current=temperature_2m,weather_code,is_day,cloud_cover` +
          `&temperature_unit=${celsius ? 'celsius' : 'fahrenheit'}&timezone=auto`;
        const res = await fetch(url);
        const { current } = await res.json();
        const info = WEATHER_CODES[current.weather_code] ||
          { label: 'Unknown', emojiDay: '🌡️', emojiNight: '🌡️', category: 'clear' };
        const emoji = current.is_day ? info.emojiDay : info.emojiNight;

        weatherSummary = `${emoji} ${Math.round(current.temperature_2m)}${celsius ? '°C' : '°F'} · ${info.label}`;
        applyWeather(weatherSummary, info.category, current.cloud_cover);
        writeWeatherCache({
          key: cacheKey,
          // Stored so the next load can seed a position before geolocation
          // answers - see startLocation.
          lat,
          lng,
          ts: Date.now(),
          summary: weatherSummary,
          category: info.category,
          cloudCover: current.cloud_cover,
        });
      } catch (err) {
        console.error('Weather fetch failed:', err);
      }
    }

    setInterval(renderWeatherWidget, 60000);

    let weatherRefreshId = null;

    function applyLocation(lat, lng) {
      lastCoords = { lat, lng };
      const { sunriseHour, sunsetHour } = getSunriseSunsetHours(new Date(), lat, lng);
      SKY_KEYFRAMES = buildSkyKeyframes(sunriseHour, sunsetHour);
      updateSky();

      updateWeather(lat, lng);
      // This can now be called again whenever the location setting changes,
      // so replace the previous refresh timer rather than stacking another
      // one on top of it every time.
      if (weatherRefreshId !== null) clearInterval(weatherRefreshId);
      weatherRefreshId = setInterval(() => updateWeather(lat, lng), 30 * 60000);
    }

    // Called from the settings block below (not here) because it reads
    // stored settings, and those constants are declared down there.
    function startLocation() {
      const saved = loadSettings();
      // A saved custom location skips geolocation altogether - no browser
      // permission prompt, and none of its timeout either.
      if (saved.location === 'custom' && typeof saved.locationLat === 'number') {
        applyLocation(saved.locationLat, saved.locationLng);
        return;
      }
      // Paint from the last known position before asking where we are.
      // getCurrentPosition takes seconds, and updateWeather is reachable
      // only through applyLocation - so without this the cached reading
      // can't even be looked up (its key is the coordinates) until
      // geolocation returns, and the widget shows the clock alone until
      // then. Geolocation still runs below and corrects sky and weather
      // if the position actually moved.
      // The dedicated location entry first; the coordinates embedded in a
      // weather entry are the fallback, for a cache written before that
      // key existed.
      const cachedWeather = readWeatherCache();
      const lastKnown = readLocationCache() ||
        (cachedWeather && typeof cachedWeather.lat === 'number' ? cachedWeather : null);
      const seeded = Boolean(lastKnown);
      if (seeded) applyLocation(lastKnown.lat, lastKnown.lng);

      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            // Persist before applying: this is the only moment a genuinely
            // measured position is known.
            writeLocationCache(pos.coords.latitude, pos.coords.longitude);
            applyLocation(pos.coords.latitude, pos.coords.longitude);
          },
          // Only fall back to the hardcoded default if nothing was seeded:
          // a real last-known position beats a constant on the other side
          // of a failed lookup.
          () => { if (!seeded) applyLocation(CLEMSON_SC.lat, CLEMSON_SC.lng); },
          { timeout: 5000 }
        );
      } else if (!seeded) {
        applyLocation(CLEMSON_SC.lat, CLEMSON_SC.lng);
      }
    }

    function hexToRgb(hex) {
      const n = parseInt(hex.slice(1), 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }

    function lerpColor(hexA, hexB, t) {
      const a = hexToRgb(hexA);
      const b = hexToRgb(hexB);
      const mixed = a.map((c, i) => Math.round(c + (b[i] - c) * t));
      return `rgb(${mixed.join(',')})`;
    }

    // No override by default (real clock time is used); applyTime(hour)
    // below lets you pin the sky to a specific hour for testing, the same
    // way applyWeatherFX(category) previews a weather condition.
    let timeOverrideHour = null;
    // applyDate(new Date(2026, 11, 14, 23)) pins a whole date - a winter
    // sky, a meteor shower peak - and sets the hour override to match so
    // the colors agree. applyDate(null) and clearTimeOverride() both
    // return to the real clock.
    let dateOverride = null;

    function applyTime(hour) {
      timeOverrideHour = hour;
      updateSky();
    }

    function applyDate(date) {
      dateOverride = date;
      timeOverrideHour = date ? date.getHours() + date.getMinutes() / 60 : null;
      updateSky();
    }

    function clearTimeOverride() {
      dateOverride = null;
      timeOverrideHour = null;
      updateSky();
    }

    // Demo mode: sweeps applyTime() through a full 24h cycle so you can
    // watch the whole sky progression without waiting in real time.
    // startTimeDemo({ cycleDurationSeconds: 20, loop: true }) is the
    // default; call stopTimeDemo() to end it and return to the real clock.
    let demoIntervalId = null;

    function startTimeDemo({ cycleDurationSeconds = 20, loop = true } = {}) {
      stopTimeDemo(); // clear any demo already running
      document.querySelector('.scene').classList.add('demo-fast-sky');

      const tickMs = 100;
      const hourStep = 24 / ((cycleDurationSeconds * 1000) / tickMs);
      let hour = 0;

      demoIntervalId = setInterval(() => {
        applyTime(hour);
        hour += hourStep;
        if (hour >= 24) {
          if (loop) hour -= 24;
          else stopTimeDemo();
        }
      }, tickMs);
    }

    function stopTimeDemo() {
      if (demoIntervalId !== null) {
        clearInterval(demoIntervalId);
        demoIntervalId = null;
      }
      document.querySelector('.scene').classList.remove('demo-fast-sky');
      clearTimeOverride();
    }

    function updateSky() {
      const now = new Date();
      const hour = timeOverrideHour ?? (now.getHours() + now.getMinutes() / 60);

      let prev = SKY_KEYFRAMES[0];
      let next = SKY_KEYFRAMES[SKY_KEYFRAMES.length - 1];
      for (let i = 0; i < SKY_KEYFRAMES.length - 1; i++) {
        if (hour >= SKY_KEYFRAMES[i].hour && hour <= SKY_KEYFRAMES[i + 1].hour) {
          prev = SKY_KEYFRAMES[i];
          next = SKY_KEYFRAMES[i + 1];
          break;
        }
      }

      const span = next.hour - prev.hour;
      const t = span === 0 ? 0 : (hour - prev.hour) / span;
      const root = document.documentElement.style;
      root.setProperty('--sky-zenith', lerpColor(prev.zenith, next.zenith, t));
      root.setProperty('--sky-horizon', lerpColor(prev.horizon, next.horizon, t));

      currentNight = prev.night + (next.night - prev.night) * t;
      currentHour = hour;
      updateNightSky();
    }

    // updateSky() itself is first called from the settings block below,
    // next to startLocation(): the night sky it drives reads the stored
    // settings, and those constants are declared down there.

    // ---- Night sky ------------------------------------------------------
    // The real sky over the user's location: the Yale Bright Star
    // Catalogue to magnitude 5 (inlined below, ~1600 stars), the moon at
    // its true position with its true phase, and the occasional shooting
    // star. Everything is gated on the `night` value updateSky()
    // interpolates from the sky keyframes and then scaled by the weather.
    // The DOM is created lazily the first time the sky is dark enough to
    // show it, so a daytime tab never builds any of it; once built it is
    // kept and merely paused through the day so dusk and dawn fade rather
    // than pop.
    //
    // The view faces south, the way the moon and planets ride across the
    // sky from the northern hemisphere: due east is the left edge of the
    // window, due west the right, and the celestial horizon runs along the
    // ridge of the skyline layer. The projection is stereographic centred
    // on the south horizon point - conformal, so constellations keep their
    // shapes wherever they sit on screen, and its horizon is a straight
    // line, which is what lets it lie on the ridge. Catalog positions are
    // J2000; the quarter degree of precession since is a couple of pixels.
    let currentNight = 0; // 0 = full day, 1 = full night, set by updateSky()
    let currentHour = 12; // the hour updateSky() last painted, override included

    // How much of the night sky shows through each weather category. The
    // cloud art baked into layer2 means "cloudy" still leaves gaps.
    const NIGHT_SKY_WEATHER = { clear: 1, cloudy: 0.35, fog: 0, rain: 0, snow: 0, storm: 0 };
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    let starField = null;
    let moonEl = null;
    let starData = [];  // decoded catalog, brightest first
    let starEls = [];   // one element per catalog entry, same order
    let constellationData = []; // decoded figures, each with its name and label point
    let constellationPaths = []; // one <path> per figure, same order
    let constellationLabels = []; // one <text> per figure, same order
    let linesSvg = null;
    let planetEls = []; // one per PLANETS entry
    const SVG_NS = 'http://www.w3.org/2000/svg';
    let shootingStarTimer = null;
    let shootingStarsSeen = 0;

    // STAR_CATALOG_BEGIN - generated by scripts/firefox-newtab-stars, do not edit by hand.
    // Yale Bright Star Catalogue (BSC5) to V magnitude 5: 1630 stars,
    // brightest first, 128 of them with IAU proper names.
    const STAR_CATALOG = '7td5nk0ba7en2vm0qcgi88fa13mgyu29014hljn9xq15a63xahs16i62f6b816a8uz7ci1ce1vv2j01d86un7il1esga02ab1g8myy7mn1jc5bm87v1lpj334wl1nsfj66301o88z593v1rkqkp4nq1rbet52c71t8ny4afs1tbeeh22q1v8gyu2901vjbqh7v91v982q4pj1y8ehn2jd21qkbo42y21869s7fn2186al95h219ao61kc22a6hh6uo228eeh22q237pme3bk239exjb9g23a9fy3ai2483xwasi24fcsxbpj24l89i4wp25hlas4ai25a9oz2cp25nfyoaqz258ke93mk25e6xoaev26ajgh1m926o7o787k27ann52ke278a4e2q127a7ds5k42888rp9el28aay669y28o2gb8r628miic8y028b2xfdty28glwe4wy2880ua5k129k6kn6sm29805u96t2991cf9oy29q6pi675298gbz44z29kh6kco02apkcl7ww2acqab3bs2aq3moa3s2aadoe82h2bbeou3602banksa1u2chakk3ld2cr0s5bb22dm6ek6x62d8i139072dakrnax12dp9bu3uw2d7aqv2dc2dc2e2a7l2do06dbib2ddfiab6l2dajhi4ar2emftd2th2e8h0g3ad2e8gw03ow2e8iiw5762e9crmbam2fa0i93oh2glp5p7pg2gpkhu3xl2g8qoy9402grjvj5qc2hbdrqb352haonxbrv2hc8ke4om2h9o1f9kd2hk13ebmo2h8qpn8492iaaud2p72i83il79d2jqg483an2j8d058j02jbj8h64n2ja6f25ki2kce6z5la2k9e1t3142k9m1h4n02kbbyj8h42kmhot67y2k96xt9td2k9img5ez2k927m8jt2lb6jv4bd2l9ejw5502lji7r7fv2lm1nlblc2mbg3n8d42mghbz3m72m85q99i52mpch534q2mjelu1ly2m8k9p42e2m88fl42y2mqh2l9172mkl8l4n52momvs7rh2mpisn6nr2nqizcbov2njffz4412nah6o5pg2nccei1z52n86gy6hl2n8j3o8lp2njkij7ap2nmi1f3rn2o85xs6jv2obk9haza2ok0hw0zf2oge6j2et2o89el52i2oejbc9ds2ogldf4ze2okj7l4rm2o80978462p8f367sg2pj6by5cc2pi4il9ek2pbifb21t2pdk5w2nr2pp2ah26z2pdptj2am2po4dz8sy2p9muwafd2pap7o5p72pd7dy8oj2qq8rp9el2qa4l6a152q8hq51n82qaihv4xh2q8ixe4yx2qbm6g5bm2qe8mj7l12q9eyx9wg2q9owx6ij2qi3kcb2n2rh7wo31f2rmqaj99y2rj4lb5wh2rqegr5o42rakag33g2r8pkp6x42rk7si8vt2sobau8s12si5tpabq2sfky14li2skm3f80i2sa2hz9n72sb6ih8kq2s8e315762snfet55n2sj4atamr2s9bbq1x92sdcx2adm2slpcg4282s97c44mi2s885s53t2s9gtm9wf2tckle3uj2tf2os6pq2tog043o12t8c06a5a2tqes51ot2t8hrechj2tam8ec5y2tkjip40b2u8ml093o2ulnjx5sy2uiabt7ej2ukcj55p12uml6943w2uqnvf3an2uk6rq46n2umatm9lj2vqb0p2jl2vqdf622y2vahcf3p22v8jnd2mh2vqaegang2vcjys8v02vbjys9s92vo5wva4j2v87o83m02v9b1taxk2vfjugc0j2v9lpp4v12v95la7hc2we5w557v2wph0v1xi2wcjmq7o22wmojz99z2wkkmy4342wmrdocxn2wkhru3t32w8nd76vq2x9ouwce02x83ft3u22xb4dt17s2xqive6kz2xklyy9gt2xa8nz3lq2xpl8t6py2xj0rb9bq2xn5aa2p42x97vh25y2xcgbr4vw2xlk3m50k2x8qim5q22xa78c8oj2yqhfu4zs2yrhubbht2ym19w3c82yj61b5oz2y9e6qbcf2ybbu71jg2y9c6x26n2y9m4i4t52ymjws3lw2ze91w50y2zmd0884v2zak5z2le2z9ktc66v2zk4wp24h2zjpo7bfo2zq69c6rc2z87tg7xu2ze9udbmo2zimhd76n2zdfpr6wc2zbhsr3hv2z827gbuv308a5t7fu30heym77g30q3kl9xw30q56l86330cbwj27n30pq9h7s33091pd3lo30q26j98630fg023q7308hlj2xa30jiir3zc308kkl93030io0k1u430co0sbps31j0y4bem31gamm2e7318bw98r231dm406kg3191bn65q31mbwja9731alss9io31a35f77031b4n57wp31984v4sf31r9732uu318hns9ij31kn4h8g531qd369hx32ojyi81z32oqfe8uc32jqee2zg32b20a5pq32hheda2732klcq3eb328ly35bd32m9kt7nj32pb7l7ph32fbpr88k32aqf6c1w32k56j8fa33k8hn8n233dibg6oh33ajcg9y433jpnr7f833b4b166w33j6gq7pl338bii2qf339dd94hi33jkeg5r833d6oy5su33bgkt3e23380di69i33m2mt2yx3394z34c4339d3s5sy33lhs545a33pnbe1u633i1w2ap333n8yj8ts33jjj040e338l8mck133fnhv5z633j8g887y34bgtg9ad34ni2q4ru34oeau2a834o1md6ba34l3y87n334j64k6f03496n857n34f7yo9kc34bahjal034ab0c3tl34e8z340j34rbs15zp34kdpj72w34g1rj84n34ka1b2v0348f391f934mjkl3oc34ok9x29g349kk31y834mqnoa7l3493a291q3594f58st359nvf82k35edm01sn35c50f85f35keoy6tz35egaebwu35ao7e2fn35m0pob3q358i3u4na358kym32v359qsw5b735mb0wbt635di9384u35ba3m4dt368eoy6tz36ghwc96v36dp2u5nq36d3uk59k36q5m87dk368baf24d36mqy977436j28j2yn36i4c68sz369ksg97936j6vi5un36ddmbamq36mica7ag36cn237ft36j5oc74s3686xob4s36kh3g73936aoefac136qola9vp36e25e65a37l43v67q37j93x3ta37kkz47ok37b3zv7p1379otj57r37kqh76cy37q5u2a4437mahw3b637mixw8f737dkll75j37akpibbz37mq0xbga37g3ajb9a37r52l8aq37k6fp24f37ijh92e037qp3t0z137kplj8we37e4cea8a37e9r71ua37lm2x59m37kmbkb2937knwv867379o2g67m37aq2eato37a89r1i638kclt2ej38k86j8j538i8lj93838kmkbaxp38bnetaju38n3nlaem38kbefbi038dbyj8h438gi167ra38di167ra38dkfraht3886j96qs3886rz5c038kc2s5n838p5bd4l438kas39s838bc412eu38dj4573i38amwl8dh38orcfaj238k4bs9fp39aclp9l239kg653p2398h4k0ug39okz995w39amx4cd739j56i86c39ka1k3cf39habk29k399cal38139ddc5cal39qi6p8z239alag8mh39mpvp6u539a4bp1xz39l6p630539c7dd4d439j8dy4vn398buw3p039ac7g7nv399ig785i39fite21339llig6b439n4we3oj39lem737639akre9th39ol3k5bi39c13f9wy39b3pe4ph39f4cu8tp3995d65ua39l6e047h39l7zl52u39reik1dn398ej9cbv399g6f3hk398hla36m39a06j3ex3akaoz74f3a9bfn8y93amfn83wj3amh186ia3aeigi4ov3a83ej69a3ald4x2qn3a8e9u6w53aaiweain3a8j5w0uu3ajn2s9ng3ak9r56n53aan0470t3ajqtj3gb3ak4ov7en3aaa5b3e43aab6o6uu3ancwb2e63amefh32h3a8i1o5sx3ak1bi2oj3a9joj9bx3aaom07cl3af5bw6op3b88wb67h3bkmeq5kf3bc0i73ko3bca4d8cf3bld6y7r93beo91a4d3ba1rd35p3bk3d0b0k3bh7nh5gi3bl8wq1cb3bkfiab6k3bbice4cl3baqcz8rh3bl53d4bi3bp6xf3n23bl7wm4fp3b88y34pl3bce432wj3b8ine5cl3ban5r1bh3ba6s39yr3bla1747x3bjafga623beamu24w3b8kug7653bamg93t63b9q103l63bkr2a5e63bl2dqcj63ca78b6gl3cn8fd1p83cing3amj3cpqyg2g83ce2bc5bg3cq3cr33f3cvagp1tk3cbc1m18d3ceh0h4113c82nd9k13caa8f4t13cnfj7b6r3ccijzbgp3cfir05fy3calnw1fl3clmfe3ii3c9npr9ad3ceqf45w93cqrrj7h23ce5ia6oz3c8a5r95w3cke1u51b3cdiwg32o3cllzf83v3clm0u6i23cloymagn3cjq586xo3c95upblw3djdm67g53dpexx2j63d8kxs74y3djnse7te3d94ly9pf3da4spamj3da4ux6f03dde8t2083d8lwfac33dq3nbart3dgd507er3d9glm40r3dagouay13dfgxn34p3d8h1n48b3dohj53g83d80wv8tf3dl8sm90q3dpjo22uc3do200aut3da32r6yx3d85pt7zj3dm7zn60k3do9m710c3dea463nj3djg0185w3dphp62eo3dbof55m53dab2x2dh3eacq65j63eld7m5kw3ecgig6hc3efoqc8h03elp58bha3ey1v8a513ef2qg1na3ea3io54e3ec6hz7nt3ekiav8ce3eq33l3va3ek32u1od3e942g7xy3el91v3d73e8c9b0vn3eqdmn2823eje871p83eqi2i1ts3emm6940q3eam6n3wq3emo5c4v83eqq1c3kh3eq361aqr3ef6zo7ot3ec86a5ql3e9ber5sr3ejdzm7m93ekqmy2vh3ekle135p3fkn223pp3flp608x83feprr9uv3fpre37dn3ff4x0aoh3fk68z6cb3fk9zh3ml3fbhzv9d43f9o1c4zt3fereead53f97i48i53f98bx6wn3fae0s1yj3fdiee5nj3fkih090o3fmqcn0ny3fc0mxbst3fb70v8qm3fi9zh7du3faj7x4823fqpsd6ce3fk4fc45g3fkk6n52u3fdq8w4uw3f94d68sj3g98nw9ea3gdgiqai13gbg004ab3gpgga65h3gnlpq8j33gfpr4bcg3gdqd37vt3gf6dq7ej3g997556g3ghj6da7w3ga417bki3ge6kn6sm3ggc419rz3gjqjj4fm3gkqxd68r3gl54a8nx3gbl8fcg63g9lqr6kt3gllu92593g9npwbsz3gco129bc3gkotd1wf3gfqwa6h73gq0dy1xt3hg3ah9wg3hd46canv3h94dj55f3hefxe4e83hein943s3h8j4h49m3h8jeld9w3hjmys9hf3hson39zf3hbp7iaqz3h994p38e3h9jcl0yo3hlnhl5z93hl1brdlm3hm1caal83h92u339i3h935z5vi3h94xt2yz3hd5c5a4m3hm5bf7q83hc9p7a9z3hqady7uy3hbc3j4jp3hogqgcsa3ho2177ng3hk6xyahm3hre8r0tp3h9ejga4w3hgf9x93g3hgg8h72a3hbioraeu3h9kh35y83hb36k7q33hd3uu3md3hh44h59x3h95d67wr3hb5yp69p3h89fx3ah3h8ex43ue3hcf6h33d3h8hpv3903h9o1q86s3hkpl55vh3h917q7jx3ik2uw7li3i946m6z43ig54y8pd3id5g08ps3i98xr9683ilcbz2nk3ikdr34bt3i9j4a5nv3ijoqg5n93ijqr43l43ier5r7fq3il4r9atv3ia4xg7mp3i954d8bt3ia5o7c2a3ia65x5xe3i7b4rd7x3ipk7c4n13iekdq3yo3ilmfs3hk3idp6kbns3ifpjbbxj3idpnm9i63ifq2k4g53iarctaa73i94ce8tz3i9a3d77g3i8dg06vq3iklvv9si3irnenbb53ib14p4og3i8b118pt3ipeia5p03iehu09tu3id5er5fd3iq8n87mt3ioa5j5wd3ijdou20t3i8gq10hl3inh773ky3i8i7lcy33iaint5c13iinvy6ux3ik1deb773jc2cr75o3ja7k454y3j8a1j2c03j9dy42253jdeww3623joglg2ld3jbi3f3nr3jok2t5yb3jal7t9q63jm9fb6pq3jkaq92i63jqg8j3fc3jghpe4m93jlk6r79i3jpp684e93jap5x8a73jm3ft3u23jb3p38gt3jk6nf1ve3jc78o97y3jk81sbga3ji9eu1ne3j99no0ys3jmb4l34w3jcgpi3fy3jekzy2153jc0pm9jo3j90u42ie3ja428anc3jo4px8nc3jl5lt7mq3ja61j5y23j96wa4803j8a6z7e83jaeep94j3jlgbj3rm3j8l038jt3j8kapdmj3jala52773jplp39ug3jclqo8ci3jbmb19vx3jnmp66uf3j9q16amj3jr0lx2343j90qs97f3jj2kd7ml3jj79i48e3jk80z5mn3j9bq67ps3jomri8c13jims68ak3jkn554803j8r9840y3j96ep8dn3kvf8l6im3kajk67q93k95ne6iv3kc7ma2uu3ka9ax74h3kmcqg3op3kbk2x5bd3kem989yr3k8nbicxv3kaoot2tj3kcqys68i3k8r4f5co3kp7wm2t23kj8go50p3k89fm5gk3k8hf073t3kkpf82p93kdr3y8r03kg26x3de3kq6gi7od3k86u48ic3kg8bf9a13kn9843583k8d2z9dl3kgh694sc3kok9o8yj3koksz99v3keqrtcrf3kiqzf4fn3kl01d6hb3kq13q8r23kj4d260e3kq7398313k8cry8i23kagnc3w93k8gtz31u3k8j1g5iq3kdo2h6k13kqq0p6xy3ke0xt7j23lp4xa6cr3li7ob5jc3lmgzx8053lai997if3lgnlx9ff3lnnzi83v3ldong9my3l9px1az33lk0a65hf3lr1yg7d93lo4y42da3ll7ei7ar3lc9j33tx3lma0977a3lmlxk1r93lhmjm8ui3lp5eu3pq3ld60v6113l98rb5823lf9h83vy3lq9m84463lcaf23rf3lgc9e2i43lqcgg0qa3l8j4z5ad3lbkv871n3lamahcls3lmmnc7ii3lm39f4fz3lk61k75y3lmaw48yq3lmdpv3gj3lngvf98m3lepkx3w63loq8tad03lnqh54eo3la36o5if3lf3v496p3lq4fec013lt5qgb3b3la5rc72r3lo7v874p3lld1x6nv3lce1m31a3l8j1k39w3l9qqz5423lj76a81h3m87bnbhx3ma7hk4fi3m8al6axc3mdail1cc3mgbpu9nw3mccyf56l3mamozati3mepzn1xj3ma54z85e3mc7sk7yr3mm8ce3c43md9483y23m8a5s2kb3m8bq66wz3mahb26lx3mdol27pt3mfpqba0c3morg05tm3ma7kv7id3ma8un4vk3m89124xy3mab37ayl3mabz72mc3m9cna8ur3mafyi8ai3mfizf5ec3mkofy50j3mqpmi4ed3marfj72y3mcrry1vu3m91ds99l3ml38m9793ml4na25c3mq59y4nb3mk6qy2lz3mlazb4653moht82d83mcn7ac6j3mnnzx2xs3mdo0ubdy3mfoho62f3mjouy59f3mjq1ua9s3m90cq9s73ma2vjc583mb6qh9yu3mjb6c27n3m9gkm5wv3mbi5v8gn3mak4s9t73man384uj3mpnga9393mnqr77o53mqqv2ar93md0yla443n83b49ne3nq6y16ph3nm8tm48v3n9dno8i63ngfhe28l3n9fic1yq3nil1t3ed3nko299rd3n9qp178m3n90lx2333nc0v2ao43n92cpcez3nc41sbhk3ng64y9ip3nn7mc5683na8od7vd3nnggpaxv3nchg390v3nmhli5f13n9ht343m3n8i1x3h43n8k6u6jv3nekld4sp3niro4bdq3nm5ve47g3nm83qcvu3nob2s9r43njh718f23niix052v3nioflamd3nqr6l7xg3nj02m5lu3na4lt27g3nqajj9wt3nkb2ycbz3nig1o4ed3n9gph3ge3n8p44cg33nl6jk79g3n9b186uq3nbbya2p53nqcew29r3nrj0b80z3nakzm4qy3njovt8ro3nqpvaaja3n9pxparg3nbrkb4rv3na46r3u53ok6td92p3oaakl4y63oqbew3cp3omkhgcif3oen0t8sw3o9n764t13oq0sp3e03ok4ar42d3om6az76m3o86gx6kk3o88xw4r33oqbf7b463oaie84zn3o9ir84sf3o8kd33ct3oalw18ow3oim5h3ti3olme1c0j3oao5j91a3oiq0p6xy3og7i06eh3o9a19bwp3omaz96qb3ofbo85xq3o9co242u3okcz32ag3ogfa72bk3o9h2r8943okhbcc153oqhul3yf3oamp650w3o9r0o8ry3oc03p6i53ok0bv9xg3ob4zcatq3oa9995iw3obcuw24m3okmer5po3obnsw9nx3oq26v76v3oj6ei6dq3o78un4vk3oga3o6dx3oiapy4233oedeh2ra3o9exy2dp3o8i0q6623okidla7x3ogkem6bg3obkuc6nr3oelx279o3oc13dbie3pk3gg8la3pa3gg8la3pa3oua013pl4fzcg53pa70q8hy3pd94j3473p8ctt7ie3pdd0w8q63pribg8yf3piil42hi3pcj1z6ar3pcq6max73pc5uh8lz3pc8f74sk3pq8m8aqp3pa8s84r73p9enp3ux3p9i5m3hy3peice4yh3paku77a53pakz37m93pklfs2503p9lha3oh3pkn649333pc1f88ua3pk4ib51n3p95a68383pc5os7q73pb6tx22r3pk7zy7ym3pd8p04k03pjes72l33p8fy22z53pkg1ebxs3pqikw3593pjjha6423pfk0m9tl3pal6j4uw3prqp9at13pl1dm8kf3pk35i92z3p94mm53a3p97qg7pi3p88dk4wt3p88ge43z3p9a3e8ln3pac3p2hw3pfcbl2dm3ppdwm7gd3pben96bs3pmepl36f3plftyb5w3pqltkbiz3pmmi36yy3pgpy871u3parqg8vu3pq24464b3pd41earj3p972a5si3paamlbuf3pei4m4af3pkku188j3pnobw4ge3pjp48aw73p95vi84s3q980n5e23qe9a76u53qpb5p7ax3qniwt0ve3qrlaf6973qkmm5cbi3qintv82r3qbp0r5fx3q827t1q33qk2eg4om3q855582v3qk5dy8683qcacg2vk3q9av44px3qjaxz57y3qlerp28m3qkfnv6gm3qqkxi4nu3qimr099r3qkoi77q53qdp186c73qcpj02k93qlpiz6s03q9qay5hp3qoqt857m3qg3g5a063qb3gt7mr3q98u94zk3q9bkt7kc3qqdft66s3q9di949i3q9fplaq63qblea5tj3qbn2g4wy3qi1t8bij3qk2t5ato3qp4x0a2g3qk65na1e3qg66j5b03qa6cz6uz3qq9183b83qlaix1i23q8cbk9eu3qicm5a9z3qaf6137e3q9g5p2133qln1c7li3qkong4gn3qbqigdgb3qor9g5bx3qarap3nm3qb41e2363qe5w62id3qf9h65y33qkatx4xv3qqdnu1sf3qpdz022j3q9hgk3bb3q9in63gj3qclnd68v3qe0m2b5g3r94296jw3r94er41i3ra67g6wy3r8dlf5j13rkfdva2p3rdg2m4hb3r9jk63oc3rfjzv6wr3rlo5w6923rdp1cbqg3rdp4m5hl3rjp5o95u3rf1noc793rk5n581l3rs6rs9tn3rqc2o9jw3rcc5q1e13racrm6r43rqeae8bf3rkfeg5j53rhg1n9lo3rri655fc3rqmlq9lp3r9oawam03raqdndcz3rnrcm3fn3rb26u8fl3ra2xm5ro3re32z3mv3rb3as5bo3rj3ae15h3rn9ha3ml3rcc7ra2b3rcge82tk3rjgikawp3rci6n49l3r9m1u3p23raqzac773ri0up64j3rk1j791q3ra3kubbj3rk6f29ff3rd8du37x3r99fl27q3reagsc5v3rpfkq5pn3rlhfnamd3rgicm8ka3rpikmahw3r9iow9rd3rkktv53u3ranjp5yk3ranu229q3rdqra8wr3rn0lt36g3ra10t6uu3rq7uv7kc3roa1y3ak3rbb7o54h3r9dbe6po3rpglq3gh3rdgnd4sx3rnilp62f3rfkge34q3relgmbch3rgmax8lf3ran7t40m3ro57w86z3sc5n89ry3so6go6hc3s86sr7363so9ip46a3s9d3m9w33sbf0x8ad3sqivd4qj3sak3m1pr3smnfy8x33s8npd5kj3seo6badb3s90140zx3sn29w8rk3sd4ip6pt3sj5sa5z63sd7pba813sm8f75583sr97q4lr3scasq60r3sjb9p4sv3sfbyd8g33seexr67i3sqj3n5083s9lpk1xt3scpnhciy3sjpri3r53siq007b23skq9o97f3sa0a58i53sq0t8aub3s93s069i3sc4czbty3si53e8ag3sc6jc6dz3sb7b3cak3saam8c4h3sfat867g3sjecpax83sjf6n92q3spfc91pf3s9fdw7d73srke0c903serqwawr3ss0je4eb3sq5tc6e33s87552pb3s8atk24o3sjb3da023skebn8xt3sfek78ov3sagju9on3slgqx6rt3shh1i8zp3srheh8vh3spka553g3sakn73un3sdlbm5cy3snnhp9vn3sepvh94p3saq3l25u3sq10vbns3sf2h89v63sb3u09l23sp5z385c3sd6wm8y33s97pa5up3sp99k21f3s89oz37b3s8car5wu3szce01yx3s9cfb20c3s9eef2z33s9fro9qt3scgdhcxf3sohgk3bb3sghlx3ie3s8icl9p23skiy070v3sdjgvahq3sbjp26ma3spk0d9hy3s8lc2c043smlvscg23smnw38kw3saopf3sn3saq1y64c3s9rfc5ki3si127bht3tm1ovag53te26u8fm3tg29d3ae3tj2kjacv3tp3ug77d3th64h4923tk61w1rd3tn7z75du3t889t3vu3t89o74e73toaq9b423tcc063qb3tld7f63u3tqgek8vp3tfgzx8053tgik98pc3tbjb3bxf3tmkmh4hy3talq09023tmlvm56u3tolxn6hr3tln4m4x83tjnekak23tb1qn7f23to2e2a7l3ta32t6113te36z1q63tb3uwc0d3t84wc7nq3ti8v23zl3t89f7ax33tac5yb9i3tfc91csb3tkcqq7823tmj5b7tx3tpo3bai33teoe25eu3tcpkm7c23to29157f3to51naj63ta8oe5623tcch71z63t8dls7ky3tcf4534f3tafa14103thiy09bt3tkje4bbq3temag4zu3tgqav3qz3tkqcd2te3tmqqxbj23taqyoaq63tr1gm1mo3tf3097dj3tj61o9ww3tc6l087x3t96qd8u93tk9xv2gv3tka2t2uh3t8bqv2y33t9eef22o3t9gl287b3tmh097ko3tkhp921b3tmkrs3iu3tml8i77e3tjmvv5f43tjrr36o43tj2n69l23tg3pacon3ta4wo65i3tm6t84c43t87u4bj43tbd2z9dl3tgfdm1si3tpjrp4b83tdkarb793tdkii59s3tflos4703t8lym2uy3talys42x3terj0bgx3tl1l6agh3ul3tr57h3uj5lc9u53uo6bj8my3u88zp8df3uoa2b5pq3ulbgn4xz3umep37qg3ubihf5uc3u9kaob7a3udksh3q43uqnvg2733ueq7y9yh3u8rrbb8w3u907u5r13uf0xxavl3u92td5zv3ua3rd8kg3ua8cv3gi3uaa0x4nw3ujabw4t43ubc6g2ss3ufcaj4tv3uqil13ys3u9jllbyx3ufmuf9tr3uknuu6qx3uqo3p3dl3up1ng5tg3um2yu4rl3ua7bw6pu3uq820af93ua8br9z83uo8uv9m23uedqc1wv3u9ex08l03ujf1v9bi3umj9lapx3uqlo86b03ulmo438e3ulo414c63ukoz59x13ulqj17mi3ua34oa1n3ug58t6xw3un5tc5eb3ua6lu7233um6qr7x53u97faaqx3uucbh5n43ujdmn3ti3uhdvr0wq3u9ev74bk3uag078l23uogev5oq3urgk00oz3uchn64ig3uej2g1jc3ugjs27xe3ubnpx6pz3umo0i8w73umpecbur3usr77bgn3u98as6m83ukacw2dh3u8fbk2du3uffb7a1j3ulgn12fm3ujh2l4893uahdo6ac3uaimg5f03ualuzauv3ujn2bazo3ubo249lh3unpnq4fl3uf3gd9nq3vm4u73pd3vd50u9m13vj71h5o83vc7ou3823vj86d34a3vb9956ns3vma7x3g53vac681am3vrep52c73vaf26bal3vehi38v33velzo9fb3vpm444323vfnbw9sc3v9rgw97k3vk0u7akm3vc1xua2q3v92jx9a63vi4yo8j63vd5rt9v93va65q8ne3vj8sg2w33vo8vq5rm3vq9bs9373vlapu3yv3vlb8c53k3vfbh45h73vqcu14u73vediq25j3vmek4cci3vnevw92i3vhfpd7863vagzm87m3vah3a4zc3veh6r6rm3vkhtt65c3veis12q93vkir06623vbj6c3jn3van2h9wx3v9nah2v43vqqgtaab3vqr5171i3va03564t3vq1ypa8d3vg3vwaad3va50t91z3vm69j7353v86kp6uv3v86za64k3v976d86t3v981336o3vrd9q75y3vke7d8sj3vkeec91r3vdegxca83vqf7y55s3vkih5b633vdiuucsg3vel838n03vqmpa6eh3vamz58ot3v9nf98483vbnq7apz3v9qjvas53vsribaiy3vl1g83fj3vg8p9dax3vr8j45h63vaea57773vmi4z53u3vnhytcwv3vqjbj5kq3vlkv28m03vblg23eg3v9mbx5hd3vkn2ibhh3vq4af9kc3va4nl28c3vo56f87g3vl6uv42w3vl8r55to3vo94t90d3vbaj57c53vmb177te3vkc1fc053v9dp11ix3vofmb55c3vqg0b5jn3vlgqw4o33v9l2a9d93vqmgf98a3v9nff9s93vb1jmbfr3wh1x0adb3wj2hw8y23wd40haqa3w97agbow3ws8gn51s3w8a155zc3woflf80a3whfpu9ta3wejqi8153wql255463wklambhc3wblx279o3wcqzi67b3war3lbr03wrr9x9d13wo1zc6nr3wo28kc8t3w93g62013wb69g9tv3wo69b8aa3wf6ufb8r3wa7xc4aj3wo85p6m83w88lh7ns3wk8xjbh33wb9il5q53wl9ts3hs3w8c0m1s63w9cqv7ey3wcd67aas3wkercag83wziic3q23wkijo98x3w9iuh32x3wilwa5713wnm444323wfm9cbeb3wmmvx9jp3wfn8c4gy3wmpmj4bg3wp4ac4ha3w84kobnr3wo5wzaxc3wd5xi8ds3wg68777u3w880z5v03wm8cy86w3wramp3hd3wcb4u7h03wkcelc9w3wod6g45k3wpe7h9hu3wle972ou3wqeer90j3wbhsd38v3wfil04y53wmioa89d3wkj24c913w9k2g8c63wqkz7aaq3wjmnp8gx3w9mxo8f63wbontac33waqmebc73wordz5ui3wcrqc1ze3wb';
    const STAR_NAMES = {0: 'Sirius', 1: 'Canopus', 2: 'Arcturus', 3: 'Rigil Kentaurus', 4: 'Vega', 5: 'Capella', 6: 'Rigel', 7: 'Procyon', 8: 'Achernar', 9: 'Betelgeuse', 10: 'Hadar', 11: 'Altair', 12: 'Aldebaran', 13: 'Antares', 14: 'Spica', 15: 'Pollux', 16: 'Fomalhaut', 17: 'Mimosa', 18: 'Deneb', 19: 'Acrux', 21: 'Regulus', 22: 'Adhara', 23: 'Gacrux', 24: 'Shaula', 25: 'Bellatrix', 26: 'Elnath', 27: 'Miaplacidus', 28: 'Alnilam', 30: 'Alnair', 31: 'Alioth', 33: 'Mirfak', 34: 'Dubhe', 35: 'Wezen', 36: 'Kaus Australis', 37: 'Avior', 38: 'Alkaid', 39: 'Sargas', 40: 'Menkalinan', 41: 'Atria', 42: 'Alhena', 43: 'Peacock', 45: 'Mirzam', 46: 'Castor', 47: 'Alphard', 48: 'Hamal', 50: 'Polaris', 51: 'Nunki', 52: 'Diphda', 53: 'Alnitak', 54: 'Alpheratz', 55: 'Mirach', 56: 'Saiph', 58: 'Kochab', 59: 'Rasalhague', 61: 'Algol', 62: 'Denebola', 64: 'Sadr', 66: 'Schedar', 67: 'Mintaka', 68: 'Alphecca', 69: 'Eltanin', 70: 'Naos', 71: 'Aspidiske', 72: 'Almach', 73: 'Caph', 74: 'Mizar', 79: 'Dschubba', 80: 'Merak', 81: 'Ankaa', 82: 'Enif', 84: 'Scheat', 85: 'Sabik', 86: 'Phecda', 87: 'Alderamin', 89: 'Aljanah', 91: 'Markab', 93: 'Menkar', 95: 'Zosma', 97: 'Arneb', 98: 'Gienah', 100: 'Ascella', 101: 'Algieba', 102: 'Zubeneschamali', 104: 'Acrab', 105: 'Sheratan', 106: 'Phact', 107: 'Kraz', 108: 'Unukalhai', 109: 'Ruchbah', 110: 'Muphrid', 117: 'Izar', 118: 'Kaus Media', 119: 'Tarazed', 120: 'Yed Prior', 123: 'Zubenelgenubi', 126: 'Kornephoros', 127: 'Cebalrai', 130: 'Rastaban', 135: 'Kaus Borealis', 137: 'Algenib', 138: 'Vindemiatrix', 139: 'Nihal', 145: 'Alcyone', 147: 'Deneb Algedi', 156: 'Cor Caroli', 157: 'Sadalsuud', 162: 'Algorab', 164: 'Sadalmelik', 168: 'Alnasl', 189: 'Albireo', 195: 'Wazn', 215: 'Errai', 218: 'Alfirk', 221: 'Yed Posterior', 236: 'Megrez', 253: 'Segin', 282: 'Rasalgethi', 289: 'Tarf', 293: 'Ain', 315: 'Algedi', 342: 'Porrima', 343: 'Thuban', 365: 'Alshain', 478: 'Kitalpha', 566: 'Alkes', 665: 'Acubens', 732: 'Alrescha', 842: 'Anser'};
    // Constellation figures from d3-celestial: 89 constellations, 893 vertices.
    const CONSTELLATION_LINES = 'And:2e1a7l1cf9oy0rb9bq05u96t|13q8r20wv8tf0qs97f0rb9bq0pm9jorctaa7qnoa7l|rctaa7reead5rcfaj2|1cf9oy13f9wy0yla441caal81w2ap3|reead5ribaiy;Ant:azb465c3j4jpco242u;Aps:h4l0ugiwt0vejcl0yoj5w0uu;Aqr:o2g67mo5w692owx6ijpkp6x4pvp6u5q0p6xyq586xoqh76cyqys68iqsw5b7|owx6ijpl55vh|pkp6x4psd6ce|q0p6xypy871u|r2a5e6qys68irfc5ki;Aql:mvs7rhmyy7mnn237ftnd76vqn0470tmhd76nm3f80imyy7mnmhd76nm406kg;Ara:k5z2lek9x29gjh92e0jne2mhjo22uckag33gk5w2nr;Ari:3a291q2gb8r627m8jt26u8fl;Aur:6xoaev63xahs5wva4j5q99i56al95h6xt9td6xoaev6xob4s63xahs5tpabq5u2a44;Boo:fyi8aig3n8d4gi88fagtg9adgtm9wfheda27hns9ijh2l917gi88fagzx805|gtm9wfgiqai1ggpaxvgouay1giqai1;Cae:5833h55eu3pq5fv42u5ve47g;Cam:5qgb3b5upblw5o7c2a4fzcg54fec01417bki|5o7c2a7b3cak83qcvu;Cnc:ady7uya4d8cfa3e8lna5r95x|a4d8cf9kt7nj;CVn:eyw9wfejga4w;CMa:7dr5k47td5nk85s53t89i4wp84v4sf82q4pj7c44mi|8ke4om89i4wp|7td5nk80z5mn86a5ql7zn60k80z5mn;CMi:8uz7ci8mj7l1;Cap:nhl5z9njx5synpe5kjo1c4zto5c4v8otj57rp7o5p7p2u5nqoqg5n9of55m5nhl5z9;Car:7o83m07en2vmao61kcbu71jgcei1z5c6x26nbwj27naqv2dc9oz2cp9732uu9fy3aia4e2q1aqv2dc|cei1z5cuw24mcwa25xcz32agcwb2e6clt2ejc6x26n;Cas:27gbuv1nlblc13ebmo0s5bb206dbib;Cen:d4x2qne1t314efh32heou360ftd2thg483ang043o1g023q7gbz44zgw03owhcf3p2|g023q7ffz441|gyu290ftd2thga02ab|efh32he432wjdce2cw;Cep:npwbszo0sbpsonwbrvp58bhapr4bcgpo7bfoq0xbgaqf6c1wrdocxnouxce0onwbrv|ouxce0qf6c1w;Cet:35f7703097dj2uw7li36k7q33gt7mr3il79d35f77032r6yx2os6pq25f65a20a5pq0ua5k10di69i1bn65q1md6ba25f65a;Cha:9m710cc9b0vncg40qhe8r0tpdvr0wqc9b0vn;Cir:hp62eoh0v1xiht82d8;Col:7dd4d46rq46n6jv4bd6e047h|6rq46n6xf3n2;Com:f8m8apf9x93geep94j;CrA:lys42xm44432m6940qm6n3wqm5h3tim1u3p2lsg3ldlha3oh;CrB:hzv9d4hwc96vi13907i6p8z2ibg8yfih090oijo98x;Crv:e1u51be31576e6z5laegr5o4ejw550e31576;Crt:dft66sd7f63ud3s5sycq65j6cyf56ld6k5hud7m5kwdlf5j1dt85md|d3s5syd7m5kw;Cru:et52c7e6j2et|eeh22qehn2jd;Cyg:ojz99zo1f9kdnksa1umuwafdmkbaxpmbkb29|ny4afsnksa1un2s9ngml093o;Del:nse7tenvf82knwv867o1q86snzi83vnvf82k;Dor:4xt2yz5aa2p46fp24f6nf1ve6tx22r6fp24f5w62id5aa2p4;Dra:kpibbzkrnax1k9hazakarb79kpibbzm8ec5yl8fcg6jugc0jizcbovijzbgphubbhtgaebwuej9cbvdc5cal|l8fcg6l8mck1|m8ec5ymx4cd7;Equ:om07clol27ptoi77q5;Eri:5xs6jv5ia6oz5bw6op4ux6f04lb5wh4d260e4b166w43v67q3ej69a35z5vi36o5if3io54e3uk59k44h59x4dj55f5bd4l453d4bi4z34c44fc45g46r3u53uu3md3ft3u233l3va2u339i2mt2yx28j2yn1vv2j0;For:3pe4ph39f4fz2eg4om;Gem:78c8oj7dy8oj7si8vt8be9a18rp9el8z593v8sm90q8hn8n286j8j57o787k7tg7xu|8hn8n28g887y;Gru:qmy2vhqee2zgqab3bsq1c3khpme3bkqab3bs|q103l6pri3r5pkx3w6pcg428;Her:ixw8f7j3o8lpjbc9dsjcg9y4j6da7wiweainioraetidla7x|jbc9dsjoj9bx|jcg9y4jys9s9|kre9thk4s9t7jys9s9joj9bxjys8v0kkl930ksg979kz995w|jyi81zj3o8lp;Hor:4we3oj34w30w31b2w233l2qh3ji2c23g6201;Hya:a5t7fua6z7e8a3d77ga0977a9zh7dua5t7fuabt7ejaoz74fb6o6uuay669yber5srbs15zpc2s5n8cj55p1dd94hidr34btfet55ngbr4vwh694sc;Hyi:0hw0zf4dt17s32u1od2qg1na27t1q32ah26z;Ind:nvf3annzx2xso7e2fnpf82p9oot2tjnvf3an;Lac:px1az3q2eatoq16amjpvaajaq1ua9sq8tad0q16amjpxpargpx1az3|q1ua9spqba0bprr9uv;Leo:bqh7v9bpr88kbyj8h4d058j0doe82hd0884vbqh7v9|byj8h4bw98r2bfn8y9bau8s1;LMi:bpu9nwc2o9jwclp9l1c419rzbpu9nwb2s9r4;Lep:72a5si6vi5un6oy5su6f25ki61b5oz5w557v6by5cc6n857n6rz5c0|61j5y261b5oz65x5xe;Lib:hfu4zsh6o5pghot67yi1o5sxi2q4rui3u4na|h6o5pgi1o5sx;Lup:ice4cli4m4afhs545ahru3t3hbz3m7h0g3adhlj2xahpv390hsr3hvi1f3rniir3zcin943s|hru3t3i1f3rn;Lyn:7bnbhx81sbga8m8aqp9p7a9zafga62as39s8atm9lj;Lyr:lp39uhlota01ljn9xqlp39uhlvv9silyy9gtlss9iolp39uh;Men:75416d6eh11y5p015u5u81fx;Mic:o414c6o303jtopf3snong4gnobw4geo414c6;Mon:8wb67h9fb6pq8bx6wn7i06eh78b6gl|8bx6wn7v974p7ei7ar7kv7id7qg7pi;Mus:dm01sne871p8elu1lyes51otf391f9eik1dnelu1ly;Nor:in63gjj1k39xiwg32oikw359in63gj;Oct:gq10hlqcn0nyp3t0z1gq10hl;Oph:ktc66vkll75jkij7apkcl7wwjmq7o2j4573iisn6nrive6kzj8h64njvj5qc|jmq7o2j8h64nj4a5nvj1g5iqizf5ecj0g54v|kij7apjvj5qck3m50kk7c4n1;Ori:7398316u48ic70q8hy76a81h6zo7ot6un7il69s7fn5os7q7|5rc72r5oc74s5m87dl5la7hc5lt7mq5os7q75pt7zj5vi84s5z285c|62f6b869c6rc6ek6x669s7fn6gq7pl6un7il6kn6sm6pi675|6kn6sm6hh6uo6ek6x6;Pav:nn52keo0k1u4nbe1u6lu9259la5277kzz215kk31y8lnw1fln5r1bho0k1u4otd1wf;Peg:pnm9i6qaj99yqoy94005u96t097846qpn849qd37vtq9h7s3pnr7f8p5p7pg|qpn849qoy940qfe8ucqcz8rhplj8wfp608x8;Per:4bs9fp4il9ek4ly9pf4l6a154cea8a4atamr46canv3xwasi3kcb2n3ajb9a3d0b0k3nbart3nlaem3moa3s3oua013kl9xw3g5a063gsa3z3moa3s|4r9atv4x0aoh4spamj4atamr|3nbart361aqr200aut;Phe:0i93oh19w3c81pd3lo1rd35p1bi2oj19w3c806j3ex0i93oh;Pic:7vh25y6qy2lz6p6305;Psc:1f88ua1ds99l1j791q1f88ua1dm8kf1rj84n2177ng2cr75o26v76v1yg7d91qn7f21f77j217q7jx0xt7j3rrj7h2re37dnr5r7fqr0h7cyqy9774r5171irfj72yrik77pre37dn|qy9774qp178m;PsA:q8w4uwqkp4nqqjj4fmqh54eoq2k4g5pmi4edp684e9p854k6pmi4edq8w4uw;Pup:7o83m08fl42y8s94r78un4vk91w50y97556g9el52i9bu3uw9fy3ai|91w50y9124xy8y34pl8s94r7;Pyx:9bu3uwa1747xa3m4dta8f4t1;Ret:4wp24h4y42da4lt27g4bp1xz4wp24h;Sge:mri8c1mwl8dhn4h8g5|ms68akmwl8dh;Sgr:l6943wlas4ail8l4n5ldf4zel3k5bi|mfe3iimg93t6m1h4n0lpp4v1ldf4ze|n223ppn55480n2g4wymp650wmh851xmah4zulwe4wylpp4v1l8l4n5ky14lilas4aim1h4n0m4i4t5lwe4wym2x59mm6g5bmmbx5hdmeq5kfmer5po|m2x59mly35bdlvm56ulwe4wy;Sco:ihv4xhiiw576img5ez|iiw576ixe4yxj334wlj7l4rmjhi4arjip40bjkl3ocjws3lwke93mkkle3ujkhu3xlkbo42y;Scl:14p4ogrkb4rvqzf4fnr9840y;Sct:lig6b4lqr6ktlnd68vlea5tjlig6b4;Ser:i9384ui5v8gniau8ceig785ii9384ui167rai7r7fvica7agisn6nr;Ser:jvj5qckeg5r8ktc66vkw56bal8t6pylx179o;Sex:bq66wzbfh6bic556qec5p6w8;Tau:6ih8kq5bm87v56l86350f85f52l8aq56j8fa6al95h|50f85f4n57wp3zv7p14ov7en|3zv7p13y87n346m6z4;Tel:l1t3edlcq3eble135p;Tri:26j9862hz9n72nd9k126j986;TrA:jgh1m9ifb21thq51n8jgh1m9;Tuc:ptj2amqyg2g80lx2340dy1xtrry1vupzn1xjptj2am;UMa:e6qbcfcsxbpjcrmbamdrqb35e6qbcfexjb9gfiab6lfypaqz|drqb35dmbamqd369hxd2z9dl|dmbamqcx2admc06a5a|cx2admbwja97|csxbpjb0wbt69udbmobefbi0crmbam|crmbambf7b46b1taxkaegang|ahjal0b1taxk;UMi:i7lcy3iuucsghrechjh6kco0i7lcy3jeld9wkapdmj2xfdty;Vel:a4e2q1aud2p7bii2qfch534qbuw3p0b0c3tlakk3ld9fy3ai;Vir:dm67g5dpj72we9u6w5eoy6tzf8l6imfj6630gig6hch196ia|f367sgeym77geoy6tz|f8l6imfpr6wcg8h72ah3g739;Vol:agp1tk9r71ua9eu1ne8fd1p889r1i69eu1neagp1tk;Vul:max8lfmjm8uin0t8swn64933nga939';
    const CONSTELLATION_NAMES = 'And:Andromeda:023a9g;Ant:Antlia:c1c460;Aps:Apus:iio18g;Aqr:Aquarius:q1i6k4;Aql:Aquila:mgc7k8;Ara:Ara:jwo2mg;Ari:Aries:38o8n4;Aur:Auriga:6d69ss;Boo:Boötes:h8u9n8;Cae:Caelum:5o63pc;Cam:Camelopardalis:6hcci0;Cnc:Cancer:9w9910;CVn:Canes Venatici:etca9g;CMa:Canis Major:7iu4xs;CMi:Canis Minor:8g67bw;Cap:Capricornus:ob058w;Car:Carina:b401uo;Cas:Cassiopeia:rbcb86;Cen:Centaurus:fe63uw;Cep:Cepheus:q1icf8;Cet:Cetus:2766k4;Cha:Chamaeleon:el00p0;Cir:Circinus:gs61rw;Col:Columba:6li3xo;Com:Coma Berenices:exi8so;CrA:Corona Austrina:lrc3uw;CrB:Corona Borealis:iei9ew;Crv:Corvus:eco5fu;Crt:Crater:dhf5sc;Cru:Crux:exi25s;Cyg:Cygnus:nq6asw;Del:Delphinus:nuc7eo;Dor:Dorado:5wi208;Dra:Draco:kpubvs;Equ:Equuleus:opl7ty;Eri:Eridanus:41u5k0;For:Fornax:34i4s8;Gem:Gemini:89x8ra;Gru:Grus:qe03qq;Her:Hercules:jk69n8;Hor:Horologium:3xo2xk;Hya:Hydra:bko58w;Hyi:Hydrus:2nu1e0;Ind:Indus:ojc2nu;Lac:Lacerta:qe0akk;Leo:Leo:c9o83o;LMi:Leo Minor:c5i99c;Lep:Lepus:6tu50k;Lib:Libra:hto4xs;Lup:Lupus:hnf48s;Lyn:Lynx:9diaq4;Lyr:Lyra:lj099c;Men:Mensa:6d60rs;Mic:Microscopium:of6438;Mon:Monoceros:8ur6hc;Mus:Musca:f1o1b8;Nor:Norma:ir02xk;Oct:Octans:n5c0rs;Oph:Ophiuchus:jwo76c;Ori:Orion:6hc7y4;Pav:Pavo:mx025s;Peg:Pegasus:pt686g;Per:Perseus:53caf0;Phe:Phoenix:19u3mk;Pic:Pictor:6d6334;Psc:Pisces:1i683o;PsA:Piscis Austrinus:pp04pg;Pup:Puppis:8kc3e8;Pyx:Pyxis:a6o53c;Ret:Reticulum:4a628k;Sge:Sagitta:mgc8c0;Sgr:Sagittarius:mki4bk;Sco:Scorpius:j7o40g;Scl:Sculptor:0464ec;Sct:Scutum:lrc5za;Ser:Serpens Caput:hxu7bw;Ser:Serpens Cauda:ln676c;Sex:Sextans:c5i6ek;Tau:Taurus:46083o;Tel:Telescopium:leu2s0;Tri:Triangulum:2309kg;TrA:Triangulum Australe:iio1qi;Tuc:Tucana:quo208;UMa:Ursa Major:cqcanc;UMi:Ursa Minor:hh6c6w;Vel:Vela:b1x3e8;Vir:Virgo:fe66mw;Vol:Volans:8kc1b8;Vul:Vulpecula:msu8kc';
    // STAR_CATALOG_END

    // Nine base-36 characters per star, see scripts/firefox-newtab-stars:
    // RA (3, hundredths of a degree), Dec+90 (3, hundredths), V magnitude
    // +2 (2, twentieths), B-V colour index +1 (1, tenths).
    function decodeStarCatalog(text) {
      const stars = [];
      for (let i = 0; i + 9 <= text.length; i += 9) {
        stars.push({
          ra: parseInt(text.slice(i, i + 3), 36) / 100,
          dec: parseInt(text.slice(i + 3, i + 6), 36) / 100 - 90,
          mag: parseInt(text.slice(i + 6, i + 8), 36) / 20 - 2,
          bv: parseInt(text.slice(i + 8, i + 9), 36) / 10 - 1,
        });
      }
      return stars;
    }

    // "And:v1v2v3|v4v5;Ant:..." - the three-letter abbreviation, then
    // polylines of six-character vertices (RA and Dec+90 in hundredths of
    // a degree, base 36), '|' between polylines, ';' between figures.
    function decodeConstellations(text) {
      if (!text) return [];
      return text.split(';').map((entry) => {
        const [id, body] = entry.split(':');
        const lines = body.split('|').map((poly) => {
          const verts = [];
          for (let i = 0; i + 6 <= poly.length; i += 6) {
            verts.push({
              ra: parseInt(poly.slice(i, i + 3), 36) / 100,
              dec: parseInt(poly.slice(i + 3, i + 6), 36) / 100 - 90,
            });
          }
          return verts;
        });
        return { id, lines };
      });
    }

    // "And:Andromeda:v;Ant:Antlia:v" - abbreviation, name and one packed
    // label vertex per figure, in the same order as the figures.
    function decodeConstellationNames(text) {
      if (!text) return [];
      return text.split(';').map((entry) => {
        const [id, name, v] = entry.split(':');
        return {
          id, name,
          ra: parseInt(v.slice(0, 3), 36) / 100,
          dec: parseInt(v.slice(3, 6), 36) / 100 - 90,
        };
      });
    }

    const DEG = Math.PI / 180;

    function julianDay(date) {
      return date.getTime() / 86400000 + 2440587.5;
    }

    // Local sidereal time in degrees: Greenwich mean sidereal time (Meeus
    // 12.4) plus the east longitude.
    function localSiderealDeg(date, lng) {
      const d = julianDay(date) - 2451545.0;
      const T = d / 36525;
      const gmst = 280.46061837 + 360.98564736629 * d + 0.000387933 * T * T - T * T * T / 38710000;
      return (((gmst + lng) % 360) + 360) % 360;
    }

    // Equatorial (degrees) to horizontal (radians). Azimuth is measured
    // from north through east, so south is PI.
    function toAltAz(raDeg, decDeg, lstDeg, latRad) {
      const H = (lstDeg - raDeg) * DEG;
      const dec = decDeg * DEG;
      const alt = Math.asin(Math.sin(dec) * Math.sin(latRad) + Math.cos(dec) * Math.cos(latRad) * Math.cos(H));
      const east = -Math.sin(H) * Math.cos(dec);
      const north = Math.sin(dec) * Math.cos(latRad) - Math.cos(dec) * Math.sin(latRad) * Math.cos(H);
      return { alt, az: Math.atan2(east, north) };
    }

    // Stereographic projection about the south horizon point, in units
    // where due east and due west on the horizon land at x = -2 and +2
    // and the zenith at y = 2. y is up. The scale factor is 1 at the
    // centre and grows away from it (2 at the east/west points, 4 at
    // 120 degrees round), so constellations near the edges are larger
    // but the same shape.
    function projectSky(alt, az) {
      const dAz = az - Math.PI; // west positive: right on screen
      const cosAlt = Math.cos(alt);
      const k = 2 / (1 + cosAlt * Math.cos(dAz));
      return { x: k * cosAlt * Math.sin(dAz), y: k * Math.sin(alt) };
    }

    // Where the celestial horizon sits: the median ridge line of layer4,
    // measured from the image's alpha channel at 3.6vw below its top
    // edge (the clock tower pokes higher than the ridge). The layer's
    // bottom gap is whatever updateLayout() last set for the window.
    const LAYER4_RIDGE_VW = OWN_HEIGHT_VW.l4 - 3.6;

    // The frame is sized from the sky's height, not the window's width:
    // the top edge of the window is projection y = SKY_FRAME_TOP, 81
    // degrees up on the meridian, so the moon stays on screen even at a
    // high winter transit (72 degrees for tonight's). The width then
    // takes whatever azimuth fits, a little past due east and west on a
    // 16:9 window, capped at 120 degrees either side of south on very
    // wide ones so the corners don't stretch past all recognition.
    const SKY_FRAME_TOP = 1.7;
    const SKY_MAX_HALF_AZ = 120 * DEG;

    function skyFrame() {
      const W = window.innerWidth;
      const H = window.innerHeight;
      const l4 = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--l4-vw'));
      const gap = Number.isFinite(l4) ? l4 : LAYERS.l4.full;
      const horizonY = H - (gap + LAYER4_RIDGE_VW) * W / 100;
      const edgeX = 2 * Math.tan(SKY_MAX_HALF_AZ / 2); // horizon x at the azimuth cap
      const scale = Math.max(horizonY / SKY_FRAME_TOP, W / 2 / edgeX);
      return { W, horizonY, cx: W / 2, scale };
    }

    // The moment the sky is drawn for: now, or today at the pinned hour
    // when applyTime()/startTimeDemo() are driving the sky colors, so the
    // stars sweep along with them.
    function skyDate() {
      if (dateOverride) return dateOverride;
      if (timeOverrideHour === null) return new Date();
      const midnight = new Date();
      midnight.setHours(0, 0, 0, 0);
      return new Date(midnight.getTime() + timeOverrideHour * 3600000);
    }

    function skyCoords() {
      return lastCoords || CLEMSON_SC;
    }

    function nightSkyOpacity() {
      if (loadSettings().nightSky === 'off') return 0;
      const n = Math.max(0, Math.min(1, currentNight));
      // Smoothstep rather than the raw lerp: the horizon is still orange
      // at sunsetHour itself, so stars should stay all but invisible for
      // the first half hour and likewise be gone well before sunrise.
      const eased = n * n * (3 - 2 * n);
      return eased * weatherSkyFactor();
    }

    // How much of the sky shows through the weather. Fog and
    // precipitation hide it outright; otherwise the cloud cover figure
    // from the last fetch sets it - half cover leaves two thirds, full
    // cover a tenth - with the category's fixed value as the fallback
    // when no figure is known.
    function weatherSkyFactor() {
      const fixed = NIGHT_SKY_WEATHER[lastWeatherCategory] ?? 1;
      if (fixed === 0 || lastCloudCover === null) return fixed;
      const cover = Math.max(0, Math.min(1, lastCloudCover / 100));
      return 1 - 0.9 * Math.pow(cover, 1.5);
    }

    // The moon is up in daylight half the time, so it has its own
    // opacity: full alongside the stars, faint by day, still subject to
    // the weather and to the night-sky setting.
    const DAY_MOON_OPACITY = 0.45;

    function updateNightSky() {
      const opacity = nightSkyOpacity();
      const root = document.documentElement.style;
      root.setProperty('--star-opacity', opacity.toFixed(3));
      if (opacity > 0) {
        ensureNightSky();
        starField.classList.remove('dormant');
        layoutSky();
        scheduleShootingStar();
      } else if (starField) {
        // Pausing the instant the target hits zero freezes the twinkle a
        // few seconds before the 4s fade-out finishes, at an opacity
        // where nobody can tell.
        starField.classList.add('dormant');
      }

      const moonOpacity = loadSettings().nightSky === 'off'
        ? 0 : Math.max(opacity, DAY_MOON_OPACITY * weatherSkyFactor());
      root.setProperty('--moon-opacity', moonOpacity.toFixed(3));
      if (moonOpacity > 0) {
        ensureMoon();
        layoutMoon();
        updateMoon();
      }
    }

    function ensureMoon() {
      if (moonEl) return;
      moonEl = document.createElement('div');
      moonEl.id = 'moon';
      moonEl.hidden = true; // until layoutMoon() finds it above the ridge
      // Like the paw: something you can click that doesn't look like it.
      moonEl.addEventListener('click', () => spawnUfo());
      document.querySelector('.scene').appendChild(moonEl);
    }

    // Rough spectral tint from the B-V colour index: blue-white for the
    // hot O/B stars, through white, to the orange of Betelgeuse, Antares
    // and Aldebaran. Only the brightest are big enough to show it.
    function starColor(bv) {
      if (bv < -0.05) return '#B5CCFF';
      if (bv < 0.3) return '#DCE6FF';
      if (bv < 0.6) return '#F6F7FF';
      if (bv < 1.0) return '#FFF3D6';
      if (bv < 1.5) return '#FFD9A3';
      return '#FFBA7A';
    }

    function ensureNightSky() {
      if (starField) return;
      const scene = document.querySelector('.scene');

      starData = decodeStarCatalog(STAR_CATALOG);
      starField = document.createElement('div');
      starField.id = 'star-field';
      starField.setAttribute('aria-hidden', 'true'); // decoration, thousands of it

      // Constellation figures go in first so the stars paint over them.
      constellationData = decodeConstellations(CONSTELLATION_LINES);
      const names = decodeConstellationNames(CONSTELLATION_NAMES);
      constellationData.forEach((figure, i) => {
        const entry = names[i] && names[i].id === figure.id ? names[i] : null;
        figure.name = entry ? entry.name : figure.id;
        figure.label = entry; // preferred label point, or null
      });
      linesSvg = document.createElementNS(SVG_NS, 'svg');
      linesSvg.id = 'constellation-lines';
      linesSvg.setAttribute('aria-hidden', 'true');
      constellationPaths = constellationData.map((figure) => {
        const path = document.createElementNS(SVG_NS, 'path');
        path.dataset.id = figure.id;
        linesSvg.appendChild(path);
        return path;
      });
      // Labels after every path so they sit on top of the lines.
      constellationLabels = constellationData.map((figure) => {
        const text = document.createElementNS(SVG_NS, 'text');
        text.textContent = figure.name;
        text.setAttribute('text-anchor', 'middle');
        text.style.display = 'none';
        linesSvg.appendChild(text);
        return text;
      });
      starField.appendChild(linesSvg);

      const frag = document.createDocumentFragment();
      starEls = starData.map((star, i) => {
        const el = document.createElement('div');
        // Size and brightness from magnitude: Sirius over 4px with a halo,
        // the constellation-drawing second and third magnitudes a couple
        // of pixels with a faint one, the mag 5 tail a single dim pixel.
        const size = Math.max(1.1, Math.min(4.4, 3.5 - 0.5 * star.mag));
        const base = Math.max(0.45, Math.min(1, 1.05 - 0.14 * (star.mag - 1)));
        el.className = 'star'
          + (star.mag < 1.6 ? ' bright' : star.mag < 3 ? ' mid' : '')
          + (star.mag < 3.5 && Math.random() < 0.4 ? ' twinkle' : '')
          + (STAR_NAMES[i] ? ' named' : '');
        if (STAR_NAMES[i]) el.title = STAR_NAMES[i];
        el.style.width = el.style.height = `${size.toFixed(1)}px`;
        el.style.background = starColor(star.bv);
        el.style.setProperty('--star-base', base.toFixed(2));
        el.style.setProperty('--twinkle-dur', `${(2.5 + Math.random() * 4).toFixed(1)}s`);
        el.style.animationDelay = `${(-Math.random() * 6).toFixed(1)}s`;
        el.hidden = true; // until layoutSky() finds it above the horizon
        frag.appendChild(el);
        return el;
      });
      starField.appendChild(frag);

      // Planets go in after the stars so they paint over them. They never
      // twinkle - the one thing that gives a planet away to the eye.
      planetEls = PLANETS.map((planet) => {
        const el = document.createElement('div');
        el.className = 'star planet named';
        el.style.background = planet.color;
        el.style.setProperty('--star-base', '1');
        el.hidden = true;
        starField.appendChild(el);
        return el;
      });

      scene.appendChild(starField);
    }

    // Everything that maps a sky position to the window for skyDate() at
    // skyCoords(), computed once per layout. place() takes RA/Dec in
    // degrees and returns window pixels, or null when the point is below
    // the ridge or out of frame. margin: how far outside the window a
    // point may land and still count. Stars need almost none; line
    // vertices get half a window, so a figure's edge segments run off
    // screen instead of stopping at the last vertex that was inside.
    function makePlacer() {
      const date = skyDate();
      const { lat, lng } = skyCoords();
      const latRad = lat * DEG;
      const lst = localSiderealDeg(date, lng);
      const { W, horizonY, cx, scale } = skyFrame();
      const place = (raDeg, decDeg, margin = 20) => {
        const { alt, az } = toAltAz(raDeg, decDeg, lst, latRad);
        if (alt < -0.5 * DEG) return null;
        const { x, y } = projectSky(alt, az);
        const px = cx + x * scale;
        const py = horizonY - y * scale;
        // The sky behind the viewer projects to huge or infinite
        // coordinates (the north point itself is the pole of the
        // projection), so the bounds check is also the back-cull.
        if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
        if (px < -margin || px > W + margin || py < -margin) return null;
        return { px, py };
      };
      return { date, W, horizonY, place };
    }

    // Place every star, figure and planet. Runs on each sky update (once
    // a minute) and on resize; ~1600 stars take well under a
    // millisecond. Anything below the ridge or behind the viewer is
    // hidden rather than moved off-screen so it costs no layout.
    function layoutSky() {
      if (!starField) return;
      const { date, W, horizonY, place } = makePlacer();

      for (let i = 0; i < starEls.length; i++) {
        const pos = place(starData[i].ra, starData[i].dec);
        const el = starEls[i];
        el.hidden = !pos;
        if (!pos) continue;
        el.style.left = `${pos.px.toFixed(1)}px`;
        el.style.top = `${pos.py.toFixed(1)}px`;
      }

      // Each figure becomes one path: a segment is drawn only between
      // two consecutive vertices that both placed, so figures stop at
      // the ridge rather than diving under it. The SVG root isn't an
      // HTML element, so it's hidden through style, not `hidden`.
      // 'on' is what the setting stored before names existed.
      const mode = loadSettings().constellations || 'lines';
      const showLines = mode !== 'off';
      const showNames = mode === 'names';
      linesSvg.style.display = showLines ? '' : 'none';
      if (showLines) {
        const H = window.innerHeight;
        const lineMargin = Math.max(W, H) / 2;
        for (let c = 0; c < constellationData.length; c++) {
          const figure = constellationData[c];
          let d = '';
          let sumX = 0, sumY = 0, placed = 0;
          for (const poly of figure.lines) {
            let penDown = false;
            for (const v of poly) {
              const pos = place(v.ra, v.dec, lineMargin);
              if (!pos) { penDown = false; continue; }
              d += (penDown ? 'L' : 'M') + pos.px.toFixed(1) + ' ' + pos.py.toFixed(1);
              penDown = true;
              sumX += pos.px; sumY += pos.py; placed++;
            }
          }
          constellationPaths[c].setAttribute('d', d);

          // The name goes at the catalog's label point when that is on
          // screen, otherwise at the middle of whichever vertices did
          // place, so a figure half-set behind the ridge is still
          // named. A lone vertex is a sliver, not a figure: no label.
          const label = constellationLabels[c];
          let at = null;
          if (showNames && placed >= 2) {
            at = (figure.label && place(figure.label.ra, figure.label.dec, 0))
              || { px: sumX / placed, py: sumY / placed };
            if (at.px < 0 || at.px > W || at.py < 0 || at.py > horizonY) at = null;
          }
          label.style.display = at ? '' : 'none';
          if (at) {
            label.setAttribute('x', at.px.toFixed(1));
            label.setAttribute('y', at.py.toFixed(1));
          }
        }
      }

      planetStates(date).forEach((planet, i) => {
        const el = planetEls[i];
        const pos = place(planet.ra, planet.dec);
        el.hidden = !pos;
        if (!pos) return;
        const size = Math.max(1.6, Math.min(6, 3.5 - 0.5 * planet.mag));
        el.style.width = el.style.height = `${size.toFixed(1)}px`;
        el.classList.toggle('bright', planet.mag < 1.6);
        el.style.left = `${pos.px.toFixed(1)}px`;
        el.style.top = `${pos.py.toFixed(1)}px`;
        el.title = `${planet.name} \u00b7 mag ${planet.mag.toFixed(1)}`;
      });
    }

    // The moon is placed separately because it can be up by day, when
    // the star field doesn't exist. A new moon is hidden outright: the
    // faint unlit disc reads as a smudge next to the sun.
    function layoutMoon({ instant = false } = {}) {
      if (!moonEl) return;
      const { date, place } = makePlacer();
      const moon = moonState(date);
      const lit = (1 - Math.cos(moonPhase() * 2 * Math.PI)) / 2;
      const pos = lit >= 0.02 ? place(moon.raDeg, moon.decDeg) : null;
      moonEl.hidden = !pos;
      if (!pos) return;
      // The moon's 60s transform transition is for its real drift; a
      // resize should snap it, not send it gliding across the window.
      if (instant) moonEl.style.transition = 'none';
      moonEl.style.setProperty('--moon-x', pos.px.toFixed(1));
      moonEl.style.setProperty('--moon-y', pos.py.toFixed(1));
      if (instant) {
        void moonEl.offsetWidth; // commit the snapped position first
        moonEl.style.transition = '';
      }
    }

    window.addEventListener('resize', () => {
      layoutSky();
      layoutMoon({ instant: true });
    });

    // Moon: the Astronomical Almanac's low-precision series (the leading
    // terms of Meeus ch. 47) for ecliptic longitude and latitude, good to
    // about a third of a degree - a couple of pixels here - plus the sun's
    // longitude so the phase comes from the true elongation rather than a
    // mean cycle. Topocentric parallax (under a degree) is ignored; the
    // disc is drawn many times its real size anyway.
    function moonState(date) {
      const d = julianDay(date) - 2451545.0;
      const wrap = (deg) => (((deg % 360) + 360) % 360) * DEG;
      const L0 = wrap(218.3164477 + 13.17639648 * d); // mean longitude
      const l = wrap(134.9633964 + 13.06499295 * d);  // mean anomaly
      const M = wrap(357.5291092 + 0.98560028 * d);   // sun's mean anomaly
      const F = wrap(93.2720950 + 13.22935024 * d);   // argument of latitude
      const D = wrap(297.8501921 + 12.19074912 * d);  // mean elongation
      const lon = L0 + DEG * (
        6.289 * Math.sin(l) - 1.274 * Math.sin(l - 2 * D) + 0.658 * Math.sin(2 * D)
        + 0.214 * Math.sin(2 * l) - 0.186 * Math.sin(M) - 0.114 * Math.sin(2 * F));
      const lat = DEG * (
        5.128 * Math.sin(F) + 0.281 * Math.sin(l + F) + 0.278 * Math.sin(l - F)
        + 0.173 * Math.sin(2 * D - F) + 0.055 * Math.sin(2 * D - l + F) + 0.046 * Math.sin(2 * D - l - F));
      const sunLon = wrap(280.459 + 0.98564736 * d) + DEG * (1.915 * Math.sin(M) + 0.020 * Math.sin(2 * M));
      const eps = (23.4393 - 0.0000004 * d) * DEG;
      const ra = Math.atan2(Math.sin(lon) * Math.cos(eps) - Math.tan(lat) * Math.sin(eps), Math.cos(lon));
      const dec = Math.asin(Math.sin(lat) * Math.cos(eps) + Math.cos(lat) * Math.sin(eps) * Math.sin(lon));
      let phase = ((lon - sunLon) / (2 * Math.PI)) % 1;
      if (phase < 0) phase += 1;
      return { raDeg: ra / DEG, decDeg: dec / DEG, phase }; // phase: 0 new, 0.5 full
    }

    // Planets: Keplerian elements from JPL's "Approximate Positions of
    // the Planets" (Standish; the 1800-2050 table), each at J2000 with
    // its rate per century: a (AU), e, I, L, longitude of perihelion,
    // longitude of the ascending node, in degrees. Geocentric positions
    // come from subtracting the Earth-Moon barycentre's; no light-time
    // or aberration, so good to a few arcminutes - a pixel here. h is
    // the absolute magnitude V(1,0); the cap stands in for the phase
    // term, which matters only for the inner two.
    const PLANETS = [
      { name: 'Mercury', color: '#E8E8F0', h: -0.6, cap: -1.0,
        el: [0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593],
        rate: [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081] },
      { name: 'Venus', color: '#FFF7E0', h: -4.4, cap: -4.6,
        el: [0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255],
        rate: [0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418] },
      { name: 'Mars', color: '#FFB090', h: -1.5, cap: -2.9,
        el: [1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
        rate: [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343] },
      { name: 'Jupiter', color: '#FFF2D6', h: -9.4, cap: -2.9,
        el: [5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909],
        rate: [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106] },
      { name: 'Saturn', color: '#F5E6B8', h: -8.9, cap: -0.5,
        el: [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448],
        rate: [-0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794] },
    ];
    const EARTH_MOON = {
      el: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0],
      rate: [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0],
    };

    // Heliocentric ecliptic position in AU at T centuries from J2000.
    function heliocentric(body, T) {
      const [a, e, I, L, wbar, node] = body.el.map((v, i) => v + body.rate[i] * T);
      const w = (wbar - node) * DEG;
      const M = ((((L - wbar) % 360) + 540) % 360 - 180) * DEG;
      let E = M + e * Math.sin(M); // Kepler's equation, Newton's method
      for (let i = 0; i < 6; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
      const xp = a * (Math.cos(E) - e);
      const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
      const cw = Math.cos(w), sw = Math.sin(w);
      const cn = Math.cos(node * DEG), sn = Math.sin(node * DEG);
      const ci = Math.cos(I * DEG), si = Math.sin(I * DEG);
      return {
        x: (cw * cn - sw * sn * ci) * xp + (-sw * cn - cw * sn * ci) * yp,
        y: (cw * sn + sw * cn * ci) * xp + (-sw * sn + cw * cn * ci) * yp,
        z: (sw * si) * xp + (cw * si) * yp,
      };
    }

    // Geocentric RA/Dec in degrees plus a rough visual magnitude for each
    // planet, in PLANETS order.
    function planetStates(date) {
      const d = julianDay(date) - 2451545.0;
      const T = d / 36525;
      const eps = (23.4393 - 0.0000004 * d) * DEG;
      const earth = heliocentric(EARTH_MOON, T);
      return PLANETS.map((p) => {
        const h = heliocentric(p, T);
        const gx = h.x - earth.x, gy = h.y - earth.y, gz = h.z - earth.z;
        const sunDist = Math.hypot(h.x, h.y, h.z);
        const earthDist = Math.hypot(gx, gy, gz);
        const yq = gy * Math.cos(eps) - gz * Math.sin(eps);
        const zq = gy * Math.sin(eps) + gz * Math.cos(eps);
        const ra = Math.atan2(yq, gx) / DEG;
        return {
          name: p.name, color: p.color,
          ra: ((ra % 360) + 360) % 360,
          dec: Math.asin(zq / earthDist) / DEG,
          mag: Math.max(p.cap, p.h + 5 * Math.log10(sunDist * earthDist)),
        };
      });
    }

    // Console hook for testing: applyMoonPhase(0.5) pins a full moon,
    // applyMoonPhase(null) returns to the real one.
    let moonPhaseOverride = null;
    let renderedMoonKey = null;

    function moonPhase() {
      return moonPhaseOverride !== null ? moonPhaseOverride : moonState(skyDate()).phase;
    }

    function applyMoonPhase(phase) {
      moonPhaseOverride = phase;
      updateMoon();
    }

    // The four principal phases are instants, so they get a window of
    // about a day either side; everything between is a crescent or a
    // gibbous moon. Splitting the cycle into equal eighths instead would
    // call a 68%-lit moon "last quarter".
    function moonPhaseName(phase) {
      const near = (target) => Math.abs(phase - target) < 0.035;
      if (near(0) || near(1)) return 'New moon';
      if (near(0.25)) return 'First quarter';
      if (near(0.5)) return 'Full moon';
      if (near(0.75)) return 'Last quarter';
      if (phase < 0.25) return 'Waxing crescent';
      if (phase < 0.5) return 'Waxing gibbous';
      if (phase < 0.75) return 'Waning gibbous';
      return 'Waning crescent';
    }

    // The lit shape as one SVG path. Facing south the sun is off to the
    // right (west) after dusk and to the left (east) before dawn, so the
    // lit limb is on the right while waxing and on the left while waning.
    // Out along that limb from the top of the disc to the bottom, then
    // back up along the terminator, a half-ellipse whose x-radius follows
    // |cos(phase)|. It bulges toward the lit limb for a crescent (thin
    // sliver) and away from it for a gibbous moon; at the quarters it
    // collapses to a straight line (an arc with rx=0 is drawn as a line).
    // Sweep flag 1 is clockwise on screen: top-to-bottom clockwise passes
    // the right side, bottom-to-top clockwise passes the left.
    function moonPathD(phase, r) {
      const cosT = Math.cos(phase * 2 * Math.PI);
      const litRight = phase < 0.5;
      const bulgeRight = litRight === (cosT > 0);
      const rx = (Math.abs(cosT) * r).toFixed(2);
      const top = `${r} 0`;
      const bottom = `${r} ${2 * r}`;
      return `M ${top} A ${r} ${r} 0 0 ${litRight ? 1 : 0} ${bottom} `
           + `A ${rx} ${r} 0 0 ${bulgeRight ? 0 : 1} ${top} Z`;
    }

    // Redraws the disc when the phase has visibly moved (about once an
    // hour). Position is layoutSky()'s job, alongside the stars.
    function updateMoon() {
      if (!moonEl) return;
      const phase = moonPhase();
      const key = Math.round(phase * 720);
      if (key === renderedMoonKey) return;
      renderedMoonKey = key;
      const r = 20;
      moonEl.innerHTML =
        `<svg viewBox="0 0 ${2 * r} ${2 * r}" aria-hidden="true">`
        + `<circle cx="${r}" cy="${r}" r="${r}" fill="rgba(255, 255, 255, 0.07)"></circle>`
        + `<path d="${moonPathD(phase, r)}" fill="#F4ECD6"></path>`
        + '</svg>';
      const lit = Math.round((1 - Math.cos(phase * 2 * Math.PI)) / 2 * 100);
      moonEl.title = `${moonPhaseName(phase)} · ${lit}% lit`;
    }

    // The major annual showers: peak (month, day), radiant J2000 RA/Dec,
    // zenithal hourly rate at maximum, and how many days either side the
    // stream is worth showing. Between them the streaks are sporadic.
    const METEOR_SHOWERS = [
      { name: 'Quadrantids', month: 1, day: 3.5, ra: 230, dec: 49, zhr: 120, span: 1 },
      { name: 'Lyrids', month: 4, day: 22, ra: 271, dec: 34, zhr: 18, span: 2 },
      { name: 'Eta Aquariids', month: 5, day: 6, ra: 338, dec: -1, zhr: 50, span: 3 },
      { name: 'Perseids', month: 8, day: 12.5, ra: 48, dec: 58, zhr: 100, span: 3 },
      { name: 'Orionids', month: 10, day: 21, ra: 95, dec: 16, zhr: 20, span: 3 },
      { name: 'Leonids', month: 11, day: 17, ra: 152, dec: 22, zhr: 15, span: 2 },
      { name: 'Geminids', month: 12, day: 14, ra: 112, dec: 33, zhr: 150, span: 2 },
      { name: 'Ursids', month: 12, day: 22, ra: 217, dec: 76, zhr: 10, span: 1 },
    ];

    // The shower in progress on the sky's date, with a 0-1 strength that
    // peaks at the maximum and falls off linearly over the span, or null.
    function activeShower(date = skyDate()) {
      const dayOfYear = (d) => (d - new Date(d.getFullYear(), 0, 1)) / 86400000;
      const now = dayOfYear(date);
      let best = null;
      for (const shower of METEOR_SHOWERS) {
        const peak = dayOfYear(new Date(date.getFullYear(), shower.month - 1, 1)) + shower.day - 1;
        const away = Math.abs(now - peak);
        if (away > shower.span) continue;
        const strength = 1 - away / shower.span;
        if (!best || strength * shower.zhr > best.strength * best.zhr) best = { ...shower, strength };
      }
      return best;
    }

    // One pending timer at most. The first streak comes within seconds so
    // a lingering tab has a fair chance of catching it; after one has
    // actually been seen they turn rare, as they should be. A tick that
    // lands while the tab is hidden (new tabs are preloaded hidden) or
    // the sky has brightened spawns nothing and doesn't count.
    function scheduleShootingStar() {
      if (shootingStarTimer !== null || reducedMotion.matches) return;
      // A shower shortens the wait in proportion to its rate: the
      // Perseids at peak bring one every ten or twenty seconds.
      const shower = activeShower();
      const rate = shower ? 1 + (shower.zhr / 30) * shower.strength : 1;
      const seconds = (shootingStarsSeen === 0 ? 4 + Math.random() * 8 : 30 + Math.random() * 60) / rate;
      shootingStarTimer = setTimeout(() => {
        shootingStarTimer = null;
        if (document.visibilityState === 'visible' && nightSkyOpacity() > 0.2) {
          // Every so often the streak is something else entirely - but
          // never the first thing a tab shows, so it stays a rumour.
          if (shootingStarsSeen > 0 && Math.random() < 0.04) spawnUfo();
          else spawnShootingStar();
          shootingStarsSeen++;
        }
        if (nightSkyOpacity() > 0) scheduleShootingStar();
      }, seconds * 1000);
    }

    function spawnShootingStar() {
      ensureNightSky();
      const streak = document.createElement('div');
      streak.className = 'shooting-star';
      // During a shower the streaks radiate: each starts somewhere in the
      // sky and flies directly away from the radiant, which is what makes
      // a shower look like one. The radiant is usually off screen (Perseus
      // rises in the north-east, far beyond the left edge in this
      // projection; a northern radiant projects above the top), so it is
      // allowed a very wide margin and only its direction matters. A
      // radiant below the horizon means sporadic streaks as usual.
      const shower = activeShower();
      let placed = false;
      if (shower) {
        const { W, horizonY, place } = makePlacer();
        const radiant = place(shower.ra, shower.dec, 20 * Math.max(W, window.innerHeight));
        if (radiant) {
          const x = (0.05 + Math.random() * 0.9) * W;
          const y = Math.random() * horizonY * 0.85;
          const bearing = Math.atan2(y - radiant.py, x - radiant.px) / DEG;
          // The head is the element's right end, so the start point is
          // offset by the streak's length.
          streak.style.left = `${(x - 120).toFixed(1)}px`;
          streak.style.top = `${y.toFixed(1)}px`;
          streak.style.setProperty('--shoot-angle', `${bearing.toFixed(1)}deg`);
          placed = true;
        }
      }
      if (!placed) {
        // Sporadic: somewhere in the upper sky, heading down-left or
        // down-right; the angle is measured clockwise from horizontal,
        // so 180 minus it mirrors the flight.
        const goingRight = Math.random() < 0.5;
        const pitch = 18 + Math.random() * 22;
        streak.style.left = `${(goingRight ? 5 + Math.random() * 50 : 45 + Math.random() * 50).toFixed(1)}%`;
        streak.style.top = `${(3 + Math.random() * 30).toFixed(1)}%`;
        streak.style.setProperty('--shoot-angle', `${(goingRight ? pitch : 180 - pitch).toFixed(1)}deg`);
      }
      streak.style.setProperty('--shoot-dist', `${Math.round(25 + Math.random() * 25)}vw`);
      streak.style.animationDuration = `${(0.7 + Math.random() * 0.5).toFixed(2)}s`;
      streak.addEventListener('animationend', () => streak.remove());
      starField.appendChild(streak);
    }

    // ---- Settings panel -------------------------------------------------
    // Preferences behind the gear in the bottom-left corner. Stored as a
    // single JSON object in localStorage, so adding a setting is just
    // another key - no storage migration. This only works because the page
    // is served over http(s): localStorage is per-origin and unavailable
    // under file:// (the same constraint that already forces bookmarks.json
    // to be fetched rather than opened from disk).
    const SETTINGS_KEY = 'newtab-settings';

    function loadSettings() {
      try {
        return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
      } catch (err) {
        // Corrupt or unreadable storage shouldn't take the page down.
        return {};
      }
    }

    function saveSettings(patch) {
      const next = Object.assign(loadSettings(), patch);
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      } catch (err) {
        // Quota or private-browsing failure: the choice still applies to
        // this tab, it just won't survive a reload.
      }
      return next;
    }

    // Every engine below takes its query in a "q" parameter, which is what
    // #search-input is already named - so switching engines is nothing more
    // than swapping the form's action URL. An engine using a different
    // parameter name would need its URL built in a submit handler instead.
    const SEARCH_ENGINES = [
      { id: 'duckduckgo', label: 'DuckDuckGo', action: 'https://duckduckgo.com/' },
      { id: 'google',     label: 'Google',     action: 'https://www.google.com/search' },
      { id: 'brave',      label: 'Brave',      action: 'https://search.brave.com/search' },
      { id: 'bing',       label: 'Bing',       action: 'https://www.bing.com/search' },
      { id: 'startpage',  label: 'Startpage',  action: 'https://www.startpage.com/sp/search' },
    ];

    function applySearchEngine(id) {
      const engine = SEARCH_ENGINES.find(e => e.id === id) || SEARCH_ENGINES[0];
      document.getElementById('search-form').action = engine.action;
      document.getElementById('search-input').placeholder = `Search ${engine.label}`;
    }

    // A hoisted declaration that re-reads storage per call, rather than
    // closing over a `let` - renderWeatherWidget (defined further up) calls
    // this, and this settings block runs last, so a `let` would sit in the
    // temporal dead zone if the weather fetch ever resolved first.
    // hourCycle 'h23' rather than hour12:false: the latter renders midnight
    // as "24:00" under some locales.
    function formatClock(date) {
      const opts = loadSettings().clock === '12h'
        ? { hour: 'numeric', minute: '2-digit', hour12: true }
        : { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
      return date.toLocaleTimeString([], opts);
    }

    // One labelled radio list per entry. Adding a setting means adding an
    // entry here; the panel markup builds itself from this table. `apply`
    // receives (value, isInit) - isInit is true during first paint, when
    // the page is already loading with the stored value and re-triggering
    // network work would just duplicate it.
    const SETTINGS_GROUPS = [
      {
        key: 'searchEngine',
        label: 'Search engine',
        fallback: 'duckduckgo',
        options: SEARCH_ENGINES.map(e => ({ id: e.id, label: e.label })),
        apply: (id) => applySearchEngine(id),
      },
      {
        key: 'clock',
        label: 'Clock',
        fallback: '24h',
        options: [
          { id: '24h', label: '24-hour' },
          { id: '12h', label: '12-hour' },
        ],
        // The widget only repaints itself once a minute, so repaint now to
        // make the format change visible immediately.
        apply: () => renderWeatherWidget(),
      },
      {
        key: 'tempUnit',
        label: 'Temperature',
        fallback: 'fahrenheit',
        options: [
          { id: 'fahrenheit', label: 'Fahrenheit' },
          { id: 'celsius', label: 'Celsius' },
        ],
        // Open-Meteo converts server-side, so changing units means asking
        // again. On init the pending first fetch already reads the setting.
        apply: (id, isInit) => {
          if (!isInit && lastCoords) updateWeather(lastCoords.lat, lastCoords.lng);
        },
      },
      {
        key: 'weatherFX',
        label: 'Weather effects',
        fallback: 'on',
        options: [
          { id: 'on', label: 'On' },
          { id: 'off', label: 'Off' },
        ],
        // Re-applying the last known category either tears the effects down
        // or brings them back, without another fetch.
        apply: (id, isInit) => {
          if (!isInit) applyWeatherFX(lastWeatherCategory);
        },
      },
      {
        key: 'nightSky',
        label: 'Night sky',
        fallback: 'on',
        options: [
          { id: 'on', label: 'On' },
          { id: 'off', label: 'Off' },
        ],
        // The first updateSky() call runs right after this loop and reads
        // the setting itself; only a live toggle needs a repaint here.
        apply: (id, isInit) => {
          if (!isInit) updateNightSky();
        },
      },
      {
        key: 'constellations',
        label: 'Constellations',
        fallback: 'lines',
        options: [
          { id: 'off', label: 'Off' },
          { id: 'lines', label: 'Lines' },
          { id: 'names', label: 'Lines and names' },
        ],
        // layoutSky() reads the setting; it's a no-op until the night
        // sky has been built.
        apply: (id, isInit) => {
          if (!isInit) layoutSky();
        },
      },
      {
        key: 'linkTarget',
        label: 'Bookmark links',
        fallback: 'same',
        options: [
          { id: 'same', label: 'Open in this tab' },
          { id: 'new', label: 'Open in a new tab' },
        ],
        // Rebuild the cards so existing links pick up the new target.
        apply: (id, isInit) => { if (!isInit) loadBookmarks(); },
      },
      {
        key: 'showBookmarks',
        label: 'Bookmark cards',
        fallback: 'on',
        options: [
          { id: 'on', label: 'Show' },
          { id: 'off', label: 'Hide' },
        ],
        apply: () => updateBookmarksVisibility(),
      },
      {
        key: 'location',
        label: 'Location',
        fallback: 'auto',
        options: [
          { id: 'auto', label: 'Automatic' },
          { id: 'custom', label: 'Custom' },
        ],
        extra: buildLocationExtra,
        apply: (id, isInit) => {
          syncLocationExtra();
          if (!isInit) startLocation();
        },
      },
    ];

    // Assigned when the location group's extra control is built; called by
    // that group's apply() to grey the input out under "Automatic".
    let syncLocationExtra = () => {};

    // Location needs more than a radio pair - "Custom" has to capture a
    // place. Names are resolved through Open-Meteo's geocoding API, the
    // same provider already supplying the forecast, so switching to a
    // custom location introduces no new third party.
    function buildLocationExtra() {
      const wrap = document.createElement('div');
      wrap.className = 'settings-extra';

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'settings-input';
      input.placeholder = 'City, e.g. Greenville,SC';
      input.setAttribute('aria-label', 'Custom location');
      input.value = loadSettings().locationLabel || '';

      const status = document.createElement('div');
      status.className = 'settings-status';

      syncLocationExtra = () => {
        const custom = loadSettings().location === 'custom';
        input.disabled = !custom;
        wrap.classList.toggle('disabled', !custom);
      };

      let lastResolved = input.value;

      async function lookupPlace(name) {
        const res = await fetch('https://geocoding-api.open-meteo.com/v1/search?count=1&name=' +
          encodeURIComponent(name));
        const data = await res.json();
        return (data.results && data.results[0]) || null;
      }

      async function resolvePlace() {
        const name = input.value.trim();
        // Don't re-query on every blur when nothing was retyped.
        if (!name || name === lastResolved) return;
        status.textContent = 'Looking up\u2026';
        try {
          let hit = await lookupPlace(name);
          // The API matches on a comma-joined token: "Greenville,SC"
          // resolves, but "Greenville SC" misses outright. Retry a
          // space-separated entry in the comma form before giving up.
          if (!hit && /\s/.test(name)) hit = await lookupPlace(name.replace(/\s+/g, ','));
          if (!hit) {
            status.textContent = 'No match found';
            return;
          }
          const label = [hit.name, hit.admin1, hit.country_code].filter(Boolean).join(', ');
          saveSettings({
            locationLat: hit.latitude,
            locationLng: hit.longitude,
            locationLabel: label,
          });
          input.value = label;
          lastResolved = label;
          status.textContent = '';
          applyLocation(hit.latitude, hit.longitude);
        } catch (err) {
          status.textContent = 'Lookup failed';
        }
      }

      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          resolvePlace();
        }
      });
      input.addEventListener('blur', resolvePlace);

      wrap.append(input, status);
      return wrap;
    }

    const settingsToggle = document.getElementById('settings-toggle');
    const settingsPanel = document.getElementById('settings-panel');

    for (const group of SETTINGS_GROUPS) {
      const stored = loadSettings()[group.key];
      // Ignore a stored value that no longer matches any option (e.g. an
      // engine that was removed from the table).
      const active = group.options.some(o => o.id === stored) ? stored : group.fallback;

      const wrap = document.createElement('div');
      wrap.className = 'settings-group';

      const label = document.createElement('div');
      label.className = 'settings-group-label';
      label.id = `settings-label-${group.key}`;
      label.textContent = group.label;

      const list = document.createElement('div');
      list.setAttribute('role', 'radiogroup');
      list.setAttribute('aria-labelledby', label.id);

      for (const option of group.options) {
        const row = document.createElement('label');
        row.className = 'settings-option';

        const input = document.createElement('input');
        input.type = 'radio';
        input.name = group.key;
        input.value = option.id;
        input.checked = option.id === active;
        input.addEventListener('change', () => {
          saveSettings({ [group.key]: option.id });
          group.apply(option.id, false);
        });

        const dot = document.createElement('span');
        dot.className = 'settings-dot';

        const text = document.createElement('span');
        text.textContent = option.label;

        row.append(input, dot, text);
        list.appendChild(row);
      }

      wrap.append(label, list);
      if (group.extra) wrap.appendChild(group.extra());
      settingsPanel.appendChild(wrap);

      // After the extra control exists, so apply() can reach it.
      group.apply(active, true);
    }

    // Kick off sky + weather now that the stored settings are readable
    // (the night sky reads them on every sky update). Deliberately after
    // the loop so each runs exactly once.
    updateSky();
    setInterval(updateSky, 60000);
    startLocation();


    // ---- Bookmark editor -------------------------------------------------
    // Edits bookmarks.json in place rather than keeping a second copy in
    // browser storage: the page regenerates the file and PUTs it back to
    // the local server (see the do_PUT guards in firefox-newtab-serve), so
    // the CSV stays the single source of truth and is still hand-editable,
    // greppable and committable.
    const editorEl = document.getElementById('bookmark-editor');
    const editorBody = document.getElementById('bookmark-editor-body');
    const editorStatus = document.getElementById('bookmark-editor-status');
    let editorModel = [];

    // Focus target to restore after renderEditor() rebuilds the DOM, set by
    // the move handlers so the arrow you just clicked stays under the
    // keyboard focus as its row travels.
    let editorPendingFocus = null;

    function moveWithin(arr, from, to) {
      if (to < 0 || to >= arr.length) return false;
      arr.splice(to, 0, arr.splice(from, 1)[0]);
      return true;
    }

    function makeMoveButton(glyph, label, disabled, focusKey, onClick) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bm-btn move';
      btn.textContent = glyph;
      btn.setAttribute('aria-label', label);
      btn.disabled = disabled;
      btn.dataset.fk = focusKey;
      btn.addEventListener('click', onClick);
      return btn;
    }

    // Returns the number of fields caught in a collision, so the save path
    // can use it as a guard as well as a highlighter.
    function markDuplicateKeys() {
      const inputs = Array.from(editorBody.querySelectorAll('.bm-key'));
      const counts = new Map();
      for (const input of inputs) {
        if (input.value) counts.set(input.value, (counts.get(input.value) || 0) + 1);
      }
      let clashing = 0;
      for (const input of inputs) {
        const bad = Boolean(input.value) && counts.get(input.value) > 1;
        input.classList.toggle('dupe', bad);
        if (bad) clashing++;
      }
      return clashing;
    }

    function renderEditor() {
      editorBody.innerHTML = '';

      editorModel.forEach((group, gi) => {
        const box = document.createElement('div');
        box.className = 'bm-category';

        const head = document.createElement('div');
        head.className = 'bm-row';

        const name = document.createElement('input');
        name.className = 'bm-cat-name';
        name.value = group.name;
        name.placeholder = 'Category name';
        name.setAttribute('aria-label', 'Category name');
        name.addEventListener('input', () => { group.name = name.value; });

        const catUp = makeMoveButton('\u2191', 'Move category up', gi === 0, `cat:${gi}:up`, () => {
          if (moveWithin(editorModel, gi, gi - 1)) {
            editorPendingFocus = `cat:${gi - 1}:up`;
            renderEditor();
          }
        });
        const catDown = makeMoveButton('\u2193', 'Move category down',
          gi === editorModel.length - 1, `cat:${gi}:down`, () => {
            if (moveWithin(editorModel, gi, gi + 1)) {
              editorPendingFocus = `cat:${gi + 1}:down`;
              renderEditor();
            }
          });

        const dropCat = document.createElement('button');
        dropCat.type = 'button';
        dropCat.className = 'bm-btn danger';
        dropCat.textContent = 'Remove';
        dropCat.addEventListener('click', () => {
          editorModel.splice(gi, 1);
          renderEditor();
        });

        head.append(name, catUp, catDown, dropCat);
        box.appendChild(head);

        group.links.forEach((link, li) => {
          const row = document.createElement('div');
          row.className = 'bm-row';

          const title = document.createElement('input');
          title.className = 'bm-title';
          title.value = link.title;
          title.placeholder = 'Title';
          title.setAttribute('aria-label', 'Link title');
          title.addEventListener('input', () => { link.title = title.value; });

          const url = document.createElement('input');
          url.className = 'bm-url';
          url.value = link.url;
          url.placeholder = 'https://…';
          url.setAttribute('aria-label', 'Link URL');
          url.addEventListener('input', () => { link.url = url.value; });

          const keyInput = document.createElement('input');
          keyInput.className = 'bm-key';
          keyInput.value = link.key || '';
          keyInput.maxLength = 1;
          keyInput.placeholder = 'k';
          keyInput.setAttribute('aria-label', 'Speedkey');
          keyInput.title = 'One letter or digit - opens this link with Alt+key';
          keyInput.addEventListener('input', () => {
            // Normalize on the way in so the field can only ever hold a
            // character the keydown handler will actually match.
            link.key = normalizeSpeedkey(keyInput.value);
            keyInput.value = link.key;
            markDuplicateKeys();
          });

          const up = makeMoveButton('\u2191', 'Move link up', li === 0, `lnk:${gi}:${li}:up`, () => {
            if (moveWithin(group.links, li, li - 1)) {
              editorPendingFocus = `lnk:${gi}:${li - 1}:up`;
              renderEditor();
            }
          });
          const down = makeMoveButton('\u2193', 'Move link down',
            li === group.links.length - 1, `lnk:${gi}:${li}:down`, () => {
              if (moveWithin(group.links, li, li + 1)) {
                editorPendingFocus = `lnk:${gi}:${li + 1}:down`;
                renderEditor();
              }
            });

          const drop = document.createElement('button');
          drop.type = 'button';
          drop.className = 'bm-btn danger';
          drop.textContent = '\u2715';
          drop.setAttribute('aria-label', 'Remove link');
          drop.addEventListener('click', () => {
            group.links.splice(li, 1);
            renderEditor();
          });

          row.append(title, url, keyInput, up, down, drop);
          box.appendChild(row);
        });

        const addLink = document.createElement('button');
        addLink.type = 'button';
        addLink.className = 'bm-btn';
        addLink.textContent = '+ Add link';
        addLink.addEventListener('click', () => {
          group.links.push({ title: '', url: '', key: '' });
          renderEditor();
          // renderEditor() rebuilt the DOM, so re-find this group's card
          // and focus the title field of the row just added.
          const card = editorBody.querySelectorAll('.bm-category')[gi];
          if (card) {
            const titles = card.querySelectorAll('.bm-title');
            if (titles.length) titles[titles.length - 1].focus();
          }
        });
        box.appendChild(addLink);

        editorBody.appendChild(box);
      });

      if (editorPendingFocus) {
        const target = editorBody.querySelector(`[data-fk="${editorPendingFocus}"]`);
        editorPendingFocus = null;
        if (target && !target.disabled) {
          target.focus();
        } else if (target) {
          // The row reached an end and that arrow is now disabled; fall back
          // to the opposite one so focus doesn't drop to the document.
          const alt = target.parentElement.querySelector('.bm-btn.move:not(:disabled)');
          if (alt) alt.focus();
        }
      }

      markDuplicateKeys();
    }

    async function openBookmarkEditor() {
      editorStatus.textContent = '';
      editorModel = [];
      try {
        // cache:no-store so a save made in another tab isn't masked by a
        // stale copy of the file.
        const res = await fetch(DATA_BASE + 'bookmarks.json', { cache: 'no-store' });
        // The file's shape is the editor's shape, so this is a straight
        // load - no regrouping on the way in, no flattening on the way out.
        editorModel = parseBookmarksDoc(await res.json());
      } catch (err) {
        editorStatus.textContent = 'Could not read bookmarks.json';
      }
      renderEditor();
      editorEl.hidden = false;
      const first = editorBody.querySelector('input');
      if (first) first.focus();
    }

    function closeBookmarkEditor() {
      editorEl.hidden = true;
      document.getElementById('search-input').focus();
    }

    async function saveBookmarkEditor() {
      if (markDuplicateKeys()) {
        editorStatus.textContent = 'Two links share a speedkey - each must be unique';
        return;
      }
      editorStatus.textContent = 'Saving…';
      // Drop rows left blank and categories left unnamed - they'd otherwise
      // render as empty cards.
      const categories = editorModel
        .map((group) => ({
          name: group.name.trim(),
          links: group.links
            .map((link) => {
              // Omit the key entirely when unset rather than writing an
              // empty string - keeps the file clean for hand-editing.
              const row = { title: link.title.trim(), url: link.url.trim() };
              const key = normalizeSpeedkey(link.key || '');
              if (key) row.key = key;
              return row;
            })
            .filter((link) => link.title || link.url),
        }))
        .filter((group) => group.name);
      try {
        const res = await fetch(DATA_BASE + 'bookmarks.json', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: 1, categories }, null, 2) + '\n',
        });
        if (!res.ok) throw new Error(`server returned ${res.status}`);
        await loadBookmarks();
        closeBookmarkEditor();
      } catch (err) {
        // Most likely the server predates the PUT handler or rejected the
        // origin. Either way bookmarks.json on disk is untouched, so the
        // dialog stays open with the edits intact.
        editorStatus.textContent = `Save failed: ${err.message}`;
      }
    }

    document.getElementById('bookmark-editor-add-category').addEventListener('click', () => {
      editorModel.push({ name: '', links: [{ title: '', url: '', key: '' }] });
      renderEditor();
      const names = editorBody.querySelectorAll('.bm-cat-name');
      if (names.length) names[names.length - 1].focus();
    });
    document.getElementById('bookmark-editor-cancel').addEventListener('click', closeBookmarkEditor);
    document.getElementById('bookmark-editor-save').addEventListener('click', saveBookmarkEditor);

    // Backdrop click closes; clicks on the card itself must not.
    editorEl.addEventListener('click', (event) => {
      if (event.target === editorEl) closeBookmarkEditor();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !editorEl.hidden) closeBookmarkEditor();
    });

    // Bookmarks get a launcher rather than a radio group - see above.
    const bmGroup = document.createElement('div');
    bmGroup.className = 'settings-group';
    const bmLabel = document.createElement('div');
    bmLabel.className = 'settings-group-label';
    bmLabel.textContent = 'Bookmarks';
    const bmButton = document.createElement('button');
    bmButton.type = 'button';
    bmButton.className = 'bm-btn';
    bmButton.textContent = 'Edit links…';
    bmButton.addEventListener('click', () => {
      setSettingsOpen(false);
      openBookmarkEditor();
    });
    bmGroup.append(bmLabel, bmButton);
    settingsPanel.appendChild(bmGroup);

    // Reset sits last and confirms in place rather than through a modal -
    // one stray click shouldn't wipe every setting, but a blocking
    // confirm() dialog would be heavier than this warrants.
    const resetGroup = document.createElement('div');
    resetGroup.className = 'settings-group';
    const resetLabel = document.createElement('div');
    resetLabel.className = 'settings-group-label';
    resetLabel.textContent = 'Reset';
    const resetButton = document.createElement('button');
    resetButton.type = 'button';
    resetButton.className = 'bm-btn';
    resetButton.textContent = 'Reset settings';
    const resetNote = document.createElement('div');
    resetNote.className = 'settings-status';
    resetNote.textContent = 'Bookmarks are not affected.';

    let resetArmTimer = null;

    function disarmReset() {
      resetArmTimer = null;
      resetButton.textContent = 'Reset settings';
      resetButton.classList.remove('armed');
    }

    resetButton.addEventListener('click', () => {
      if (resetArmTimer !== null) {
        clearTimeout(resetArmTimer);
        try {
          localStorage.removeItem(SETTINGS_KEY);
        } catch (err) {
          // Nothing stored, or storage unavailable - reloading still
          // restores defaults for this tab.
        }
        // Reload rather than re-applying each group by hand: it re-runs the
        // whole init path, so nothing can be left half-reverted.
        location.reload();
        return;
      }
      resetButton.textContent = 'Click again to confirm';
      resetButton.classList.add('armed');
      resetArmTimer = setTimeout(disarmReset, 4000);
    });

    resetGroup.append(resetLabel, resetButton, resetNote);
    settingsPanel.appendChild(resetGroup);

    function settingsOpen() {
      return settingsPanel.classList.contains('visible');
    }

    function setSettingsOpen(open) {
      settingsPanel.classList.toggle('visible', open);
      settingsToggle.classList.toggle('open', open);
      settingsToggle.setAttribute('aria-expanded', String(open));
      if (open) {
        // Focus the first checked option so arrow keys work straight away.
        const checked = settingsPanel.querySelector('input:checked');
        if (checked) checked.focus();
      } else {
        // Hand focus back to the search box rather than to the gear: a
        // focused search box is this page's resting state (see the
        // autofocus note above), so closing settings should restore it.
        document.getElementById('search-input').focus();
      }
    }

    settingsToggle.addEventListener('click', (event) => {
      event.stopPropagation();
      setSettingsOpen(!settingsOpen());
    });

    // Clicks landing inside the panel shouldn't count as "clicked away".
    settingsPanel.addEventListener('click', (event) => event.stopPropagation());

    document.addEventListener('click', () => {
      if (settingsOpen()) setSettingsOpen(false);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && settingsOpen()) setSettingsOpen(false);
    });

    // event.key carries the plain character for Alt chords on Linux, but the
    // length guard matters: pressing Alt by itself reports key === 'Alt',
    // whose first character would otherwise register as a stray 'a'.
    // event.code is the fallback for layouts where Alt does rewrite the key.
    function speedkeyFromEvent(event) {
      if (typeof event.key === 'string' && event.key.length === 1) {
        const ch = event.key.toLowerCase();
        if (/[a-z0-9]/.test(ch)) return ch;
      }
      const m = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(event.code || '');
      return m ? (m[1] || m[2]).toLowerCase() : '';
    }

    // Alt+<key> jumps straight to a bookmark. Alt rather than a bare letter
    // because #search-input holds focus by design (see the autofocus note
    // near the top of this script), so unmodified keys have to keep flowing
    // into the search box. Clicking the anchor rather than assigning
    // location reuses whatever target/rel loadBookmarks already set from the
    // linkTarget setting, instead of duplicating that decision here.
    document.addEventListener('keydown', (event) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;
      // Navigating away mid-edit would silently discard unsaved edits.
      if (!editorEl.hidden) return;
      const link = speedkeyLinks.get(speedkeyFromEvent(event));
      if (!link) return;
      event.preventDefault();
      link.click();
    });
    // ---------------------------------------------------------------
    // Easter eggs. Mostly triggers for machinery that already existed:
    // startTimeDemo/applyWeatherFX were written as console-only dev tools
    // (see README) and are just given a way in from the keyboard here.
    // ---------------------------------------------------------------

    // Paw prints tracking diagonally across the scene, back-left to
    // front-right, staggered so they read as footsteps rather than a
    // single burst. Each removes itself when its animation ends.
    function pawBurst(count = 14) {
      const scene = document.querySelector('.scene');
      for (let i = 0; i < count; i += 1) {
        const t = count > 1 ? i / (count - 1) : 0;
        const print = document.createElement('img');
        print.className = 'paw-print';
        print.src = 'resources/paw-orange.png';
        print.alt = '';
        print.style.left = `${6 + t * 82 + (Math.random() * 5 - 2.5)}vw`;
        print.style.top = `${72 - t * 30 + (Math.random() * 7 - 3.5)}vh`;
        print.style.setProperty('--paw-rot', `${-26 + t * 52 + (Math.random() * 18 - 9)}deg`);
        print.style.animationDelay = `${(t * 1.15).toFixed(2)}s`;
        print.addEventListener('animationend', () => print.remove());
        scene.appendChild(print);
      }
    }

    // A flying saucer. Summoned by clicking the moon, by asking the search
    // box to take you to its leader, or - rarely - by itself on a clear
    // night (see scheduleShootingStar). It comes in from one side, stops
    // over something for a moment with its beam on, then leaves in a
    // hurry. Lives in .scene at z-index 15 - above the clouds, behind the
    // skyline - and outside #star-field, so it isn't dimmed with the
    // stars and can be summoned by day from the console. One at a time:
    // a second summons while one is on screen is ignored. Three nested
    // wrappers because the flight path, the constant bobbing and the
    // lean into the turn are each their own transform.
    function spawnUfo({ duration = 7000 } = {}) {
      if (reducedMotion.matches || document.querySelector('.ufo')) return;
      const scene = document.querySelector('.scene');
      const ufo = document.createElement('div');
      ufo.className = 'ufo';
      ufo.setAttribute('aria-hidden', 'true');
      const lights = [['10', '#FF6B6B'], ['21', '#FFD166'], ['32', '#6BFFB8'], ['43', '#6BC9FF'], ['54', '#FF8BE6']]
        .map(([x, color], i) => `<circle class="ufo-light" cx="${x}" cy="21.5" r="1.7" fill="${color}" style="animation-delay: ${(-i * 0.24).toFixed(2)}s"></circle>`)
        .join('');
      ufo.innerHTML =
        '<div class="ufo-bob"><div class="ufo-tilt">'
        + '<div class="ufo-beam"></div>'
        + '<svg viewBox="0 0 64 32" aria-hidden="true">'
        + '<ellipse cx="32" cy="12" rx="10" ry="8.5" fill="rgba(190, 240, 255, 0.55)" stroke="rgba(230, 250, 255, 0.9)" stroke-width="0.8"></ellipse>'
        + '<ellipse cx="29" cy="9" rx="3.5" ry="2" fill="rgba(255, 255, 255, 0.55)"></ellipse>'
        + '<ellipse cx="32" cy="19.5" rx="29" ry="6.5" fill="#6F778A"></ellipse>'
        + '<ellipse cx="32" cy="18" rx="29" ry="5" fill="#AEB6C6"></ellipse>'
        + '<ellipse cx="32" cy="17" rx="22" ry="2.6" fill="rgba(255, 255, 255, 0.25)"></ellipse>'
        + '<ellipse cx="32" cy="24" rx="12" ry="1.8" fill="rgba(170, 255, 220, 0.35)"></ellipse>'
        + lights
        + '</svg></div></div>';
      scene.appendChild(ufo);

      // Left to right or right to left, a stop somewhere in the middle of
      // the sky, and an exit that climbs and accelerates.
      const dir = Math.random() < 0.5 ? 1 : -1;
      const y = 12 + Math.random() * 24;
      const hoverX = 30 + Math.random() * 40;
      const at = (x, dy = 0) => `translate(${x}vw, ${(y + dy).toFixed(1)}vh)`;
      const flight = ufo.animate([
        { transform: at(dir > 0 ? -12 : 112), easing: 'cubic-bezier(0.2, 0.8, 0.4, 1)' },
        { transform: at(hoverX, 3), offset: 0.32, easing: 'linear' },
        { transform: at(hoverX + dir * 1.5, 3), offset: 0.62, easing: 'cubic-bezier(0.7, 0, 1, 0.6)' },
        { transform: at(dir > 0 ? 116 : -16, -12) },
      ], { duration, fill: 'forwards' });
      ufo.querySelector('.ufo-tilt').animate([
        { transform: `rotate(${dir * 9}deg)`, easing: 'ease-out' },
        { transform: 'rotate(0deg)', offset: 0.32 },
        { transform: 'rotate(0deg)', offset: 0.62, easing: 'ease-in' },
        { transform: `rotate(${dir * 12}deg)` },
      ], { duration, fill: 'forwards' });
      ufo.querySelector('.ufo-beam').animate([
        { opacity: 0, offset: 0 },
        { opacity: 0, offset: 0.34 },
        { opacity: 1, offset: 0.42 },
        { opacity: 1, offset: 0.55 },
        { opacity: 0, offset: 0.62 },
        { opacity: 0, offset: 1 },
      ], { duration, fill: 'forwards' });
      const leave = () => ufo.remove();
      flight.finished.then(leave, leave);
      setTimeout(leave, duration + 1000); // in case the tab was hidden throughout
    }

    let orangeWashTimer = null;

    function flashOrange(ms = 4500) {
      document.body.classList.add('orange-wash');
      clearTimeout(orangeWashTimer);
      orangeWashTimer = setTimeout(() => {
        // Game day holds the wash for the whole session; a temporary
        // flash must not clear it out from under that.
        if (!document.body.classList.contains('gameday')) {
          document.body.classList.remove('orange-wash');
        }
      }, ms);
    }

    // Five clicks on the corner paw. The window resets 1.5s after the
    // last click so ordinary stray clicks never accumulate into it.
    (() => {
      const paw = document.getElementById('paw');
      let clicks = 0;
      let resetId = null;
      paw.addEventListener('click', () => {
        clicks += 1;
        clearTimeout(resetId);
        resetId = setTimeout(() => { clicks = 0; }, 1500);
        if (clicks >= 5) {
          clicks = 0;
          pawBurst(16);
        }
      });
    })();

    // Konami code -> one full sunrise-to-midnight cycle in 20 seconds.
    // loop:false means startTimeDemo stops itself at the end and hands
    // the sky back to the real clock.
    const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown',
                    'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
    let konamiAt = 0;

    document.addEventListener('keydown', (event) => {
      const got = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      if (got === KONAMI[konamiAt]) {
        konamiAt += 1;
      } else {
        // A mismatch can still be a fresh start on the first key.
        konamiAt = got === KONAMI[0] ? 1 : 0;
      }
      if (konamiAt < KONAMI.length) return;
      konamiAt = 0;
      // The b and a landed in the search box on the way past.
      document.getElementById('search-input').value = '';
      startTimeDemo({ cycleDurationSeconds: 20, loop: false });
    });

    // Escape bails out of the time-lapse early.
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && demoIntervalId !== null) stopTimeDemo();
    });

    // Phrases that do something instead of searching. Anything not listed
    // here submits to the search engine exactly as before.
    // Deliberately only phrases nobody would type into a search box on
    // purpose. Bare weather words like "snow" or "rain" were here and
    // were removed: they're plausible real searches, and silently
    // swallowing one is worse than the egg is fun.
    const SEARCH_SPELLS = {
      'go tigers':    () => pawBurst(18),
      'solid orange': () => flashOrange(),
      'death valley': () => applyWeatherFX('storm'),
      'take me to your leader': () => spawnUfo(),
    };

    document.getElementById('search-form').addEventListener('submit', (event) => {
      const input = document.getElementById('search-input');
      const spell = SEARCH_SPELLS[input.value.trim().toLowerCase()];
      if (!spell) return; // fall through to a real search
      event.preventDefault();
      input.value = '';
      spell();
    });

    // Autumn Saturdays. Unlike the others this one isn't hidden - it is
    // meant to find you. Call applyGameDay() from the console to preview
    // it on any other day.
    function isGameDay(now = new Date()) {
      const month = now.getMonth(); // 0-based: 7=Aug, 10=Nov
      return now.getDay() === 6 && month >= 7 && month <= 10;
    }

    function applyGameDay() {
      if (document.getElementById('gameday-mark')) return; // already on
      document.body.classList.add('gameday', 'orange-wash');
      const mark = document.createElement('div');
      mark.id = 'gameday-mark';
      mark.textContent = 'GO TIGERS';
      document.querySelector('.scene').appendChild(mark);
    }

    if (isGameDay()) applyGameDay();

    // Optional resilience layer, OFF by default because it is not free:
    // profiled 2026-08-27, routing every request through a service
    // worker cost ~15ms of first-contentful-paint and ~40ms of load
    // time per tab. What it buys is a working new tab while the server
    // is down (network-first, so it never serves stale code while the
    // server is up); the systemd unit's Restart= covers that case well
    // enough for the default. Opt in from any new-tab console with
    //   localStorage.setItem('newtab-offline-fallback', 'on')
    // and opt back out by removing the key - the else branch tears the
    // worker down on the next load. Skipped in the extension build:
    // moz-extension pages load from disk and need no fallback.
    if (!IS_EXTENSION && 'serviceWorker' in navigator) {
      if (localStorage.getItem('newtab-offline-fallback') === 'on') {
        navigator.serviceWorker.register('sw.js').catch((err) => {
          console.warn('Service worker registration failed:', err);
        });
      } else {
        navigator.serviceWorker.getRegistrations()
          .then((regs) => regs.forEach((r) => r.unregister()))
          .catch(() => {});
      }
    }
