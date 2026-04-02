import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);

/** Lazy-load the OWS native module (NAPI binding, requires CJS require). */
export function loadOws(): typeof import("@open-wallet-standard/core") {
  return _require("@open-wallet-standard/core");
}
