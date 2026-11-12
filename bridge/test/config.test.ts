import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, requireBridgeToken } from "../src/config.ts";

test("uses safe bridge defaults", () => {
  const config = loadConfig({});
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 8790);
  assert.equal(config.token, "");
  assert.equal(config.backend, "hermes");
  assert.equal(config.model, "");
  assert.equal(config.provider, "");
  assert.equal(config.timeoutMs, 180_000);
  assert.equal(config.maxAttempts, 2);
  assert.equal(config.maxConcurrency, 1);
  assert.equal(config.rateLimit, 30);
  assert.equal(config.rateWindowMs, 3_600_000);
  assert.equal(config.hermesBin, "hermes");
  assert.equal(config.verbose, true);
  assert.equal(config.progressIntervalMs, 15_000);
});

test("reads overrides from the environment", () => {
  const config = loadConfig({
    BRIDGE_HOST: "0.0.0.0",
    BRIDGE_PORT: "9000",
    BRIDGE_TOKEN: "secret",
    BRIDGE_MODEL: "claude-sonnet-4",
    BRIDGE_PROVIDER: "anthropic",
    BRIDGE_TIMEOUT_MS: "60000",
    BRIDGE_MAX_ATTEMPTS: "3",
    BRIDGE_MAX_CONCURRENCY: "2",
    BRIDGE_RATE_LIMIT: "10",
    BRIDGE_RATE_WINDOW_MS: "120000",
    HERMES_BIN: "/opt/hermes",
    BRIDGE_VERBOSE: "false",
    BRIDGE_PROGRESS_INTERVAL_MS: "5000",
  });
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 9000);
  assert.equal(config.token, "secret");
  assert.equal(config.model, "claude-sonnet-4");
  assert.equal(config.provider, "anthropic");
  assert.equal(config.timeoutMs, 60_000);
  assert.equal(config.maxAttempts, 3);
  assert.equal(config.maxConcurrency, 2);
  assert.equal(config.rateLimit, 10);
  assert.equal(config.rateWindowMs, 120_000);
  assert.equal(config.hermesBin, "/opt/hermes");
  assert.equal(config.verbose, false);
  assert.equal(config.progressIntervalMs, 5_000);
});

test("rejects unsupported backends", () => {
  assert.throws(() => loadConfig({ BRIDGE_BACKEND: "openai" }), /Unsupported BRIDGE_BACKEND/);
});

test("rejects out-of-range numbers", () => {
  assert.throws(() => loadConfig({ BRIDGE_PORT: "0" }), /BRIDGE_PORT/);
  assert.throws(() => loadConfig({ BRIDGE_PORT: "abc" }), /BRIDGE_PORT/);
  assert.throws(() => loadConfig({ BRIDGE_MAX_ATTEMPTS: "9" }), /BRIDGE_MAX_ATTEMPTS/);
  assert.throws(() => loadConfig({ BRIDGE_VERBOSE: "maybe" }), /BRIDGE_VERBOSE/);
});

test("requires a non-example token", () => {
  assert.throws(() => requireBridgeToken(loadConfig({})), /BRIDGE_TOKEN/);
  assert.throws(() => requireBridgeToken(loadConfig({ BRIDGE_TOKEN: "change-me" })), /example/);
  assert.doesNotThrow(() => requireBridgeToken(loadConfig({ BRIDGE_TOKEN: "a-real-token" })));
});
