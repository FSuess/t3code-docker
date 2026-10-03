// Unit tests for accepting T3 Code's sign-in in the console (docker/setup/t3-session.mjs).
//
//   node --test tests/t3-session.test.mjs
//
// The console trusts a browser's T3 session only as T3 vouches for it, only
// with terminal access, and only for a short while without asking again. T3 is
// a fake fetch here, answering /api/auth/session the way T3 0.0.45 does.
import assert from "node:assert/strict";
import test from "node:test";

import { REQUIRED_SCOPE, createT3Sessions, t3SessionCookies, trusted } from "../docker/setup/t3-session.mjs";

const COOKIE = "t3_session_3773_550a82367a3d";
const STANDARD = ["orchestration:read", "orchestration:operate", "terminal:operate", "review:write", "relay:read"];

/** A fake T3: `sessions` maps a cookie value to its answer. Records every ask. */
const fakeT3 = (sessions, { fail = false } = {}) => {
  const asked = [];
  const fetchImpl = async (url, { headers }) => {
    asked.push({ url, cookie: headers.cookie });
    if (fail) throw new Error("connect ECONNREFUSED");
    const value = (headers.cookie.match(new RegExp(`${COOKIE}=([^;]+)`)) || [])[1];
    const session = sessions[value];
    const body = session
      ? { authenticated: true, scopes: session.scopes ?? STANDARD, sessionMethod: "browser-session-cookie", expiresAt: session.expiresAt ?? "2026-11-02T00:00:00.000Z" }
      : { authenticated: false, auth: { sessionCookieName: COOKIE } };
    return { ok: true, json: async () => body };
  };
  return { asked, fetchImpl };
};

test("only T3's session cookies are passed on, never the browser's others", () => {
  assert.equal(t3SessionCookies(`t3setup=thekey; ${COOKIE}=abc; theme=dark`), `${COOKIE}=abc`);
  assert.equal(t3SessionCookies(`${COOKIE}=abc; t3_session_23773_x=1`), `t3_session_23773_x=1; ${COOKIE}=abc`, "every T3 server's, in one order");
  assert.equal(t3SessionCookies("t3setup=thekey"), "");
  assert.equal(t3SessionCookies(`${COOKIE}=`), "", "an empty cookie is no cookie");
  assert.equal(t3SessionCookies("not_t3_session_1=abc; xt3_session=1"), "");
  assert.equal(t3SessionCookies(undefined), "");
});

test("a session is trusted only when T3 says authenticated, with a terminal", () => {
  assert.equal(REQUIRED_SCOPE, "terminal:operate");
  assert.equal(trusted({ authenticated: true, scopes: STANDARD }), true);
  assert.equal(trusted({ authenticated: true, scopes: ["orchestration:read"] }), false, "read-only is not enough");
  assert.equal(trusted({ authenticated: false, scopes: STANDARD }), false);
  assert.equal(trusted({ authenticated: "true", scopes: STANDARD }), false);
  assert.equal(trusted({ authenticated: true }), false);
  assert.equal(trusted(null), false);
});

test("T3 is asked with the session cookie alone, and its answer kept for a while", async () => {
  let clock = 1_000_000;
  const t3 = fakeT3({ good: {} });
  const sessions = createT3Sessions({ baseUrl: "http://127.0.0.1:3773", fetchImpl: t3.fetchImpl, now: () => clock, ttlMs: 30_000 });
  const viewer = await sessions.verify(`t3setup=k; ${COOKIE}=good; other=1`);
  assert.deepEqual(viewer, { expiresAt: Date.parse("2026-11-02T00:00:00.000Z") });
  assert.deepEqual(t3.asked, [{ url: "http://127.0.0.1:3773/api/auth/session", cookie: `${COOKIE}=good` }]);

  clock += 29_000;
  assert.ok(await sessions.verify(`${COOKIE}=good`));
  assert.equal(t3.asked.length, 1, "a poll within the half minute does not ask T3 again");
  clock += 2_000;
  assert.ok(await sessions.verify(`${COOKIE}=good`));
  assert.equal(t3.asked.length, 2, "after it, T3 is asked again");
});

test("no cookie, a stranger's cookie, or too little access: not trusted", async () => {
  const t3 = fakeT3({ reader: { scopes: ["orchestration:read"] } });
  const sessions = createT3Sessions({ baseUrl: "http://t3", fetchImpl: t3.fetchImpl });
  assert.equal(await sessions.verify(""), null);
  assert.equal(await sessions.verify("t3setup=k"), null);
  assert.equal(t3.asked.length, 0, "nothing to ask T3 about");
  assert.equal(await sessions.verify(`${COOKIE}=forged`), null);
  assert.equal(await sessions.verify(`${COOKIE}=reader`), null);
});

test("T3 down means not trusted, and asked again soon rather than in half a minute", async () => {
  let clock = 0;
  const t3 = fakeT3({}, { fail: true });
  const sessions = createT3Sessions({ baseUrl: "http://t3", fetchImpl: t3.fetchImpl, now: () => clock, missTtlMs: 5_000 });
  assert.equal(await sessions.verify(`${COOKIE}=good`), null);
  assert.equal(await sessions.verify(`${COOKIE}=good`), null);
  assert.equal(t3.asked.length, 1);
  clock += 5_001;
  await sessions.verify(`${COOKIE}=good`);
  assert.equal(t3.asked.length, 2);
});

test("a session is never trusted past the end T3 gave it", async () => {
  let clock = Date.parse("2026-10-03T00:00:00Z");
  const t3 = fakeT3({ ending: { expiresAt: "2026-10-03T00:00:10Z" } });
  const sessions = createT3Sessions({ baseUrl: "http://t3", fetchImpl: t3.fetchImpl, now: () => clock, ttlMs: 30_000 });
  assert.ok(await sessions.verify(`${COOKIE}=ending`));
  clock += 11_000;
  await sessions.verify(`${COOKIE}=ending`);
  assert.equal(t3.asked.length, 2, "asked again once T3's own end has passed");
});

test("a burst of requests asks T3 once, and forget() makes the next one ask again", async () => {
  const t3 = fakeT3({ good: {} });
  const sessions = createT3Sessions({ baseUrl: "http://t3", fetchImpl: t3.fetchImpl });
  const all = await Promise.all(Array.from({ length: 5 }, () => sessions.verify(`${COOKIE}=good`)));
  assert.ok(all.every(Boolean));
  assert.equal(t3.asked.length, 1);
  sessions.forget();
  await sessions.verify(`${COOKIE}=good`);
  assert.equal(t3.asked.length, 2, "a device revoked from the console stops counting at once");
});

test("the answers kept are bounded", async () => {
  const t3 = fakeT3({});
  const sessions = createT3Sessions({ baseUrl: "http://t3", fetchImpl: t3.fetchImpl, maxEntries: 3 });
  for (const value of ["a", "b", "c", "d"]) await sessions.verify(`${COOKIE}=${value}`);
  assert.equal(t3.asked.length, 4);
  await sessions.verify(`${COOKIE}=d`);
  assert.equal(t3.asked.length, 4, "the newest is kept");
  await sessions.verify(`${COOKIE}=a`);
  assert.equal(t3.asked.length, 5, "the oldest made room");
});
