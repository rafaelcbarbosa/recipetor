import { BridgeError } from "./errors.ts";

const CATEGORIES = new Set(["Breakfast", "Lunch", "Dinner", "Dessert", "Snack", "Other"]);
const MEAL_TYPES = ["Breakfast", "Lunch", "Dinner", "Dessert", "Snack"] as const;

const DIET_ALIASES: Record<string, string> = {
  vegan: "Vegan",
  vegetarian: "Vegetarian",
  "gluten-free": "Gluten-free",
  glutenfree: "Gluten-free",
  "gluten free": "Gluten-free",
  "low-carb": "Low-carb",
  lowcarb: "Low-carb",
  "low carb": "Low-carb",
  "dairy-free": "Dairy-free",
  dairyfree: "Dairy-free",
  "dairy free": "Dairy-free",
  pescatarian: "Pescatarian",
  "high-protein": "High-protein",
  highprotein: "High-protein",
};

function normalizeTagList(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const clean = item.trim().replace(/\s+/g, " ");
    if (!clean || clean.length > 40) continue;
    const tag = DIET_ALIASES[clean.toLowerCase()] ?? clean;
    if (seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    tags.push(tag);
    if (tags.length >= maxItems) break;
  }
  return tags;
}

function normalizeMealTypes(value: unknown, category: string): string[] {
  const fallback = category === "Other" ? [] : [category];
  if (!Array.isArray(value)) return fallback;
  const seen = new Set<string>();
  const meals: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const key = item.trim().toLowerCase();
    const meal = MEAL_TYPES.find(
      (candidate) =>
        candidate.toLowerCase() === key || (key === "snacks" && candidate === "Snack"),
    );
    if (!meal || seen.has(meal)) continue;
    seen.add(meal);
    meals.push(meal);
  }
  return meals.length ? meals : fallback;
}

export interface Nutrition {
  calories: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
}

export interface Ingredient {
  amount: number | null;
  unit: string;
  name: string;
  nutrition: Nutrition;
}

export interface Recipe {
  title: string;
  description: string;
  category: string;
  cuisine: string;
  mealTypes: string[];
  dietTags: string[];
  customTags: string[];
  prepTimeMinutes: number | null;
  basePortions: number | null;
  ingredients: Ingredient[];
  instructions: string[];
  totals: Nutrition | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function invalid(message: string): never {
  throw new BridgeError("INVALID_MODEL_OUTPUT", message);
}

function validateNutrition(value: unknown, name: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    invalid(`The extractor returned an invalid ${name}.`);
  }
  return value;
}

function validateIngredientNutrition(value: unknown): Nutrition {
  const record = asRecord(value);
  if (!record) invalid("The extractor returned invalid ingredient nutrition.");
  return {
    calories: validateNutrition(record.calories, "calories"),
    protein: validateNutrition(record.protein, "protein"),
    carbs: validateNutrition(record.carbs, "carbs"),
    fat: validateNutrition(record.fat, "fat"),
  };
}

function boundedString(
  value: unknown,
  name: string,
  maxLength: number,
  { allowEmpty = false }: { allowEmpty?: boolean } = {},
): string {
  if (typeof value !== "string") invalid(`The extractor returned an invalid ${name}.`);
  const clean = value.trim();
  if ((!allowEmpty && clean.length === 0) || clean.length > maxLength) {
    invalid(`The extractor returned an invalid ${name}.`);
  }
  return clean;
}

function boundedNumber(
  value: unknown,
  name: string,
  { min = 0, max = 10000, allowNull = false }: { min?: number; max?: number; allowNull?: boolean } = {},
): number | null {
  if (value === null || value === undefined) {
    if (allowNull) return null;
    invalid(`The extractor returned an invalid ${name}.`);
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    invalid(`The extractor returned an invalid ${name}.`);
  }
  return value;
}

function validateIngredientLine(value: unknown): Omit<Ingredient, "nutrition"> {
  const record = asRecord(value);
  if (!record) invalid("The extractor returned an invalid ingredient line.");
  return {
    amount: boundedNumber(record.amount, "amount", { min: 0, max: 100000, allowNull: true }),
    unit: boundedString(record.unit ?? "", "unit", 30, { allowEmpty: true }),
    name: boundedString(record.name, "ingredient name", 250),
  };
}

