// End-to-end check: loads the unpacked extension in Playwright's Chromium,
// drives the overlay with real input and checks the saved/copied images.
//
//   npm install && npx playwright install chromium && npm test
//
// The test copy of the extension gets <all_urls> host access, because
// activeTab is only granted by a real toolbar click / shortcut.

import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "screenshots-e2e-"));
const extDir = path.join(tmp, "ext");
const outDir = process.env.SCREENSHOTS_OUT || path.join(tmp, "out");
fs.mkdirSync(outDir, { recursive: true });
for (const entry of ["manifest.json", "background.js", "content", "icons", "_locales"]) {
  fs.cpSync(path.join(root, entry), path.join(extDir, entry), { recursive: true });
}
const manifest = JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json")));
manifest.host_permissions = ["<all_urls>"];
fs.writeFileSync(path.join(extDir, "manifest.json"), JSON.stringify(manifest));

// Test page, plus a copy served with a strict CSP.
const page = fs.readFileSync(path.join(import.meta.dirname, "page.html"));
const server = http.createServer((req, res) => {
  const headers = { "content-type": "text/html" };
  if (req.url.startsWith("/csp")) {
    headers["content-security-policy"] =
      "default-src 'none'; style-src 'unsafe-inline'; require-trusted-types-for 'script'";
  }
  res.writeHead(200, headers).end(page);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://localhost:${server.address().port}`;

const context = await chromium.launchPersistentContext(path.join(tmp, "profile"), {
  channel: "chromium",
  headless: !process.env.HEADED,
  viewport: { width: 1000, height: 700 },
  deviceScaleFactor: 1,
  acceptDownloads: true,
  args: [
    // Chromium 137+ ignores --load-extension unless this feature is disabled.
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    // A hostname that isn't localhost, so pages on it are insecure contexts.
    "--host-resolver-rules=MAP insecure.test 127.0.0.1",
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
  ],
});
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));

// Playwright saves downloads under GUID names; record the requested filename.
await worker.evaluate(() => {
  let download = chrome.downloads.download;
  chrome.downloads.download = options => {
    self.requestedFilename = options.filename;
    return download(options);
  };
});

const tab = await context.newPage();
const errors = [];
tab.on("pageerror", e => errors.push(e));
tab.on("console", m => m.type() === "error" && errors.push(m.text()));

/** Simulate the toolbar button. */
async function toggle() {
  await worker.evaluate(async () => {
    let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await toggle(tab);
  });
}

