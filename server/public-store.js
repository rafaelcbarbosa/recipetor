import { randomUUID } from "node:crypto";

const REPORT_REASONS = new Set([
  "inappropriate",
  "not-a-recipe",
  "privacy",
  "copyright",
  "spam",
  "other",
]);

function nowIso() {
  return new Date().toISOString();
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, maxLength) : "";
}

function safePublicRecipe(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    cuisine: row.cuisine ?? "",
    mealTypes: parseJson(row.meal_types_json, []),
    dietTags: parseJson(row.diet_tags_json, []),
    allergenTags: parseJson(row.allergen_tags_json, []),
    prepTimeMinutes: row.prep_time_minutes,
    baseServings: row.base_portions,
    imageUrl: row.image_url ?? null,
    ingredients: parseJson(row.ingredients_json, []),
    steps: parseJson(row.steps_json, []),
    nutritionPerPortion: parseJson(row.totals_json, null),
    ratingAvg: row.rating_avg ?? 0,
    ratingCount: row.rating_count ?? 0,
    sourceUrl: row.source_url ?? null,
    sourceCredit: row.source_credit ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    visibility: "public",
    sharedBy: "Shared by a family",
  };
}

export function createPublicStore(db, { now = nowIso } = {}) {
  function listPublicRecipes({ query = "", page = 1, limit = 24 } = {}) {
    const safeLimit = Math.min(60, Math.max(1, Number(limit) || 24));
    const safePage = Math.max(1, Number(page) || 1);
    const offset = (safePage - 1) * safeLimit;
    const term = cleanText(query, 80);
    const where = ["visibility = 'public'"];
    const params = [];
    if (term) {
      where.push(
        `(title LIKE ? OR description LIKE ? OR cuisine LIKE ? OR ingredients_json LIKE ?)`,
      );
      const like = `%${term.replace(/[%_]/g, (match) => `\\${match}`)}%`;
      params.push(like, like, like, like);
    }
    const whereSql = where.join(" AND ");
    const total = db
      .prepare(`SELECT COUNT(*) AS n FROM recipes WHERE ${whereSql}`)
      .get(...params).n;
    const rows = db
      .prepare(
        `SELECT * FROM recipes WHERE ${whereSql}
         ORDER BY updated_at DESC, created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, safeLimit, offset);
    return {
      recipes: rows.map((row) => {
        const recipe = safePublicRecipe(row);
        return {
          id: recipe.id,
          title: recipe.title,
          description: recipe.description,
          cuisine: recipe.cuisine,
          mealTypes: recipe.mealTypes,
          dietTags: recipe.dietTags,
          allergenTags: recipe.allergenTags,
          prepTimeMinutes: recipe.prepTimeMinutes,
          imageUrl: recipe.imageUrl,
          ratingAvg: recipe.ratingAvg,
          ratingCount: recipe.ratingCount,
          sourceUrl: recipe.sourceUrl,
          sourceCredit: recipe.sourceCredit,
          sharedBy: recipe.sharedBy,
          updatedAt: recipe.updatedAt,
        };
      }),
      page: safePage,
      limit: safeLimit,
      total,
      hasMore: offset + rows.length < total,
    };
  }

  function getPublicRecipe(id) {
    const row = db.prepare("SELECT * FROM recipes WHERE id = ? AND visibility = 'public'").get(id);
    return row ? safePublicRecipe(row) : null;
  }

  function getPublicRecipeRow(id) {
    return (
      db.prepare("SELECT * FROM recipes WHERE id = ? AND visibility = 'public'").get(id) ?? null
    );
  }

  function createReport(recipeId, reporterId, { reason, details = "" } = {}) {
    const recipe = db.prepare("SELECT id FROM recipes WHERE id = ? AND visibility = 'public'").get(recipeId);
    if (!recipe) return { error: "NOT_FOUND" };
    if (!REPORT_REASONS.has(reason)) return { error: "INVALID_REASON" };
    const existing = db
      .prepare("SELECT id FROM reports WHERE recipe_id = ? AND reporter_id = ? AND status = 'open'")
      .get(recipeId, reporterId);
    if (existing) return { report: { id: existing.id, duplicate: true } };
    const id = randomUUID();
    db.prepare(
      `INSERT INTO reports (id, recipe_id, reporter_id, reason, details, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?)`,
    ).run(id, recipeId, reporterId, reason, cleanText(details, 500), now());
    return { report: { id, duplicate: false } };
  }

  function listReports({ status = "open" } = {}) {
    const rows = db
      .prepare(
        `SELECT r.*, rec.title AS recipe_title, rec.visibility AS recipe_visibility,
                u.email AS reporter_email
         FROM reports r
         LEFT JOIN recipes rec ON rec.id = r.recipe_id
         LEFT JOIN users u ON u.id = r.reporter_id
         WHERE (? = 'all' OR r.status = ?)
         ORDER BY r.created_at DESC
         LIMIT 200`,
      )
      .all(status, status);
    return rows.map((row) => ({
      id: row.id,
      recipeId: row.recipe_id,
      recipeTitle: row.recipe_title ?? "Deleted recipe",
      recipeVisibility: row.recipe_visibility ?? null,
      reporterEmail: row.reporter_email ?? null,
      reason: row.reason,
      details: row.details,
      status: row.status,
      resolvedBy: row.resolved_by,
      resolvedAt: row.resolved_at,
      createdAt: row.created_at,
    }));
  }

  function resolveReport(reportId, adminUserId, action) {
    const report = db.prepare("SELECT * FROM reports WHERE id = ?").get(reportId);
    if (!report) return { error: "NOT_FOUND" };
    if (report.status !== "open") return { error: "ALREADY_RESOLVED" };
    if (!["dismiss", "unpublish"].includes(action)) return { error: "INVALID_ACTION" };
    const timestamp = now();
    if (action === "unpublish" && report.recipe_id) {
      db.prepare("UPDATE recipes SET visibility = 'private', updated_at = ? WHERE id = ?").run(
        timestamp,
        report.recipe_id,
      );
    }
    db.prepare(
      "UPDATE reports SET status = ?, resolved_by = ?, resolved_at = ? WHERE id = ?",
    ).run(action === "unpublish" ? "resolved" : "dismissed", adminUserId, timestamp, reportId);
    return { report: listReports({ status: "all" }).find((item) => item.id === reportId) ?? null };
  }

  function countOpenReports() {
    return db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'").get().n;
  }

  return {
    listPublicRecipes,
    getPublicRecipe,
    getPublicRecipeRow,
    createReport,
    listReports,
    resolveReport,
    countOpenReports,
  };
}
