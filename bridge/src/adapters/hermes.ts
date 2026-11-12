import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { BridgeError } from "../errors.ts";
import { buildPrompt } from "../prompt.ts";
import { validateRecipe, type Recipe } from "../recipe-schema.ts";
import type { ExtractOptions, ExtractorAdapter } from "./types.ts";

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_STDERR_CHARS = 2000;
const FORCE_KILL_DELAY_MS = 2000;

export interface HermesAdapterOptions {
  binary?: string;
  model?: string | null;
  provider?: string | null;
  maxOutputBytes?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function findJsonObjectEnd(output: string, start: number): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < output.length; index += 1) {
    const char = output[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return null;
}

function parseJsonResponse(output: string): unknown {
  // Models sometimes wrap the object in a markdown fence, add a trailing
  // sentence, or emit an extra closing brace. Walk to the first balanced
  // object instead of assuming the last brace belongs to it.
  let start = output.indexOf("{");
  let sawObject = false;

  while (start >= 0) {
    sawObject = true;
    const end = findJsonObjectEnd(output, start);
    if (end !== null) {
      try {
        return JSON.parse(output.slice(start, end + 1));
      } catch {
        // Keep looking: the model may have emitted prose containing braces
        // before the actual JSON object.
      }
    }
    start = output.indexOf("{", start + 1);
  }

  if (!sawObject) {
    throw new BridgeError("INVALID_MODEL_OUTPUT", "The extractor returned no JSON object.");
  }
  throw new BridgeError("INVALID_MODEL_OUTPUT", "The extractor returned invalid JSON.");
}

function errorSignal(value: unknown): BridgeError | null {
  const record = asRecord(value);
  if (!record) return null;
  if (record.error !== "POST_INACCESSIBLE" && record.error !== "NO_RECIPE") return null;
  const detail = typeof record.message === "string" ? record.message.trim().slice(0, 300) : "";
  const fallback =
    record.error === "POST_INACCESSIBLE"
      ? "This Instagram post is private or unavailable."
      : "No recipe found in this post.";
  return new BridgeError(record.error, detail || fallback);
}

function sanitizeStderr(stderr: string): string {
  return stderr.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").trim();
}

function runHermes(
  binary: string,
  args: string[],
  timeoutMs: number,
  maxOutputBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: tmpdir(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let timedOut = false;
    let overflow = false;
    let aborted = false;
    let forceKill: NodeJS.Timeout | undefined;
    let timeout: NodeJS.Timeout | undefined;

    function terminate(terminationSignal: NodeJS.Signals) {
      try {
        if (process.platform !== "win32" && child.pid) {
          process.kill(-child.pid, terminationSignal);
        } else {
          child.kill(terminationSignal);
        }
      } catch {
        // The process may already have exited.
      }
    }

    function stopChild() {
      terminate("SIGTERM");
      if (!forceKill) {
        forceKill = setTimeout(() => terminate("SIGKILL"), FORCE_KILL_DELAY_MS);
      }
    }

    function cleanup() {
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      signal?.removeEventListener("abort", onAbort);
    }

    function onAbort() {
      aborted = true;
      stopChild();
    }

    timeout = setTimeout(() => {
      timedOut = true;
      stopChild();
    }, timeoutMs);

    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > maxOutputBytes) {
        if (!overflow) {
          overflow = true;
          stopChild();
        }
      } else {
        stdout += chunk;
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < MAX_STDERR_CHARS) {
        stderr += chunk.slice(0, MAX_STDERR_CHARS - stderr.length);
      }
    });

    child.once("error", (error) => {
      cleanup();
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        reject(
          new BridgeError("MODEL_ERROR", `Hermes executable not found (${binary}).`, {
            retryable: false,
            cause: error,
          }),
        );
        return;
      }
      reject(new BridgeError("MODEL_ERROR", "Could not start Hermes.", { cause: error }));
    });

    child.once("close", (code) => {
      cleanup();
      if (aborted) {
        reject(
          new BridgeError("MODEL_ERROR", "The extraction was cancelled.", {
            retryable: false,
          }),
        );
        return;
      }
      if (timedOut) {
        reject(new BridgeError("MODEL_TIMEOUT", "The recipe extractor timed out."));
        return;
      }
      if (overflow) {
        reject(
          new BridgeError("MODEL_ERROR", "The model response exceeded the size limit.", {
            retryable: false,
          }),
        );
        return;
      }
      if (code !== 0) {
        const detail = sanitizeStderr(stderr);
        reject(
          new BridgeError(
            "MODEL_ERROR",
            `Hermes exited with status ${code}.${detail ? ` ${detail}` : ""}`,
          ),
        );
        return;
      }
      resolve(stdout);
    });
  });
}

function parseOutput(output: string): Recipe {
  const parsed = parseJsonResponse(output);

  const signal = errorSignal(parsed);
  if (signal) throw signal;

  const record = asRecord(parsed);
  if (record && Array.isArray(record.ingredients) && record.ingredients.length === 0) {
    throw new BridgeError("NO_RECIPE", "No recipe found in this post.");
  }

  return validateRecipe(parsed);
}

export function isHermesAvailable(binary = "hermes"): boolean {
  const result = spawnSync(binary, ["--version"], {
    cwd: tmpdir(),
    encoding: "utf8",
    timeout: 3000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0;
}

export function createHermesAdapter(options: HermesAdapterOptions = {}): ExtractorAdapter {
  const binary = options.binary || "hermes";
  const model = options.model || null;
  const provider = options.provider || null;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return {
    name: "hermes",
    model,
    provider,

    async extract(url: string, extractOptions: ExtractOptions): Promise<Recipe> {
      const args = ["-z", buildPrompt(url), "-t", "web", "--ignore-rules"];
      if (model) args.push("-m", model);
      if (provider) args.push("--provider", provider);

      const output = await runHermes(
        binary,
        args,
        extractOptions.timeoutMs,
        maxOutputBytes,
        extractOptions.signal,
      );
      return parseOutput(output);
    },

    async isAvailable(): Promise<boolean> {
      return isHermesAvailable(binary);
    },
  };
}
