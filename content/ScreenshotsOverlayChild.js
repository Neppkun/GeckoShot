/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The Screenshots overlay is inserted into the document's
 * anonymous content container (see dom/webidl/Document.webidl).
 *
 * This container gets cleared automatically when the document navigates.
 *
 * To retrieve the AnonymousContent instance, use the `content` getter.
 */

/*
 * Below are the states of the screenshots overlay
 * States:
 *  "crosshairs":
 *    Nothing has happened, and the crosshairs will follow the movement of the mouse
 *  "draggingReady":
 *    The user has pressed the mouse button, but hasn't moved enough to create a selection
 *  "dragging":
 *    The user has pressed down a mouse button, and is dragging out an area far enough to show a selection
 *  "selected":
 *    The user has selected an area
 *  "resizing":
 *    The user is resizing the selection
 */

// Ported from browser/components/screenshots/ScreenshotsOverlayChild.sys.mjs.
// Helpers (Region, WindowDimensions, l10n, ...) come from overlayHelpers.js.

const STATES = {
  CROSSHAIRS: "crosshairs",
  DRAGGING_READY: "draggingReady",
  DRAGGING: "dragging",
  SELECTED: "selected",
  RESIZING: "resizing",
};

const SCROLL_BY_EDGE = 20;

class ScreenshotsOverlay {
  #content;
  #initialized = false;
  #state = "";
  #moverId;

  #cachedEle;
  #lastPageX;
  #lastPageY;
  #lastClientX;
  #lastClientY;
  #previousDimensions;

  get markup() {
    let accelString = getAccelString();
    let copyShorcut = accelString + this.copyKey;
    let downloadShortcut = accelString + this.downloadKey;

    let cancelTitle = l10n("screenshots-component-cancel-button.title");
    let cancelAriaLabel = l10n("screenshots-component-cancel-button.aria-label");

    return `
      <template>
        <div id="screenshots-component">
          <div id="preview-container" hidden>
            <div class="preview-bubble">
            <!-- Firefox shows a smiley face (#face-container) before the
                 instructions; the face is dropped and the instructions take
                 its id so keyboard users can still focus them and press Space
                 to start from that region. -->
            <div id="face-container" class="preview-instructions" tabindex="0" role="button" aria-label="${l10n("screenshots-overlay-preview-face-label.aria-label")}">${l10n("screenshots-instructions")}</div>
            <button class="screenshots-button ghost-button" id="screenshots-cancel-button" title="${cancelTitle}" aria-label="${cancelAriaLabel}">${l10n("screenshots-cancel-button")}</button>
            </div>
          </div>
          <div id="hover-highlight" hidden></div>
          <div id="selection-container" hidden>
            <div id="top-background" class="bghighlight"></div>
            <div id="bottom-background" class="bghighlight"></div>
            <div id="left-background" class="bghighlight"></div>
            <div id="right-background" class="bghighlight"></div>
            <div id="highlight" class="highlight" tabindex="0">
              <div id="mover-topLeft" class="mover-target direction-topLeft" tabindex="0">
                <div class="mover"></div>
              </div>
              <div id="mover-top" class="mover-target direction-top">
                <div class="mover"></div>
              </div>
              <div id="mover-topRight" class="mover-target direction-topRight" tabindex="0">
                <div class="mover"></div>
              </div>
              <div id="mover-right" class="mover-target direction-right">
                <div class="mover"></div>
              </div>
              <div id="mover-bottomRight" class="mover-target direction-bottomRight" tabindex="0">
                <div class="mover"></div>
              </div>
              <div id="mover-bottom" class="mover-target direction-bottom">
                <div class="mover"></div>
              </div>
              <div id="mover-bottomLeft" class="mover-target direction-bottomLeft" tabindex="0">
                <div class="mover"></div>
              </div>
              <div id="mover-left" class="mover-target direction-left">
                <div class="mover"></div>
              </div>
              <div id="selection-size-container">
                <span id="selection-size" dir="ltr"></span>
              </div>
            </div>
          </div>
          <div id="buttons-container" hidden>
            <div class="buttons-wrapper bar">
              <button id="cancel" class="screenshots-button icon-only" title="${cancelTitle}" aria-label="${cancelAriaLabel}"><span class="icon"></span></button>
              <button id="copy" class="screenshots-button" title="${l10n("screenshots-component-copy-button-2.title", copyShorcut)}" aria-label="${l10n("screenshots-component-copy-button-2.aria-label")}"><span class="icon"></span><label>${l10n("screenshots-component-copy-button-2")}</label></button>
              <button id="download" class="screenshots-button primary" title="${l10n("screenshots-component-download-button-2.title", downloadShortcut)}" aria-label="${l10n("screenshots-component-download-button-2.aria-label")}"><span class="icon"></span><label>${l10n("screenshots-component-download-button-2")}</label></button>
            </div>
          </div>
        </div>
      </template>`;
  }

  get fragment() {
    if (!this.overlayTemplate) {
      let parser = new DOMParser();
      let doc = parser.parseFromString(this.markup, "text/html");
      this.overlayTemplate = this.document.importNode(
        doc.querySelector("template"),
        true
      );
    }
    let fragment = this.overlayTemplate.content.cloneNode(true);
    return fragment;
  }

  get initialized() {
    return this.#initialized;
  }

  get state() {
    return this.#state;
  }

  /**
   * Firefox's overlay reports to its actor with chrome-only events; this one
   * calls ScreenshotsUtils directly.
   *
   * @param {Document} contentDocument
   */
  constructor(contentDocument) {
    this.document = contentDocument;
    this.window = contentDocument.defaultView;
    // browsingContext.fullZoom, set by ScreenshotsUtils (chrome.tabs.getZoom).
    this.fullZoom = 1;

    this.windowDimensions = new WindowDimensions();
    this.selectionRegion = new Region(this.windowDimensions);
    this.hoverElementRegion = new Region(this.windowDimensions);

    this.downloadKey = l10n("screenshots-component-download-key");
    this.copyKey = l10n("screenshots-component-copy-key");
  }

  get content() {
    return this.#content ?? null;
  }

  getElementById(id) {
    return this.content.root.getElementById(id);
  }

