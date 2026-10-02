// Any mise tool, beyond the agents and the five toolchains.
//
// A "package" here is a tool in the user's global mise config that this image
// does not manage under another name: ripgrep, kubectl, terraform, python, an
// `npm:` or `github:` spec. The manager installs, updates and removes them the
// same way it does a toolchain - one at a time under the global lock, pinned to
// an exact version - and adopts the ones someone added with `mise use -g`.
//
// Pure: no process, no filesystem. The manager and the setup service run mise
// and hand its output here, so the rules - what a tool name may be, which names
// belong to an agent or a toolchain, how the registry reads - are unit-tested
// without mise.
import { CATALOGUE, TOOLCHAINS } from "./catalogue.mjs";

// `[backend:]name`. The backend is any lowercase word (mise owns that list and
// grows it: aqua, asdf, github, cargo, npm, pypi, ...). The name may carry an
// npm scope or an owner/repo path, but never starts with a dash (it is an argv
// entry), never contains whitespace, and never contains a second colon, which
// keeps URL-shaped plugin sources (`asdf:https://...`) out: those clone and run
// code from wherever they point.
const TOOL_SPEC = /^(?:([a-z][a-z0-9-]{0,31}):)?([A-Za-z0-9@_][A-Za-z0-9@._/+-]{0,127})$/;

// A version as mise spells them: 1.8.2, 2026.10.01-e373342, 3.12 (a prefix
// mise resolves), latest, lts, nightly.
const VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;

/**
 * Validate a tool name typed or picked by a person. Returns the id as mise
 * should see it (`ripgrep`, `npm:prettier`) or a sentence saying what is wrong.
 */
export function parseToolSpec(raw) {
  const id = String(raw ?? "").trim();
  if (!id) return { ok: false, error: "Name a tool, for example ripgrep or npm:prettier." };
  const match = TOOL_SPEC.exec(id);
  if (!match || id.includes("..") || id.endsWith("/")) {
    return { ok: false, error: `“${id.slice(0, 80)}” is not a mise tool name. Use a registry name (ripgrep) or backend:name (npm:prettier, github:owner/repo).` };
  }
  return { ok: true, id, backend: match[1] ?? null, name: match[2] };
}

/** Whether a version string is one mise could be asked for. */
export const isVersionSpec = (value) => VERSION.test(String(value ?? "").trim());

/**
 * The name a row shows: the registry name as is, or for a backend spec the last
 * meaningful part (`aqua:BurntSushi/ripgrep` -> ripgrep, `npm:@biomejs/biome`
 * -> biome, `github:cli/cli` -> cli).
 */
export function displayName(id) {
  const spec = String(id ?? "");
  const colon = spec.indexOf(":");
  if (colon === -1) return spec;
  const name = spec.slice(colon + 1);
  const parts = name.split("/").filter(Boolean);
  return parts[parts.length - 1] || name;
}

/**
 * `mise registry --json --hide-aliased` -> the fields the console uses, with
 * backends reduced to their kind (aqua, cargo, ...) for display. Descriptions
 * are capped: a few run to paragraphs.
 */
