<img src="icons/geckoshot.svg" width="96" height="96" alt="">

# GeckoShot

The **Take Screenshot** tool from Firefox, for Chrome, Edge, Brave, Helium and
other Chromium-based browsers.

Click the toolbar button (or press `Ctrl+Shift+S`) and the page dims. Hover to
highlight a paragraph, image or card and click to grab it, or drag out any
region you like. Then copy it to the clipboard or download it as a PNG. You can
also save the whole visible area or the entire page in one click.

It isn't a lookalike: it's built from the source code of Firefox's own
Screenshots feature, so it picks elements, handles the keyboard and names files
the same way Firefox does. The look is restyled to fit in with
[Helium](https://github.com/imputnet/helium).

## Install

GeckoShot isn't in the Chrome Web Store yet. Get the latest version from the
[Releases page](https://github.com/Neppkun/GeckoShot/releases/latest).

**Chrome, Edge, Brave and Vivaldi** (these only allow store extensions to be
installed from a file, so use the ZIP):

1. Download `geckoshot-<version>.zip` and unzip it somewhere you'll keep it.
2. Open `chrome://extensions` (`edge://extensions` in Edge) and turn on
   **Developer mode**.
3. Click **Load unpacked** and choose the unzipped folder.

**Helium, ungoogled-chromium, or Chromium on Linux:** download
`geckoshot-<version>.crx` and drag it onto `chrome://extensions`.

Then optionally pin the GeckoShot button to your toolbar.

## How to use it

Start a screenshot in any of three ways:

- Click the GeckoShot button in the toolbar.
- Press `Ctrl+Shift+S` (`⌘+Shift+S` on a Mac). You can change the shortcut at
  `chrome://extensions/shortcuts`.
- Right-click the page and choose **Take Screenshot**.

Then:

| To… | Do this |
| --- | --- |
| Grab one element | Hover until it's outlined, then click |
| Grab any area | Drag across it; drag near an edge to scroll |
| Adjust the area | Drag the handles, or drag the middle to move it |
| Nudge with the keyboard | Arrow keys (hold `Shift` for 10px, `Ctrl` to jump to the edge) |
| Copy | **Copy** or `Ctrl+C` |
| Save as PNG | **Download** or `Ctrl+S` |
| Capture what's on screen | **Save visible** (top right) |
| Capture the whole page | **Save full page** (top right) |
| Start over or quit | `Esc` (once goes back, twice closes) |

**Save visible** and **Save full page** open a preview first, where you can
copy, download, retry or cancel.

Files are named like the ones Firefox saves, for example
`Screenshot 2026-10-22 at 14-03-51 Page title.png`, and go wherever your
browser saves downloads. If you've set your browser to ask where to save files,
it will ask here too.

The extension is available in 50 languages, using Firefox's own translations.

## Good to know

- **Full-page and very tall screenshots scroll the page.** Extensions can only
  capture what's on screen, so the page is captured piece by piece and stitched
  together, at roughly two pieces per second. Sticky headers are kept only once.
- **It can't run on browser pages** such as `chrome://` pages, the Chrome Web
  Store, or the built-in PDF viewer. Browsers don't allow extensions there.
- **Embedded content from other sites** (some videos, ads, social widgets) is
  highlighted as one block rather than piece by piece.

## Privacy

Nothing leaves your browser. The extension makes no network requests and
collects no data. It only runs on a tab when you start a screenshot there.

It asks for these permissions:

| Permission | Why |
| --- | --- |
| Active tab, scripting | Show the screenshot overlay on the tab you clicked |
| Downloads | Save the PNG |
| Clipboard write | Copy the screenshot |
| Context menus | The **Take Screenshot** right-click item |
| Notifications | Tell you if a screenshot was too large and got cropped |
| Storage | Remember whether you last used Copy or Download |

## Contributing

Bug reports and pull requests are welcome. To run the automated tests:

```sh
npm install
npx playwright install chromium
npm test
```

The tests load the extension into a real Chromium and use it the way a person
would. `HEADED=1 npm test` lets you watch. `npm run build` writes the CRX and
ZIP to `dist/`.

If you use an AI coding agent, point it at [AGENTS.md](AGENTS.md). Among other
things, it requires agents to say which model they are and how involved a
human was in each contribution.

## Credits

- The screenshot code, the in-page icons and the translations come from
  [Mozilla Firefox](https://github.com/mozilla-firefox/firefox) and its
  [translation community](https://github.com/mozilla-l10n/firefox-l10n).
- The name is a nod to Gecko, Firefox's engine, and to the lizard on the
  icon.
- The visual design follows [Helium](https://github.com/imputnet/helium) by
  imput.
- The port was written by Claude Opus 5.5 (`claude-opus-5-5`), an AI model,
  directed by Neppkun: they set the goal and the Helium look, chose how the
  instructions bubble should behave, asked for the simplifications, and
  reported bugs from real use. The model wrote the code, tests and docs.

## License

[Mozilla Public License 2.0](LICENSE), the same license as the Firefox code
it's based on.

Firefox is a trademark of the Mozilla Foundation, and Gecko is a trademark of
Netscape Communications. This project is not affiliated with or endorsed by
Mozilla, Netscape or Helium.
