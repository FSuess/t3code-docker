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
  DEFAULT_HOSTS, azExtensionDir, credentialFiles, detectSourceControlAuth, deviceSignIn, failureLine, fjKeysPath, missingExtensions,
  parseAzAuth, parseDevicePrompt, parseFjKeys, parseGhAuth, parseGlabAuth, parseHost, parseTeaAuth, parseToken, safeLine, signOutArgs,
  teaLoginFor, tokenSignIn,
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

  // Only the active account counts: every gh call runs as it, so a second
  // account that works does not make up for an active one that does not.
  const inactive = JSON.stringify({ hosts: { "github.com": [
    { state: "error", error: "HTTP 401: Bad credentials (https://api.github.com/)", active: true, host: "github.com", login: "alice" },
    { state: "success", active: false, host: "github.com", login: "bob" },
  ] } });
  assert.deepEqual(parseGhAuth({ stdout: inactive }),
    { status: "unauthenticated", account: null, host: "github.com", detail: "HTTP 401: Bad credentials (https://api.github.com/)" });

  // A host gh never reached is not a host it is signed out of.
  const timeout = JSON.stringify({ hosts: { "github.com": [{ state: "timeout", active: true, host: "github.com", login: "octocat" }] } });
  assert.deepEqual(parseGhAuth({ stdout: timeout }),
    { status: "unknown", account: null, host: "github.com", detail: "github.com did not answer in time" });
  const offline = JSON.stringify({ hosts: { "github.com": [{ state: "error", active: true, host: "github.com", login: "octocat",
    error: 'Get "https://api.github.com/": dial tcp: lookup api.github.com on 127.0.0.11:53: no such host' }] } });
  assert.equal(parseGhAuth({ stdout: offline }).status, "unknown");
  assert.equal(parseGhAuth({ stdout: offline }).detail, "github.com does not resolve", "the point, not the wrapping");

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

  // What glab 1.120 prints for a host it cannot reach: unknown, not signed out.
  const offline = [
    "gitlab.example.com",
    '  x gitlab.example.com: API call failed: Get "https://gitlab.example.com/api/v4/user": dial tcp: lookup gitlab.example.com: no such host',
    "  ✓ Git operations for gitlab.example.com configured to use https protocol.",
    "  ✓ Token found in configuration file (plaintext): **************************",
  ].join("\n");
  const unknown = parseGlabAuth({ stderr: offline, code: 1 });
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.host, "gitlab.example.com");
  assert.equal(unknown.detail, "gitlab.example.com does not resolve");
  const tls = offline.replace("dial tcp: lookup gitlab.example.com: no such host", "remote error: tls: unrecognized name");
  assert.equal(parseGlabAuth({ stderr: tls, code: 1 }).status, "unknown", "a TLS failure never got an answer either");
  const x509 = offline.replace("dial tcp: lookup gitlab.example.com: no such host", "tls: failed to verify certificate: x509: certificate signed by unknown authority");
  assert.equal(parseGlabAuth({ stderr: x509, code: 1 }).detail, "gitlab.example.com's certificate is not trusted");
});

test("tea: the default login, valid or not", () => {
  const logins = JSON.stringify([
    { name: "work", url: "https://git.example.com", user: "ana", default: "false", valid: "true" },
    { name: "gitea.com", url: "https://gitea.com", user: "ana-g", default: "true", valid: "true" },
  ]);
  assert.deepEqual(parseTeaAuth({ stdout: logins }), { status: "authenticated", account: "ana-g", host: "gitea.com", detail: null });
  // tea says "false" alike for a refused token and an unreachable server, so
  // the verdict keeps the login's name for the follow-up question.
  const invalid = JSON.stringify([{ name: "x", url: "https://git.example.com", user: "", default: "true", valid: "false" }]);
  assert.deepEqual(parseTeaAuth({ stdout: invalid }), { status: "unauthenticated", account: null, host: "git.example.com", detail: null, login: "x" });
  assert.equal(parseTeaAuth({ stdout: "[]\n" }).status, "unauthenticated");
  assert.equal(parseTeaAuth({ stdout: "not json" }).status, "unknown");
});

