// Unit tests for the rules behind added tools (docker/harness/packages.mjs).
//
//   node --test tests/packages.test.mjs
//
// What a tool name may be, which names belong to an agent or a toolchain, and
// how mise's registry, version list and tool details read. Pure functions over
// strings, so nothing here runs mise.
import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalTool, displayName, indexRegistry, isPreview, isReservedTool, isVersionSpec, managedElsewhere,
  parseDuration, parseRegistry, parseReleases, parseToolInfo, parseToolSpec,
} from "../docker/harness/packages.mjs";

// The shape `mise registry --json --hide-aliased` prints (2026.9.10).
const REGISTRY = JSON.stringify([
  { short: "ripgrep", backends: ["aqua:BurntSushi/ripgrep", "asdf:https://gitlab.com/wt0f/asdf-ripgrep", "cargo:ripgrep"], bins: ["rg"], description: "ripgrep recursively searches directories", aliases: ["rg"] },
  { short: "claude", backends: ["aqua:anthropics/claude-code", "http:claude"], bins: ["claude"], description: "Claude Code", aliases: ["claude-code"] },
  { short: "cursor-agent", backends: ["http:cursor-agent"], bins: ["cursor-agent"], description: "Cursor CLI", aliases: ["cursor-cli"] },
  { short: "uv", backends: ["aqua:astral-sh/uv", "pypi:uv"], bins: ["uv"], description: "An extremely fast Python package manager" },
  { short: "node", backends: ["core:node"], bins: ["node", "npm", "npx"], description: `Node.js ${"x".repeat(400)}` },
  { short: "jq", backends: ["aqua:jqlang/jq"], bins: ["jq"], description: "Command-line JSON processor" },
  { nonsense: true },
]);

test("tool names: registry names and backend specs pass, anything argv- or URL-shaped does not", () => {
  for (const id of ["ripgrep", "jq", "1password", "npm:prettier", "npm:@biomejs/biome", "github:cli/cli", "aqua:BurntSushi/ripgrep",
    "cargo:cargo-nextest", "pypi:black", "go:github.com/mikefarah/yq/v4", "ubi:owner/repo", "gem:rubocop"]) {
    const parsed = parseToolSpec(id);
    assert.equal(parsed.ok, true, id);
    assert.equal(parsed.id, id);
  }
  assert.deepEqual(parseToolSpec("  npm:prettier ").backend, "npm");
  for (const id of ["", "  ", "-v", "--help", "a b", "jq;rm -rf", "asdf:https://evil.example/plugin", "github:owner/repo/", "../x",
    "x/../y", "Npm:prettier", "npm:", ":jq", "jq\nx", "tool[exe=sh]", "a".repeat(200)]) {
    assert.equal(parseToolSpec(id).ok, false, JSON.stringify(id));
  }
  assert.match(parseToolSpec("--help").error, /not a mise tool name/);
  assert.match(parseToolSpec("").error, /Name a tool/);
});

test("versions: what mise accepts, nothing that could be a flag", () => {
  for (const v of ["1.8.2", "3.12", "latest", "lts", "nightly", "2026.10.01-e373342", "1.0.0+build.5", "v2"]) assert.equal(isVersionSpec(v), true, v);
  for (const v of ["", "-1", "--force", "1 2", "1.2;x", "x".repeat(80)]) assert.equal(isVersionSpec(v), false, v);
});

test("a row is named by its registry name, or the last part of a backend spec", () => {
  assert.equal(displayName("ripgrep"), "ripgrep");
  assert.equal(displayName("aqua:BurntSushi/ripgrep"), "ripgrep");
  assert.equal(displayName("npm:@biomejs/biome"), "biome");
  assert.equal(displayName("npm:prettier"), "prettier");
  assert.equal(displayName("go:github.com/mikefarah/yq/v4"), "v4");
});

test("the registry reads into names, descriptions, backend kinds, binaries and aliases", () => {
  const entries = parseRegistry(REGISTRY);
  assert.deepEqual(entries.map((e) => e.name), ["claude", "cursor-agent", "jq", "node", "ripgrep", "uv"], "sorted, malformed entries dropped");
  const rg = entries.find((e) => e.name === "ripgrep");
  assert.deepEqual(rg.kinds, ["aqua", "asdf", "cargo"]);
  assert.deepEqual(rg.bins, ["rg"]);
  assert.deepEqual(rg.aliases, ["rg"]);
  assert.ok(entries.find((e) => e.name === "node").description.length <= 220, "long descriptions are capped");
  assert.deepEqual(parseRegistry("not json"), []);
  assert.deepEqual(parseRegistry("{}"), []);
});

