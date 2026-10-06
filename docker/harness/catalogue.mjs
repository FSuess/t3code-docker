// The five supported agent harnesses, the toolchains, and the source control
// CLIs. This file is data only: every executable name, architecture,
// credential surface, and minimum version the manager enforces comes from
// here, so the module, the setup console, and the CLI all describe the same
// tools.

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
 * `mise use`, so an update keeps them. `firstStart` marks the agents a fresh
 * volume installs unasked (T3_PREINSTALL's default); the rest are one press on
 * the Agents page.
 */
export const CATALOGUE = Object.freeze([
  {
    id: "claude",
    name: "Claude Code",
    firstStart: true,
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
    firstStart: true,
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
    firstStart: true,
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
    firstStart: false,
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
    firstStart: false,
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

/**
 * The command-line tools T3 Code drives for each source control provider
 * (its Settings > Source Control): it looks each up by name on PATH and asks
 * it whether it is signed in. Bitbucket needs none; T3 talks to its API with
 * a token saved in that same settings page.
 *
 * GitHub's `gh` is part of the image (`inImage`), at the minimum version T3
 * requires, which the image build checks. The rest install like a toolchain -
 * through mise, into the persistent home - but only when asked: a server
 * rarely talks to more than one host, and Azure's CLI alone is a 330 MB
 * Python install. `bin` is the command T3 runs, `probe` proves an install
 * runs, and `extensions` are az extensions installed with it, because T3's
 * Azure DevOps support runs `az repos`. tea is published on gitea.com, which
 * mise's forgejo backend reaches through `api_url`; the option has to be part
 * of every spec mise resolves releases for, not only the one it installs.
 */
export const SOURCE_CONTROL = Object.freeze([
  {
    id: "gh",
    name: "GitHub CLI",
    provider: "GitHub",
    inImage: true,
    bin: "gh",
    // By its path in the image: a newer gh added through mise comes first on
    // PATH, and is an added tool, not this one.
    probe: ["/usr/bin/gh", "--version"],
    versionPattern: "gh version (\\d+\\.\\d+\\.\\d+)",
    auth: "gh",
  },
  {
    id: "glab",
    name: "GitLab CLI",
    provider: "GitLab",
    miseTool: "glab",
    bin: "glab",
    probe: ["glab", "--version"],
    auth: "glab",
  },
  {
    id: "fj",
    name: "Forgejo CLI",
    provider: "Forgejo",
    miseTool: "forgejo:forgejo-contrib/forgejo-cli",
    bin: "fj",
    probe: ["fj", "version"],
    auth: "fj",
  },
  {
    id: "tea",
    name: "Gitea CLI",
    provider: "Gitea",
    miseTool: "forgejo:gitea/tea",
    miseOptions: "api_url=https://gitea.com/api/v1",
    bin: "tea",
    probe: ["tea", "--version"],
    auth: "tea",
  },
  {
    id: "az",
    name: "Azure CLI",
    provider: "Azure DevOps",
    // Through pipx, which the image has. mise's registry installs azure-cli
    // from PyPI with options only uv understands, and uv is a toolchain that
    // may not be installed. pipx uses uv when it is there anyway, and a uv
    // environment has no pip, which `az extension add` runs: without it the
    // azure-devops extension cannot be added, and the install is rolled back.
    // `--with pip` puts it there; pipx's own environments already have it.
    miseTool: "pipx:azure-cli",
    miseOptions: "uvx_args=--with=pip",
    // The registry's own name for the same package: refused as an added tool,
    // so az is never installed twice.
    registryNames: ["azure-cli"],
    bin: "az",
    probe: ["az", "version", "--output", "json"],
    extensions: ["azure-devops"],
    auth: "az",
  },
]);

/** Look up one source control CLI by its stable id. */
export function getSourceControl(id) {
  return SOURCE_CONTROL.find((entry) => entry.id === id) ?? null;
}

/**
 * Everything installed and updated the way a toolchain is: the toolchains, and
 * the source control CLIs that are not part of the image. One lookup, so the
 * lock, the state record and the routes treat them alike.
 */
export function getManagedTool(id) {
  const scm = getSourceControl(id);
  return getToolchain(id) ?? (scm && !scm.inImage ? scm : null);
}

/**
 * The spec mise resolves an entry's releases under: its tool, with the tool
 * options that change where releases come from (tea's api_url).
 */
export function releaseSpec(entry) {
  return entry.miseOptions ? `${entry.miseTool}[${entry.miseOptions}]` : entry.miseTool;
}
