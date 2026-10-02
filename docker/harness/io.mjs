// Process and filesystem seams.
//
// Every effect the manager performs goes through one of the two objects built
// here. Production uses the real child process and real files; the unit tests
// inject in-memory equivalents, so exact-version resolution, locking, and
// failure recovery are exercised without touching mise or the host filesystem.
import { spawn } from "node:child_process";
import { promises as fsp, readFileSync } from "node:fs";

/**
 * Run one program to completion and resolve with its result. It never rejects:
 * a non-zero exit and a failed spawn are both facts the caller inspects, which
 * is what lets the manager treat "the backend does not have that version" the
 * same as any other failed operation instead of an unhandled exception.
 */
export function createRunner() {
  return (argv, { env, cwd, timeoutMs = 0, input = null } = {}) =>
    new Promise((resolve) => {
      let child;
      try {
        child = spawn(argv[0], argv.slice(1), {
          env,
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        resolve({ code: null, signal: null, stdout: "", stderr: "", error: String(error?.message ?? error) });
        return;
      }

      let stdout = "";
      let stderr = "";
      let settled = false;
      let timer = null;

      const finish = (code, signal, error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({
          code,
          signal: signal ?? null,
          stdout,
          stderr,
          error: error ? String(error?.message ?? error) : null,
        });
      };

      child.stdout?.on("data", (chunk) => { stdout = (stdout + chunk).slice(-1_000_000); });
      child.stderr?.on("data", (chunk) => { stderr = (stderr + chunk).slice(-1_000_000); });
      child.on("error", (error) => finish(null, null, error));
      child.on("close", (code, signal) => finish(code, signal, null));

      if (input !== null) child.stdin?.end(input);
      else child.stdin?.end();

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* already gone */ }
          finish(null, "SIGKILL", `timed out after ${timeoutMs}ms`);
        }, timeoutMs);
        timer.unref?.();
      }
    });
}

/** The subset of node:fs the manager needs, with a boolean existence check. */
export function createFs() {
  return {
    readFile: (path, encoding = "utf8") => fsp.readFile(path, encoding),
    writeFile: (path, data, options) => fsp.writeFile(path, data, options),
    mkdir: (path, options) => fsp.mkdir(path, options),
    rename: (from, to) => fsp.rename(from, to),
    link: (from, to) => fsp.link(from, to),
    unlink: (path) => fsp.unlink(path),
    stat: (path) => fsp.stat(path),
    async exists(path) {
      try {
        await fsp.stat(path);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** True when the file exists and carries at least one execute bit. */
export async function isExecutable(fs, path) {
  try {
    const info = await fs.stat(path);
    return info.isFile() && (info.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** Whether a pid still exists. EPERM means it exists but is not ours. */
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * When a process started, in clock ticks since boot (field 22 of
 * /proc/<pid>/stat), or null when it cannot be read. A pid alone does not
 * identify a process across a container restart: the setup server is usually
 * reborn with the same pid, so a lock holder is the pair (pid, start time).
 */
export function processStartTime(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name is parenthesised and may contain spaces; the fields
    // after it are fixed. starttime is the 20th field after the closing paren.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19] ?? null;
  } catch {
    return null;
  }
}
