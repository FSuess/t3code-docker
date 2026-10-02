// One lock for the whole harness manager.
//
// mise writes a single user-wide config and one installs tree, so two installs
// racing each other can half-write configuration or report a harness runnable
// while its files are still being extracted. The setup server, the first-boot
// preinstall and `t3-harness` are separate processes, so the lock is a file.
//
// The lock is written complete to a private temp file and then hard-linked
// into place. link(2) fails with EEXIST when the lock exists, so creation is
// atomic and a reader can never observe a half-written holder.
//
// A holder is the pair (pid, process start time). A pid alone is not enough:
// after a container restart the setup server is usually reborn with the same
// pid, and a lock left by the killed one would look alive until the age
// ceiling. The ceiling stays only as a backstop for a holder that is alive but
// hung. The reader (including status) never writes, so a stuck lock cannot be
// "cleaned up" into a silent concurrent install.
import crypto from "node:crypto";
import path from "node:path";
import { processAlive as defaultProcessAlive, processStartTime as defaultStartTime } from "./io.mjs";

export function lockPath(stateDir) {
  return path.join(stateDir, "harness.lock");
}

/** Parse a lock file; malformed content is treated as stale, never trusted. */
export async function readLock(ctx) {
  try {
    const raw = await ctx.fs.readFile(ctx.lockPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** A lock is stale when its owner is gone, was replaced, or it is too old. */
export function lockIsStale(holder, ctx) {
  if (!holder) return true;
  const alive = ctx.isAlive ?? defaultProcessAlive;
  if (!alive(holder.pid)) return true;
  if (holder.startTime) {
    const startTimeOf = ctx.startTimeOf ?? defaultStartTime;
    const current = startTimeOf(holder.pid);
    if (current && current !== holder.startTime) return true;
  }
  if (!Number.isFinite(holder.startedAt)) return true;
  return ctx.now() - holder.startedAt > ctx.lockStaleMs;
}

/** Read-only view used by status: is a live operation holding the lock? */
export async function liveHolder(ctx) {
  const holder = await readLock(ctx);
  if (!holder) return null;
  return lockIsStale(holder, ctx) ? null : holder;
}

/**
 * Acquire the global lock, or report the live holder. Stale locks are removed
 * and retried, so an interrupted install heals on the next operation.
 */
export async function acquireLock(ctx, { id, operation }) {
  await ctx.fs.mkdir(path.dirname(ctx.lockPath), { recursive: true });
  const startTimeOf = ctx.startTimeOf ?? defaultStartTime;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const token = crypto.randomBytes(12).toString("hex");
    const holder = {
      pid: ctx.pid,
      startTime: startTimeOf(ctx.pid),
      token,
      id,
      operation,
      startedAt: ctx.now(),
    };
    const tmp = `${ctx.lockPath}.${token}`;

    let linked = false;
    try {
      await ctx.fs.writeFile(tmp, JSON.stringify(holder), { encoding: "utf8", flag: "wx" });
      await ctx.fs.link(tmp, ctx.lockPath);
      linked = true;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        return { acquired: false, holder: null, error: String(error?.message ?? error) };
      }
    } finally {
      try { await ctx.fs.unlink(tmp); } catch { /* never written */ }
    }

    if (!linked) {
      const current = await readLock(ctx);
      if (!lockIsStale(current, ctx)) {
        return { acquired: false, holder: current, error: null };
      }
      // The owner is gone. Read the lock again immediately before removing it,
      // so a lock another process took in the meantime is never the one that
      // gets deleted; then race for ours on the next pass.
      const again = await readLock(ctx);
      if ((again?.token ?? null) !== (current?.token ?? null)) continue;
      try { await ctx.fs.unlink(ctx.lockPath); } catch { /* someone else won */ }
      continue;
    }

    return {
      acquired: true,
      holder,
      release: async () => {
        const current = await readLock(ctx);
        if (current?.token !== token) return;
        try { await ctx.fs.unlink(ctx.lockPath); } catch { /* already gone */ }
      },
    };
  }

  return { acquired: false, holder: await readLock(ctx), error: null };
}
