import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import nodemailer from "nodemailer";

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

  // Favorites prepared statements
  const favoritesByUser = db.prepare("SELECT recipe_id FROM favorites WHERE user_id = ? ORDER BY created_at DESC");
  const favoriteByUserAndRecipe = db.prepare("SELECT * FROM favorites WHERE user_id = ? AND recipe_id = ?");
  const addFavoriteStmt = db.prepare("INSERT OR IGNORE INTO favorites (user_id, recipe_id, created_at) VALUES (?, ?, ?)");
  const removeFavoriteStmt = db.prepare("DELETE FROM favorites WHERE user_id = ? AND recipe_id = ?");

  // History prepared statements
  const historyByUser = db.prepare(`
    SELECT h.*, r.title, r.description, r.category, r.prep_time_minutes, r.base_portions, r.emoji, r.color,
           r.ingredients_json, r.steps_json, r.totals_json
    FROM user_recipe_history h
    JOIN recipes r ON h.recipe_id = r.id
    WHERE h.user_id = ?
    ORDER BY h.created_at DESC
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
    if (updates.errorMessage !== undefined) { fields.push("error_message = ?"); params.push(updates.errorMessage); }
    if (updates.recipeId !== undefined) { fields.push("recipe_id = ?"); params.push(updates.recipeId); }
    if (fields.length === 0) return;
    fields.push("updated_at = ?");
    params.push(new Date().toISOString());
    params.push(id);
    db.prepare(`UPDATE extraction_jobs SET ${fields.join(", ")} WHERE id = ?`).run(...params);
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

  // History functions
  function addToHistory(userId, recipeId, action) {
    const now = new Date().toISOString();
    addHistoryStmt.run(userId, recipeId, action, now);
  }

  function getUserHistory(userId) {
    const rows = historyByUser.all(userId);
    return rows.map((row) => ({
      id: row.recipe_id,
      title: row.title,
      description: row.description,
      category: row.category,
      prepTimeMinutes: row.prep_time_minutes,
      basePortions: row.base_portions,
      emoji: row.emoji,
      color: row.color,
      ingredients: JSON.parse(row.ingredients_json),
      steps: JSON.parse(row.steps_json),
      totals: row.totals_json ? JSON.parse(row.totals_json) : null,
      action: row.action,
      createdAt: row.created_at,
    }));
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

  // Returns the owner user id, null for legacy recipes without an owner,
  // or undefined when the recipe does not exist.
  function getRecipeOwner(id) {
    const row = db.prepare("SELECT user_id FROM recipes WHERE id = ?").get(id);
    return row ? row.user_id ?? null : undefined;
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
          ingredientSimilarity(JSON.parse(candidate.ingredients_json), recipe.ingredients) >= 0.65,
      );

      if (match) {
        db.prepare("INSERT INTO recipe_sources (url, recipe_id, created_at) VALUES (?, ?, ?)")
          .run(url, match.id, now);
        db.prepare("UPDATE recipes SET updated_at = ? WHERE id = ?").run(now, match.id);
        const saved = getRecipe(match.id);
        if (userId && addFavorite(userId, match.id)) addToHistory(userId, match.id, "added");
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
    getBySource,
    getRecipe,
    getRecipeOwner,
    list,
    saveImported,
    createExtractionJob,
    getExtractionJob,
    getExtractionJobByUrl,
    getExtractionJobsByUrl,
    listExtractionJobs,
    listRecoverableExtractionJobs,
    updateExtractionJob,
    // Favorites
    listFavorites,
    isFavorite,
    addFavorite,
    removeFavorite,
    // History
    getUserHistory,
    addToHistory,
  };
}
