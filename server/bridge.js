import { validateRecipeResult } from "./recipe-schema.js";

const DEFAULT_TIMEOUT_MS = 400_000;

const BRIDGE_ERROR_MESSAGES = new Map([
  ["INVALID_URL", "Use a public Instagram post or reel link."],
  ["UNAUTHORIZED", "The recipe extractor is not configured correctly."],
  ["RATE_LIMITED", "The recipe extractor is busy. Try again later."],
  ["BAD_REQUEST", "The recipe extractor rejected the request."],
  ["POST_INACCESSIBLE", "This Instagram post is private or unavailable."],
  ["NO_RECIPE", "No recipe found in this post."],
  ["INCOMPLETE_RECIPE", "No complete recipe found in this post."],
  ["MODEL_TIMEOUT", "The recipe extractor timed out."],
  ["MODEL_ERROR", "The recipe extractor failed. Try again."],
  ["INVALID_MODEL_OUTPUT", "The recipe extractor returned an invalid result."],
  ["INTERNAL", "The recipe extractor failed."],
]);

function bridgeEndpoint(baseUrl, path) {
  try {
    return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
  } catch {
    throw new Error("The recipe extractor is not configured correctly.");
  }
}

function effectiveTimeout(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Creates an extractor that calls the standalone bridge over HTTP. The bridge
 * owns prompts, model choice, retries, and timeouts; the app validates the
 * returned recipe again before storing it.
 */
export function createBridgeExtractor({
  baseUrl = process.env.RECIPE_BRIDGE_URL || "http://127.0.0.1:8790",
  token = process.env.RECIPE_BRIDGE_TOKEN || "",
  timeoutMs = Number(process.env.RECIPE_BRIDGE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  fetchImpl = fetch,
} = {}) {
  return async function extractRecipe(url) {
    if (!token) {
      throw new Error("The recipe extractor is not configured correctly.");
    }

    const endpoint = bridgeEndpoint(baseUrl, "/v1/extract");
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ url }),
        signal: AbortSignal.timeout(effectiveTimeout(timeoutMs, DEFAULT_TIMEOUT_MS)),
      });
    } catch (error) {
      if (error?.name === "TimeoutError") {
        throw new Error("The recipe extractor timed out.");
      }
      throw new Error("The recipe extractor is unavailable.");
    }

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const code = payload?.error?.code;
      const message =
        BRIDGE_ERROR_MESSAGES.get(code) ||
        (typeof payload?.error?.message === "string" && payload.error.message.trim()) ||
        "The recipe extractor failed.";
      const error = new Error(message);
      error.code = code;
      throw error;
    }

    if (!payload?.recipe) {
      throw new Error("The recipe extractor returned an invalid response.");
    }
    return validateRecipeResult(payload.recipe);
  };
}

/**
 * Checks whether the bridge is reachable and its extraction backend is ready.
 * Returns false instead of throwing so the app can still start and show status.
 */
export async function isBridgeAvailable({
  baseUrl = process.env.RECIPE_BRIDGE_URL || "http://127.0.0.1:8790",
  token = process.env.RECIPE_BRIDGE_TOKEN || "",
  timeoutMs = 3000,
  fetchImpl = fetch,
} = {}) {
  if (!token) return false;

  try {
    const endpoint = bridgeEndpoint(baseUrl, "/health");
    const response = await fetchImpl(endpoint, {
      signal: AbortSignal.timeout(effectiveTimeout(timeoutMs, 3000)),
    });
    if (!response.ok) return false;
    const payload = await response.json();
    return payload?.status === "ok" && payload?.hermesAvailable !== false;
  } catch {
    return false;
  }
}
