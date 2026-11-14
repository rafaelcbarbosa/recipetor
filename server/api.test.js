import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

    const otherList = await (await request(baseUrl, "/api/recipes", { token: other.token })).json();
    assert.equal(otherList.recipes.find((item) => item.id === ownerRecipe.recipe.id).canDelete, false);

    const adminList = await (await request(baseUrl, "/api/recipes", { token: admin.token })).json();
    assert.equal(adminList.recipes.find((item) => item.id === ownerRecipe.recipe.id).canDelete, true);
    assert.equal(adminList.recipes.find((item) => item.id === legacy.recipe.id).canDelete, true);

    const anonymousList = await (await request(baseUrl, "/api/recipes")).json();
    assert.equal(anonymousList.recipes.find((item) => item.id === ownerRecipe.recipe.id).canDelete, false);

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

test("public queue hides urls and creators while reporting positions", async () => {
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
      assert.equal("url" in job, false);
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
    assert.equal("url" in status.job, false);
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
    assert.deepEqual(firstFavorites.favorites, [jobs[0].recipeId]);
    assert.deepEqual(secondFavorites.favorites, [jobs[0].recipeId]);
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
