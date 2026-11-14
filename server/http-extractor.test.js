import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHttpExtractor, isHttpExtractorAvailable } from "./http-extractor.js";

const recipe = {
  title: "Remote recipe",
  description: "A test.",
  category: "Dinner",
  cuisine: "Italian",
  mealTypes: ["Dinner"],
  dietTags: [],
  prepTimeMinutes: 10,
  basePortions: 2,
  ingredients: [
    { amount: 100, unit: "g", name: "test ingredient", nutrition: { calories: 50, protein: 1, carbs: 2, fat: 3 } },
  ],
  instructions: ["Do the thing."],
  totals: { calories: 25, protein: 0.5, carbs: 1, fat: 1.5 },
};

function sendJson(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

async function startMock(handler) {
  const server = createServer(handler);
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

test("polls a remote job, reports progress, and stores the thumbnail", async () => {
  const mediaDir = mkdtempSync(join(tmpdir(), "recipetor-http-media-"));
  let polls = 0;
  let postedBody = null;
  let postedToken = null;
  const { server, baseUrl } = await startMock((request, response) => {
    if (request.url === "/healthz") {
      return sendJson(response, 200, { status: "ok", token_configured: true });
    }
    if (request.url === "/jobs" && request.method === "POST") {
      postedToken = request.headers["x-api-token"];
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        postedBody = JSON.parse(body);
        sendJson(response, 202, { job_id: "job-1" });
      });
      return;
    }
    if (request.url === "/jobs/job-1") {
      polls += 1;
      if (polls === 1) {
        return sendJson(response, 200, {
          job_id: "job-1",
          status: "processing",
          stage: "fetching",
          progress: 14,
          label: "Fetching post metadata (yt-dlp)",
          recipe: null,
          error: null,
          thumbnail_id: null,
        });
      }
      return sendJson(response, 200, {
        job_id: "job-1",
        status: "done",
        stage: "completed",
        progress: 100,
        label: null,
        recipe,
        error: null,
        thumbnail_id: "thumb-1",
      });
    }
    if (request.url === "/thumbnails/thumb-1.jpg") {
      response.writeHead(200, { "Content-Type": "image/jpeg" });
      response.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      return;
    }
    sendJson(response, 404, { detail: "not found" });
  });

  try {
    const extract = createHttpExtractor({
      baseUrl,
      token: "secret",
      mediaDir,
      pollIntervalMs: 10,
      timeoutMs: 5000,
    });
    const progress = [];
    const result = await extract("https://www.instagram.com/p/REMOTE/", {
      onProgress: (event) => progress.push(event),
    });

    assert.equal(result.title, "Remote recipe");
    assert.equal(result.imageUrl, "/media/thumb-1.jpg");
    assert.deepEqual(postedBody, {
      url: "https://www.instagram.com/p/REMOTE/",
      compute_nutrition: true,
    });
    assert.equal(postedToken, "secret");
    assert.deepEqual(progress, [
      { stage: "fetching", progress: 14, label: "Fetching post metadata (yt-dlp)" },
    ]);
    assert.ok(existsSync(join(mediaDir, "thumb-1.jpg")));
    assert.deepEqual([...readFileSync(join(mediaDir, "thumb-1.jpg"))], [0xff, 0xd8, 0xff, 0xd9]);
    assert.equal(await isHttpExtractorAvailable({ baseUrl, token: "secret" }), true);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
    rmSync(mediaDir, { recursive: true, force: true });
  }
});

test("maps remote job errors to friendly messages", async () => {
  const { server, baseUrl } = await startMock((request, response) => {
    if (request.url === "/jobs" && request.method === "POST") {
      request.resume();
      request.on("end", () => sendJson(response, 202, { job_id: "job-2" }));
      return;
    }
    if (request.url === "/jobs/job-2") {
      return sendJson(response, 200, {
        job_id: "job-2",
        status: "error",
        stage: "failed",
        progress: 100,
        label: null,
        recipe: null,
        error: "It is only a teaser.",
        error_code: "NO_RECIPE",
        thumbnail_id: null,
      });
    }
    sendJson(response, 404, { detail: "not found" });
  });

  try {
    const extract = createHttpExtractor({
      baseUrl,
      token: "secret",
      mediaDir: join(tmpdir(), "unused"),
      pollIntervalMs: 10,
      timeoutMs: 5000,
    });
    await assert.rejects(
      () => extract("https://www.instagram.com/p/TEASER/"),
      /No complete recipe found in this post/,
    );
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});

test("reports remote extractor availability", async () => {
  const { server, baseUrl } = await startMock((request, response) => {
    if (request.url === "/healthz") {
      return sendJson(response, 200, { status: "ok", token_configured: true });
    }
    sendJson(response, 404, {});
  });

  try {
    assert.equal(await isHttpExtractorAvailable({ baseUrl, token: "secret" }), true);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }

  assert.equal(await isHttpExtractorAvailable({ baseUrl: "http://127.0.0.1:1", token: "secret" }), false);
});
