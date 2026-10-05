// Unit tests for the source control CLIs' sign-in checks
// (docker/harness/source-control.mjs).
//
//   node --test tests/source-control.test.mjs
//
// The outputs are what the CLIs print (gh 2.102, glab 1.120, tea 0.16,
// az 2.90, fj 0.6), signed in and not, so the verdicts match what T3 Code's
// own Settings > Source Control reports for the same CLI.
import assert from "node:assert/strict";
import test from "node:test";

import { getSourceControl } from "../docker/harness/catalogue.mjs";
import {
  DEFAULT_HOSTS, azExtensionDir, detectSourceControlAuth, failureLine, fjKeysPath, missingExtensions,
  parseAzAuth, parseFjKeys, parseGhAuth, parseGlabAuth, parseHost, parseTeaAuth, parseToken, safeLine, signOutArgs, tokenSignIn,
} from "../docker/harness/source-control.mjs";

test("gh: the active account that signed in, else why not", () => {
  const signed = JSON.stringify({ hosts: { "github.com": [
    { state: "error", error: "token expired", active: false, host: "github.com", login: "old" },
    { state: "success", active: true, host: "github.com", login: "octocat", tokenSource: "keyring", gitProtocol: "https" },
  ] } });
  assert.deepEqual(parseGhAuth({ stdout: signed }), { status: "authenticated", account: "octocat", host: "github.com", detail: null });

  const expired = JSON.stringify({ hosts: { "github.com": [{ state: "error", error: "The token in keyring is invalid.", active: true, host: "github.com", login: "octocat" }] } });
  assert.deepEqual(parseGhAuth({ stdout: expired }), { status: "unauthenticated", account: null, host: "github.com", detail: "The token in keyring is invalid." });

  // Signed out: gh says so on stderr and still exits 0 with empty hosts.
  const none = parseGhAuth({ stdout: '{"hosts":{}}\n', stderr: "You are not logged into any GitHub hosts. To log in, run: gh auth login\n" });
  assert.equal(none.status, "unauthenticated");

  const old = parseGhAuth({ stdout: "", stderr: "unknown flag: --json\n", code: 1 });
  assert.equal(old.status, "unknown", "an old gh is not a signed-out one");
  assert.match(old.detail, /2\.81/);
});

test("glab: the host block that says who is logged in", () => {
  const signed = [
    "gitlab.com",
    "  x gitlab.com: API call failed: GET https://gitlab.com/api/v4/user: 401",
    "gitlab.example.com:8443",
    "  ✓ Logged in to gitlab.example.com:8443 as dev-user (/home/t3/.config/glab-cli/config.yml)",
    "  ✓ Git operations for gitlab.example.com:8443 configured to use https protocol.",
    "  ✓ Token found: **************************",
  ].join("\n");
  assert.deepEqual(parseGlabAuth({ stderr: signed, code: 0 }), { status: "authenticated", account: "dev-user", host: "gitlab.example.com:8443", detail: null });

  const signedOut = [
    "gitlab.com",
    "  x gitlab.com: API call failed: GET https://gitlab.com/api/v4/user: 401 {message: 401 Unauthorized}",
    "  ✓ Git operations for gitlab.com configured to use ssh protocol.",
    "  ! No token found (checked config file, keyring, and environment variables).",
  ].join("\n");
  const out = parseGlabAuth({ stderr: signedOut, code: 1 });
  assert.equal(out.status, "unauthenticated");
  assert.equal(out.host, "gitlab.com");
  assert.match(out.detail, /API call failed/);
});

test("tea: the default login, valid or not", () => {
  const logins = JSON.stringify([
    { name: "work", url: "https://git.example.com", user: "ana", default: "false", valid: "true" },
    { name: "gitea.com", url: "https://gitea.com", user: "ana-g", default: "true", valid: "true" },
  ]);
  assert.deepEqual(parseTeaAuth({ stdout: logins }), { status: "authenticated", account: "ana-g", host: "gitea.com", detail: null });
  const invalid = JSON.stringify([{ name: "x", url: "https://git.example.com", user: "ana", default: "true", valid: "false" }]);
  assert.equal(parseTeaAuth({ stdout: invalid }).status, "unauthenticated");
  assert.equal(parseTeaAuth({ stdout: "[]\n" }).status, "unauthenticated");
  assert.equal(parseTeaAuth({ stdout: "not json" }).status, "unknown");
});

