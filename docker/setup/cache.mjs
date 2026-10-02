// Offline-safe cache helpers for the setup console.
//
// `/status` and `/providers` must each answer within five seconds with no
// network. The strategy is the same for both:
// serve bundled or cached state immediately, refresh asynchronously, and
// coalesce concurrent refreshes so background work never accumulates.
//
// Reads never install or update anything: the harness paths below only call
// the manager's read-only `status()`, and the provider path only reads a
// local file or fetches a catalog. Plain ESM with Node built-ins only, and
// every dependency injectable so the unit tests can drive exact timing
// without a container or a network.

/** Per-request bound for the offline endpoints, which should answer within five
// seconds; keep headroom for HTTP framing and the local reads that share it. */
export const STATUS_BUDGET_MS = 4500;

/**
 * Race `work` against `ms` milliseconds. Never rejects: slow or failing work
 * resolves `{ ok: false, error }` while the underlying promise keeps running
 * (a timed-out harness refresh still warms the cache when it settles).
 */
export async function withTimeout(work, ms) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve(work).then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error: String(error?.message ?? error) }),
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, error: `timed out after ${ms}ms` }), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Deduplicate concurrent refresh work. While a promise is in flight every
 * caller shares it; once it settles the next call starts fresh. A rejection
 * clears the slot without poisoning later calls, and an abandoned refresh
 * can never crash the process.
 */
export function createCoalescer() {
  let inflight = null;
  return {
    get pending() {
      return inflight !== null;
    },
    run(work) {
      if (inflight) return inflight;
      inflight = Promise.resolve()
        .then(work)
        .finally(() => {
          inflight = null;
        });
      inflight.catch(() => {});
      return inflight;
    },
  };
}

/** True when there is no timestamp or it is older than `ttlMs`. */
export function isStale(at, now, ttlMs) {
  if (at === null || at === undefined) return true;
  return now - at >= ttlMs;
}

/**
 * The OpenCode provider catalogue behind GET /providers.
 *
 * `snapshot()` is local-only and never waits on the network: it serves the
 * in-memory list, else the disk cache (even when stale), else the bundled
 * fallback, and kicks off one coalesced background fetch whenever the data
 * it served is stale. `fetchList` therefore runs only in the background.
 */
export function createProviderCache({
  readFile,
  writeFile,
  mkdir,
  fetchList,
  now = Date.now,
  ttlMs = 24 * 60 * 60 * 1000,
  minRefreshIntervalMs = 60_000,
  fallback = [],
} = {}) {
  let memo = null; // { list, at, source }
  const coalescer = createCoalescer();
  let lastRefreshStart = 0;

  const ensureRefresh = () => {
    if (coalescer.pending) return coalescer.run(() => null);
    if (now() - lastRefreshStart < minRefreshIntervalMs) return Promise.resolve(null);
    lastRefreshStart = now();
    return coalescer
      .run(async () => {
        const list = await fetchList();
        if (!Array.isArray(list) || list.length === 0) throw new Error("empty catalog");
        memo = { list, at: now(), source: "live" };
        try {
          if (mkdir && writeFile) {
            await mkdir();
            await writeFile(JSON.stringify({ at: memo.at, list }));
          }
        } catch { /* the cache is an optimisation, not a requirement */ }
        return memo;
      })
      .catch(() => null);
  };

  const readDisk = async () => {
    try {
      const cached = JSON.parse(await readFile());
      if (Array.isArray(cached?.list) && cached.list.length) {
        return { list: cached.list, at: typeof cached.at === "number" ? cached.at : null };
      }
    } catch { /* no usable cache; fall through */ }
    return null;
  };

  const snapshot = async () => {
    if (memo) {
      const stale = memo.source !== "live" || isStale(memo.at, now(), ttlMs);
      if (stale) void ensureRefresh();
      return { list: memo.list, at: memo.at, stale, source: memo.source, refreshing: coalescer.pending };
    }
    const disk = await readDisk();
    if (disk) {
      memo = { ...disk, source: "disk" };
      // A disk entry with no timestamp is usable but of unknown age: honest
      // means calling it stale.
      const stale = disk.at === null || isStale(disk.at, now(), ttlMs);
      void ensureRefresh();
      return { list: disk.list, at: disk.at, stale, source: "disk", refreshing: coalescer.pending };
    }
    memo = { list: fallback, at: null, source: "bundled" };
    void ensureRefresh();
    return { list: fallback, at: null, stale: true, source: "bundled", refreshing: coalescer.pending };
  };

  return {
    snapshot,
    refresh: ensureRefresh,
    peek: () => memo,
    get refreshing() {
      return coalescer.pending;
    },
  };
}

/**
 * Authenticated harness facts behind GET /status and GET /harnesses.
 *
 * `full` is the authenticated manager read (bounded probes, but they can
 * still stall offline on remote API checks); `cheap` is the local-only read
 * (`authenticate: false`: one `mise ls` plus filesystem checks).
 *
 * `snapshot()` starts one coalesced `full` refresh (at most one every
 * `refreshIntervalMs`) and races it against `budgetMs`. When the budget wins
 * it answers from local state — warm authenticated facts when they exist and
 * are fresh enough, else a bounded cheap read — with `stale: true`, while the
 * refresh keeps running so the next poll is warm. Only a refresh that
 * actually completed on this request is reported as `live`.
 *
 * `snapshotCheap()` answers the explicit `authenticate=false` polls from a
 * bounded cheap read without starting an auth refresh.
 *
 * `full` and `cheap` must already return the public card shape
 * (`{ harnesses, degraded }`); this never throws, so the endpoint always has
 * *some* answer instead of failing offline.
 */
