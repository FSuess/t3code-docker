#!/usr/bin/env node
// Noninteractive entry point for the provider integration.
//
// The shell helpers (t3-login, t3-browser-mcp) cannot import an ESM module, and
// the entrypoint wants one line of output, so both go through here:
//
//   cli.mjs resolve <id>   print the runnable managed executable, or nothing
//   cli.mjs sync           write managed selections into T3's settings
//   cli.mjs status         print the manager's facts as JSON
//
// `resolve` exits 0 when a managed executable is runnable and 3 when it is not;
// callers treat any other exit as "no managed answer" and fall back.
import os from "node:os";
import { pathToFileURL } from "node:url";

import { createProviderIntegration } from "./index.mjs";

const HARNESS_MODULE = process.env.T3_HARNESS_MODULE || "/opt/t3-harness/index.mjs";

const usage = `Usage: cli.mjs <resolve <id>|sync|status> [--json]

  resolve <id>   managed executable for claude|codex|opencode|grok|cursor
  sync           apply managed selections to T3's provider settings
  status         harness facts as JSON
`;

async function loadManager() {
  const module = await import(pathToFileURL(HARNESS_MODULE).href);
  return module.createHarnessManager();
}

const [command, ...rest] = process.argv.slice(2);
const json = rest.includes("--json");
const args = rest.filter((value) => value !== "--json");

try {
  switch (command) {
    case "resolve": {
      const id = args[0];
      if (!id) {
        process.stderr.write("provider-integration: resolve needs a harness id\n");
        process.exitCode = 2;
        break;
      }
      const harness = await loadManager();
      const facts = await harness.resolve(id, { authenticate: false });
      if (json) process.stdout.write(`${JSON.stringify(facts)}\n`);
      else if (facts.runnable && facts.executable) process.stdout.write(`${facts.executable}\n`);
      process.exitCode = facts.runnable && facts.executable ? 0 : 3;
      break;
    }
    case "status": {
      const harness = await loadManager();
      process.stdout.write(`${JSON.stringify(await harness.status({ authenticate: false }))}\n`);
      break;
    }
    case "sync": {
      const harness = await loadManager();
      const integration = createProviderIntegration({
        env: process.env,
        home: process.env.HOME ?? os.homedir(),
        harness,
      });
      const report = await integration.sync();
      if (json) {
        process.stdout.write(`${JSON.stringify(report)}\n`);
      } else if (report.ok) {
        const applied = report.applied.map((entry) => entry.id).join(",") || "none";
        const cleared = report.cleared.map((entry) => entry.id).join(",") || "none";
        const kept = report.kept.map((entry) => entry.id).join(",");
        process.stdout.write(`applied ${applied}; cleared ${cleared}`
          + `${kept ? `; kept your own binaryPath for ${kept}` : ""}\n`);
      }
      if (!report.ok) {
        process.stderr.write(`provider-integration: ${report.error}\n`);
        process.exitCode = 1;
      }
      break;
    }
    default:
      process.stderr.write(usage);
      process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`provider-integration: ${String(error?.message ?? error)}\n`);
  process.exitCode = 4;
}
