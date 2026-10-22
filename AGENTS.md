# AGENTS.md

Instructions for AI coding agents working in this repository. Read the whole
file before changing anything.

## Attribution (required)

Every contribution you make must say exactly which model you are and how much
a human was involved. This applies to every commit, pull request, and any
changelog or release-note entry you write.

**Commits:** end the message with these two trailers:

```
Assisted-by: <model name> (<exact model ID>)
Human-involvement: <level> - <one sentence on what the human did>
```

**Pull requests:** put the same two lines at the end of the description. If
several models contributed, add one `Assisted-by` line per model.

Rules:

- **Name the exact model and ID**, for example
  `Assisted-by: Claude Opus 5.5 (claude-opus-5-5)`. Generic credits like "AI",
  "an LLM", "Claude", "Copilot" or a tool name without the model are not
  acceptable.
- **Never guess.** If you can't determine your exact model or ID, write
  `unknown` for the part you don't know and say so in the description.
- **Pick the level that matches what actually happened:**

  | Level | Meaning |
  | --- | --- |
  | `none` | Agent acted without a human prompt for this change (scheduled or autonomous run) |
  | `prompted` | Human gave the task; the agent made every decision and wrote all of it |
  | `directed` | Human steered decisions along the way (design choices, corrections, bug reports) or reviewed iterations; the agent wrote the code |
  | `co-authored` | Human wrote or edited part of the change themselves |

- **Don't overstate or understate.** If the human only said "fix the tests",
  that's `prompted`, not `directed`. If they rejected your approach and chose a
  different one, that's `directed`.
- These trailers come in addition to any attribution your tooling adds, not
  instead of it.

Example:

```
Stitch tall regions from the user's scroll position

Capture the first tile where the user was looking so fixed headers
don't appear over a region they never covered.

Assisted-by: Claude Opus 5.5 (claude-opus-5-5)
Human-involvement: directed - reported the duplicated header and approved the fix
```

## What this is