test("az: a user name, or az's own complaint", () => {
  assert.deepEqual(parseAzAuth({ stdout: "ana@example.com\n", code: 0 }), { status: "authenticated", account: "ana@example.com", host: "dev.azure.com", detail: null });
  const out = parseAzAuth({ stderr: "ERROR: Please run 'az login' to setup account.\n", code: 1 });
  assert.equal(out.status, "unauthenticated");
  assert.equal(out.detail, "ERROR: Please run 'az login' to setup account.");
  assert.equal(parseAzAuth({ stdout: "\n", code: 0 }).status, "unknown");
  // An az that is broken is not signed out: that would offer a sign-in that cannot work.
  const broken = parseAzAuth({ stderr: "Traceback (most recent call last):\nModuleNotFoundError: No module named 'azure.cli.command_modules.profile'\n", code: 1 });
  assert.equal(broken.status, "unknown");
  assert.equal(broken.detail, "ModuleNotFoundError: No module named 'azure.cli.command_modules.profile'");
  assert.equal(parseAzAuth({ stderr: "ERROR: AADSTS700082: The refresh token has expired due to inactivity.\n", code: 1 }).status, "unauthenticated");
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

test("tea: an invalid login is asked once more, to tell a refused token from a server it never reached", async () => {
  const status = JSON.stringify([{ name: "gitea.com", url: "https://gitea.com", user: "", default: "true", valid: "false" }]);
  // tea 0.16: the server's refusal comes back as its JSON with exit 0; a
  // request that never got an answer fails with exit 1.
  const refused = fakeCtx({ run: (argv) => argv[1] === "login"
    ? { code: 0, stdout: status, stderr: "", error: null }
    : { code: 0, stdout: '{"message":"invalid username, password or token","url":"https://gitea.com/api/swagger"}', stderr: "", error: null } });
  assert.deepEqual(await detectSourceControlAuth(refused, getSourceControl("tea"), "/x/tea"),
    { status: "unauthenticated", account: null, host: "gitea.com", detail: "invalid username, password or token" });
  assert.deepEqual(refused.calls[1].argv, ["/x/tea", "api", "--login", "gitea.com", "/user"]);

  const offline = fakeCtx({ run: (argv) => argv[1] === "login"
    ? { code: 0, stdout: status, stderr: "", error: null }
    : { code: 1, stdout: "", stderr: 'Error: request failed: Get "https://gitea.com/api/v1/user": dial tcp: lookup gitea.com: no such host\n', error: null } });
  assert.equal((await detectSourceControlAuth(offline, getSourceControl("tea"), "/x/tea")).status, "unknown");

  const valid = fakeCtx({ run: () => ({ code: 0, stdout: status.replace('"valid":"false"', '"valid":"true"'), stderr: "", error: null }) });
  await detectSourceControlAuth(valid, getSourceControl("tea"), "/x/tea");
  assert.equal(valid.calls.length, 1, "a valid login is not asked twice");
});

test("each CLI's credential files are where it writes them", () => {
  const home = "/home/t3";
  const files = (id, env = {}) => credentialFiles(getSourceControl(id), env, home);
  assert.deepEqual(files("gh"), ["/home/t3/.config/gh/hosts.yml"]);
  assert.deepEqual(files("gh", { GH_CONFIG_DIR: "/gh" }), ["/gh/hosts.yml"]);
  assert.deepEqual(files("glab"), ["/home/t3/.config/glab-cli/config.yml"]);
  assert.deepEqual(files("tea", { XDG_CONFIG_HOME: "/cfg" }), ["/cfg/tea/config.yml"]);
  assert.deepEqual(files("fj"), ["/home/t3/.local/share/forgejo-cli/keys.json"]);
  assert.deepEqual(files("az"), ["/home/t3/.azure/azureProfile.json", "/home/t3/.azure/msal_token_cache.json"]);
});

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
  }
  assert.deepEqual(tokenSignIn(getSourceControl("gh"), "github.com", TOKEN).steps[1],
    { args: ["auth", "setup-git", "--hostname", "github.com"], optional: true, warn: "Signed in, but git push over HTTPS will not use it" });
  // fj keeps a key it already has (and exits 0), tea refuses a login name in
  // use: both sign out of the host first, and either may have nothing to sign out of.
  assert.deepEqual(tokenSignIn(getSourceControl("fj"), "codeberg.org", TOKEN).steps.map((step) => [step.args.join(" "), Boolean(step.optional)]),
    [["auth logout codeberg.org", true], ["--host https://codeberg.org auth add-token", false]]);
  assert.deepEqual(tokenSignIn(getSourceControl("tea"), "gitea.com", TOKEN).steps.map((step) => [step.args.join(" "), Boolean(step.optional)]),
    [["logout gitea.com", true], ["login add --name gitea.com --url https://gitea.com --git-credentials", false]]);
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

test("gh and az sign in with a device code; the others only take a token", () => {
  const gh = deviceSignIn(getSourceControl("gh"));
  assert.equal(gh.host, "github.com");
  assert.deepEqual(gh.args, ["auth", "login", "--web", "--hostname", "github.com", "--git-protocol", "https", "--insecure-storage",
    "--skip-ssh-key", "--scopes", "workflow"], "workflow on top of gh's own scopes, so T3 can push workflow files");
  assert.deepEqual(gh.after, [{ args: ["auth", "setup-git", "--hostname", "github.com"], warn: "Signed in, but git push over HTTPS will not use it" }],
    "git push over HTTPS signs in the same way");
  assert.equal(deviceSignIn(getSourceControl("gh"), "github.example.com").args[4], "github.example.com");
  assert.deepEqual(deviceSignIn(getSourceControl("az")).args, ["login", "--use-device-code", "--allow-no-subscriptions", "--output", "none"]);
  for (const id of ["glab", "fj", "tea"]) assert.equal(deviceSignIn(getSourceControl(id)), null, id);
});

test("a device sign-in's page and code come from the lines that ask for them", () => {
  // gh 2.102, with no clipboard and no browser, as in the container.
  const gh = getSourceControl("gh");
  const ghSaid = [
    "! Failed to copy one-time code to clipboard",
    "  No clipboard utilities available. Please install xsel, xclip, wl-clipboard or Termux:API add-on for termux-clipboard-get/set.",
    "! First copy your one-time code: 30B3-A660",
    "Open this URL to continue in your web browser: https://github.com/login/device",
  ].join("\n");
  assert.deepEqual(parseDevicePrompt(gh, ghSaid), { url: "https://github.com/login/device", code: "30B3-A660" });
  assert.deepEqual(parseDevicePrompt(gh, ghSaid.split("\n").slice(0, 3).join("\n")), { url: null, code: "30B3-A660" }, "the code comes first");
  assert.deepEqual(parseDevicePrompt(gh, ""), { url: null, code: null });

  // az 2.90's line; a warning with a longer link can come before it.
  const az = getSourceControl("az");
  const azSaid = [
    "WARNING: A web browser has been opened at https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?client_id=04b07795-8ddb-461a-bbee-02f9e1bf7b46. Please continue the login there.",
    "To sign in, use a web browser to open the page https://login.microsoft.com/device and enter the code AATJL9P8Y to authenticate.",
  ].join("\n");
  assert.deepEqual(parseDevicePrompt(az, azSaid), { url: "https://login.microsoft.com/device", code: "AATJL9P8Y" });
  assert.deepEqual(parseDevicePrompt(az, "To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code DXQ8ZRT7K to authenticate."),
    { url: "https://microsoft.com/devicelogin", code: "DXQ8ZRT7K" }, "and the older page");
  assert.deepEqual(parseDevicePrompt(az, azSaid.split("\n")[0]), { url: null, code: null });
  assert.deepEqual(parseDevicePrompt(getSourceControl("glab"), azSaid), { url: null, code: null });
});

test("signing out names the account gh should drop, and the login tea knows the host by", () => {
  const gh = getSourceControl("gh");
  assert.deepEqual(signOutArgs(gh, "github.com"), ["auth", "logout", "--hostname", "github.com"]);
  assert.deepEqual(signOutArgs(gh, "github.com", { account: "octocat" }), ["auth", "logout", "--hostname", "github.com", "--user", "octocat"],
    "with two accounts on one host, gh will not guess");
  assert.deepEqual(signOutArgs(gh, "github.com", { account: "--hostname=evil" }), ["auth", "logout", "--hostname", "github.com"], "never an option");
  assert.deepEqual(signOutArgs(getSourceControl("glab"), "gitlab.com"), ["auth", "logout", "--hostname", "gitlab.com"]);
  assert.deepEqual(signOutArgs(getSourceControl("fj"), "codeberg.org"), ["auth", "logout", "codeberg.org"]);
  assert.deepEqual(signOutArgs(getSourceControl("az"), null), ["logout"]);

  const tea = getSourceControl("tea");
  const listed = JSON.stringify([
    { name: "work", url: "https://git.example.com", default: "true", user: "ana" },
    { name: "gitea.com", url: "https://gitea.com", default: "false", user: "ana" },
  ]);
  assert.equal(teaLoginFor(listed, "git.example.com"), "work", "made in a terminal, under a name of its own");
  assert.equal(teaLoginFor(listed, "gitea.com"), "gitea.com");
  assert.equal(teaLoginFor(listed, "codeberg.org"), null);
  assert.equal(teaLoginFor("not json", "gitea.com"), null);
  assert.deepEqual(signOutArgs(tea, "git.example.com", { login: "work" }), ["logout", "work"]);
  assert.deepEqual(signOutArgs(tea, "gitea.com"), ["logout", "gitea.com"], "the name the page gives a login");
});
