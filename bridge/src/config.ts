export type BridgeBackend = "hermes";

export interface BridgeConfig {
  host: string;
  port: number;
  token: string;
  backend: BridgeBackend;
  model: string;
  provider: string;
  timeoutMs: number;
  maxAttempts: number;
  maxConcurrency: number;
  rateLimit: number;
  rateWindowMs: number;
  hermesBin: string;
}

function parseInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const backend = (env.BRIDGE_BACKEND || "hermes").trim().toLowerCase();
  if (backend !== "hermes") {
    throw new Error(`Unsupported BRIDGE_BACKEND "${backend}". Supported backends: hermes.`);
  }

  return {
    host: (env.BRIDGE_HOST || "").trim() || "127.0.0.1",
    port: parseInteger(env, "BRIDGE_PORT", 8790, 1, 65535),
    token: (env.BRIDGE_TOKEN || "").trim(),
    backend,
    model: (env.BRIDGE_MODEL || "").trim(),
    provider: (env.BRIDGE_PROVIDER || "").trim(),
    timeoutMs: parseInteger(env, "BRIDGE_TIMEOUT_MS", 180_000, 1_000, 1_800_000),
    maxAttempts: parseInteger(env, "BRIDGE_MAX_ATTEMPTS", 2, 1, 5),
    maxConcurrency: parseInteger(env, "BRIDGE_MAX_CONCURRENCY", 1, 1, 16),
    rateLimit: parseInteger(env, "BRIDGE_RATE_LIMIT", 30, 0, 100_000),
    rateWindowMs: parseInteger(env, "BRIDGE_RATE_WINDOW_MS", 3_600_000, 1_000, 86_400_000),
    hermesBin: (env.HERMES_BIN || "").trim() || "hermes",
  };
}

export function requireBridgeToken(config: BridgeConfig): void {
  if (!config.token) {
    throw new Error("BRIDGE_TOKEN must be set to a non-empty value.");
  }
  if (config.token === "change-me") {
    throw new Error("BRIDGE_TOKEN is still set to the example value. Choose a random token.");
  }
}
