// Unit tests for the offline-safe setup caches.
//
//   node --test tests/setup-cache.test.mjs
//
// Everything runs against injected fakes with real short timers, so the
// five-second offline budgets, background refreshes, and refresh
// deduplication are exercised deterministically, with no container and no
// network.
import assert from "node:assert/strict";
import test from "node:test";

import {
  STATUS_BUDGET_MS,
  withTimeout,
  createCoalescer,
  isStale,
  createProviderCache,
  createHarnessCache,
} from "../docker/setup/cache.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const manualClock = () => {
  let at = 1_700_000_000_000;
  return { now: () => at, advance: (ms) => { at += ms; } };
};

// ---------------------------------------------------------------------------

test("the endpoint budget leaves headroom under the five-second acceptance", () => {
  assert.ok(STATUS_BUDGET_MS < 5000, `budget ${STATUS_BUDGET_MS} must fit the 5s acceptance`);
  assert.ok(STATUS_BUDGET_MS >= 4000, "budget must leave room for bounded local reads");
});

test("withTimeout passes fast work through", async () => {
  const raced = await withTimeout(Promise.resolve(42), 100);
  assert.deepEqual(raced, { ok: true, value: 42 });
});

test("withTimeout times slow work out without rejecting", async () => {
  const raced = await withTimeout(sleep(300).then(() => "late"), 20);
  assert.equal(raced.ok, false);
  assert.match(raced.error, /timed out/);
});

test("withTimeout turns rejection into a value, never a throw", async () => {
  const raced = await withTimeout(Promise.reject(new Error("boom")), 100);
  assert.equal(raced.ok, false);
  assert.match(raced.error, /boom/);
});

test("the coalescer shares one execution between concurrent callers", async () => {
  const coalescer = createCoalescer();
  let executions = 0;
  const work = async () => {
    executions += 1;
    await sleep(30);
    return "done";
  };
  const [a, b, c] = await Promise.all([
    coalescer.run(work),
    coalescer.run(work),
    coalescer.run(work),
  ]);
  assert.deepEqual([a, b, c], ["done", "done", "done"]);
  assert.equal(executions, 1);
  assert.equal(coalescer.pending, false);
});

test("the coalescer runs again after the previous refresh settles", async () => {
  const coalescer = createCoalescer();
  let executions = 0;
  await coalescer.run(async () => { executions += 1; });
  await coalescer.run(async () => { executions += 1; });
  assert.equal(executions, 2);
});

test("a failed refresh does not poison the coalescer", async () => {
  const coalescer = createCoalescer();
  await assert.rejects(coalescer.run(async () => { throw new Error("nope"); }), /nope/);
  assert.equal(coalescer.pending, false);
  assert.equal(await coalescer.run(async () => "recovered"), "recovered");
});

test("isStale treats a missing timestamp as stale", () => {
  assert.equal(isStale(null, 1000, 60_000), true);
  assert.equal(isStale(undefined, 1000, 60_000), true);
  assert.equal(isStale(1000, 1000 + 59_999, 60_000), false);
  assert.equal(isStale(1000, 1000 + 60_000, 60_000), true);
});

// ---------------------------------------------------------------------------
// Provider catalogue

function providerWorld({ disk = null, fetchList = null, clock = manualClock() } = {}) {
  const world = {
    clock,
    disk,
    writes: [],
    fetches: 0,
    fetchGate: null, // when set, fetch waits for release()
  };
  const deps = {
    now: clock.now,
    ttlMs: 60_000,
    minRefreshIntervalMs: 0,
    fallback: [{ id: "bundled", name: "Bundled" }],
    readFile: async () => {
      if (world.disk === null) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return world.disk;
    },
    writeFile: async (data) => { world.writes.push(data); },
    mkdir: async () => {},
    fetchList: async () => {
      world.fetches += 1;
      if (world.fetchGate) await world.fetchGate;
      if (fetchList) return fetchList();
      return [{ id: "live", name: "Live" }];
    },
  };
  return { world, deps };
}

test("a cold provider cache serves the bundled fallback and refreshes behind it", async () => {
  const { world, deps } = providerWorld();
  const cache = createProviderCache(deps);
  const snap = await cache.snapshot();
  assert.deepEqual(snap.list, [{ id: "bundled", name: "Bundled" }]);
  assert.equal(snap.source, "bundled");
  assert.equal(snap.stale, true);
  assert.equal(snap.at, null);
  // The refresh was kicked off without blocking the answer.
  await sleep(20);
  assert.equal(world.fetches, 1);
  const warmed = cache.peek();
  assert.equal(warmed.source, "live");
  assert.deepEqual(warmed.list, [{ id: "live", name: "Live" }]);
  assert.equal(world.writes.length, 1);
  assert.equal(JSON.parse(world.writes[0]).list[0].id, "live");
});

