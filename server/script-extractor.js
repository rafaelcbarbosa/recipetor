import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { validateRecipeResult } from "./recipe-schema.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT_PYTHON = resolve(ROOT, "extractor/.venv/bin/python");
const DEFAULT_SCRIPT = resolve(ROOT, "extractor/recipe_extract.py");
const DEFAULT_MEDIA_DIR = resolve(ROOT, "data/media");
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;
const STEP_RE = /^\[(\d+)\/(\d+)\]\s+(.+)$/;
const THUMBNAIL_RE = /thumbnail:\s*(?:cache hit\s*→\s*|using [^→]+→\s*)?(.+?\.jpg)(?:\s+\([^)]*\))?\s*$/i;

function envBool(name, fallback) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function stageForStep(label) {
  if (/^(fetching|downloading)\b/i.test(label)) return "fetching";
  if (/^validating\b/i.test(label)) return "saving";
  return "extracting";
}

function progressForStep(index, total) {
  if (!Number.isFinite(index) || !Number.isFinite(total) || total <= 0) return null;
  return Math.max(5, Math.min(95, Math.round((index / total) * 100)));
}

function friendlyError(payload, stderrTail) {
  const code = typeof payload?.error === "string" ? payload.error : "";
  const detail = typeof payload?.message === "string" ? payload.message.trim() : "";
  const error = new Error(
    code === "NO_RECIPE" || code === "INCOMPLETE_RECIPE"
      ? "No complete recipe found in this post."
      : code === "POST_INACCESSIBLE"
        ? "This Instagram post is private or unavailable."
        : detail || stderrTail || "The recipe extractor failed.",
  );
  if (code) error.code = code;
  return error;
}

