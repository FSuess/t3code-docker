// Antigravity on the Agents page: Google's runtime as T3 Code installs it.
//
// T3 Code downloads the runtime itself (about 650 MB, a release it pins and
// checks against its checksum) into its own data directory, and owns the
// Google sign-in. So everything here goes through T3's API (t3-api.mjs) and
// T3 stays the owner: install and update are T3's installer, remove is T3's,
// sign-in is T3's flow with the console as its window. Reads go through a
// short cache, so a status poll never waits on T3.
export const INSTANCE = "antigravity";

// T3 names a release `agy_acp_server_1.1.1`; the page says 1.1.1.
const shortVersion = (value) => (value ? String(value).replace(/^agy_acp_server_/, "") : null);
const BUSY = new Set(["downloading", "extracting", "verifying"]);
const DONE = new Set(["succeeded", "failed", "cancelled", "idle"]);
// Bytes only while they move: T3 reports the whole archive's while it
// extracts and verifies, which would read as a bar stuck at 100%.
const progressOf = (state) => (state.phase === "downloading"
  ? { phase: state.phase, done: state.downloadedBytes ?? null, total: state.totalBytes ?? null }
  : { phase: state.phase });

/**
 * The Agents card row, in the shape the page reads for every agent
 * (setup/server.mjs toPublicHarness), from T3's provider snapshot and the
 * state of its installer. `error` is set when T3 could not be asked.
 */
export function antigravityFacts({ provider = null, install = null, error = null } = {}) {
  const installedVersion = shortVersion(install?.installedVersion ?? (provider?.installed ? provider.version : null));
  const pinned = shortVersion(install?.version);
  const busy = BUSY.has(install?.phase);
  const auth = provider?.auth?.status;
  return {
    id: INSTANCE,
    name: "Antigravity",
    managedBy: "t3",
    // T3 lists the provider only when it supports it, and offers to install it
    // only on a platform Google publishes the runtime for.
    available: Boolean(provider) && provider.setup?.canInstall !== false,
    reachable: !error,
    error: error ? String(error).slice(0, 300) : null,
    installed: Boolean(installedVersion),
    runnable: Boolean(installedVersion),
    version: installedVersion,
    installedVersion,
    recordedVersion: installedVersion,
    // What T3 installs today: newer than what is on the volume is an update.
    latestVersion: pinned,
    enabled: provider ? provider.enabled !== false : null,
    t3Status: provider?.status ?? null,
    t3Message: provider?.message ?? null,
    signedIn: auth === "authenticated" ? true : auth === "unauthenticated" ? false : null,
    account: provider?.auth?.email ?? provider?.auth?.label ?? null,
    inProgress: busy,
    operation: busy ? "install" : null,
    operationState: install?.phase ?? null,
    progress: busy ? progressOf(install) : null,
    failed: install?.phase === "failed",
    failure: install?.phase === "failed" ? install.message ?? "the install did not finish" : null,
    downloadBytes: install?.totalBytes ?? null,
    managedVersions: installedVersion ? [installedVersion] : [],
    supported: true,
    configured: Boolean(installedVersion),
    canSignIn: Boolean(installedVersion) && provider?.setup?.canAuthenticate !== false,
    canSetKey: false,
    keyKind: null,
    authMethod: null,
    credentialsPresent: auth === "authenticated",
  };
}