test("a warm disk cache is served immediately, even when stale", async () => {
  const diskList = [{ id: "disk", name: "Disk" }];
  const { world, deps } = providerWorld({
    disk: JSON.stringify({ at: 1_000, list: diskList }),
  });
  // Gate the fetch so the test can prove the answer did not wait on it.
  let release = null;
  world.fetchGate = new Promise((resolve) => { release = resolve; });
  const cache = createProviderCache(deps);
  const snap = await cache.snapshot();
  assert.deepEqual(snap.list, diskList);
  assert.equal(snap.source, "disk");
  assert.equal(snap.stale, true);
  release();
  await sleep(20);
  assert.deepEqual(cache.peek().list, [{ id: "live", name: "Live" }]);
});

test("a fresh memo answers without touching the network", async () => {
  const { world, deps } = providerWorld();
  const cache = createProviderCache(deps);
  await cache.snapshot();
  await sleep(20); // let the background refresh land
  const fetches = world.fetches;
  assert.ok(fetches >= 1);
  const snap = await cache.snapshot();
  assert.equal(snap.source, "live");
  assert.equal(snap.stale, false);
  assert.equal(world.fetches, fetches, "a fresh answer starts no new fetch");
});

test("concurrent cold snapshots share one catalogue fetch", async () => {
  const { world, deps } = providerWorld();
  const cache = createProviderCache(deps);
  const snaps = await Promise.all([cache.snapshot(), cache.snapshot(), cache.snapshot()]);
  for (const snap of snaps) assert.equal(snap.source, "bundled");
  await sleep(20);
  assert.equal(world.fetches, 1);
});

test("a failed catalogue fetch keeps serving the fallback", async () => {
  const { world, deps } = providerWorld({
    fetchList: async () => { throw new Error("offline"); },
  });
  const cache = createProviderCache(deps);
  const first = await cache.snapshot();
  assert.equal(first.source, "bundled");
  await sleep(20);
  assert.equal(world.fetches, 1);
  // A later poll still answers; the failure never rejects the endpoint.
  const second = await cache.snapshot();
  assert.deepEqual(second.list, [{ id: "bundled", name: "Bundled" }]);
});

// ---------------------------------------------------------------------------
// Harness facts

function harnessWorld({ fullDelay = 10, cheapDelay = 5, fullFails = false, cheapFails = false, clock = manualClock() } = {}) {
  const world = {
    clock,
    fullCalls: 0,
    cheapCalls: 0,
    mutations: 0,
    fullGate: null,
  };
  const rows = (kind) => [{ id: "claude", signedIn: kind === "full" }];
  const deps = {
    now: clock.now,
    budgetMs: 50,
    refreshIntervalMs: 1_000,
    liveTtlMs: 500,
    full: async () => {
      world.fullCalls += 1;
      if (world.fullGate) await world.fullGate;
      await sleep(fullDelay);
      if (fullFails) throw new Error("probe failed");
      return { harnesses: rows("full"), degraded: [] };
    },
    cheap: async () => {
      world.cheapCalls += 1;
      await sleep(cheapDelay);
      if (cheapFails) throw new Error("mise gone");
      return { harnesses: rows("cheap"), degraded: [] };
    },
  };
  return { world, deps };
}

test("a fast authenticated refresh is served live", async () => {
  const { world, deps } = harnessWorld();
  const cache = createHarnessCache(deps);
  const snap = await cache.snapshot();
  assert.equal(snap.source, "live");
  assert.equal(snap.stale, false);
  assert.deepEqual(snap.harnesses, [{ id: "claude", signedIn: true }]);
  assert.ok(typeof snap.at === "number");
  assert.equal(world.fullCalls, 1);
});

test("a slow refresh serves cheap local facts and warms the next poll", async () => {
  const { world, deps } = harnessWorld({ fullDelay: 300, cheapDelay: 5 });
  const cache = createHarnessCache(deps);
  const first = await cache.snapshot();
  assert.equal(first.source, "cheap");
  assert.equal(first.stale, true);
  assert.deepEqual(first.harnesses, [{ id: "claude", signedIn: false }]);
  assert.equal(first.refreshing, true, "the refresh keeps running in the background");
  // Let the slow refresh land, then poll again inside the warm window.
  await sleep(350);
  const second = await cache.snapshot();
  assert.ok(["live", "cache"].includes(second.source), `got ${second.source}`);
  assert.deepEqual(second.harnesses, [{ id: "claude", signedIn: true }]);
  assert.equal(world.fullCalls, 1, "the second poll reused the landed refresh");
});

test("concurrent snapshots share one authenticated refresh", async () => {
  const { world, deps } = harnessWorld({ fullDelay: 30 });
  const cache = createHarnessCache(deps);
  const snaps = await Promise.all([cache.snapshot(), cache.snapshot(), cache.snapshot()]);
  for (const snap of snaps) assert.equal(snap.source, "live");
  assert.equal(world.fullCalls, 1);
});

