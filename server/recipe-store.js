import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import nodemailer from "nodemailer";

const FINISHED_JOB_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const COMPLETED_JOB_LIMIT = 10;

function createTransporter() {
  // Use local Postfix relay if available (no auth needed on localhost)
  // Falls back to SMTP_* env vars for external SMTP
  const host = process.env.SMTP_HOST || "localhost";
  const port = parseInt(process.env.SMTP_PORT || "25", 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || user;

  const transportOptions = {
    host,
    port,
    secure: port === 465,
    // Skip verification for local Postfix
    tls: { rejectUnauthorized: false },
  };

  // Only add auth if credentials provided (for external SMTP)
  if (user && pass) {
    transportOptions.auth = { user, pass };
  }

  return nodemailer.createTransport(transportOptions);
}

let transporter = null;
function getTransporter() {
  if (!transporter) {
    transporter = createTransporter();
  }
  return transporter;
}

function parseJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function shortenUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    const path = parsed.pathname.replace(/\/$/, "");
    return `${host}${path}`;
  } catch {
    return url;
  }
}

function isActiveJob(row) {
  return row.status === "pending" || row.status === "processing";
}

async function sendEmail(to, subject, html) {
  const t = getTransporter();
  const from = process.env.SMTP_FROM || "recipetor <noreply@barbtech.com>";
  try {
    await t.sendMail({ from, to, subject, html });
    console.log("Email sent via Postfix to", to);
    return true;
  } catch (error) {
    console.error("Failed to send email:", error instanceof Error ? error.message : "Unknown error");
    return false;
  }
}

function defaultGenerateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function sendCodeEmail(emailSender, to, subject, html, code, label) {
  void Promise.resolve(emailSender(to, subject, html))
    .then((delivered) => {
      // Keep local development usable when no SMTP relay is configured.
      if (delivered === false && process.env.NODE_ENV !== "production") {
        console.log(`[dev] ${label} for ${to}: ${code}`);
      }
    })
    .catch((error) => {
      console.error(`Failed to send ${label.toLowerCase()} email:`, error instanceof Error ? error.message : "Unknown error");
    });
}

function codeEmailHtml(title, intro, code) {
  return `
    <div style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #333;">${title}</h2>
      <p>${intro}</p>
      <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; text-align: center; margin: 20px 0;">
        <span style="font-size: 32px; font-weight: bold; letter-spacing: 4px; color: #333;">${code}</span>
      </div>
      <p>This code expires in 15 minutes.</p>
      <p>If you didn't request this, please ignore this email.</p>
      <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
      <p style="color: #666; font-size: 12px;">recipetor</p>
    </div>
  `;
}

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

// A slightly looser key used only for cross-recipe nutrition lookup. It also
// drops cooking methods and qualifiers so "large eggs, boiled" can match "egg".
const NUTRITION_STOP_WORDS = new Set([
  "baked", "boiled", "cooked", "fried", "grilled", "minute", "min", "raw",
  "roasted", "sauteed", "simmered", "steamed", "toasted", "light", "lowfat",
  "nonfat", "skim", "sweetened", "unsweetened",
]);

const SINGULAR_EXCEPTIONS = new Set(["asparagus", "citrus", "couscous", "hummus", "molasses"]);

function nutritionKey(value) {
  return normalizeIngredient(value)
    .split(" ")
    .filter((word) => word && !NUTRITION_STOP_WORDS.has(word) && !/^\d+$/.test(word))
    .map((word) =>
      word.length > 3 && word.endsWith("s") && !word.endsWith("ss") && !SINGULAR_EXCEPTIONS.has(word)
        ? word.slice(0, -1)
        : word,
    )
    .join(" ");
}

function ingredientSimilarity(left, right) {
  const a = new Set(left.map(normalizeIngredient).filter(Boolean).flatMap((name) => name.split(" ")));
  const b = new Set(right.map(normalizeIngredient).filter(Boolean).flatMap((name) => name.split(" ")));
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = [...a].filter((ingredient) => b.has(ingredient)).length;
  return intersection / new Set([...a, ...b]).size;
}

// Unit tables shared in spirit with src/units.ts. Keep the canonical names in sync.
const MASS_UNITS = {
  g: 1,
  kg: 1000,
  mg: 0.001,
  oz: 28.349523125,
  lb: 453.59237,
};
const VOLUME_UNITS = {
  ml: 1,
  l: 1000,
  tsp: 4.92892159375,
  tbsp: 14.78676478125,
  cup: 236.5882365,
  "fl oz": 29.5735295625,
  pint: 473.176473,
  quart: 946.352946,
  gallon: 3785.411784,
};
const COUNT_UNITS = new Set([
  "piece", "slice", "clove", "can", "package", "pinch", "bunch", "sprig", "stick", "head",
]);
const UNIT_ALIASES = {
  gram: "g", grams: "g",
  kilogram: "kg", kilograms: "kg", kilo: "kg", kilos: "kg",
  milligram: "mg", milligrams: "mg",
  ounce: "oz", ounces: "oz",
  pound: "lb", pounds: "lb", lbs: "lb",
  milliliter: "ml", milliliters: "ml", millilitre: "ml", millilitres: "ml",
  liter: "l", liters: "l", litre: "l", litres: "l",
  teaspoon: "tsp", teaspoons: "tsp",
  tablespoon: "tbsp", tablespoons: "tbsp",
  cups: "cup",
  "fl oz": "fl oz", floz: "fl oz", "fluid ounce": "fl oz", "fluid ounces": "fl oz",
  pints: "pint",
  quarts: "quart",
  gallons: "gallon",
  pieces: "piece", unit: "piece", units: "piece",
  slices: "slice",
  cloves: "clove",
  cans: "can",
  packages: "package", pkg: "package",
  pinches: "pinch",
  bunches: "bunch",
  sprigs: "sprig",
  sticks: "stick",
  heads: "head",
};

function normalizeUnit(unit) {
  const text = String(unit ?? "")
    .trim()
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, " ");
  return UNIT_ALIASES[text] ?? text;
}

function unitInfo(unit) {
  const canonical = normalizeUnit(unit);
  if (Object.hasOwn(MASS_UNITS, canonical)) {
    return { canonical, family: "mass", factor: MASS_UNITS[canonical] };
  }
  if (Object.hasOwn(VOLUME_UNITS, canonical)) {
    return { canonical, family: "volume", factor: VOLUME_UNITS[canonical] };
  }
  if (COUNT_UNITS.has(canonical)) {
    return { canonical, family: "count", factor: 1 };
  }
  return { canonical, family: "other", factor: 1 };
}

function convertAmount(amount, fromUnit, toUnit) {
  const from = unitInfo(fromUnit);
  const to = unitInfo(toUnit);
  if (from.canonical === to.canonical) return amount;
  if (from.family === "mass" && to.family === "mass") return (amount * from.factor) / to.factor;
  if (from.family === "volume" && to.family === "volume") return (amount * from.factor) / to.factor;
  return null;
}

