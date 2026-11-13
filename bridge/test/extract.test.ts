import assert from "node:assert/strict";
import test from "node:test";
import { BridgeError } from "../src/errors.ts";
import { extractRecipe } from "../src/extract.ts";
import { fakeAdapter, RECIPE } from "../test-support/helpers.ts";

function options(overrides: Partial<Parameters<typeof extractRecipe>[0]> = {}) {
  return {
    adapter: fakeAdapter(),
    url: "https://www.instagram.com/p/example/",
    timeoutMs: 5000,
    maxAttempts: 2,
    ...overrides,
  };
}

test("retries an incomplete recipe and succeeds", async () => {
  let calls = 0;
  const adapter = fakeAdapter({
    extract: async () => {
      calls += 1;
      if (calls === 1) {
        throw new BridgeError("INCOMPLETE_RECIPE", "The extractor returned a recipe without cooking instructions.");
      }
      return structuredClone(RECIPE);
    },
  });

  const result = await extractRecipe(options({ adapter }));

  assert.equal(calls, 2);
  assert.equal(result.meta.attempts, 2);
  assert.deepEqual(result.recipe.instructions, RECIPE.instructions);
});

test("resolves a persistently incomplete recipe to NO_RECIPE", async () => {
  let calls = 0;
  const adapter = fakeAdapter({
    extract: async () => {
      calls += 1;
      throw new BridgeError("INCOMPLETE_RECIPE", "The extractor returned a recipe without cooking instructions.");
    },
  });

  await assert.rejects(
    extractRecipe(options({ adapter })),
    (error) =>
      error instanceof BridgeError &&
      error.code === "NO_RECIPE" &&
      !error.retryable,
  );
  assert.equal(calls, 2);
});

test("does not retry NO_RECIPE", async () => {
  let calls = 0;
  const adapter = fakeAdapter({
    extract: async () => {
      calls += 1;
      throw new BridgeError("NO_RECIPE", "No recipe found in this post.");
    },
  });

  await assert.rejects(
    extractRecipe(options({ adapter })),
    (error) => error instanceof BridgeError && error.code === "NO_RECIPE",
  );
  assert.equal(calls, 1);
});

test("still reports the final INVALID_MODEL_OUTPUT after retries", async () => {
  let calls = 0;
  const adapter = fakeAdapter({
    extract: async () => {
      calls += 1;
      throw new BridgeError("INVALID_MODEL_OUTPUT", "The extractor returned invalid JSON.");
    },
  });

  await assert.rejects(
    extractRecipe(options({ adapter })),
    (error) => error instanceof BridgeError && error.code === "INVALID_MODEL_OUTPUT",
  );
  assert.equal(calls, 2);
});

test("waits before retrying a gateway failure", async () => {
  let calls = 0;
  const delays: number[] = [];
  const adapter = fakeAdapter({
    extract: async () => {
      calls += 1;
      if (calls === 1) {
        throw new BridgeError("EXTRACTOR_UNAVAILABLE", "The recipe extractor is starting.");
      }
      return structuredClone(RECIPE);
    },
  });

  const result = await extractRecipe(
    options({
      adapter,
      retryDelayMs: 20,
      onRetry: (_error, _attempt, delayMs) => delays.push(delayMs),
    }),
  );

  assert.equal(calls, 2);
  assert.deepEqual(delays, [20]);
  assert.equal(result.meta.attempts, 2);
});

test("does not delay model-quality retries", async () => {
  let calls = 0;
  const delays: number[] = [];
  const adapter = fakeAdapter({
    extract: async () => {
      calls += 1;
      if (calls === 1) {
        throw new BridgeError("INCOMPLETE_RECIPE", "The extractor returned a recipe without cooking instructions.");
      }
      return structuredClone(RECIPE);
    },
  });

  await extractRecipe(
    options({
      adapter,
      retryDelayMs: 60_000,
      onRetry: (_error, _attempt, delayMs) => delays.push(delayMs),
    }),
  );

  assert.equal(calls, 2);
  assert.deepEqual(delays, [0]);
});

test("reports EXTRACTOR_UNAVAILABLE after retries are exhausted", async () => {
  const adapter = fakeAdapter({
    extract: async () => {
      throw new BridgeError("EXTRACTOR_UNAVAILABLE", "The recipe extractor is starting.");
    },
  });

  await assert.rejects(
    extractRecipe(options({ adapter, retryDelayMs: 0 })),
    (error) =>
      error instanceof BridgeError &&
      error.code === "EXTRACTOR_UNAVAILABLE" &&
      error.retryable,
  );
});