/**
 * Validates and normalizes a recipe returned by the model. Throws a
 * BridgeError with code INVALID_MODEL_OUTPUT when the shape is not usable, or
 * INCOMPLETE_RECIPE when it has ingredients but no method (usually a teaser
 * post), so the bridge can retry and then report NO_RECIPE.
 */
export function validateRecipe(value: unknown): Recipe {
  const record = asRecord(value);
  if (!record) invalid("The extractor returned an invalid recipe.");

  const title = boundedString(record.title, "title", 150);
  const description = boundedString(record.description ?? "", "description", 500, { allowEmpty: true });
  const category =
    typeof record.category === "string" && CATEGORIES.has(record.category) ? record.category : "Other";
  // Classification fields are best-effort. A missing or malformed value must
  // never discard an otherwise usable recipe.
  const cuisine =
    typeof record.cuisine === "string" ? record.cuisine.trim().slice(0, 50) : "";
  const mealTypes = normalizeMealTypes(record.mealTypes, category);
  const dietTags = normalizeTagList(record.dietTags, 8);
  const customTags = normalizeTagList(record.customTags, 10);

  const prepTimeMinutes = record.prepTimeMinutes ?? null;
  if (
    prepTimeMinutes !== null &&
    (typeof prepTimeMinutes !== "number" ||
      !Number.isInteger(prepTimeMinutes) ||
      prepTimeMinutes < 1 ||
      prepTimeMinutes > 1440)
  ) {
    invalid("The extractor returned an invalid preparation time.");
  }

  const basePortions = boundedNumber(record.basePortions, "basePortions", {
    min: 1,
    max: 1000,
    allowNull: true,
  });

  if (!Array.isArray(record.ingredients) || record.ingredients.length < 1 || record.ingredients.length > 50) {
    invalid("The extractor returned an invalid ingredient list.");
  }
  // An empty list is almost always a model failure rather than a recipe with
  // no method. Mark it retryable so the bridge tries again, and let the
  // extraction loop resolve it to NO_RECIPE if every attempt is incomplete.
  if (!Array.isArray(record.instructions) || record.instructions.length > 40) {
    invalid("The extractor returned invalid cooking instructions.");
  }
  if (record.instructions.length === 0) {
    throw new BridgeError("INCOMPLETE_RECIPE", "The extractor returned a recipe without cooking instructions.");
  }

  const ingredients = record.ingredients.map((item) => {
    const line = validateIngredientLine(item);
    const itemRecord = asRecord(item);
    const nutrition = itemRecord?.nutrition
      ? validateIngredientNutrition(itemRecord.nutrition)
      : { calories: null, protein: null, carbs: null, fat: null };
    return { ...line, nutrition };
  });

  const totalsRecord = asRecord(record.totals);
  const totals = totalsRecord
    ? {
        calories: validateNutrition(totalsRecord.calories, "total calories"),
        protein: validateNutrition(totalsRecord.protein, "total protein"),
        carbs: validateNutrition(totalsRecord.carbs, "total carbs"),
        fat: validateNutrition(totalsRecord.fat, "total fat"),
      }
    : null;
  // Models often return a totals object with every field null or zero when
  // the source has no nutrition data. Treat that as "unknown" so the app can
  // compute totals from ingredients instead of rendering null or 0 calories.
  const normalizedTotals =
    totals &&
    [totals.calories, totals.protein, totals.carbs, totals.fat].every(
      (value) => value === null || value === 0,
    )
      ? null
      : totals;

  const instructions = record.instructions.map((item) => boundedString(item, "instruction", 1500));

  return {
    title,
    description,
    category,
    cuisine,
    mealTypes,
    dietTags,
    customTags,
    prepTimeMinutes: prepTimeMinutes as number | null,
    basePortions,
    ingredients,
    instructions,
    totals: normalizedTotals,
  };
}
