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
  signal?: AbortSignal;
  onRetry?: (error: BridgeError, attempt: number) => void;
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
      if (!bridgeError.retryable || attempt === attempts) throw bridgeError;
      onRetry?.(bridgeError, attempt);
    }
  }

  throw lastError ?? new BridgeError("INTERNAL", "The extraction failed.");
}
