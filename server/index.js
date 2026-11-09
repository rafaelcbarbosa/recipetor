import { createServer as createHttpServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHermesExtractor, isHermesAvailable } from "./hermes.js";
import { createRecipeStore } from "./recipe-store.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MAX_REQUEST_BYTES = 2048;
const IMPORT_LIMIT = 10;
const IMPORT_WINDOW_MS = 60 * 60 * 1000;
const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webmanifest", "application/manifest+json"],
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function canonicalizeInstagramUrl(input) {
  if (typeof input !== "string" || input.length > 2048) {
    throw new HttpError(400, "Enter a valid Instagram post or reel link.");
  }

  let url;
  try {
    url = new URL(input);
  } catch {
    throw new HttpError(400, "Enter a valid Instagram post or reel link.");
  }

  if (
    url.protocol !== "https:" ||
    !["instagram.com", "www.instagram.com"].includes(url.hostname.toLowerCase()) ||
    url.port ||
    !/^\/(?:p|reel|tv)\/[A-Za-z0-9_-]+\/?$/i.test(url.pathname)
  ) {
    throw new HttpError(400, "Use a public Instagram post or reel link.");
  }

  return `https://www.instagram.com${url.pathname.replace(/\/?$/, "/")}`;
}

function jsonResponse(response, status, value) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new HttpError(413, "Request is too large.");
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

function checkSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return;

  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw new HttpError(403, "Request origin is not allowed.");
  }

  const configuredOrigin = process.env.RECIPETOR_ORIGIN;
  if (
    (configuredOrigin && parsedOrigin.origin !== configuredOrigin) ||
    (!configuredOrigin && parsedOrigin.host !== request.headers.host)
  ) {
    throw new HttpError(403, "Request origin is not allowed.");
  }
}

function sendStaticFile(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  } catch {
    return false;
  }

  const distDirectory = resolve(ROOT, "dist");
  const requestedPath = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = resolve(distDirectory, requestedPath);
  if (filePath !== distDirectory && !filePath.startsWith(`${distDirectory}${sep}`)) return false;

  if (!existsSync(filePath)) {
    if (!extname(pathname) && existsSync(resolve(distDirectory, "index.html"))) {
      return sendFile(resolve(distDirectory, "index.html"), request, response);
    }
    return false;
  }
  return sendFile(filePath, request, response);
}

function sendFile(filePath, request, response) {
  const content = readFileSync(filePath);
  response.writeHead(200, {
    "Cache-Control": filePath.endsWith(`${sep}index.html`) || filePath === resolve(ROOT, "dist/index.html")
      ? "no-cache"
      : "public, max-age=31536000, immutable",
    "Content-Length": content.length,
    "Content-Type": MIME_TYPES.get(extname(filePath)) || "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(request.method === "HEAD" ? undefined : content);
  return true;
}

export function createServer({
  store,
  extractRecipe = createHermesExtractor(),
  hermesAvailable = () => isHermesAvailable(),
  now = () => Date.now(),
} = {}) {
  if (!store) throw new Error("A recipe store is required.");
  const rateLimits = new Map();
  const inFlight = new Map();

  async function handleRequest(request, response) {
    const pathname = new URL(request.url, "http://localhost").pathname;

    if (pathname === "/api/health" && request.method === "GET") {
      return jsonResponse(response, 200, { ok: true, hermesAvailable: hermesAvailable() });
    }
    if (pathname === "/api/recipes" && request.method === "GET") {
      return jsonResponse(response, 200, { recipes: store.list() });
    }
    if (pathname === "/api/recipes/import" && request.method === "POST") {
      checkSameOrigin(request);
      const body = await readJson(request);
      const url = canonicalizeInstagramUrl(body?.url);
      console.log(`[import] URL: ${url}`);
      const existing = store.getBySource(url);
      if (existing) return jsonResponse(response, 200, { recipe: existing, duplicate: true, reason: "source" });

      const pending = inFlight.get(url);
      if (pending) {
        const result = await pending;
        return jsonResponse(response, 200, { ...result, duplicate: true });
      }

      const key = request.socket.remoteAddress || "unknown";
      const timestamps = (rateLimits.get(key) || []).filter((timestamp) => now() - timestamp < IMPORT_WINDOW_MS);
      if (timestamps.length >= IMPORT_LIMIT) {
        throw new HttpError(429, "Too many recipe imports from this connection. Try again later.");
      }
      timestamps.push(now());
      rateLimits.set(key, timestamps);
      if (rateLimits.size > 2000) {
        for (const [client, events] of rateLimits) {
          if (events.every((timestamp) => now() - timestamp >= IMPORT_WINDOW_MS)) rateLimits.delete(client);
        }
      }

      const extraction = (async () => {
        let extracted;
        try {
          console.log(`[import] Calling Hermes for: ${url}`);
          extracted = await extractRecipe(url);
          console.log(`[import] Hermes returned, saving recipe`);
        } catch (error) {
          console.error("Recipe import failed:", error instanceof Error ? error.message : "Unknown error");
          const reason = error instanceof Error && error.message ? error.message : "Unknown extraction error.";
          throw new HttpError(502, `Hermes could not extract a recipe: ${reason}`);
        }

        const saved = store.saveImported(url, extracted);
        console.log(`[import] Recipe saved: ${saved.recipe.id}, duplicate: ${saved.duplicate}`);
        return {
          recipe: saved.recipe,
          duplicate: saved.duplicate,
          reason: saved.reason,
        };
      })();
      inFlight.set(url, extraction);
      try {
        return jsonResponse(response, 200, await extraction);
      } finally {
        inFlight.delete(url);
      }
    }

    const deleteMatch = pathname.match(/^\/api\/recipes\/([^/]+)$/);
    if (deleteMatch && request.method === "DELETE") {
      checkSameOrigin(request);
      const deleted = store.deleteRecipe(deleteMatch[1]);
      if (!deleted) return jsonResponse(response, 404, { error: "Recipe not found." });
      return jsonResponse(response, 200, { ok: true });
    }

    if (pathname.startsWith("/api/")) {
      return jsonResponse(response, 404, { error: "API endpoint not found." });
    }
    if (sendStaticFile(request, response)) return;
    return jsonResponse(response, 404, { error: "Not found." });
  }

  const server = createHttpServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof HttpError ? error.message : "The request could not be completed.";
      if (!(error instanceof HttpError)) {
        console.error("API request failed:", error instanceof Error ? error.message : "Unknown error");
      }
      jsonResponse(response, status, { error: message });
    });
  });
  return server;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const databasePath = process.env.RECIPETOR_DB_PATH || "./data/recipetor.sqlite";
  const store = createRecipeStore(databasePath);
  const server = createServer({ store });
  const host = process.env.RECIPETOR_HOST || "127.0.0.1";
  const port = Number(process.env.RECIPETOR_PORT || 8787);

  server.listen(port, host, () => {
    console.log(`Recipetor API listening on http://${host}:${port}`);
  });

  function shutdown() {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