test("agents and toolchains own their names in every spelling", () => {
  const index = indexRegistry(parseRegistry(REGISTRY));
  assert.equal(isReservedTool("claude"), true);
  assert.equal(isReservedTool("cursor-agent"), true);
  assert.equal(isReservedTool("ripgrep"), false);
  assert.deepEqual(managedElsewhere("claude-code", index), { kind: "agent", id: "claude", name: "Claude Code" });
  assert.deepEqual(managedElsewhere("aqua:anthropics/claude-code", index), { kind: "agent", id: "claude", name: "Claude Code" });
  assert.deepEqual(managedElsewhere("cursor-cli", index), { kind: "agent", id: "cursor", name: "Cursor" });
  assert.deepEqual(managedElsewhere("cursor", index), { kind: "agent", id: "cursor", name: "Cursor" });
  assert.deepEqual(managedElsewhere("pypi:uv", index), { kind: "toolchain", id: "uv", name: "uv" });
  assert.deepEqual(managedElsewhere("core:go", null), { kind: "toolchain", id: "go", name: "Go" }, "core: needs no registry");
  assert.equal(managedElsewhere("ripgrep", index), null);
  assert.equal(managedElsewhere("npm:prettier", index), null);
});

test("an alias becomes its registry name; specs and unknown names stay as typed", () => {
  const index = indexRegistry(parseRegistry(REGISTRY));
  assert.equal(canonicalTool("rg", index), "ripgrep");
  assert.equal(canonicalTool("ripgrep", index), "ripgrep");
  assert.equal(canonicalTool("aqua:BurntSushi/ripgrep", index), "aqua:BurntSushi/ripgrep");
  assert.equal(canonicalTool("terraform", index), "terraform");
  assert.equal(canonicalTool("rg", null), "rg");
});

test("ls-remote reads newest first, with dates and previews; tool details read their backend and verification", () => {
  const releases = parseReleases(JSON.stringify([
    { version: "1.7", created_at: "2023-09-07T00:00:00.0Z", release_url: "https://github.com/jqlang/jq/releases/tag/jq-1.7" },
    { version: "1.8.0-rc.1" },
    { version: "1.8.0-beta", prerelease: false },
    { version: "--force" },
    { nonsense: true },
    { version: "1.8.2", created_at: "2026-06-20T14:11:27.0Z", prerelease: false },
  ]));
  assert.deepEqual(releases.map((r) => r.version), ["1.8.2", "1.8.0-beta", "1.8.0-rc.1", "1.7"], "newest first; nothing argv-shaped");
  assert.equal(releases[0].releasedAt, "2026-06-20T14:11:27.000Z");
  assert.equal(releases[2].releasedAt, null, "a backend that does not date its releases");
  assert.deepEqual(releases.map((r) => r.prerelease), [false, true, true, false], "a preview by its flag or its name");
  assert.equal(isPreview({ version: "2.0.0", prerelease: true }), true);
  assert.equal(isPreview({ version: "2026.10.01-e373342" }), false, "a build suffix is not a preview");
  assert.deepEqual(parseReleases("1.7\n1.8"), [], "plain text is not the JSON listing");
  const info = parseToolInfo(JSON.stringify({
    backend: "aqua:BurntSushi/ripgrep", description: "rg", installed_versions: ["15.0.0"],
    security: [{ type: "checksum", algorithm: "sha256" }, { type: "github_attestations" }, { type: "checksum", algorithm: "sha512" }],
  }));
  assert.deepEqual(info, { backend: "aqua:BurntSushi/ripgrep", description: "rg", security: ["checksum", "github_attestations"], installedVersions: ["15.0.0"] });
  assert.equal(parseToolInfo("nope"), null);
});

test("mise's release age reads as milliseconds, or nothing when it is not a duration", () => {
  assert.equal(parseDuration("24h"), 86_400_000);
  assert.equal(parseDuration(" 1d "), 86_400_000);
  assert.equal(parseDuration("90m"), 5_400_000);
  assert.equal(parseDuration("0s"), 0);
  assert.equal(parseDuration("1.5h"), 5_400_000);
  for (const value of ["", null, "2024-06-01", "soon", "24 hours", "-1h"]) assert.equal(parseDuration(value), null, String(value));
});
