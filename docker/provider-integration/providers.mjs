// The bridge between the harness catalogue and T3 Code's provider settings.
//
// The harness manager identifies harnesses by a stable `id` (`claude`,
// `codex`, ...). T3 Code keys its settings by provider *driver kind*, and the
// two do not line up: Claude's driver kind is `claudeAgent`, and Cursor's
// executable is `cursor-agent` while its driver kind is `cursor`. This mapping
// is data only, so the module, the CLI and the tests all speak the same names.
//
// `defaultBinary` is what T3 falls back to when `binaryPath` is empty
// (`makeBinaryPathSetting` in T3's settings schema). A settings file holding
// exactly that value has not been customised, so the managed path may replace
// it; anything else someone typed is theirs.
export const PROVIDERS = Object.freeze([
  { id: "claude", driver: "claudeAgent", name: "Claude Code", defaultBinary: "claude" },
  { id: "codex", driver: "codex", name: "Codex", defaultBinary: "codex" },
  { id: "opencode", driver: "opencode", name: "OpenCode", defaultBinary: "opencode" },
  { id: "grok", driver: "grok", name: "Grok Build", defaultBinary: "grok" },
  { id: "cursor", driver: "cursor", name: "Cursor", defaultBinary: "cursor-agent" },
]);

/** The T3 driver kind for a harness id, or null when the id is unknown. */
export function driverFor(id) {
  return PROVIDERS.find((provider) => provider.id === id)?.driver ?? null;
}

/** The harness id for a T3 driver kind, or null when the kind is unknown. */
export function idFor(driver) {
  return PROVIDERS.find((provider) => provider.driver === driver)?.id ?? null;
}
