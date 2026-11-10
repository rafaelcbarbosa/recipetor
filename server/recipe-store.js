import { createHash, randomBytes, randomUUID } from "node:crypto";
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

function hashPassword(password, salt) {
  return createHash("sha256").update(salt + password).digest("hex");
}

function generateSalt() {
  return randomBytes(16).toString("hex");
}

function verifyPassword(password, salt, hash) {
  return hashPassword(password, salt) === hash;
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
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recipes (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
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
    CREATE INDEX IF NOT EXISTS recipes_user_id_idx ON recipes(user_id);
    CREATE TABLE IF NOT EXISTS recipe_sources (
      url TEXT PRIMARY KEY,
      recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS recipe_sources_recipe_id_idx ON recipe_sources(recipe_id);
  `);

  // Migration: add totals_json column if missing (for existing databases)
  try {
    const columns = db.prepare("PRAGMA table_info(recipes)").all();
    const hasTotalsJson = columns.some(c => c.name === "totals_json");
    if (!hasTotalsJson) {
      db.exec("ALTER TABLE recipes ADD COLUMN totals_json TEXT;");
      console.log("Migration: added totals_json column to recipes table");
    }
  } catch (error) {
    console.error("Migration check failed:", error instanceof Error ? error.message : "Unknown error");
  }

  // Migration: add user_id column to recipes if missing
  try {
    const columns = db.prepare("PRAGMA table_info(recipes)").all();
    const hasUserId = columns.some(c => c.name === "user_id");
    if (!hasUserId) {
      db.exec("ALTER TABLE recipes ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE SET NULL;");
      console.log("Migration: added user_id column to recipes table");
    }
  } catch (error) {
    console.error("Migration check failed:", error instanceof Error ? error.message : "Unknown error");
  }

  // Extraction jobs table for background processing with progress tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS extraction_jobs (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      stage TEXT,
      progress INTEGER DEFAULT 0,
      error_message TEXT,
      recipe_id TEXT REFERENCES recipes(id) ON DELETE SET NULL,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS extraction_jobs_url_idx ON extraction_jobs(url);
    CREATE INDEX IF NOT EXISTS extraction_jobs_status_idx ON extraction_jobs(status);
  `);

  const userByEmail = db.prepare("SELECT * FROM users WHERE email = ?");
  const userById = db.prepare("SELECT * FROM users WHERE id = ?");

  const jobById = db.prepare("SELECT * FROM extraction_jobs WHERE id = ?");
  const jobByUrl = db.prepare("SELECT * FROM extraction_jobs WHERE url = ? ORDER BY created_at DESC LIMIT 1");
  const jobsByUrl = db.prepare("SELECT * FROM extraction_jobs WHERE url = ? ORDER BY created_at DESC");

  function createUser(email, password) {
    const existing = userByEmail.get(email);
    if (existing) throw new Error("Email already registered");
    const id = randomUUID();
    const salt = generateSalt();
    const passwordHash = hashPassword(password, salt);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO users (id, email, password_hash, salt, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, email, passwordHash, salt, now);
    return { id, email, createdAt: now };
  }

  function getUserByEmail(email) {
    const row = userByEmail.get(email);
    if (!row) return null;
    return { id: row.id, email: row.email, createdAt: row.created_at };
  }

  function getUserById(id) {
    const row = userById.get(id);
    if (!row) return null;
    return { id: row.id, email: row.email, createdAt: row.created_at };
  }

  function verifyUser(email, password) {
    const row = userByEmail.get(email);
    if (!row) return null;
    if (!verifyPassword(password, row.salt, row.password_hash)) return null;
    return { id: row.id, email: row.email, createdAt: row.created_at };
  }

  function createExtractionJob(url, userId) {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO extraction_jobs (id, url, status, stage, progress, created_by, created_at, updated_at) VALUES (?, ?, 'pending', 'queued', 0, ?, ?, ?)"
    ).run(id, url, userId ?? null, now, now);
    return { id, url, status: "pending", stage: "queued", progress: 0, createdAt: now };
  }

  function getExtractionJob(id) {
    const row = jobById.get(id);
    if (!row) return null;
    return {
      id: row.id,
      url: row.url,
      status: row.status,
      stage: row.stage,
      progress: row.progress,
      errorMessage: row.error_message,
      recipeId: row.recipe_id,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function getExtractionJobByUrl(url) {
    const row = jobByUrl.get(url);
    if (!row) return null;
    return {
      id: row.id,
      url: row.url,
      status: row.status,
      stage: row.stage,
      progress: row.progress,
      errorMessage: row.error_message,
      recipeId: row.recipe_id,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function getExtractionJobsByUrl(url) {
    return db
      .prepare("SELECT * FROM extraction_jobs WHERE url = ? ORDER BY created_at DESC")
      .all(url)
      .map((row) => ({
        id: row.id,
        url: row.url,
        status: row.status,
        stage: row.stage,
        progress: row.progress,
        errorMessage: row.error_message,
        recipeId: row.recipe_id,
        createdBy: row.created_by,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }

  function listExtractionJobs() {
    return db
      .prepare("SELECT * FROM extraction_jobs ORDER BY created_at DESC")
      .all()
      .map((row) => ({
        id: row.id,
        url: row.url,
        status: row.status,
        stage: row.stage,
        progress: row.progress,
        errorMessage: row.error_message,
        recipeId: row.recipe_id,
        createdBy: row.created_by,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }

  function updateExtractionJob(id, updates) {
    const fields = [];
    const params = [];
    if (updates.status !== undefined) { fields.push("status = ?"); params.push(updates.status); }
    if (updates.stage !== undefined) { fields.push("stage = ?"); params.push(updates.stage); }
    if (updates.progress !== undefined) { fields.push("progress = ?"); params.push(updates.progress); }
    if (updates.errorMessage !== undefined) { fields.push("error_message = ?"); params.push(updates.errorMessage); }
    if (updates.recipeId !== undefined) { fields.push("recipe_id = ?"); params.push(updates.recipeId); }
    if (fields.length === 0) return;
    fields.push("updated_at = ?");
    params.push(new Date().toISOString());
    params.push(id);
    db.prepare(`UPDATE extraction_jobs SET ${fields.join(", ")} WHERE id = ?`).run(...params);
  }

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

  function saveImported(url, recipe, userId) {
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
          id, user_id, title, title_key, description, category, prep_time_minutes, base_portions, emoji, color,
          ingredients_json, steps_json, totals_json, fingerprint, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        userId ?? null,
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
    createUser,
    getUserByEmail,
    getUserById,
    verifyUser,
    deleteRecipe,
    getBySource,
    getRecipe,
    list,
    saveImported,
    createExtractionJob,
    getExtractionJob,
    getExtractionJobByUrl,
    getExtractionJobsByUrl,
    listExtractionJobs,
    updateExtractionJob,
  };
}
