export type UnitFamily = "mass" | "volume" | "count" | "other";

export type UnitGroup = {
  label: string;
  units: string[];
};

// Keep these canonical names in sync with the unit tables in server/recipe-store.js.
export const UNIT_GROUPS: UnitGroup[] = [
  { label: "Weight", units: ["g", "kg", "mg", "oz", "lb"] },
  { label: "Volume", units: ["ml", "l", "tsp", "tbsp", "cup", "fl oz", "pint", "quart", "gallon"] },
  { label: "Count", units: ["piece", "slice", "clove", "can", "package", "pinch", "bunch", "sprig", "stick", "head"] },
];

const MASS_UNITS = new Set(UNIT_GROUPS[0].units);
const VOLUME_UNITS = new Set(UNIT_GROUPS[1].units);
const COUNT_UNITS = new Set(UNIT_GROUPS[2].units);
const ALL_UNITS = new Set(UNIT_GROUPS.flatMap((group) => group.units));

const UNIT_ALIASES: Record<string, string> = {
  gram: "g",
  grams: "g",
  kilogram: "kg",
  kilograms: "kg",
  kilo: "kg",
  kilos: "kg",
  milligram: "mg",
  milligrams: "mg",
  ounce: "oz",
  ounces: "oz",
  pound: "lb",
  pounds: "lb",
  lbs: "lb",
  milliliter: "ml",
  milliliters: "ml",
  millilitre: "ml",
  millilitres: "ml",
  liter: "l",
  liters: "l",
  litre: "l",
  litres: "l",
  teaspoon: "tsp",
  teaspoons: "tsp",
  tablespoon: "tbsp",
  tablespoons: "tbsp",
  cups: "cup",
  floz: "fl oz",
  "fluid ounce": "fl oz",
  "fluid ounces": "fl oz",
  pints: "pint",
  quarts: "quart",
  gallons: "gallon",
  pieces: "piece",
  unit: "piece",
  units: "piece",
  slices: "slice",
  cloves: "clove",
  cans: "can",
  packages: "package",
  pkg: "package",
  pinches: "pinch",
  bunches: "bunch",
  sprigs: "sprig",
  sticks: "stick",
  heads: "head",
};

export function normalizeUnit(unit: string) {
  const text = String(unit ?? "")
    .trim()
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, " ");
  return UNIT_ALIASES[text] ?? text;
}

export function unitFamily(unit: string): UnitFamily {
  const canonical = normalizeUnit(unit);
  if (MASS_UNITS.has(canonical)) return "mass";
  if (VOLUME_UNITS.has(canonical)) return "volume";
  if (COUNT_UNITS.has(canonical)) return "count";
  return "other";
}

export function isConvertibleUnit(unit: string) {
  const family = unitFamily(unit);
  return family === "mass" || family === "volume";
}

export function compatibleUnits(unit: string): string[] {
  const family = unitFamily(unit);
  if (family === "mass") return UNIT_GROUPS[0].units;
  if (family === "volume") return UNIT_GROUPS[1].units;
  return [];
}

export function isKnownUnit(unit: string) {
  return ALL_UNITS.has(normalizeUnit(unit));
}
