import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createServer } from "./index.js";
import { validateRecipeResult } from "./recipe-schema.js";
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
  const databasePath = join(directory, "recipes.sqlite");
  const store = createRecipeStore(databasePath, {
    generateCode: () => "123456",
    emailSender: async () => true,
  });
  return {
    store,
    databasePath,
    cleanup() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function startServer(store, options = {}) {
  const server = createServer({ store, extractorAvailable: () => true, ...options });
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

test("reports extractor health and backend", async () => {
  const { store, cleanup } = createTestStore();
  const { server, baseUrl } = await startServer(store, { extractorBackend: "script" });

  try {
    const response = await request(baseUrl, "/api/health");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.extractorAvailable, true);
    assert.equal(body.extractor.backend, "script");
  } finally {
    await stopServer(server);
    cleanup();
  }
});

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

test("only the original loader or the site owner can delete a recipe", async () => {
  const { store, cleanup } = createTestStore();
  const { server, baseUrl } = await startServer(store);

  try {
    const owner = await createVerifiedUser(baseUrl, "owner@example.com");
    const other = await createVerifiedUser(baseUrl, "other@example.com");
    const admin = await createVerifiedUser(baseUrl, "coxinha@gmail.com");

    function variant(title, ingredient) {
      return {
        ...recipe,
        title,
        ingredients: [
          { amount: 1, unit: "unit", name: ingredient, nutrition: { calories: 10, protein: 1, carbs: 1, fat: 0 } },
        ],
      };
    }

    const legacy = store.saveImported("https://www.instagram.com/p/LEGACY/", variant("Legacy soup", "legacy beans"));
    const ownerRecipe = store.saveImported(
      "https://www.instagram.com/p/OWNER/",
      variant("Owner pasta", "owner noodles"),
      owner.user.id,
    );
    const adminRecipe = store.saveImported(
      "https://www.instagram.com/p/ADMIN/",
      variant("Admin pie", "admin apples"),
      owner.user.id,
    );

    const anonymousDelete = await request(baseUrl, `/api/recipes/${ownerRecipe.recipe.id}`, { method: "DELETE" });
    assert.equal(anonymousDelete.status, 401);

    const otherDelete = await request(baseUrl, `/api/recipes/${ownerRecipe.recipe.id}`, {
      method: "DELETE",
      token: other.token,
    });
    assert.equal(otherDelete.status, 403);

    const legacyForOther = await request(baseUrl, `/api/recipes/${legacy.recipe.id}`, {
      method: "DELETE",
      token: other.token,
    });
    assert.equal(legacyForOther.status, 403);

    const ownerList = await (await request(baseUrl, "/api/recipes", { token: owner.token })).json();
    assert.equal(ownerList.recipes.find((item) => item.id === ownerRecipe.recipe.id).canDelete, true);
    assert.equal(ownerList.recipes.find((item) => item.id === legacy.recipe.id).canDelete, false);

    // New recipes default to Private: another family cannot see them at all.
    const otherList = await (await request(baseUrl, "/api/recipes", { token: other.token })).json();
    assert.equal(otherList.recipes.find((item) => item.id === ownerRecipe.recipe.id), undefined);
    assert.ok(otherList.recipes.find((item) => item.id === legacy.recipe.id));

    const adminList = await (await request(baseUrl, "/api/recipes", { token: admin.token })).json();
    assert.equal(adminList.recipes.find((item) => item.id === ownerRecipe.recipe.id).canDelete, true);
    assert.equal(adminList.recipes.find((item) => item.id === legacy.recipe.id).canDelete, true);

    const anonymousList = await (await request(baseUrl, "/api/recipes")).json();
    assert.equal(anonymousList.recipes.find((item) => item.id === ownerRecipe.recipe.id), undefined);
    assert.ok(anonymousList.recipes.find((item) => item.id === legacy.recipe.id));

    const ownerDelete = await request(baseUrl, `/api/recipes/${ownerRecipe.recipe.id}`, {
      method: "DELETE",
      token: owner.token,
    });
    assert.equal(ownerDelete.status, 200);

    const adminDelete = await request(baseUrl, `/api/recipes/${adminRecipe.recipe.id}`, {
      method: "DELETE",
      token: admin.token,
    });
    assert.equal(adminDelete.status, 200);

    const legacyAdminDelete = await request(baseUrl, `/api/recipes/${legacy.recipe.id}`, {
      method: "DELETE",
      token: admin.token,
    });
    assert.equal(legacyAdminDelete.status, 200);

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

test("ratings require auth, aggregate averages, and decorate recipes per user", async () => {
  const { store, cleanup } = createTestStore();
  const { server, baseUrl } = await startServer(store);
  const saved = store.saveImported("https://www.instagram.com/p/RATE/", recipe);

  try {
    const anonymous = await request(baseUrl, `/api/recipes/${saved.recipe.id}/rating`, {
      method: "PUT",
      body: { rating: 5 },
    });
    assert.equal(anonymous.status, 401);

    const first = await createVerifiedUser(baseUrl, "rater-a@example.com");
    const second = await createVerifiedUser(baseUrl, "rater-b@example.com");

    const firstRating = await request(baseUrl, `/api/recipes/${saved.recipe.id}/rating`, {
      method: "PUT",
      token: first.token,
      body: { rating: 5 },
    });
    assert.equal(firstRating.status, 200);
    assert.deepEqual(await firstRating.json(), { ratingAvg: 5, ratingCount: 1, myRating: 5 });

    const secondRating = await request(baseUrl, `/api/recipes/${saved.recipe.id}/rating`, {
      method: "PUT",
      token: second.token,
      body: { rating: 2 },
    });
    assert.equal(secondRating.status, 200);
    assert.deepEqual(await secondRating.json(), { ratingAvg: 3.5, ratingCount: 2, myRating: 2 });

    const decorated = await (
      await request(baseUrl, `/api/recipes/${saved.recipe.id}`, { token: first.token })
    ).json();
    assert.equal(decorated.recipe.ratingAvg, 3.5);
    assert.equal(decorated.recipe.ratingCount, 2);
    assert.equal(decorated.recipe.myRating, 5);

    const invalid = await request(baseUrl, `/api/recipes/${saved.recipe.id}/rating`, {
      method: "PUT",
      token: first.token,
      body: { rating: 6 },
    });
    assert.equal(invalid.status, 400);

    const removed = await request(baseUrl, `/api/recipes/${saved.recipe.id}/rating`, {
      method: "DELETE",
      token: first.token,
    });
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { ok: true, ratingAvg: 2, ratingCount: 1, myRating: null });

    const missing = await request(baseUrl, "/api/recipes/does-not-exist/rating", {
      method: "PUT",
      token: first.token,
      body: { rating: 4 },
    });
    assert.equal(missing.status, 404);
  } finally {
    await stopServer(server);
    cleanup();
  }
});

test("public queue reports positions and hides creators", async () => {
  const { store, cleanup } = createTestStore();
  const { server, baseUrl } = await startServer(store);

  try {
    const first = await createVerifiedUser(baseUrl, "queue-a@example.com");
    const second = await createVerifiedUser(baseUrl, "queue-b@example.com");
    const firstJob = store.createExtractionJob("https://www.instagram.com/p/AAA/", first.user.id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const secondJob = store.createExtractionJob("https://www.instagram.com/reel/BBB/", second.user.id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const anonymousJob = store.createExtractionJob("https://www.instagram.com/p/CCC/", null);

    const anonymousQueue = await (await request(baseUrl, "/api/recipes/import/queue")).json();
    assert.equal(anonymousQueue.jobs.length, 3);
    for (const job of anonymousQueue.jobs) {
      assert.equal(typeof job.url, "string");
      assert.match(job.url, /instagram\.com/);
      assert.equal("createdBy" in job, false);
      assert.equal(job.isMine, false);
      assert.match(job.shortUrl, /instagram\.com/);
    }
    assert.deepEqual(
      anonymousQueue.jobs.map((job) => job.position),
      [1, 2, 3],
    );

    const signedInQueue = await (
      await request(baseUrl, "/api/recipes/import/queue", { token: first.token })
    ).json();
    const mine = signedInQueue.jobs.find((job) => job.id === firstJob.id);
    const other = signedInQueue.jobs.find((job) => job.id === secondJob.id);
    const unowned = signedInQueue.jobs.find((job) => job.id === anonymousJob.id);
    assert.equal(mine.isMine, true);
    assert.equal(mine.canRetry, true);
    assert.equal(other.isMine, false);
    assert.equal(other.canRetry, false);
    assert.equal(unowned.isMine, false);
    assert.equal(unowned.canRetry, true);

    const status = await (
      await request(baseUrl, `/api/recipes/import/status/${secondJob.id}`, { token: first.token })
    ).json();
    assert.equal(typeof status.job.url, "string");
    assert.equal(status.job.position, 2);
    assert.equal(status.job.isMine, false);

    store.updateExtractionJob(firstJob.id, { status: "completed", stage: "completed", progress: 100 });
    const afterCompletion = await (
      await request(baseUrl, "/api/recipes/import/queue", { token: first.token })
    ).json();
    assert.equal(afterCompletion.jobs.find((job) => job.id === secondJob.id).position, 1);
    assert.equal(afterCompletion.jobs.find((job) => job.id === anonymousJob.id).position, 2);
  } finally {
    await stopServer(server);
    cleanup();
  }
});

test("failed imports can be retried by their owner or watchers", async () => {
  const { store, cleanup } = createTestStore();
  const { server, baseUrl } = await startServer(store, { extractRecipe: async () => recipe });

  try {
    const owner = await createVerifiedUser(baseUrl, "retry-owner@example.com");
    const other = await createVerifiedUser(baseUrl, "retry-other@example.com");
    const watcher = await createVerifiedUser(baseUrl, "retry-watcher@example.com");
    const job = store.createExtractionJob("https://www.instagram.com/p/RETRY/", owner.user.id);
    store.updateExtractionJob(job.id, {
      status: "failed",
      stage: "failed",
      progress: 100,
      errorMessage: "Extraction failed: nope",
    });
    store.addJobWatcher(job.id, watcher.user.id);

    const anonymous = await request(baseUrl, `/api/recipes/import/retry/${job.id}`, { method: "POST" });
    assert.equal(anonymous.status, 401);

    const forbidden = await request(baseUrl, `/api/recipes/import/retry/${job.id}`, {
      method: "POST",
      token: other.token,
    });
    assert.equal(forbidden.status, 403);

    const watcherRetry = await request(baseUrl, `/api/recipes/import/retry/${job.id}`, {
      method: "POST",
      token: watcher.token,
    });
    assert.equal(watcherRetry.status, 202);
    const watcherBody = await watcherRetry.json();
    assert.equal(watcherBody.job.isMine, true);
    assert.equal(store.isJobWatcher(watcherBody.job.id, owner.user.id), true);

    const pendingJob = store.createExtractionJob("https://www.instagram.com/p/PENDING/", owner.user.id);
    const conflict = await request(baseUrl, `/api/recipes/import/retry/${pendingJob.id}`, {
      method: "POST",
      token: owner.token,
    });
    assert.equal(conflict.status, 409);

    const retried = await request(baseUrl, `/api/recipes/import/retry/${job.id}`, {
      method: "POST",
      token: owner.token,
    });
    assert.equal(retried.status, 202);
    const body = await retried.json();
    assert.equal(body.job.status, "pending");
    assert.equal(body.job.isMine, true);
    assert.equal(body.job.shortUrl, "instagram.com/p/RETRY");
    assert.equal("url" in body.job, false);
    assert.notEqual(body.job.id, job.id);

    const missing = await request(baseUrl, "/api/recipes/import/retry/does-not-exist", {
      method: "POST",
      token: owner.token,
    });
    assert.equal(missing.status, 404);
  } finally {
    await stopServer(server);
    cleanup();
  }
});


test("converts ingredient units and lets signed-in users add missing amounts", async () => {
  const { store, cleanup } = createTestStore();
  const { server, baseUrl } = await startServer(store);

  try {
    const owner = await createVerifiedUser(baseUrl, "units@example.com");
    const saved = store.saveImported(
      "https://www.instagram.com/p/UNITS/",
      {
        ...recipe,
        title: "Unit test soup",
        ingredients: [
          { amount: 1, unit: "lb", name: "chicken", nutrition: { calories: 500, protein: 100, carbs: 0, fat: 20 } },
          { amount: null, unit: "", name: "salt", nutrition: { calories: null, protein: null, carbs: null, fat: null } },
          { amount: 240, unit: "ml", name: "cream", nutrition: { calories: 800, protein: 5, carbs: 6, fat: 84 } },
        ],
      },
      owner.user.id,
    );

    const anonymous = await request(baseUrl, `/api/recipes/${saved.recipe.id}/ingredients/0`, {
      method: "PATCH",
      body: { unit: "g" },
    });
    assert.equal(anonymous.status, 401);

    const converted = await request(baseUrl, `/api/recipes/${saved.recipe.id}/ingredients/0`, {
      method: "PATCH",
      token: owner.token,
      body: { unit: "g" },
    });
    assert.equal(converted.status, 200);
    const convertedRecipe = (await converted.json()).recipe;
    assert.equal(convertedRecipe.ingredients[0].unit, "g");
    assert.ok(Math.abs(convertedRecipe.ingredients[0].amount - 453.59237) < 0.01);
    assert.equal(convertedRecipe.ingredients[0].nutrition.calories, 500);

    const incompatible = await request(baseUrl, `/api/recipes/${saved.recipe.id}/ingredients/0`, {
      method: "PATCH",
      token: owner.token,
      body: { unit: "ml" },
    });
    assert.equal(incompatible.status, 400);

    const cup = await request(baseUrl, `/api/recipes/${saved.recipe.id}/ingredients/2`, {
      method: "PATCH",
      token: owner.token,
      body: { unit: "cup" },
    });
    assert.equal(cup.status, 200);
    const cupRecipe = (await cup.json()).recipe;
    assert.equal(cupRecipe.ingredients[2].unit, "cup");
    assert.ok(Math.abs(cupRecipe.ingredients[2].amount - 1.014420681) < 0.001);
    assert.equal(cupRecipe.ingredients[2].nutrition.calories, 800);

    const added = await request(baseUrl, `/api/recipes/${saved.recipe.id}/ingredients/1`, {
      method: "PATCH",
      token: owner.token,
      body: { amount: 2, unit: "pinch" },
    });
    assert.equal(added.status, 200);
    const addedRecipe = (await added.json()).recipe;
    assert.equal(addedRecipe.ingredients[1].amount, 2);
    assert.equal(addedRecipe.ingredients[1].unit, "pinch");

    const invalidAmount = await request(baseUrl, `/api/recipes/${saved.recipe.id}/ingredients/1`, {
      method: "PATCH",
      token: owner.token,
      body: { amount: -1 },
    });
    assert.equal(invalidAmount.status, 400);

    const invalidUnit = await request(baseUrl, `/api/recipes/${saved.recipe.id}/ingredients/1`, {
      method: "PATCH",
      token: owner.token,
      body: { unit: "x".repeat(31) },
    });
    assert.equal(invalidUnit.status, 400);

    const missingIndex = await request(baseUrl, `/api/recipes/${saved.recipe.id}/ingredients/99`, {
      method: "PATCH",
      token: owner.token,
      body: { amount: 1 },
    });
    assert.equal(missingIndex.status, 400);

    const noChanges = await request(baseUrl, `/api/recipes/${saved.recipe.id}/ingredients/1`, {
      method: "PATCH",
      token: owner.token,
      body: {},
    });
    assert.equal(noChanges.status, 400);
  } finally {
    await stopServer(server);
    cleanup();
  }
});

test("re-importing an existing link favorites it for the new user", async () => {
  const { store, cleanup } = createTestStore();
  const { server, baseUrl } = await startServer(store);

  try {
    const first = await createVerifiedUser(baseUrl, "first-source@example.com");
    const second = await createVerifiedUser(baseUrl, "second-source@example.com");
    const url = "https://www.instagram.com/p/SOURCE/";
    const saved = store.saveImported(url, recipe, first.user.id);
    store.setRecipeVisibility(saved.recipe.id, "public", [], first.user.id, false);
    const completedJob = store.createExtractionJob(url, first.user.id);
    store.updateExtractionJob(completedJob.id, {
      status: "completed",
      stage: "completed",
      progress: 100,
      recipeId: saved.recipe.id,
    });

    const response = await request(baseUrl, "/api/recipes/import", {
      method: "POST",
      token: second.token,
      body: { url },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.reason, "source");
    assert.equal(body.recipe.id, saved.recipe.id);
    assert.equal(body.recipe.isFavorite, true);
    assert.equal(store.isJobWatcher(completedJob.id, second.user.id), true);
    assert.equal(store.getExtractionJobsByUrl(url).length, 1);

    const favorites = await (await request(baseUrl, "/api/favorites", { token: second.token })).json();
    assert.ok(favorites.favorites.includes(saved.recipe.id));
  } finally {
    await stopServer(server);
    cleanup();
  }
});

test("users who join an in-progress import get the finished recipe favorited", async () => {
  const { store, cleanup } = createTestStore();
  let releaseExtraction;
  const extractionGate = new Promise((resolve) => {
    releaseExtraction = resolve;
  });
  const { server, baseUrl } = await startServer(store, {
    extractRecipe: async () => {
      await extractionGate;
      return recipe;
    },
  });

  try {
    const first = await createVerifiedUser(baseUrl, "joined-first@example.com");
    const second = await createVerifiedUser(baseUrl, "joined-second@example.com");
    const url = "https://www.instagram.com/p/JOINED/";

    const firstImport = await request(baseUrl, "/api/recipes/import", {
      method: "POST",
      token: first.token,
      body: { url },
    });
    assert.equal(firstImport.status, 202);
    const firstJob = (await firstImport.json()).job;

    const secondImport = await request(baseUrl, "/api/recipes/import", {
      method: "POST",
      token: second.token,
      body: { url },
    });
    assert.equal(secondImport.status, 200);
    const secondJob = (await secondImport.json()).job;
    assert.equal(secondJob.id, firstJob.id);
    assert.equal(secondJob.isMine, true);

    releaseExtraction();
    const jobs = await waitForJobs(store, 1);
    assert.ok(jobs[0].recipeId);

    const firstFavorites = await (await request(baseUrl, "/api/favorites", { token: first.token })).json();
    const secondFavorites = await (await request(baseUrl, "/api/favorites", { token: second.token })).json();
    assert.equal(firstFavorites.favorites.length, 1);
    assert.equal(secondFavorites.favorites.length, 1);
    // Each family gets their own private copy, so the ids differ.
    assert.notEqual(firstFavorites.favorites[0], secondFavorites.favorites[0]);
  } finally {
    await stopServer(server);
    cleanup();
  }
});

test("serves extracted thumbnails from the media directory", async () => {
  const { store, cleanup } = createTestStore();
  const mediaDir = mkdtempSync(join(tmpdir(), "recipetor-media-"));
  const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  writeFileSync(join(mediaDir, "thumb.jpg"), image);
  const { server, baseUrl } = await startServer(store, { mediaDir });

  try {
    const response = await fetch(`${baseUrl}/media/thumb.jpg`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/jpeg");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), image);

    const missing = await fetch(`${baseUrl}/media/nope.jpg`);
    assert.equal(missing.status, 404);

    const traversal = await fetch(`${baseUrl}/media/..%2Fsecret.jpg`);
    assert.equal(traversal.status, 404);
  } finally {
    await stopServer(server);
    cleanup();
    rmSync(mediaDir, { recursive: true, force: true });
  }
});

test("records live extractor progress and stage labels on queued jobs", async () => {
  const { store, cleanup } = createTestStore();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { server, baseUrl } = await startServer(store, {
    extractRecipe: async (_url, { onProgress } = {}) => {
      onProgress?.({ stage: "fetching", progress: 14, label: "Fetching post metadata (yt-dlp)" });
      onProgress?.({ stage: "extracting", progress: 57, label: "Reading on-screen text (tesseract: por+eng)" });
      await gate;
      onProgress?.({ stage: "saving", progress: 95, label: "Validating recipe JSON" });
      return recipe;
    },
  });

  try {
    const user = await createVerifiedUser(baseUrl, "progress@example.com");
    const response = await request(baseUrl, "/api/recipes/import", {
      method: "POST",
      token: user.token,
      body: { url: "https://www.instagram.com/p/PROGRESS/" },
    });
    assert.equal(response.status, 202);
    const job = (await response.json()).job;

    let queued;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const body = await (await request(baseUrl, "/api/recipes/import/queue", { token: user.token })).json();
      queued = body.jobs.find((item) => item.id === job.id);
      if (queued?.stageLabel === "Reading on-screen text (tesseract: por+eng)") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(queued.stage, "extracting");
    assert.equal(queued.progress, 57);
    assert.equal(queued.stageLabel, "Reading on-screen text (tesseract: por+eng)");

    release();
    await waitForJobs(store, 1);
    const finished = store.getExtractionJob(job.id);
    assert.equal(finished.status, "completed");
    assert.equal(finished.stageLabel, null);
    assert.ok(finished.recipeId);
  } finally {
    release?.();
    await stopServer(server);
    cleanup();
  }
});

test("serves thumbnails from a relative media directory", async () => {
  const { store, cleanup } = createTestStore();
  const relativeDir = `.tmp-media-${process.pid}-${Date.now()}`;
  mkdirSync(relativeDir, { recursive: true });
  const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  writeFileSync(join(relativeDir, "thumb.jpg"), image);
  const { server, baseUrl } = await startServer(store, { mediaDir: relativeDir });

  try {
    const response = await fetch(`${baseUrl}/media/thumb.jpg`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/jpeg");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), image);
  } finally {
    await stopServer(server);
    cleanup();
    rmSync(relativeDir, { recursive: true, force: true });
  }
});

test("asks before retrying a recently failed link", async () => {
  const { store, cleanup } = createTestStore();
  const { server, baseUrl } = await startServer(store);

  try {
    const user = await createVerifiedUser(baseUrl, "failed-link@example.com");
    const url = "https://www.instagram.com/p/FAILED-ONCE/";
    const job = store.createExtractionJob(url, user.user.id);
    store.updateExtractionJob(job.id, {
      status: "failed",
      stage: "failed",
      progress: 100,
      errorMessage: "Extraction failed: nope",
    });

    const response = await request(baseUrl, "/api/recipes/import", {
      method: "POST",
      token: user.token,
      body: { url },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.alreadyFailed, true);
    assert.match(body.message, /tried before/);
    assert.equal(body.job.id, job.id);
    assert.equal(body.job.isMine, true);
    assert.equal(store.getExtractionJobsByUrl(url).length, 1);
    assert.equal(store.isJobWatcher(job.id, user.user.id), true);
  } finally {
    await stopServer(server);
    cleanup();
  }
});

test("creates a new job when the previous failure is older than 24h", async () => {
  const { store, databasePath, cleanup } = createTestStore();
  const { server, baseUrl } = await startServer(store);

  try {
    const user = await createVerifiedUser(baseUrl, "failed-old@example.com");
    const url = "https://www.instagram.com/p/FAILED-OLD/";
    const job = store.createExtractionJob(url, user.user.id);
    store.updateExtractionJob(job.id, {
      status: "failed",
      stage: "failed",
      progress: 100,
      errorMessage: "Extraction failed: old",
    });
    const db = new DatabaseSync(databasePath);
    db.prepare("UPDATE extraction_jobs SET updated_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), job.id);
    db.close();

    const response = await request(baseUrl, "/api/recipes/import", {
      method: "POST",
      token: user.token,
      body: { url },
    });
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.ok(body.job.id);
    assert.notEqual(body.job.id, job.id);
    assert.equal(store.getExtractionJobsByUrl(url).length, 2);
  } finally {
    await stopServer(server);
    cleanup();
  }
});

test("manual entry saves a recipe, attaches the failed link, and favorites watchers", async () => {
  const { store, cleanup } = createTestStore();
  const { server, baseUrl } = await startServer(store);

  try {
    const owner = await createVerifiedUser(baseUrl, "manual-owner@example.com");
    const watcher = await createVerifiedUser(baseUrl, "manual-watcher@example.com");
    const url = "https://www.instagram.com/p/MANUAL/";
    const job = store.createExtractionJob(url, owner.user.id);
    store.updateExtractionJob(job.id, {
      status: "failed",
      stage: "failed",
      progress: 100,
      errorMessage: "Extraction failed: nope",
    });
    store.addJobWatcher(job.id, watcher.user.id);

    const manualRecipe = {
      title: "Manual dish",
      description: "",
      category: "Dinner",
      cuisine: "Italian",
      prepTimeMinutes: 10,
      basePortions: 2,
      ingredients: [
        { amount: 100, unit: "g", name: "flour", nutrition: { calories: 364, protein: 10, carbs: 76, fat: 1 } },
      ],
      instructions: ["Mix it."],
      totals: null,
    };

    const response = await request(baseUrl, "/api/recipes/manual", {
      method: "POST",
      token: owner.token,
      body: { jobId: job.id, recipe: manualRecipe },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.recipe.id);
    assert.equal(body.job.recipeId, body.recipe.id);
    assert.equal(store.getRecipeOwner(body.recipe.id), owner.user.id);
    assert.ok(store.listFavorites(owner.user.id).includes(body.recipe.id));
    assert.equal(store.listFavorites(watcher.user.id).length, 1);
    assert.notEqual(store.listFavorites(watcher.user.id)[0], body.recipe.id);
    assert.ok(!store.listPublicExtractionJobs(owner.user.id).some((item) => item.id === job.id));

    // Once the owner publishes, a re-import can resolve to the same recipe.
    store.setRecipeVisibility(body.recipe.id, "public", [], owner.user.id, false);
    const reimport = await request(baseUrl, "/api/recipes/import", {
      method: "POST",
      token: watcher.token,
      body: { url },
    });
    assert.equal(reimport.status, 200);
    const reimportBody = await reimport.json();
    assert.equal(reimportBody.reason, "source");
    assert.equal(reimportBody.recipe.id, body.recipe.id);
    assert.equal(reimportBody.recipe.isFavorite, true);

    const anonymous = await request(baseUrl, "/api/recipes/manual", {
      method: "POST",
      body: { jobId: job.id, recipe: manualRecipe },
    });
    assert.equal(anonymous.status, 401);
  } finally {
    await stopServer(server);
    cleanup();
  }
});

test("serves the telemetry page and data only to the admin account", async () => {
  const { store, cleanup } = createTestStore();
  const { server, baseUrl } = await startServer(store);

  try {
    const page = await fetch(`${baseUrl}/telemetry`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Recipetor telemetry/);

    const anonymous = await request(baseUrl, "/api/telemetry");
    assert.equal(anonymous.status, 401);

    const regular = await createVerifiedUser(baseUrl, "regular-telemetry@example.com");
    const forbidden = await request(baseUrl, "/api/telemetry", { token: regular.token });
    assert.equal(forbidden.status, 401);

    const admin = await createVerifiedUser(baseUrl, "coxinha@gmail.com");
    const response = await request(baseUrl, "/api/telemetry", { token: admin.token });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status.ok, true);
    assert.equal(typeof body.recipes.total, "number");
    assert.ok(Array.isArray(body.recipes.byCategory));
    assert.ok(Array.isArray(body.users.top));
    assert.ok(Array.isArray(body.access.latest));
    assert.ok(Array.isArray(body.users.registered));
    assert.ok(body.users.registered.some((user) => user.email === "coxinha@gmail.com"));
    assert.equal(body.eventRetentionDays, 90);
  } finally {
    await stopServer(server);
    cleanup();
  }
});

test("records recipe views, app opens, and favorites for telemetry", async () => {
  const { store, cleanup } = createTestStore();
  const { server, baseUrl } = await startServer(store);

  try {
    const saved = store.saveImported("https://www.instagram.com/p/VIEWED/", recipe);
    const user = await createVerifiedUser(baseUrl, "viewer@example.com");

    const view = await request(baseUrl, "/api/events/recipe-view", {
      method: "POST",
      token: user.token,
      body: { recipeId: saved.recipe.id },
    });
    assert.equal(view.status, 200);
    const appOpen = await request(baseUrl, "/api/events/app-open", { method: "POST", token: user.token });
    assert.equal(appOpen.status, 200);
    const favorite = await request(baseUrl, "/api/favorites", {
      method: "POST",
      token: user.token,
      body: { recipeId: saved.recipe.id },
    });
    assert.equal(favorite.status, 200);

    const admin = await createVerifiedUser(baseUrl, "coxinha@gmail.com");
    const body = await (await request(baseUrl, "/api/telemetry", { token: admin.token })).json();

    assert.ok(body.access.latest.some((event) => event.event === "recipe_view" && event.recipe === recipe.title));
    assert.ok(body.access.latest.some((event) => event.event === "app_open"));
    assert.ok(body.access.topViewed.some((entry) => entry.title === recipe.title && entry.views === 1));
    const viewer = body.users.top.find((entry) => entry.email === "viewer@example.com");
    assert.ok(viewer);
    assert.ok(viewer.recipeViews >= 1);
    assert.ok(body.favorites.total >= 1);
  } finally {
    await stopServer(server);
    cleanup();
  }
});

test("reports average extraction time from completed jobs", async () => {
  const { store, cleanup } = createTestStore();
  const { server, baseUrl } = await startServer(store);

  try {
    const admin = await createVerifiedUser(baseUrl, "coxinha@gmail.com");
    const started = new Date(Date.now() - 10_000).toISOString();
    const job = store.createExtractionJob("https://www.instagram.com/p/TIMED/", admin.user.id);
    store.updateExtractionJob(job.id, {
      status: "completed",
      stage: "completed",
      progress: 100,
      startedAt: started,
    });

    const body = await (await request(baseUrl, "/api/telemetry", { token: admin.token })).json();
    assert.equal(body.extraction.completed, 1);
    assert.ok(body.extraction.averageMs >= 9000 && body.extraction.averageMs <= 12000);
    assert.ok(body.extraction.recent[0].durationMs >= 9000);
  } finally {
    await stopServer(server);
    cleanup();
  }
});

test("admin can clear finished queue history without deleting recipes", async () => {
  const { store, cleanup } = createTestStore();
  const { server, baseUrl } = await startServer(store);

  try {
    const user = await createVerifiedUser(baseUrl, "clear-user@example.com");
    const admin = await createVerifiedUser(baseUrl, "coxinha@gmail.com");
    const saved = store.saveImported("https://www.instagram.com/p/CLEAR/", recipe);

    const active = store.createExtractionJob("https://www.instagram.com/p/ACTIVE-CLEAR/", user.user.id);
    const completed = store.createExtractionJob("https://www.instagram.com/p/DONE-CLEAR/", user.user.id);
    store.updateExtractionJob(completed.id, {
      status: "completed",
      stage: "completed",
      progress: 100,
      recipeId: saved.recipe.id,
    });
    const failed = store.createExtractionJob("https://www.instagram.com/p/FAIL-CLEAR/", user.user.id);
    store.updateExtractionJob(failed.id, { status: "failed", stage: "failed", progress: 100 });

    const forbidden = await request(baseUrl, "/api/telemetry/clear-queue", {
      method: "POST",
      token: user.token,
    });
    assert.equal(forbidden.status, 401);

    const response = await request(baseUrl, "/api/telemetry/clear-queue", {
      method: "POST",
      token: admin.token,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { removed: 2 });

    assert.ok(store.getExtractionJob(active.id));
    assert.equal(store.getExtractionJob(completed.id), null);
    assert.equal(store.getExtractionJob(failed.id), null);
    assert.ok(store.getRecipe(saved.recipe.id));
  } finally {
    await stopServer(server);
    cleanup();
  }
});

test("keeps the screenshot on a failed extraction", async () => {
  const { store, cleanup } = createTestStore();
  const failure = new Error("No complete recipe found in this post.");
  failure.thumbnailUrl = "/media/failed-thumb.jpg";
  const { server, baseUrl } = await startServer(store, {
    extractRecipe: async () => {
      throw failure;
    },
  });

  try {
    const user = await createVerifiedUser(baseUrl, "failed-thumb@example.com");
    const response = await request(baseUrl, "/api/recipes/import", {
      method: "POST",
      token: user.token,
      body: { url: "https://www.instagram.com/p/FAIL-THUMB/" },
    });
    assert.equal(response.status, 202);
    const job = (await response.json()).job;

    await waitForJobs(store, 1);
    const finished = store.getExtractionJob(job.id);
    assert.equal(finished.status, "failed");
    assert.equal(finished.thumbnailUrl, "/media/failed-thumb.jpg");

    const publicJob = store.getPublicExtractionJob(job.id, user.user.id);
    assert.equal(publicJob.thumbnailUrl, "/media/failed-thumb.jpg");
    assert.equal(publicJob.url, "https://www.instagram.com/p/FAIL-THUMB/");
  } finally {
    await stopServer(server);
    cleanup();
  }
});

test("keeps extraction logs for successful and failed jobs and serves them to the admin", async () => {
  const { store, cleanup } = createTestStore();
  const failure = new Error("No complete recipe found in this post.");
  failure.logs = "[extract] no recipe in caption";
  const { server, baseUrl } = await startServer(store, {
    extractRecipe: async (url) => {
      if (url.includes("FAIL")) throw failure;
      return { ...recipe, extractorLogs: "[extract] parsed 2 ingredients" };
    },
  });

  try {
    const user = await createVerifiedUser(baseUrl, "logs-user@example.com");
    const admin = await createVerifiedUser(baseUrl, "coxinha@gmail.com");

    const ok = await request(baseUrl, "/api/recipes/import", {
      method: "POST",
      token: user.token,
      body: { url: "https://www.instagram.com/p/LOG-OK/" },
    });
    assert.equal(ok.status, 202);
    const okJobId = (await ok.json()).job.id;

    const fail = await request(baseUrl, "/api/recipes/import", {
      method: "POST",
      token: user.token,
      body: { url: "https://www.instagram.com/p/LOG-FAIL/" },
    });
    assert.equal(fail.status, 202);
    const failJobId = (await fail.json()).job.id;

    await waitForJobs(store, 2);
    assert.equal(store.getExtractionLogs(okJobId), "[extract] parsed 2 ingredients");
    assert.equal(store.getExtractionLogs(failJobId), "[extract] no recipe in caption");

    const telemetry = await (
      await request(baseUrl, "/api/telemetry", { token: admin.token })
    ).json();
    const okRow = telemetry.extraction.recent.find((row) => row.id === okJobId);
    const failRow = telemetry.extraction.recent.find((row) => row.id === failJobId);
    assert.equal(okRow.hasLogs, true);
    assert.equal(failRow.hasLogs, true);
    assert.match(failRow.errorMessage, /No complete recipe found/);

    const anonymous = await request(baseUrl, `/api/telemetry/extraction/${okJobId}/logs`);
    assert.equal(anonymous.status, 401);
    const forbidden = await request(baseUrl, `/api/telemetry/extraction/${okJobId}/logs`, {
      token: user.token,
    });
    assert.equal(forbidden.status, 401);

    const logsResponse = await request(baseUrl, `/api/telemetry/extraction/${failJobId}/logs`, {
      token: admin.token,
    });
    assert.equal(logsResponse.status, 200);
    assert.deepEqual(await logsResponse.json(), {
      id: failJobId,
      logs: "[extract] no recipe in caption",
    });

    const missing = await request(baseUrl, "/api/telemetry/extraction/missing/logs", {
      token: admin.token,
    });
    assert.equal(missing.status, 404);
  } finally {
    await stopServer(server);
    cleanup();
  }
});

test("queues pasted recipe text and normalizes it through the backlog", async () => {
  const { store, cleanup } = createTestStore();
  let receivedText = "";
  const { server, baseUrl } = await startServer(store, {
    normalizeRecipe: async (text) => {
      receivedText = text;
      // normalizeRecipeText validates and returns this shape.
      return validateRecipeResult({
        title: "Normalized Recipe",
        description: "",
        category: "Dinner",
        cuisine: "",
        mealTypes: ["Dinner"],
        dietTags: [],
        prepTimeMinutes: 20,
        basePortions: 2,
        ingredients: recipe.ingredients,
        instructions: recipe.steps,
        totals: recipe.totals,
      });
    },
  });

  try {
    const anonymous = await request(baseUrl, "/api/recipes/import/text", {
      method: "POST",
      body: { text: "Ingredients: 2 cups flour" },
    });
    assert.equal(anonymous.status, 401);

    const user = await createVerifiedUser(baseUrl, "text-queue@example.com");
    const empty = await request(baseUrl, "/api/recipes/import/text", {
      method: "POST",
      token: user.token,
      body: { text: "   " },
    });
    assert.equal(empty.status, 400);

    const response = await request(baseUrl, "/api/recipes/import/text", {
      method: "POST",
      token: user.token,
      body: { text: "Ingredients\n- 2 cups flour\n\nSteps\n1. Mix and rest" },
    });
    assert.equal(response.status, 202);
    const queued = await response.json();
    assert.equal(queued.job.kind, "text");
    assert.equal(queued.job.shortUrl, "Pasted recipe");
    assert.match(receivedText, /Mix and rest/);

    const jobs = await waitForJobs(store, 1);
    assert.equal(jobs[0].status, "completed");
    assert.equal(jobs[0].recipeId, queued.job.recipeId ?? jobs[0].recipeId);
    assert.match(store.getExtractionLogs(jobs[0].id) ?? "", /normalized successfully/);

    // Same text returns the saved recipe instead of re-running the AI.
    const again = await request(baseUrl, "/api/recipes/import/text", {
      method: "POST",
      token: user.token,
      body: { text: "Ingredients\n- 2 cups flour\n\nSteps\n1. Mix and rest" },
    });
    assert.equal(again.status, 200);
    const saved = await again.json();
    assert.equal(saved.duplicate, true);
    assert.equal(saved.recipe.title, "Normalized Recipe");
    assert.deepEqual(saved.recipe.sourceUrls, []);
  } finally {
    await stopServer(server);
    cleanup();
  }
});

test("accepts the real normalizer output shape (steps, no instructions)", async () => {
  const { store, cleanup } = createTestStore();
  const { server, baseUrl } = await startServer(store, {
    normalizeRecipe: async () => {
      // normalizeRecipeText already validates and returns this exact shape.
      return validateRecipeResult({
        title: "Real Shape Recipe",
        description: "",
        category: "Dinner",
        cuisine: "",
        mealTypes: ["Dinner"],
        dietTags: [],
        prepTimeMinutes: null,
        basePortions: 2,
        ingredients: recipe.ingredients,
        instructions: recipe.steps,
        totals: recipe.totals,
      });
    },
  });

  try {
    const user = await createVerifiedUser(baseUrl, "text-shape@example.com");
    const response = await request(baseUrl, "/api/recipes/import/text", {
      method: "POST",
      token: user.token,
      body: { text: "Ingredients: 2 cups flour" },
    });
    assert.equal(response.status, 202);
    const jobs = await waitForJobs(store, 1);
    assert.equal(jobs[0].status, "completed");
    const library = await request(baseUrl, "/api/recipes", { token: user.token });
    const { recipes: libraryRecipes } = await library.json();
    assert.ok(libraryRecipes.some((item) => item.title === "Real Shape Recipe"));
  } finally {
    await stopServer(server);
    cleanup();
  }
});

test("retries a transient normalization failure and records each attempt", async () => {
  const { store, cleanup } = createTestStore();
  let attempts = 0;
  const { server, baseUrl } = await startServer(store, {
    normalizeRecipe: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("The recipe extractor returned invalid cooking instructions.");
      }
      return validateRecipeResult({
        title: "Retry Recipe",
        description: "",
        category: "Dinner",
        cuisine: "",
        mealTypes: ["Dinner"],
        dietTags: [],
        prepTimeMinutes: null,
        basePortions: 2,
        ingredients: recipe.ingredients,
        instructions: recipe.steps,
        totals: recipe.totals,
      });
    },
  });

  try {
    const user = await createVerifiedUser(baseUrl, "text-retry@example.com");
    const response = await request(baseUrl, "/api/recipes/import/text", {
      method: "POST",
      token: user.token,
      body: { text: "Ingredients: 2 cups flour" },
    });
    assert.equal(response.status, 202);
    const jobs = await waitForJobs(store, 1);
    assert.equal(jobs[0].status, "completed");
    assert.equal(attempts, 2);
    const logs = store.getExtractionLogs(jobs[0].id) ?? "";
    assert.match(logs, /attempt 1 failed: The recipe extractor returned invalid cooking instructions/);
    assert.match(logs, /normalized successfully/);
  } finally {
    await stopServer(server);
    cleanup();
  }
});

test("does not retry a permanent normalization verdict", async () => {
  const { store, cleanup } = createTestStore();
  let attempts = 0;
  const { server, baseUrl } = await startServer(store, {
    normalizeRecipe: async () => {
      attempts += 1;
      throw new Error("That text doesn't look like a complete recipe.");
    },
  });

  try {
    const user = await createVerifiedUser(baseUrl, "text-noretry@example.com");
    const response = await request(baseUrl, "/api/recipes/import/text", {
      method: "POST",
      token: user.token,
      body: { text: "just an ingredient list" },
    });
    assert.equal(response.status, 202);
    const jobs = await waitForJobs(store, 1);
    assert.equal(jobs[0].status, "failed");
    assert.equal(attempts, 1);
    const logs = store.getExtractionLogs(jobs[0].id) ?? "";
    assert.match(logs, /attempt 1 failed/);
    assert.match(logs, /not retrying/);
  } finally {
    await stopServer(server);
    cleanup();
  }
});

test("failed text normalization stays in the backlog and can be retried", async () => {
  const { store, cleanup } = createTestStore();
  let attempts = 0;
  const { server, baseUrl } = await startServer(store, {
    normalizeRecipe: async () => {
      attempts += 1;
      throw new Error("That text doesn't look like a complete recipe.");
    },
  });

  try {
    const user = await createVerifiedUser(baseUrl, "text-fail@example.com");
    const first = await request(baseUrl, "/api/recipes/import/text", {
      method: "POST",
      token: user.token,
      body: { text: "only an ingredient list, no steps" },
    });
    assert.equal(first.status, 202);
    await waitForJobs(store, 1);

    // The failed row is visible as a text job and resubmitting asks to retry.
    const jobs = store.listPublicExtractionJobs();
    const failed = jobs.find((job) => job.status === "failed");
    assert.ok(failed);
    assert.equal(failed.kind, "text");
    assert.match(failed.errorMessage ?? "", /complete recipe/);

    const resubmit = await request(baseUrl, "/api/recipes/import/text", {
      method: "POST",
      token: user.token,
      body: { text: "only an ingredient list, no steps" },
    });
    assert.equal(resubmit.status, 200);
    const body = await resubmit.json();
    assert.equal(body.alreadyFailed, true);
    assert.equal(body.job.kind, "text");

    assert.equal(attempts, 1);
  } finally {
    await stopServer(server);
    cleanup();
  }
});

test("only the recipe owner can edit recipe fields, steps, and links", async () => {
  const { store, cleanup } = createTestStore();
  const { server, baseUrl } = await startServer(store);

  try {
    const signedUp = await createVerifiedUser(baseUrl, "edit-owner@example.com");
    const owner = store.getUserByEmail("edit-owner@example.com");
    store.saveImported("https://www.instagram.com/p/EDITTEST1/", recipe, owner.id);
    const original = store.getBySource("https://www.instagram.com/p/EDITTEST1/", owner.id, false);
    assert.ok(original);
    const recipeId = original.id;

    const editor = await createVerifiedUser(baseUrl, "edit-editor@example.com");

    const anonymous = await request(baseUrl, `/api/recipes/${recipeId}`, {
      method: "PATCH",
      body: { title: "New title" },
    });
    assert.equal(anonymous.status, 401);

    const forbidden = await request(baseUrl, `/api/recipes/${recipeId}`, {
      method: "PATCH",
      token: editor.token,
      body: { title: "Edited by another user." },
    });
    assert.equal(forbidden.status, 403);

    const patched = await request(baseUrl, `/api/recipes/${recipeId}`, {
      method: "PATCH",
      token: signedUp.token,
      body: {
        title: "Edited Lemon Pasta",
        description: "Edited by the owner.",
        steps: ["Boil water.", "Cook pasta.", "Toss with lemon."],
        prepTimeMinutes: 30,
        basePortions: 2,
      },
    });
    assert.equal(patched.status, 200);
    const patchedBody = await patched.json();
    assert.equal(patchedBody.recipe.title, "Edited Lemon Pasta");
    assert.equal(patchedBody.recipe.steps.length, 3);
    assert.deepEqual(patchedBody.recipe.sourceUrls, ["https://www.instagram.com/p/EDITTEST1/"]);

    // The title change keeps the source-based dedupe intact.
    assert.ok(store.getBySource("https://www.instagram.com/p/EDITTEST1/", owner.id, false));

    const invalid = await request(baseUrl, `/api/recipes/${recipeId}`, {
      method: "PATCH",
      token: signedUp.token,
      body: { steps: [] },
    });
    assert.equal(invalid.status, 400);

    // Replace links.
    const linked = await request(baseUrl, `/api/recipes/${recipeId}`, {
      method: "PATCH",
      token: signedUp.token,
      body: { sourceUrls: ["https://www.instagram.com/p/EDITTEST2/"] },
    });
    assert.equal(linked.status, 200);
    assert.deepEqual((await linked.json()).recipe.sourceUrls, ["https://www.instagram.com/p/EDITTEST2/"]);

    // Remove all links.
    const unlinked = await request(baseUrl, `/api/recipes/${recipeId}`, {
      method: "PATCH",
      token: signedUp.token,
      body: { sourceUrls: [] },
    });
    assert.equal(unlinked.status, 200);
    assert.deepEqual((await unlinked.json()).recipe.sourceUrls, []);
  } finally {
    await stopServer(server);
    cleanup();
  }
});

test("editing rejects links already attached to another recipe", async () => {
  const { store, cleanup } = createTestStore();
  const { server, baseUrl } = await startServer(store);

  try {
    const owner = await createVerifiedUser(baseUrl, "dup-owner@example.com");
    store.saveImported("https://www.instagram.com/p/DUPLINK1/", recipe, owner.user.id);
    store.saveImported("https://www.instagram.com/p/DUPLINK2/", { ...recipe, title: "Second Dish" }, owner.user.id);
    const first = store.getBySource("https://www.instagram.com/p/DUPLINK1/", owner.user.id, false);
    const second = store.getBySource("https://www.instagram.com/p/DUPLINK2/", owner.user.id, false);

    const editor = await createVerifiedUser(baseUrl, "dup-editor@example.com");
    const forbidden = await request(baseUrl, `/api/recipes/${first.id}`, {
      method: "PATCH",
      token: editor.token,
      body: { sourceUrls: ["https://www.instagram.com/p/DUPLINK2/"] },
    });
    assert.equal(forbidden.status, 403);

    const conflict = await request(baseUrl, `/api/recipes/${first.id}`, {
      method: "PATCH",
      token: owner.token,
      body: { sourceUrls: ["https://www.instagram.com/p/DUPLINK2/"] },
    });
    assert.equal(conflict.status, 400);
    assert.match((await conflict.json()).error, /already belongs/);

    // Non-Instagram links are rejected.
    const bad = await request(baseUrl, `/api/recipes/${first.id}`, {
      method: "PATCH",
      token: owner.token,
      body: { sourceUrls: ["https://example.com/post/123/"] },
    });
    assert.equal(bad.status, 400);
    void second;
  } finally {
    await stopServer(server);
    cleanup();
  }
});

test("uploads and removes a recipe image", async () => {
  const { store, cleanup } = createTestStore();
  const mediaDir = mkdtempSync(join(tmpdir(), "recipetor-media-"));
  const { server, baseUrl } = await startServer(store, { mediaDir });

  try {
    const ownerSignup = await createVerifiedUser(baseUrl, "img-owner@example.com");
    const owner = store.getUserByEmail("img-owner@example.com");
    store.saveImported("https://www.instagram.com/p/IMGTEST1/", recipe, owner.id);
    const target = store.getBySource("https://www.instagram.com/p/IMGTEST1/", owner.id, false);

    const editor = await createVerifiedUser(baseUrl, "img-editor@example.com");

    const anonymous = await fetch(`${baseUrl}/api/recipes/${target.id}/image`, {
      method: "POST",
      headers: { "Content-Type": "image/png", Origin: baseUrl },
      body: Buffer.from([1, 2, 3, 4]),
    });
    assert.equal(anonymous.status, 401);

    const png = Buffer.from(
      "89504e470d0a1a0a0000000d494844520000000100000001080600000" +
        "01f15c4890000000d4944415478da63fcffff3f030005fe02fea72d" +
        "67250000000049454e44ae426082",
      "hex",
    );
    const upload = await fetch(`${baseUrl}/api/recipes/${target.id}/image`, {
      method: "POST",
      headers: { "Content-Type": "image/png", Origin: baseUrl, Authorization: `Bearer ${ownerSignup.token}` },
      body: png,
    });
    assert.equal(upload.status, 200);
    const uploaded = await upload.json();
    assert.match(uploaded.recipe.imageUrl, /\/media\/.+\.png$/);
    const filename = uploaded.recipe.imageUrl.replace("/media/", "");
    assert.ok(existsSync(join(mediaDir, filename)));

    const served = await fetch(`${baseUrl}${uploaded.recipe.imageUrl}`);
    assert.equal(served.status, 200);

    const wrongType = await fetch(`${baseUrl}/api/recipes/${target.id}/image`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", Origin: baseUrl, Authorization: `Bearer ${ownerSignup.token}` },
      body: "nope",
    });
    assert.equal(wrongType.status, 415);

    const removed = await request(baseUrl, `/api/recipes/${target.id}`, {
      method: "PATCH",
      token: ownerSignup.token,
      body: { imageUrl: null },
    });
    assert.equal(removed.status, 200);
    assert.equal((await removed.json()).recipe.imageUrl, null);
  } finally {
    await stopServer(server);
    cleanup();
    rmSync(mediaDir, { recursive: true, force: true });
  }
});

test("records anonymous accesses with device metadata and reports traffic", async () => {
  const { store, cleanup } = createTestStore();
  const { server, baseUrl } = await startServer(store);

  try {
    const load = await fetch(`${baseUrl}/api/events/app-open`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: baseUrl,
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
      },
    });
    assert.equal(load.status, 200);

    const desktopLoad = await fetch(`${baseUrl}/api/events/app-open`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: baseUrl,
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Firefox",
      },
    });
    assert.equal(desktopLoad.status, 200);

    const search = await request(baseUrl, "/api/events/search", {
      method: "POST",
      body: { term: "pudim" },
    });
    assert.equal(search.status, 200);

    const user = await createVerifiedUser(baseUrl, "traffic@example.com");
    await request(baseUrl, "/api/events/app-open", { method: "POST", token: user.token });

    const admin = await createVerifiedUser(baseUrl, "coxinha@gmail.com");
    const telemetry = await (await request(baseUrl, "/api/telemetry", { token: admin.token })).json();
    assert.ok(telemetry.traffic.appOpensAll >= 3);
    assert.equal(telemetry.traffic.anonymousShare > 0, true);
    const devices = Object.fromEntries(telemetry.traffic.byDevice.map((row) => [row.label, row.count]));
    assert.equal(devices.mobile, 1);
    assert.equal(devices.desktop, 2);
    assert.ok(telemetry.access.topSearches.some((row) => row.term === "pudim"));

    // Anonymous accesses show up in the latest-access list without a user.
    const anonymousRow = telemetry.access.latest.find(
      (row) => row.event === "app_open" && row.user === null,
    );
    assert.ok(anonymousRow);
    assert.ok(anonymousRow.meta.includes("device"));
  } finally {
    await stopServer(server);
    cleanup();
  }
});
