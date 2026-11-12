import assert from "node:assert/strict";
import test from "node:test";
import { validateRecipe } from "../src/recipe-schema.ts";
import {
  fakeAdapter,
  postExtract,
  startTestServer,
  stopTestServer,
  testConfig,
} from "../test-support/helpers.ts";

test("the HTTP contract returns a validated recipe and meta object", async () => {
  const { server, baseUrl } = await startTestServer(testConfig(), fakeAdapter());
  try {
    const response = await postExtract(baseUrl, {
      url: "https://www.instagram.com/reel/CONTRACT/",
    });
    assert.equal(response.status, 200);

    const body = (await response.json()) as Record<string, unknown>;
    assert.ok(body.recipe && typeof body.recipe === "object");
    assert.ok(body.meta && typeof body.meta === "object");

    const recipe = validateRecipe(body.recipe);
    assert.ok(recipe.title.length > 0);
    assert.ok(recipe.ingredients.length > 0);

    const meta = body.meta as Record<string, unknown>;
    for (const key of ["backend", "model", "provider", "durationMs", "promptVersion", "attempts"]) {
      assert.ok(key in meta, `meta.${key} is missing`);
    }
    assert.equal(typeof meta.backend, "string");
    assert.equal(typeof meta.durationMs, "number");
    assert.equal(typeof meta.promptVersion, "string");
    assert.equal(typeof meta.attempts, "number");
  } finally {
    await stopTestServer(server);
  }
});

test("the HTTP error contract always includes code, message, and retryable", async () => {
  const { server, baseUrl } = await startTestServer(testConfig(), fakeAdapter());
  try {
    const response = await postExtract(baseUrl, { url: "https://example.com/p/ABC/" });
    assert.equal(response.status, 400);

    const body = (await response.json()) as any;
    assert.equal(typeof body.error.code, "string");
    assert.equal(typeof body.error.message, "string");
    assert.equal(typeof body.error.retryable, "boolean");
  } finally {
    await stopTestServer(server);
  }
});
