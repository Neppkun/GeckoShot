/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Ported from browser/components/screenshots/screenshots-buttons.js.
//
// Firefox puts <screenshots-buttons> in a .screenshotsPagePanel box at the
// top of the tab's content area (browser chrome). Here it's a plain element
// in the overlay's shadow root, pinned to the same spot of the viewport.

class ScreenshotsButtons {
  static get markup() {
    return `
        <div class="screenshotsPagePanel moz-button-group bar" hidden>
          <button id="visible-page" class="screenshot-button footer-button">${ScreenshotsButtons.icon("menu-visible")}${l10n("screenshots-save-visible-button")}</button>
          <button id="full-page" class="screenshot-button footer-button primary">${ScreenshotsButtons.icon("menu-fullpage")}${l10n("screenshots-save-page-button")}</button>
        </div>
      `;
  }

  /**
   * The menu-visible/menu-fullpage SVGs use -moz-context-properties
   * (context-fill, context-stroke), which Chromium doesn't support for
   * images, so they are inlined and coloured by screenshots.css.
   */
  static icon(name) {
    return {
      "menu-visible": `<svg class="screenshot-button-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 46 46" aria-hidden="true"><path d="M5 12c0-.6.5-1 1-1h34c.6 0 1 .5 1 1v24c0 .6-.5 1-1 1H6c-.6 0-1-.5-1-1V12zm2 23V13h32v22H7z" class="icon-fill"/><path d="M7 35h32V13H7z" class="icon-stroke"/><path d="M38 19h1v-2h-1v2zm0 3h1v-2h-1v2zm0 3h1v-2h-1v2zm0 3h1v-2h-1v2zm0 3h1v-2h-1v2zm0 3h1v-2h-1v2zm-1 1h2v-1h-2v1zm-3 0h2v-1h-2v1zm-3 0h2v-1h-2v1zm-3 0h2v-1h-2v1zm-3 0h2v-1h-2v1zm-3 0h2v-1h-2v1zm-3 0h2v-1h-2v1zm-3 0h2v-1h-2v1zm-3 0h2v-1h-2v1zm-3 0h2v-1h-2v1zm-2-3H7v3h2v-1H8v-2zm-1-1h1v-2H7v2zm0-3h1v-2H7v2zm0-3h1v-2H7v2zm0-3h1v-2H7v2zm0-3h1v-2H7v2zm2-6H7v3h1v-2h1v-1zm1 1h2v-1h-2v1zm3 0h2v-1h-2v1zm3 0h2v-1h-2v1zm3 0h2v-1h-2v1zm3 0h2v-1h-2v1zm3 0h2v-1h-2v1zm3 0h2v-1h-2v1zm3 0h2v-1h-2v1zm3 0h2v-1h-2v1zm5-1h-2v1h1v2h1v-3z" class="icon-fill" opacity="0.5"/></svg>`,
      "menu-fullpage": `<svg class="screenshot-button-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 46 46" aria-hidden="true"><path d="M7 42h32V5.1H7z" class="icon-stroke"/><g transform="translate(0 6)"><path d="M40 5c.5 0 1 .4 1 1v24c0 .5-.5 1-1 1H6c-.6 0-1-.5-1-1V6c0-.6.4-1 1-1h34zM7 29h32V7H7v22z" class="icon-fill"/><path class="icon-fill" d="M7 7h32V5H7z"/><path class="icon-fill" d="M7 31h32v-2H7z"/></g><path d="M38 11h1V9h-1v2zm0 3h1v-2h-1v2zm0 3h1v-2h-1v2zm0 3h1v-2h-1v2zm0 3h1v-2h-1v2zm0 3h1v-2h-1v2zm0 3h1v-2h-1v2zm0 3h1v-2h-1v2zm0 3h1v-2h-1v2zm0 3h1v-2h-1v2zm0 3h1v-2h-1v2zm-1 1h2v-1h-2v1zm-3 0h2v-1h-2v1zm-3 0h2v-1h-2v1zm-3 0h2v-1h-2v1zm-3 0h2v-1h-2v1zm-3 0h2v-1h-2v1zm-3 0h2v-1h-2v1zm-3 0h2v-1h-2v1zm-3 0h2v-1h-2v1zm-3 0h2v-1h-2v1zm-2-3H7v3h2v-1H8v-2zm-1-1h1v-2H7v2zm0-3h1v-2H7v2zm0-3h1v-2H7v2zm0-3h1v-2H7v2zm0-3h1v-2H7v2zm0-3h1v-2H7v2zm0-3h1v-2H7v2zm0-3h1v-2H7v2zm0-3h1v-2H7v2zm0-3h1V9H7v2zm2-6H7v3h1V6h1V5zm1 1h2V5h-2v1zm3 0h2V5h-2v1zm3 0h2V5h-2v1zm3 0h2V5h-2v1zm3 0h2V5h-2v1zm3 0h2V5h-2v1zm3 0h2V5h-2v1zm3 0h2V5h-2v1zm3 0h2V5h-2v1zm5-1h-2v1h1v2h1V5z" class="icon-fill" opacity="0.5"/></svg>`,
    }[name];
  }

  /**
   * @param {ShadowRoot} root The overlay's shadow root to add the panel to.
   */
  constructor(root) {
    let template = document.createElement("template");
    template.innerHTML = ScreenshotsButtons.markup;
    this.element = template.content.firstElementChild;
    root.append(this.element);
  }

  get hidden() {
    return this.element.hidden;
  }

  set hidden(value) {
    this.element.hidden = value;
  }

  get visibleButton() {
    return this.element.querySelector("#visible-page");
  }
  get fullpageButton() {
    return this.element.querySelector("#full-page");
  }

  handleEvent(event) {
    let button = event.composedPath()[0].closest?.("button");
    if (!button) {
      return;
    }
    switch (button) {
      case this.visibleButton:
        ScreenshotsUtils.takeScreenshot("Visible");
        break;
      case this.fullpageButton:
        ScreenshotsUtils.takeScreenshot("FullPage");
        break;
    }
  }

  /**
   * Focus a button in the panel. "first"/"last" pick the edge button,
   * so tab focus can wrap between the panel and the overlay.
   * Otherwise the default is the last-used save button.
   *
   * @param {string} buttonToFocus
   */
  async focusButton(buttonToFocus) {
    if (buttonToFocus === "fullpage") {
      this.fullpageButton.focus({ focusVisible: true });
    } else if (buttonToFocus === "first") {
      this.element.firstElementChild.focus({ focusVisible: true });
    } else if (buttonToFocus === "last") {
      this.element.lastElementChild.focus({ focusVisible: true });
    } else {
      this.visibleButton.focus({ focusVisible: true });
    }
  }
}
