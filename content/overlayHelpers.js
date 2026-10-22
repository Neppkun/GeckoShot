/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// An autoselection smaller than these will be ignored entirely:
const MIN_DETECT_ABSOLUTE_HEIGHT = 10;
const MIN_DETECT_ABSOLUTE_WIDTH = 30;
// An autoselection smaller than these will not be preferred:
const MIN_DETECT_HEIGHT = 30;
const MIN_DETECT_WIDTH = 100;
// An autoselection bigger than either of these will be ignored:
let MAX_DETECT_HEIGHT = 700;
let MAX_DETECT_WIDTH = 1000;

const doNotAutoselectTags = {
  H1: true,
  H2: true,
  H3: true,
  H4: true,
  H5: true,
  H6: true,
};

/**
 * Gets the rect for an element if getBoundingClientRect exists
 *
 * @param ele The element to get the rect from
 * @returns The bounding client rect of the element or null
 */
function getBoundingClientRect(ele) {
  if (!ele.getBoundingClientRect) {
    return null;
  }

  return ele.getBoundingClientRect();
}

function setMaxDetectHeight(maxHeight) {
  MAX_DETECT_HEIGHT = maxHeight;
}

function setMaxDetectWidth(maxWidth) {
  MAX_DETECT_WIDTH = maxWidth;
}

/**
 * This function will try to get an element from a given point in the doc.
 * This function is recursive because when sending a message to the
 * ScreenshotsHelper, the ScreenshotsHelper will call into this function.
 * This only occurs when the element at the given point is an iframe.
 *
 * If the element is an iframe, we will send a message to the ScreenshotsHelper
 * actor in the correct context to get the element at the given point.
 * The message will return the "getBestRectForElement" for the element at the
 * given point.
 *
 * If the element is not an iframe, then we will just return the element.
 *
 * @param {number} x The x coordinate
 * @param {number} y The y coordinate
 * @param {Document} doc The document
 * @returns {object}
 *    ele: The element for a given point (x, y)
 *    rect: The rect for the given point if ele is an iframe
 *          otherwise null
 */
async function getElementFromPoint(x, y, doc) {
  let ele = null;
  let rect = null;
  try {
    ele = doc.elementFromPoint(x, y);
    // Firefox asks the iframe's ScreenshotsHelper actor for the element at
    // the point. Content scripts can only look inside same-origin frames, so
    // cross-origin frames are treated as a single element.
    if (ele instanceof HTMLIFrameElement && ele.contentDocument) {
      let frameRect = ele.getBoundingClientRect();
      let style = getComputedStyle(ele);
      let offsetX =
        frameRect.left + ele.clientLeft + parseFloat(style.paddingLeft);
      let offsetY = frameRect.top + ele.clientTop + parseFloat(style.paddingTop);
      let inner = await getElementFromPoint(
        x - offsetX,
        y - offsetY,
        ele.contentDocument
      );
      rect =
        inner.rect ||
        (inner.ele && getBestRectForElement(inner.ele, ele.contentDocument));

      if (rect) {
        rect = {
          left: rect.left + offsetX,
          right: rect.right + offsetX,
          top: rect.top + offsetY,
          bottom: rect.bottom + offsetY,
        };
      }
    } else if (openOrClosedShadowRoot(ele)) {
      while (openOrClosedShadowRoot(ele)) {
        let shadowEle = openOrClosedShadowRoot(ele).elementFromPoint(x, y);
        if (shadowEle && shadowEle !== ele) {
          ele = shadowEle;
        } else {
          break;
        }
      }
    }
  } catch (e) {
    console.error(e);
  }

  return { ele, rect };
}

/**
 * Element.openOrClosedShadowRoot in Firefox: the element's shadow root, or
 * null. chrome.dom.openOrClosedShadowRoot() throws for anything that isn't an
 * HTMLElement of this frame (SVG elements, null, same-origin iframe nodes).
 */
function openOrClosedShadowRoot(ele) {
  if (!(ele instanceof HTMLElement)) {
    return null;
  }
  return chrome.dom.openOrClosedShadowRoot(ele) ?? null;
}

/**
 * This function takes an element and finds a suitable rect to draw the hover box on
 *
 * @param {Element} ele The element to find a suitale rect of
 * @param {Document} doc The current document
 * @returns A suitable rect or null
 */
