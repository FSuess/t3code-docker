// Unit tests for the setup service's helper modules.
//
//   node --test tests/setup-server-modules.test.mjs
//
// ports.mjs parses `ss` and names listeners, storage.mjs judges mounts the way
// t3-doctor does, and latest.mjs keeps release lookups off the poll path. All
// are pure or take their effects as arguments, so none of this needs a
// container.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { looksLikeDatabase, parseListeners, processLabel, splitLocal } from "../docker/setup/ports.mjs";
import { countProjects, coveringMount, mountKind } from "../docker/setup/storage.mjs";
import { createLatestCache } from "../docker/setup/latest.mjs";

// --------------------------------------------------------------------- ports --

const SS = [
  'LISTEN 0      511          127.0.0.1:3000       0.0.0.0:*    users:(("next-server",pid=101,fd=20))',
  'LISTEN 0      511            0.0.0.0:5173       0.0.0.0:*    users:(("MainThread",pid=102,fd=21))',
  'LISTEN 0      511               [::]:5173          [::]:*    users:(("MainThread",pid=102,fd=22))',
  'LISTEN 0      244          127.0.0.1:5432       0.0.0.0:*    users:(("postgres",pid=103,fd=7))',
  'LISTEN 0      244              [::1]:5432          [::]:*    users:(("postgres",pid=103,fd=8))',
  'LISTEN 0      4096     127.0.0.53%lo:53         0.0.0.0:*',
  'LISTEN 0      4096         127.0.0.1:20241      0.0.0.0:*    users:(("cloudflared",pid=104,fd=3))',
  'LISTEN 0      511            0.0.0.0:3773       0.0.0.0:*    users:(("t3",pid=105,fd=9))',
  'LISTEN 0      511          127.0.0.1:41234      0.0.0.0:*    users:(("t3",pid=105,fd=10))',
  '',
].join("\n");

test("listeners are one per port, in order, without plumbing or the ephemeral range", () => {
  const found = parseListeners(SS, { reserved: new Set([3773, 3774]), ephemeral: [32768, 60999] });
  assert.deepEqual(found, [
    { port: 53, process: null, pid: null, address: "127.0.0.53", looksLikeDatabase: false },
    { port: 3000, process: "next-server", pid: 101, address: "127.0.0.1", looksLikeDatabase: false },
    { port: 5173, process: "MainThread", pid: 102, address: "0.0.0.0", looksLikeDatabase: false },
    { port: 5432, process: "postgres", pid: 103, address: "127.0.0.1", looksLikeDatabase: true },
  ]);
  assert.deepEqual(parseListeners(""), []);
});

test("local addresses split across IPv4, IPv6 and interface suffixes", () => {
  assert.deepEqual(splitLocal("127.0.0.1:3000"), { address: "127.0.0.1", port: 3000 });
  assert.deepEqual(splitLocal("[::1]:5432"), { address: "::1", port: 5432 });
  assert.deepEqual(splitLocal("*:8080"), { address: "*", port: 8080 });
  assert.deepEqual(splitLocal("127.0.0.53%lo:53"), { address: "127.0.0.53", port: 53 });
  assert.equal(splitLocal("nonsense"), null);
  assert.equal(splitLocal("1.2.3.4:99999"), null);
});

test("a listener is named for what it runs, not for its runtime", () => {
  assert.equal(processLabel(["node", "/app/node_modules/vite/bin/vite.js", "--port", "5173"], "MainThread"), "vite");
  assert.equal(processLabel(["node", "/app/node_modules/.bin/vite"], "MainThread"), "vite");
  assert.equal(processLabel(["node", "/x/node_modules/@scope/cli/dist/index.js"]), "cli");
  assert.equal(processLabel(["python3", "-m", "http.server", "3000"]), "http.server");
  assert.equal(processLabel(["/usr/lib/postgresql/16/bin/postgres", "-D", "/data"]), "postgres");
  assert.equal(processLabel(["next-server (v15.0.3)"]), "next-server");
  assert.equal(processLabel(["npx", "vite"]), "vite");
  assert.equal(processLabel(["node", "server.mjs"]), "server");
  assert.equal(processLabel(null, "MainThread"), "MainThread");
  assert.equal(processLabel([], "postgres"), "postgres");
});

test("databases are recognised by port or by process", () => {
  for (const port of [5432, 3306, 6379, 27017, 9000]) assert.equal(looksLikeDatabase(port, "anything"), true, String(port));
  for (const name of ["postgres", "mysqld", "mariadbd", "redis-server", "mongod", "clickhouse-server"]) {
    assert.equal(looksLikeDatabase(7000, name), true, name);
  }
  assert.equal(looksLikeDatabase(5173, "vite"), false);
});

// ------------------------------------------------------------------- storage --