function scaleNutrition(nutrition, ratio) {
  if (!nutrition) return nutrition;
  const scale = (value) => (value == null ? null : Math.round(value * ratio * 10) / 10);
  return {
    calories: scale(nutrition.calories),
    protein: scale(nutrition.protein),
    carbs: scale(nutrition.carbs),
    fat: scale(nutrition.fat),
  };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
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

function toRecipe(row, sourceRows, userId = null, isAdmin = false) {
  const sourceUrls = sourceRows.map((source) => source.url);
  const totals = row.totals_json ? JSON.parse(row.totals_json) : null;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    cuisine: row.cuisine ?? "",
    mealTypes: parseJsonArray(row.meal_types_json),
    dietTags: parseJsonArray(row.diet_tags_json),
    customTags: parseJsonArray(row.custom_tags_json),
    prepTimeMinutes: row.prep_time_minutes,
    basePortions: row.base_portions,
    baseServings: row.base_portions,
    time: row.prep_time_minutes ? `${row.prep_time_minutes} min` : "Time varies",
    emoji: row.emoji,
    color: row.color,
    imageUrl: row.image_url ?? null,
    ingredients: JSON.parse(row.ingredients_json),
    steps: JSON.parse(row.steps_json),
    totals,
    nutritionPerPortion: totals,
    source: sourceUrls.length > 1 ? `${sourceUrls.length} Instagram sources` : "Instagram",
    sourceUrls,
    sourcePosts: sourceUrls,
    sourceCount: sourceUrls.length,
    ratingAvg: row.rating_avg ?? 0,
    ratingCount: row.rating_count ?? 0,
    canDelete: Boolean(userId && (isAdmin || row.user_id === userId)),
    isExample: false,
  };
}