GeckoShot is a Manifest V3 extension that ports Firefox's Screenshots feature
(`browser/components/screenshots` at
[`e33ac8a9`](https://github.com/mozilla-firefox/firefox/tree/e33ac8a9b64e3946a203af8df5b2aa1bb4711d5c/browser/components/screenshots))
to Chromium. The behaviour is Firefox's, while the look follows the Helium
browser. There is no build step: the files in the repo are what ships.

## Layout

| File | Role | Firefox origin |
| --- | --- | --- |
| `manifest.json` | Permissions, `Ctrl+Shift+S` (`_execute_action`), web-accessible CSS/icons | `ScreenshotsCustomizableWidget`, `key_screenshot` |
| `background.js` | Toolbar/context-menu entry points, injects the content scripts, `captureVisibleTab` (rate-limited), downloads, notifications | Privileged half of `ScreenshotsUtils.sys.mjs` |
| `content/overlayHelpers.js` | `Region`, `WindowDimensions`, element detection, anonymous-content emulation, `l10n()` | `overlayHelpers.mjs` |
| `content/ScreenshotsOverlayChild.js` | `ScreenshotsOverlay`: the selection state machine and DOM | `ScreenshotsOverlayChild.sys.mjs` |
| `content/ScreenshotsUtils.js` | Controller: event interception, panel, preview, capture/stitching, copy, download | `ScreenshotsComponentChild.sys.mjs` + `ScreenshotsUtils.sys.mjs` |
| `content/screenshots-buttons.js` | Save visible / Save full page panel | `screenshots-buttons.js` |
| `content/screenshots-preview.js` | Preview `<dialog>` | `screenshots-preview.mjs` |
| `content/fileHelpers.js` | PNG filename | `fileHelpers.mjs` |
| `content/clipboard.html/.js` | Copy fallback for insecure (`http:`) pages | none (Chromium-only) |
| `content/screenshots.css` | All UI styles: Firefox's layout, Helium's look | `overlay.css` and friends |
| `content/icons/` | Firefox SVG icons, used as CSS masks | toolkit/browser icons |
| `icons/geckoshot.svg` | Extension icon (gecko on a camera); `icons/icon-*.png` are renders of it at 16/32/48/128px | none (original) |
| `_locales/` | Generated from Firefox's Fluent files; don't hand-edit | `screenshots.ftl` etc. |
| `tools/import-firefox-l10n.py` | Regenerates `_locales/` | none |
| `test/e2e.mjs`, `test/page.html` | End-to-end test in Playwright Chromium | none |
| `tools/build.mjs` | `npm run build`: packages `dist/geckoshot-<version>.crx` and `.zip` | none |
| `.github/workflows/ci.yml` | Tests every push/PR; on a `v*` tag, builds and publishes a GitHub Release | none |

## How it fits together

- `background.js` injects the content scripts on the first click, in the order
  listed in `CONTENT_SCRIPTS`, then calls `ScreenshotsUtils.toggle()`. All
  content scripts share one isolated world. Top-level `class`/`const`
  declarations are globals there and must not be declared twice. Keep the load
  order: helpers first, `ScreenshotsUtils.js` last.
- The overlay lives in an open shadow root on a `<moz-screenshots>` host that
  is shown as a manual popover (top layer), absolutely positioned at the
  document origin. See `insertAnonymousContent()`.
- `ScreenshotsUtils` listens on `window` in the capture phase, prevents the
  page from seeing input, and calls `overlay.handleEvent()`. The overlay calls
  `ScreenshotsUtils` methods directly; there is no message passing inside the
  page.
- Capturing works one viewport at a time: `captureVisibleTab` per tile,
  stitched on a canvas, with fixed/sticky elements hidden after the first
  tile, and the scroll position restored afterwards.

## Things that will bite you

- **Content scripts can't define custom elements** (`customElements` is null
  in isolated worlds). Use plain elements.
- **Don't put `style="…"` in markup strings.** Strict page CSPs can block
  parsed style attributes. Set styles through CSSOM (`el.style.x = …`) or use
  classes in `screenshots.css`.
- **No `context-fill`/`context-stroke` in SVGs.** Chromium understands them as
  `none` outside `<use>`/markers, so icons render invisible. Icons are masks
  over `currentColor`. Strip those attributes from any new Firefox SVG.
- **`chrome.dom.openOrClosedShadowRoot()` throws** for non-HTML elements. Use
  the `openOrClosedShadowRoot()` wrapper in `overlayHelpers.js`.
- **`__` is not allowed inside `_locales` message names**, because it ends a
  `__MSG_name__` reference in the manifest. Attributes map to `<id>_<attr>`.
  Look strings up with `l10n("fluent-id.attr")`.
- **The host's inline `all: initial` resets inherited properties**, so
  anything that must inherit (like `color-scheme`) has to be set inline on the
  host.
- **`captureVisibleTab` is limited to 2 calls per second.** `background.js`
  queues calls; don't add parallel captures.
- **Use LF line endings and UTF-8.** On Windows, Python's `write_text`
  produces CRLF unless you pass `newline="\n"`. Keep invisible characters
  escaped (`‎`), never literal.

## Conventions

- **Port, don't reinvent.** Behaviour should match Firefox. When you change
  something from upstream, leave a short comment saying what Firefox does and
  why this differs.
- **Don't copy architecture that does nothing here.** IPC layers, telemetry,
  per-browser state, and the mini-window mode were deliberately removed. Don't
  bring back layers that only exist because Firefox has separate processes.
- **Prefer the simplest thing that works**, and keep changes small. Mark
  deliberate shortcuts with a `ponytail:` comment naming the limit.
- **Match the surrounding style:** 2-space indent, double quotes, Firefox's
  comment style.
- **Every source file keeps the MPL-2.0 header.**
- **Design values follow Helium's UI patches**
  (`imputnet/helium/patches/helium/ui`). Helium is GPL-3.0: take design
  values only, never copy its code.
- **Don't use "Firefox" or "Helium" as branding** (name, icon, store listing).
  Saying "based on code from Mozilla Firefox" is fine. "GeckoShot" refers to
  the lizard on the icon. Don't add Firefox or Mozilla imagery (foxes, logos)
  that would turn it into a reference to the engine.
- **If you change `icons/geckoshot.svg`, re-render every `icons/icon-*.png`**
  from it at the same sizes.

## Testing

```sh
npm install
npx playwright install chromium
npm test
```

- The test copies the extension to a temp folder and adds `<all_urls>` host
  access, since `activeTab` needs a real click. It also launches Chromium with
  `--disable-features=DisableLoadExtensionCommandLineSwitch`, because
  `--load-extension` is ignored otherwise.
- `npm test` must pass before you commit. Add a test step for every bug you fix
  or behaviour you add, and reproduce the bug in the test before fixing it.
- `HEADED=1` shows the browser. `SCREENSHOTS_OUT=<dir>` keeps per-step
  screenshots, so look at them after UI changes.
- After UI changes, also check a real site in both light and dark mode
  (Playwright `colorScheme`).

## Building and releasing

- `npm run build` packages only the shipped files (`SHIPPED` in
  `tools/build.mjs`). If you add a top-level file or folder the extension
  needs at runtime, add it there too.
- The CRX is signed with the `CRX_PRIVATE_KEY` repository secret, which fixes
  the extension ID (`ekblcghnfjnonhcjfkejigolmpelmeph`). Locally the key is
  `geckoshot.pem` (git-ignored). Never commit a key, never print it, and
  never replace the secret: a new key means a new extension ID and breaks
  existing installs. CI refuses to build without it.
- To release: bump `version` in `manifest.json`, commit, then tag `v<version>`
  and push the tag. The workflow fails if the tag and manifest disagree. Only
  release when the human asks.

## Translations

Never edit `_locales/*/messages.json` by hand. To add a string, add its Fluent
id to `WANTED` in `tools/import-firefox-l10n.py` and regenerate (see the
script's docstring for the two checkouts it needs). Only strings that exist in
Firefox can be used, so every locale stays translated.
