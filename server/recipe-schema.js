const CATEGORIES = new Set(["Breakfast", "Lunch", "Dinner", "Dessert", "Snack", "Other"]);
const CATEGORY_STYLE = {
  Breakfast: { emoji: "🍳", color: "berry" },
  Lunch: { emoji: "🥗", color: "avocado" },
  Dinner: { emoji: "🍽️", color: "lemon" },
  Dessert: { emoji: "🍰", color: "berry" },
  Snack: { emoji: "🥑", color: "avocado" },
  Other: { emoji: "🍴", color: "lemon" },
};

function validateNutrition(value, name, { allowNull = true } = {}) {
  if (value === null || value === undefined) {
    if (allowNull) return null;
    throw new Error(`The recipe extractor returned an invalid ${name}.`);
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`The recipe extractor returned an invalid ${name}.`);
  }
  return value;
}

function validateIngredientNutrition(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new Error("The recipe extractor returned invalid ingredient nutrition.");
  }
  return {
    calories: validateNutrition(item.calories, "calories"),
    protein: validateNutrition(item.protein, "protein"),
    carbs: validateNutrition(item.carbs, "carbs"),
    fat: validateNutrition(item.fat, "fat"),
  };
}

function boundedString(value, name, maxLength, { allowEmpty = false } = {}) {
  if (typeof value !== "string") {
    throw new Error(`The recipe extractor returned an invalid ${name}.`);
  }
  const clean = value.trim();
  if ((!allowEmpty && clean.length === 0) || clean.length > maxLength) {
    throw new Error(`The recipe extractor returned an invalid ${name}.`);
  }
  return clean;
}

function boundedNumber(value, name, { min = 0, max = 10000, allowNull = false } = {}) {
  if (value === null || value === undefined) {
    if (allowNull) return null;
    throw new Error(`The recipe extractor returned an invalid ${name}.`);
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`The recipe extractor returned an invalid ${name}.`);
  }
  return value;
}

function validateIngredientLine(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new Error("The recipe extractor returned an invalid ingredient line.");
  }
  const amount = boundedNumber(item.amount, "amount", { min: 0, max: 100000, allowNull: true });
  const unit = boundedString(item.unit ?? "", "unit", 30, { allowEmpty: true });
  const name = boundedString(item.name, "ingredient name", 250);
  return { amount, unit, name };
}

/**
 * Validates a recipe returned by the extraction bridge (or the legacy Hermes
 * extractor) and normalizes it into the shape the recipe store persists.
 */
export function validateRecipeResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The recipe extractor returned an invalid recipe.");
  }
  const title = boundedString(value.title, "title", 150);
  const description = boundedString(value.description ?? "", "description", 500, { allowEmpty: true });
  const category = CATEGORIES.has(value.category) ? value.category : "Other";
  const prepTimeMinutes = value.prepTimeMinutes ?? null;
  if (
    prepTimeMinutes !== null &&
    (!Number.isInteger(prepTimeMinutes) || prepTimeMinutes < 1 || prepTimeMinutes > 1440)
  ) {
    throw new Error("The recipe extractor returned an invalid preparation time.");
  }
  const basePortions = boundedNumber(value.basePortions, "basePortions", {
    min: 1,
    max: 1000,
    allowNull: true,
  });
  if (!Array.isArray(value.ingredients) || value.ingredients.length < 1 || value.ingredients.length > 50) {
    throw new Error("The recipe extractor returned an invalid ingredient list.");
  }
  if (!Array.isArray(value.instructions) || value.instructions.length > 40) {
    throw new Error("The recipe extractor returned invalid cooking instructions.");
  }

  const ingredients = value.ingredients.map((item) => {
    const base = validateIngredientLine(item);
    const nutrition = item.nutrition
      ? validateIngredientNutrition(item.nutrition)
      : { calories: null, protein: null, carbs: null, fat: null };
    return { ...base, nutrition };
  });

  const totals = value.totals
    ? {
        calories: validateNutrition(value.totals.calories, "total calories", { allowNull: true }),
        protein: validateNutrition(value.totals.protein, "total protein", { allowNull: true }),
        carbs: validateNutrition(value.totals.carbs, "total carbs", { allowNull: true }),
        fat: validateNutrition(value.totals.fat, "total fat", { allowNull: true }),
      }
    : null;

  const steps = value.instructions.map((item) => boundedString(item, "instruction", 1500));
  const style = CATEGORY_STYLE[category];

  return {
    title,
    description,
    category,
    prepTimeMinutes,
    basePortions,
    emoji: style.emoji,
    color: style.color,
    ingredients,
    steps,
    totals,
  };
}
