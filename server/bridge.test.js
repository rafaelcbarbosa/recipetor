import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createBridgeExtractor, isBridgeAvailable } from "./bridge.js";

const recipe = {
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
  ],
  instructions: ["Boil the pasta.", "Toss with lemon and butter."],
  totals: { calories: 219, protein: 7, carbs: 14, fat: 15 },
};

async function startMock(handler) {
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let body = null;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      body = null;
    }
    await handler(request, response, body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopMock(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

function sendJson(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

test("posts the URL with the bridge token and validates the recipe", async () => {
  let seen;
  const { server, baseUrl } = await startMock((request, response, body) => {
    seen = { url: request.url, authorization: request.headers.authorization, body };
    sendJson(response, 200, { recipe, meta: { backend: "hermes" } });
  });

  try {
    const extract = createBridgeExtractor({ baseUrl, token: "secret", timeoutMs: 5000 });
    const result = await extract("https://www.instagram.com/reel/ABC/");

    assert.equal(seen.url, "/v1/extract");
    assert.equal(seen.authorization, "Bearer secret");
    assert.deepEqual(seen.body, { url: "https://www.instagram.com/reel/ABC/" });
    assert.equal(result.title, recipe.title);
    assert.deepEqual(result.steps, recipe.instructions);
    assert.equal(result.emoji, "🍽️");
    assert.equal(result.color, "lemon");
  } finally {
    await stopMock(server);
  }
});

test("maps bridge error codes to friendly messages", async () => {
  const cases = [
    ["NO_RECIPE", 422, /No recipe found in this post/],
    ["POST_INACCESSIBLE", 422, /private or unavailable/],
    ["MODEL_TIMEOUT", 504, /timed out/],
    ["MODEL_ERROR", 502, /failed/],
    ["INVALID_MODEL_OUTPUT", 502, /invalid result/],
  ];

  for (const [code, status, messagePattern] of cases) {
    const { server, baseUrl } = await startMock((request, response) => {
      sendJson(response, status, {
        error: { code, message: "raw bridge detail", retryable: false },
      });
    });

    try {
      const extract = createBridgeExtractor({ baseUrl, token: "secret", timeoutMs: 5000 });
      await assert.rejects(
        extract("https://www.instagram.com/reel/ABC/"),
        (error) => messagePattern.test(error.message) && error.code === code,
      );
    } finally {
      await stopMock(server);
    }
  }
});

test("rejects an invalid bridge response", async () => {
  const { server, baseUrl } = await startMock((request, response) => {
    sendJson(response, 200, { meta: { backend: "hermes" } });
  });

  try {
    const extract = createBridgeExtractor({ baseUrl, token: "secret", timeoutMs: 5000 });
    await assert.rejects(
      extract("https://www.instagram.com/reel/ABC/"),
      /invalid response/,
    );
  } finally {
    await stopMock(server);
  }
});

test("rejects an invalid recipe returned by the bridge", async () => {
  const { server, baseUrl } = await startMock((request, response) => {
    sendJson(response, 200, { recipe: { ...recipe, ingredients: [] } });
  });

  try {
    const extract = createBridgeExtractor({ baseUrl, token: "secret", timeoutMs: 5000 });
    await assert.rejects(
      extract("https://www.instagram.com/reel/ABC/"),
      /invalid ingredient list/,
    );
  } finally {
    await stopMock(server);
  }
});

test("rejects a recipe with no instructions", async () => {
  const { server, baseUrl } = await startMock((request, response) => {
    sendJson(response, 200, { recipe: { ...recipe, instructions: [] } });
  });

  try {
    const extract = createBridgeExtractor({ baseUrl, token: "secret", timeoutMs: 5000 });
    await assert.rejects(
      extract("https://www.instagram.com/reel/ABC/"),
      /invalid cooking instructions/,
    );
  } finally {
    await stopMock(server);
  }
});

test("normalizes all-zero totals to null", async () => {
  const { server, baseUrl } = await startMock((request, response) => {
    sendJson(response, 200, {
      recipe: { ...recipe, totals: { calories: 0, protein: 0, carbs: 0, fat: 0 } },
    });
  });

  try {
    const extract = createBridgeExtractor({ baseUrl, token: "secret", timeoutMs: 5000 });
    const result = await extract("https://www.instagram.com/reel/ABC/");
    assert.equal(result.totals, null);
  } finally {
    await stopMock(server);
  }
});

test("normalizes all-null totals to null", async () => {
  const { server, baseUrl } = await startMock((request, response) => {
    sendJson(response, 200, {
      recipe: { ...recipe, totals: { calories: null, protein: null, carbs: null, fat: null } },
    });
  });

  try {
    const extract = createBridgeExtractor({ baseUrl, token: "secret", timeoutMs: 5000 });
    const result = await extract("https://www.instagram.com/reel/ABC/");
    assert.equal(result.totals, null);
  } finally {
    await stopMock(server);
  }
});

test("times out when the bridge does not answer", async () => {
  const { server, baseUrl } = await startMock(() => {
    // Intentionally never respond.
  });

  try {
    const extract = createBridgeExtractor({ baseUrl, token: "secret", timeoutMs: 100 });
    await assert.rejects(
      extract("https://www.instagram.com/reel/ABC/"),
      /timed out/,
    );
  } finally {
    await stopMock(server);
  }
});

test("reports bridge availability from the health endpoint", async () => {
  const healthy = await startMock((request, response) => {
    sendJson(response, 200, { status: "ok", hermesAvailable: true });
  });
  try {
    assert.equal(await isBridgeAvailable({ baseUrl: healthy.baseUrl, token: "secret" }), true);
  } finally {
    await stopMock(healthy.server);
  }

  const degraded = await startMock((request, response) => {
    sendJson(response, 200, { status: "degraded", hermesAvailable: false });
  });
  try {
    assert.equal(await isBridgeAvailable({ baseUrl: degraded.baseUrl, token: "secret" }), false);
  } finally {
    await stopMock(degraded.server);
  }

  assert.equal(await isBridgeAvailable({ baseUrl: "http://127.0.0.1:1", token: "secret" }), false);
  assert.equal(await isBridgeAvailable({ baseUrl: "http://127.0.0.1:1", token: "" }), false);
});
