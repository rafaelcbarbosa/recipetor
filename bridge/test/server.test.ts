import assert from "node:assert/strict";
import test from "node:test";
import { BridgeError } from "../src/errors.ts";
import {
  fakeAdapter,
  postExtract,
  RECIPE,
  startTestServer,
  stopTestServer,
  testConfig,
} from "../test-support/helpers.ts";

const URL = "https://www.instagram.com/reel/ABC123/";

test("reports health and backend metadata", async () => {
  const { server, baseUrl } = await startTestServer(testConfig(), fakeAdapter());
  try {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.status, "ok");
    assert.equal(body.backend, "hermes");
    assert.equal(body.model, "fake-model");
    assert.equal(body.hermesAvailable, true);
    assert.ok(typeof body.version === "string");
  } finally {
    await stopTestServer(server);
  }
});

test("reports degraded health when Hermes is missing", async () => {
  const adapter = fakeAdapter({ isAvailable: async () => false });
  const { server, baseUrl } = await startTestServer(testConfig(), adapter);
  try {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.status, "degraded");
    assert.equal(body.hermesAvailable, false);
  } finally {
    await stopTestServer(server);
  }
});

test("requires a bearer token", async () => {
  const { server, baseUrl } = await startTestServer(testConfig(), fakeAdapter());
  try {
    const missing = await postExtract(baseUrl, { url: URL }, "");
    assert.equal(missing.status, 401);
    assert.equal(((await missing.json()) as any).error.code, "UNAUTHORIZED");

    const wrong = await postExtract(baseUrl, { url: URL }, "wrong-token");
    assert.equal(wrong.status, 401);
    assert.equal(((await wrong.json()) as any).error.code, "UNAUTHORIZED");
  } finally {
    await stopTestServer(server);
  }
});

test("rejects non-Instagram URLs", async () => {
  const { server, baseUrl } = await startTestServer(testConfig(), fakeAdapter());
  try {
    const response = await postExtract(baseUrl, { url: "https://example.com/reel/ABC/" });
    assert.equal(response.status, 400);
    const body = (await response.json()) as any;
    assert.equal(body.error.code, "INVALID_URL");
  } finally {
    await stopTestServer(server);
  }
});

test("extracts a recipe and canonicalizes the URL", async () => {
  let received = "";
  const adapter = fakeAdapter({
    extract: async (url) => {
      received = url;
      return structuredClone(RECIPE);
    },
  });
  const { server, baseUrl } = await startTestServer(testConfig(), adapter);
  try {
    const response = await postExtract(baseUrl, {
      url: "https://instagram.com/reel/ABC123/?igsh=tracking",
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as any;
    assert.equal(received, URL);
    assert.equal(body.recipe.title, RECIPE.title);
    assert.equal(body.meta.backend, "fake");
    assert.equal(body.meta.model, "fake-model");
    assert.equal(body.meta.attempts, 1);
    assert.ok(typeof body.meta.promptVersion === "string");
    assert.ok(body.meta.durationMs >= 0);
  } finally {
    await stopTestServer(server);
  }
});

test("retries a retryable model failure once", async () => {
  let calls = 0;
  const adapter = fakeAdapter({
    extract: async () => {
      calls += 1;
      if (calls === 1) {
        throw new BridgeError("INVALID_MODEL_OUTPUT", "The extractor returned invalid JSON.");
      }
      return structuredClone(RECIPE);
    },
  });
  const { server, baseUrl } = await startTestServer(testConfig({ maxAttempts: 2 }), adapter);
  try {
    const response = await postExtract(baseUrl, { url: URL });
    assert.equal(response.status, 200);
    const body = (await response.json()) as any;
    assert.equal(calls, 2);
    assert.equal(body.meta.attempts, 2);
  } finally {
    await stopTestServer(server);
  }
});

test("returns the final error after retries are exhausted", async () => {
  let calls = 0;
  const adapter = fakeAdapter({
    extract: async () => {
      calls += 1;
      throw new BridgeError("INVALID_MODEL_OUTPUT", "The extractor returned invalid JSON.");
    },
  });
  const { server, baseUrl } = await startTestServer(testConfig({ maxAttempts: 2 }), adapter);
  try {
    const response = await postExtract(baseUrl, { url: URL });
    assert.equal(response.status, 502);
    const body = (await response.json()) as any;
    assert.equal(body.error.code, "INVALID_MODEL_OUTPUT");
    assert.equal(body.error.retryable, true);
    assert.equal(calls, 2);
  } finally {
    await stopTestServer(server);
  }
});

test("does not retry NO_RECIPE", async () => {
  let calls = 0;
  const adapter = fakeAdapter({
    extract: async () => {
      calls += 1;
      throw new BridgeError("NO_RECIPE", "No recipe found in this post.");
    },
  });
  const { server, baseUrl } = await startTestServer(testConfig({ maxAttempts: 2 }), adapter);
  try {
    const response = await postExtract(baseUrl, { url: URL });
    assert.equal(response.status, 422);
    const body = (await response.json()) as any;
    assert.equal(body.error.code, "NO_RECIPE");
    assert.equal(body.error.retryable, false);
    assert.equal(calls, 1);
  } finally {
    await stopTestServer(server);
  }
});

test("enforces the global rate limit", async () => {
  const { server, baseUrl } = await startTestServer(testConfig({ rateLimit: 2 }), fakeAdapter());
  try {
    assert.equal((await postExtract(baseUrl, { url: URL })).status, 200);
    assert.equal((await postExtract(baseUrl, { url: URL })).status, 200);

    const limited = await postExtract(baseUrl, { url: URL });
    assert.equal(limited.status, 429);
    assert.ok(limited.headers.get("retry-after"));
    const body = (await limited.json()) as any;
    assert.equal(body.error.code, "RATE_LIMITED");
  } finally {
    await stopTestServer(server);
  }
});

test("rejects malformed request bodies", async () => {
  const { server, baseUrl } = await startTestServer(testConfig(), fakeAdapter());
  try {
    const response = await fetch(`${baseUrl}/v1/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
      body: "not json",
    });
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as any).error.code, "BAD_REQUEST");
  } finally {
    await stopTestServer(server);
  }
});

test("serializes extractions with maxConcurrency", async () => {
  let active = 0;
  let peak = 0;
  const adapter = fakeAdapter({
    extract: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 30));
      active -= 1;
      return structuredClone(RECIPE);
    },
  });
  const { server, baseUrl } = await startTestServer(
    testConfig({ maxConcurrency: 1 }),
    adapter,
  );
  try {
    const responses = await Promise.all([
      postExtract(baseUrl, { url: URL }),
      postExtract(baseUrl, { url: URL }),
    ]);
    assert.deepEqual(
      responses.map((response) => response.status),
      [200, 200],
    );
    assert.equal(peak, 1);
  } finally {
    await stopTestServer(server);
  }
});

test("returns 405 and 404 for unknown routes", async () => {
  const { server, baseUrl } = await startTestServer(testConfig(), fakeAdapter());
  try {
    const wrongMethod = await fetch(`${baseUrl}/v1/extract`);
    assert.equal(wrongMethod.status, 405);
    assert.equal(((await wrongMethod.json()) as any).error.code, "METHOD_NOT_ALLOWED");

    const missing = await fetch(`${baseUrl}/nope`);
    assert.equal(missing.status, 404);
    assert.equal(((await missing.json()) as any).error.code, "NOT_FOUND");
  } finally {
    await stopTestServer(server);
  }
});
