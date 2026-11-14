import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateRecipeResult } from "./recipe-schema.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT_MEDIA_DIR = resolve(ROOT, "data/media");
const DEFAULT_TIMEOUT_MS = 16 * 60 * 1000;
const DEFAULT_POLL_MS = 1000;

function envBool(name, fallback) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function endpointFor(baseUrl, path) {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

function extractorError(message) {
  const error = new Error(message);
  return error;
}

function friendlyError(payload) {
  const code = typeof payload?.error_code === "string" ? payload.error_code : "";
  const detail = typeof payload?.error === "string" ? payload.error.trim() : "";
  if (code === "NO_RECIPE" || code === "INCOMPLETE_RECIPE") {
    return extractorError("No complete recipe found in this post.");
  }
  if (code === "POST_INACCESSIBLE") {
    return extractorError("This Instagram post is private or unavailable.");
  }
  if (code === "TIMEOUT") {
    return extractorError("The recipe extractor timed out.");
  }
  return extractorError(detail || "The recipe extractor failed.");
}

function wait(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

/**
 * Client for the extractor's job API. The heavy pipeline runs on another host;
 * this keeps progress polling and thumbnail storage on the Recipetor server.
 */
export function createHttpExtractor({
  baseUrl = process.env.RECIPE_EXTRACTOR_URL || "",
  token = process.env.RECIPE_EXTRACTOR_TOKEN || "",
  timeoutMs = envNumber("RECIPE_EXTRACTOR_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
  pollIntervalMs = envNumber("RECIPE_EXTRACTOR_POLL_MS", DEFAULT_POLL_MS),
  mediaDir = process.env.RECIPETOR_MEDIA_DIR || DEFAULT_MEDIA_DIR,
  computeNutrition = envBool("RECIPE_EXTRACTOR_COMPUTE_NUTRITION", true),
} = {}) {
  return async function extractRecipe(url, { onProgress } = {}) {
    if (!baseUrl) throw extractorError("The recipe extractor is not configured.");
    if (!token) throw extractorError("The recipe extractor is not configured correctly.");

    let createResponse;
    try {
      createResponse = await fetch(endpointFor(baseUrl, "/jobs"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Token": token,
        },
        body: JSON.stringify({ url, compute_nutrition: computeNutrition }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw extractorError("The recipe extractor is unavailable.");
    }
    if (createResponse.status === 401) {
      throw extractorError("The recipe extractor is not configured correctly.");
    }
    if (!createResponse.ok) {
      const body = await createResponse.json().catch(() => ({}));
      throw extractorError(body?.detail || body?.error || "The recipe extractor rejected the request.");
    }

    const created = await createResponse.json().catch(() => null);
    const jobId = created?.job_id;
    if (!jobId) throw extractorError("The recipe extractor returned an invalid response.");

    const deadline = Date.now() + timeoutMs;
    let lastLabel = null;

    while (true) {
      if (Date.now() > deadline) {
        throw extractorError("The recipe extractor timed out.");
      }
      await wait(pollIntervalMs);

      let response;
      try {
        response = await fetch(endpointFor(baseUrl, `/jobs/${encodeURIComponent(jobId)}`), {
          headers: { "X-API-Token": token },
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        // The tunnel may blip; keep polling until the deadline.
        continue;
      }
      if (response.status === 401) {
        throw extractorError("The recipe extractor is not configured correctly.");
      }
      if (response.status === 404) {
        throw extractorError("The recipe extractor lost this job. Try again.");
      }
      if (!response.ok) {
        continue;
      }

      const state = await response.json().catch(() => null);
      if (!state) continue;

      if (state.label && state.label !== lastLabel) {
        lastLabel = state.label;
        try {
          onProgress?.({
            stage: state.stage || "extracting",
            progress: Number.isFinite(Number(state.progress)) ? Number(state.progress) : 0,
            label: state.label,
          });
        } catch {
          // Progress reporting must never break extraction.
        }
      }

      if (state.status === "done") {
        let recipe;
        try {
          recipe = validateRecipeResult(state.recipe);
        } catch (error) {
          throw error instanceof Error
            ? error
            : extractorError("The recipe extractor returned an invalid recipe.");
        }

        if (state.thumbnail_id) {
          try {
            const thumbnail = await fetch(
              endpointFor(baseUrl, `/thumbnails/${encodeURIComponent(state.thumbnail_id)}.jpg`),
              { signal: AbortSignal.timeout(30_000) },
            );
            if (thumbnail.ok) {
              const buffer = Buffer.from(await thumbnail.arrayBuffer());
              if (buffer.length > 0) {
                mkdirSync(mediaDir, { recursive: true });
                writeFileSync(resolve(mediaDir, `${state.thumbnail_id}.jpg`), buffer);
                recipe.imageUrl = `/media/${state.thumbnail_id}.jpg`;
              }
            }
          } catch {
            // A missing thumbnail should not fail an otherwise valid recipe.
          }
        }
        return recipe;
      }

      if (state.status === "error") {
        throw friendlyError(state);
      }
    }
  };
}

export async function isHttpExtractorAvailable({
  baseUrl = process.env.RECIPE_EXTRACTOR_URL || "",
  token = process.env.RECIPE_EXTRACTOR_TOKEN || "",
  timeoutMs = 3000,
} = {}) {
  if (!baseUrl) return false;
  try {
    const response = await fetch(endpointFor(baseUrl, "/healthz"), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.status === "ok" && body?.token_configured !== false;
  } catch {
    return false;
  }
}

/**
 * Whether the app should use the HTTP extractor instead of the local script.
 */
export function useHttpExtractor() {
  return Boolean(process.env.RECIPE_EXTRACTOR_URL);
}
