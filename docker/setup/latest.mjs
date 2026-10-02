// The newest release of each agent and toolchain, so a row can say "2.1.290 is
// available" without anyone asking.
//
// `mise latest` asks a registry, which takes a second or two online and up to
// its timeout offline - far too slow and too flaky for a status poll. So it
// runs here in the background, one tool at a time, at most every few hours,
// and the answers are kept on the state volume so a restart starts warm. A
// poll only ever reads memory. A lookup that fails keeps the last answer: an
// unreachable registry is not news that the update went away.
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

/**
 *   keys      () => ["harness:claude", "toolchain:go", ...]
 *   lookup    (key) => Promise<version>   (throws when it cannot say)
 *   read      () => Promise<string>       the saved cache, or throws
 *   write     (text) => Promise<void>
 */
export function createLatestCache({ keys, lookup, read, write, ttlMs = DEFAULT_TTL_MS, now = Date.now }) {
  let versions = {};          // key -> { version, at }
  let checkedAt = null;       // when a full pass last finished
  let loaded = null;
  let running = null;

  const load = () => {
    loaded ??= (async () => {
      try {
        const saved = JSON.parse(await read());
        if (saved && typeof saved === "object" && saved.versions && typeof saved.versions === "object") {
          versions = saved.versions;
          checkedAt = Number.isFinite(saved.checkedAt) ? saved.checkedAt : null;
        }
      } catch { /* nothing saved yet */ }
    })();
    return loaded;
  };

  /**
   * One pass over every key, unless a recent one already happened. `force`
   * is the "Check for updates now" button. Concurrent callers share a pass.
   */
  const refresh = ({ force = false } = {}) => {
    if (running) return running;
    running = (async () => {
      await load();
      if (!force && checkedAt && now() - checkedAt < ttlMs) return false;
      for (const key of keys()) {
        try {
          const version = String(await lookup(key)).trim();
          if (version) versions[key] = { version, at: now() };
        } catch { /* keep what we had */ }
      }
      checkedAt = now();
      try {
        await write(JSON.stringify({ checkedAt, versions }, null, 2));
      } catch { /* a read-only volume still has the answers in memory */ }
      return true;
    })().finally(() => { running = null; });
    return running;
  };

  /**
   * Look one key up now, outside the schedule: a tool just added at an older
   * release should say a newer one exists without waiting for the next pass.
   */
  const refreshOne = async (key) => {
    await load();
    try {
      const version = String(await lookup(key)).trim();
      if (!version) return;
      versions[key] = { version, at: now() };
      await write(JSON.stringify({ checkedAt, versions }, null, 2));
    } catch { /* the scheduled pass tries again */ }
  };

  return {
    load,
    refresh,
    refreshOne,
    refreshing: () => Boolean(running),
    /** `{ latestVersion, latestCheckedAt }` for a row; nulls when unknown. */
    get: (key) => {
      const hit = versions[key];
      return { latestVersion: hit?.version ?? null, latestCheckedAt: hit?.at ?? null };
    },
    checkedAt: () => checkedAt,
  };
}
