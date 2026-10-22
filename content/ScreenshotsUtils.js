/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Ported from browser/components/screenshots/ScreenshotsUtils.sys.mjs and
// browser/actors/ScreenshotsComponentChild.sys.mjs.
//
// In Firefox the overlay, the content actor and ScreenshotsUtils (parent
// process) are three layers talking over events and IPC. Here they all run in
// one content script, so this object drives the overlay, panel and preview
// directly. Only capturing pixels, downloads and alerts go to background.js.

// The screenshots.browser.component.last-*-method prefs.
const screenshotsPrefs = {
  lastSavedMethod: "download",
  lastScreenshotMethod: "visible",
};

// The max dimension for a canvas is 32,767 and Chromium's max canvas area is
// 268,435,456 pixels (16,384 x 16,384); Firefox allows 472,907,776.
// We have to limit screenshots to these dimensions otherwise it will cause an error.
const MAX_CAPTURE_DIMENSION = 32766;
const MAX_CAPTURE_AREA = 268435456;

// Events the overlay handles, listened to in the capture phase so the page
// doesn't see them.
const OVERLAY_EVENTS = [
  "click",
  "pointerdown",
  "pointermove",
  "pointerup",
  "keyup",
  "keydown",
  "selectionchange",
];

// Only listened to so they don't reach the page.
const PREVENTABLE_EVENTS = [
  "mousemove",
  "mousedown",
  "mouseup",
  "mouseenter",
  "mouseover",
  "mouseout",
  "mouseleave",
  "touchstart",
  "touchmove",
  "touchend",
  "dblclick",
  "auxclick",
  "keypress",
  "contextmenu",
  "pointerenter",
  "pointerover",
  "pointerout",
  "pointerleave",
];

/**
 * Clamps dimensions to fit within MAX_CAPTURE_DIMENSION and MAX_CAPTURE_AREA constraints.
 *
 * @returns {object} The (possibly) cropped width and height, and whether
 *   cropping occurred.
 */
function clampDimensionsIfNeeded(width, height) {
  let cropped = false;

  if (width > MAX_CAPTURE_DIMENSION) {
    width = MAX_CAPTURE_DIMENSION;
    cropped = true;
  }
  if (height > MAX_CAPTURE_DIMENSION) {
    height = MAX_CAPTURE_DIMENSION;
    cropped = true;
  }
  if (width * height > MAX_CAPTURE_AREA) {
    height = Math.floor(MAX_CAPTURE_AREA / width);
    cropped = true;
  }

  return { width, height, cropped };
}