/** PNG width/height from the IHDR chunk. */
function pngSize(buffer) {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function pixelAt(buffer, x, y) {
  return tab.evaluate(
    async ({ data, x, y }) => {
      let bitmap = await createImageBitmap(await (await fetch(data)).blob());
      let canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      let ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      return [...ctx.getImageData(x, y, 1, 1).data.slice(0, 3)];
    },
    { data: `data:image/png;base64,${buffer.toString("base64")}`, x, y }
  );
}

let seenDownloads = 0;
/** Waits for the next completed download. */
async function nextDownload() {
  let item = await worker.evaluate(async seen => {
    for (let i = 0; i < 300; i++) {
      let items = await chrome.downloads.search({ state: "complete" });
      if (items.length > seen) {
        return items.sort((a, b) => b.id - a.id)[0];
      }
      await new Promise(r => setTimeout(r, 100));
    }
    return null;
  }, seenDownloads);
  assert.ok(item, "download completed");
  seenDownloads++;
  return item;
}

const panel = tab.locator("moz-screenshots .screenshotsPagePanel");
const step = async (name, fn) => {
  await fn();
  await tab.screenshot({ path: path.join(outDir, `${name}.png`) });
  console.log(`ok - ${name}`);
};

try {
  await tab.goto(`${base}/`);

  await step("overlay-opens", async () => {
    await toggle();
    await tab.locator("#preview-container").waitFor();
    await panel.locator("#visible-page").waitFor();
    assert.equal(await tab.locator("#screenshots-component").count(), 1);
    // Styles from the extension loaded (preview scrim is the overlay colour).
    let bg = await tab.locator("#preview-container").evaluate(e => getComputedStyle(e).backgroundColor);
    assert.notEqual(bg, "rgba(0, 0, 0, 0)");
  });

  await step("hover-highlights-element", async () => {
    await tab.mouse.move(150, 150);
    await tab.locator("#hover-highlight").waitFor();
    let box = await tab.locator("#hover-highlight").boundingBox();
    assert.deepEqual(
      [box.x, box.y, box.width, box.height].map(Math.round),
      [40, 100, 300, 200]
    );
  });

  await step("hover-svg-and-empty-space", async () => {
    // Regression: chrome.dom.openOrClosedShadowRoot() throws for SVG elements.
    let svg = await tab.locator("#svg").boundingBox();
    await tab.mouse.move(svg.x + 10, svg.y + 10);
    await tab.mouse.move(svg.x + 20, svg.y + 20);
    await tab.waitForTimeout(100);
    assert.deepEqual(errors, []);
  });

  await step("bubble-dodges-pointer", async () => {
    let bubble = tab.locator(".preview-bubble");
    let rest = await bubble.boundingBox();
    assert.ok(rest.y < 100, "bubble starts at the top");
    // Slides to one fixed spot below its zone, wherever the pointer is in it...
    let spots = [];
    for (let dy of [0, rest.height / 2]) {
      await tab.mouse.move(rest.x + rest.width / 2, rest.y + dy);
      await tab.waitForTimeout(300);
      spots.push((await bubble.boundingBox()).y);
    }
    assert.equal(spots[0], spots[1], "same spot for any pointer position in the zone");
    assert.ok(spots[0] >= rest.y + rest.height + 24, `bubble moved below its zone (${spots[0]})`);
    // ...and back once the pointer leaves.
    await tab.mouse.move(150, 150);
    await tab.waitForTimeout(300);
    assert.equal((await bubble.boundingBox()).y, rest.y);
  });

  await step("escape-cancels", async () => {
    await tab.keyboard.press("Escape");
    await tab.locator("moz-screenshots").waitFor({ state: "detached" });
  });

  await step("drag-selects-region", async () => {
    await toggle();
    await tab.locator("#preview-container").waitFor();
    await tab.mouse.move(100, 120);
    await tab.mouse.down();
    await tab.mouse.move(200, 200, { steps: 5 });
    await tab.mouse.move(300, 250, { steps: 5 });
    await tab.mouse.up();
    await tab.locator("#buttons-container").waitFor();
    assert.equal(await tab.locator("#selection-size").textContent(), "200 × 130");
    assert.ok(await panel.isHidden(), "panel hides once a region is selected");
  });

  await step("download-region", async () => {
    await tab.locator("#download").click();
    await tab.locator("moz-screenshots").waitFor({ state: "detached" });
    let item = await nextDownload();
    let filename = await worker.evaluate(() => self.requestedFilename);
    assert.match(filename, /^Screenshot \d{4}-\d\d-\d\d at \d\d-\d\d-\d\d Screenshots test page\.png$/);
    let png = fs.readFileSync(item.filename);
    assert.deepEqual(pngSize(png), { width: 200, height: 130 });
    // (100,120) is inside the green box.
    assert.deepEqual(await pixelAt(png, 5, 5), [0, 128, 0]);
    fs.copyFileSync(item.filename, path.join(outDir, "region.png"));
  });

  await step("full-page-preview", async () => {
    await toggle();
    await panel.locator("#full-page").click();
    await tab.locator("dialog #preview-image").waitFor();
    let { width, height } = await tab.locator("#preview-image").evaluate(c => ({ width: c.width, height: c.height }));
    let pageHeight = await tab.evaluate(() => document.documentElement.scrollHeight);
    assert.deepEqual({ width, height }, { width: 1000, height: pageHeight });
    // Fixed header appears once, at the top.
    let pixels = await tab.locator("#preview-image").evaluate(c => {
      let ctx = c.getContext("2d");
      return [ctx.getImageData(500, 10, 1, 1).data, ctx.getImageData(500, 710, 1, 1).data].map(d => [...d.slice(0, 3)]);
    });
    assert.deepEqual(pixels[0], [255, 0, 0]);
    assert.notDeepEqual(pixels[1], [255, 0, 0]);
    assert.equal(await tab.evaluate(() => scrollY), 0, "scroll position restored");
  });

  await step("copy-from-preview", async () => {
    await tab.locator("dialog #copy").click();
    await tab.locator("#confirmation-hint").waitFor();
    let size = await tab.evaluate(async () => {
      let [item] = await navigator.clipboard.read();
      let bitmap = await createImageBitmap(await item.getType("image/png"));
      return { width: bitmap.width, height: bitmap.height };
    });
    assert.equal(size.width, 1000);
    await tab.locator("dialog").waitFor({ state: "detached" });
  });

  await step("keyboard-only-selection", async () => {
    await toggle();
    await panel.locator("#visible-page").waitFor();
    // Tab out of the panel's last button into the overlay (the face), then
    // Space selects the face's rect and focuses the bottom-right mover.
    await panel.locator("#full-page").focus();
    await tab.keyboard.press("Tab");
    assert.ok(
      await tab.locator("#face-container").evaluate(el => el.getRootNode().activeElement === el),
      "focus moved from the panel to the overlay"
    );
    // As in browser_screenshots_face_focusable.js: the region is the face's rect.
    let face = await tab.locator("#face-container").boundingBox();
    await tab.keyboard.press("Space");
    await tab.locator("#buttons-container").waitFor();
    let size = `${Math.floor(face.width)} × ${Math.floor(face.height)}`;
    assert.equal(await tab.locator("#selection-size").textContent(), size);
    await tab.keyboard.press("Shift+ArrowRight");
    await tab.keyboard.press("Shift+ArrowDown");
    size = `${Math.floor(face.width) + 10} × ${Math.floor(face.height) + 10}`;
    assert.equal(await tab.locator("#selection-size").textContent(), size);
    await tab.keyboard.press("Escape"); // back to crosshairs
    await panel.locator("#visible-page").waitFor();
    await tab.keyboard.press("Escape"); // close
    await tab.locator("moz-screenshots").waitFor({ state: "detached" });
  });

  await step("toolbar-button-toggles-closed", async () => {
    await toggle();
    await panel.locator("#visible-page").waitFor();
    await toggle();
    await tab.locator("moz-screenshots").waitFor({ state: "detached" });
  });

  await step("resize-with-mover-then-ctrl-c", async () => {
    await toggle();
    await tab.locator("#preview-container").waitFor();
    await tab.mouse.move(100, 120);
    await tab.mouse.down();
    await tab.mouse.move(300, 250, { steps: 10 });
    await tab.mouse.up();
    // Drag the bottom-right mover 50px right and 20px down.
    await tab.mouse.move(300, 250);
    await tab.mouse.down();
    await tab.mouse.move(350, 270, { steps: 10 });
    await tab.mouse.up();
    assert.equal(await tab.locator("#selection-size").textContent(), "250 × 150");
    await tab.keyboard.press("Control+c");
    await tab.locator("#confirmation-hint").waitFor();
    let size = await tab.evaluate(async () => {
      let [item] = await navigator.clipboard.read();
      let bitmap = await createImageBitmap(await item.getType("image/png"));
      return [bitmap.width, bitmap.height];
    });
    assert.deepEqual(size, [250, 150]);
  });

  await step("retry-from-preview", async () => {
    await toggle();
    await panel.locator("#visible-page").click();
    await tab.locator("dialog #retry").click();
    await tab.locator("dialog").waitFor({ state: "detached" });
    await panel.locator("#visible-page").waitFor();
    await tab.keyboard.press("Escape");
    await tab.locator("moz-screenshots").waitFor({ state: "detached" });
  });

  await step("drag-past-viewport-is-stitched", async () => {
    await toggle();
    await tab.locator("#preview-container").waitFor();
    await tab.mouse.move(100, 120);
    await tab.mouse.down();
    // Dragging near the bottom edge scrolls the page (scrollIfByEdge).
    for (let i = 0; i < 60; i++) {
      await tab.mouse.move(400, 690 + (i % 2) * 5);
    }
    await tab.mouse.up();
    let scrolled = await tab.evaluate(() => scrollY);
    assert.ok(scrolled > 300, `page scrolled while dragging (${scrolled})`);
    await tab.keyboard.press("Control+s");
    await tab.locator("moz-screenshots").waitFor({ state: "detached" });
    let item = await nextDownload();
    let png = fs.readFileSync(item.filename);
    let { width, height } = pngSize(png);
    assert.equal(width, 300);
    assert.ok(height > 700, `region taller than the viewport (${height})`);
    // The fixed header (scrolled away when the region was captured) is not
    // painted over the region, at its start or in the stitched part.
    assert.deepEqual(await pixelAt(png, 5, 5), [0, 128, 0]);
    assert.notDeepEqual(await pixelAt(png, 150, height - 5), [255, 0, 0]);
    assert.equal(await tab.evaluate(() => scrollY), scrolled, "scroll position restored");
    fs.copyFileSync(item.filename, path.join(outDir, "stitched.png"));
    await tab.evaluate(() => scrollTo(0, 0));
  });

  await step("visible-on-strict-csp-page", async () => {
    await tab.goto(`${base}/csp`);
    await tab.evaluate(() => scrollTo(0, 500));
    await toggle();
    await panel.locator("#visible-page").click();
    await tab.locator("dialog #preview-image").waitFor();
    let size = await tab.locator("#preview-image").evaluate(c => [c.width, c.height]);
    assert.deepEqual(size, [1000, 700]);
    let bg = await tab.locator("dialog").evaluate(e => getComputedStyle(e).backgroundColor);
    assert.notEqual(bg, "rgba(0, 0, 0, 0)", "styles load despite CSP");
    await tab.locator("dialog #download").click();
    await tab.locator("dialog").waitFor({ state: "detached" });
    assert.deepEqual(pngSize(fs.readFileSync((await nextDownload()).filename)), { width: 1000, height: 700 });
  });

  await step("copy-on-insecure-page", async () => {
    await tab.goto(`http://insecure.test:${server.address().port}/`);
    assert.equal(await tab.evaluate(() => isSecureContext), false);
    await toggle();
    await tab.locator("#preview-container").waitFor();
    await tab.mouse.move(100, 120);
    await tab.mouse.down();
    await tab.mouse.move(220, 180, { steps: 10 });
    await tab.mouse.up();
    await tab.locator("#copy").click();
    await tab.locator("#confirmation-hint").waitFor();
    await tab.goto(`${base}/`);
    let size = await tab.evaluate(async () => {
      let [item] = await navigator.clipboard.read();
      let bitmap = await createImageBitmap(await item.getType("image/png"));
      return [bitmap.width, bitmap.height];
    });
    assert.deepEqual(size, [120, 60]);
  });

  assert.deepEqual(errors, [], "no page errors");
  console.log(`all passed; screenshots in ${outDir}`);
} finally {
  await context.close();
  server.close();
}
