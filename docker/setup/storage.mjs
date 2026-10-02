// How durable the mounts holding state and work are, and how big.
//
// The same verdict t3-doctor prints, from the same evidence: field 4 of
// /proc/self/mountinfo is a mount's source and field 5 its mount point, and the
// source is the only way from inside a container to tell a bind mount from a
// named volume from an anonymous one. That distinction matters because the
// image declares VOLUME /home/t3, and an anonymous volume looks persistent from
// the inside while being replaced on every recreate.
import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The mount covering `path`, longest mount point first: `{ point, root }` or null. */
export function coveringMount(path, mountinfo) {
  let best = null;
  for (const line of String(mountinfo ?? "").split("\n")) {
    const fields = line.split(" ");
    const root = fields[3];
    const point = fields[4];
    if (!point || point === "/") continue;
    if (path === point || path.startsWith(`${point}/`)) {
      if (!best || point.length > best.point.length) best = { point, root };
    }
  }
  return best;
}

/** `durable` (named volume or host path), `anonymous`, or `none` (inside the container). */
export function mountKind(path, mountinfo) {
  const mount = coveringMount(path, mountinfo);
  if (!mount) return "none";
  const volume = /\/var\/lib\/docker\/volumes\/([^/]+)\/_data/.exec(mount.root);
  if (volume) return /^[0-9a-f]{64}$/.test(volume[1]) ? "anonymous" : "durable";
  return "durable";
}

/** Git repositories T3 Code registers on start: the workspace itself, or its children. */
export async function countProjects(workspace) {
  const isRepo = async (dir) => {
    try { await stat(`${dir}/.git`); return true; } catch { return false; }
  };
  if (await isRepo(workspace)) return 1;
  let entries = [];
  try { entries = await readdir(workspace, { withFileTypes: true }); } catch { return 0; }
  let count = 0;
  for (const entry of entries) {
    if (entry.isDirectory() && await isRepo(`${workspace}/${entry.name}`)) count += 1;
  }
  return count;
}

/**
 * Storage facts, refreshed in the background and served from memory: `du`
 * over a home full of toolchains takes seconds, which no poll should wait on.
 */
export function createStorageFacts({ volume, workspace, intervalMs = 10 * 60 * 1000, now = Date.now }) {
  let facts = { volumeKind: null, workspaceKind: null, volumeBytes: null, workspaceProjects: null, at: null };
  let running = null;

  const refresh = () => {
    if (running) return running;
    running = (async () => {
      const next = { ...facts };
      try {
        const mountinfo = await readFile("/proc/self/mountinfo", "utf8");
        next.volumeKind = mountKind(volume, mountinfo);
        next.workspaceKind = mountKind(workspace, mountinfo);
      } catch { /* not Linux: say nothing rather than guess */ }
      try {
        const { stdout } = await run("du", ["-sb", volume], { timeout: 120_000, maxBuffer: 1024 * 1024 });
        const bytes = Number(stdout.trim().split(/\s+/)[0]);
        if (Number.isFinite(bytes)) next.volumeBytes = bytes;
      } catch (error) {
        // du exits non-zero on one unreadable file but still prints the total.
        const bytes = Number(String(error?.stdout ?? "").trim().split(/\s+/)[0]);
        if (Number.isFinite(bytes) && bytes > 0) next.volumeBytes = bytes;
      }
      next.workspaceProjects = await countProjects(workspace);
      next.at = now();
      facts = next;
    })().finally(() => { running = null; });
    return running;
  };

  const timer = setInterval(() => { void refresh(); }, intervalMs);
  timer.unref?.();

  return {
    refresh,
    /** What is known now; never waits. */
    snapshot: () => ({ ...facts }),
    stop: () => clearInterval(timer),
  };
}