const MOUNTINFO = [
  "21 1 0:20 / / rw,relatime - overlay overlay rw",
  "300 21 8:1 /var/lib/docker/volumes/t3-home/_data /home/t3 rw,relatime - ext4 /dev/sda1 rw",
  "301 21 8:1 /srv/projects /workspace rw,relatime - ext4 /dev/sda1 rw",
  "302 21 8:1 /var/lib/docker/volumes/2f1a9b0c7d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f90/_data /data rw - ext4 /dev/sda1 rw",
  "303 300 8:1 /@/var/lib/docker/volumes/t3-state/_data /home/t3/.t3 rw - btrfs /dev/sda2 rw",
].join("\n");

test("mounts are judged the way t3-doctor judges them", () => {
  assert.deepEqual(coveringMount("/home/t3/.t3/state.db", MOUNTINFO), { point: "/home/t3/.t3", root: "/@/var/lib/docker/volumes/t3-state/_data" });
  assert.equal(mountKind("/home/t3", MOUNTINFO), "durable", "a named volume");
  assert.equal(mountKind("/workspace", MOUNTINFO), "durable", "a host path");
  assert.equal(mountKind("/data", MOUNTINFO), "anonymous", "a volume named by a hash");
  assert.equal(mountKind("/home/t3/.t3", MOUNTINFO), "durable", "however the data root is prefixed");
  assert.equal(mountKind("/opt/elsewhere", MOUNTINFO), "none", "the root filesystem is not a mount");
  assert.equal(mountKind("/home/t3x", MOUNTINFO), "none", "a prefix is not a parent");
});

test("projects are the git repositories T3 Code registers on start", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "t3-projects-"));
  try {
    assert.equal(await countProjects(root), 0);
    await mkdir(path.join(root, "a", ".git"), { recursive: true });
    await mkdir(path.join(root, "b", ".git"), { recursive: true });
    await mkdir(path.join(root, "notes"));
    assert.equal(await countProjects(root), 2);
    await mkdir(path.join(root, ".git"));
    assert.equal(await countProjects(root), 1, "a workspace that is itself a repository is one project");
    assert.equal(await countProjects(path.join(root, "missing")), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------------- latest --

const latestWorld = ({ answers = {}, saved = null } = {}) => {
  const world = { lookups: [], written: null, clock: 1_000_000 };
  world.cache = createLatestCache({
    keys: () => Object.keys(answers),
    lookup: async (key) => {
      world.lookups.push(key);
      const answer = answers[key];
      if (answer instanceof Error) throw answer;
      return answer;
    },
    read: async () => {
      if (saved === null) throw new Error("ENOENT");
      return saved;
    },
    write: async (text) => { world.written = text; },
    ttlMs: 1000,
    now: () => world.clock,
  });
  return world;
};

test("a pass looks every tool up once and remembers the answers", async () => {
  const world = latestWorld({ answers: { "harness:claude": "2.1.290", "toolchain:go": "1.27.1" } });
  assert.deepEqual(world.cache.get("harness:claude"), { latestVersion: null, latestCheckedAt: null });
  assert.equal(await world.cache.refresh(), true);
  assert.deepEqual(world.cache.get("harness:claude"), { latestVersion: "2.1.290", latestCheckedAt: 1_000_000 });
  assert.deepEqual(world.lookups, ["harness:claude", "toolchain:go"]);
  assert.deepEqual(JSON.parse(world.written).versions["toolchain:go"], { version: "1.27.1", at: 1_000_000 });
});

test("a fresh pass is not repeated, unless someone asks", async () => {
  const world = latestWorld({ answers: { "harness:claude": "1" } });
  await world.cache.refresh();
  world.clock += 500;
  assert.equal(await world.cache.refresh(), false);
  assert.equal(world.lookups.length, 1);
  assert.equal(await world.cache.refresh({ force: true }), true);
  assert.equal(world.lookups.length, 2);
  world.clock += 2000;
  assert.equal(await world.cache.refresh(), true, "stale after the TTL");
});

test("a failed lookup keeps the last answer instead of forgetting the update", async () => {
  const saved = JSON.stringify({ checkedAt: 1, versions: { "harness:claude": { version: "2.1.280", at: 1 } } });
  const world = latestWorld({ answers: { "harness:claude": new Error("offline") }, saved });
  await world.cache.refresh();
  assert.equal(world.cache.get("harness:claude").latestVersion, "2.1.280");
});

test("concurrent callers share one pass", async () => {
  const world = latestWorld({ answers: { "harness:claude": "1", "harness:codex": "2" } });
  await Promise.all([world.cache.refresh(), world.cache.refresh(), world.cache.refresh({ force: true })]);
  assert.equal(world.lookups.length, 2);
});