const ScreenshotsUtils = {
  // True from start() until exit(), including while capturing and previewing.
  active: false,
  overlay: null,
  panel: null,
  preview: null,
  previousFocus: null,

  /**
   * The toolbar button, keyboard shortcut and context menu item: open
   * screenshots, or close them if they're already open.
   */
  async toggle() {
    if (this.active) {
      this.exit();
      return;
    }
    await this.start();
  },

  async start() {
    this.active = true;
    // Prefs and zoom are async here, Firefox reads them synchronously.
    let [prefs, zoom] = await Promise.all([
      chrome.storage.local.get(screenshotsPrefs),
      chrome.runtime.sendMessage({ name: "Screenshots:GetZoom" }),
    ]);
    Object.assign(screenshotsPrefs, prefs);
    if (!this.active) {
      return; // cancelled while starting
    }
    this.previousFocus = document.activeElement;
    this.overlay ??= new ScreenshotsOverlay(document);
    this.overlay.fullZoom = zoom;
    await this.showOverlay();
  },

  /**
   * Close everything (preview, panel, overlay) and put focus back where it
   * was before screenshots opened.
   */
  exit() {
    let focus = document.activeElement;
    let focusInUI =
      !focus || focus === document.body || focus.localName === "moz-screenshots";

    this.active = false;
    let preview = this.preview;
    this.preview = null;
    preview?.close();
    this.hideOverlay();

    if (focusInUI && this.previousFocus?.isConnected) {
      this.previousFocus.focus({ preventScroll: true });
    }
    this.previousFocus = null;
  },

  async showOverlay() {
    this.addEventListeners();
    await this.overlay.initialize();
  },

  hideOverlay() {
    this.removeEventListeners();
    this.overlay?.tearDown();
    this.panel = null;
  },

  addEventListeners() {
    for (let type of [...OVERLAY_EVENTS, ...PREVENTABLE_EVENTS]) {
      window.addEventListener(type, this, true);
    }
    for (let type of ["resize", "scroll", "pagehide"]) {
      window.addEventListener(type, this);
    }
    document.addEventListener("visibilitychange", this);
  },

  removeEventListeners() {
    for (let type of [...OVERLAY_EVENTS, ...PREVENTABLE_EVENTS]) {
      window.removeEventListener(type, this, true);
    }
    for (let type of ["resize", "scroll", "pagehide"]) {
      window.removeEventListener(type, this);
    }
    document.removeEventListener("visibilitychange", this);
    clearTimeout(this.updateTimer);
  },

  handleEvent(event) {
    if (!event.isTrusted) {
      return;
    }

    switch (event.type) {
      case "resize":
      case "scroll":
        clearTimeout(this.updateTimer);
        this.updateTimer = setTimeout(
          () => this.overlay.updateScreenshotsOverlayDimensions(event.type),
          16
        );
        return;
      case "pagehide":
        this.exit();
        return;
      case "visibilitychange":
        // Switching tabs closes screenshots if nothing was selected yet
        // (TabSelect in Firefox).
        if (document.hidden && this.overlay.state === "crosshairs") {
          this.exit();
        }
        return;
    }

    if (!this.overlay.initialized) {
      return;
    }

    // The buttons panel shares the overlay's shadow root (in Firefox it's
    // browser chrome): keep its events from the page and handle them here.
    if (this.panel && event.composedPath().includes(this.panel.element)) {
      event.stopImmediatePropagation();
      this.handlePanelEvent(event);
      return;
    }

    // Don't prevent the default context menu, or pointerdown (which would
    // suppress the click event).
    if (!["contextmenu", "pointerdown"].includes(event.type)) {
      event.preventDefault();
    }
    event.stopImmediatePropagation();
    this.overlay.handleEvent(event);
  },

  // Buttons panel

  openPanel() {
    let root = this.overlay.content?.root;
    if (!root || (this.panel && !this.panel.hidden)) {
      return;
    }
    this.panel ??= new ScreenshotsButtons(root);
    this.panel.hidden = false;
    this.panel.focusButton(screenshotsPrefs.lastScreenshotMethod);
  },

  closePanel() {
    if (this.panel) {
      this.panel.hidden = true;
    }
  },

  /**
   * @param {string} [direction] "forward" or "backward" when tabbing in from
   *   the overlay.
   */
  focusPanel(direction) {
    if (direction) {
      this.panel.focusButton(direction === "forward" ? "first" : "last");
    } else {
      this.panel.focusButton(screenshotsPrefs.lastScreenshotMethod);
    }
  },

  handlePanelEvent(event) {
    if (event.type === "click") {
      this.panel.handleEvent(event);
    } else if (event.type === "keydown") {
      if (event.key === "Escape") {
        this.exit();
      } else if (event.key === "Tab") {
        this.maybeLockFocus(event);
      }
    }
  },

  /**
   * Tabbing past either end of the panel moves focus into the overlay.
   */
  maybeLockFocus(event) {
    let target = event.composedPath()[0];
    if (!target.closest(".moz-button-group")) {
      return;
    }

    let isElementFirst = !!target.nextElementSibling;

    if (isElementFirst && event.shiftKey) {
      event.preventDefault();
      this.overlay.focus("backward");
    } else if (!isElementFirst && !event.shiftKey) {
      event.preventDefault();
      this.overlay.focus("forward");
    }
  },

  // Capturing

  /**
   * "Save visible" / "Save full page": capture, then open the preview.
   *
   * @param {string} type "Visible" or "FullPage".
   */
  async takeScreenshot(type) {
    let {
      scrollMinX,
      scrollMinY,
      scrollWidth,
      scrollHeight,
      pageScrollX,
      pageScrollY,
      clientWidth,
      clientHeight,
    } = this.overlay.windowDimensions.dimensions;
    let rect =
      type === "FullPage"
        ? { left: scrollMinX, top: scrollMinY, width: scrollWidth, height: scrollHeight }
        : { left: pageScrollX, top: pageScrollY, width: clientWidth, height: clientHeight };

    this.hideOverlay();
    let canvas = await this.createCanvas(rect);
    if (!this.active) {
      return; // closed while capturing
    }

    let preview = (this.preview = new ScreenshotsPreview());
    preview.closedPromise.then(() => {
      // Closed by the user (Cancel, Esc), not by retry() or exit().
      if (this.preview === preview) {
        this.exit();
      }
    });
    preview.showCanvas(canvas);
    preview.focusButton(screenshotsPrefs.lastSavedMethod);

    this.setPref(
      "lastScreenshotMethod",
      type === "FullPage" ? "fullpage" : "visible"
    );
  },

  /**
   * The preview's Retry button: back to the overlay.
   */
  retry() {
    let preview = this.preview;
    this.preview = null;
    preview.close();
    this.showOverlay();
  },

  /**
   * The overlay's Copy button / accel+C.
   *
   * @param {object} region The selection, relative to the overlay.
   */
  async copyRegion(region) {
    try {
      await this.copyScreenshot(await this.captureRegion(region));
    } finally {
      this.exit();
    }
  },

  /**
   * The overlay's Download button / accel+S.
   *
   * @param {object} region The selection, relative to the overlay.
   */
  async downloadRegion(region) {
    try {
      await this.downloadScreenshot(await this.captureRegion(region));
    } finally {
      this.exit();
    }
  },

  /**
   * Overlay regions are relative to the scroll origin; captures use page
   * coordinates (which differ in RTL documents).
   */
  captureRegion(region) {
    let { scrollMinX, scrollMinY } = this.overlay.windowDimensions;
    this.hideOverlay();
    return this.createCanvas({
      left: region.left + scrollMinX,
      top: region.top + scrollMinY,
      width: region.width,
      height: region.height,
    });
  },

  setPref(name, value) {
    screenshotsPrefs[name] = value;
    chrome.storage.local.set({ [name]: value });
  },

  /**
   * Creates a canvas and draws a snapshot of the region on it.
   *
   * Firefox renders any part of the page with WindowGlobalParent.drawSnapshot.
   * Extensions can only capture the visible viewport, so regions that extend
   * beyond it are captured one viewport at a time and stitched together.
   *
   * @param region {left, top, width, height} in page coordinates
   * @returns The canvas
   */
  async createCanvas(region) {
    let left = Math.round(region.left);
    let top = Math.round(region.top);
    let { width, height, cropped } = clampDimensionsIfNeeded(
      Math.round(region.width) * devicePixelRatio,
      Math.round(region.height) * devicePixelRatio
    );
    region = {
      left,
      top,
      width: Math.floor(width / devicePixelRatio),
      height: Math.floor(height / devicePixelRatio),
    };
    region.right = region.left + region.width;
    region.bottom = region.top + region.height;
    if (cropped) {
      chrome.runtime.sendMessage({
        name: "Screenshots:Alert",
        title: l10n("screenshots-too-large-error-title"),
        message: l10n("screenshots-too-large-error-details"),
      });
    }

    let scroller = document.scrollingElement || document.documentElement;
    let viewportWidth = Math.min(scroller.clientWidth, window.innerWidth);
    let viewportHeight = Math.min(scroller.clientHeight, window.innerHeight);
    let { scrollX: startScrollX, scrollY: startScrollY } = window;

    let canvas = document.createElement("canvas");
    let context;
    let scale;
    let restoreFixedElements = null;

    // Scroll (if needed) so the page point (x, y) is in the viewport.
    // The first tile is taken from wherever the user was looking.
    let scrollIntoView = async (x, y) => {
      let { scrollX, scrollY } = window;
      let visible = (start, scroll, size) =>
        start >= scroll && start < scroll + size;
      let scroll =
        !visible(x, scrollX, viewportWidth) ||
        !visible(y, scrollY, viewportHeight);
      if (scroll) {
        window.scrollTo({
          left: visible(x, scrollX, viewportWidth) ? scrollX : x,
          top: visible(y, scrollY, viewportHeight) ? scrollY : y,
          behavior: "instant",
        });
      }
      // drawSnapshot renders the page once; stitching would repeat fixed and
      // sticky elements (headers, banners) in every tile. Keep them only in a
      // first tile taken where the user was looking or at the top of the page.
      let keepFixed =
        !context &&
        ((window.scrollX === startScrollX && window.scrollY === startScrollY) ||
          window.scrollY === 0);
      let hide = !keepFixed && !restoreFixedElements;
      if (hide) {
        restoreFixedElements = hideFixedElements();
      }
      if (scroll || hide) {
        await nextPaint();
      }
    };

    // Let the page repaint without the overlay before the first capture.
    await nextPaint();

    try {
      for (let y = region.top, h; y < region.bottom; y += h) {
        for (let x = region.left, w; x < region.right; x += w) {
          await scrollIntoView(x, y);
          let { scrollX, scrollY } = window;
          w = Math.min(region.right, scrollX + viewportWidth) - x;
          h = Math.min(region.bottom, scrollY + viewportHeight) - y;

          let snapshot = await captureVisibleTab();
          if (!context) {
            // Device pixels per CSS pixel, including zoom.
            scale = snapshot.width / window.innerWidth;
            canvas.width = Math.round(region.width * scale);
            canvas.height = Math.round(region.height * scale);
            context = canvas.getContext("2d");
            // Fill with the same background color drawSnapshot uses.
            context.fillStyle = "rgb(255,255,255)";
            context.fillRect(0, 0, canvas.width, canvas.height);
          }

          // Round tile edges (not sizes) so tiles meet without gaps.
          let dx = Math.round((x - region.left) * scale);
          let dy = Math.round((y - region.top) * scale);
          let dw = Math.round((x + w - region.left) * scale) - dx;
          let dh = Math.round((y + h - region.top) * scale) - dy;
          context.drawImage(
            snapshot,
            Math.round((x - scrollX) * scale),
            Math.round((y - scrollY) * scale),
            dw,
            dh,
            dx,
            dy,
            dw,
            dh
          );
          snapshot.close();
        }
      }
    } finally {
      restoreFixedElements?.();
      window.scrollTo({
        left: startScrollX,
        top: startScrollY,
        behavior: "instant",
      });
    }

    return canvas;
  },

  // Saving

  /**
   * Copy the image to the clipboard and show "Screenshot copied!".
   */
  async copyScreenshot(canvas) {
    if (navigator.clipboard) {
      let blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    } else {
      await copyFromExtensionFrame(canvas.toDataURL());
    }

    this.showCopiedConfirmationHint();
    this.setPref("lastSavedMethod", "copy");
  },

  /**
   * @returns {Promise<boolean>} Whether the download completed (false if the
   *   user cancelled the "Save as" dialog).
   */
  async downloadScreenshot(canvas) {
    let succeeded = await chrome.runtime.sendMessage({
      name: "Screenshots:Download",
      url: canvas.toDataURL(),
      filename: getFilename(document.title),
    });
    if (succeeded) {
      this.setPref("lastSavedMethod", "download");
    }
    return succeeded;
  },

  /**
   * Firefox's ConfirmationHint, anchored to the toolbar button there; an
   * extension can only draw in the page, so it appears top right.
   */
  async showCopiedConfirmationHint() {
    let content = insertAnonymousContent(document);
    await linkStylesheet(content.root, "content/screenshots.css");
    let hint = document.createElement("div");
    hint.id = "confirmation-hint";
    hint.setAttribute("role", "alert");
    let checkmark = document.createElement("div");
    checkmark.id = "confirmation-hint-checkmark-image";
    let message = document.createElement("span");
    message.textContent = l10n("confirmation-hint-screenshot-copied");
    hint.append(checkmark, message);
    content.root.append(hint);
    setTimeout(() => removeAnonymousContent(content), 1500);
  },
};