function parseStdout(stdout) {
  const text = stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

/**
 * Extracts a recipe by running the vendored Python pipeline. Progress is read
 * from the script's stderr step lines so the queue can show live stages.
 */
export function createScriptExtractor({
  pythonBin = process.env.RECIPE_EXTRACTOR_PYTHON || DEFAULT_PYTHON,
  scriptPath = process.env.RECIPE_EXTRACTOR_SCRIPT || DEFAULT_SCRIPT,
  model = process.env.RECIPE_EXTRACTOR_MODEL || "beam-free",
  baseUrl = process.env.RECIPE_EXTRACTOR_BASE_URL || "",
  apiKey = process.env.RECIPE_EXTRACTOR_API_KEY || process.env.RECIPE_API_KEY || "",
  whisperModel = process.env.RECIPE_EXTRACTOR_WHISPER_MODEL || "medium",
  language = process.env.RECIPE_EXTRACTOR_LANGUAGE || "auto",
  ocrLangs = process.env.RECIPE_EXTRACTOR_OCR_LANGS || "por+eng",
  computeNutrition = envBool("RECIPE_EXTRACTOR_COMPUTE_NUTRITION", true),
  thumbnailWidth = envNumber("RECIPE_EXTRACTOR_THUMBNAIL_WIDTH", 480),
  timeoutMs = envNumber("RECIPE_EXTRACTOR_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
  mediaDir = process.env.RECIPETOR_MEDIA_DIR || DEFAULT_MEDIA_DIR,
} = {}) {
  return async function extractRecipe(url, { onProgress } = {}) {
    mkdirSync(mediaDir, { recursive: true });

    const args = [
      scriptPath,
      url,
      "--model", model,
      "--whisper-model", whisperModel,
      "--language", language,
      "--ocr-langs", ocrLangs,
      "--thumbnail-dir", mediaDir,
      "--thumbnail-width", String(thumbnailWidth),
    ];
    if (baseUrl) args.push("--base-url", baseUrl);
    if (apiKey) args.push("--api-key", apiKey);
    if (computeNutrition) args.push("--compute-nutrition");

    const expectedThumbnail = resolve(
      mediaDir,
      `${createHash("sha256").update(`${url}|${thumbnailWidth}`).digest("hex").slice(0, 32)}.jpg`,
    );

    return await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(pythonBin, args, {
        cwd: dirname(scriptPath),
        env: {
          ...process.env,
          PATH: `${dirname(pythonBin)}:${process.env.PATH ?? ""}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      });

      let stdout = "";
      let stdoutBytes = 0;
      let stderrTail = "";
      let stderrBytes = 0;
      let thumbnailPath = null;
      let timedOut = false;
      let overflow = false;
      let settled = false;
      let timer = null;

      function terminate(signal) {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch (error) {
          if (!(error instanceof Error) || error.name !== "ESRCH") {
            // The process has already exited; nothing left to kill.
          }
        }
      }

      function finish() {
        if (timer) clearTimeout(timer);
      }

      timer = setTimeout(() => {
        timedOut = true;
        terminate("SIGKILL");
      }, timeoutMs);

      const lines = createInterface({ input: child.stderr, crlfDelay: Infinity });
      lines.on("line", (line) => {
        if (stderrBytes < MAX_STDERR_BYTES) {
          stderrTail = `${stderrTail}${line}\n`.slice(-MAX_STDERR_BYTES);
          stderrBytes += line.length + 1;
        }

        const thumbnailMatch = THUMBNAIL_RE.exec(line);
        if (thumbnailMatch) thumbnailPath = thumbnailMatch[1].trim();

        const stepMatch = STEP_RE.exec(line);
        if (!stepMatch || typeof onProgress !== "function") return;
        const index = Number(stepMatch[1]);
        const total = Number(stepMatch[2]);
        const label = stepMatch[3].trim().slice(0, 160);
        const progress = progressForStep(index, total);
        if (progress == null) return;
        try {
          onProgress({ stage: stageForStep(label), progress, label });
        } catch {
          // Progress reporting must never break extraction.
        }
      });

      child.stdout.on("data", (chunk) => {
        if (overflow) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_STDOUT_BYTES) {
          overflow = true;
          terminate("SIGKILL");
          return;
        }
        stdout += chunk.toString("utf8");
      });

      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        finish();
        rejectPromise(new Error(`The recipe extractor could not start: ${error.message}`));
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        finish();

        if (timedOut) {
          rejectPromise(new Error("The recipe extractor timed out."));
          return;
        }
        if (overflow) {
          rejectPromise(new Error("The recipe extractor returned too much data."));
          return;
        }

        const payload = parseStdout(stdout);
        if (payload && typeof payload === "object" && !Array.isArray(payload) && "error" in payload) {
          rejectPromise(friendlyError(payload, stderrTail.trim().split("\n").slice(-1)[0]));
          return;
        }
        if (code !== 0 || !payload) {
          rejectPromise(
            new Error(
              stderrTail.trim().split("\n").slice(-1)[0] ||
                "The recipe extractor returned an invalid response.",
            ),
          );
          return;
        }

        let recipe;
        try {
          recipe = validateRecipeResult(payload);
        } catch (error) {
          rejectPromise(error instanceof Error ? error : new Error("The recipe extractor returned an invalid recipe."));
          return;
        }

        const candidate = thumbnailPath && existsSync(thumbnailPath) ? thumbnailPath : expectedThumbnail;
        if (existsSync(candidate) && statSync(candidate).isFile() && statSync(candidate).size > 0) {
          const destination = resolve(mediaDir, basename(candidate));
          if (resolve(candidate) !== destination) copyFileSync(candidate, destination);
          recipe.imageUrl = `/media/${basename(destination)}`;
        }

        resolvePromise(recipe);
      });
    });
  };
}

/**
 * Cheap readiness check used by /api/health. It does not run the pipeline.
 */
export function isScriptAvailable({
  pythonBin = process.env.RECIPE_EXTRACTOR_PYTHON || DEFAULT_PYTHON,
  scriptPath = process.env.RECIPE_EXTRACTOR_SCRIPT || DEFAULT_SCRIPT,
} = {}) {
  return existsSync(pythonBin) && existsSync(scriptPath);
}
