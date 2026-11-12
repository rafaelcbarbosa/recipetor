import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer } from "./index.js";
import { createRecipeStore } from "./recipe-store.js";

const recipe = {
  title: "Lemon Butter Pasta",
  description: "A bright lemon pasta.",
  category: "Dinner",
  prepTimeMinutes: 25,
  basePortions: 4,
  emoji: "🍽️",
  color: "lemon",
  ingredients: [
    { amount: 12, unit: "oz", name: "spaghetti", nutrition: { calories: 220, protein: 8, carbs: 43, fat: 1 } },
    { amount: 2, unit: "units", name: "lemons", nutrition: { calories: 34, protein: 1, carbs: 11, fat: 0 } },
  ],
  steps: ["Boil the pasta.", "Toss with lemon and butter."],
  totals: { calories: 219, protein: 7, carbs: 14, fat: 15 },
};

function createTestStore() {
  const directory = mkdtempSync(join(tmpdir(), "recipetor-api-"));
  const store = createRecipeStore(join(directory, "recipes.sqlite"), {
    generateCode: () => "123456",
    emailSender: async () => true,
  });
  return {
    store,
    cleanup() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function startServer(store, options = {}) {
  const server = createServer({ store, hermesAvailable: () => true, ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function stopServer(server) {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function request(baseUrl, path, { method = "GET", body, token } = {}) {
  const headers = { Origin: baseUrl };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createVerifiedUser(baseUrl, email) {
  const register = await request(baseUrl, "/api/auth/register", {
    method: "POST",
    body: { email, password: "secret1" },
  });
  assert.equal(register.status, 200);

  const verify = await request(baseUrl, "/api/auth/verify-email", {
    method: "POST",
    body: { email, code: "123456" },
  });
  assert.equal(verify.status, 200);

  const login = await request(baseUrl, "/api/auth/login", {
    method: "POST",
    body: { email, password: "secret1" },
  });
  assert.equal(login.status, 200);
  return login.json();
}

async function waitForJobs(store, expectedCount) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const jobs = store.listExtractionJobs();
    if (
      jobs.length >= expectedCount &&
      jobs.every((job) => job.status === "completed" || job.status === "failed")
    ) {
      return jobs;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for extraction jobs.");
}

test("registers, requires email verification, then logs in", async () => {
  const { store, cleanup } = createTestStore();
  const { server, baseUrl } = await startServer(store);

  try {
    const register = await request(baseUrl, "/api/auth/register", {
      method: "POST",
      body: { email: "cook@example.com", password: "secret1" },
    });
    assert.equal(register.status, 200);
    const registered = await register.json();
    assert.equal(registered.requiresVerification, true);

    const blockedLogin = await request(baseUrl, "/api/auth/login", {
      method: "POST",
      body: { email: "cook@example.com", password: "secret1" },
    });
    assert.equal(blockedLogin.status, 401);
    assert.equal((await blockedLogin.json()).requiresVerification, true);

    const verify = await request(baseUrl, "/api/auth/verify-email", {
      method: "POST",
      body: { email: "cook@example.com", code: "123456" },
    });
    assert.equal(verify.status, 200);

    const login = await request(baseUrl, "/api/auth/login", {
      method: "POST",
      body: { email: "cook@example.com", password: "secret1" },
    });
    assert.equal(login.status, 200);
    const { token, user } = await login.json();
    assert.ok(token);

    const me = await request(baseUrl, "/api/auth/me", { token });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.id, user.id);
  } finally {
    await stopServer(server);
    cleanup();
  }
});

test("favorites and history require auth and work for a signed-in user", async () => {
  const { store, cleanup } = createTestStore();
  const { server, baseUrl } = await startServer(store);
  const saved = store.saveImported("https://www.instagram.com/p/FAV/", recipe);

  try {
    const anonymousFavorite = await request(baseUrl, "/api/favorites", {
      method: "POST",
      body: { recipeId: saved.recipe.id },
    });
    assert.equal(anonymousFavorite.status, 401);

    const { token } = await createVerifiedUser(baseUrl, "favorite@example.com");

    const addFavorite = await request(baseUrl, "/api/favorites", {
      method: "POST",
      token,
      body: { recipeId: saved.recipe.id },
    });
    assert.equal(addFavorite.status, 200);
    assert.equal((await addFavorite.json()).added, true);

    const favorites = await request(baseUrl, "/api/favorites", { token });
    assert.deepEqual((await favorites.json()).favorites, [saved.recipe.id]);

    const removeFavorite = await request(baseUrl, `/api/favorites/${saved.recipe.id}`, {
      method: "DELETE",
      token,
    });
    assert.equal(removeFavorite.status, 200);
    assert.deepEqual((await (await request(baseUrl, "/api/favorites", { token })).json()).favorites, []);

    const anonymousHistory = await request(baseUrl, "/api/history", {
      method: "POST",
      body: { recipeId: saved.recipe.id },
    });
    assert.equal(anonymousHistory.status, 401);

    const addHistory = await request(baseUrl, "/api/history", {
      method: "POST",
      token,
      body: { recipeId: saved.recipe.id, action: "added" },
    });
    assert.equal(addHistory.status, 200);

    const history = await (await request(baseUrl, "/api/history", { token })).json();
    assert.equal(history.history.length, 1);
    assert.equal(history.history[0].id, saved.recipe.id);
  } finally {
    await stopServer(server);
    cleanup();
  }
});

test("deleting a recipe requires auth and ownership", async () => {
  const { store, cleanup } = createTestStore();
  const { server, baseUrl } = await startServer(store);

  try {
    const owner = await createVerifiedUser(baseUrl, "owner@example.com");
    const other = await createVerifiedUser(baseUrl, "other@example.com");
    const saved = store.saveImported("https://www.instagram.com/p/DELETE/", recipe, owner.user.id);

    const anonymousDelete = await request(baseUrl, `/api/recipes/${saved.recipe.id}`, { method: "DELETE" });
    assert.equal(anonymousDelete.status, 401);

    const otherDelete = await request(baseUrl, `/api/recipes/${saved.recipe.id}`, {
      method: "DELETE",
      token: other.token,
    });
    assert.equal(otherDelete.status, 403);

    const ownerDelete = await request(baseUrl, `/api/recipes/${saved.recipe.id}`, {
      method: "DELETE",
      token: owner.token,
    });
    assert.equal(ownerDelete.status, 200);
    assert.equal(store.list().length, 0);
  } finally {
    await stopServer(server);
    cleanup();
  }
});

test("limits new imports per client connection", async () => {
  const { store, cleanup } = createTestStore();
  const { server, baseUrl } = await startServer(store, {
    extractRecipe: async () => recipe,
    now: () => 1_000_000,
  });

  try {
    for (let index = 0; index < 10; index += 1) {
      const response = await request(baseUrl, "/api/recipes/import", {
        method: "POST",
        body: { url: `https://www.instagram.com/p/LIMIT${index}/` },
      });
      assert.equal(response.status, 202);
    }

    const limited = await request(baseUrl, "/api/recipes/import", {
      method: "POST",
      body: { url: "https://www.instagram.com/p/LIMIT10/" },
    });
    assert.equal(limited.status, 429);

    const jobs = await waitForJobs(store, 10);
    assert.equal(jobs.length, 10);
  } finally {
    await stopServer(server);
    cleanup();
  }
});

test("recovers pending extraction jobs when the server starts", async () => {
  const { store, cleanup } = createTestStore();
  const job = store.createExtractionJob("https://www.instagram.com/p/RECOVER/", null);
  const { server } = await startServer(store, { extractRecipe: async () => recipe });

  try {
    await waitForJobs(store, 1);
    const recovered = store.getExtractionJob(job.id);
    assert.equal(recovered.status, "completed");
    assert.ok(recovered.recipeId);
  } finally {
    await stopServer(server);
    cleanup();
  }
});