test("az: a user name, or az's own complaint", () => {
  assert.deepEqual(parseAzAuth({ stdout: "ana@example.com\n", code: 0 }), { status: "authenticated", account: "ana@example.com", host: "dev.azure.com", detail: null });
  const out = parseAzAuth({ stderr: "ERROR: Please run 'az login' to setup account.\n", code: 1 });
  assert.equal(out.status, "unauthenticated");
  assert.equal(out.detail, "ERROR: Please run 'az login' to setup account.");
  assert.equal(parseAzAuth({ stdout: "\n", code: 0 }).status, "unknown");
});

test("fj: a saved key is the answer, and its host is the account", () => {
  assert.deepEqual(parseFjKeys(JSON.stringify({ hosts: { "codeberg.org": { type: "Application", token: "secret" } }, aliases: {} })),
    { status: "authenticated", account: null, host: "codeberg.org", detail: null });
  assert.equal(parseFjKeys('{"hosts":{}}').status, "unauthenticated");
  assert.equal(parseFjKeys("{").status, "unknown");
  assert.equal(fjKeysPath({}, "/home/t3"), "/home/t3/.local/share/forgejo-cli/keys.json");
  assert.equal(fjKeysPath({ XDG_DATA_HOME: "/data" }, "/home/t3"), "/data/forgejo-cli/keys.json");
  assert.equal(fjKeysPath({ XDG_DATA_HOME: "relative" }, "/home/t3"), "/home/t3/.local/share/forgejo-cli/keys.json");
});

test("a line worth showing never carries a token", () => {
  assert.equal(safeLine("  ✓ Token: gho_abc\n  x bad credentials"), "bad credentials");
  assert.equal(safeLine(""), null);
});

