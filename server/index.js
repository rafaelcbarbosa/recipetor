import { createServer as createHttpServer } from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRecipeStore } from "./recipe-store.js";
import { createHttpExtractor, isHttpExtractorAvailable, useHttpExtractor } from "./http-extractor.js";
import { validateRecipeResult } from "./recipe-schema.js";
import { createScriptExtractor, isScriptAvailable } from "./script-extractor.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MAX_REQUEST_BYTES = 2048;
const IMPORT_LIMIT = 10;
const IMPORT_WINDOW_MS = 60 * 60 * 1000;
const JWT_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const ADMIN_EMAIL = (process.env.RECIPETOR_ADMIN_EMAIL || "coxinha@gmail.com").trim().toLowerCase();

// Keep sessions valid across restarts: use RECIPETOR_JWT_SECRET when provided,
// otherwise persist a generated secret next to the database.
function loadJwtSecret() {
  if (process.env.RECIPETOR_JWT_SECRET) return process.env.RECIPETOR_JWT_SECRET;
  const databasePath = process.env.RECIPETOR_DB_PATH || "./data/recipetor.sqlite";
  if (databasePath === ":memory:") return randomBytes(32).toString("hex");

  const secretPath = resolve(dirname(databasePath), ".jwt-secret");
  try {
    const existing = readFileSync(secretPath, "utf8").trim();
    if (existing) return existing;
  } catch {
    // Generate and persist below.
  }

  const secret = randomBytes(32).toString("hex");
  try {
    mkdirSync(dirname(secretPath), { recursive: true });
    writeFileSync(secretPath, secret, { mode: 0o600 });
    console.log(`Generated JWT secret at ${secretPath}`);
  } catch (error) {
    console.warn("Could not persist JWT secret; sessions will end on restart:", error instanceof Error ? error.message : "Unknown error");
  }
  return secret;
}

const JWT_SECRET = loadJwtSecret();
const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
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

function base64UrlToBuffer(data) {
  let base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const pad = base64.length % 4;
  if (pad) base64 += "=".repeat(4 - pad);
  return Buffer.from(base64, "base64");
}

function signJwt(payload) {
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64UrlEncode(JSON.stringify(payload));
  const signatureInput = `${header}.${body}`;
  const signature = createHmac("sha256", JWT_SECRET).update(signatureInput).digest();
  return `${signatureInput}.${base64UrlEncode(signature)}`;
}

