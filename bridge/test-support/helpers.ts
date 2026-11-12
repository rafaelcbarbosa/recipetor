import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { ExtractorAdapter } from "../src/adapters/types.ts";
import type { BridgeConfig } from "../src/config.ts";
import type { Recipe } from "../src/recipe-schema.ts";
import { createBridgeServer, type Logger } from "../src/server.ts";

export const RECIPE: Recipe = {
  title: "Lemon Butter Pasta",
  description: "A bright lemon pasta.",
  category: "Dinner",
  prepTimeMinutes: 25,
  basePortions: 4,
  ingredients: [
    {
      amount: 12,
      unit: "oz",
      name: "spaghetti",
      nutrition: { calories: 220, protein: 8, carbs: 43, fat: 1 },
    },
    {
      amount: 2,
      unit: "units",
      name: "lemons",
      nutrition: { calories: 34, protein: 1, carbs: 11, fat: 0 },
    },
  ],
  instructions: ["Boil the pasta.", "Toss with lemon and butter."],
  totals: { calories: 219, protein: 7, carbs: 14, fat: 15 },
};

export const silentLogger: Logger = {
  info() {},
  warn() {},
  error() {},
};

export function testConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "test-token",
    backend: "hermes",
    model: "fake-model",
    provider: "",
    timeoutMs: 5000,
    maxAttempts: 2,
    maxConcurrency: 1,
    rateLimit: 100,
    rateWindowMs: 60_000,
    hermesBin: "hermes",
    verbose: false,
    progressIntervalMs: 15_000,
    ...overrides,
  };
}

export function fakeAdapter(overrides: Partial<ExtractorAdapter> = {}): ExtractorAdapter {
  return {
    name: "fake",
    model: "fake-model",
    provider: null,
    extract: async () => structuredClone(RECIPE),
    isAvailable: async () => true,
    ...overrides,
  };
}

export async function startTestServer(
  config: BridgeConfig,
  adapter: ExtractorAdapter,
): Promise<{ server: Server; baseUrl: string }> {
  const server = createBridgeServer({ config, adapter, logger: silentLogger });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

export async function stopTestServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export function postExtract(
  baseUrl: string,
  body: unknown,
  token = "test-token",
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}/v1/extract`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const fakeDirectories: string[] = [];

export function fakeHermes(body: string): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "recipetor-bridge-hermes-"));
  fakeDirectories.push(dir);
  const path = join(dir, "hermes");
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(path, 0o755);
  return { path, dir };
}

export function cleanupFakeBinaries(): void {
  for (const dir of fakeDirectories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function jsonOutputScript(value: unknown): string {
  return `process.stdout.write(${JSON.stringify(JSON.stringify(value))});`;
}