export function createRecipeStore(
  databasePath = "./data/recipetor.sqlite",
  { emailSender = sendEmail, generateCode = defaultGenerateCode } = {},
) {
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
      email_verified INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `);

  // Migration: add email_verified column if it doesn't exist (for existing databases)
  const userColumns = db.prepare("PRAGMA table_info(users)").all();
  const hasEmailVerified = userColumns.some((col) => col.name === "email_verified");
  if (!hasEmailVerified) {
    db.exec("ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0");
  }

  db.exec(`
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
    CREATE TABLE IF NOT EXISTS recipe_sources (
      url TEXT PRIMARY KEY,
      recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS recipe_sources_recipe_id_idx ON recipe_sources(recipe_id);
  `);

  // Migrations: bring older databases up to the current recipes schema.
  // The user_id index must be created after the column exists.
  const recipeMigrations = [
    ["base_portions", "ALTER TABLE recipes ADD COLUMN base_portions INTEGER"],
    ["totals_json", "ALTER TABLE recipes ADD COLUMN totals_json TEXT"],
    ["user_id", "ALTER TABLE recipes ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE SET NULL"],
    ["cuisine", "ALTER TABLE recipes ADD COLUMN cuisine TEXT NOT NULL DEFAULT ''"],
    ["meal_types_json", "ALTER TABLE recipes ADD COLUMN meal_types_json TEXT NOT NULL DEFAULT '[]'"],
    ["diet_tags_json", "ALTER TABLE recipes ADD COLUMN diet_tags_json TEXT NOT NULL DEFAULT '[]'"],
    ["custom_tags_json", "ALTER TABLE recipes ADD COLUMN custom_tags_json TEXT NOT NULL DEFAULT '[]'"],
    ["image_url", "ALTER TABLE recipes ADD COLUMN image_url TEXT"],
    ["rating_avg", "ALTER TABLE recipes ADD COLUMN rating_avg REAL NOT NULL DEFAULT 0"],
    ["rating_count", "ALTER TABLE recipes ADD COLUMN rating_count INTEGER NOT NULL DEFAULT 0"],
  ];
  const recipeColumns = new Set(
    db.prepare("PRAGMA table_info(recipes)").all().map((column) => column.name),
  );
  for (const [column, statement] of recipeMigrations) {
    if (recipeColumns.has(column)) continue;
    try {
      db.exec(statement);
      recipeColumns.add(column);
      console.log(`Migration: added ${column} column to recipes table`);
    } catch (error) {
      console.error(
        `Migration for recipes.${column} failed:`,
        error instanceof Error ? error.message : "Unknown error",
      );
      throw error;
    }
  }
  db.exec("CREATE INDEX IF NOT EXISTS recipes_user_id_idx ON recipes(user_id);");

  // Backfill meal types for recipes created before classification existed.
  // New extractions carry their own values; this only fills empty arrays.
  const backfillRows = db.prepare("SELECT id, category, meal_types_json FROM recipes").all();
  const backfillMealTypes = db.prepare("UPDATE recipes SET meal_types_json = ? WHERE id = ?");
  for (const row of backfillRows) {
    if (parseJsonArray(row.meal_types_json).length > 0 || row.category === "Other") continue;
    backfillMealTypes.run(JSON.stringify([row.category]), row.id);
  }

  // Extraction jobs table for background processing with progress tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS extraction_jobs (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      stage TEXT,
      progress INTEGER DEFAULT 0,
      stage_label TEXT,
      error_message TEXT,
      recipe_id TEXT REFERENCES recipes(id) ON DELETE SET NULL,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS extraction_jobs_url_idx ON extraction_jobs(url);
    CREATE INDEX IF NOT EXISTS extraction_jobs_status_idx ON extraction_jobs(status);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS job_watchers (
      job_id TEXT NOT NULL REFERENCES extraction_jobs(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (job_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS job_watchers_user_id_idx ON job_watchers(user_id);
  `);

  // Older jobs predate the watcher table; make their creators watchers too.
  db.prepare(`
    INSERT OR IGNORE INTO job_watchers (job_id, user_id, created_at)
    SELECT id, created_by, created_at FROM extraction_jobs WHERE created_by IS NOT NULL
  `).run();

  const jobColumns = new Set(
    db.prepare("PRAGMA table_info(extraction_jobs)").all().map((column) => column.name),
  );
  if (!jobColumns.has("stage_label")) {
    db.exec("ALTER TABLE extraction_jobs ADD COLUMN stage_label TEXT");
    console.log("Migration: added stage_label column to extraction_jobs table");
  }
  if (!jobColumns.has("started_at")) {
    db.exec("ALTER TABLE extraction_jobs ADD COLUMN started_at TEXT");
    console.log("Migration: added started_at column to extraction_jobs table");
  }

  // Anonymous-friendly usage events for the telemetry dashboard.
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_events (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      event TEXT NOT NULL,
      recipe_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS app_events_created_idx ON app_events(created_at);
    CREATE INDEX IF NOT EXISTS app_events_user_idx ON app_events(user_id);
    CREATE INDEX IF NOT EXISTS app_events_event_idx ON app_events(event);
  `);
  const EVENT_RETENTION_DAYS = 90;
  db.prepare("DELETE FROM app_events WHERE created_at < ?")
    .run(new Date(Date.now() - EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString());

  // Favorites and history tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS favorites (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, recipe_id)
    );
    CREATE TABLE IF NOT EXISTS user_recipe_history (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      action TEXT NOT NULL CHECK (action IN ('added', 'updated')),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS user_recipe_history_user_id_idx ON user_recipe_history(user_id);
    CREATE INDEX IF NOT EXISTS user_recipe_history_recipe_id_idx ON user_recipe_history(recipe_id);
    CREATE TABLE IF NOT EXISTS recipe_ratings (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, recipe_id)
    );
    CREATE INDEX IF NOT EXISTS recipe_ratings_recipe_id_idx ON recipe_ratings(recipe_id);
  `);

// Email verification codes table
  db.exec(`
    CREATE TABLE IF NOT EXISTS verification_codes (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      code TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS verification_codes_email_idx ON verification_codes(email);
  `);

  // Password reset codes table
  db.exec(`
    CREATE TABLE IF NOT EXISTS password_reset_codes (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      code TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS password_reset_codes_email_idx ON password_reset_codes(email);
  `);

  const userByEmail = db.prepare("SELECT * FROM users WHERE email = ?");
  const userById = db.prepare("SELECT * FROM users WHERE id = ?");

  const jobById = db.prepare("SELECT * FROM extraction_jobs WHERE id = ?");
  const jobByUrl = db.prepare("SELECT * FROM extraction_jobs WHERE url = ? ORDER BY created_at DESC LIMIT 1");
  const jobsByUrl = db.prepare("SELECT * FROM extraction_jobs WHERE url = ? ORDER BY created_at DESC");
  const addJobWatcherStmt = db.prepare(
    "INSERT OR IGNORE INTO job_watchers (job_id, user_id, created_at) VALUES (?, ?, ?)",
  );
  const jobWatcherStmt = db.prepare("SELECT 1 FROM job_watchers WHERE job_id = ? AND user_id = ?");
  const watchersByJob = db.prepare("SELECT user_id FROM job_watchers WHERE job_id = ? ORDER BY created_at ASC");
  const watchersByUser = db.prepare("SELECT job_id FROM job_watchers WHERE user_id = ?");

  // Telemetry prepared statements
  const insertEventStmt = db.prepare(
    "INSERT INTO app_events (id, user_id, event, recipe_id, created_at) VALUES (?, ?, ?, ?, ?)",
  );

  // Favorites prepared statements
  const favoritesByUser = db.prepare("SELECT recipe_id FROM favorites WHERE user_id = ? ORDER BY created_at DESC");
  const favoriteByUserAndRecipe = db.prepare("SELECT * FROM favorites WHERE user_id = ? AND recipe_id = ?");
  const addFavoriteStmt = db.prepare("INSERT OR IGNORE INTO favorites (user_id, recipe_id, created_at) VALUES (?, ?, ?)");
  const removeFavoriteStmt = db.prepare("DELETE FROM favorites WHERE user_id = ? AND recipe_id = ?");

  // Rating prepared statements
  const ratingByUserAndRecipe = db.prepare("SELECT rating FROM recipe_ratings WHERE user_id = ? AND recipe_id = ?");
  const ratingSummary = db.prepare("SELECT COUNT(*) AS count, AVG(rating) AS average FROM recipe_ratings WHERE recipe_id = ?");
  const upsertRatingStmt = db.prepare(`
    INSERT INTO recipe_ratings (user_id, recipe_id, rating, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, recipe_id) DO UPDATE SET rating = excluded.rating, updated_at = excluded.updated_at
  `);
  const removeRatingStmt = db.prepare("DELETE FROM recipe_ratings WHERE user_id = ? AND recipe_id = ?");
  const updateRecipeRatingStmt = db.prepare("UPDATE recipes SET rating_avg = ?, rating_count = ? WHERE id = ?");

  // History prepared statements
  const historyByUser = db.prepare(`
    SELECT recipe_id, action, created_at
    FROM user_recipe_history
    WHERE user_id = ?
    ORDER BY created_at DESC
  `);
  const addHistoryStmt = db.prepare("INSERT INTO user_recipe_history (user_id, recipe_id, action, created_at) VALUES (?, ?, ?, ?)");

  // Verification codes prepared statements
  const createVerificationCodeStmt = db.prepare("INSERT INTO verification_codes (id, email, code, expires_at, created_at) VALUES (?, ?, ?, ?, ?)");
  const getVerificationCodeStmt = db.prepare("SELECT * FROM verification_codes WHERE email = ? AND code = ? ORDER BY created_at DESC LIMIT 1");
  const deleteVerificationCodeStmt = db.prepare("DELETE FROM verification_codes WHERE email = ? AND code = ?");
  const deleteExpiredVerificationCodesStmt = db.prepare("DELETE FROM verification_codes WHERE expires_at < ?");
  const updateUserEmailVerifiedStmt = db.prepare("UPDATE users SET email_verified = 1 WHERE email = ?");

  // Password reset codes prepared statements
  const createPasswordResetCodeStmt = db.prepare("INSERT INTO password_reset_codes (id, email, code, expires_at, created_at) VALUES (?, ?, ?, ?, ?)");
  const getPasswordResetCodeStmt = db.prepare("SELECT * FROM password_reset_codes WHERE email = ? AND code = ? ORDER BY created_at DESC LIMIT 1");
  const deletePasswordResetCodeStmt = db.prepare("DELETE FROM password_reset_codes WHERE email = ? AND code = ?");
  const deleteExpiredPasswordResetCodesStmt = db.prepare("DELETE FROM password_reset_codes WHERE expires_at < ?");
  const updateUserPasswordStmt = db.prepare("UPDATE users SET password_hash = ?, salt = ? WHERE email = ?");

  function createUser(email, password) {
    const existing = userByEmail.get(email);
    if (existing) throw new Error("Email already registered");
    const id = randomUUID();
    const salt = generateSalt();
    const passwordHash = hashPassword(password, salt);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO users (id, email, password_hash, salt, email_verified, created_at) VALUES (?, ?, ?, ?, 0, ?)")
      .run(id, email, passwordHash, salt, now);
    
    // Generate verification code
    const code = generateCode(); // 6-digit code
    const codeId = randomUUID();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 minutes
    createVerificationCodeStmt.run(codeId, email, code, expiresAt, now);

    // Send the code by email. Registration still succeeds if delivery fails.
    sendCodeEmail(
      emailSender,
      email,
      "Verify your recipetor email",
      codeEmailHtml("Verify your email", "Use this code to finish creating your recipetor account.", code),
      code,
      "Verification code",
    );

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

  function deleteUser(userId) {
    const stmt = db.prepare("DELETE FROM users WHERE id = ?");
    const result = stmt.run(userId);
    return result.changes > 0;
  }

  function verifyUser(email, password) {
    const row = userByEmail.get(email);
    if (!row) return null;
    if (!verifyPassword(password, row.salt, row.password_hash)) return null;
    if (!row.email_verified) return { error: "EMAIL_NOT_VERIFIED", message: "Please verify your email before logging in" };
    return { id: row.id, email: row.email, createdAt: row.created_at };
  }

  function verifyEmailCode(email, code) {
    // Clean up expired codes
    const now = new Date().toISOString();
    deleteExpiredVerificationCodesStmt.run(now);
    
    const record = getVerificationCodeStmt.get(email, code);
    if (!record) return { success: false, message: "Invalid or expired verification code" };
    
    // Check if code is expired
    if (new Date(record.expires_at) < new Date()) {
      deleteVerificationCodeStmt.run(email, code);
      return { success: false, message: "Verification code has expired" };
    }
    
    // Mark user as verified
    updateUserEmailVerifiedStmt.run(email);
    deleteVerificationCodeStmt.run(email, code);
    
    return { success: true, message: "Email verified successfully" };
  }

  function resendVerificationCode(email) {
    const user = userByEmail.get(email);
    if (!user) return { success: false, message: "User not found" };
    if (user.email_verified) return { success: false, message: "Email already verified" };
    
    // Clean up expired codes
    const now = new Date().toISOString();
    deleteExpiredVerificationCodesStmt.run(now);
    
    // Generate new code
    const code = generateCode();
    const codeId = randomUUID();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    createVerificationCodeStmt.run(codeId, email, code, expiresAt, now);

    sendCodeEmail(
      emailSender,
      email,
      "Your new recipetor verification code",
      codeEmailHtml("Verify your email", "Use this code to finish creating your recipetor account.", code),
      code,
      "Verification code",
    );

    return { success: true, message: "Verification code sent" };
    }

    function createPasswordResetCode(email) {
      const user = userByEmail.get(email);
      if (!user) return { success: false, message: "User not found" };

      // Clean up expired codes
      const now = new Date().toISOString();
      deleteExpiredPasswordResetCodesStmt.run(now);

      // Generate new code
      const code = generateCode();
      const codeId = randomUUID();
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 minutes
      createPasswordResetCodeStmt.run(codeId, email, code, expiresAt, now);

      sendCodeEmail(
        emailSender,
        email,
        "Reset your recipetor password",
        codeEmailHtml("Reset your password", "You requested a password reset for your recipetor account.", code),
        code,
        "Password reset code",
      );

      return { success: true, message: "Password reset code sent" };
    }

    function verifyPasswordResetCode(email, code, newPassword) {
      // Clean up expired codes
      const now = new Date().toISOString();
      deleteExpiredPasswordResetCodesStmt.run(now);

      const record = getPasswordResetCodeStmt.get(email, code);
      if (!record) return { success: false, message: "Invalid or expired reset code" };

      // Check if code is expired
      if (new Date(record.expires_at) < new Date()) {
        deletePasswordResetCodeStmt.run(email, code);
        return { success: false, message: "Reset code has expired" };
      }

      // Update password
      const salt = generateSalt();
      const passwordHash = hashPassword(newPassword, salt);
      updateUserPasswordStmt.run(passwordHash, salt, email);

      // Delete used code
      deletePasswordResetCodeStmt.run(email, code);

      return { success: true, message: "Password reset successfully" };
    }

    function resendPasswordResetCode(email) {
      const user = userByEmail.get(email);
      if (!user) return { success: false, message: "User not found" };

      // Clean up expired codes
      const now = new Date().toISOString();
      deleteExpiredPasswordResetCodesStmt.run(now);

      // Generate new code
      const code = generateCode();
      const codeId = randomUUID();
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      createPasswordResetCodeStmt.run(codeId, email, code, expiresAt, now);

      sendCodeEmail(
        emailSender,
        email,
        "Your new recipetor password reset code",
        codeEmailHtml("Reset your password", "You requested a new password reset code for your recipetor account.", code),
        code,
        "Password reset code",
      );

      return { success: true, message: "Password reset code sent" };
    }

    function createExtractionJob(url, userId) {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO extraction_jobs (id, url, status, stage, progress, created_by, created_at, updated_at) VALUES (?, ?, 'pending', 'queued', 0, ?, ?, ?)"
    ).run(id, url, userId ?? null, now, now);
    if (userId) addJobWatcherStmt.run(id, userId, now);
    return { id, url, status: "pending", stage: "queued", progress: 0, createdAt: now };
  }

  function addJobWatcher(jobId, userId) {
    if (!jobId || !userId) return false;
    const result = addJobWatcherStmt.run(jobId, userId, new Date().toISOString());
    return result.changes > 0;
  }

  function isJobWatcher(jobId, userId) {
    if (!jobId || !userId) return false;
    return Boolean(jobWatcherStmt.get(jobId, userId));
  }

  function listJobWatchers(jobId) {
    return watchersByJob.all(jobId).map((row) => row.user_id);
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
      stageLabel: row.stage_label ?? null,
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
      stageLabel: row.stage_label ?? null,
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

  function getRecentFailedJob(url) {
    const now = Date.now();
    return (
      getExtractionJobsByUrl(url).find((job) => {
        if (job.status !== "failed") return false;
        const updated = Date.parse(job.updatedAt);
        return Number.isFinite(updated) && now - updated <= FINISHED_JOB_MAX_AGE_MS;
      }) ?? null
    );
  }

  function linkExtractionJobToRecipe(jobId, recipeId) {
    if (!jobId || !recipeId) return;
    db.prepare("UPDATE extraction_jobs SET recipe_id = ?, updated_at = ? WHERE id = ?")
      .run(recipeId, new Date().toISOString(), jobId);
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

  function listRecoverableExtractionJobs() {
    return db
      .prepare("SELECT * FROM extraction_jobs WHERE status IN ('pending', 'processing') ORDER BY created_at ASC")
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
    if (updates.stageLabel !== undefined) { fields.push("stage_label = ?"); params.push(updates.stageLabel); }
    if (updates.startedAt !== undefined) { fields.push("started_at = ?"); params.push(updates.startedAt); }
    if (updates.errorMessage !== undefined) { fields.push("error_message = ?"); params.push(updates.errorMessage); }
    if (updates.recipeId !== undefined) { fields.push("recipe_id = ?"); params.push(updates.recipeId); }
    if (fields.length === 0) return;
    fields.push("updated_at = ?");
    params.push(new Date().toISOString());
    params.push(id);
    db.prepare(`UPDATE extraction_jobs SET ${fields.join(", ")} WHERE id = ?`).run(...params);
  }

  function activeJobPositions() {
    const rows = db
      .prepare("SELECT id FROM extraction_jobs WHERE status IN ('pending', 'processing') ORDER BY created_at ASC, id ASC")
      .all();
    return new Map(rows.map((row, index) => [row.id, index + 1]));
  }

  function toPublicJob(row, position, userId, watched = false) {
    const isCreator = Boolean(userId && row.created_by === userId);
    return {
      id: row.id,
      shortUrl: shortenUrl(row.url),
      status: row.status,
      stage: row.stage,
      progress: row.progress,
      stageLabel: row.stage_label ?? null,
      position: position ?? null,
      isMine: isCreator || watched,
      canRetry: !row.created_by || row.created_by === userId || watched,
      recipeId: row.recipe_id ?? null,
      error: row.error_message ?? null,
      errorMessage: row.error_message ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function listPublicExtractionJobs(userId = null) {
    const rows = db.prepare("SELECT * FROM extraction_jobs ORDER BY created_at ASC").all();
    const positions = activeJobPositions();
    const now = Date.now();
    const sourceUrls = new Set(db.prepare("SELECT url FROM recipe_sources").all().map((row) => row.url));
    const activeRows = rows.filter((row) => row.status === "pending" || row.status === "processing");
    const failedRows = rows.filter((row) => {
      // Failed jobs that already have a recipe (manual entry or a successful
      // retry) are processed and should not remain in the queue.
      if (row.status !== "failed" || row.recipe_id || sourceUrls.has(row.url)) return false;
      const updated = Date.parse(row.updated_at);
      return Number.isFinite(updated) && now - updated <= FINISHED_JOB_MAX_AGE_MS;
    });
    const failedByUrl = new Map();
    for (const row of failedRows) {
      const existing = failedByUrl.get(row.url);
      if (!existing || String(row.updated_at) >= String(existing.updated_at)) {
        failedByUrl.set(row.url, row);
      }
    }
    const completedRows = rows
      .filter((row) => row.status === "completed")
      .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))
      .slice(0, COMPLETED_JOB_LIMIT);
    const visibleRows = [...activeRows, ...failedByUrl.values(), ...completedRows];
    const watched = userId
      ? new Set(watchersByUser.all(userId).map((row) => row.job_id))
      : new Set();
    return visibleRows
      .map((row) => toPublicJob(row, positions.get(row.id), userId, watched.has(row.id)))
      .sort((left, right) => {
        const leftActive = left.position !== null;
        const rightActive = right.position !== null;
        if (leftActive !== rightActive) return leftActive ? -1 : 1;
        if (leftActive) return left.position - right.position;
        return String(right.updatedAt).localeCompare(String(left.updatedAt));
      });
  }

  function getPublicExtractionJob(id, userId = null) {
    const row = jobById.get(id);
    if (!row) return null;
    return toPublicJob(
      row,
      activeJobPositions().get(id),
      userId,
      Boolean(userId && jobWatcherStmt.get(id, userId)),
    );
  }

  function retryExtractionJob(id, userId) {
    const row = jobById.get(id);
    if (!row) return { error: "NOT_FOUND" };
    if (row.status !== "failed") return { error: "NOT_FAILED" };
    const watched = Boolean(userId && jobWatcherStmt.get(id, userId));
    if (row.created_by && row.created_by !== userId && !watched) return { error: "FORBIDDEN" };
    const created = createExtractionJob(row.url, userId ?? row.created_by ?? null);
    for (const watcherId of listJobWatchers(id)) {
      addJobWatcher(created.id, watcherId);
    }
    return {
      job: {
        id: created.id,
        shortUrl: shortenUrl(row.url),
        status: "pending",
        stage: "queued",
        progress: 0,
        stageLabel: null,
        position: activeJobPositions().get(created.id) ?? null,
        isMine: Boolean(userId),
        canRetry: false,
        recipeId: null,
        error: null,
        errorMessage: null,
        createdAt: created.createdAt,
        updatedAt: created.createdAt,
      },
    };
  }

  // Favorites functions
  function listFavorites(userId) {
    const rows = favoritesByUser.all(userId);
    return rows.map(({ recipe_id }) => recipe_id);
  }

  function isFavorite(userId, recipeId) {
    return !!favoriteByUserAndRecipe.get(userId, recipeId);
  }

  function addFavorite(userId, recipeId) {
    const now = new Date().toISOString();
    const result = addFavoriteStmt.run(userId, recipeId, now);
    return result.changes > 0;
  }

  function removeFavorite(userId, recipeId) {
    removeFavoriteStmt.run(userId, recipeId);
  }

  // Rating functions
  function getMyRating(userId, recipeId) {
    const row = ratingByUserAndRecipe.get(userId, recipeId);
    return row ? row.rating : null;
  }

  function refreshRecipeRating(recipeId) {
    const summary = ratingSummary.get(recipeId);
    const count = summary?.count ?? 0;
    const average = count > 0 ? Math.round((summary.average ?? 0) * 10) / 10 : 0;
    updateRecipeRatingStmt.run(average, count, recipeId);
    return { ratingAvg: average, ratingCount: count };
  }

  function setRating(userId, recipeId, rating) {
    const now = new Date().toISOString();
    upsertRatingStmt.run(userId, recipeId, rating, now, now);
    return { ...refreshRecipeRating(recipeId), myRating: rating };
  }

  function removeRating(userId, recipeId) {
    removeRatingStmt.run(userId, recipeId);
    return { ...refreshRecipeRating(recipeId), myRating: null };
  }

  // History functions
  function addToHistory(userId, recipeId, action) {
    const now = new Date().toISOString();
    addHistoryStmt.run(userId, recipeId, action, now);
  }

  function getUserHistory(userId, isAdmin = false) {
    const rows = historyByUser.all(userId);
    return rows.flatMap((row) => {
      const recipe = getRecipe(row.recipe_id, userId, isAdmin);
      return recipe ? [{ ...recipe, action: row.action, createdAt: row.created_at }] : [];
    });
  }

  const recipeById = db.prepare("SELECT * FROM recipes WHERE id = ?");
  const sourcesByRecipe = db.prepare(
    "SELECT url FROM recipe_sources WHERE recipe_id = ? ORDER BY created_at ASC",
  );

  function decorateRecipe(recipe, userId) {
    if (!recipe || !userId) return recipe;
    return {
      ...recipe,
      isFavorite: isFavorite(userId, recipe.id),
      myRating: getMyRating(userId, recipe.id),
    };
  }

  function getRecipe(id, userId = null, isAdmin = false) {
    const row = recipeById.get(id);
    if (!row) return null;
    return decorateRecipe(toRecipe(row, sourcesByRecipe.all(id), userId, isAdmin), userId);
  }

  // Returns the owner user id, null for legacy recipes without an owner,
  // or undefined when the recipe does not exist.
  function getRecipeOwner(id) {
    const row = db.prepare("SELECT user_id FROM recipes WHERE id = ?").get(id);
    return row ? row.user_id ?? null : undefined;
  }

  function getBySource(url, userId = null, isAdmin = false) {
    const source = db.prepare("SELECT recipe_id FROM recipe_sources WHERE url = ?").get(url);
    return source ? getRecipe(source.recipe_id, userId, isAdmin) : null;
  }

  function list(userId = null, isAdmin = false) {
    return db
      .prepare("SELECT id FROM recipes ORDER BY updated_at DESC, title COLLATE NOCASE ASC")
      .all()
      .map(({ id }) => getRecipe(id, userId, isAdmin));
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

  function totalsAreEmpty(totals) {
    if (!totals) return true;
    return ["calories", "protein", "carbs", "fat"].every((field) => totals[field] == null || totals[field] === 0);
  }

  // Build a cross-recipe index of nutrition values, normalized to a per-gram,
  // per-millilitre, or per-count unit so another recipe can reuse them.
  function buildNutritionIndex() {
    const rows = db.prepare("SELECT id, ingredients_json FROM recipes").all();
    const samples = [];
    for (const row of rows) {
      let ingredients;
      try {
        ingredients = JSON.parse(row.ingredients_json);
      } catch {
        continue;
      }
      if (!Array.isArray(ingredients)) continue;
      for (const ingredient of ingredients) {
        if (!ingredient || typeof ingredient !== "object" || typeof ingredient.name !== "string") continue;
        const info = unitInfo(ingredient.unit);
        if (info.family === "other") continue;
        const amount = Number(ingredient.amount);
        if (!Number.isFinite(amount) || amount <= 0) continue;
        const nutrition = ingredient.nutrition;
        if (!nutrition || typeof nutrition !== "object") continue;
        const key = nutritionKey(ingredient.name);
        if (!key) continue;
        samples.push({ recipeId: row.id, key, info, amount, nutrition });
      }
    }
    return samples;
  }

  function inferIngredientNutrition(ingredient, samples, excludeRecipeId = null) {
    if (!ingredient || typeof ingredient !== "object" || typeof ingredient.name !== "string") return null;
    const target = unitInfo(ingredient.unit);
    if (target.family === "other") return null;
    const amount = Number(ingredient.amount);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const key = nutritionKey(ingredient.name);
    if (!key) return null;
    const targetBase = target.family === "count" ? amount : amount * target.factor;
    if (!(targetBase > 0)) return null;

    const candidates = samples.filter((sample) => {
      if (excludeRecipeId && sample.recipeId === excludeRecipeId) return false;
      if (sample.key !== key) return false;
      if (target.family === "count") {
        return sample.info.family === "count" && sample.info.canonical === target.canonical;
      }
      return sample.info.family === target.family;
    });
    if (candidates.length === 0) {
      // Fall back to names where the shorter one is fully contained in the
      // longer one, e.g. "cream cheese" inside "light requeijao cream cheese".
      const targetWords = new Set(key.split(" ").filter(Boolean));
      const wordCandidates = samples.filter((sample) => {
        if (excludeRecipeId && sample.recipeId === excludeRecipeId) return false;
        if (target.family === "count") {
          if (sample.info.family !== "count" || sample.info.canonical !== target.canonical) return false;
        } else if (sample.info.family !== target.family) {
          return false;
        }
        const sampleWords = new Set(sample.key.split(" ").filter(Boolean));
        const [smaller, larger] =
          sampleWords.size <= targetWords.size ? [sampleWords, targetWords] : [targetWords, sampleWords];
        return smaller.size >= 2 && [...smaller].every((word) => larger.has(word));
      });
      if (wordCandidates.length > 0) candidates.push(...wordCandidates);
    }
    if (candidates.length === 0) return null;

    const existing = ingredient.nutrition ?? {};
    const result = {
      calories: existing.calories ?? null,
      protein: existing.protein ?? null,
      carbs: existing.carbs ?? null,
      fat: existing.fat ?? null,
    };
    let changed = false;
    for (const field of ["calories", "protein", "carbs", "fat"]) {
      if (result[field] != null) continue;
      const rates = [];
      for (const sample of candidates) {
        const value = Number(sample.nutrition[field]);
        if (sample.nutrition[field] == null || !Number.isFinite(value)) continue;
        const base = sample.info.family === "count" ? sample.amount : sample.amount * sample.info.factor;
        if (!(base > 0)) continue;
        rates.push(value / base);
      }
      if (rates.length === 0) continue;
      result[field] = Math.round(median(rates) * targetBase * 10) / 10;
      changed = true;
    }
    return changed ? result : null;
  }

  function enrichIngredients(ingredients, samples, excludeRecipeId = null) {
    if (!Array.isArray(ingredients)) return ingredients;
    let changed = false;
    const next = ingredients.map((ingredient) => {
      const inferred = inferIngredientNutrition(ingredient, samples, excludeRecipeId);
      if (!inferred) return ingredient;
      changed = true;
      return { ...ingredient, nutrition: inferred };
    });
    return changed ? next : ingredients;
  }

  // Fill missing ingredient nutrition in existing recipes from other recipes.
  // Runs once when the store opens so older imports benefit from newer data.
  function backfillIngredientNutrition() {
    const samples = buildNutritionIndex();
    if (samples.length === 0) return 0;
    const rows = db.prepare("SELECT id, ingredients_json, totals_json, base_portions FROM recipes").all();
    const update = db.prepare("UPDATE recipes SET ingredients_json = ?, totals_json = ? WHERE id = ?");
    let updated = 0;
    for (const row of rows) {
      let ingredients;
      try {
        ingredients = JSON.parse(row.ingredients_json);
      } catch {
        continue;
      }
      const next = enrichIngredients(ingredients, samples, row.id);
      if (next === ingredients) continue;
      let totalsJson = row.totals_json;
      const currentTotals = totalsJson ? JSON.parse(totalsJson) : null;
      if (totalsAreEmpty(currentTotals)) {
        const computed = computeTotalsFromIngredients(next, row.base_portions);
        if (computed) totalsJson = JSON.stringify(computed);
      }
      update.run(JSON.stringify(next), totalsJson, row.id);
      updated += 1;
    }
    if (updated > 0) console.log(`Backfilled ingredient nutrition in ${updated} recipe(s)`);
    return updated;
  }

  function mergeRecipeFacets(row, recipe) {
    const existingMeals = parseJsonArray(row.meal_types_json);
    const existingDiets = parseJsonArray(row.diet_tags_json);
    const existingCustom = parseJsonArray(row.custom_tags_json);
    return {
      cuisine: row.cuisine || recipe.cuisine || "",
      mealTypes: existingMeals.length ? existingMeals : (recipe.mealTypes ?? []),
      dietTags: existingDiets.length ? existingDiets : (recipe.dietTags ?? []),
      customTags: existingCustom.length ? existingCustom : (recipe.customTags ?? []),
      imageUrl: row.image_url ?? recipe.imageUrl ?? null,
    };
  }

  function updateIngredient(recipeId, index, changes, userId = null, isAdmin = false) {
    if (!changes || typeof changes !== "object" || Array.isArray(changes)) return { error: "NO_CHANGES" };
    const row = recipeById.get(recipeId);
    if (!row) return { error: "NOT_FOUND" };

    let ingredients;
    try {
      ingredients = JSON.parse(row.ingredients_json);
    } catch {
      return { error: "INVALID_RECIPE" };
    }
    if (!Array.isArray(ingredients)) return { error: "INVALID_RECIPE" };
    if (!Number.isInteger(index) || index < 0 || index >= ingredients.length) return { error: "INVALID_INDEX" };
    const current = ingredients[index];
    if (!current || typeof current !== "object") return { error: "INVALID_INDEX" };

    const hasUnit = Object.hasOwn(changes, "unit");
    const hasAmount = Object.hasOwn(changes, "amount");
    if (!hasUnit && !hasAmount) return { error: "NO_CHANGES" };

    const currentUnit = normalizeUnit(current.unit);
    let nextUnit = currentUnit;
    if (hasUnit) {
      if (typeof changes.unit !== "string") return { error: "INVALID_UNIT" };
      const requested = normalizeUnit(changes.unit);
      if (requested.length > 30) return { error: "INVALID_UNIT" };
      nextUnit = requested;
    }

    let nextAmount = current.amount ?? null;
    let amountProvided = false;
    if (hasAmount) {
      if (changes.amount === null || changes.amount === "") {
        nextAmount = null;
      } else {
        const value = Number(changes.amount);
        if (!Number.isFinite(value) || value < 0) return { error: "INVALID_AMOUNT" };
        nextAmount = value;
      }
      amountProvided = true;
    }

    const next = { ...current };
    let nutritionChanged = false;
    const unitChanged = hasUnit && nextUnit !== currentUnit;

    // A unit-only change converts the number so the physical quantity stays the same.
    if (unitChanged && current.amount != null && current.amount > 0 && !amountProvided) {
      if (currentUnit !== "" && nextUnit !== "") {
        const converted = convertAmount(current.amount, currentUnit, nextUnit);
        if (converted == null) return { error: "INCOMPATIBLE_UNITS" };
        nextAmount = Math.round(converted * 10000) / 10000;
      }
    }

    // A direct quantity edit keeps the per-unit nutrition rate.
    if (
      amountProvided &&
      current.amount != null &&
      current.amount > 0 &&
      nextAmount != null &&
      nextAmount !== current.amount
    ) {
      const explicitUnitChange = unitChanged && currentUnit !== "" && nextUnit !== "";
      if (!explicitUnitChange && current.nutrition) {
        next.nutrition = scaleNutrition(current.nutrition, nextAmount / current.amount);
        nutritionChanged = true;
      }
    }
    if (amountProvided && nextAmount == null && current.amount != null) {
      next.nutrition = { calories: null, protein: null, carbs: null, fat: null };
      nutritionChanged = true;
    }

    next.unit = hasUnit ? nextUnit : (current.unit ?? "");
    next.amount = nextAmount;

    // Once a quantity and unit are known, fill missing nutrition from other recipes.
    const inferred = inferIngredientNutrition(next, buildNutritionIndex(), recipeId);
    if (inferred) {
      next.nutrition = inferred;
      nutritionChanged = true;
    }

    ingredients[index] = next;
    let totalsJson = row.totals_json;
    const currentTotals = totalsJson ? JSON.parse(totalsJson) : null;
    if (nutritionChanged && totalsAreEmpty(currentTotals)) {
      const computed = computeTotalsFromIngredients(ingredients, row.base_portions);
      if (computed) totalsJson = JSON.stringify(computed);
    }

    db.prepare("UPDATE recipes SET ingredients_json = ?, totals_json = ? WHERE id = ?")
      .run(JSON.stringify(ingredients), totalsJson, recipeId);
    return { recipe: getRecipe(recipeId, userId, isAdmin) };
  }

  function saveImported(url, recipe, userId, isAdmin = false) {
    const samples = buildNutritionIndex();
    const enrichedIngredients = enrichIngredients(recipe.ingredients, samples);
    const enrichedRecipe =
      enrichedIngredients === recipe.ingredients ? recipe : { ...recipe, ingredients: enrichedIngredients };
    const titleKey = normalizeText(enrichedRecipe.title);
    const recipeFingerprint = fingerprint(titleKey, enrichedRecipe.ingredients);
    const now = new Date().toISOString();

    db.exec("BEGIN IMMEDIATE");
    try {
      const source = db.prepare("SELECT recipe_id FROM recipe_sources WHERE url = ?").get(url);
      if (source) {
        const existing = getRecipe(source.recipe_id, userId, isAdmin);
        if (userId && addFavorite(userId, source.recipe_id)) addToHistory(userId, source.recipe_id, "added");
        db.exec("COMMIT");
        return { recipe: existing, duplicate: true, reason: "source" };
      }

      const candidates = db
        .prepare("SELECT * FROM recipes WHERE title_key = ? ORDER BY updated_at DESC LIMIT 50")
        .all(titleKey);
      const match = candidates.find(
        (candidate) =>
          candidate.fingerprint === recipeFingerprint ||
          ingredientSimilarity(JSON.parse(candidate.ingredients_json), enrichedRecipe.ingredients) >= 0.65,
      );

      if (match) {
        const facets = mergeRecipeFacets(match, enrichedRecipe);
        db.prepare("INSERT INTO recipe_sources (url, recipe_id, created_at) VALUES (?, ?, ?)")
          .run(url, match.id, now);
        db.prepare(`
          UPDATE recipes
          SET updated_at = ?, cuisine = ?, meal_types_json = ?, diet_tags_json = ?, custom_tags_json = ?, image_url = ?
          WHERE id = ?
        `).run(
          now,
          facets.cuisine,
          JSON.stringify(facets.mealTypes),
          JSON.stringify(facets.dietTags),
          JSON.stringify(facets.customTags),
          facets.imageUrl,
          match.id,
        );
        const saved = getRecipe(match.id, userId, isAdmin);
        if (userId && addFavorite(userId, match.id)) addToHistory(userId, match.id, "added");
        db.exec("COMMIT");
        return { recipe: saved, duplicate: true, reason: "recipe" };
      }

      const id = randomUUID();
      const computedTotals = enrichedRecipe.totals
        ? enrichedRecipe.totals
        : computeTotalsFromIngredients(enrichedRecipe.ingredients, enrichedRecipe.basePortions);
      db.prepare(`
        INSERT INTO recipes (
          id, user_id, title, title_key, description, category, cuisine, meal_types_json, diet_tags_json,
          custom_tags_json, image_url, prep_time_minutes, base_portions, emoji, color,
          ingredients_json, steps_json, totals_json, fingerprint, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        userId ?? null,
        enrichedRecipe.title,
        titleKey,
        enrichedRecipe.description,
        enrichedRecipe.category,
        enrichedRecipe.cuisine ?? "",
        JSON.stringify(enrichedRecipe.mealTypes ?? []),
        JSON.stringify(enrichedRecipe.dietTags ?? []),
        JSON.stringify(enrichedRecipe.customTags ?? []),
        enrichedRecipe.imageUrl ?? null,
        enrichedRecipe.prepTimeMinutes,
        enrichedRecipe.basePortions ?? null,
        enrichedRecipe.emoji,
        enrichedRecipe.color,
        JSON.stringify(enrichedRecipe.ingredients),
        JSON.stringify(enrichedRecipe.steps),
        computedTotals ? JSON.stringify(computedTotals) : null,
        recipeFingerprint,
        now,
        now,
      );
      db.prepare("INSERT INTO recipe_sources (url, recipe_id, created_at) VALUES (?, ?, ?)")
        .run(url, id, now);
      const saved = getRecipe(id, userId, isAdmin);
      
      // Auto-favorite and add to history for the user who added the recipe
      if (userId && addFavorite(userId, id)) {
        addToHistory(userId, id, "added");
      }
      
      db.exec("COMMIT");
      return { recipe: saved, duplicate: false, reason: "new" };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function recordEvent(userId, event, recipeId = null) {
    insertEventStmt.run(randomUUID(), userId ?? null, event, recipeId ?? null, new Date().toISOString());
  }

  function telemetryData() {
    const count = (sql, ...params) => db.prepare(sql).get(...params);
    const iso = (daysAgo) => new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();

    const recipes = {
      total: count("SELECT COUNT(*) AS n FROM recipes").n,
      byCategory: db
        .prepare("SELECT category AS label, COUNT(*) AS count FROM recipes GROUP BY category ORDER BY count DESC")
        .all(),
      byCuisine: db
        .prepare(
          "SELECT cuisine AS label, COUNT(*) AS count FROM recipes WHERE cuisine != '' GROUP BY cuisine ORDER BY count DESC LIMIT 10",
        )
        .all(),
      latest: db
        .prepare(
          `SELECT r.id, r.title, r.category, r.image_url AS imageUrl, r.created_at AS createdAt,
                  u.email AS addedBy
           FROM recipes r LEFT JOIN users u ON r.user_id = u.id
           ORDER BY r.created_at DESC LIMIT ?`,
        )
        .all(10),
    };

    const durationExpr = "(julianday(updated_at) - julianday(started_at)) * 86400000.0";
    const durations = db
      .prepare(
        `SELECT ${durationExpr} AS ms FROM extraction_jobs
         WHERE status = 'completed' AND started_at IS NOT NULL`,
      )
      .all()
      .map((row) => row.ms)
      .filter((ms) => Number.isFinite(ms) && ms >= 0);
    const averageMs = durations.length
      ? Math.round(durations.reduce((total, ms) => total + ms, 0) / durations.length)
      : null;

    const extraction = {
      completed: count("SELECT COUNT(*) AS n FROM extraction_jobs WHERE status = 'completed'").n,
      failed: count("SELECT COUNT(*) AS n FROM extraction_jobs WHERE status = 'failed'").n,
      averageMs,
      minMs: durations.length ? Math.min(...durations) : null,
      maxMs: durations.length ? Math.max(...durations) : null,
      recent: db
        .prepare(
          `SELECT url, status, started_at AS startedAt, updated_at AS updatedAt,
                  CASE WHEN started_at IS NOT NULL
                    THEN CAST(${durationExpr} AS INTEGER) END AS durationMs
           FROM extraction_jobs
           WHERE status IN ('completed', 'failed')
           ORDER BY updated_at DESC LIMIT 10`,
        )
        .all(),
    };

    const active7 = count(
      "SELECT COUNT(DISTINCT user_id) AS n FROM app_events WHERE user_id IS NOT NULL AND created_at >= ?",
      iso(7),
    ).n;
    const active30 = count(
      "SELECT COUNT(DISTINCT user_id) AS n FROM app_events WHERE user_id IS NOT NULL AND created_at >= ?",
      iso(30),
    ).n;

    const users = {
      total: count("SELECT COUNT(*) AS n FROM users").n,
      activeLast7Days: active7,
      activeLast30Days: active30,
      top: db
        .prepare(
          `SELECT u.email, COUNT(*) AS events,
                  SUM(CASE WHEN e.event = 'recipe_view' THEN 1 ELSE 0 END) AS recipeViews,
                  MAX(e.created_at) AS lastSeen
           FROM app_events e JOIN users u ON e.user_id = u.id
           GROUP BY e.user_id ORDER BY events DESC LIMIT 10`,
        )
        .all(),
    };

    const access = {
      latest: db
        .prepare(
          `SELECT e.event, e.created_at AS at, u.email AS user, r.title AS recipe
           FROM app_events e
           LEFT JOIN users u ON e.user_id = u.id
           LEFT JOIN recipes r ON e.recipe_id = r.id
           ORDER BY e.created_at DESC LIMIT 20`,
        )
        .all(),
      topViewed: db
        .prepare(
          `SELECT r.title, COUNT(*) AS views
           FROM app_events e JOIN recipes r ON e.recipe_id = r.id
           WHERE e.event = 'recipe_view'
           GROUP BY e.recipe_id ORDER BY views DESC LIMIT 10`,
        )
        .all(),
    };

    const ratings = count("SELECT COUNT(*) AS n, AVG(rating) AS average FROM recipe_ratings");

    return {
      now: new Date().toISOString(),
      eventRetentionDays: EVENT_RETENTION_DAYS,
      dbSizeBytes: (() => {
        if (path === ":memory:") return null;
        try {
          return statSync(path).size;
        } catch {
          return null;
        }
      })(),
      recipes,
      extraction,
      users,
      access,
      favorites: { total: count("SELECT COUNT(*) AS n FROM favorites").n },
      ratings: {
        total: ratings.n ?? 0,
        average: ratings.average != null ? Math.round(ratings.average * 10) / 10 : null,
      },
      queue: {
        active: count("SELECT COUNT(*) AS n FROM extraction_jobs WHERE status IN ('pending', 'processing')").n,
        waiting24h: count(
          "SELECT COUNT(*) AS n FROM extraction_jobs WHERE status = 'failed' AND updated_at >= ?",
          iso(1),
        ).n,
      },
    };
  }

  backfillIngredientNutrition();

  return {
    close: () => db.close(),
    createUser,
    getUserByEmail,
    getUserById,
    verifyUser,
    deleteUser,
    verifyEmailCode,
    resendVerificationCode,
    // Password reset
    createPasswordResetCode,
    verifyPasswordResetCode,
    resendPasswordResetCode,
    deleteRecipe,
    updateIngredient,
    getBySource,
    getRecipe,
    getRecipeOwner,
    list,
    saveImported,
    createExtractionJob,
    getExtractionJob,
    getExtractionJobByUrl,
    getExtractionJobsByUrl,
    getRecentFailedJob,
    linkExtractionJobToRecipe,
    listExtractionJobs,
    listPublicExtractionJobs,
    getPublicExtractionJob,
    retryExtractionJob,
    addJobWatcher,
    isJobWatcher,
    listJobWatchers,
    listRecoverableExtractionJobs,
    updateExtractionJob,
    recordEvent,
    telemetryData,
    // Favorites
    listFavorites,
    isFavorite,
    addFavorite,
    removeFavorite,
    // Ratings
    getMyRating,
    setRating,
    removeRating,
    // History
    getUserHistory,
    addToHistory,
  };
}