function getBestRectForElement(ele, doc) {
  let lastRect;
  let lastNode;
  let rect;
  let attemptExtend = false;
  let node = ele;
  while (node) {
    rect = getBoundingClientRect(node);
    if (!rect) {
      rect = lastRect;
      break;
    }
    if (rect.width < MIN_DETECT_WIDTH || rect.height < MIN_DETECT_HEIGHT) {
      // Avoid infinite loop for elements with zero or nearly zero height,
      // like non-clearfixed float parents with or without borders.
      break;
    }
    if (rect.width > MAX_DETECT_WIDTH || rect.height > MAX_DETECT_HEIGHT) {
      // Then the last rectangle is better
      rect = lastRect;
      attemptExtend = true;
      break;
    }
    if (rect.width >= MIN_DETECT_WIDTH && rect.height >= MIN_DETECT_HEIGHT) {
      if (!doNotAutoselectTags[node.tagName]) {
        break;
      }
    }
    lastRect = rect;
    lastNode = node;
    node = node.parentNode;
  }
  if (rect && node) {
    const evenBetter = evenBetterElement(node, doc);
    if (evenBetter) {
      node = lastNode = evenBetter;
      rect = getBoundingClientRect(evenBetter);
      attemptExtend = false;
    }
  }
  if (rect && attemptExtend) {
    let extendNode = lastNode.nextSibling;
    while (extendNode) {
      if (extendNode.nodeType === doc.ELEMENT_NODE) {
        break;
      }
      extendNode = extendNode.nextSibling;
      if (!extendNode) {
        const parentNode = lastNode.parentNode;
        for (let i = 0; i < parentNode.childNodes.length; i++) {
          if (parentNode.childNodes[i] === lastNode) {
            extendNode = parentNode.childNodes[i + 1];
          }
        }
      }
    }
    if (extendNode) {
      const extendRect = getBoundingClientRect(extendNode);
      let x = Math.min(rect.x, extendRect.x);
      let y = Math.min(rect.y, extendRect.y);
      let width = Math.max(rect.right, extendRect.right) - x;
      let height = Math.max(rect.bottom, extendRect.bottom) - y;
      const combinedRect = new DOMRect(x, y, width, height);
      if (
        combinedRect.width <= MAX_DETECT_WIDTH &&
        combinedRect.height <= MAX_DETECT_HEIGHT
      ) {
        rect = combinedRect;
      }
    }
  }

  if (
    rect &&
    (rect.width < MIN_DETECT_ABSOLUTE_WIDTH ||
      rect.height < MIN_DETECT_ABSOLUTE_HEIGHT)
  ) {
    rect = null;
  }

  return rect;
}

/**
 * This finds a better element by looking for elements with role article
 *
 * @param {Element} node The currently hovered node
 * @param {Document} doc The current document
 * @returns A better node or null
 */
function evenBetterElement(node, doc) {
  let el = node.parentNode;
  const ELEMENT_NODE = doc.ELEMENT_NODE;
  while (el && el.nodeType === ELEMENT_NODE) {
    if (!el.getAttribute) {
      return null;
    }
    if (el.getAttribute("role") === "article") {
      const rect = getBoundingClientRect(el);
      if (!rect) {
        return null;
      }
      if (rect.width <= MAX_DETECT_WIDTH && rect.height <= MAX_DETECT_HEIGHT) {
        return el;
      }
      return null;
    }
    el = el.parentNode;
  }
  return null;
}

class Region {
  #x1;
  #x2;
  #y1;
  #y2;
  #windowDimensions;

  constructor(windowDimensions) {
    this.resetDimensions();
    this.#windowDimensions = windowDimensions;
  }

  #clampX(val) {
    return Math.min(this.#windowDimensions.scrollWidth, Math.max(0, val));
  }

  #clampY(val) {
    return Math.min(this.#windowDimensions.scrollHeight, Math.max(0, val));
  }

  /**
   * Sets the dimensions if the given dimension is defined.
   * Otherwise will reset the dimensions
   *
   * @param {object} dims The new region dimensions
   *  {
   *    left: new left dimension value or undefined
   *    top: new top dimension value or undefined
   *    right: new right dimension value or undefined
   *    bottom: new bottom dimension value or undefined
   *   }
   */
  set dimensions(dims) {
    if (dims == null) {
      this.resetDimensions();
      return;
    }

    if (dims.left != null) {
      this.left = dims.left;
    }
    if (dims.top != null) {
      this.top = dims.top;
    }
    if (dims.right != null) {
      this.right = dims.right;
    }
    if (dims.bottom != null) {
      this.bottom = dims.bottom;
    }
  }

