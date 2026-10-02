// Public surface of the persistent harness manager.
//
//   import { createHarnessManager } from "./harness/index.mjs";
//   const harness = createHarnessManager();
//   const { harnesses, degraded } = await harness.status();
//   const result = await harness.install("claude");            // latest, recorded exact
//   const result = await harness.update("opencode", { version: "1.18.31" });
//   const result = await harness.uninstall("grok");
//   const { toolchains } = await harness.toolchains.status();
//   await harness.toolchains.install("rust");                 // latest, recorded exact
//   const { packages } = await harness.packages.status();      // any other global mise tool
//   await harness.packages.install("ripgrep");                 // or "npm:prettier", { version: "3.12" }
//
// `status`/`resolve` are read-only. `install`/`update`/`uninstall` run one at a
// time under a lock and record the exact version they resolved.
export { createHarnessManager } from "./manager.mjs";
export {
  CATALOGUE,
  CURSOR_EXECUTABLE,
  MINIMUM_OPENCODE_VERSION,
  TOOLCHAINS,
  getHarness,
  getToolchain,
  normalizeArch,
  supportsArch,
} from "./catalogue.mjs";
export { parsePreinstall, readPreinstall, runPreinstall } from "./preinstall.mjs";
export {
  canonicalTool, displayName, indexRegistry, isPreview, isReservedTool, isVersionSpec, managedElsewhere,
  parseDuration, parseRegistry, parseReleases, parseToolInfo, parseToolSpec,
} from "./packages.mjs";
export { compareVersions, meetsMinimum } from "./version.mjs";
