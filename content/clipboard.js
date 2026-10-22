/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Firefox copies with BrowserUtils.copyImageToClipboard from the parent
// process. Content scripts use navigator.clipboard, which doesn't exist on
// insecure (http:) pages; there, ScreenshotsUtils embeds this extension page
// (always a secure context), focuses it and asks it to write the image.
// Requests come over chrome.runtime messaging, which pages can't send.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.name !== "Screenshots:FrameCopy") {
    return false;
  }
  (async () => {
    let blob = await (await fetch(message.url)).blob();
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
  })().then(
    () => sendResponse(true),
    e => sendResponse(e.message)
  );
  return true;
});
