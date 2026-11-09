import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const PREPARATION_WORDS = new Set([
  "chopped", "diced", "minced", "sliced", "crushed", "grated", "shredded",
  "fresh", "large", "small", "medium", "finely", "roughly", "divided",
  "optional", "drained", "rinsed", "dried", "softened", "melted",
]);
const UNITS = new Set([
  "cup", "cups", "tablespoon", "tablespoons", "tbsp", "teaspoon", "teaspoons",
  "tsp", "ounce", "ounces", "oz", "pound", "pounds", "lb", "lbs", "gram",
  "grams", "g", "kilogram", "kg", "milliliter", "milliliters", "ml", "liter",
  "liters", "l", "pinch", "pinches", "clove", "cloves", "can", "cans",
  "package", "packages", "pkg", "slice", "slices", "piece", "pieces",
]);

function normalizeText(value) {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeIngredient(value) {
  const text = typeof value === "string" ? value : value.name;
  const words = normalizeText(text.replace(/[¼½¾⅓⅔⅛⅜⅝⅞]/g, " "))
    .replace(/^\d+(?:\s+\d+\/\d+|[/.]\d+)?\s*/, "")
    .split(" ")
    .filter((word) => word && !UNITS.has(word) && !PREPARATION_WORDS.has(word));
  return words
    .map((word) => word.length > 4 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word)
    .join(" ");
}

function ingredientSimilarity(left, right) {
  const a = new Set(left.map(normalizeIngredient).filter(Boolean).flatMap((name) => name.split(" ")));
  const b = new Set(right.map(normalizeIngredient).filter(Boolean).flatMap((name) => name.split(" ")));
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = [...a].filter((ingredient) => b.has(ingredient)).length;
  return intersection / new Set([...a, ...b]).size;
}

function fingerprint(titleKey, ingredients) {
  const names = ingredients.map(normalizeIngredient).filter(Boolean).sort();
  return createHash("sha256").update(`${titleKey}\n${names.join("\n")}`).digest("hex");
}

function toRecipe(row, sourceRows) {
  const sourceUrls = sourceRows.map((source) => source.url);
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    prepTimeMinutes: row.prep_time_minutes,
    basePortions: row.base_portions,
    time: row.prep_time_minutes ? `${row.prep_time_minutes} min` : "Time varies",
    emoji: row.emoji,
    color: row.color,
    ingredients: JSON.parse(row.ingredients_json),
    steps: JSON.parse(row.steps_json),
    totals: row.totals_json ? JSON.parse(row.totals_json) : null,
    source: sourceUrls.length > 1 ? `${sourceUrls.length} Instagram sources` : "Instagram",
    sourceUrls,
    sourceCount: sourceUrls.length,
    isExample: false,
  };
}

