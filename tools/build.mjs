// Packages the extension into dist/geckoshot-<version>.zip and .crx.
//
//   npm run build
//
// The CRX is signed with a private key, which also fixes the extension ID.
// CI passes it in the CRX_PRIVATE_KEY environment variable (a GitHub secret).
// Locally the key lives in geckoshot.pem (git-ignored) and is created on the
// first build. Keep it: a new key means a new extension ID.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crx3 from "crx3";

const root = path.resolve(import.meta.dirname, "..");
const SHIPPED = ["manifest.json", "background.js", "content", "icons", "_locales"];

const { version } = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const dist = path.join(root, "dist");
const stage = path.join(dist, "geckoshot");
fs.rmSync(dist, { recursive: true, force: true });
for (const entry of SHIPPED) {
  fs.cpSync(path.join(root, entry), path.join(stage, entry), { recursive: true });
}

let keyPath = path.join(root, "geckoshot.pem");
if (process.env.CRX_PRIVATE_KEY) {
  keyPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "crx-")), "key.pem");
  fs.writeFileSync(keyPath, process.env.CRX_PRIVATE_KEY, { mode: 0o600 });
} else if (process.env.RELEASE_TAG) {
  // Releases must keep the extension ID. (Other CI builds, e.g. pull requests
  // from forks, don't get secrets and sign with a throwaway key.)
  throw new Error("CRX_PRIVATE_KEY is not set; refusing to release with a throwaway key.");
}

const name = `geckoshot-${version}`;
await crx3([stage], {
  keyPath,
  crxPath: path.join(dist, `${name}.crx`),
  zipPath: path.join(dist, `${name}.zip`),
});
fs.rmSync(stage, { recursive: true });

// Chromium's extension ID: the first 128 bits of SHA-256(public key), as a-p.
const publicKey = crypto
  .createPublicKey(fs.readFileSync(keyPath))
  .export({ type: "spki", format: "der" });
const id = [...crypto.createHash("sha256").update(publicKey).digest("hex").slice(0, 32)]
  .map(c => String.fromCharCode(97 + parseInt(c, 16)))
  .join("");

console.log(`Built dist/${name}.crx and dist/${name}.zip (extension ID ${id})`);