  async initialize() {
    if (this.initialized) {
      return;
    }

    this.windowDimensions.reset();

    this.#content = insertAnonymousContent(this.document);
    // Load the styles before measuring.
    await linkStylesheet(this.#content.root, "content/screenshots.css");
    this.#content.root.appendChild(this.fragment);

    this.initializeElements();
    this.screenshotsContainer.dir = isAppLocaleRTL ? "rtl" : "ltr";
    await this.updateWindowDimensions();

    this.#setState(STATES.CROSSHAIRS);

    this.selection = this.window.getSelection();
    this.ranges = [];
    for (let i = 0; i < this.selection.rangeCount; i++) {
      this.ranges.push(this.selection.getRangeAt(i));
    }

    this.#initialized = true;
  }

  /**
   * Get all the elements that will be used.
   */
  initializeElements() {
    this.previewCancelButton = this.getElementById("screenshots-cancel-button");
    this.cancelButton = this.getElementById("cancel");
    this.copyButton = this.getElementById("copy");
    this.downloadButton = this.getElementById("download");

    this.previewContainer = this.getElementById("preview-container");
    this.previewFace = this.getElementById("face-container");
    this.hoverElementContainer = this.getElementById("hover-highlight");
    this.selectionContainer = this.getElementById("selection-container");
    this.buttonsContainer = this.getElementById("buttons-container");
    this.screenshotsContainer = this.getElementById("screenshots-component");

    this.previewBubble = this.content.root.querySelector(".preview-bubble");

    this.leftBackgroundEl = this.getElementById("left-background");
    this.topBackgroundEl = this.getElementById("top-background");
    this.rightBackgroundEl = this.getElementById("right-background");
    this.bottomBackgroundEl = this.getElementById("bottom-background");
    this.highlightEl = this.getElementById("highlight");

    this.topLeftMover = this.getElementById("mover-topLeft");
    this.topRightMover = this.getElementById("mover-topRight");
    this.bottomLeftMover = this.getElementById("mover-bottomLeft");
    this.bottomRightMover = this.getElementById("mover-bottomRight");

    this.selectionSize = this.getElementById("selection-size");
  }

  /**
   * Removes all event listeners and removes the overlay from the Anonymous Content
   */
  tearDown() {
    if (this.#content) {
      removeAnonymousContent(this.#content);
      this.#content = null;
    }
    this.#initialized = false;
    this.#setState("");
  }

  focus(direction) {
    if (direction === "backward") {
      this.previewCancelButton.focus({ focusVisible: true });
    } else {
      this.previewFace.focus({ focusVisible: true });
    }
  }

  /**
   * Returns the x and y coordinates of the event relative to both the
   * viewport and the page.
   *
   * @param {Event} event The event
   * @returns
   *  {
   *    clientX: The x position relative to the viewport
   *    clientY: The y position relative to the viewport
   *    pageX: The x position relative to the entire page
   *    pageY: The y position relative to the entire page
   *  }
   */
  getCoordinatesFromEvent(event) {
    let { clientX, clientY, pageX, pageY } = event;
    pageX -= this.windowDimensions.scrollMinX;
    pageY -= this.windowDimensions.scrollMinY;

    return { clientX, clientY, pageX, pageY };
  }

  handleEvent(event) {
    switch (event.type) {
      case "click":
        this.handleClick(event);
        break;
      case "pointerdown":
        this.handlePointerDown(event);
        break;
      case "pointermove":
        this.handlePointerMove(event);
        break;
      case "pointerup":
        this.handlePointerUp(event);
        break;
      case "keydown":
        this.handleKeyDown(event);
        break;
      case "keyup":
        this.handleKeyUp(event);
        break;
      case "selectionchange":
        this.handleSelectionChange();
        break;
    }
  }

  /**
   * If the event came from the primary button, return false as we should not
   * early return in the event handler function.
   * If the event had another button, set to the crosshairs or selected state
   * and return true to early return from the event handler function.
   *
   * @param {PointerEvent} event
   * @returns true if the event button(s) was the non primary button
   *          false otherwise
   */
  preEventHandler(event) {
    if (event.button > 0 || event.buttons > 1) {
      switch (this.#state) {
        case STATES.DRAGGING_READY:
          this.#setState(STATES.CROSSHAIRS);
          break;
        case STATES.DRAGGING:
        case STATES.RESIZING:
          this.#setState(STATES.SELECTED);
          break;
      }
      return true;
    }
    return false;
  }

  handleClick(event) {
    if (this.preEventHandler(event)) {
      return;
    }

    switch (event.composedPath()[0].id) {
      case "screenshots-cancel-button":
      case "cancel":
        this.maybeCancelScreenshots();
        break;
      case "copy":
        this.copySelectedRegion();
        break;
      case "download":
        this.downloadSelectedRegion();
        break;
    }
  }

  maybeCancelScreenshots() {
    if (this.#state === STATES.CROSSHAIRS) {
      ScreenshotsUtils.exit();
    } else {
      this.#setState(STATES.CROSSHAIRS);
    }
  }

  /**
   * Handles the pointerdown event depending on the state.
   * Early return when a pointer down happens on a button.
   *
   * @param {Event} event The pointerown event
   */
  handlePointerDown(event) {
    // Early return if the event target is not within the screenshots component
    // element.
    if (!event.composedPath()[0].closest("#screenshots-component")) {
      return;
    }

    if (this.preEventHandler(event)) {
      return;
    }

    if (
      event.composedPath()[0].id === "screenshots-cancel-button" ||
      event.composedPath()[0].closest("#buttons-container") ===
        this.buttonsContainer
    ) {
      event.stopPropagation();
      return;
    }

    const { pageX, pageY } = this.getCoordinatesFromEvent(event);

    switch (this.#state) {
      case STATES.CROSSHAIRS: {
        this.crosshairsDragStart(pageX, pageY);
        break;
      }
      case STATES.SELECTED: {
        this.selectedDragStart(pageX, pageY, event.composedPath()[0].id);
        break;
      }
    }
  }

  /**
   * Handles the pointermove event depending on the state
   *
   * @param {Event} event The pointermove event
   */
  handlePointerMove(event) {
    if (this.preEventHandler(event)) {
      return;
    }

    const { pageX, pageY, clientX, clientY } =
      this.getCoordinatesFromEvent(event);

    switch (this.#state) {
      case STATES.CROSSHAIRS: {
        this.crosshairsMove(clientX, clientY);
        break;
      }
      case STATES.DRAGGING_READY: {
        this.draggingReadyDrag(pageX, pageY);
        break;
      }
      case STATES.DRAGGING: {
        this.draggingDrag(pageX, pageY);
        break;
      }
      case STATES.RESIZING: {
        this.resizingDrag(pageX, pageY);
        break;
      }
    }
  }

  /**
   * Handles the pointerup event depending on the state
   *
   * @param {Event} event The pointerup event
   */
  handlePointerUp(event) {
    const { pageX, pageY, clientX, clientY } =
      this.getCoordinatesFromEvent(event);

    switch (this.#state) {
      case STATES.DRAGGING_READY: {
        this.draggingReadyDragEnd(pageX - clientX, pageY - clientY);
        break;
      }
      case STATES.DRAGGING: {
        this.draggingDragEnd(pageX, pageY, event.composedPath()[0].id);
        break;
      }
      case STATES.RESIZING: {
        this.resizingDragEnd(pageX, pageY);
        break;
      }
    }
  }

  /**
   * Handles when a keydown occurs in the screenshots component.
   *
   * @param {Event} event The keydown event
   */
  handleKeyDown(event) {
    if (event.key === "Escape") {
      this.maybeCancelScreenshots();
      return;
    }

    switch (this.#state) {
      case STATES.CROSSHAIRS:
        this.crosshairsKeyDown(event);
        break;
      case STATES.DRAGGING:
        this.draggingKeyDown(event);
        break;
      case STATES.RESIZING:
        this.resizingKeyDown(event);
        break;
      case STATES.SELECTED:
        this.selectedKeyDown(event);
        break;
    }
  }

  /**
   * Handles when a keyup occurs in the screenshots component.
   * All we need to do on keyup is set the state to selected.
   *
   * @param {Event} event The keydown event
   */
  handleKeyUp(event) {
    switch (this.#state) {
      case STATES.RESIZING:
        switch (event.key) {
          case "ArrowLeft":
          case "ArrowUp":
          case "ArrowRight":
          case "ArrowDown":
            switch (event.composedPath()[0].id) {
              case "highlight":
              case "mover-bottomLeft":
              case "mover-bottomRight":
              case "mover-topLeft":
              case "mover-topRight":
                this.#setState(STATES.SELECTED, { doNotMoveFocus: true });
                break;
            }
            break;
        }
        break;
    }
  }

  /**
   * Gets the accel key depending on the platform.
   * metaKey for macOS. ctrlKey for Windows and Linux.
   *
   * @param {Event} event The keydown event
   * @returns {boolean} True if the accel key is pressed, false otherwise.
   */
  getAccelKey(event) {
    return isMac ? event.metaKey : event.ctrlKey;
  }

  crosshairsKeyDown(event) {
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowUp":
      case "ArrowRight":
      case "ArrowDown":
        // Do nothing so we can prevent default below
        break;
      case "Tab":
        this.maybeLockFocus(event);
        return;
      case "Enter":
        if (this.handleKeyDownOnButton(event)) {
          return;
        }

        if (this.hoverElementRegion.isRegionValid) {
          this.draggingReadyStart();
          this.draggingReadyDragEnd();
          return;
        }
      // eslint-disable-next-line no-fallthrough
      case " ": {
        if (this.handleKeyDownOnButton(event)) {
          return;
        }

        // If the preview face is focused, create a region from the preview
        // face and move focus to the bottom right mover for adjustments
        if (this.content.root.activeElement === this.previewFace) {
          let rect = this.previewFace.getBoundingClientRect();
          this.hoverElementRegion.setDimensionsFromDOMRect(rect);
          this.draggingReadyStart();
          this.draggingReadyDragEnd({ doNotMoveFocus: true });
          this.bottomRightMover.focus({ focusVisible: true });
          return;
        }

        // The left and top coordinates from cursorRegion are relative to
        // the client window so we need to add the scroll offset of the page to
        // get the correct coordinates.
        // (Firefox asks windowUtils for the last pointer location; we track it.)
        this.crosshairsDragStart(
          (this.#lastClientX ?? 0) + this.windowDimensions.scrollX,
          (this.#lastClientY ?? 0) + this.windowDimensions.scrollY
        );
        this.#setState(STATES.DRAGGING);
        break;
      }
    }
  }

  /**
   * Handles a keydown event for the dragging state.
   *
   * @param {Event} event The keydown event
   */
  draggingKeyDown(event) {
    switch (event.key) {
      case "ArrowLeft":
        this.handleArrowLeftKeyDown(event);
        break;
      case "ArrowUp":
        this.handleArrowUpKeyDown(event);
        break;
      case "ArrowRight":
        this.handleArrowRightKeyDown(event);
        break;
      case "ArrowDown":
        this.handleArrowDownKeyDown(event);
        break;
      case "Enter":
      case " ":
        this.#setState(STATES.SELECTED);
        return;
      default:
        return;
    }

    this.drawSelectionContainer();
  }

  /**
   * Handles a keydown event for the resizing state.
   *
   * @param {Event} event The keydown event
   */
  resizingKeyDown(event) {
    switch (event.key) {
      case "ArrowLeft":
        this.resizingArrowLeftKeyDown(event);
        break;
      case "ArrowUp":
        this.resizingArrowUpKeyDown(event);
        break;
      case "ArrowRight":
        this.resizingArrowRightKeyDown(event);
        break;
      case "ArrowDown":
        this.resizingArrowDownKeyDown(event);
        break;
    }
  }

  selectedKeyDown(event) {
    let isSelectionElement = event.composedPath()[0].closest(
      "#selection-container"
    );
    switch (event.key) {
      case "ArrowLeft":
        if (isSelectionElement) {
          this.resizingArrowLeftKeyDown(event);
        }
        break;
      case "ArrowUp":
        if (isSelectionElement) {
          this.resizingArrowUpKeyDown(event);
        }
        break;
      case "ArrowRight":
        if (isSelectionElement) {
          this.resizingArrowRightKeyDown(event);
        }
        break;
      case "ArrowDown":
        if (isSelectionElement) {
          this.resizingArrowDownKeyDown(event);
        }
        break;
      case "Tab":
        this.maybeLockFocus(event);
        break;
      case "Enter":
      case " ":
        this.handleKeyDownOnButton(event);
        break;
      case this.copyKey.toLowerCase():
        if (this.state === "selected" && this.getAccelKey(event)) {
          this.copySelectedRegion();
        }
        break;
      case this.downloadKey.toLowerCase():
        if (this.state === "selected" && this.getAccelKey(event)) {
          this.downloadSelectedRegion();
        }
        break;
    }
  }

  /**
   * Move the region or its left or right side to the left.
   * Just the arrow key will move the region by 1px.
   * Arrow key + shift will move the region by 10px.
   * Arrow key + control/meta will move to the edge of the window.
   *
   * @param {Event} event The keydown event
   */
  resizingArrowLeftKeyDown(event) {
    this.handleArrowLeftKeyDown(event);

    if (this.#state !== STATES.RESIZING) {
      this.#setState(STATES.RESIZING);
    }

    this.drawSelectionContainer();
  }

  /**
   * Move the region or its left or right side to the left.
   * Just the arrow key will move the region by 1px.
   * Arrow key + shift will move the region by 10px.
   * Arrow key + control/meta will move to the edge of the window.
   *
   * @param {Event} event The keydown event
   */
  handleArrowLeftKeyDown(event) {
    let exponent = event.shiftKey ? 1 : 0;
    switch (event.composedPath()[0].id) {
      case "highlight":
        if (this.getAccelKey(event)) {
          let width = this.selectionRegion.width;
          this.selectionRegion.left = this.windowDimensions.scrollX;
          this.selectionRegion.right = this.windowDimensions.scrollX + width;
          break;
        }

        this.selectionRegion.right -= 10 ** exponent;
      // eslint-disable-next-line no-fallthrough
      case "mover-topLeft":
      case "mover-bottomLeft":
        if (this.getAccelKey(event)) {
          this.selectionRegion.left = this.windowDimensions.scrollX;
          break;
        }

        this.selectionRegion.left -= 10 ** exponent;
        this.scrollIfByEdge(
          this.selectionRegion.left,
          this.windowDimensions.scrollY + this.windowDimensions.clientHeight / 2
        );
        break;
      case "mover-topRight":
      case "mover-bottomRight":
        if (this.getAccelKey(event)) {
          let left = this.selectionRegion.left;
          this.selectionRegion.left = this.windowDimensions.scrollX;
          this.selectionRegion.right = left;
          if (event.composedPath()[0].id === "mover-topRight") {
            this.topLeftMover.focus({ focusVisible: true });
          } else if (event.composedPath()[0].id === "mover-bottomRight") {
            this.bottomLeftMover.focus({ focusVisible: true });
          }
          break;
        }

        this.selectionRegion.right -= 10 ** exponent;
        if (this.selectionRegion.x1 >= this.selectionRegion.x2) {
          this.selectionRegion.sortCoords();
          if (event.composedPath()[0].id === "mover-topRight") {
            this.topLeftMover.focus({ focusVisible: true });
          } else if (event.composedPath()[0].id === "mover-bottomRight") {
            this.bottomLeftMover.focus({ focusVisible: true });
          }
        }
        break;
    }
  }

  /**
   * Move the region or its top or bottom side upward.
   * Just the arrow key will move the region by 1px.
   * Arrow key + shift will move the region by 10px.
   * Arrow key + control/meta will move to the edge of the window.
   *
   * @param {Event} event The keydown event
   */
  resizingArrowUpKeyDown(event) {
    this.handleArrowUpKeyDown(event);

    if (this.#state !== STATES.RESIZING) {
      this.#setState(STATES.RESIZING);
    }

    this.drawSelectionContainer();
  }

  /**
   * Move the region or its top or bottom side upward.
   * Just the arrow key will move the region by 1px.
   * Arrow key + shift will move the region by 10px.
   * Arrow key + control/meta will move to the edge of the window.
   *
   * @param {Event} event The keydown event
   */
  handleArrowUpKeyDown(event) {
    let exponent = event.shiftKey ? 1 : 0;
    switch (event.composedPath()[0].id) {
      case "highlight":
        if (this.getAccelKey(event)) {
          let height = this.selectionRegion.height;
          this.selectionRegion.top = this.windowDimensions.scrollY;
          this.selectionRegion.bottom = this.windowDimensions.scrollY + height;
          break;
        }

        this.selectionRegion.bottom -= 10 ** exponent;
      // eslint-disable-next-line no-fallthrough
      case "mover-topLeft":
      case "mover-topRight":
        if (this.getAccelKey(event)) {
          this.selectionRegion.top = this.windowDimensions.scrollY;
          break;
        }

        this.selectionRegion.top -= 10 ** exponent;
        this.scrollIfByEdge(
          this.windowDimensions.scrollX + this.windowDimensions.clientWidth / 2,
          this.selectionRegion.top
        );
        break;
      case "mover-bottomLeft":
      case "mover-bottomRight":
        if (this.getAccelKey(event)) {
          let top = this.selectionRegion.top;
          this.selectionRegion.top = this.windowDimensions.scrollY;
          this.selectionRegion.bottom = top;
          if (event.composedPath()[0].id === "mover-bottomLeft") {
            this.topLeftMover.focus({ focusVisible: true });
          } else if (event.composedPath()[0].id === "mover-bottomRight") {
            this.topRightMover.focus({ focusVisible: true });
          }
          break;
        }

        this.selectionRegion.bottom -= 10 ** exponent;
        if (this.selectionRegion.y1 >= this.selectionRegion.y2) {
          this.selectionRegion.sortCoords();
          if (event.composedPath()[0].id === "mover-bottomLeft") {
            this.topLeftMover.focus({ focusVisible: true });
          } else if (event.composedPath()[0].id === "mover-bottomRight") {
            this.topRightMover.focus({ focusVisible: true });
          }
        }
        break;
    }
  }

  /**
   * Move the region or its left or right side to the right.
   * Just the arrow key will move the region by 1px.
   * Arrow key + shift will move the region by 10px.
   * Arrow key + control/meta will move to the edge of the window.
   *
   * @param {Event} event The keydown event
   */
  resizingArrowRightKeyDown(event) {
    this.handleArrowRightKeyDown(event);

    if (this.#state !== STATES.RESIZING) {
      this.#setState(STATES.RESIZING);
    }

    this.drawSelectionContainer();
  }

  /**
   * Move the region or its left or right side to the right.
   * Just the arrow key will move the region by 1px.
   * Arrow key + shift will move the region by 10px.
   * Arrow key + control/meta will move to the edge of the window.
   *
   * @param {Event} event The keydown event
   */
  handleArrowRightKeyDown(event) {
    let exponent = event.shiftKey ? 1 : 0;
    switch (event.composedPath()[0].id) {
      case "highlight":
        if (this.getAccelKey(event)) {
          let width = this.selectionRegion.width;
          let { scrollX, clientWidth } = this.windowDimensions.dimensions;
          this.selectionRegion.right = scrollX + clientWidth;
          this.selectionRegion.left = this.selectionRegion.right - width;
          break;
        }

        this.selectionRegion.left += 10 ** exponent;
      // eslint-disable-next-line no-fallthrough
      case "mover-topRight":
      case "mover-bottomRight":
        if (this.getAccelKey(event)) {
          this.selectionRegion.right =
            this.windowDimensions.scrollX + this.windowDimensions.clientWidth;
          break;
        }

        this.selectionRegion.right += 10 ** exponent;
        this.scrollIfByEdge(
          this.selectionRegion.right,
          this.windowDimensions.scrollY + this.windowDimensions.clientHeight / 2
        );
        break;
      case "mover-topLeft":
      case "mover-bottomLeft":
        if (this.getAccelKey(event)) {
          let right = this.selectionRegion.right;
          this.selectionRegion.right =
            this.windowDimensions.scrollX + this.windowDimensions.clientWidth;
          this.selectionRegion.left = right;
          if (event.composedPath()[0].id === "mover-topLeft") {
            this.topRightMover.focus({ focusVisible: true });
          } else if (event.composedPath()[0].id === "mover-bottomLeft") {
            this.bottomRightMover.focus({ focusVisible: true });
          }
          break;
        }

        this.selectionRegion.left += 10 ** exponent;
        if (this.selectionRegion.x1 >= this.selectionRegion.x2) {
          this.selectionRegion.sortCoords();
          if (event.composedPath()[0].id === "mover-topLeft") {
            this.topRightMover.focus({ focusVisible: true });
          } else if (event.composedPath()[0].id === "mover-bottomLeft") {
            this.bottomRightMover.focus({ focusVisible: true });
          }
        }
        break;
    }
  }

  /**
   * Move the region or its top or bottom side downward.
   * Just the arrow key will move the region by 1px.
   * Arrow key + shift will move the region by 10px.
   * Arrow key + control/meta will move to the edge of the window.
   *
   * @param {Event} event The keydown event
   */
  resizingArrowDownKeyDown(event) {
    this.handleArrowDownKeyDown(event);

    if (this.#state !== STATES.RESIZING) {
      this.#setState(STATES.RESIZING);
    }

    this.drawSelectionContainer();
  }

  handleArrowDownKeyDown(event) {
    let exponent = event.shiftKey ? 1 : 0;
    switch (event.composedPath()[0].id) {
      case "highlight":
        if (this.getAccelKey(event)) {
          let height = this.selectionRegion.height;
          let { scrollY, clientHeight } = this.windowDimensions.dimensions;
          this.selectionRegion.bottom = scrollY + clientHeight;
          this.selectionRegion.top = this.selectionRegion.bottom - height;
          break;
        }

        this.selectionRegion.top += 10 ** exponent;
      // eslint-disable-next-line no-fallthrough
      case "mover-bottomLeft":
      case "mover-bottomRight":
        if (this.getAccelKey(event)) {
          this.selectionRegion.bottom =
            this.windowDimensions.scrollY + this.windowDimensions.clientHeight;
          break;
        }

        this.selectionRegion.bottom += 10 ** exponent;
        this.scrollIfByEdge(
          this.windowDimensions.scrollX + this.windowDimensions.clientWidth / 2,
          this.selectionRegion.bottom
        );
        break;
      case "mover-topLeft":
      case "mover-topRight":
        if (this.getAccelKey(event)) {
          let bottom = this.selectionRegion.bottom;
          this.selectionRegion.bottom =
            this.windowDimensions.scrollY + this.windowDimensions.clientHeight;
          this.selectionRegion.top = bottom;
          if (event.composedPath()[0].id === "mover-topLeft") {
            this.bottomLeftMover.focus({ focusVisible: true });
          } else if (event.composedPath()[0].id === "mover-topRight") {
            this.bottomRightMover.focus({ focusVisible: true });
          }
          break;
        }

        this.selectionRegion.top += 10 ** exponent;
        if (this.selectionRegion.y1 >= this.selectionRegion.y2) {
          this.selectionRegion.sortCoords();
          if (event.composedPath()[0].id === "mover-topLeft") {
            this.bottomLeftMover.focus({ focusVisible: true });
          } else if (event.composedPath()[0].id === "mover-topRight") {
            this.bottomRightMover.focus({ focusVisible: true });
          }
        }
        break;
    }
  }

  /**
   * We lock focus to the overlay when a region is selected.
   * Can still escape with shift + F6.
   *
   * @param {Event} event The keydown event
   */
  maybeLockFocus(event) {
    switch (this.#state) {
      case STATES.CROSSHAIRS:
        if (event.composedPath()[0] === this.previewCancelButton) {
          if (event.shiftKey) {
            this.previewFace.focus({ focusVisible: true });
          } else {
            ScreenshotsUtils.focusPanel("forward");
          }
        } else if (event.composedPath()[0] === this.previewFace) {
          if (event.shiftKey) {
            ScreenshotsUtils.focusPanel("backward");
          } else {
            this.previewCancelButton.focus({ focusVisible: true });
          }
        }
        break;
      case STATES.SELECTED: {
        let lastActionButton = this.downloadButton;
        if (event.composedPath()[0].id === "highlight" && event.shiftKey) {
          lastActionButton.focus({ focusVisible: true });
        } else if (
          event.composedPath()[0] === lastActionButton &&
          !event.shiftKey
        ) {
          this.highlightEl.focus({ focusVisible: true });
        } else {
          // The content document can listen for keydown events and prevent moving
          // focus so we manually move focus to the next element here.
          // (Firefox uses Services.focus.moveFocus.)
          let focusable = [
            ...this.content.root.querySelectorAll("[tabindex], button"),
          ].filter(el => el.tabIndex >= 0 && el.checkVisibility());
          let index = focusable.indexOf(event.composedPath()[0]);
          let next = focusable.at(
            (index + (event.shiftKey ? -1 : 1)) % focusable.length
          );
          next?.focus({ focusVisible: true });
        }
        break;
      }
    }
  }

  /**
   * Set the focus to the most recent saved method.
   * This will default to the download button.
   */
  setFocusToActionButton() {
    if (screenshotsPrefs.lastSavedMethod === "copy") {
      this.copyButton.focus({ focusVisible: true, preventScroll: true });
    } else {
      this.downloadButton.focus({ focusVisible: true, preventScroll: true });
    }
  }

  /**
   * ScreenshotsUtils prevents all events' defaults, so we need to
   * explicitly handle keydown events on buttons here.
   *
   * @param {KeyEvent} event The keydown event
   *
   * @returns {boolean} True if the event was handled here, otherwise false.
   */
  handleKeyDownOnButton(event) {
    switch (event.composedPath()[0]) {
      case this.cancelButton:
      case this.previewCancelButton:
        this.maybeCancelScreenshots();
        break;
      case this.copyButton:
        this.copySelectedRegion();
        break;
      case this.downloadButton:
        this.downloadSelectedRegion();
        break;
      default:
        return false;
    }
    return true;
  }

  /**
   * All of the selection ranges were recorded at initialization. The ranges
   * are removed when focus is set to the buttons so we add the selection
   * ranges back so a selected region can be captured.
   */
  handleSelectionChange() {
    if (this.ranges.length) {
      for (let range of this.ranges) {
        this.selection.addRange(range);
      }
    }
  }

  /**
   * Set a new state for the overlay
   *
   * @param {string} newState
   * @param {object} options (optional) Options for calling start of state method
   */
  #setState(newState, options = {}) {
    this.#state = newState;

    switch (this.#state) {
      case STATES.CROSSHAIRS: {
        this.crosshairsStart();
        break;
      }
      case STATES.DRAGGING_READY: {
        this.draggingReadyStart();
        break;
      }
      case STATES.DRAGGING: {
        this.draggingStart();
        break;
      }
      case STATES.SELECTED: {
        this.selectedStart(options);
        break;
      }
      case STATES.RESIZING: {
        this.resizingStart();
        break;
      }
    }
  }

  copySelectedRegion() {
    ScreenshotsUtils.copyRegion(this.selectionRegion.dimensions);
  }

  downloadSelectedRegion() {
    ScreenshotsUtils.downloadRegion(this.selectionRegion.dimensions);
  }

  /**
   * Hide hover element, selection and buttons containers.
   * Show the preview container and the panel.
   * This is the initial state of the overlay.
   */
  crosshairsStart() {
    this.hideHoverElementContainer();
    this.hideSelectionContainer();
    this.hideButtonsContainer();
    this.showPreviewContainer();
    ScreenshotsUtils.openPanel();
    this.#previousDimensions = null;
    this.#cachedEle = null;
    this.hoverElementRegion.resetDimensions();
  }

  /**
   * Hide the panel because we have started dragging.
   */
  draggingReadyStart() {
    ScreenshotsUtils.closePanel();
  }

  /**
   * Hide the preview, hover element and buttons containers.
   * Show the selection container.
   */
  draggingStart() {
    this.hidePreviewContainer();
    this.hideButtonsContainer();
    this.hideHoverElementContainer();
    this.drawSelectionContainer();
  }

  /**
   * Hide the preview and hover element containers.
   * Draw the selection and buttons containers.
   *
   * @param {object} [options={}] (optional)
   * @param {boolean} doNotMoveFocus True if focus should not be moved to an action button
   */
  selectedStart(options = {}) {
    this.selectionRegion.sortCoords();
    this.hidePreviewContainer();
    this.hideHoverElementContainer();
    this.drawSelectionContainer();
    this.drawButtonsContainer();

    if (!options.doNotMoveFocus) {
      this.setFocusToActionButton();
    }
  }

  /**
   * Hide the buttons container.
   * Store the width and height of the current selected region.
   * The dimensions will be used when moving the region along the edge of the
   * page and for recording telemetry.
   */
  resizingStart() {
    this.hideButtonsContainer();
    let { width, height } = this.selectionRegion.dimensions;
    this.#previousDimensions = { width, height };
  }

  /**
   * Dragging has started so we set the initial selection region and set the
   * state to draggingReady.
   *
   * @param {number} pageX The x position relative to the page
   * @param {number} pageY The y position relative to the page
   */
  crosshairsDragStart(pageX, pageY) {
    this.selectionRegion.dimensions = {
      left: pageX,
      top: pageY,
      right: pageX,
      bottom: pageY,
    };

    this.#setState(STATES.DRAGGING_READY);
  }

  /**
   * If the background is clicked we set the state to crosshairs
   * otherwise set the state to resizing
   *
   * @param {number} pageX The x position relative to the page
   * @param {number} pageY The y position relative to the page
   * @param {string} targetId The id of the event target
   */
  selectedDragStart(pageX, pageY, targetId) {
    if (targetId === this.screenshotsContainer.id) {
      this.#setState(STATES.CROSSHAIRS);
      return;
    }
    this.#moverId = targetId;
    this.#lastPageX = pageX;
    this.#lastPageY = pageY;

    this.#setState(STATES.RESIZING);
  }

  /**
   * Move the instructions bubble out of the way and find the element currently
   * being hovered.
   *
   * @param {number} clientX The x position relative to the viewport
   * @param {number} clientY The y position relative to the viewport
   */
  crosshairsMove(clientX, clientY) {
    this.#lastClientX = clientX;
    this.#lastClientY = clientY;
    this.dodgePreviewBubble(clientX, clientY);

    this.handleElementHover(clientX, clientY);
  }

  /**
   * Set the selection region dimensions and if the region is at least 40
   * pixels diagnally in distance, set the state to dragging.
   *
   * @param {number} pageX The x position relative to the page
   * @param {number} pageY The y position relative to the page
   */
  draggingReadyDrag(pageX, pageY) {
    this.selectionRegion.dimensions = {
      right: pageX,
      bottom: pageY,
    };

    if (this.selectionRegion.distance > 40) {
      this.#setState(STATES.DRAGGING);
    }
  }

  /**
   * Scroll if along the edge of the viewport, update the selection region
   * dimensions and draw the selection container.
   *
   * @param {number} pageX The x position relative to the page
   * @param {number} pageY The y position relative to the page
   */
  draggingDrag(pageX, pageY) {
    this.scrollIfByEdge(pageX, pageY);
    this.selectionRegion.dimensions = {
      right: pageX,
      bottom: pageY,
    };

    this.drawSelectionContainer();
  }

  /**
   * Resize the selection region depending on the mover that started the resize.
   *
   * @param {number} pageX The x position relative to the page
   * @param {number} pageY The y position relative to the page
   */
  resizingDrag(pageX, pageY) {
    this.scrollIfByEdge(pageX, pageY);
    switch (this.#moverId) {
      case "mover-topLeft": {
        this.selectionRegion.dimensions = {
          left: pageX,
          top: pageY,
        };
        break;
      }
      case "mover-top": {
        this.selectionRegion.dimensions = { top: pageY };
        break;
      }
      case "mover-topRight": {
        this.selectionRegion.dimensions = {
          top: pageY,
          right: pageX,
        };
        break;
      }
      case "mover-right": {
        this.selectionRegion.dimensions = {
          right: pageX,
        };
        break;
      }
      case "mover-bottomRight": {
        this.selectionRegion.dimensions = {
          right: pageX,
          bottom: pageY,
        };
        break;
      }
      case "mover-bottom": {
        this.selectionRegion.dimensions = {
          bottom: pageY,
        };
        break;
      }
      case "mover-bottomLeft": {
        this.selectionRegion.dimensions = {
          left: pageX,
          bottom: pageY,
        };
        break;
      }
      case "mover-left": {
        this.selectionRegion.dimensions = { left: pageX };
        break;
      }
      case "highlight": {
        let diffX = this.#lastPageX - pageX;
        let diffY = this.#lastPageY - pageY;

        let newLeft;
        let newRight;
        let newTop;
        let newBottom;

        // Unpack dimensions to use here
        let {
          left: boxLeft,
          top: boxTop,
          right: boxRight,
          bottom: boxBottom,
          width: boxWidth,
          height: boxHeight,
        } = this.selectionRegion.dimensions;
        let { scrollWidth, scrollHeight } = this.windowDimensions.dimensions;

        // wait until all 4 if elses have completed before setting box dimensions
        if (boxWidth <= this.#previousDimensions.width && boxLeft === 0) {
          newLeft = boxRight - this.#previousDimensions.width;
        } else {
          newLeft = boxLeft;
        }

        if (
          boxWidth <= this.#previousDimensions.width &&
          boxRight === scrollWidth
        ) {
          newRight = boxLeft + this.#previousDimensions.width;
        } else {
          newRight = boxRight;
        }

        if (boxHeight <= this.#previousDimensions.height && boxTop === 0) {
          newTop = boxBottom - this.#previousDimensions.height;
        } else {
          newTop = boxTop;
        }

        if (
          boxHeight <= this.#previousDimensions.height &&
          boxBottom === scrollHeight
        ) {
          newBottom = boxTop + this.#previousDimensions.height;
        } else {
          newBottom = boxBottom;
        }

        this.selectionRegion.dimensions = {
          left: newLeft - diffX,
          top: newTop - diffY,
          right: newRight - diffX,
          bottom: newBottom - diffY,
        };

        this.#lastPageX = pageX;
        this.#lastPageY = pageY;
        break;
      }
    }
    this.drawSelectionContainer();
  }

  /**
   * If there is a valid element region, update and draw the selection
   * container and set the state to selected.
   * Otherwise set the state to crosshairs.
   *
   * @param {object} options (optional) Options for passing to setState method
   */
  draggingReadyDragEnd(options = {}) {
    if (this.hoverElementRegion.isRegionValid) {
      this.selectionRegion.dimensions = this.hoverElementRegion.dimensions;
      this.#setState(STATES.SELECTED, options);
    } else {
      this.#setState(STATES.CROSSHAIRS);
    }
  }

  /**
   * Update the selection region dimensions and set the state to selected.
   *
   * @param {number} pageX The x position relative to the page
   * @param {number} pageY The y position relative to the page
   */
  draggingDragEnd(pageX, pageY) {
    this.selectionRegion.dimensions = {
      right: pageX,
      bottom: pageY,
    };
    this.#setState(STATES.SELECTED);
  }

  /**
   * Update the selection region dimensions by calling `resizingDrag` and set
   * the state to selected.
   *
   * @param {number} pageX The x position relative to the page
   * @param {number} pageY The y position relative to the page
   */
  resizingDragEnd(pageX, pageY) {
    this.resizingDrag(pageX, pageY);
    this.#setState(STATES.SELECTED);
  }

  /**
   * Keep the instructions bubble out of the way: while the pointer is in the
   * zone around its resting spot, slide it down to a fixed spot just below
   * that zone; it slides back once the pointer leaves. Distances in CSS px.
   * (Replaces Firefox's drawPreviewEyes; the face is not shown.)
   *
   * @param {number} clientX The x position relative to the viewport
   * @param {number} clientY The y position relative to the viewport
   */
  dodgePreviewBubble(clientX, clientY) {
    const margin = 24;
    // The resting spot, ignoring the current (possibly animating) offset.
    let container = this.previewContainer.getBoundingClientRect();
    let left = container.left + this.previewBubble.offsetLeft;
    let top = container.top + this.previewBubble.offsetTop;
    let right = left + this.previewBubble.offsetWidth;
    let bottom = top + this.previewBubble.offsetHeight;
    let near =
      clientX > left - margin &&
      clientX < right + margin &&
      clientY > top - margin &&
      clientY < bottom + margin;
    // Below the zone (which ends `margin` under the bubble), plus a gap.
    let offset = near ? bottom - top + margin * 2 : 0;
    this.previewBubble.style.setProperty("--bubble-offset", `${offset}px`);
  }

  showPreviewContainer() {
    this.previewContainer.hidden = false;
  }

  hidePreviewContainer() {
    this.previewContainer.hidden = true;
  }

  updatePreviewContainer() {
    let { clientWidth, clientHeight } = this.windowDimensions.dimensions;
    this.previewContainer.style.width = `${clientWidth}px`;
    this.previewContainer.style.height = `${clientHeight}px`;
  }

  /**
   * Update the screenshots overlay container based on the window dimensions.
   */
  updateScreenshotsOverlayContainer() {
    let { scrollWidth, scrollHeight, scrollMinX } =
      this.windowDimensions.dimensions;
    this.screenshotsContainer.style = `left:${scrollMinX}px;width:${scrollWidth}px;height:${scrollHeight}px;`;
  }

  /**
   * Draw the hover element container based on the hover element region.
   */
  drawHoverElementRegion() {
    this.showHoverElementContainer();

    let { top, left, width, height } = this.hoverElementRegion.dimensions;

    this.hoverElementContainer.style = `top:${top}px;left:${left}px;width:${width}px;height:${height}px;`;
  }

  showHoverElementContainer() {
    this.hoverElementContainer.hidden = false;
  }

  hideHoverElementContainer() {
    this.hoverElementContainer.hidden = true;
  }

  /**
   * Draw each background element and the highlight element base on the
   * selection region.
   */
  drawSelectionContainer() {
    this.showSelectionContainer();

    let { top, left, right, bottom, width, height } =
      this.selectionRegion.dimensions;

    this.highlightEl.style = `top:${top}px;left:${left}px;width:${width}px;height:${height}px;`;

    this.leftBackgroundEl.style = `top:${top}px;width:${left}px;height:${height}px;`;
    this.topBackgroundEl.style.height = `${top}px`;
    this.rightBackgroundEl.style = `top:${top}px;left:${right}px;width:calc(100% - ${right}px);height:${height}px;`;
    this.bottomBackgroundEl.style = `top:${bottom}px;height:calc(100% - ${bottom}px);`;

    this.updateSelectionSizeText();
  }

  /**
   * Update the size of the selected region. Use the zoom to correctly display
   * the region dimensions.
   */
  updateSelectionSizeText() {
    let { width, height } = this.selectionRegion.dimensions;
    let zoom = Math.round(this.fullZoom * 100) / 100;

    this.selectionSize.textContent = l10n(
      "screenshots-overlay-selection-region-size-3",
      Math.floor(width * zoom),
      Math.floor(height * zoom)
    );
  }

  showSelectionContainer() {
    this.selectionContainer.hidden = false;
  }

  hideSelectionContainer() {
    this.selectionContainer.hidden = true;
  }

  /**
   * Draw the buttons container in the bottom right corner of the selection
   * container if possible.
   * The buttons will be visible in the viewport if the selection container
   * is within the viewport, otherwise skip drawing the buttons.
   */
  drawButtonsContainer() {
    this.showButtonsContainer();

    let {
      left: boxLeft,
      top: boxTop,
      right: boxRight,
      bottom: boxBottom,
    } = this.selectionRegion.dimensions;

    let { clientWidth, clientHeight, scrollX, scrollY, scrollWidth } =
      this.windowDimensions.dimensions;

    if (!this.windowDimensions.isInViewport(this.selectionRegion.dimensions)) {
      // The box is entirely offscreen so need to draw the buttons

      return;
    }

    let top = boxBottom;

    if (scrollY + clientHeight - boxBottom < 70) {
      if (boxBottom < scrollY + clientHeight) {
        top = boxBottom - 60;
      } else if (scrollY + clientHeight - boxTop < 70) {
        top = boxTop - 60;
      } else {
        top = scrollY + clientHeight - 60;
      }
    }

    if (!this.buttonsContainerRect) {
      this.buttonsContainerRect = this.buttonsContainer.getBoundingClientRect();
    }

    let viewportLeft = scrollX;
    let viewportRight = scrollX + clientWidth;

    let left, right;
    let isLTR = !isAppLocaleRTL;
    if (isLTR) {
      left = Math.max(
        Math.min(viewportRight, boxRight),
        viewportLeft + Math.ceil(this.buttonsContainerRect.width)
      );
      right = scrollWidth - left;

      this.buttonsContainer.style.right = `${right}px`;
      this.buttonsContainer.style.left = "";
    } else {
      left = Math.min(
        Math.max(viewportLeft, boxLeft),
        viewportRight - Math.ceil(this.buttonsContainerRect.width)
      );

      this.buttonsContainer.style.left = `${left}px`;
      this.buttonsContainer.style.right = "";
    }

    this.buttonsContainer.style.top = `${top}px`;
  }

  showButtonsContainer() {
    this.buttonsContainer.hidden = false;
  }

  hideButtonsContainer() {
    this.buttonsContainer.hidden = true;
  }

  /**
   * Set the pointer events to none on the screenshots elements so
   * elementFromPoint can find the real element at the given point.
   */
  setPointerEventsNone() {
    this.screenshotsContainer.style.pointerEvents = "none";
  }

  resetPointerEvents() {
    this.screenshotsContainer.style.pointerEvents = "";
  }

  /**
   * Try to find a reasonable element for a given point.
   * If a reasonable element is found, draw the hover element container for
   * that element region.
   *
   * @param {number} clientX The x position relative to the viewport
   * @param {number} clientY The y position relative to the viewport
   */
  async handleElementHover(clientX, clientY) {
    this.setPointerEventsNone();
    let promise = getElementFromPoint(clientX, clientY, this.document);
    this.resetPointerEvents();
    let { ele, rect } = await promise;

    if (
      this.#cachedEle &&
      !(this.#cachedEle instanceof HTMLIFrameElement) &&
      this.#cachedEle === ele
    ) {
      // Still hovering over the same element
      return;
    }
    this.#cachedEle = ele;

    if (!rect) {
      // this means we found an element that wasn't an iframe
      rect = getBestRectForElement(ele, this.document);
    }

    if (rect) {
      this.hoverElementRegion.setDimensionsFromDOMRect(rect);
      this.drawHoverElementRegion();
    } else {
      this.hoverElementRegion.resetDimensions();
      this.hideHoverElementContainer();
    }
  }

  /**
   * Scroll the viewport if near one or both of the edges.
   *
   * @param {number} pageX The x position relative to the page
   * @param {number} pageY The y position relative to the page
   */
  scrollIfByEdge(pageX, pageY) {
    let { scrollX, scrollY, clientWidth, clientHeight } =
      this.windowDimensions.dimensions;

    if (pageY - scrollY < SCROLL_BY_EDGE) {
      // Scroll up
      this.scrollWindow(0, -(SCROLL_BY_EDGE - (pageY - scrollY)));
    } else if (scrollY + clientHeight - pageY < SCROLL_BY_EDGE) {
      // Scroll down
      this.scrollWindow(0, SCROLL_BY_EDGE - (scrollY + clientHeight - pageY));
    }

    if (pageX - scrollX <= SCROLL_BY_EDGE) {
      // Scroll left
      this.scrollWindow(-(SCROLL_BY_EDGE - (pageX - scrollX)), 0);
    } else if (scrollX + clientWidth - pageX <= SCROLL_BY_EDGE) {
      // Scroll right
      this.scrollWindow(SCROLL_BY_EDGE - (scrollX + clientWidth - pageX), 0);
    }
  }

  /**
   * Scroll the window by the given amount.
   *
   * @param {number} x The x amount to scroll
   * @param {number} y The y amount to scroll
   */
  scrollWindow(x, y) {
    this.window.scrollBy(x, y);
    this.updateScreenshotsOverlayDimensions("scroll");
  }

  /**
   * The page was resized or scrolled. We need to update the screenshots
   * container size so we don't draw outside the page bounds.
   *
   * @param {string} eventType will be "scroll" or "resize"
   */
  async updateScreenshotsOverlayDimensions(eventType) {
    let updateWindowDimensionsPromise = this.updateWindowDimensions();

    if (this.#state === STATES.CROSSHAIRS) {
      if (eventType === "resize") {
        this.hideHoverElementContainer();
        this.#cachedEle = null;
      } else if (eventType === "scroll") {
        if (this.#lastClientX && this.#lastClientY) {
          this.#cachedEle = null;
          this.handleElementHover(this.#lastClientX, this.#lastClientY);
        }
      }
    } else if (this.#state === STATES.SELECTED) {
      await updateWindowDimensionsPromise;
      this.selectionRegion.shift();
      this.drawSelectionContainer();
      this.drawButtonsContainer();
      this.updateSelectionSizeText();
    }
  }

  /**
   * Returns the window's dimensions for the current window.
   *
   * @return {object} An object containing window dimensions
   *   {
   *     clientWidth: The width of the viewport
   *     clientHeight: The height of the viewport
   *     scrollWidth: The width of the enitre page
   *     scrollHeight: The height of the entire page
   *     scrollX: The X scroll offset of the viewport
   *     scrollY: The Y scroll offest of the viewport
   *     scrollMinX: The X minimum the viewport can scroll to
   *     scrollMinY: The Y minimum the viewport can scroll to
   *     scrollMaxX: The X maximum the viewport can scroll to
   *     scrollMaxY: The Y maximum the viewport can scroll to
   *   }
   */
  getDimensionsFromWindow() {
    let { innerHeight, innerWidth, scrollY, scrollX } = this.window;

    // Firefox reads the scrollbar size from windowUtils and the scroll range
    // from window.scrollMin/MaxX/Y; derive them from the scrolling element.
    let docEl = this.document.scrollingElement || this.document.documentElement;
    let clientHeight = Math.min(docEl.clientHeight, innerHeight);
    let clientWidth = Math.min(docEl.clientWidth, innerWidth);

    // Use the document element's scrollWidth/scrollHeight which give the
    // actual content dimensions via a single rounding. The previous formula
    // (innerHeight + scrollMaxY - scrollMinY) can overshoot by 1 CSS pixel
    // because it adds separately rounded values derived from the scroll
    // range, causing transparent rows at the image edges.
    let scrollWidth = Math.max(docEl.scrollWidth, clientWidth);
    let scrollHeight = Math.max(docEl.scrollHeight, clientHeight);

    // In RTL documents horizontal scroll positions are negative.
    let isRTL = getComputedStyle(docEl).direction === "rtl";
    let scrollMinX = isRTL ? clientWidth - scrollWidth : 0;
    let scrollMinY = 0;
    let scrollMaxX = scrollMinX + scrollWidth - clientWidth;
    let scrollMaxY = scrollHeight - clientHeight;

    return {
      clientWidth,
      clientHeight,
      scrollWidth,
      scrollHeight,
      scrollX,
      scrollY,
      scrollMinX,
      scrollMinY,
      scrollMaxX,
      scrollMaxY,
    };
  }

  /**
   * We have to be careful not to draw the overlay larger than the document
   * because the overlay is absolutely position and within the document so we
   * can cause the document to overflow when it shouldn't. To mitigate this,
   * we will temporarily position the overlay to position fixed with width and
   * height 100% so the overlay is within the document bounds. Then we will get
   * the dimensions of the document to correctly draw the overlay.
   */
  async updateWindowDimensions() {
    // Setting the screenshots container attribute "resizing" will make the
    // overlay fixed position with width and height of 100% percent so it
    // does not draw outside the actual document.
    this.screenshotsContainer.toggleAttribute("resizing", true);

    await new Promise(r => this.window.requestAnimationFrame(r));

    let {
      clientWidth,
      clientHeight,
      scrollWidth,
      scrollHeight,
      scrollX,
      scrollY,
      scrollMinX,
      scrollMinY,
      scrollMaxX,
      scrollMaxY,
    } = this.getDimensionsFromWindow();
    this.screenshotsContainer.toggleAttribute("resizing", false);

    this.windowDimensions.dimensions = {
      clientWidth,
      clientHeight,
      scrollWidth,
      scrollHeight,
      scrollX,
      scrollY,
      scrollMinX,
      scrollMinY,
      scrollMaxX,
      scrollMaxY,
      devicePixelRatio: this.window.devicePixelRatio,
    };

    this.updatePreviewContainer();
    this.updateScreenshotsOverlayContainer();

    setMaxDetectHeight(Math.max(clientHeight + 100, 700));
    setMaxDetectWidth(Math.max(clientWidth + 100, 1000));
  }
}
