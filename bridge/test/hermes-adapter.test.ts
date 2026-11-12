import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { createHermesAdapter, isHermesAvailable } from "../src/adapters/hermes.ts";
import { BridgeError } from "../src/errors.ts";
import {
  cleanupFakeBinaries,
  fakeHermes,
  jsonOutputScript,
  RECIPE,
} from "../test-support/helpers.ts";

after(cleanupFakeBinaries);

const URL = "https://www.instagram.com/reel/ABC123/";

function rejectsWithCode(code: string, retryable?: boolean) {
  return (error: unknown) =>
    error instanceof BridgeError &&
    error.code === code &&
    (retryable === undefined || error.retryable === retryable);
}

test("parses a recipe from noisy stdout", async () => {
  const output = `working...\n${JSON.stringify(RECIPE)}\n`;
  const fake = fakeHermes(`process.stdout.write(${JSON.stringify(output)});`);
  const adapter = createHermesAdapter({ binary: fake.path });

  const recipe = await adapter.extract(URL, { timeoutMs: 5000 });
  assert.equal(recipe.title, RECIPE.title);
  assert.equal(recipe.ingredients.length, 2);
});

test("reports progress while Hermes is running", async () => {
  const output = JSON.stringify(RECIPE);
  const fake = fakeHermes(
    `setTimeout(() => process.stdout.write(${JSON.stringify(output)}), 120);`,
  );
  const messages: string[] = [];
  const adapter = createHermesAdapter({
    binary: fake.path,
    onLog: (message) => messages.push(message),
    progressIntervalMs: 30,
  });

  const recipe = await adapter.extract(URL, { timeoutMs: 5000 });
  assert.equal(recipe.title, RECIPE.title);
  assert.ok(messages.some((message) => message.includes("starting:")));
  assert.ok(messages.some((message) => message.includes("still running")));
  assert.ok(messages.some((message) => message.includes("first output")));
  assert.ok(messages.some((message) => message.includes("finished code=0")));
  assert.ok(messages.some((message) => message.includes("parsed recipe")));
});

test("parses JSON wrapped in a markdown fence with an extra closing brace", async () => {
  const output = `\`\`\`json\n${JSON.stringify(RECIPE)}}\n\`\`\``;
  const fake = fakeHermes(`process.stdout.write(${JSON.stringify(output)});`);
  const adapter = createHermesAdapter({ binary: fake.path });

  const recipe = await adapter.extract(URL, { timeoutMs: 5000 });
  assert.equal(recipe.title, RECIPE.title);
});

test("ignores prose after the JSON object", async () => {
  const output = `Here is the recipe:\n${JSON.stringify(RECIPE)}\nEnjoy!`;
  const fake = fakeHermes(`process.stdout.write(${JSON.stringify(output)});`);
  const adapter = createHermesAdapter({ binary: fake.path });

  const recipe = await adapter.extract(URL, { timeoutMs: 5000 });
  assert.equal(recipe.title, RECIPE.title);
});

test("rejects a malformed JSON object", async () => {
  const fake = fakeHermes('process.stdout.write("{not json}");');
  const adapter = createHermesAdapter({ binary: fake.path });

  await assert.rejects(
    adapter.extract(URL, { timeoutMs: 5000 }),
    rejectsWithCode("INVALID_MODEL_OUTPUT", true),
  );
});

const ARGS_SCRIPT = [
  'require("node:fs").writeFileSync(require("node:path").join(__dirname, "args.json"), JSON.stringify(process.argv));',
  jsonOutputScript(RECIPE),
].join("\n");

test("passes model and provider flags to Hermes", async () => {
  const fake = fakeHermes(ARGS_SCRIPT);

  const adapter = createHermesAdapter({
    binary: fake.path,
    model: "claude-sonnet-4",
    provider: "anthropic",
  });
  await adapter.extract(URL, { timeoutMs: 5000 });

  const args = JSON.parse(readFileSync(join(fake.dir, "args.json"), "utf8")) as string[];
  assert.equal(args[args.indexOf("-m") + 1], "claude-sonnet-4");
  assert.equal(args[args.indexOf("--provider") + 1], "anthropic");
  assert.equal(args[args.indexOf("-t") + 1], "web");
  assert.ok(args.includes("--ignore-rules"));
});

test("omits model and provider flags when not configured", async () => {
  const fake = fakeHermes(ARGS_SCRIPT);

  const adapter = createHermesAdapter({ binary: fake.path });
  await adapter.extract(URL, { timeoutMs: 5000 });

  const args = JSON.parse(readFileSync(join(fake.dir, "args.json"), "utf8")) as string[];
  assert.ok(!args.includes("-m"));
  assert.ok(!args.includes("--provider"));
});

test("rejects invalid JSON as INVALID_MODEL_OUTPUT", async () => {
  const fake = fakeHermes('process.stdout.write("this is not json");');
  const adapter = createHermesAdapter({ binary: fake.path });

  await assert.rejects(
    adapter.extract(URL, { timeoutMs: 5000 }),
    rejectsWithCode("INVALID_MODEL_OUTPUT", true),
  );
});

test("maps an empty ingredient list to NO_RECIPE", async () => {
  const fake = fakeHermes(jsonOutputScript({ ...RECIPE, ingredients: [] }));
  const adapter = createHermesAdapter({ binary: fake.path });

  await assert.rejects(
    adapter.extract(URL, { timeoutMs: 5000 }),
    rejectsWithCode("NO_RECIPE", false),
  );
});

test("maps a structured model error to POST_INACCESSIBLE", async () => {
  const fake = fakeHermes(
    jsonOutputScript({ error: "POST_INACCESSIBLE", message: "This post is private." }),
  );
  const adapter = createHermesAdapter({ binary: fake.path });

  await assert.rejects(
    adapter.extract(URL, { timeoutMs: 5000 }),
    (error) =>
      error instanceof BridgeError &&
      error.code === "POST_INACCESSIBLE" &&
      error.message === "This post is private.",
  );
});

test("maps a non-zero exit to a retryable MODEL_ERROR", async () => {
  const fake = fakeHermes('process.stderr.write("provider exploded"); process.exit(3);');
  const adapter = createHermesAdapter({ binary: fake.path });

  await assert.rejects(
    adapter.extract(URL, { timeoutMs: 5000 }),
    (error) =>
      error instanceof BridgeError &&
      error.code === "MODEL_ERROR" &&
      error.retryable &&
      /status 3/.test(error.message),
  );
});

test("times out a stuck Hermes process", async () => {
  const fake = fakeHermes('setTimeout(() => process.stdout.write("late"), 5000);');
  const adapter = createHermesAdapter({ binary: fake.path });
  const started = Date.now();

  await assert.rejects(
    adapter.extract(URL, { timeoutMs: 150 }),
    rejectsWithCode("MODEL_TIMEOUT", false),
  );
  assert.ok(Date.now() - started < 3000, "timeout should terminate the process promptly");
});

test("reports a missing Hermes binary without retrying", async () => {
  const adapter = createHermesAdapter({ binary: "/nonexistent/recipetor-hermes" });

  await assert.rejects(
    adapter.extract(URL, { timeoutMs: 5000 }),
    rejectsWithCode("MODEL_ERROR", false),
  );
});

test("checks Hermes availability", async () => {
  const fake = fakeHermes("process.exit(0);");
  assert.equal(isHermesAvailable(fake.path), true);
  assert.equal(isHermesAvailable("/nonexistent/recipetor-hermes"), false);
  assert.equal(await createHermesAdapter({ binary: fake.path }).isAvailable(), true);
});