export function createAntigravity({ api, now = Date.now, maxAgeMs = 15_000 }) {
  let snapshot = null;     // { provider, install } as last read
  let readAt = 0;
  let readError = null;
  let reading = null;
  let live = null;         // install state from a running install's stream

  const read = async () => {
    const [config, install] = await Promise.all([
      api.call("server.getConfig", {}),
      api.first("provider.install.subscribe", { instanceId: INSTANCE }),
    ]);
    return { provider: (config?.providers ?? []).find((p) => p.instanceId === INSTANCE) ?? null, install };
  };

  /** Read T3 again, sharing a read already on its way. */
  const refresh = () => {
    reading ??= read().then(
      (value) => { snapshot = value; readError = null; readAt = now(); },
      (error) => { readError = String(error?.message ?? error); readAt = now(); },
    ).finally(() => { reading = null; });
    return reading;
  };

  /**
   * The row, never waiting on T3 for long: a stale answer refreshes in the
   * background, and only the very first read is waited for (up to `budgetMs`).
   */
  const status = async ({ budgetMs = 1500 } = {}) => {
    if (!snapshot || now() - readAt > maxAgeMs) {
      const pending = refresh();
      if (!snapshot && !readError) await Promise.race([pending, new Promise((r) => setTimeout(r, budgetMs).unref?.())]);
    }
    if (!snapshot) return readError ? antigravityFacts({ error: readError }) : null;
    return antigravityFacts({ provider: snapshot.provider, install: live ?? snapshot.install, error: readError });
  };

  const setEnabled = (enabled) =>
    api.call("server.updateSettings", { patch: { providers: { antigravity: { enabled } } } });

  /**
   * Install the release T3 pins (also how it updates), then wait for T3 to
   * finish it. Turns Antigravity on in T3 first: a runtime T3 is not using is
   * no use, and T3 only checks the Google sign-in of an enabled provider.
   * Resolves `{ ok, code, error? }`; `signal` cancels through T3.
   */
  const install = async ({ signal, onStarted = () => {}, onProgress = () => {} } = {}) => {
    await setEnabled(true);
    let operationId = null;
    let stream = null;
    let settle;
    const finished = new Promise((resolve) => { settle = resolve; });
    const end = (state) => {
      if (state?.phase === "succeeded") settle({ ok: true, code: "installed", version: shortVersion(state.installedVersion ?? state.version) });
      else if (state?.phase === "cancelled") settle({ ok: false, code: "cancelled", error: "cancelled" });
      else settle({ ok: false, code: "failed", error: state?.message ?? "T3 Code did not finish installing Antigravity" });
    };
    const onState = (state) => {
      if (operationId && state.operationId && state.operationId !== operationId) return;
      live = state;
      if (BUSY.has(state.phase)) onProgress(progressOf(state));
      if (operationId && DONE.has(state.phase) && state.phase !== "idle") end(state);
    };
    try {
      stream = await api.subscribe("provider.install.subscribe", { instanceId: INSTANCE }, onState, (error) => {
        if (error) settle({ ok: false, code: "failed", error: error.message });
      });
      const started = await api.call("provider.install.start", { instanceId: INSTANCE });
      operationId = started.operationId ?? null;
      live = started;
      onStarted();
      // Already on the pinned release: T3 answers at once.
      if (!operationId || DONE.has(started.phase)) end(started.phase === "idle" && started.installedVersion ? { ...started, phase: "succeeded" } : started);
      signal?.addEventListener("abort", () => {
        if (operationId) void api.call("provider.install.cancel", { instanceId: INSTANCE, operationId }).catch(() => {});
      }, { once: true });
      return await finished;
    } catch (error) {
      return { ok: false, code: "failed", error: String(error?.message ?? error) };
    } finally {
      stream?.close();
      live = null;
      await refresh().catch(() => {});
    }
  };

  /**
   * Turn Antigravity off in T3, then remove the runtime T3 installed. Off
   * first: T3 keeps the runtime running for an enabled provider and will not
   * remove it while anything holds it. If T3 still refuses (a thread is
   * running in it), it is turned back on as it was.
   */
  const uninstall = async () => {
    const wasEnabled = snapshot?.provider?.enabled !== false;
    try {
      await setEnabled(false);
      await api.call("provider.install.remove", { instanceId: INSTANCE });
      return { ok: true, code: "uninstalled" };
    } catch (error) {
      if (wasEnabled) await setEnabled(true).catch(() => {});
      return { ok: false, code: "failed", error: String(error?.message ?? error) };
    } finally {
      await refresh().catch(() => {});
    }
  };

  /** Turn Antigravity on in T3 Code again. */
  const enable = async () => {
    await setEnabled(true);
    await api.call("server.refreshProviders", {}).catch(() => {});
    await refresh();
  };

  /**
   * Start T3's Google sign-in. `onState` sees each state T3 reports (phase,
   * authorizationUrl, expiresAt, message); the flow belongs to the console's
   * session, so the same connection completes or cancels it.
   */
  const signIn = async (onState) => {
    // The stream opens on T3's current state, which may be an earlier flow's
    // end. Only this flow's states count; any that arrive before T3 has named
    // the flow are held and replayed once it has.
    let flowId = null;
    const early = [];
    const stream = await api.subscribe("provider.auth.subscribe", { instanceId: INSTANCE }, (state) => {
      if (!flowId) early.push(state);
      else if (state.flowId === flowId) onState(state);
    });
    try {
      const state = await api.call("provider.auth.start", { instanceId: INSTANCE });
      flowId = state.flowId;
      onState(state);
      for (const held of early) if (held.flowId === flowId) onState(held);
      return { flowId, close: () => stream.close() };
    } catch (error) {
      stream.close();
      throw error;
    }
  };
  const completeSignIn = (flowId, callbackUrl) => api.call("provider.auth.complete", { instanceId: INSTANCE, flowId, callbackUrl });
  const cancelSignIn = (flowId) => api.call("provider.auth.cancel", { instanceId: INSTANCE, flowId });
  /** After a sign-in: have T3 check access again, then read it. */
  const recheck = async () => {
    await api.call("server.refreshProviders", {}).catch(() => {});
    await refresh();
  };

  return { status, refresh, install, uninstall, enable, signIn, completeSignIn, cancelSignIn, recheck };
}
