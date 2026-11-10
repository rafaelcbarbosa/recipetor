import { createServer as createHttpServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHermesExtractor, isHermesAvailable } from "./hermes.js";
import { createRecipeStore } from "./recipe-store.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MAX_REQUEST_BYTES = 2048;
const IMPORT_LIMIT = 10;
const IMPORT_WINDOW_MS = 60 * 60 * 1000;
const JWT_SECRET = process.env.RECIPETOR_JWT_SECRET || randomBytes(32).toString("hex");
const JWT_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
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

function base64UrlEncode(data) {
  return Buffer.from(data).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlDecode(data) {
  let base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const pad = base64.length % 4;
  if (pad) base64 += "=".repeat(4 - pad);
  return Buffer.from(base64, "base64").toString("utf8");
}

function signJwt(payload) {
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64UrlEncode(JSON.stringify(payload));
  const signatureInput = `${header}.${body}`;
  const signature = createHash("sha256").update(`${signatureInput}.${JWT_SECRET}`).digest();
  const encodedSig = base64UrlEncode(signature);
  return `${signatureInput}.${encodedSig}`;
}

function verifyJwt(token) {
  try {
    const [header, body, signature] = token.split(".");
    if (!header || !body || !signature) return null;
    const signatureInput = `${header}.${body}`;
    const expectedSignature = createHash("sha256").update(`${signatureInput}.${JWT_SECRET}`).digest();
    const encodedExpected = base64UrlEncode(expectedSignature);
    if (encodedExpected !== signature) return null;
    const payload = JSON.parse(base64UrlDecode(body));
    if (payload.exp && payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function extractUserId(request) {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  const payload = verifyJwt(token);
  return payload?.sub ?? null;
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

  // Serial job queue - processes one job at a time across all users
  const jobQueue = [];
  let isProcessing = false;

  async function processQueue() {
    if (isProcessing || jobQueue.length === 0) return;
    isProcessing = true;

    while (jobQueue.length > 0) {
      const { jobId, url, userId } = jobQueue.shift();
      try {
        store.updateExtractionJob(jobId, { status: "processing", stage: "queued", progress: 5 });
        console.log(`[queue] Job ${jobId}: Starting extraction for ${url}`);

        store.updateExtractionJob(jobId, { status: "processing", stage: "fetching", progress: 10 });

        store.updateExtractionJob(jobId, { status: "processing", stage: "extracting", progress: 30 });
        let extracted;
        try {
          extracted = await extractRecipe(url);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : "Unknown extraction error";
          console.error(`[queue] Job ${jobId}: Hermes extraction failed:`, errorMsg);
          store.updateExtractionJob(jobId, {
            status: "failed",
            stage: "failed",
            progress: 100,
            errorMessage: `Hermes extraction failed: ${errorMsg}`,
          });
          continue;
        }

        store.updateExtractionJob(jobId, { status: "processing", stage: "saving", progress: 70 });
        console.log(`[queue] Job ${jobId}: Hermes returned, saving recipe`);

        const saved = store.saveImported(url, extracted, userId);
        console.log(`[queue] Job ${jobId}: Recipe saved: ${saved.recipe.id}, duplicate: ${saved.duplicate}`);

        store.updateExtractionJob(jobId, {
          status: "completed",
          stage: "completed",
          progress: 100,
          recipeId: saved.recipe.id,
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : "Unknown error";
        console.error(`[queue] Job ${jobId}: Failed:`, errorMsg);
        store.updateExtractionJob(jobId, {
          status: "failed",
          stage: "failed",
          progress: 100,
          errorMessage: `Extraction failed: ${errorMsg}`,
        });
      }
    }

    isProcessing = false;
  }

  function enqueueJob(jobId, url, userId) {
    jobQueue.push({ jobId, url, userId });
    if (!isProcessing) {
      // Process asynchronously
      processQueue();
    }
  }

  async function handleRequest(request, response) {
    const pathname = new URL(request.url, "http://localhost").pathname;

    if (pathname === "/api/health" && request.method === "GET") {
      return jsonResponse(response, 200, { ok: true, hermesAvailable: hermesAvailable() });
    }
    if (pathname === "/api/auth/register" && request.method === "POST") {
      checkSameOrigin(request);
      const body = await readJson(request);
      const email = body?.email?.toString().trim().toLowerCase();
      const password = body?.password?.toString();
      if (!email || !email.includes("@")) return jsonResponse(response, 400, { error: "Valid email required." });
      if (!password || password.length < 6) return jsonResponse(response, 400, { error: "Password must be at least 6 characters." });
      try {
        const user = store.createUser(email, password);
        // User created but email not verified - return info about verification
        return jsonResponse(response, 200, { 
          user: { id: user.id, email: user.email }, 
          requiresVerification: true,
          message: "Account created. Please check your email for a verification code." 
        });
      } catch (error) {
        if (error.message === "Email already registered") return jsonResponse(response, 409, { error: "Email already registered." });
        throw error;
      }
    }
    if (pathname === "/api/auth/verify-email" && request.method === "POST") {
      checkSameOrigin(request);
      const body = await readJson(request);
      const email = body?.email?.toString().trim().toLowerCase();
      const code = body?.code?.toString().trim();
      if (!email || !code) return jsonResponse(response, 400, { error: "Email and verification code required." });
      const result = store.verifyEmailCode(email, code);
      if (!result.success) return jsonResponse(response, 400, { error: result.message });
      return jsonResponse(response, 200, { message: result.message });
    }
    if (pathname === "/api/auth/resend-verification" && request.method === "POST") {
      checkSameOrigin(request);
      const body = await readJson(request);
      const email = body?.email?.toString().trim().toLowerCase();
      if (!email) return jsonResponse(response, 400, { error: "Email required." });
      const result = store.resendVerificationCode(email);
      if (!result.success) return jsonResponse(response, 400, { error: result.message });
      return jsonResponse(response, 200, { message: result.message });
    }
    if (pathname === "/api/auth/login" && request.method === "POST") {
      checkSameOrigin(request);
      const body = await readJson(request);
      const email = body?.email?.toString().trim().toLowerCase();
      const password = body?.password?.toString();
      if (!email || !password) return jsonResponse(response, 400, { error: "Email and password required." });
      const user = store.verifyUser(email, password);
      if (!user) return jsonResponse(response, 401, { error: "Invalid email or password." });
      if (user.error === "EMAIL_NOT_VERIFIED") {
        return jsonResponse(response, 401, { error: user.message, requiresVerification: true, email });
      }
      const token = signJwt({ sub: user.id, email: user.email, exp: Date.now() + JWT_EXPIRY_MS });
      return jsonResponse(response, 200, { user: { id: user.id, email: user.email }, token });
    }
    if (pathname === "/api/auth/me" && request.method === "GET") {
      const userId = extractUserId(request);
      if (!userId) return jsonResponse(response, 401, { error: "Not authenticated." });
      const user = store.getUserById(userId);
      if (!user) return jsonResponse(response, 404, { error: "User not found." });
      return jsonResponse(response, 200, { user: { id: user.id, email: user.email } });
    }
    if (pathname === "/api/auth/delete-account" && request.method === "DELETE") {
      const userId = extractUserId(request);
      if (!userId) return jsonResponse(response, 401, { error: "Not authenticated." });
      const deleted = store.deleteUser(userId);
      if (!deleted) return jsonResponse(response, 404, { error: "User not found." });
      return jsonResponse(response, 200, { message: "Account deleted successfully" });
    }
    if (pathname === "/api/recipes" && request.method === "GET") {
      return jsonResponse(response, 200, { recipes: store.list() });
    }
    const singleRecipeMatch = pathname.match(/^\/api\/recipes\/([^/]+)$/);
    if (singleRecipeMatch && request.method === "GET") {
      const recipeId = singleRecipeMatch[1];
      const recipe = store.getRecipe(recipeId);
      if (!recipe) return jsonResponse(response, 404, { error: "Recipe not found." });
      return jsonResponse(response, 200, { recipe });
    }
    if (pathname === "/api/recipes/import" && request.method === "POST") {
      checkSameOrigin(request);
      const body = await readJson(request);
      const url = canonicalizeInstagramUrl(body?.url);
      console.log(`[import] URL: ${url}`);
      const userId = extractUserId(request);

      // Check if recipe already exists
      const existing = store.getBySource(url);
      if (existing) return jsonResponse(response, 200, { recipe: existing, duplicate: true, reason: "source" });

      // Check for existing job for this URL
      const existingJob = store.getExtractionJobByUrl(url);
      if (existingJob && existingJob.status !== "completed" && existingJob.status !== "failed") {
        return jsonResponse(response, 200, {
          job: existingJob,
          message: "Recipe extraction already in progress. Check status endpoint for progress.",
        });
      }

      // Create new extraction job
      const job = store.createExtractionJob(url, userId);

      // Add to serial queue
      enqueueJob(job.id, url, userId);

      return jsonResponse(response, 202, { job, message: "Extraction queued. Poll status endpoint for progress." });
    }

    // Queue view - get all extraction jobs
    if (pathname === "/api/recipes/import/queue" && request.method === "GET") {
      const jobs = store.listExtractionJobs();
      return jsonResponse(response, 200, { jobs });
    }

    // Get extraction job status by job ID
    if (pathname.match(/^\/api\/recipes\/import\/status\/([^/]+)$/) && request.method === "GET") {
      const jobId = pathname.match(/^\/api\/recipes\/import\/status\/([^/]+)$/)[1];
      const job = store.getExtractionJob(jobId);
      if (!job) return jsonResponse(response, 404, { error: "Job not found." });
      return jsonResponse(response, 200, { job });
    }

    // Get extraction job status by URL (latest job for URL)
    if (pathname === "/api/recipes/import/status/by-url" && request.method === "GET") {
      const urlSearchParams = new URL(request.url, "http://localhost").searchParams;
      const url = urlSearchParams.get("url");
      if (!url) return jsonResponse(response, 400, { error: "URL parameter required." });
      try {
        const canonicalUrl = canonicalizeInstagramUrl(url);
        const job = store.getExtractionJobByUrl(canonicalUrl);
        if (!job) return jsonResponse(response, 404, { error: "No extraction job found for this URL." });
        return jsonResponse(response, 200, { job });
      } catch {
        return jsonResponse(response, 400, { error: "Invalid Instagram URL." });
      }
    }

    const deleteMatch = pathname.match(/^\/api\/recipes\/([^/]+)$/);
    if (deleteMatch && request.method === "DELETE") {
      checkSameOrigin(request);
      const deleted = store.deleteRecipe(deleteMatch[1]);
      if (!deleted) return jsonResponse(response, 404, { error: "Recipe not found." });
      return jsonResponse(response, 200, { ok: true });
    }

    // Favorites endpoints
    if (pathname === "/api/favorites" && request.method === "GET") {
      const userId = extractUserId(request);
      if (!userId) return jsonResponse(response, 401, { error: "Authentication required." });
      const favoriteIds = store.listFavorites(userId);
      return jsonResponse(response, 200, { favorites: favoriteIds });
    }

    if (pathname === "/api/favorites" && request.method === "POST") {
      const userId = extractUserId(request);
      if (!userId) return jsonResponse(response, 401, { error: "Authentication required." });
      const body = await parseBody(request);
      const { recipeId } = body;
      if (!recipeId) return jsonResponse(response, 400, { error: "recipeId is required." });
      const added = store.addFavorite(userId, recipeId);
      return jsonResponse(response, 200, { added, recipeId });
    }

    const favoriteDeleteMatch = pathname.match(/^\/api\/favorites\/([^/]+)$/);
    if (favoriteDeleteMatch && request.method === "DELETE") {
      const userId = extractUserId(request);
      if (!userId) return jsonResponse(response, 401, { error: "Authentication required." });
      const recipeId = favoriteDeleteMatch[1];
      store.removeFavorite(userId, recipeId);
      return jsonResponse(response, 200, { ok: true, recipeId });
    }

    // History endpoint
    if (pathname === "/api/history" && request.method === "GET") {
      const userId = extractUserId(request);
      if (!userId) return jsonResponse(response, 401, { error: "Authentication required." });
      const history = store.getUserHistory(userId);
      return jsonResponse(response, 200, { history });
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
