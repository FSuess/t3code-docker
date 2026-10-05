// The one-port router as a process: T3_SINGLE_PORT in, a listener out.
//
//   node server.mjs           run it (the entrypoint keeps it running)
//   node server.mjs --check   validate the configuration and exit, so the
//                             entrypoint can refuse to start a container whose
//                             one port could never work
//
// See router.mjs for what it does to a request.
import { createRouterServer, readConfig } from "./router.mjs";

const log = (line) => console.log(`[router] ${line}`);
const fatal = (line) => {
  console.error(`[router] ERROR: ${line}`);
  process.exit(1);
};

let config;
try {
  config = readConfig(process.env);
} catch (error) {
  if (process.argv.includes("--check")) {
    console.error(`[t3code] ERROR: ${error.message}`);
    process.exit(1);
  }
  fatal(error.message);
}
if (process.argv.includes("--check")) process.exit(0);
if (!config) fatal("T3_SINGLE_PORT is not set; there is nothing to route.");

const server = createRouterServer({ ...config, log });

// Both stacks where the container has IPv6 (Fly's and Railway's private
// networks are IPv6), IPv4 alone where it does not.
const listen = (host) => new Promise((resolve, reject) => {
  const failed = (error) => reject(error);
  server.once("error", failed);
  server.listen(config.port, host, () => {
    server.off("error", failed);
    resolve(host);
  });
});

const explain = (error) => {
  switch (error.code) {
    case "EADDRINUSE":
      return `port ${config.port} is already in use in this container. Something else listens there; pick another T3_SINGLE_PORT.`;
    case "EACCES":
      return `port ${config.port} needs privileges this container does not give. Use a port above 1023, such as 8080, and map the one you want to it.`;
    default:
      return `could not listen on port ${config.port}: ${error.message}`;
  }
};

let host;
try {
  host = await listen("::");
} catch (error) {
  if (error.code !== "EAFNOSUPPORT" && error.code !== "EADDRNOTAVAIL") fatal(explain(error));
  try {
    host = await listen("0.0.0.0");
  } catch (fallback) {
    fatal(explain(fallback));
  }
}

const where = config.setup
  ? `T3 Code (port ${config.t3.port}) at /, the setup page (port ${config.setup.port}) at ${config.setupPrefix}`
  : `T3 Code (port ${config.t3.port}); the setup page is off`;
log(`listening on ${host === "::" ? "[::]" : host}:${config.port}: ${where}`);

// Stop taking connections, let what is in flight finish briefly, then go.
const stop = () => {
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setTimeout(() => process.exit(0), 2_000).unref();
};
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, stop);
