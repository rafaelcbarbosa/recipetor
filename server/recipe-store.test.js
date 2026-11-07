import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    { amount: 12, unit: "oz", name: "spaghetti" },
    { amount: 2, unit: "units", name: "lemons" },
    { amount: 4, unit: "tbsp", name: "butter" },
    { amount: 0.5, unit: "cup", name: "parmesan" },
  ],
  steps: ["Boil the pasta.", "Toss with lemon, butter, and parmesan."],
};

function createTestStore() {
  const directory = mkdtempSync(join(tmpdir(), "recipetor-test-"));
  const store = createRecipeStore(join(directory, "recipes.sqlite"));
  return {
    store,
    cleanup() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

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

test("imports via the API, returns saved recipes, and avoids repeated Hermes calls", async () => {
  const { store, cleanup } = createTestStore();
  let extractionCount = 0;
  const server = createServer({
    store,
    hermesAvailable: () => true,
    extractRecipe: async () => {
      extractionCount += 1;
      return {
        ...recipe,
        ingredients: recipe.ingredients.map((item) => ({
          amount: item.amount,
          unit: item.unit,
          name: item.name,
        })),
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
    assert.equal(first.status, 200);
    assert.equal(firstBody.recipe.title, recipe.title);
    assert.equal(firstBody.duplicate, false);

    const second = await fetch(`${baseUrl}/api/recipes/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: JSON.stringify({ url: "https://www.instagram.com/p/ONE/" }),
    });
    const secondBody = await second.json();
    assert.equal(second.status, 200);
    assert.equal(secondBody.duplicate, true);
    assert.equal(extractionCount, 1);

    const listResponse = await fetch(`${baseUrl}/api/recipes`);
    const listBody = await listResponse.json();
    assert.equal(listBody.recipes.length, 1);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    cleanup();
  }
});
