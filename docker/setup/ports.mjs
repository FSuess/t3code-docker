// What is listening in the container, read from `ss -H -l -t -n -p`.
//
// Pure: server.mjs runs ss and hands the text here, so the parsing - the part
// that has to cope with IPv6 brackets, interface suffixes and one row per
// bound address - is unit-tested without a kernel.

// A database port gets a confirmation before it is published: a quick tunnel
// has nothing in front of it, and a dev database rarely has a password worth
// the name.
export const DATABASE_PORTS = new Set([5432, 3306, 6379, 27017, 9000]);
export const DATABASE_PROCESSES = /^(postgres|mysqld|mariadbd|redis-server|mongod|clickhouse)/;

/** Whether a listener looks like a database, by port or by process name. */
export const looksLikeDatabase = (port, process) =>
  DATABASE_PORTS.has(Number(port)) || DATABASE_PROCESSES.test(String(process ?? ""));

const WILDCARDS = new Set(["*", "0.0.0.0", "::", ""]);

// Runtimes whose process name says nothing about what they run: for these the
// script is the name worth showing ("vite", not "node").
const RUNTIMES = /^(node|nodejs|bun|deno|python[0-9.]*|ruby|php|java|uv|npx|pnpm|yarn|npm|tsx|ts-node)$/;
const SCRIPT_SUFFIX = /\.(m?js|cjs|ts|mts|py|rb)$/;
const base = (value) => String(value ?? "").split("/").filter(Boolean).pop() ?? "";

/**
 * A readable name for a listener from its command line: the program, or for a
 * runtime the script it runs (`node .../vite/bin/vite.js` is "vite",
 * `python3 -m http.server` is "http.server"). Falls back to what ss reported,
 * which for Node is the main thread's name - literally "MainThread".
 */
export function processLabel(argv, fallback = null) {
  const args = (argv ?? []).filter((arg) => arg !== "");
  if (!args.length) return fallback;
  // A process that set its own title ("next-server (v15.0.0)") keeps the name.
  const program = base(args[0]).replace(/\s*\(v?[\d.]+[^)]*\)$/, "");
  if (!RUNTIMES.test(program)) return program || fallback;
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-m" && args[i + 1]) return args[i + 1];
    if (arg.startsWith("-")) continue;
    // `bun run dev`, `npx vite`: the subcommand is not the name.
    if (i === 1 && /^(run|exec|x|dlx)$/.test(arg)) continue;
    // node_modules/vite/bin/vite.js and node_modules/.bin/vite both say vite.
    const parts = arg.split("/").filter(Boolean);
    const modules = parts.lastIndexOf("node_modules");
    if (modules !== -1 && parts[modules + 1] && parts[modules + 1] !== ".bin") {
      const pkg = parts[modules + 1].startsWith("@") ? parts[modules + 2] : parts[modules + 1];
      if (pkg) return pkg;
    }
    return base(arg).replace(SCRIPT_SUFFIX, "") || program;
  }
  return program;
}

/** "127.0.0.1:3000" / "[::1]:3000" / "*:3000" / "127.0.0.53%lo:53" -> { address, port } */
export function splitLocal(local) {
  const cut = String(local ?? "").lastIndexOf(":");
  if (cut < 0) return null;
  const port = Number(local.slice(cut + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const address = local.slice(0, cut).replace(/^\[|\]$/g, "").replace(/%[^%\s]*$/, "");
  return { address, port };
}

/**
 * One entry per port, in port order: `{ port, process, pid, address, looksLikeDatabase }`.
 *
 *   reserved   ports that belong to the container's plumbing (T3 Code, this console)
 *   ephemeral  [lo, hi], the kernel's ephemeral range, where T3 Code's own probes land
 *
 * cloudflared's own metrics listener is dropped: publishing a port opened a
 * second "port" in this list, which nobody would want to publish.
 */
export function parseListeners(stdout, { reserved = new Set(), ephemeral = [32768, 60999] } = {}) {
  const byPort = new Map();
  for (const line of String(stdout ?? "").split("\n")) {
    if (!line.trim() || /"cloudflared"/.test(line)) continue;
    const local = splitLocal(line.trim().split(/\s+/)[3]);
    if (!local) continue;
    const { port, address } = local;
    if (reserved.has(port)) continue;
    if (port >= ephemeral[0] && port <= ephemeral[1]) continue;
    const owner = /users:\(\("([^"]+)",pid=(\d+)/.exec(line);
    // ss lists one row per bound address; a server on :: and 0.0.0.0 is one port.
    const entry = byPort.get(port) ?? { port, process: null, pid: null, addresses: [] };
    entry.process ??= owner?.[1] ?? null;
    entry.pid ??= owner ? Number(owner[2]) : null;
    entry.addresses.push(address);
    byPort.set(port, entry);
  }
  return [...byPort.values()]
    .sort((a, b) => a.port - b.port)
    .map(({ port, process, pid, addresses }) => ({
      port,
      process,
      pid,
      // Every interface when any row says so; else the first, IPv4 first.
      address: addresses.some((a) => WILDCARDS.has(a))
        ? "0.0.0.0"
        : addresses.find((a) => !a.includes(":")) ?? addresses[0] ?? null,
      looksLikeDatabase: looksLikeDatabase(port, process),
    }));
}