export function createRecipeStore(databasePath = "./data/recipetor.sqlite") {
  const path = databasePath === ":memory:" ? databasePath : resolve(databasePath);
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS recipes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      title_key TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      prep_time_minutes INTEGER,
      base_portions INTEGER,
      emoji TEXT NOT NULL,
      color TEXT NOT NULL,
      ingredients_json TEXT NOT NULL,
      steps_json TEXT NOT NULL,
      totals_json TEXT,
      fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS recipes_title_key_idx ON recipes(title_key);
    CREATE TABLE IF NOT EXISTS recipe_sources (
      url TEXT PRIMARY KEY,
      recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS recipe_sources_recipe_id_idx ON recipe_sources(recipe_id);
  `);

  const recipeById = db.prepare("SELECT * FROM recipes WHERE id = ?");
  const sourcesByRecipe = db.prepare(
    "SELECT url FROM recipe_sources WHERE recipe_id = ? ORDER BY created_at ASC",
  );

  function getRecipe(id) {
    const row = recipeById.get(id);
    if (!row) return null;
    return toRecipe(row, sourcesByRecipe.all(id));
  }

  function getBySource(url) {
    const source = db.prepare("SELECT recipe_id FROM recipe_sources WHERE url = ?").get(url);
    return source ? getRecipe(source.recipe_id) : null;
  }

  function list() {
    return db
      .prepare("SELECT id FROM recipes ORDER BY updated_at DESC, title COLLATE NOCASE ASC")
      .all()
      .map(({ id }) => getRecipe(id));
  }

  function deleteRecipe(id) {
    const existing = getRecipe(id);
    if (!existing) return false;

    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM recipe_sources WHERE recipe_id = ?").run(id);
      db.prepare("DELETE FROM recipes WHERE id = ?").run(id);
      db.exec("COMMIT");
      return true;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function computeTotalsFromIngredients(ingredients, basePortions) {
    const totals = { calories: 0, protein: 0, carbs: 0, fat: 0 };
    let hasAny = false;
    for (const ing of ingredients) {
      if (ing.nutrition) {
        if (ing.nutrition.calories != null) { totals.calories += ing.nutrition.calories; hasAny = true; }
        if (ing.nutrition.protein != null) { totals.protein += ing.nutrition.protein; hasAny = true; }
        if (ing.nutrition.carbs != null) { totals.carbs += ing.nutrition.carbs; hasAny = true; }
        if (ing.nutrition.fat != null) { totals.fat += ing.nutrition.fat; hasAny = true; }
      }
    }
    if (!hasAny) return null;
    const portions = basePortions ?? 1;
    totals.calories = Math.round(totals.calories / portions);
    totals.protein = Math.round(totals.protein / portions);
    totals.carbs = Math.round(totals.carbs / portions);
    totals.fat = Math.round(totals.fat / portions);
    return totals;
  }

  function saveImported(url, recipe) {
    const titleKey = normalizeText(recipe.title);
    const recipeFingerprint = fingerprint(titleKey, recipe.ingredients);
    const now = new Date().toISOString();

    db.exec("BEGIN IMMEDIATE");
    try {
      const source = db.prepare("SELECT recipe_id FROM recipe_sources WHERE url = ?").get(url);
      if (source) {
        const existing = getRecipe(source.recipe_id);
        db.exec("COMMIT");
        return { recipe: existing, duplicate: true, reason: "source" };
      }

      const candidates = db
        .prepare("SELECT * FROM recipes WHERE title_key = ? ORDER BY updated_at DESC LIMIT 50")
        .all(titleKey);
      const match = candidates.find(
        (candidate) =>
          candidate.fingerprint === recipeFingerprint ||
          ingredientSimilarity(JSON.parse(candidate.ingredients_json), recipe.ingredients) >= 0.65,
      );

      if (match) {
        db.prepare("INSERT INTO recipe_sources (url, recipe_id, created_at) VALUES (?, ?, ?)")
          .run(url, match.id, now);
        db.prepare("UPDATE recipes SET updated_at = ? WHERE id = ?").run(now, match.id);
        const saved = getRecipe(match.id);
        db.exec("COMMIT");
        return { recipe: saved, duplicate: true, reason: "recipe" };
      }

      const id = randomUUID();
      const computedTotals = recipe.totals ? recipe.totals : computeTotalsFromIngredients(recipe.ingredients, recipe.basePortions);
      db.prepare(`
        INSERT INTO recipes (
          id, title, title_key, description, category, prep_time_minutes, base_portions, emoji, color,
          ingredients_json, steps_json, totals_json, fingerprint, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        recipe.title,
        titleKey,
        recipe.description,
        recipe.category,
        recipe.prepTimeMinutes,
        recipe.basePortions ?? null,
        recipe.emoji,
        recipe.color,
        JSON.stringify(recipe.ingredients),
        JSON.stringify(recipe.steps),
        computedTotals ? JSON.stringify(computedTotals) : null,
        recipeFingerprint,
        now,
        now,
      );
      db.prepare("INSERT INTO recipe_sources (url, recipe_id, created_at) VALUES (?, ?, ?)")
        .run(url, id, now);
      const saved = getRecipe(id);
      db.exec("COMMIT");
      return { recipe: saved, duplicate: false, reason: "new" };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  return {
    close: () => db.close(),
    deleteRecipe,
    getBySource,
    list,
    saveImported,
  };
}
