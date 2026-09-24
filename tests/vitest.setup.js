import { existsSync } from "node:fs";
import path from "node:path";

// Run every Harness process through the native anchor, as the Shim does in
// production. `npm run test:typescript` builds it; without a build the suite
// exercises the Host-side fallback instead.
const anchor = path.resolve(import.meta.dirname, "..", "target", "debug", "codexhost-anchor");
if (
  process.platform !== "win32" &&
  !process.env.CODEXHOST_PROCESS_ANCHOR_PATH &&
  existsSync(anchor)
) {
  process.env.CODEXHOST_PROCESS_ANCHOR_PATH = anchor;
}