export function parseRegistry(text) {
  let list;
  try {
    list = JSON.parse(String(text ?? ""));
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item.short !== "string" || !item.short) continue;
    const backends = Array.isArray(item.backends) ? item.backends.filter((b) => typeof b === "string") : [];
    const description = typeof item.description === "string" ? item.description.trim() : "";
    out.push({
      name: item.short,
      description: description.length > 220 ? `${description.slice(0, 217).trimEnd()}…` : description,
      backends,
      kinds: [...new Set(backends.map((b) => b.split(":")[0]))],
      bins: Array.isArray(item.bins) ? item.bins.filter((b) => typeof b === "string") : [],
      aliases: Array.isArray(item.aliases) ? item.aliases.filter((a) => typeof a === "string" && a !== item.short) : [],
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Lookups over a parsed registry: a name or alias to its entry, and a full
 * backend spec (`aqua:BurntSushi/ripgrep`) to the registry name it belongs to.
 */
export function indexRegistry(entries) {
  const byName = new Map();
  const byBackend = new Map();
  for (const entry of entries ?? []) {
    byName.set(entry.name, entry);
    for (const alias of entry.aliases ?? []) if (!byName.has(alias)) byName.set(alias, entry);
    for (const backend of entry.backends ?? []) if (!byBackend.has(backend)) byBackend.set(backend, entry);
  }
  return { byName, byBackend, entries: entries ?? [] };
}

// The mise tool names the agents and toolchains are configured under. They are
// installed, updated and removed on their own pages, with their own rules
// (exact verification, T3's provider wiring), never as a package.
const RESERVED = new Map([
  ...CATALOGUE.map((entry) => [entry.miseTool, { kind: "agent", id: entry.id, name: entry.name }]),
  ...CATALOGUE.map((entry) => [entry.id, { kind: "agent", id: entry.id, name: entry.name }]),
  ...TOOLCHAINS.map((entry) => [entry.miseTool, { kind: "toolchain", id: entry.id, name: entry.name }]),
]);

/** Whether a mise tool name is one an agent or toolchain is configured under. */
export const isReservedTool = (id) => RESERVED.has(String(id ?? ""));

/**
 * Which agent or toolchain owns a tool name, through any of its spellings: the
 * name itself, a registry alias (claude-code), or a backend spec that resolves
 * to it (core:go, aqua:anthropics/claude-code). Null when it is free to add.
 */
export function managedElsewhere(id, registry) {
  const spec = String(id ?? "");
  if (RESERVED.has(spec)) return RESERVED.get(spec);
  const viaName = registry?.byName?.get(spec);
  if (viaName && RESERVED.has(viaName.name)) return RESERVED.get(viaName.name);
  const viaBackend = registry?.byBackend?.get(spec);
  if (viaBackend && RESERVED.has(viaBackend.name)) return RESERVED.get(viaBackend.name);
  // `core:go` is go whether or not the registry lists that exact spelling.
  if (spec.startsWith("core:") && RESERVED.has(spec.slice(5))) return RESERVED.get(spec.slice(5));
  return null;
}

/**
 * The registry name a typed alias stands for (`rg` -> ripgrep), so a tool is
 * configured under one name whatever it was asked for by. Backend specs and
 * unknown names are kept as typed.
 */
export function canonicalTool(id, registry) {
  const entry = registry?.byName?.get(String(id ?? ""));
  return entry ? entry.name : String(id ?? "");
}

// Release names that are previews by their own say, for backends whose
// listing does not flag them (`prerelease`).
const PREVIEW = /[-.+_](?:alpha|beta|rc|pre|preview|dev|canary|nightly|next|snapshot|insiders)\b/i;

/** Whether a release is a preview, by its listing's flag or its name. */
export const isPreview = (release) => Boolean(release?.prerelease) || PREVIEW.test(String(release?.version ?? ""));

/**
 * `mise ls-remote --json` -> releases newest first, each with when it was
 * published where the backend says (`releasedAt`, ISO) and whether it is a
 * preview. Anything that is not a version mise could install is dropped.
 */
export function parseReleases(text) {
  let list;
  try {
    list = JSON.parse(String(text ?? ""));
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const version = typeof item?.version === "string" ? item.version.trim() : "";
    if (!isVersionSpec(version)) continue;
    const at = typeof item.created_at === "string" && !Number.isNaN(Date.parse(item.created_at)) ? new Date(item.created_at).toISOString() : null;
    out.push({ version, releasedAt: at, prerelease: isPreview(item) });
  }
  return out.reverse();
}

const UNIT_MS = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5, y: 31536e6 };

/**
 * A mise duration setting ("24h", "1d", "90m", "0s") in milliseconds, or null
 * for anything else - an absolute date, or nothing set.
 */
export function parseDuration(text) {
  const match = /^(\d+(?:\.\d+)?)\s*([smhdwy])$/i.exec(String(text ?? "").trim());
  return match ? Math.round(Number(match[1]) * UNIT_MS[match[2].toLowerCase()]) : null;
}

/** `mise tool <id> --json` -> where it comes from and how its downloads are verified. */
export function parseToolInfo(text) {
  let info;
  try {
    info = JSON.parse(String(text ?? ""));
  } catch {
    return null;
  }
  if (!info || typeof info !== "object") return null;
  const security = Array.isArray(info.security)
    ? [...new Set(info.security.map((s) => s?.type).filter((t) => typeof t === "string"))]
    : [];
  return {
    backend: typeof info.backend === "string" ? info.backend : null,
    description: typeof info.description === "string" ? info.description : null,
    security,
    installedVersions: Array.isArray(info.installed_versions) ? info.installed_versions.filter((v) => typeof v === "string") : [],
  };
}