test("the refresh interval gates background work", async () => {
  const { world, deps } = harnessWorld({ fullDelay: 10 });
  const cache = createHarnessCache(deps);
  await cache.snapshot();
  assert.equal(world.fullCalls, 1);
  // Still inside the 1s interval: no new refresh, warm facts served as cache.
  const second = await cache.snapshot();
  assert.equal(world.fullCalls, 1);
  assert.equal(second.source, "cache");
  assert.equal(second.stale, false, "seconds-old facts are not called stale");
  // Past the interval and past the live TTL: a new refresh starts.
  world.clock.advance(60_000);
  const third = await cache.snapshot();
  assert.equal(world.fullCalls, 2);
  assert.equal(third.source, "live");
});

test("a failed refresh degrades honestly instead of throwing", async () => {
  const { deps } = harnessWorld({ fullDelay: 5, fullFails: true, cheapDelay: 5 });
  const cache = createHarnessCache(deps);
  const snap = await cache.snapshot();
  assert.equal(snap.source, "cheap");
  assert.equal(snap.stale, true);
  assert.ok(snap.degraded.some((entry) => entry.what === "harness refresh"), "the refresh failure is reported");
});

test("total probe failure is unavailable, never a rejection", async () => {
  const { deps } = harnessWorld({ fullFails: true, cheapFails: true });
  const cache = createHarnessCache(deps);
  const snap = await cache.snapshot();
  assert.equal(snap.source, "unavailable");
  assert.deepEqual(snap.harnesses, []);
  assert.equal(snap.stale, true);
  assert.ok(snap.degraded.length > 0);
});

test("explicit cheap polls never start an authenticated refresh", async () => {
  const { world, deps } = harnessWorld();
  const cache = createHarnessCache(deps);
  const snap = await cache.snapshotCheap();
  assert.equal(snap.source, "cheap");
  assert.equal(snap.stale, false);
  assert.equal(world.fullCalls, 0);
  assert.equal(world.cheapCalls, 1);
});

test("status paths only read: no install, update, or mutation call exists", async () => {
  const { world, deps } = harnessWorld({ fullDelay: 300 });
  const cache = createHarnessCache(deps);
  await cache.snapshot();
  await cache.snapshotCheap();
  await sleep(350);
  await cache.snapshot();
  assert.equal(world.mutations, 0);
  assert.ok(world.fullCalls + world.cheapCalls > 0, "reads happened");
});

test("invalidate refreshes now so the next poll cannot serve pre-write facts", async () => {
  const { world, deps } = harnessWorld();
  const cache = createHarnessCache(deps);
  const first = await cache.snapshot();
  assert.equal(first.source, "live");
  assert.equal(world.fullCalls, 1);

  // A credential write lands between the two polls. Without the invalidation
  // the warm snapshot (refreshIntervalMs has not elapsed) would answer the
  // second poll with the verdict from before the write.
  await cache.invalidate();
  assert.equal(world.fullCalls, 2, "invalidate refreshes instead of clearing only");

  const second = await cache.snapshot();
  assert.deepEqual(second.harnesses, first.harnesses);
  assert.equal(second.stale, false);
  assert.equal(world.fullCalls, 2, "the next poll reused the invalidated refresh");
});

test("invalidate is bounded: a stalled refresh leaves the next poll a cheap answer", async () => {
  const { world, deps } = harnessWorld({ fullDelay: 300, cheapDelay: 5 });
  const cache = createHarnessCache(deps);
  await cache.invalidate();
  const snap = await cache.snapshot();
  assert.ok(["cheap", "cache", "live"].includes(snap.source), `got ${snap.source}`);
  await sleep(350);
  const later = await cache.snapshot();
  assert.deepEqual(later.harnesses, [{ id: "claude", signedIn: true }]);
  assert.ok(world.fullCalls >= 1, "a refresh was attempted");
});

test("invalidate does not reuse a refresh that began before the write", async () => {
  const clock = manualClock();
  let signedIn = false;
  const calls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let held = false;
  const cache = createHarnessCache({
    now: clock.now,
    budgetMs: 50,
    refreshIntervalMs: 1_000,
    liveTtlMs: 500,
    full: async () => {
      // Capture the verdict at the start, the way a real probe batch does.
      const captured = signedIn;
      calls.push(captured);
      if (!held) {
        held = true;
        await gate;
      }
      return { harnesses: [{ id: "claude", signedIn: captured }], degraded: [] };
    },
    cheap: async () => ({ harnesses: [{ id: "claude", signedIn }], degraded: [] }),
  });

  signedIn = false;
  const pending = cache.snapshot();       // starts a refresh with pre-write facts
  await sleep(5);
  assert.deepEqual(calls, [false], "the in-flight refresh captured the old verdict");
  signedIn = true;                         // the credential write lands
  const invalidating = cache.invalidate(); // must not just join that refresh
  await sleep(80);                          // let its wait exceed the budget
  release();
  assert.equal(await invalidating, false, "the wait is bounded");
  await pending;
  await sleep(10);
  const after = await cache.snapshot();
  assert.equal(after.harnesses[0].signedIn, true, "the next poll must see the write");
  assert.deepEqual(calls, [false, true], "a refresh started after the write");
});
