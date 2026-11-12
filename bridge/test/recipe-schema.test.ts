import assert from "node:assert/strict";
import test from "node:test";
import { BridgeError } from "../src/errors.ts";
import { validateRecipe } from "../src/recipe-schema.ts";
import { RECIPE } from "../test-support/helpers.ts";

test("validates and normalizes a complete recipe", () => {
  const recipe = validateRecipe(RECIPE);
  assert.equal(recipe.title, RECIPE.title);
  assert.equal(recipe.category, "Dinner");
  assert.equal(recipe.ingredients.length, 2);
  assert.deepEqual(recipe.instructions, RECIPE.instructions);
  assert.deepEqual(recipe.totals, RECIPE.totals);
});

test("normalizes unknown categories to Other", () => {
  const recipe = validateRecipe({ ...RECIPE, category: "Brunch" });
  assert.equal(recipe.category, "Other");
});

test("accepts missing optional nutrition and totals", () => {
  const recipe = validateRecipe({
    ...RECIPE,
    totals: undefined,
    ingredients: [{ amount: null, unit: "", name: "salt" }],
  });
  assert.equal(recipe.totals, null);
  assert.deepEqual(recipe.ingredients[0].nutrition, {
    calories: null,
    protein: null,
    carbs: null,
    fat: null,
  });
});

test("normalizes an all-null totals object to null", () => {
  const recipe = validateRecipe({
    ...RECIPE,
    totals: { calories: null, protein: null, carbs: null, fat: null },
  });
  assert.equal(recipe.totals, null);
});

test("normalizes an all-zero totals object to null", () => {
  const recipe = validateRecipe({
    ...RECIPE,
    totals: { calories: 0, protein: 0, carbs: 0, fat: 0 },
  });
  assert.equal(recipe.totals, null);
});

test("keeps totals when at least one value is known", () => {
  const recipe = validateRecipe({
    ...RECIPE,
    totals: { calories: 219, protein: null, carbs: null, fat: null },
  });
  assert.deepEqual(recipe.totals, { calories: 219, protein: null, carbs: null, fat: null });
});

test("rejects unusable recipes with INVALID_MODEL_OUTPUT", () => {
  const cases = [
    null,
    [],
    { ...RECIPE, title: "" },
    { ...RECIPE, ingredients: [] },
    { ...RECIPE, ingredients: [{ amount: -1, unit: "g", name: "flour" }] },
    { ...RECIPE, instructions: [1] },
    { ...RECIPE, prepTimeMinutes: 0 },
  ];
  for (const value of cases) {
    assert.throws(
      () => validateRecipe(value),
      (error) => error instanceof BridgeError && error.code === "INVALID_MODEL_OUTPUT",
    );
  }
});

test("marks a recipe without instructions as INCOMPLETE_RECIPE", () => {
  assert.throws(
    () => validateRecipe({ ...RECIPE, instructions: [] }),
    (error) =>
      error instanceof BridgeError && error.code === "INCOMPLETE_RECIPE" && error.retryable,
  );
});
