/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The privileged half of browser/components/screenshots/ScreenshotsUtils.sys.mjs:
// the "screenshot-button" widget (ScreenshotsCustomizableWidget), the
// key_screenshot shortcut, the "Take Screenshot" context menu item, and the
// pieces content can't do itself (capturing pixels, downloads, alerts).
// Everything else runs in the page; see content/.

const CONTENT_SCRIPTS = [
  "content/overlayHelpers.js",
  "content/fileHelpers.js",
  "content/ScreenshotsOverlayChild.js",
  "content/screenshots-buttons.js",
  "content/screenshots-preview.js",
  "content/ScreenshotsUtils.js",
];

/**
 * ScreenshotsUtils.toggle() for the given tab, injecting the content side on
 * first use.
 */
async function toggle(tab) {
  let target = { tabId: tab.id };
  let run = () =>
    chrome.scripting.executeScript({
      target,
      func: () => {
        if (typeof ScreenshotsUtils === "undefined") {
          return false;
        }
        ScreenshotsUtils.toggle();
        return true;
      },
    });
  try {
    let [{ result }] = await run();
    if (!result) {
      await chrome.scripting.executeScript({ target, files: CONTENT_SCRIPTS });
      await run();
    }
  } catch (e) {
    // Pages extensions can't script (chrome://, the Web Store, ...).
    console.warn(`Screenshots unavailable on this page: ${e.message}`);
  }
}

chrome.action.onClicked.addListener(toggle);

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "context-take-screenshot",
    title: chrome.i18n.getMessage("main_context_menu_take_screenshot_label"),
    contexts: ["all"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "context-take-screenshot") {
    toggle(tab);
  }
});

// screenshot-toolbar-button.tooltiptext: "Take a screenshot (Ctrl+Shift+S)"
chrome.commands.getAll().then(commands => {
  let shortcut = commands.find(c => c.name === "_execute_action")?.shortcut;
  chrome.action.setTitle({
    title: shortcut
      ? chrome.i18n.getMessage("screenshot_toolbar_button_tooltiptext", shortcut)
      : chrome.i18n.getMessage("screenshot_toolbar_button_label"),
  });
});

// chrome.tabs.captureVisibleTab is limited to 2 calls per second.
const CAPTURE_INTERVAL_MS = 1000 / chrome.tabs.MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND + 50;
let captureQueue = Promise.resolve();
let lastCapture = 0;

function captureVisibleTab(windowId) {
  let capture = captureQueue.then(async () => {
    let wait = lastCapture + CAPTURE_INTERVAL_MS - Date.now();
    if (wait > 0) {
      await new Promise(resolve => setTimeout(resolve, wait));
    }
    lastCapture = Date.now();
    return chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  });
  captureQueue = capture.catch(() => {});
  return capture;
}

/**
 * Resolves true once the download completes, false if it is interrupted
 * (e.g. the user cancels the "Save as" dialog). Firefox awaits
 * download.start() the same way before closing the preview.
 */
function waitForDownload(id) {
  return new Promise(resolve => {
    let done = state => {
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve(state === "complete");
    };
    let onChanged = delta => {
      if (delta.id === id && delta.state && delta.state.current !== "in_progress") {
        done(delta.state.current);
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search({ id }).then(([item]) => {
      if (item && item.state !== "in_progress") {
        done(item.state);
      }
    });
  });
}

const handlers = {
  "Screenshots:GetZoom": (message, sender) => chrome.tabs.getZoom(sender.tab.id),

  "Screenshots:CaptureVisibleTab": (message, sender) =>
    captureVisibleTab(sender.tab.windowId),

  async "Screenshots:Download"({ url, filename }) {
    let id;
    try {
      id = await chrome.downloads.download({ url, filename });
    } catch (e) {
      // e.g. a filename the OS rejects; fall back to the date-only name.
      console.warn(`Failed to download using filename: ${filename}`, e);
      id = await chrome.downloads.download({
        url,
        filename: filename.replace(/^(Screenshot \S+ at \S+).*$/, "$1.png"),
      });
    }
    return waitForDownload(id);
  },

  async "Screenshots:Alert"({ title, message }) {
    // AlertsService.showAlert in Firefox.
    await chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon-128.png",
      title,
      message,
    });
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  let handler = handlers[message.name];
  if (!handler) {
    return false;
  }
  Promise.resolve(handler(message, sender)).then(sendResponse, e => {
    console.error(e);
    sendResponse(null);
  });
  return true;
});
