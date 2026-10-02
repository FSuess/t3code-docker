#!/usr/bin/env node
// Inject the setup-console pill into T3 Code's client shell.
//
// Runs at image build time, after installing T3's platform package. The shell
// is a static file upstream owns, so this reads like any other build step that
// would fail loudly rather than ship: if a future release moves the `</body>` or renames
// the client directory, the build stops here, and scripts/smoke-test.sh checks
// the served HTML again in the running container. Both exist so a T3 bump
// cannot silently drop the only route from the app back to the console.
//
// The paths can be overridden for a local dry run:
//   T3_CLIENT_SHELL=/tmp/index.html T3_SETUP_PILL=docker/t3-client/setup-pill.js \
//     node docker/t3-client/patch.mjs
import { readFileSync, writeFileSync } from "node:fs";

// T3 lives in the root-owned immutable prefix, not the mutable npm prefix.
const T3_PREFIX = process.env.T3_INFRA_PREFIX || "/opt/t3";
const SHELL = process.env.T3_CLIENT_SHELL
  || `${T3_PREFIX}/client/index.html`;
const PILL = process.env.T3_SETUP_PILL
  || "/usr/local/share/t3-client/setup-pill.js";
const MARKER = "t3-setup-pill";

const html = readFileSync(SHELL, "utf8");

if (html.includes(MARKER)) {
  console.log(`[patch] ${SHELL}: pill already present`);
  process.exit(0);
}

if (!html.includes("</body>")) {
  console.error(`[patch] ${SHELL}: no </body> to inject before - upstream layout changed`);
  process.exit(1);
}

const pill = readFileSync(PILL, "utf8");
if (!pill.includes(MARKER)) {
  console.error(`[patch] ${PILL}: does not look like the setup pill`);
  process.exit(1);
}
if (pill.includes("</script")) {
  console.error(`[patch] ${PILL}: contains </script and cannot be inlined`);
  process.exit(1);
}

writeFileSync(SHELL, html.replace("</body>", `<script>\n${pill}</script>\n</body>`));
console.log(`[patch] ${SHELL}: setup pill injected`);
