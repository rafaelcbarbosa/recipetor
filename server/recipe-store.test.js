import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { canonicalizeInstagramUrl, createServer } from "./index.js";
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
    { amount: 4, unit: "tbsp", name: "butter", nutrition: { calories: 407, protein: 0, carbs: 0, fat: 46 } },
    { amount: 0.5, unit: "cup", name: "parmesan", nutrition: { calories: 216, protein: 19, carbs: 2, fat: 14 } },
  ],
  steps: ["Boil the pasta.", "Toss with lemon, butter, and parmesan."],
  totals: { calories: 219, protein: 7, carbs: 14, fat: 15 },
};

function createTestStore() {
  const directory = mkdtempSync(join(tmpdir(), "recipetor-test-"));
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

test("migrates an older database schema on startup", () => {
  const directory = mkdtempSync(join(tmpdir(), "recipetor-old-schema-"));
  const databasePath = join(directory, "old.sqlite");
  const oldDb = new DatabaseSync(databasePath);
  oldDb.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      email_verified INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE recipes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      title_key TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      prep_time_minutes INTEGER,
      emoji TEXT NOT NULL,
      color TEXT NOT NULL,
      ingredients_json TEXT NOT NULL,
      steps_json TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE recipe_sources (
      url TEXT PRIMARY KEY,
      recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL
    );
  `);
  oldDb.close();

  const store = createRecipeStore(databasePath, {
    generateCode: () => "123456",
    emailSender: async () => true,
  });
  try {
    const saved = store.saveImported("https://www.instagram.com/p/OLD/", recipe);
    assert.equal(saved.duplicate, false);
    assert.equal(store.list().length, 1);

    const job = store.createExtractionJob("https://www.instagram.com/p/OLD-JOB/", null);
    assert.ok(job.id);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("canonicalizes public Instagram posts and rejects other hosts", () => {
  assert.equal(
    canonicalizeInstagramUrl("https://www.instagram.com/reel/ABC123/?igsh=tracking#comment"),
    "https://www.instagram.com/reel/ABC123/",
  );
  assert.throws(() => canonicalizeInstagramUrl("https://example.com/reel/ABC123/"), /Instagram/);
  assert.throws(() => canonicalizeInstagramUrl("http://instagram.com/p/ABC123/"), /Instagram/);
  assert.throws(() => canonicalizeInstagramUrl("https://instagram.com/stories/user/123/"), /Instagram/);
});

test("stores a recipe once and attaches matching recipes from another source", () => {
  const { store, cleanup } = createTestStore();
  try {
    const first = store.saveImported("https://www.instagram.com/p/ONE/", recipe);
    const second = store.saveImported("https://www.instagram.com/reel/TWO/", {
      ...recipe,
      ingredients: ["1 pound spaghetti", "1 lemon", "3 tbsp butter", "parmesan cheese"],
    });

    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(second.recipe.id, first.recipe.id);
    assert.equal(second.recipe.sourceCount, 2);
    assert.equal(store.list().length, 1);
  } finally {
    cleanup();
  }
});

test("favorites and logs an attached recipe once per user", () => {
  const { store, cleanup } = createTestStore();
  try {
    const firstUser = store.createUser("first@example.com", "secret1");
    const secondUser = store.createUser("second@example.com", "secret1");

    const first = store.saveImported("https://www.instagram.com/p/FIRST/", recipe, firstUser.id);
    const attached = store.saveImported("https://www.instagram.com/p/SECOND/", recipe, secondUser.id);
    store.saveImported("https://www.instagram.com/p/THIRD/", recipe, firstUser.id);

    assert.equal(attached.recipe.id, first.recipe.id);
    assert.deepEqual(store.listFavorites(firstUser.id), [first.recipe.id]);
    assert.deepEqual(store.listFavorites(secondUser.id), [first.recipe.id]);
    assert.equal(store.getUserHistory(firstUser.id).length, 1);
    assert.equal(store.getUserHistory(secondUser.id).length, 1);
  } finally {
    cleanup();
  }
});

test("imports via the API, returns saved recipes, and avoids repeated extractor calls", async () => {
  const { store, cleanup } = createTestStore();
  let extractionCount = 0;
  const server = createServer({
    store,
    extractorAvailable: () => true,
    extractRecipe: async () => {
      extractionCount += 1;
      return {
        ...recipe,
        ingredients: recipe.ingredients.map((item) => ({
          amount: item.amount,
          unit: item.unit,
          name: item.name,
          nutrition: item.nutrition,
        })),
        totals: recipe.totals,
      };
    },
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const first = await fetch(`${baseUrl}/api/recipes/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: JSON.stringify({ url: "https://instagram.com/p/ONE/?igsh=abc" }),
    });
    const firstBody = await first.json();
    assert.equal(first.status, 202);
    assert.ok(firstBody.job);
    assert.equal(firstBody.job.status, "pending");

    // Poll until completed
    await new Promise((r) => setTimeout(r, 100)); // Wait for background job to start
    let job = firstBody.job;
    while (job.status === "pending" || job.status === "processing") {
      await new Promise((r) => setTimeout(r, 50));
      const statusRes = await fetch(`${baseUrl}/api/recipes/import/status/${job.id}`);
      const statusBody = await statusRes.json();
      job = statusBody.job;
    }

    assert.equal(job.status, "completed");
    assert.ok(job.recipeId);
    const recipeId = job.recipeId;

    const recipeRes = await fetch(`${baseUrl}/api/recipes/${recipeId}`);
    const recipeBody = await recipeRes.json();
    assert.equal(recipeBody.recipe.title, recipe.title);

    // Second import of same URL should find the existing recipe
    const second = await fetch(`${baseUrl}/api/recipes/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: JSON.stringify({ url: "https://www.instagram.com/p/ONE/" }),
    });
    const secondBody = await second.json();
    assert.equal(second.status, 200);
    assert.ok(secondBody.recipe);
    assert.equal(secondBody.recipe.id, recipeId);
    assert.equal(secondBody.duplicate, true);

    const listResponse = await fetch(`${baseUrl}/api/recipes`);
    const listBody = await listResponse.json();
    assert.equal(listBody.recipes.length, 1);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    cleanup();
  }
});

test("returns the extraction failure reason from the import API", async () => {
  const { store, cleanup } = createTestStore();
  const server = createServer({
    store,
    extractorAvailable: () => true,
    extractRecipe: async () => {
      throw new Error("The recipe extractor timed out.");
    },
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${baseUrl}/api/recipes/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: JSON.stringify({ url: "https://instagram.com/p/timeout" }),
    });
    const body = await response.json();

    assert.equal(response.status, 202);
    assert.ok(body.job);
    assert.equal(body.job.status, "pending");

    // Poll until failed
    await new Promise((r) => setTimeout(r, 100)); // Wait for background job to start
    let job = body.job;
    while (job.status === "pending" || job.status === "processing") {
      await new Promise((r) => setTimeout(r, 50));
      const statusRes = await fetch(`${baseUrl}/api/recipes/import/status/${job.id}`);
      const statusBody = await statusRes.json();
      job = statusBody.job;
    }

    assert.equal(job.status, "failed");
    assert.match(job.errorMessage, /recipe extractor timed out/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    cleanup();
  }
});
