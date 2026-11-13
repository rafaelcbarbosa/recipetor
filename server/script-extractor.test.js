import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createScriptExtractor, isScriptAvailable } from "./script-extractor.js";

const SUCCESS_FIXTURE = `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const mediaDir = process.argv[process.argv.indexOf("--thumbnail-dir") + 1];
const thumbnail = join(mediaDir, "thumb.jpg");
writeFileSync(thumbnail, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
console.error("[1/7] Fetching post metadata (yt-dlp)");
console.error("       done in 0.1s");
console.error("[2/7] Downloading media (yt-dlp)");
console.error("[3/7] Transcribing audio (faster-whisper: medium)");
console.error("[4/7] Reading on-screen text (tesseract: por+eng)");
console.error("[5/7] Generating thumbnail (480px JPEG)");
console.error(\`       thumbnail: \${thumbnail} (1 KB)\`);
console.error("[6/7] Extracting recipe (LLM: beam-free)");
console.error("[7/7] Validating recipe JSON");
console.log(JSON.stringify({
  title: "Test recipe",
  description: "A test.",
  category: "Dinner",
  cuisine: "Italian",
  mealTypes: ["Dinner"],
  dietTags: ["Vegetarian"],
  prepTimeMinutes: 10,
  basePortions: 2,
  ingredients: [
    { amount: 100, unit: "g", name: "test ingredient", nutrition: { calories: 50, protein: 1, carbs: 2, fat: 3 } },
  ],
  instructions: ["Do the thing."],
  totals: { calories: 25, protein: 0.5, carbs: 1, fat: 1.5 },
}));
`;

const NO_RECIPE_FIXTURE = `
console.error("[1/2] Fetching post metadata (yt-dlp)");
console.log(JSON.stringify({ error: "NO_RECIPE", message: "It is only a teaser." }));
`;

const TIMEOUT_FIXTURE = `
console.error("[1/2] Fetching post metadata (yt-dlp)");
setTimeout(() => {}, 60_000);
`;

function createFixture(source) {
  const directory = mkdtempSync(join(tmpdir(), "recipetor-script-extractor-"));
  const scriptPath = join(directory, "fixture.mjs");
  writeFileSync(scriptPath, source);
  return {
    directory,
    scriptPath,
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("runs the script, reports progress, validates the recipe, and attaches a thumbnail", async () => {
  const fixture = createFixture(SUCCESS_FIXTURE);
  const mediaDir = join(fixture.directory, "media");
  const extract = createScriptExtractor({
    pythonBin: process.execPath,
    scriptPath: fixture.scriptPath,
    mediaDir,
    timeoutMs: 5000,
  });

  try {
    const progress = [];
    const recipe = await extract("https://www.instagram.com/p/TEST/", {
      onProgress: (event) => progress.push(event),
    });

    assert.equal(recipe.title, "Test recipe");
    assert.equal(recipe.cuisine, "Italian");
    assert.deepEqual(recipe.mealTypes, ["Dinner"]);
    assert.equal(recipe.steps[0], "Do the thing.");
    assert.equal(recipe.imageUrl, "/media/thumb.jpg");

    assert.equal(progress.length, 7);
    assert.deepEqual(progress[0], {
      stage: "fetching",
      progress: 14,
      label: "Fetching post metadata (yt-dlp)",
    });
    assert.equal(progress[2].stage, "extracting");
    assert.equal(progress[2].label, "Transcribing audio (faster-whisper: medium)");
    assert.equal(progress[6].stage, "saving");
    assert.equal(progress[6].label, "Validating recipe JSON");
    assert.equal(progress[6].progress, 95);
  } finally {
    fixture.cleanup();
  }
});

test("maps NO_RECIPE to a friendly error", async () => {
  const fixture = createFixture(NO_RECIPE_FIXTURE);
  const extract = createScriptExtractor({
    pythonBin: process.execPath,
    scriptPath: fixture.scriptPath,
    mediaDir: join(fixture.directory, "media"),
    timeoutMs: 5000,
  });

  try {
    await assert.rejects(
      () => extract("https://www.instagram.com/p/TEASER/"),
      /No complete recipe found in this post/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("kills the script when it exceeds the timeout", async () => {
  const fixture = createFixture(TIMEOUT_FIXTURE);
  const extract = createScriptExtractor({
    pythonBin: process.execPath,
    scriptPath: fixture.scriptPath,
    mediaDir: join(fixture.directory, "media"),
    timeoutMs: 150,
  });

  try {
    await assert.rejects(
      () => extract("https://www.instagram.com/p/SLOW/"),
      /timed out/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("reports script availability from the interpreter and script paths", () => {
  const fixture = createFixture("console.log('{}');");
  try {
    assert.equal(
      isScriptAvailable({ pythonBin: process.execPath, scriptPath: fixture.scriptPath }),
      true,
    );
    assert.equal(
      isScriptAvailable({ pythonBin: join(fixture.directory, "missing"), scriptPath: fixture.scriptPath }),
      false,
    );
  } finally {
    fixture.cleanup();
  }
});
