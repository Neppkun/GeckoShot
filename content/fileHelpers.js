/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Ported from browser/components/screenshots/fileHelpers.mjs.
//
// Firefox resolves the full target path itself (download dir or file
// picker). chrome.downloads picks the directory, and shows the "Save as"
// picker when the user's "Ask where to save each file" setting is on, so only
// the filename is computed here.

// Windows allows 255 character filenames in the filepicker
// macOS has a max filename length of 255 characters
// Linux has a max filename length of 255 bytes
const MAX_FILENAME_LENGTH = 255;

/**
 * Linux has a max length of bytes while macOS and Windows has a max length of
 * characters so we have to check them differently.
 *
 * @param {string} filename The current clipped filename
 * @param {string} maxFilenameLength The max length of the filename
 * @returns {boolean} True if the filename is too long, otherwise false
 */
function checkFilenameLength(filename, maxFilenameLength) {
  if (/Linux/.test(navigator.platform)) {
    return new Blob([filename]).size > maxFilenameLength;
  }

  return filename.length > maxFilenameLength;
}

/**
 * Gets the filename for a screenshot of the page with the given title.
 *
 * @param filenameTitle The title of the current page
 * @returns {string}
 */
function getFilename(filenameTitle) {
  const date = new Date();
  const maxFilenameLength = MAX_FILENAME_LENGTH;
  /* eslint-disable no-control-regex */
  filenameTitle = filenameTitle
    .replace(/[\\/]/g, "_")
    .replace(/[\u200e\u200f\u202a-\u202e]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f:*?|"<>;,+=\[\]]+/g, " ")
    .replace(/^[\s\u180e.]+|[\s\u180e.]+$/g, "");
  /* eslint-enable no-control-regex */
  filenameTitle = filenameTitle.replace(/\s{1,4000}/g, " ");
  const currentDateTime = new Date(
    date.getTime() - date.getTimezoneOffset() * 60 * 1000
  ).toISOString();
  const filenameDate = currentDateTime.substring(0, 10);
  const filenameTime = currentDateTime.substring(11, 19).replace(/:/g, "-");
  let clipFilename = `Screenshot ${filenameDate} at ${filenameTime}`;
  if (filenameTitle.length) {
    clipFilename += " " + filenameTitle;
  }

  // allow space for a potential ellipsis and the extension
  let maxNameStemLength = maxFilenameLength - "[...].png".length;

  // Crop the filename size so as to leave
  // room for the extension and an ellipsis [...]. Note that JS
  // strings are UTF16 but the filename will be converted to UTF8
  // when saving which could take up more space, and we want a
  // maximum of maxFilenameLength bytes (not characters). Here, we iterate
  // and crop at shorter and shorter points until we fit into
  // our max number of bytes.
  let suffix = "";
  for (let cropSize = maxNameStemLength; cropSize >= 0; cropSize -= 1) {
    if (checkFilenameLength(clipFilename, maxNameStemLength)) {
      clipFilename = clipFilename.substring(0, cropSize);
      suffix = "[...]";
    } else {
      break;
    }
  }
  clipFilename += suffix;

  return clipFilename + ".png";
}
