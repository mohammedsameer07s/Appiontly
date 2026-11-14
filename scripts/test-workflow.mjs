import "dotenv/config";

import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const isWindows = process.platform === "win32";
const executableSuffix = isWindows ? ".exe" : "";
const clusterPrefix = join(root, ".local-pg-workflow-");

function postgresBinDirectories() {
  const directories = [];
  if (process.env.PG_BIN) directories.push(resolve(process.env.PG_BIN));

  if (isWindows) {
    const installRoot = "C:\\Program Files\\PostgreSQL";
    if (existsSync(installRoot)) {
      directories.push(
        ...readdirSync(installRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(installRoot, entry.name, "bin")),
      );
    }
  }
  directories.push(...(process.env.PATH ?? "").split(delimiter));
  return [...new Set(directories)];
}

function findPostgresTools() {
  for (const directory of postgresBinDirectories()) {
    const tools = Object.fromEntries(
      ["initdb", "pg_ctl", "createdb"].map((name) => {
        const path = join(directory, `${name}${executableSuffix}`);
        return [name, existsSync(path) ? path : null];
      }),
    );
    if (Object.values(tools).every(Boolean)) return tools;
  }
  return null;
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status ?? "unknown"}.`);
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a local PostgreSQL port.");
  const port = address.port;
  await new Promise((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
  return port;
}

function databaseIdentity(connectionString) {
  const url = new URL(connectionString);
  return `${url.protocol}//${url.hostname}:${url.port || "5432"}${url.pathname}`;
}

function ensureSeparateTestDatabase(testUrl) {
  const applicationUrl = process.env.DATABASE_URL?.trim();
  if (applicationUrl && databaseIdentity(applicationUrl) === databaseIdentity(testUrl)) {
    throw new Error(
      "DATABASE_URL_TEST points to the same host, port, and database as DATABASE_URL. Use a separate, disposable test database.",
    );
  }
}

function executeWorkflowTests(databaseUrl) {
  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    DATABASE_URL_TEST: databaseUrl,
  };
  run(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], env);
  run(process.execPath, ["node_modules/tsx/dist/cli.mjs", "--test", "src/lib/workflows.integration.test.ts"], env);
}

async function main() {
  const configuredTestUrl = process.env.DATABASE_URL_TEST?.trim();
  if (configuredTestUrl) {
    ensureSeparateTestDatabase(configuredTestUrl);
    executeWorkflowTests(configuredTestUrl);
    return;
  }

  const tools = findPostgresTools();
  if (!tools) {
    throw new Error(
      "DATABASE_URL_TEST is unset and local PostgreSQL tools (initdb, pg_ctl, createdb) were not found. Install PostgreSQL, set PG_BIN to its bin directory, configure a separate DATABASE_URL_TEST, or run Docker Compose's postgres-test service. Workflow tests were not run.",
    );
  }

  const clusterPath = mkdtempSync(clusterPrefix);
  let serverStarted = false;
  try {
    const port = await unusedPort();
    const databaseUrl = `postgresql://appointly_test@127.0.0.1:${port}/appointly_test?schema=public`;
    run(tools.initdb, [
      "-D", clusterPath,
      "-U", "appointly_test",
      "--auth-local=trust",
      "--auth-host=trust",
      "--encoding=UTF8",
      "--no-locale",
    ]);
    run(tools.pg_ctl, [
      "-D", clusterPath,
      "-l", join(clusterPath, "server.log"),
      "-o", `-h 127.0.0.1 -p ${port}`,
      "-w", "start",
    ]);
    serverStarted = true;
    run(tools.createdb, ["-h", "127.0.0.1", "-p", String(port), "-U", "appointly_test", "appointly_test"]);
    executeWorkflowTests(databaseUrl);
  } finally {
    try {
      if (serverStarted) {
        run(tools.pg_ctl, ["-D", clusterPath, "-m", "immediate", "-w", "stop"]);
      }
    } finally {
      rmSync(clusterPath, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(`Workflow test setup failed: ${error.message}`);
  process.exitCode = 1;
});