function verifyJwt(token) {
  try {
    const [header, body, signature] = token.split(".");
    if (!header || !body || !signature) return null;
    const signatureInput = `${header}.${body}`;
    const expectedSignature = createHmac("sha256", JWT_SECRET).update(signatureInput).digest();
    const providedSignature = base64UrlToBuffer(signature);
    if (
      providedSignature.length !== expectedSignature.length ||
      !timingSafeEqual(providedSignature, expectedSignature)
    ) {
      return null;
    }
    const payload = JSON.parse(base64UrlDecode(body));
    if (payload.exp && payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function extractUser(request) {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  return verifyJwt(token);
}

function extractUserId(request) {
  return extractUser(request)?.sub ?? null;
}

function isAdminRequest(request) {
  return extractUser(request)?.email?.trim().toLowerCase() === ADMIN_EMAIL;
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

function sendMediaFile(request, response, mediaDirectory) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  } catch {
    return false;
  }
  if (!pathname.startsWith("/media/")) return false;

  const mediaRoot = resolve(mediaDirectory);
  const filePath = resolve(mediaRoot, pathname.slice("/media/".length));
  if (filePath === mediaRoot || !filePath.startsWith(`${mediaRoot}${sep}`)) return false;
  if (!existsSync(filePath)) return false;
  return sendFile(filePath, request, response);
}

function appVersion() {
  try {
    return JSON.parse(readFileSync(resolve(ROOT, "dist/commit-info.json"), "utf8")).hash ?? null;
  } catch {
    return null;
  }
}

function sendFile(filePath, request, response) {
  const content = readFileSync(filePath);
  response.writeHead(200, {
    "Cache-Control":
      filePath.endsWith(`${sep}index.html`) ||
      filePath === resolve(ROOT, "dist/index.html") ||
      filePath.endsWith("telemetry.html")
      ? "no-cache"
      : "public, max-age=31536000, immutable",
    "Content-Length": content.length,
    "Content-Type": MIME_TYPES.get(extname(filePath)) || "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(request.method === "HEAD" ? undefined : content);
  return true;
}

const defaultExtractor = useHttpExtractor()
  ? {
      backend: "http",
      extractRecipe: createHttpExtractor(),
      extractorAvailable: () => isHttpExtractorAvailable(),
    }
  : {
      backend: "script",
      extractRecipe: createScriptExtractor(),
      extractorAvailable: () => isScriptAvailable(),
    };

const DEFAULT_MEDIA_DIR = resolve(ROOT, "data/media");

export function createServer({
  store,
  extractRecipe = defaultExtractor.extractRecipe,
  extractorAvailable = defaultExtractor.extractorAvailable,
  extractorBackend = defaultExtractor.backend,
  mediaDir = resolve(process.env.RECIPETOR_MEDIA_DIR || DEFAULT_MEDIA_DIR),
  now = () => Date.now(),
} = {}) {
  if (!store) throw new Error("A recipe store is required.");
  const rateLimits = new Map();

  // Serial job queue - processes one job at a time across all users
  const jobQueue = [];
  let isProcessing = false;

  async function processQueue() {
    if (isProcessing || jobQueue.length === 0) return;
    isProcessing = true;

    while (jobQueue.length > 0) {
      const { jobId, url, userId } = jobQueue.shift();
      try {
        store.updateExtractionJob(jobId, {
          status: "processing",
          stage: "queued",
          progress: 5,
          stageLabel: null,
          startedAt: new Date().toISOString(),
        });
        console.log(`[queue] Job ${jobId}: Starting extraction for ${url}`);

        store.updateExtractionJob(jobId, { status: "processing", stage: "fetching", progress: 10, stageLabel: "Fetching post" });

        store.updateExtractionJob(jobId, { status: "processing", stage: "extracting", progress: 30, stageLabel: "Extracting recipe" });
        let extracted;
        try {
          extracted = await extractRecipe(url, {
            onProgress: ({ stage, progress, label }) => {
              store.updateExtractionJob(jobId, {
                status: "processing",
                stage,
                progress,
                ...(label ? { stageLabel: label } : {}),
              });
            },
          });
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : "Unknown extraction error";
          console.error(`[queue] Job ${jobId}: Extraction failed:`, errorMsg);
          store.updateExtractionJob(jobId, {
            status: "failed",
            stage: "failed",
            progress: 100,
            stageLabel: null,
            errorMessage: `Extraction failed: ${errorMsg}`,
          });
          continue;
        }

        store.updateExtractionJob(jobId, { status: "processing", stage: "saving", progress: 70, stageLabel: "Saving recipe" });
        console.log(`[queue] Job ${jobId}: Extraction finished, saving recipe`);

        const saved = store.saveImported(url, extracted, userId);
        store.recordEvent(userId, "import", saved.recipe.id);
        console.log(`[queue] Job ${jobId}: Recipe saved: ${saved.recipe.id}, duplicate: ${saved.duplicate}`);

        // The creator and every watcher get the finished recipe favorited and
        // added to their history.
        for (const watcherId of store.listJobWatchers(jobId)) {
          if (store.addFavorite(watcherId, saved.recipe.id)) {
            store.addToHistory(watcherId, saved.recipe.id, "added");
          }
        }

        store.updateExtractionJob(jobId, {
          status: "completed",
          stage: "completed",
          progress: 100,
          stageLabel: null,
          recipeId: saved.recipe.id,
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : "Unknown error";
        console.error(`[queue] Job ${jobId}: Failed:`, errorMsg);
        store.updateExtractionJob(jobId, {
          status: "failed",
          stage: "failed",
          progress: 100,
          stageLabel: null,
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

  function clientAddress(request) {
    const forwarded = request.headers["cf-connecting-ip"] || request.headers["x-forwarded-for"];
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    return value?.split(",")[0].trim() || request.socket.remoteAddress || "unknown";
  }

  function checkImportRateLimit(request) {
    const key = clientAddress(request);
    const timestamp = now();
    const entry = rateLimits.get(key);

    if (!entry || timestamp - entry.start >= IMPORT_WINDOW_MS) {
      rateLimits.set(key, { start: timestamp, count: 1 });
      return;
    }
    if (entry.count >= IMPORT_LIMIT) {
      throw new HttpError(429, "Too many imports from this connection. Try again later.");
    }
    entry.count += 1;

    if (rateLimits.size > 1000) {
      for (const [address, limit] of rateLimits) {
        if (timestamp - limit.start >= IMPORT_WINDOW_MS) rateLimits.delete(address);
      }
    }
  }

  // Re-enqueue jobs that were pending or mid-extraction when the process stopped.
  try {
    for (const job of store.listRecoverableExtractionJobs()) {
      store.updateExtractionJob(job.id, { status: "pending", stage: "queued", progress: 0, errorMessage: null });
      console.log(`[queue] Recovered job ${job.id} for ${job.url}`);
      enqueueJob(job.id, job.url, job.createdBy);
    }
  } catch (error) {
    console.error("[queue] Could not recover pending jobs:", error instanceof Error ? error.message : "Unknown error");
  }

  async function handleRequest(request, response) {
    const pathname = new URL(request.url, "http://localhost").pathname;

    if (pathname === "/api/health" && request.method === "GET") {
      let available = false;
      try {
        available = Boolean(await extractorAvailable());
      } catch {
        available = false;
      }
      return jsonResponse(response, 200, {
        ok: true,
        extractorAvailable: available,
        extractor: { backend: extractorBackend },
      });
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
    if (pathname === "/api/auth/forgot-password" && request.method === "POST") {
      checkSameOrigin(request);
      const body = await readJson(request);
      const email = body?.email?.toString().trim().toLowerCase();
      if (!email || !email.includes("@")) return jsonResponse(response, 400, { error: "Valid email required." });
      const result = store.createPasswordResetCode(email);
      if (!result.success) return jsonResponse(response, 400, { error: result.message });
      return jsonResponse(response, 200, { message: result.message });
    }
    if (pathname === "/api/auth/reset-password" && request.method === "POST") {
      checkSameOrigin(request);
      const body = await readJson(request);
      const email = body?.email?.toString().trim().toLowerCase();
      const code = body?.code?.toString().trim();
      const newPassword = body?.newPassword?.toString();
      if (!email || !code || !newPassword) return jsonResponse(response, 400, { error: "Email, code, and new password required." });
      if (newPassword.length < 6) return jsonResponse(response, 400, { error: "Password must be at least 6 characters." });
      const result = store.verifyPasswordResetCode(email, code, newPassword);
      if (!result.success) return jsonResponse(response, 400, { error: result.message });
      return jsonResponse(response, 200, { message: result.message });
    }
    if (pathname === "/api/auth/resend-password-reset" && request.method === "POST") {
      checkSameOrigin(request);
      const body = await readJson(request);
      const email = body?.email?.toString().trim().toLowerCase();
      if (!email) return jsonResponse(response, 400, { error: "Email required." });
      const result = store.resendPasswordResetCode(email);
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
      const userId = extractUserId(request);
      return jsonResponse(response, 200, { recipes: store.list(userId, isAdminRequest(request)) });
    }
    const singleRecipeMatch = pathname.match(/^\/api\/recipes\/([^/]+)$/);
    if (singleRecipeMatch && request.method === "GET") {
      const recipeId = singleRecipeMatch[1];
      const userId = extractUserId(request);
      const recipe = store.getRecipe(recipeId, userId, isAdminRequest(request));
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
      const existing = store.getBySource(url, userId, isAdminRequest(request));
      if (existing) {
        if (userId) {
          const completedJob = store
            .getExtractionJobsByUrl(url)
            .find((job) => job.status === "completed" && job.recipeId === existing.id);
          if (completedJob) store.addJobWatcher(completedJob.id, userId);
          if (store.addFavorite(userId, existing.id)) {
            store.addToHistory(userId, existing.id, "added");
          }
        }
        const recipe = store.getRecipe(existing.id, userId, isAdminRequest(request));
        return jsonResponse(response, 200, { recipe, duplicate: true, reason: "source" });
      }

      // Check for an active job for this URL first, so new submissions join
      // the retry instead of being blocked by an old failure.
      const existingJob = store.getExtractionJobByUrl(url);
      if (existingJob && existingJob.status !== "completed" && existingJob.status !== "failed") {
        if (userId) store.addJobWatcher(existingJob.id, userId);
        return jsonResponse(response, 200, {
          job: store.getPublicExtractionJob(existingJob.id, userId),
          message: "Recipe extraction already in progress. Check status endpoint for progress.",
        });
      }

      // A failed job stays visible for 24h. Ask the user before retrying it.
      const recentFailed = store.getRecentFailedJob(url);
      if (recentFailed) {
        if (userId) store.addJobWatcher(recentFailed.id, userId);
        return jsonResponse(response, 200, {
          alreadyFailed: true,
          job: store.getPublicExtractionJob(recentFailed.id, userId),
          message: "This link was tried before but it was not possible to extract the recipe.",
        });
      }

      // Only count real extraction work against the per-connection limit.
      checkImportRateLimit(request);

      // Create new extraction job
      const job = store.createExtractionJob(url, userId);

      // Add to serial queue
      enqueueJob(job.id, url, userId);

      return jsonResponse(response, 202, {
        job: {
          ...store.getPublicExtractionJob(job.id, userId),
          status: job.status,
          stage: job.stage,
          progress: job.progress,
        },
        message: "Extraction queued. Poll status endpoint for progress.",
      });
    }

    // Queue view - get all extraction jobs
    if (pathname === "/api/recipes/import/queue" && request.method === "GET") {
      const jobs = store.listPublicExtractionJobs(extractUserId(request));
      return jsonResponse(response, 200, { jobs });
    }

    // Retry a failed extraction without exposing the original URL.
    const retryMatch = pathname.match(/^\/api\/recipes\/import\/retry\/([^/]+)$/);
    if (retryMatch && request.method === "POST") {
      checkSameOrigin(request);
      const userId = extractUserId(request);
      if (!userId) return jsonResponse(response, 401, { error: "Authentication required." });
      const result = store.retryExtractionJob(retryMatch[1], userId);
      if (result.error === "NOT_FOUND") return jsonResponse(response, 404, { error: "Job not found." });
      if (result.error === "NOT_FAILED") return jsonResponse(response, 409, { error: "This job did not fail." });
      if (result.error === "FORBIDDEN") return jsonResponse(response, 403, { error: "Only the job's owner or watchers can retry it." });
      enqueueJob(result.job.id, store.getExtractionJob(result.job.id).url, userId);
      return jsonResponse(response, 202, { job: result.job });
    }

    // Save a manually entered recipe for a failed job, attaching its link.
    if (pathname === "/api/recipes/manual" && request.method === "POST") {
      checkSameOrigin(request);
      const userId = extractUserId(request);
      if (!userId) return jsonResponse(response, 401, { error: "Authentication required." });

      const body = await readJson(request);
      const jobId = body?.jobId ? String(body.jobId) : "";
      if (!jobId) return jsonResponse(response, 400, { error: "A failed job is required." });
      const job = store.getExtractionJob(jobId);
      if (!job) return jsonResponse(response, 404, { error: "Job not found." });
      if (job.created_by && job.created_by !== userId && !store.isJobWatcher(jobId, userId)) {
        return jsonResponse(response, 403, { error: "Only the job's creator or a watcher can add this recipe." });
      }

      let recipe;
      try {
        recipe = validateRecipeResult(body?.recipe);
      } catch (error) {
        return jsonResponse(response, 400, {
          error: error instanceof Error ? error.message : "The recipe is invalid.",
        });
      }

      const saved = store.saveImported(job.url, recipe, userId, isAdminRequest(request));
      store.recordEvent(userId, "manual_entry", saved.recipe.id);
      store.linkExtractionJobToRecipe(jobId, saved.recipe.id);
      for (const watcherId of store.listJobWatchers(jobId)) {
        if (store.addFavorite(watcherId, saved.recipe.id)) {
          store.addToHistory(watcherId, saved.recipe.id, "added");
        }
      }

      return jsonResponse(response, 200, {
        recipe: store.getRecipe(saved.recipe.id, userId, isAdminRequest(request)),
        job: store.getPublicExtractionJob(jobId, userId),
      });
    }

    // Get extraction job status by job ID
    if (pathname.match(/^\/api\/recipes\/import\/status\/([^/]+)$/) && request.method === "GET") {
      const jobId = pathname.match(/^\/api\/recipes\/import\/status\/([^/]+)$/)[1];
      const job = store.getPublicExtractionJob(jobId, extractUserId(request));
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
        return jsonResponse(response, 200, { job: store.getPublicExtractionJob(job.id, extractUserId(request)) });
      } catch {
        return jsonResponse(response, 400, { error: "Invalid Instagram URL." });
      }
    }

    const ingredientMatch = pathname.match(/^\/api\/recipes\/([^/]+)\/ingredients\/(\d+)$/);
    if (ingredientMatch && request.method === "PATCH") {
      checkSameOrigin(request);
      const userId = extractUserId(request);
      if (!userId) return jsonResponse(response, 401, { error: "Authentication required." });

      const body = await readJson(request);
      const changes = body && typeof body === "object" && !Array.isArray(body) ? body : {};
      const result = store.updateIngredient(
        ingredientMatch[1],
        Number(ingredientMatch[2]),
        changes,
        userId,
        isAdminRequest(request),
      );
      if (result.error) {
        const messages = {
          NOT_FOUND: "Recipe not found.",
          INVALID_RECIPE: "This recipe's ingredients cannot be edited.",
          INVALID_INDEX: "Ingredient not found.",
          NO_CHANGES: "Provide an amount or a unit.",
          INVALID_UNIT: "That unit is not supported.",
          INVALID_AMOUNT: "Amount must be a non-negative number.",
          INCOMPATIBLE_UNITS: "Those units cannot be converted.",
        };
        return jsonResponse(response, result.error === "NOT_FOUND" ? 404 : 400, {
          error: messages[result.error] ?? "Couldn't update the ingredient.",
        });
      }
      return jsonResponse(response, 200, { recipe: result.recipe });
    }

    const deleteMatch = pathname.match(/^\/api\/recipes\/([^/]+)$/);
    if (deleteMatch && request.method === "DELETE") {
      checkSameOrigin(request);
      const userId = extractUserId(request);
      if (!userId) return jsonResponse(response, 401, { error: "Authentication required." });

      const owner = store.getRecipeOwner(deleteMatch[1]);
      if (owner === undefined) return jsonResponse(response, 404, { error: "Recipe not found." });
      // The site owner can remove any recipe. Otherwise only the original loader may remove it.
      if (!isAdminRequest(request) && owner !== userId) {
        return jsonResponse(response, 403, { error: "Only the recipe's creator or the site owner can delete it." });
      }

      store.deleteRecipe(deleteMatch[1]);
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
      checkSameOrigin(request);
      const userId = extractUserId(request);
      if (!userId) return jsonResponse(response, 401, { error: "Authentication required." });
      const body = await readJson(request);
      const recipeId = body?.recipeId?.toString();
      if (!recipeId) return jsonResponse(response, 400, { error: "recipeId is required." });
      if (!store.getRecipe(recipeId)) return jsonResponse(response, 404, { error: "Recipe not found." });
      const added = store.addFavorite(userId, recipeId);
      if (added) store.recordEvent(userId, "favorite", recipeId);
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

    // Rating endpoints
    const ratingMatch = pathname.match(/^\/api\/recipes\/([^/]+)\/rating$/);
    if (ratingMatch && (request.method === "PUT" || request.method === "DELETE")) {
      checkSameOrigin(request);
      const userId = extractUserId(request);
      if (!userId) return jsonResponse(response, 401, { error: "Authentication required." });
      const recipeId = ratingMatch[1];
      if (!store.getRecipe(recipeId)) return jsonResponse(response, 404, { error: "Recipe not found." });

      if (request.method === "DELETE") {
        return jsonResponse(response, 200, { ok: true, ...store.removeRating(userId, recipeId) });
      }

      const body = await readJson(request);
      const rating = Number(body?.rating);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        return jsonResponse(response, 400, { error: "rating must be an integer from 1 to 5." });
      }
      const ratingResult = store.setRating(userId, recipeId, rating);
      store.recordEvent(userId, "rating", recipeId);
      return jsonResponse(response, 200, ratingResult);
    }

    // History endpoints
    if (pathname === "/api/history" && request.method === "GET") {
      const userId = extractUserId(request);
      if (!userId) return jsonResponse(response, 401, { error: "Authentication required." });
      const history = store.getUserHistory(userId, isAdminRequest(request));
      return jsonResponse(response, 200, { history });
    }

    if (pathname === "/api/history" && request.method === "POST") {
      checkSameOrigin(request);
      const userId = extractUserId(request);
      if (!userId) return jsonResponse(response, 401, { error: "Authentication required." });
      const body = await readJson(request);
      const recipeId = body?.recipeId?.toString();
      if (!recipeId) return jsonResponse(response, 400, { error: "recipeId is required." });
      if (!store.getRecipe(recipeId)) return jsonResponse(response, 404, { error: "Recipe not found." });
      const action = body?.action === "updated" ? "updated" : "added";
      store.addToHistory(userId, recipeId, action);
      return jsonResponse(response, 200, { ok: true, recipeId, action });
    }

    // Telemetry dashboard (admin only, not linked from the main app).
    if (pathname === "/telemetry" && (request.method === "GET" || request.method === "HEAD")) {
      const file = [resolve(ROOT, "dist/telemetry.html"), resolve(ROOT, "public/telemetry.html")].find(existsSync);
      if (!file) return jsonResponse(response, 404, { error: "Not found." });
      return sendFile(file, request, response);
    }
    if (pathname === "/api/telemetry" && request.method === "GET") {
      if (!isAdminRequest(request)) {
        return jsonResponse(response, 401, { error: "Admin authentication required." });
      }
      const data = store.telemetryData();
      return jsonResponse(response, 200, {
        ...data,
        status: {
          ok: true,
          version: appVersion(),
          uptimeSeconds: Math.round(process.uptime()),
          extractorBackend,
          extractorAvailable: await extractorAvailable(),
        },
      });
    }
    if (pathname === "/api/events/app-open" && request.method === "POST") {
      checkSameOrigin(request);
      store.recordEvent(extractUserId(request), "app_open");
      return jsonResponse(response, 200, { ok: true });
    }
    if (pathname === "/api/events/recipe-view" && request.method === "POST") {
      checkSameOrigin(request);
      const body = await readJson(request);
      const recipeId = body?.recipeId?.toString();
      if (!recipeId) return jsonResponse(response, 400, { error: "recipeId is required." });
      if (!store.getRecipe(recipeId)) return jsonResponse(response, 404, { error: "Recipe not found." });
      store.recordEvent(extractUserId(request), "recipe_view", recipeId);
      return jsonResponse(response, 200, { ok: true });
    }
    if (pathname.startsWith("/api/")) {
      return jsonResponse(response, 404, { error: "API endpoint not found." });
    }
    if (sendMediaFile(request, response, mediaDir)) return;
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
    const finish = () => {
      try {
        store.close();
      } catch {
        // The store may already be closed.
      }
      process.exit(0);
    };
    server.close(finish);
    server.closeAllConnections?.();
    setTimeout(finish, 5000).unref();
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
