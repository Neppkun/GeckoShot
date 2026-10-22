/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Ported from browser/components/screenshots/screenshots-preview.mjs (and
// screenshots-preview.html).
//
// Firefox opens <screenshots-preview> in a tab-modal dialog
// (gBrowser.getTabDialogBox). The closest web equivalent is a modal <dialog>
// in the top layer of the page, which also blocks the page and closes on Esc.
// The preview shows the canvas itself rather than a blob: <img>, so the
// page's CSP can't block it.

class ScreenshotsPreview {
  constructor() {
    this.downloadKey = l10n("screenshots-component-download-key");
    this.copyKey = l10n("screenshots-component-copy-key");

    this.content = insertAnonymousContent(document);
    let root = this.content.root;
    linkStylesheet(root, "content/screenshots.css");
    let template = document.createElement("template");
    template.innerHTML = this.render();
    root.append(template.content);

    this.dialog = root.querySelector("dialog");
    this.retryButtonEl = root.getElementById("retry");
    this.cancelButtonEl = root.getElementById("cancel");
    this.copyButtonEl = root.getElementById("copy");
    this.downloadButtonEl = root.getElementById("download");
    this.previewImageContainer = root.getElementById("preview-image-container");
    this.buttons = root.querySelectorAll("button");

    this.closedPromise = new Promise(resolve => {
      this.dialog.addEventListener(
        "close",
        () => {
          removeAnonymousContent(this.content);
          resolve();
        },
        { once: true }
      );
    });
    root.querySelector(".preview-buttons").addEventListener("click", this);
    this.dialog.addEventListener("keydown", this, true);
    this.dialog.showModal();
  }

  close() {
    this.dialog.close();
  }

  handleEvent(event) {
    switch (event.type) {
      case "click":
        this.handleClick(event);
        break;
      case "keydown":
        this.handleKeydown(event);
        break;
    }
  }

  handleClick(event) {
    switch (event.target.closest("button")?.id) {
      case "retry":
        ScreenshotsUtils.retry();
        break;
      case "cancel":
        this.close();
        break;
      case "copy":
        this.saveToClipboard();
        break;
      case "download":
        this.saveToFile();
        break;
    }
  }

  handleKeydown(event) {
    // Keep the page's own shortcuts out of the modal preview.
    event.stopPropagation();
    switch (event.key) {
      case this.copyKey.toLowerCase():
        if (this.getAccelKey(event)) {
          event.preventDefault();
          this.saveToClipboard();
        }
        break;
      case this.downloadKey.toLowerCase():
        if (this.getAccelKey(event)) {
          event.preventDefault();
          this.saveToFile();
        }
        break;
    }
  }

  /**
   * Show the screenshot. Firefox sets previewImg.src to a blob URL.
   *
   * @param {HTMLCanvasElement} canvas
   */
  showCanvas(canvas) {
    this.canvas = canvas;
    canvas.id = "preview-image";
    this.previewImageContainer.append(canvas);
  }

  getAccelKey(event) {
    return isMac ? event.metaKey : event.ctrlKey;
  }

  /**
   * Enable all the buttons. This will only happen when the download button is
   * clicked and the file picker is closed without saving the image.
   */
  enableButtons() {
    this.buttons.forEach(button => (button.disabled = false));
  }

  /**
   * Disable all the buttons so they can't be clicked multiple times before
   * successfully copying or downloading the image.
   */
  disableButtons() {
    this.buttons.forEach(button => (button.disabled = true));
  }

  async saveToFile() {
    // Disable buttons so they can't by clicked again while saving.
    this.disableButtons();

    let downloadSucceeded = await ScreenshotsUtils.downloadScreenshot(
      this.canvas
    );

    if (downloadSucceeded) {
      this.close();
    } else {
      this.enableButtons();
    }
  }

  async saveToClipboard() {
    // Disable buttons so they can't by clicked again while copying.
    this.disableButtons();

    await ScreenshotsUtils.copyScreenshot(this.canvas);
    this.close();
  }

  /**
   * Set the focus to the most recent saved method.
   * This will default to the download button.
   *
   * @param {string} buttonToFocus
   */
  focusButton(buttonToFocus) {
    if (buttonToFocus === "copy") {
      this.copyButtonEl.focus({ focusVisible: true });
    } else {
      this.downloadButtonEl.focus({ focusVisible: true });
    }
  }

  render() {
    let accelString = getAccelString();
    let copyShortcut = accelString + this.copyKey;
    let downloadShortcut = accelString + this.downloadKey;
    return `
      <dialog class="dialogBox">
        <div class="image-view">
          <div class="preview-buttons">
            <button
              id="retry"
              class="icon-only"
              title="${l10n("screenshots-component-retry-button.title")}"
              aria-label="${l10n("screenshots-component-retry-button.aria-label")}"
            ><span class="icon"></span></button>
            <button
              id="cancel"
              class="icon-only"
              title="${l10n("screenshots-component-cancel-button.title")}"
              aria-label="${l10n("screenshots-component-cancel-button.aria-label")}"
            ><span class="icon"></span></button>
            <button
              id="copy"
              title="${l10n("screenshots-component-copy-button-2.title", copyShortcut)}"
              aria-label="${l10n("screenshots-component-copy-button-2.aria-label")}"
            ><span class="icon"></span><label>${l10n("screenshots-component-copy-button-2")}</label></button>
            <button
              id="download"
              class="primary"
              title="${l10n("screenshots-component-download-button-2.title", downloadShortcut)}"
              aria-label="${l10n("screenshots-component-download-button-2.aria-label")}"
            ><span class="icon"></span><label>${l10n("screenshots-component-download-button-2")}</label></button>
          </div>
          <div id="preview-image-container"></div>
        </div>
      </dialog>
    `;
  }
}