/**
 * Ask the extension to capture the visible part of the tab.
 *
 * @returns {Promise<ImageBitmap>}
 */
async function captureVisibleTab() {
  let dataURL = await chrome.runtime.sendMessage({
    name: "Screenshots:CaptureVisibleTab",
  });
  if (!dataURL) {
    throw new Error("captureVisibleTab failed");
  }
  // Decode locally rather than fetch() so page CSP can't get in the way.
  let bytes = Uint8Array.from(atob(dataURL.split(",")[1]), c =>
    c.charCodeAt(0)
  );
  return createImageBitmap(new Blob([bytes], { type: "image/png" }));
}

/**
 * Copy an image on pages without navigator.clipboard (insecure contexts),
 * using a focused extension frame; see clipboard.js.
 */
async function copyFromExtensionFrame(url) {
  let frame = document.createElement("iframe");
  frame.allow = "clipboard-write";
  frame.style.cssText =
    "position: fixed !important; width: 0 !important; height: 0 !important; border: 0 !important;";
  frame.src = chrome.runtime.getURL("content/clipboard.html");
  let loaded = new Promise(resolve => (frame.onload = resolve));
  document.documentElement.append(frame);
  try {
    await loaded;
    frame.focus();
    let result = await chrome.runtime.sendMessage({
      name: "Screenshots:FrameCopy",
      url,
    });
    if (result !== true) {
      throw new Error(`Copying the screenshot failed: ${result}`);
    }
  } finally {
    frame.remove();
  }
}

/**
 * Resolves after the next frame has been painted.
 */
function nextPaint() {
  return new Promise(resolve =>
    requestAnimationFrame(() => setTimeout(resolve, 0))
  );
}

/**
 * Hide position: fixed/sticky elements until the returned function is called.
 *
 * ponytail: walks every element once per stitched capture; a sticky element
 * in the middle of the page will be missing from the stitched image.
 */
function hideFixedElements() {
  let hidden = [];
  for (let el of document.querySelectorAll("body *")) {
    let { position } = getComputedStyle(el);
    if (position === "fixed" || position === "sticky") {
      hidden.push([
        el,
        el.style.getPropertyValue("visibility"),
        el.style.getPropertyPriority("visibility"),
      ]);
      el.style.setProperty("visibility", "hidden", "important");
    }
  }
  return () => {
    for (let [el, value, priority] of hidden) {
      el.style.setProperty("visibility", value, priority);
    }
  };
}
