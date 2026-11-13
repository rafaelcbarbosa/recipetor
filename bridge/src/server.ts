import { timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { ExtractorAdapter } from "./adapters/types.ts";
import { loadConfig, requireBridgeToken, type BridgeConfig } from "./config.ts";
import { BridgeError, errorPayload } from "./errors.ts";
import { extractRecipe, type ExtractionResult } from "./extract.ts";
import { canonicalizeInstagramUrl } from "./url.ts";

const MAX_REQUEST_BYTES = 4096;
const HEALTH_CACHE_MS = 15_000;
const BRIDGE_VERSION = "0.1.0";

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const defaultLogger: Logger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

export interface BridgeServerOptions {
  config: BridgeConfig;
  adapter: ExtractorAdapter;
  version?: string;
  logger?: Logger;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new BridgeError("BAD_REQUEST", "Request is too large.");
    }
    chunks.push(buffer);
  }
  if (size === 0) {
    throw new BridgeError("BAD_REQUEST", "Request body must be valid JSON.");
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BridgeError("BAD_REQUEST", "Request body must be valid JSON.");
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

class Semaphore {
  private active = 0;
  private readonly max: number;
  private readonly waiting: Array<() => void> = [];

  constructor(max: number) {
    this.max = max;
  }

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.waiting.length;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
    } else {
      this.active -= 1;
    }
  }
}

export function createBridgeServer({
  config,
  adapter,
  version = BRIDGE_VERSION,
  logger = defaultLogger,
}: BridgeServerOptions): Server {
  requireBridgeToken(config);

  const limiter = new Semaphore(config.maxConcurrency);
  let healthCache: { at: number; available: boolean } | null = null;
  let rateState: { start: number; count: number } | null = null;

  function isAuthorized(request: IncomingMessage): boolean {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) return false;
    const provided = Buffer.from(header.slice(7), "utf8");
    const expected = Buffer.from(config.token, "utf8");
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  }

  function checkRateLimit(): number | null {
    if (config.rateLimit <= 0) return null;
    const now = Date.now();
    if (!rateState || now - rateState.start >= config.rateWindowMs) {
      rateState = { start: now, count: 1 };
      return null;
    }
    if (rateState.count >= config.rateLimit) {
      return Math.max(1, Math.ceil((rateState.start + config.rateWindowMs - now) / 1000));
    }
    rateState.count += 1;
    return null;
  }

  async function adapterAvailable(): Promise<boolean> {
    const now = Date.now();
    if (healthCache && now - healthCache.at < HEALTH_CACHE_MS) return healthCache.available;
    let available = false;
    try {
      available = await adapter.isAvailable();
    } catch {
      available = false;
    }
    healthCache = { at: now, available };
    return available;
  }

  async function handleExtract(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!isAuthorized(request)) {
      throw new BridgeError("UNAUTHORIZED", "A valid bridge token is required.");
    }

    const retryAfter = checkRateLimit();
    if (retryAfter !== null) {
      response.setHeader("Retry-After", String(retryAfter));
      throw new BridgeError("RATE_LIMITED", "Too many extraction requests. Try again later.");
    }

    const body = await readJson(request);
    const url = canonicalizeInstagramUrl(asRecord(body)?.url);

    const controller = new AbortController();
    const onClose = () => {
      if (!response.writableEnded) controller.abort();
    };
    response.on("close", onClose);

    try {
      logger.info(
        `[extract] ${url} accepted (active=${limiter.activeCount}, queued=${limiter.queuedCount}, timeout=${Math.round(config.timeoutMs / 1000)}s, attempts=${config.maxAttempts})`,
      );
      const queuedAt = Date.now();
      const result: ExtractionResult = await limiter.run(() => {
        logger.info(
          `[extract] ${url} started after ${((Date.now() - queuedAt) / 1000).toFixed(1)}s`,
        );
        return extractRecipe({
          adapter,
          url,
          timeoutMs: config.timeoutMs,
          maxAttempts: config.maxAttempts,
          retryDelayMs: config.retryDelayMs,
          signal: controller.signal,
          onRetry: (error, attempt, delayMs) => {
            logger.warn(
              `[extract] ${url} attempt ${attempt} failed (${error.code}): ${error.message}; retrying in ${Math.round(delayMs / 1000)}s`,
            );
          },
        });
      });

      sendJson(response, 200, result);
      logger.info(
        `[extract] ${url} ok backend=${result.meta.backend} model=${result.meta.model ?? "default"} attempts=${result.meta.attempts} duration=${result.meta.durationMs}ms`,
      );
    } finally {
      response.removeListener("close", onClose);
    }
  }

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;

    if (pathname === "/health") {
      if (request.method !== "GET") {
        throw new BridgeError("METHOD_NOT_ALLOWED", "Method not allowed.");
      }
      const available = await adapterAvailable();
      sendJson(response, 200, {
        status: available ? "ok" : "degraded",
        version,
        backend: config.backend,
        model: config.model || null,
        provider: config.provider || null,
        hermesAvailable: available,
      });
      return;
    }

    if (pathname === "/v1/extract") {
      if (request.method !== "POST") {
        throw new BridgeError("METHOD_NOT_ALLOWED", "Method not allowed.");
      }
      await handleExtract(request, response);
      return;
    }

    throw new BridgeError("NOT_FOUND", "Not found.");
  }

  return createHttpServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      const bridgeError =
        error instanceof BridgeError
          ? error
          : new BridgeError("INTERNAL", "The extraction failed.", { cause: error });
      const detail = error instanceof Error ? error.stack || error.message : String(error);
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      const context = `${request.method} ${pathname}`;

      if (bridgeError.status >= 500) {
        logger.error(`[request] ${context}: ${bridgeError.code} ${detail}`);
      } else {
        logger.warn(`[request] ${context}: ${bridgeError.code} ${bridgeError.message}`);
      }

      if (response.headersSent || response.destroyed) {
        response.destroy();
        return;
      }
      sendJson(response, bridgeError.status, errorPayload(bridgeError));
    });
  });
}

export function startBridgeServer(
  config: BridgeConfig,
  adapter: ExtractorAdapter,
  logger: Logger = defaultLogger,
): Server {
  const server = createBridgeServer({ config, adapter, logger });
  server.listen(config.port, config.host, () => {
    logger.info(
      `Recipetor bridge listening on http://${config.host}:${config.port} (backend=${config.backend}, model=${config.model || "hermes-default"}, provider=${config.provider || "hermes-default"})`,
    );
  });
  server.on("error", (error) => {
    logger.error(`Bridge server error: ${error.message}`);
  });
  return server;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const config = loadConfig();
    requireBridgeToken(config);
    const { createHermesAdapter } = await import("./adapters/hermes.ts");
    const adapter = createHermesAdapter({
      binary: config.hermesBin,
      model: config.model || null,
      provider: config.provider || null,
      onLog: config.verbose ? (message) => console.log(message) : undefined,
      progressIntervalMs: config.progressIntervalMs,
    });
    const server = startBridgeServer(config, adapter);

    const shutdown = () => {
      server.close(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Could not start the bridge.");
    process.exit(1);
  }
}
