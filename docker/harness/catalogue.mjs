// The five supported agent harnesses. This file is data only: every executable
// name, architecture, credential surface, and minimum version the manager
// enforces comes from here, so the module, the setup console, and the CLI all
// describe the same harnesses.

/**
 * T3 refuses to serve OpenCode below this version, so a managed install must
 * not select one. T3's provider contract requires this minimum version.
 */
export const MINIMUM_OPENCODE_VERSION = "1.14.19";

/**
 * Canonical Cursor executable. `agent` is an alias only the vendor installer
 * creates; mise's `http:cursor-agent` backend recreates `cursor-agent` alone,
 * and an `agent` binary on PATH collides with Grok's aqua package, so nothing
 * here ever names it.
 */
export const CURSOR_EXECUTABLE = "cursor-agent";

/**
 * `executable` is the path relative to the mise install directory. `versionArgs`
 * is the bounded probe the manager runs to turn "a file exists" into "this
 * exact version runs". `miseOptions` are mise tool options passed with every
 * `mise use`, so an update keeps them.
 */
export const CATALOGUE = Object.freeze([
  {
    id: "claude",
    name: "Claude Code",
    miseTool: "claude",
    executable: "claude",
    versionArgs: ["--version"],
    versionPattern: "(\\d+\\.\\d+\\.\\d+)",
    minimumVersion: null,
    // Both release assets exist for x64 and arm64.
    architectures: ["x64", "arm64"],
    credentials: {
      env: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
      paths: [".claude/.credentials.json"],
    },
    auth: "claude",
  },
  {
    id: "codex",
    name: "Codex",
    miseTool: "codex",
    executable: "bin/codex",
    versionArgs: ["--version"],
    versionPattern: "(\\d+\\.\\d+\\.\\d+)",
    minimumVersion: null,
    architectures: ["x64", "arm64"],
    credentials: {
      env: [],
      paths: [".codex/auth.json"],
    },
    auth: "codex",
  },
  {
    id: "opencode",
    name: "OpenCode",
    miseTool: "opencode",
    executable: "opencode",
    versionArgs: ["--version"],
    versionPattern: "(\\d+\\.\\d+\\.\\d+)",
    minimumVersion: MINIMUM_OPENCODE_VERSION,
    architectures: ["x64", "arm64"],
    credentials: {
      env: [],
      paths: [".local/share/opencode/auth.json"],
    },
    auth: "opencode",
  },
  {
    id: "grok",
    name: "Grok Build",
    miseTool: "grok",
    executable: "grok",
    versionArgs: ["--version"],
    versionPattern: "(\\d+\\.\\d+\\.\\d+)",
    minimumVersion: null,
    architectures: ["x64", "arm64"],
    credentials: {
      env: ["XAI_API_KEY"],
      paths: [".grok/auth.json"],
    },
    auth: "grok",
  },
  {
    id: "cursor",
    name: "Cursor",
    miseTool: CURSOR_EXECUTABLE,
    executable: `dist-package/${CURSOR_EXECUTABLE}`,
    // Cursor's package is a whole runtime: dist-package holds its own `node`,
    // `rg` and a dozen helpers next to cursor-agent. mise's registry exposes
    // that directory, so installing Cursor used to shadow the image's node and
    // ripgrep for every agent and terminal. Point bin_path at a directory that
    // does not exist instead: nothing gets a shim, and T3, sign-in and the
    // browser helper all launch cursor-agent by its absolute path anyway.
    miseOptions: "bin_path=dist-package/.t3-no-shims",
    // With no shim, a shell would not find it at all. The manager keeps a
    // link to exactly the installed executable on the t3 user's PATH instead,
    // and removes it on uninstall - so T3, which looks agents up by name,
    // sees Cursor exactly when it is installed.
    linkOnPath: true,
    versionArgs: ["--version"],
    // Cursor versions are date-hash pins, not semver; 2026.09.15-d2fe57e.
    versionPattern: "(\\d{4}\\.\\d{2}\\.\\d{2}-[0-9a-f]+)",
    minimumVersion: null,
    architectures: ["x64", "arm64"],
    credentials: {
      env: [],
      paths: [".cursor/cli-config.json"],
    },
    auth: "cursor",
  },
]);

/** Look up one catalogue entry by its stable id. */
export function getHarness(id) {
  return CATALOGUE.find((entry) => entry.id === id) ?? null;
}

/** Map `dpkg --print-architecture`/uname spellings onto node's arch names. */
export function normalizeArch(arch) {
  switch (String(arch ?? "")) {
    case "amd64":
    case "x86_64":
    case "x64":
      return "x64";
    case "arm64":
    case "aarch64":
      return "arm64";
    default:
      return String(arch ?? "") || null;
  }
}

/** Whether this catalogue entry publishes an artifact for the host arch. */
export function supportsArch(entry, arch) {
  const normalized = normalizeArch(arch);
  return normalized !== null && entry.architectures.includes(normalized);
}

/**
 * The toolchains the image used to bake, now installed into the persistent
 * home through mise and selected globally, so `go`, `cargo`, `bun`, `deno` and
 * `uv` work in any directory. A project's own mise.toml or idiomatic file
 * still wins inside that project. `probe` proves the install runs.
 */
export const TOOLCHAINS = Object.freeze([
  { id: "go", name: "Go", miseTool: "go", probe: ["go", "version"] },
  {
    id: "rust",
    name: "Rust",
    miseTool: "rust",
    // What the old image installed: a minimal profile plus the two components
    // an agent reaches for. rustup itself is bootstrapped by mise.
    miseOptions: "components=clippy,rustfmt,profile=minimal",
    probe: ["cargo", "--version"],
  },
  { id: "bun", name: "Bun", miseTool: "bun", probe: ["bun", "--version"] },
  { id: "deno", name: "Deno", miseTool: "deno", probe: ["deno", "--version"] },
  { id: "uv", name: "uv", miseTool: "uv", probe: ["uv", "--version"] },
]);

/** Look up one toolchain by its stable id. */
export function getToolchain(id) {
  return TOOLCHAINS.find((entry) => entry.id === id) ?? null;
}
