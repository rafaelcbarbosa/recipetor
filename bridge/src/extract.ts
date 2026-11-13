import type { ExtractorAdapter } from "./adapters/types.ts";
import { BridgeError } from "./errors.ts";
import { PROMPT_VERSION } from "./prompt.ts";
import type { Recipe } from "./recipe-schema.ts";

export interface ExtractionMeta {
  backend: string;
  model: string | null;
  provider: string | null;
  durationMs: number;
  promptVersion: string;
  attempts: number;
}

export interface ExtractionResult {
  recipe: Recipe;
  meta: ExtractionMeta;
}

export interface ExtractRecipeOptions {
  adapter: ExtractorAdapter;
  url: string;
  timeoutMs: number;
  maxAttempts: number;
  /** Delay before retrying infrastructure failures. Defaults to 0. */
  retryDelayMs?: number;
  signal?: AbortSignal;
  onRetry?: (error: BridgeError, attempt: number, delayMs: number) => void;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new BridgeError("MODEL_ERROR", "The extraction was cancelled.", { retryable: false }));
      return;
    }

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new BridgeError("MODEL_ERROR", "The extraction was cancelled.", { retryable: false }));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function delayForRetry(error: BridgeError, attempt: number, baseMs: number): number {
  if (baseMs <= 0) return 0;
  // Model-quality retries are cheap and should happen immediately. Gateway
  // and provider failures need time to recover, so back off exponentially.
  if (error.code === "INCOMPLETE_RECIPE" || error.code === "INVALID_MODEL_OUTPUT") return 0;
  return Math.min(baseMs * 2 ** (attempt - 1), 120_000);
}

/**
 * Runs the adapter, retrying only errors the adapter marks as retryable
 * (invalid model output and transient model failures).
 */
export async function extractRecipe({
  adapter,
  url,
  timeoutMs,
  maxAttempts,
  retryDelayMs = 0,
  signal,
  onRetry,
}: ExtractRecipeOptions): Promise<ExtractionResult> {
  const started = Date.now();
  const attempts = Math.max(1, maxAttempts);
  let lastError: BridgeError | undefined;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal?.aborted) {
      throw new BridgeError("MODEL_ERROR", "The extraction was cancelled.", {
        retryable: false,
      });
    }

    try {
      const recipe = await adapter.extract(url, { timeoutMs, signal });
      return {
        recipe,
        meta: {
          backend: adapter.name,
          model: adapter.model,
          provider: adapter.provider,
          durationMs: Date.now() - started,
          promptVersion: PROMPT_VERSION,
          attempts: attempt,
        },
      };
    } catch (error) {
      const bridgeError =
        error instanceof BridgeError
          ? error
          : new BridgeError(
              "MODEL_ERROR",
              error instanceof Error ? error.message : "The extraction failed.",
              { cause: error },
            );
      lastError = bridgeError;
      if (!bridgeError.retryable || attempt === attempts) {
        // A post that keeps producing ingredients with no method is almost
        // certainly a teaser rather than a malformed recipe. Surface it as
        // NO_RECIPE so the app shows a clear message instead of an error.
        if (bridgeError.code === "INCOMPLETE_RECIPE") {
          throw new BridgeError("NO_RECIPE", "No complete recipe found in this post.", {
            cause: bridgeError,
          });
        }
        throw bridgeError;
      }
      const delayMs = delayForRetry(bridgeError, attempt, retryDelayMs);
      onRetry?.(bridgeError, attempt, delayMs);
      if (delayMs > 0) await sleep(delayMs, signal);
    }
  }

  throw lastError ?? new BridgeError("INTERNAL", "The extraction failed.");
}