  /**
   * Sets the dimensions from a given DOMRect. This will offset the rect
   * relative to the screenshots container before setting the dimensions.
   *
   * @param {DOMRect} rect The DOMRect to set the dimensions from
   */
  setDimensionsFromDOMRect(rect) {
    if (rect == null) {
      this.resetDimensions();
      return;
    }

    // eslint-disable-next-line no-shadow
    let { scrollX, scrollY } = this.#windowDimensions.dimensions;
    // eslint-disable-next-line no-shadow
    let { left, top, right, bottom } = rect;
    let dims = {
      left: left + scrollX,
      top: top + scrollY,
      right: right + scrollX,
      bottom: bottom + scrollY,
    };

    this.dimensions = dims;
  }

  get dimensions() {
    return {
      left: this.left,
      top: this.top,
      right: this.right,
      bottom: this.bottom,
      width: this.width,
      height: this.height,
    };
  }

  get isRegionValid() {
    return this.#x1 + this.#x2 + this.#y1 + this.#y2 > 0;
  }

  resetDimensions() {
    this.#x1 = 0;
    this.#x2 = 0;
    this.#y1 = 0;
    this.#y2 = 0;
  }

  /**
   * Sort the coordinates so x1 < x2 and y1 < y2
   */
  sortCoords() {
    if (this.#x1 > this.#x2) {
      [this.#x1, this.#x2] = [this.#x2, this.#x1];
    }
    if (this.#y1 > this.#y2) {
      [this.#y1, this.#y2] = [this.#y2, this.#y1];
    }
  }

  /**
   * The region should never appear outside the document so the region will
   * be shifted if the region is outside the page's width or height.
   */
  shift() {
    let didShift = false;
    let xDiff = this.right - this.#windowDimensions.scrollWidth;
    if (xDiff > 0) {
      this.left -= xDiff;
      this.right -= xDiff;

      didShift = true;
    }

    let yDiff = this.bottom - this.#windowDimensions.scrollHeight;
    if (yDiff > 0) {
      this.top -= yDiff;
      this.bottom -= yDiff;

      didShift = true;
    }

    return didShift;
  }

  /**
   * The diagonal distance of the region
   */
  get distance() {
    return Math.sqrt(Math.pow(this.width, 2) + Math.pow(this.height, 2));
  }

  get top() {
    return Math.min(this.#y1, this.#y2);
  }
  set top(val) {
    this.#y1 = this.#clampY(val);
  }

  get left() {
    return Math.min(this.#x1, this.#x2);
  }
  set left(val) {
    this.#x1 = this.#clampX(val);
  }

  get right() {
    return Math.max(this.#x1, this.#x2);
  }
  set right(val) {
    this.#x2 = this.#clampX(val);
  }

  get bottom() {
    return Math.max(this.#y1, this.#y2);
  }
  set bottom(val) {
    this.#y2 = this.#clampY(val);
  }

  get width() {
    return Math.abs(this.#x2 - this.#x1);
  }
  get height() {
    return Math.abs(this.#y2 - this.#y1);
  }

  get x1() {
    return this.#x1;
  }
  get x2() {
    return this.#x2;
  }
  get y1() {
    return this.#y1;
  }
  get y2() {
    return this.#y2;
  }
}

class WindowDimensions {
  #clientHeight = null;
  #clientWidth = null;
  #scrollHeight = null;
  #scrollWidth = null;
  #scrollX = null;
  #scrollY = null;
  #scrollMinX = null;
  #scrollMinY = null;
  #scrollMaxX = null;
  #scrollMaxY = null;
  #devicePixelRatio = null;

  set dimensions(dimensions) {
    if (dimensions.clientHeight != null) {
      this.#clientHeight = dimensions.clientHeight;
    }
    if (dimensions.clientWidth != null) {
      this.#clientWidth = dimensions.clientWidth;
    }
    if (dimensions.scrollHeight != null) {
      this.#scrollHeight = dimensions.scrollHeight;
    }
    if (dimensions.scrollWidth != null) {
      this.#scrollWidth = dimensions.scrollWidth;
    }
    if (dimensions.scrollX != null) {
      this.#scrollX = dimensions.scrollX;
    }
    if (dimensions.scrollY != null) {
      this.#scrollY = dimensions.scrollY;
    }
    if (dimensions.scrollMinX != null) {
      this.#scrollMinX = dimensions.scrollMinX;
    }
    if (dimensions.scrollMinY != null) {
      this.#scrollMinY = dimensions.scrollMinY;
    }
    if (dimensions.scrollMaxX != null) {
      this.#scrollMaxX = dimensions.scrollMaxX;
    }
    if (dimensions.scrollMaxY != null) {
      this.#scrollMaxY = dimensions.scrollMaxY;
    }
    if (dimensions.devicePixelRatio != null) {
      this.#devicePixelRatio = dimensions.devicePixelRatio;
    }
  }

  get dimensions() {
    return {
      clientHeight: this.clientHeight,
      clientWidth: this.clientWidth,
      scrollHeight: this.scrollHeight,
      scrollWidth: this.scrollWidth,
      scrollX: this.scrollX,
      scrollY: this.scrollY,
      pageScrollX: this.pageScrollX,
      pageScrollY: this.pageScrollY,
      scrollMinX: this.scrollMinX,
      scrollMinY: this.scrollMinY,
      scrollMaxX: this.scrollMaxX,
      scrollMaxY: this.scrollMaxY,
      devicePixelRatio: this.devicePixelRatio,
    };
  }

  get clientWidth() {
    return this.#clientWidth;
  }

  get clientHeight() {
    return this.#clientHeight;
  }

  get scrollWidth() {
    return this.#scrollWidth;
  }

  get scrollHeight() {
    return this.#scrollHeight;
  }

  get scrollX() {
    return this.#scrollX - this.scrollMinX;
  }

  get pageScrollX() {
    return this.#scrollX;
  }

  get scrollY() {
    return this.#scrollY - this.scrollMinY;
  }

  get pageScrollY() {
    return this.#scrollY;
  }

  get scrollMinX() {
    return this.#scrollMinX;
  }

  get scrollMinY() {
    return this.#scrollMinY;
  }

  get scrollMaxX() {
    return this.#scrollMaxX;
  }

  get scrollMaxY() {
    return this.#scrollMaxY;
  }

  get devicePixelRatio() {
    return this.#devicePixelRatio;
  }

  isInViewport(rect) {
    // eslint-disable-next-line no-shadow
    let { left, top, right, bottom } = rect;

    if (
      left > this.scrollX + this.clientWidth ||
      right < this.scrollX ||
      top > this.scrollY + this.clientHeight ||
      bottom < this.scrollY
    ) {
      return false;
    }
    return true;
  }

  reset() {
    this.#clientHeight = 0;
    this.#clientWidth = 0;
    this.#scrollHeight = 0;
    this.#scrollWidth = 0;
    this.#scrollX = 0;
    this.#scrollY = 0;
    this.#scrollMinX = 0;
    this.#scrollMinY = 0;
    this.#scrollMaxX = 0;
    this.#scrollMaxY = 0;
  }
}

/**
 * Chromium has no Document.insertAnonymousContent(), so emulate it: a host
 * element in the top layer (a manual popover) whose shadow root holds the
 * overlay. The host is absolutely positioned at the document origin so the
 * overlay scrolls with the page, like anonymous content does in Firefox.
 */
function insertAnonymousContent(doc) {
  let host = doc.createElement("moz-screenshots");
  host.setAttribute("popover", "manual");
  host.style.cssText = `all: initial !important; position: absolute !important;
    inset: 0 auto auto 0 !important; width: 0 !important; height: 0 !important;
    margin: 0 !important; padding: 0 !important; border: none !important;
    overflow: visible !important; display: block !important;
    z-index: 2147483647 !important; color-scheme: light dark !important;`;
  let root = host.attachShadow({ mode: "open" });
  doc.documentElement.append(host);
  try {
    host.showPopover();
  } catch (e) {
    // Popovers can't be shown in some documents (e.g. SVG/XML); the host
    // still works with z-index.
  }
  return { host, root };
}

function removeAnonymousContent(content) {
  content.host.remove();
}

/**
 * Link one of the extension's stylesheets into a shadow root.
 */
function linkStylesheet(root, path) {
  let link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL(path);
  root.append(link);
  return new Promise(resolve => {
    link.onload = link.onerror = resolve;
  });
}

/**
 * Look up a message imported from Firefox's Fluent files
 * (see tools/import-firefox-l10n.py).
 */
function l10n(id, ...args) {
  return chrome.i18n.getMessage(
    id.replaceAll("-", "_").replace(".", "_"),
    args.map(String)
  );
}

const isMac = /Mac/.test(navigator.platform);
const isAppLocaleRTL = chrome.i18n.getMessage("@@bidi_dir") === "rtl";

/**
 * ShortcutUtils.getModifierString("accel")
 */
function getAccelString() {
  return isMac ? "⌘" : "Ctrl+";
}
