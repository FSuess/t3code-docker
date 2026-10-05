// T3 Connect, read from T3 Code's own CLI.
//
// T3 Connect makes this server reachable through T3's relay, so a device signs
// in with a T3 account instead of needing a public URL and a pairing link. T3
// Code's web app can only turn it on from T3's own domains (its sign-in is tied
// to them), so on a self-hosted address the way in is the CLI:
//
//   t3 connect link --headless   a device-code sign-in, then the link is
//                                saved and made on T3 Code's next start
//   t3 connect status --json     what is saved
//   t3 connect unlink            off again, keeping the sign-in
//
// This module reads what those print. The setup service runs them and keeps
// the processes; nothing here has effects.

/**
 * What `t3 connect link --headless` has printed so far:
 *
 *   Open this URL on a device with a browser:
 *     https://...
 *   Confirm this code when asked: ABCD-EFGH
 *   Waiting for approval (expires in 15 min). Press Ctrl+C to cancel.
 *   ...
 *   ✓ Authorized as someone@example.com
 *
 * Each field is null until it has been printed.
 */
export function parseLinkOutput(text) {
  const output = String(text ?? "");
  const url = (output.match(/Open this URL on a device with a browser:\s*\n\s*(https?:\/\/\S+)/) ?? [])[1]
    ?? (output.match(/https?:\/\/\S+/) ?? [])[0]
    ?? null;
  const code = (output.match(/Confirm this code when asked:\s*(\S+)/) ?? [])[1] ?? null;
  const minutes = Number((output.match(/expires in (\d+) min/) ?? [])[1]);
  const authorized = /✓ Authorized/.test(output);
  const identity = (output.match(/✓ Authorized as ([^\n]+)/) ?? [])[1]?.trim() || null;
  return {
    url,
    code,
    expiresInMs: Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : null,
    authorized,
    identity,
  };
}

/** The relay's host, for saying where traffic goes. */
const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};

/**
 * `t3 connect status --json`, as the page needs it:
 *
 *   state  "off"      not asked for
 *          "signin"   asked for, but the stored sign-in is gone
 *          "pending"  signed in and asked for; T3 Code makes the link on its
 *                     next start
 *          "on"       linked
 *
 * Returns null for anything that is not that JSON.
 */
export function connectState(json) {
  if (!json || typeof json !== "object") return null;
  const desired = json.desired === true;
  const authenticated = json.authenticated === true;
  const linked = json.linked === true;
  const state = linked ? "on" : !desired ? "off" : authenticated ? "pending" : "signin";
  const relayClient = json.relayClient && typeof json.relayClient === "object" ? json.relayClient : {};
  return {
    state,
    desired,
    authenticated,
    linked,
    relayHost: hostOf(json.relayUrl),
    publishAgentActivity: json.publishAgentActivity === true,
    relayClient: {
      status: typeof relayClient.status === "string" ? relayClient.status : null,
      version: typeof relayClient.version === "string" ? relayClient.version : null,
    },
  };
}

/** The JSON object in a CLI's stdout, which may follow lines of chatter. */
export function jsonFrom(stdout) {
  const text = String(stdout ?? "");
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}
