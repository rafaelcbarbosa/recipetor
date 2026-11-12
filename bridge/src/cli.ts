#!/usr/bin/env node
import { createHermesAdapter } from "./adapters/hermes.ts";
import { loadConfig } from "./config.ts";
import { BridgeError } from "./errors.ts";
import { extractRecipe } from "./extract.ts";
import { canonicalizeInstagramUrl } from "./url.ts";

const USAGE = `Usage: node src/cli.ts <instagram-url>

Extracts a recipe with the configured bridge backend and prints JSON.

Environment:
  BRIDGE_BACKEND     hermes (default)
  BRIDGE_MODEL       optional Hermes model override
  BRIDGE_PROVIDER    optional Hermes provider override
  BRIDGE_TIMEOUT_MS  per-attempt timeout (default 180000)
  BRIDGE_MAX_ATTEMPTS retry count (default 2)
  HERMES_BIN         Hermes executable (default "hermes")`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    if (args.length === 0) process.exitCode = 1;
    return;
  }

  let url: string;
  try {
    url = canonicalizeInstagramUrl(args[0]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Enter a valid Instagram post or reel link.");
    process.exitCode = 1;
    return;
  }

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid bridge configuration.");
    process.exitCode = 1;
    return;
  }

  const adapter = createHermesAdapter({
    binary: config.hermesBin,
    model: config.model || null,
    provider: config.provider || null,
  });

  try {
    const result = await extractRecipe({
      adapter,
      url,
      timeoutMs: config.timeoutMs,
      maxAttempts: config.maxAttempts,
      onRetry: (error, attempt) => {
        console.error(`Attempt ${attempt} failed (${error.code}): ${error.message}. Retrying...`);
      },
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const bridgeError =
      error instanceof BridgeError
        ? error
        : new BridgeError("INTERNAL", error instanceof Error ? error.message : "Extraction failed.", {
            cause: error,
          });
    console.error(`Extraction failed (${bridgeError.code}): ${bridgeError.message}`);
    process.exitCode = 1;
  }
}

void main();
