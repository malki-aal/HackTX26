// Single developer entry point: starts the Runway API and, in live mode, builds and supervises
// the internal eve agent process on a loopback port.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile, parseConfig, secretValues } from "./config.js";
import { registerSecrets } from "./lib/redact.js";
import { createContext } from "./app/bootstrap.js";
import { buildApp } from "./http/app.js";

loadEnvFile();
const config = parseConfig(process.env);
registerSecrets(secretValues(config));
const internalToken = randomBytes(32).toString("hex");
const root = resolve(import.meta.dirname, "..");
const isWin = process.platform === "win32";
// On Windows the npm bin entry is a .cmd shim that must run through a shell.
const eveBin = resolve(root, isWin ? "node_modules/.bin/eve.cmd" : "node_modules/.bin/eve");

let agentProcess: ChildProcess | null = null;

function agentEnv(): NodeJS.ProcessEnv {
  // Least privilege: the agent process gets the Gemini key and the callback token, not the
  // SerpApi or Nessie keys. All search and banking calls happen in this server.
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    // Windows needs these system variables for node and the .cmd shim to start.
    ...(isWin ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA, TEMP: process.env.TEMP, TMP: process.env.TMP } : {}),
    NODE_ENV: "production",
    EVE_TELEMETRY_DISABLED: "1",
    EVE_SCHEDULES_DISABLED: "1",
    GEMINI_API_KEY: config.gemini.apiKey ?? "",
    GEMINI_MODEL: config.gemini.model ?? "",
    GEMINI_MAX_RPM: process.env.GEMINI_MAX_RPM ?? "0",
    RUNWAY_INTERNAL_URL: `http://127.0.0.1:${config.port}`,
    RUNWAY_INTERNAL_TOKEN: internalToken,
  };
}

function startAgentRuntime() {
  if (config.mode !== "live") return;
  if (!config.gemini.apiKey || !config.gemini.model) {
    console.warn("[runway] Gemini not configured; the agent runtime will start but research runs will fail until GEMINI_API_KEY and GEMINI_MODEL are set.");
  }
  if (process.env.RUNWAY_SKIP_AGENT_BUILD !== "1") {
    console.log("[runway] building agent runtime (eve build)...");
    const b = spawnSync(eveBin, ["build", "--skip-sandbox-prewarm"], { cwd: root, env: agentEnv(), stdio: "inherit", shell: isWin });
    if (b.status !== 0) {
      console.error("[runway] eve build failed; research runs will report agent_runtime errors.");
      return;
    }
  }
  // Runway marks research runs interrupted by a restart as failed. Discard eve's local durable
  // session store too, so old agent turns cannot resume in the background and spend model quota.
  rmSync(resolve(root, ".eve/.workflow-data"), { recursive: true, force: true });
  agentProcess = spawn(eveBin, ["start", "--host", "127.0.0.1", "--port", String(config.agentRuntimePort), "--no-schedules"], { cwd: root, env: agentEnv(), stdio: ["ignore", "inherit", "inherit"], shell: isWin });
  agentProcess.on("exit", (code) => {
    console.warn(`[runway] agent runtime exited (code ${code}).`);
    agentProcess = null;
  });
}

async function main() {
  const ctx = createContext(config, { internalToken });
  const app = buildApp(ctx, { internalToken });
  await app.listen({ host: config.host, port: config.port });
  startAgentRuntime();
  console.log(`[runway] API on http://${config.host}:${config.port}/api/v1 (mode=${config.mode}); agent runtime ${config.mode === "live" ? `on 127.0.0.1:${config.agentRuntimePort}` : "scripted fixture runner"}`);
  const shutdown = async () => {
    for (const c of ctx.activeRuns.values()) c.abort();
    agentProcess?.kill("SIGTERM");
    await app.close();
    ctx.db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("[runway] failed to start:", e instanceof Error ? e.message : e);
  agentProcess?.kill("SIGTERM");
  process.exit(1);
});
