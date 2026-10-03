// Accepting T3 Code's own sign-in.
//
// A browser paired with T3 Code holds a session that can already open a
// terminal in this container, and from there run `t3-pair`, or read
// T3_SETUP_KEY from the environment. Asking that browser for the setup key
// again adds a step without adding protection, and it is what stands between
// T3 Code's settings and the console opened inside them. So the console also
// accepts T3 Code's session, as T3 Code itself judges it: the session cookie
// is passed to T3's own `GET /api/auth/session`, and only an answer that says
// authenticated, with terminal access (`terminal:operate`), is trusted.
// Anything less and the setup key is still asked for.
//
// Only T3's session cookies are forwarded, never the browser's other cookies.
// Answers are kept for a short while, keyed by a hash of those cookies, so a
// page polling every few seconds costs T3 one request per half minute; a
// session revoked in T3 Code stops working here within that time, and at once
// when it is revoked from the console.
//
//   const sessions = createT3Sessions({ baseUrl: "http://127.0.0.1:3773" });
//   const viewer = await sessions.verify(req.headers.cookie);  // { expiresAt } | null
import { createHash } from "node:crypto";

/** The scope a T3 session needs before the console trusts it: a terminal. */
export const REQUIRED_SCOPE = "terminal:operate";

// T3 names its cookie after the port and environment (t3_session_3773_ab12…),
// so two servers on one host keep separate sessions. Every such cookie is
// passed on and T3 reads its own.
const SESSION_COOKIE = /^t3_session(?:_[\w-]+)?$/;

/** T3's session cookies from a Cookie header, as a header of their own ("" when none). */
export function t3SessionCookies(header) {
  return String(header ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => {
      const eq = part.indexOf("=");
      return eq > 0 && SESSION_COOKIE.test(part.slice(0, eq)) && part.length > eq + 1;
    })
    .sort()
    .join("; ");
}

/** Whether T3's answer describes a session the console can trust. */
export function trusted(answer) {
  return Boolean(answer && answer.authenticated === true
    && Array.isArray(answer.scopes) && answer.scopes.includes(REQUIRED_SCOPE));
}

export function createT3Sessions({
  baseUrl,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  ttlMs = 30_000,
  missTtlMs = 5_000,
  timeoutMs = 2_000,
  maxEntries = 256,
}) {
  const cache = new Map();     // hash -> { until, viewer: { expiresAt } | null }
  const inflight = new Map();  // hash -> Promise, so a burst asks T3 once

  const remember = (key, viewer, until) => {
    cache.delete(key);
    cache.set(key, { until, viewer });
    // Oldest first: a Map iterates in insertion order.
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
  };

  const ask = async (cookies) => {
    const res = await fetchImpl(`${baseUrl}/api/auth/session`, {
      headers: { cookie: cookies, accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return res.json();
  };

  /**
   * The T3 session behind a request's Cookie header: `{ expiresAt }` when T3
   * vouches for it with terminal access, otherwise null. Never throws: T3
   * being down or slow means "not trusted", and the key still works.
   */
  const verify = async (cookieHeader) => {
    const cookies = t3SessionCookies(cookieHeader);
    if (!cookies) return null;
    const key = createHash("sha256").update(cookies).digest("hex");
    const hit = cache.get(key);
    if (hit && hit.until > now()) return hit.viewer;
    if (inflight.has(key)) return inflight.get(key);
    const pending = (async () => {
      let answer = null;
      try {
        answer = await ask(cookies);
      } catch {
        // T3 did not answer: not trusted, and asked again soon.
        remember(key, null, now() + missTtlMs);
        return null;
      }
      if (!trusted(answer)) {
        remember(key, null, now() + missTtlMs);
        return null;
      }
      const expiresAt = Date.parse(answer.expiresAt);
      const viewer = { expiresAt: Number.isFinite(expiresAt) ? expiresAt : null };
      const until = Math.min(now() + ttlMs, viewer.expiresAt ?? Infinity);
      remember(key, viewer, until);
      return viewer;
    })().finally(() => inflight.delete(key));
    inflight.set(key, pending);
    return pending;
  };

  /** Forget every answer: a device was revoked, so ask T3 again. */
  const forget = () => cache.clear();

  return { verify, forget };
}