export function createHarnessCache({
  full,
  cheap,
  budgetMs = 4000,
  refreshIntervalMs = 15_000,
  liveTtlMs = 30_000,
  now = Date.now,
} = {}) {
  let warm = null; // { harnesses, degraded, at, generation }
  let lastFailure = null;
  let generation = 0; // bumped by invalidate(); facts from older runs are not served
  const coalescer = createCoalescer();
  let lastRefreshStart = 0;

  /** Facts are only usable when they were gathered for the current generation. */
  const current = (entry) => Boolean(entry) && entry.generation === generation;

  const startRefresh = () => {
    lastRefreshStart = now();
    lastFailure = null;
    const startedAt = generation;
    return coalescer
      .run(async () => {
        const result = await full();
        const entry = {
          harnesses: result?.harnesses ?? [],
          degraded: result?.degraded ?? [],
          at: now(),
          generation: startedAt,
        };
        // A refresh that began before a credential change must not replace
        // post-write facts, and must not be mistaken for them.
        if (startedAt === generation) warm = entry;
        return entry;
      })
      .catch((error) => {
        lastFailure = { what: "harness refresh", error: String(error?.message ?? error).slice(0, 200) };
        return null;
      });
  };

  const due = () => !coalescer.pending && now() - lastRefreshStart >= refreshIntervalMs;

  const withFailure = (degraded) => (lastFailure ? [...degraded, lastFailure] : degraded);

  const cheapAnswer = async () => {
    const raced = await withTimeout(Promise.resolve().then(cheap), budgetMs);
    if (raced.ok) {
      return {
        harnesses: raced.value?.harnesses ?? [],
        degraded: withFailure(raced.value?.degraded ?? []),
        at: null,
        stale: true,
        source: "cheap",
        refreshing: coalescer.pending,
      };
    }
    return {
      harnesses: [],
      degraded: withFailure([
        { what: "harness probes", error: String(raced.error ?? "unavailable").slice(0, 200) },
      ]),
      at: null,
      stale: true,
      source: "unavailable",
      refreshing: coalescer.pending,
    };
  };

  const snapshot = async () => {
    if (due()) {
      const raced = await withTimeout(startRefresh(), budgetMs);
      if (raced.ok && raced.value && raced.value.at !== null && current(raced.value)) {
        return {
          harnesses: raced.value.harnesses,
          degraded: withFailure(raced.value.degraded),
          at: raced.value.at,
          stale: false,
          source: "live",
          refreshing: coalescer.pending,
        };
      }
      // Facts gathered before a credential change must not be served: make the
      // next poll refresh again. A plain budget loss needs no such reset - the
      // refresh keeps running and warms the next poll.
      if (raced.ok && raced.value && !current(raced.value)) lastRefreshStart = 0;
    } else if (coalescer.pending) {
      const raced = await withTimeout(coalescer.run(() => null), budgetMs);
      if (raced.ok && raced.value && raced.value.at !== null && current(raced.value)) {
        const fresh = !isStale(raced.value.at, now(), liveTtlMs);
        return {
          harnesses: raced.value.harnesses,
          degraded: withFailure(raced.value.degraded),
          at: raced.value.at,
          stale: !fresh,
          source: fresh ? "live" : "cache",
          refreshing: coalescer.pending,
        };
      }
      if (raced.ok && raced.value && !current(raced.value)) lastRefreshStart = 0;
    }
    if (current(warm)) {
      // A slow refresh that settles stale must not overwrite a warm answer
      // with "unknown": the refresh updates `warm` when it lands, and the
      // stale flag says exactly how old that answer is.
      return {
        harnesses: warm.harnesses,
        degraded: withFailure(warm.degraded),
        at: warm.at,
        stale: isStale(warm.at, now(), liveTtlMs),
        source: "cache",
        refreshing: coalescer.pending,
      };
    }
    return cheapAnswer();
  };

  const snapshotCheap = async () => {
    const raced = await withTimeout(Promise.resolve().then(cheap), budgetMs);
    if (raced.ok) {
      return {
        harnesses: raced.value?.harnesses ?? [],
        degraded: raced.value?.degraded ?? [],
        at: null,
        stale: false,
        source: "cheap",
        refreshing: coalescer.pending,
      };
    }
    return {
      harnesses: [],
      degraded: [{ what: "harness probes", error: String(raced.error ?? "unavailable").slice(0, 200) }],
      at: null,
      stale: true,
      source: "unavailable",
      refreshing: coalescer.pending,
    };
  };

  /**
   * Drop warm facts and refresh now. A credential write calls this so the next
   * poll cannot serve a verdict reached before the write; the generation bump
   * makes every fact gathered before it unusable, however it lands. A refresh
   * already in flight is waited out first, because joining it would just hand
   * back pre-write facts. Both stages share the poll budget; when it is
   * exceeded the refresh keeps running, the next poll is made due again, and
   * it refreshes then.
   */
  const invalidate = async () => {
    generation += 1;
    warm = null;
    lastRefreshStart = 0;
    if (coalescer.pending) {
      const settled = await withTimeout(coalescer.run(() => null), budgetMs);
      if (!settled.ok) {
        lastRefreshStart = 0;
        return false;
      }
    }
    const raced = await withTimeout(startRefresh(), budgetMs);
    if (!raced.ok) lastRefreshStart = 0;
    return raced.ok && current(raced.value);
  };

  const peek = () => (current(warm) ? warm : null);

  return { snapshot, snapshotCheap, invalidate, peek, get refreshing() { return coalescer.pending; } };
}