function fakeCtx({ files = {}, run } = {}) {
  const calls = [];
  return {
    calls,
    env: { HOME: "/home/t3", PATH: "/usr/bin" },
    home: "/home/t3",
    timeouts: { probe: 1000 },
    fs: {
      exists: async (file) => file in files || Object.keys(files).some((key) => key.startsWith(`${file}/`)),
      readFile: async (file) => {
        if (!(file in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return files[file];
      },
    },
    run: async (argv, options) => {
      calls.push({ argv, options });
      return run(argv);
    },
  };
}

test("detection asks the CLI the question T3 asks, and never prompts", async () => {
  const ctx = fakeCtx({ run: () => ({ code: 0, stdout: '{"hosts":{"github.com":[{"state":"success","active":true,"host":"github.com","login":"octocat"}]}}', stderr: "", error: null }) });
  const out = await detectSourceControlAuth(ctx, getSourceControl("gh"), "gh");
  assert.equal(out.account, "octocat");
  assert.deepEqual(ctx.calls[0].argv, ["gh", "auth", "status", "--json", "hosts"]);
  assert.equal(ctx.calls[0].options.env.GH_PROMPT_DISABLED, "1");
  assert.equal(ctx.calls[0].options.timeoutMs, 1000);

  const az = fakeCtx({ run: () => ({ code: 0, stdout: "ana@example.com\n", stderr: "", error: null }) });
  await detectSourceControlAuth(az, getSourceControl("az"), "/x/az");
  assert.deepEqual(az.calls[0].argv, ["/x/az", "account", "show", "--query", "user.name", "--output", "tsv"]);
});

test("a CLI that does not answer is unknown, not signed out", async () => {
  const ctx = fakeCtx({ run: () => ({ code: null, signal: "SIGKILL", stdout: "", stderr: "", error: "timed out after 1000ms" }) });
  const out = await detectSourceControlAuth(ctx, getSourceControl("glab"), "/x/glab");
  assert.equal(out.status, "unknown");
  assert.match(out.detail, /timed out/);
  assert.equal((await detectSourceControlAuth(ctx, getSourceControl("glab"), null)).status, "unknown");
});

test("fj is read from its key file, without running it", async () => {
  const keys = "/home/t3/.local/share/forgejo-cli/keys.json";
  const signed = fakeCtx({ files: { [keys]: '{"hosts":{"codeberg.org":{"type":"Application","token":"t"}}}' }, run: () => assert.fail("fj was run") });
  assert.equal((await detectSourceControlAuth(signed, getSourceControl("fj"), "/x/fj")).host, "codeberg.org");
  const none = fakeCtx({ run: () => assert.fail("fj was run") });
  assert.equal((await detectSourceControlAuth(none, getSourceControl("fj"), "/x/fj")).status, "unauthenticated");
});

test("az's extensions are read from disk", async () => {
  const az = getSourceControl("az");
  assert.equal(azExtensionDir({}, "/home/t3"), "/home/t3/.azure/cliextensions");
  assert.equal(azExtensionDir({ AZURE_EXTENSION_DIR: "/ext" }, "/home/t3"), "/ext");
  assert.deepEqual(await missingExtensions(fakeCtx(), az), ["azure-devops"]);
  const with_ = fakeCtx({ files: { "/home/t3/.azure/cliextensions/azure-devops/metadata.json": "{}" } });
  assert.deepEqual(await missingExtensions(with_, az), []);
  assert.deepEqual(await missingExtensions(fakeCtx(), getSourceControl("glab")), []);
});

test("a host is a server name, typed with or without https://, never a path or another scheme", () => {
  assert.deepEqual(parseHost("gitlab.com"), { ok: true, host: "gitlab.com" });
  assert.deepEqual(parseHost(" https://Git.Example.com:8443/ "), { ok: true, host: "git.example.com:8443" });
  assert.deepEqual(parseHost("localhost"), { ok: true, host: "localhost" });
  for (const bad of ["", "http://gitlab.com", "ssh://git@x", "git.example.com/gitlab", "-x.com", "a b", "x..y", "--help"]) {
    assert.equal(parseHost(bad).ok, false, JSON.stringify(bad));
  }
  assert.equal(parseToken(" glpat-abc ").token, "glpat-abc");
  for (const bad of ["", "two words", "line\nbreak", "x".repeat(5000)]) assert.equal(parseToken(bad).ok, false);
  assert.deepEqual({ ...DEFAULT_HOSTS }, { gh: "github.com", glab: "gitlab.com", fj: "codeberg.org", tea: "gitea.com" });
});

test("a token goes to the CLI on stdin or in the environment, never as an argument", () => {
  const TOKEN = "tok-123";
  for (const id of ["gh", "glab", "fj", "tea"]) {
    const plan = tokenSignIn(getSourceControl(id), "git.example.com", TOKEN);
    for (const step of plan.steps) {
      assert.equal(step.args.some((arg) => arg.includes(TOKEN)), false, `${id} keeps the token out of argv`);
    }
    const handed = plan.steps.some((step) => step.input === `${TOKEN}\n` || step.env?.GITEA_SERVER_TOKEN === TOKEN);
    assert.ok(handed, `${id} is given the token`);
    assert.ok(plan.undo, `${id} can take a refused token back`);
  }
  assert.deepEqual(tokenSignIn(getSourceControl("gh"), "github.com", TOKEN).steps[1], { args: ["auth", "setup-git", "--hostname", "github.com"], optional: true });
  assert.deepEqual(tokenSignIn(getSourceControl("glab"), "gitlab.com", TOKEN).verify, ["api", "user", "--hostname", "gitlab.com"]);
  assert.deepEqual(tokenSignIn(getSourceControl("fj"), "codeberg.org", TOKEN).verify, ["--host", "https://codeberg.org", "whoami"]);
  assert.equal(tokenSignIn(getSourceControl("az"), "x", TOKEN), null, "az signs in with a device code");
  assert.deepEqual(signOutArgs(getSourceControl("tea"), "gitea.com"), ["logout", "gitea.com"]);
  assert.deepEqual(signOutArgs(getSourceControl("az"), null), ["logout"]);
});

test("a failed sign-in says what the CLI said, with the token cut out", () => {
  assert.equal(failureLine({ code: 1, stderr: "error validating token: HTTP 401: Bad credentials\nTry authenticating with:  gh auth login -h github.com\n", stdout: "" }, "ghp_0123456789abcdef"),
    "error validating token: HTTP 401: Bad credentials");
  assert.equal(failureLine({ code: 1, stderr: "access token does not exist [sha: tok-123]\n", stdout: "" }, "tok-123"), "access token does not exist [sha: …]");
  assert.equal(failureLine({ code: 1, stderr: "", stdout: "" }, "ghp_0123456789abcdef"), "exited with code 1");
});
