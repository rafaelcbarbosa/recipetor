import { createHash } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { signClassMedia, verifyClassMedia } from "./media.js";

const MAX_CLASS_IMAGE_BYTES = 6 * 1024 * 1024;
const SIGNED_URL_TTL_MS = 60 * 60 * 1000;

function statusForError(code) {
  switch (code) {
    case "NOT_FOUND":
      return 404;
    case "FORBIDDEN":
    case "FORBIDDEN_VISIBILITY":
      return 403;
    case "NOT_AUTHENTICATED":
      return 401;
    case "ALREADY_MEMBER":
    case "ALREADY_POSTED":
    case "NOT_PENDING":
      return 409;
    case "RATE_LIMITED":
      return 429;
    default:
      return 400;
  }
}

const ERROR_MESSAGES = {
  NOT_FOUND: "Not found.",
  FORBIDDEN: "You do not have permission to do that.",
  FORBIDDEN_VISIBILITY: "Only the recipe owner can share it publicly.",
  NOT_AUTHENTICATED: "Sign in to continue.",
  INVALID_NAME: "Enter a name.",
  INVALID_TITLE: "Enter a title.",
  INVALID_CHILD: "Choose one of your children.",
  INVALID_RECIPE: "Choose a recipe you can see.",
  CHILD_REQUIRED: "Add at least one child's first name or nickname.",
  INVALID_CHILD_NAME: "Enter a child's first name or nickname.",
  TOO_MANY: "You can add up to 5 children.",
  ALREADY_MEMBER: "You are already in this class.",
  ALREADY_POSTED: "You already posted this child's Cook-Along.",
  NOT_PENDING: "That request was already handled.",
  CLOSED: "This Cook-Along is closed.",
  ARCHIVED: "This class is archived.",
  DECLINED: "Joining this class was declined.",
  REMOVED: "You were removed from this class.",
  LAST_ADMIN: "A class needs at least one admin.",
  SELF: "You cannot do that to yourself.",
  IN_CLASS_POST: "Delete the class post before making this recipe private.",
  NO_CLASS: "Choose at least one class.",
  INVALID_VISIBILITY: "Choose Private, Class only, or Public.",
  RATE_LIMITED: "Too many attempts. Try again later.",
  INVALID_IMAGE: "Upload a JPEG, PNG, or WebP image.",
  INVALID_REASON: "Choose a reason.",
};

function errorResponse(jsonResponse, response, error) {
  return jsonResponse(response, statusForError(error), {
    error: ERROR_MESSAGES[error] ?? "That didn't work.",
    code: error,
  });
}

export function createClassRouter({
  store,
  readJson,
  jsonResponse,
  checkSameOrigin,
  classMediaDir,
  mediaSecret,
  isAdminRequest = () => false,
  now = () => Date.now(),
}) {
  const joinAttempts = new Map();

  function signPost(post) {
    if (!post) return post;
    return {
      ...post,
      photoUrl:
        post.photoUrl && !post.photoUrl.startsWith("/")
          ? signClassMedia(post.photoUrl, mediaSecret, now() + SIGNED_URL_TTL_MS)
          : post.photoUrl,
    };
  }

  function signedPosts(posts) {
    return Array.isArray(posts) ? posts.map(signPost) : posts;
  }

  function requireUser(request) {
    const userId = request.userId ?? null;
    if (!userId) return null;
    return userId;
  }

  function joinLimitKey(request, userId) {
    const forwarded = request.headers["cf-connecting-ip"] || request.headers["x-forwarded-for"];
    const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0].trim() || request.socket.remoteAddress || "unknown";
    return `${userId}:${ip}`;
  }

  function checkJoinRate(request, userId) {
    const key = joinLimitKey(request, userId);
    const timestamp = now();
    const entry = joinAttempts.get(key);
    if (!entry || timestamp - entry.start > 60 * 60 * 1000) {
      joinAttempts.set(key, { start: timestamp, count: 1 });
      return true;
    }
    if (entry.count >= 20) return false;
    entry.count += 1;
    return true;
  }

  async function readImage(request) {
    const contentType = String(request.headers["content-type"] || "").split(";")[0].trim();
    const extension = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[contentType];
    if (!extension) return { error: "INVALID_IMAGE" };
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_CLASS_IMAGE_BYTES) return { error: "TOO_LARGE" };
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    if (buffer.length === 0) return { error: "INVALID_IMAGE" };
    return { buffer, extension };
  }

  function saveClassImage(buffer, extension) {
    const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 32);
    // Include a per-content random suffix only when the same image is reused.
    const filename = `${hash}.${extension}`;
    mkdirSync(classMediaDir, { recursive: true });
    const target = resolve(classMediaDir, filename);
    if (!existsSync(target)) writeFileSync(target, buffer, { mode: 0o644 });
    return filename;
  }

  function removeClassImage(filename) {
    if (!filename || filename.startsWith("/")) return;
    try {
      unlinkSync(resolve(classMediaDir, filename));
    } catch {
      // Already gone.
    }
  }

  async function route(request, response, pathname, url) {
    const method = request.method;
    const userId = request.userId ?? null;
    const admin = isAdminRequest(request);

    /* ---------------- Classes ---------------- */

    if (pathname === "/api/classes" && method === "GET") {
      if (!userId) return errorResponse(jsonResponse, response, "NOT_AUTHENTICATED");
      return jsonResponse(response, 200, {
        classes: store.classes.listClasses(userId),
        unread: store.classes.unreadNotificationCount(userId),
      });
    }

    if (pathname === "/api/classes" && method === "POST") {
      checkSameOrigin(request);
      if (!userId) return errorResponse(jsonResponse, response, "NOT_AUTHENTICATED");
      const body = await readJson(request);
      const result = store.classes.createClass(userId, {
        name: body?.name,
        description: body?.description,
        joinMode: body?.joinMode,
      });
      if (result.error) return errorResponse(jsonResponse, response, result.error);
      return jsonResponse(response, 200, result);
    }

    if (pathname === "/api/classes/lookup" && method === "GET") {
      const code = url.searchParams.get("code") ?? "";
      const found = store.classes.lookupClass(code);
      if (!found) return jsonResponse(response, 404, { error: "That class code doesn't work." });
      const membership = userId ? store.classes.getClassMembership(found.id, userId) : null;
      return jsonResponse(response, 200, {
        class: {
          id: found.id,
          name: found.name,
          description: found.description,
          joinMode: found.joinMode,
          accepting: found.accepting,
          archived: found.archived,
        },
        membership,
      });
    }

    if (pathname === "/api/classes/join" && method === "POST") {
      checkSameOrigin(request);
      if (!userId) return errorResponse(jsonResponse, response, "NOT_AUTHENTICATED");
      if (!checkJoinRate(request, userId)) return errorResponse(jsonResponse, response, "RATE_LIMITED");
      const body = await readJson(request);
      const result = store.classes.joinClass(userId, body?.code ?? "", body?.children ?? []);
      if (result.error) return errorResponse(jsonResponse, response, result.error);
      return jsonResponse(response, 200, result);
    }

    const classMatch = pathname.match(/^\/api\/classes\/([^/]+)$/);
    if (classMatch) {
      const classId = classMatch[1];
      if (!userId) return errorResponse(jsonResponse, response, "NOT_AUTHENTICATED");
      const membership = store.classes.getClassMembership(classId, userId);

      if (method === "GET") {
        if (!membership) return errorResponse(jsonResponse, response, "NOT_FOUND");
        if (membership.status === "declined") {
          return jsonResponse(response, 200, {
            class: null,
            membership,
            pending: false,
            declined: true,
          });
        }
        if (membership.status === "removed") {
          return jsonResponse(response, 200, { class: null, membership, pending: false, removed: true });
        }
        const detail = store.classes.getClassForUser(classId, userId);
        if (!detail) return errorResponse(jsonResponse, response, "NOT_FOUND");
        return jsonResponse(response, 200, {
          class: detail,
          membership,
          pending: membership.status === "pending",
          unread: store.classes.unreadNotificationCount(userId),
        });
      }

      if (method === "PATCH") {
        checkSameOrigin(request);
        const body = await readJson(request);
        const result = store.classes.updateClass(classId, userId, body ?? {});
        if (result.error) return errorResponse(jsonResponse, response, result.error);
        return jsonResponse(response, 200, result);
      }
    }

    const classActionMatch = pathname.match(/^\/api\/classes\/([^/]+)\/([a-z-]+)$/);
    if (classActionMatch) {
      checkSameOrigin(request);
      if (!userId) return errorResponse(jsonResponse, response, "NOT_AUTHENTICATED");
      const [, classId, action] = classActionMatch;
      if (action === "regenerate-code" && method === "POST") {
        const result = store.classes.regenerateJoinCode(classId, userId);
        if (result.error) return errorResponse(jsonResponse, response, result.error);
        return jsonResponse(response, 200, result);
      }
      if (action === "leave" && method === "POST") {
        const result = store.classes.leaveClass(classId, userId);
        if (result.error) return errorResponse(jsonResponse, response, result.error);
        return jsonResponse(response, 200, result);
      }
      if (action === "cancel-request" && method === "POST") {
        const result = store.classes.cancelJoinRequest(classId, userId);
        if (result.error) return errorResponse(jsonResponse, response, result.error);
        return jsonResponse(response, 200, result);
      }
      if (action === "members" && method === "GET") {
        if (!store.classes.approvedMembershipFor(classId, userId)) {
          return errorResponse(jsonResponse, response, "NOT_FOUND");
        }
        return jsonResponse(response, 200, { members: store.classes.listMembers(classId) });
      }
      if (action === "requests" && method === "GET") {
        if (!store.classes.isClassAdmin(classId, userId)) return errorResponse(jsonResponse, response, "FORBIDDEN");
        return jsonResponse(response, 200, { requests: store.classes.listJoinRequests(classId) });
      }
      if (action === "children" && method === "POST") {
        const body = await readJson(request);
        const result = store.classes.addChild(classId, userId, body?.displayName);
        if (result.error) return errorResponse(jsonResponse, response, result.error);
        return jsonResponse(response, 200, result);
      }
      if (action === "cook-alongs" && method === "GET") {
        const list = store.classes.listCookAlongs(classId, userId);
        if (!list) return errorResponse(jsonResponse, response, "NOT_FOUND");
        return jsonResponse(response, 200, { cookAlongs: list });
      }
      if (action === "cook-alongs" && method === "POST") {
        const body = await readJson(request);
        const result = store.classes.createCookAlong(classId, userId, {
          title: body?.title,
          prompt: body?.prompt,
          dueDate: body?.dueDate ?? null,
        });
        if (result.error) return errorResponse(jsonResponse, response, result.error);
        return jsonResponse(response, 200, result);
      }
      if (action === "gallery" && method === "GET") {
        if (!store.classes.approvedMembershipFor(classId, userId)) {
          return errorResponse(jsonResponse, response, "NOT_FOUND");
        }
        const cookAlongs = store.classes.listCookAlongs(classId, userId) ?? [];
        const gallery = [];
        for (const cookAlong of cookAlongs) {
          const posts = store.classes.listPosts(cookAlong.id, userId) ?? [];
          for (const post of posts) {
            gallery.push({ ...signedPosts([post])[0], cookAlongTitle: cookAlong.title, cookAlongId: cookAlong.id });
          }
        }
        gallery.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
        return jsonResponse(response, 200, {
          posts: gallery,
          canPresent: cookAlongs.length > 0,
        });
      }
      if (action === "cookbook" && method === "GET") {
        if (!store.classes.approvedMembershipFor(classId, userId)) {
          return errorResponse(jsonResponse, response, "NOT_FOUND");
        }
        const detail = store.classes.getClassForUser(classId, userId);
        const recipes = store.list(userId, false).filter((recipe) => {
          return Array.isArray(recipe.classIds) && recipe.classIds.includes(classId);
        });
        const cookAlongs = store.classes.listCookAlongs(classId, userId) ?? [];
        const postsByRecipe = new Map();
        for (const cookAlong of cookAlongs) {
          for (const post of store.classes.listPosts(cookAlong.id, userId) ?? []) {
            if (!postsByRecipe.has(post.recipeId)) postsByRecipe.set(post.recipeId, []);
            postsByRecipe.get(post.recipeId).push({ cookAlongTitle: cookAlong.title, createdAt: post.createdAt });
          }
        }
        const safeRecipes = store.public.getPublicRecipe
          ? recipes.map((recipe) => {
              const clone = { ...recipe };
              delete clone.userId;
              return {
                id: clone.id,
                title: clone.title,
                description: clone.description,
                imageUrl: clone.imageUrl,
                prepTimeMinutes: clone.prepTimeMinutes,
                baseServings: clone.basePortions,
                ingredients: clone.ingredients,
                steps: clone.steps,
                allergenTags: clone.allergenTags ?? [],
                postedIn: postsByRecipe.get(clone.id) ?? [],
              };
            })
          : [];
        return jsonResponse(response, 200, {
          class: detail,
          exportedAt: new Date(now()).toISOString(),
          recipes: safeRecipes,
        });
      }
    }

    const classMemberActionMatch = pathname.match(/^\/api\/classes\/([^/]+)\/members\/([^/]+)$/);
    if (classMemberActionMatch && method === "DELETE") {
      checkSameOrigin(request);
      if (!userId) return errorResponse(jsonResponse, response, "NOT_AUTHENTICATED");
      const result = store.classes.removeMember(classMemberActionMatch[1], classMemberActionMatch[2], userId);
      if (result.error) return errorResponse(jsonResponse, response, result.error);
      return jsonResponse(response, 200, result);
    }

    const classMemberAdminMatch = pathname.match(/^\/api\/classes\/([^/]+)\/members\/([^/]+)\/admin$/);
    if (classMemberAdminMatch && method === "POST") {
      checkSameOrigin(request);
      if (!userId) return errorResponse(jsonResponse, response, "NOT_AUTHENTICATED");
      const result = store.classes.addAdmin(classMemberAdminMatch[1], classMemberAdminMatch[2], userId);
      if (result.error) return errorResponse(jsonResponse, response, result.error);
      return jsonResponse(response, 200, result);
    }

    const classChildMatch = pathname.match(/^\/api\/classes\/([^/]+)\/children\/([^/]+)$/);
    if (classChildMatch && method === "DELETE") {
      checkSameOrigin(request);
      if (!userId) return errorResponse(jsonResponse, response, "NOT_AUTHENTICATED");
      const result = store.classes.deleteChild(classChildMatch[1], classChildMatch[2], userId);
      if (result.error) return errorResponse(jsonResponse, response, result.error);
      return jsonResponse(response, 200, result);
    }

    const requestActionMatch = pathname.match(/^\/api\/classes\/([^/]+)\/requests\/([^/]+)$/);
    if (requestActionMatch && method === "POST") {
      checkSameOrigin(request);
      if (!userId) return errorResponse(jsonResponse, response, "NOT_AUTHENTICATED");
      const body = await readJson(request);
      const result = store.classes.decideJoinRequest(
        requestActionMatch[1],
        requestActionMatch[2],
        userId,
        body?.decision === "decline" ? "decline" : "approve",
        body?.message ?? "",
      );
      if (result.error) return errorResponse(jsonResponse, response, result.error);
      return jsonResponse(response, 200, result);
    }

    if (pathname.match(/^\/api\/classes\/([^/]+)\/requests\/approve-all$/) && method === "POST") {
      checkSameOrigin(request);
      if (!userId) return errorResponse(jsonResponse, response, "NOT_AUTHENTICATED");
      const classId = pathname.match(/^\/api\/classes\/([^/]+)\/requests\/approve-all$/)[1];
      const result = store.classes.approveAll(classId, userId);
      if (result.error) return errorResponse(jsonResponse, response, result.error);
      return jsonResponse(response, 200, result);
    }

    /* ---------------- Cook-Alongs and posts ---------------- */

    const cookAlongMatch = pathname.match(/^\/api\/cook-alongs\/([^/]+)$/);
    if (cookAlongMatch) {
      if (!userId) return errorResponse(jsonResponse, response, "NOT_AUTHENTICATED");
      const cookAlong = store.classes.getCookAlong(cookAlongMatch[1], userId);
      if (!cookAlong) return errorResponse(jsonResponse, response, "NOT_FOUND");
      if (method === "GET") return jsonResponse(response, 200, { cookAlong });
      if (method === "PATCH") {
        checkSameOrigin(request);
        const body = await readJson(request);
        const result = store.classes.updateCookAlong(cookAlongMatch[1], userId, body ?? {});
        if (result.error) return errorResponse(jsonResponse, response, result.error);
        return jsonResponse(response, 200, result);
      }
    }

    const cookAlongPostsMatch = pathname.match(/^\/api\/cook-alongs\/([^/]+)\/posts$/);
    if (cookAlongPostsMatch) {
      if (!userId) return errorResponse(jsonResponse, response, "NOT_AUTHENTICATED");
      if (method === "GET") {
        const posts = store.classes.listPosts(cookAlongPostsMatch[1], userId);
        if (!posts) return errorResponse(jsonResponse, response, "NOT_FOUND");
        return jsonResponse(response, 200, { posts: signedPosts(posts) });
      }
      if (method === "POST") {
        checkSameOrigin(request);
        const body = await readJson(request);
        const result = store.classes.createPost(cookAlongPostsMatch[1], userId, {
          childId: body?.childId,
          recipeId: body?.recipeId,
          note: body?.note,
          visibility: body?.visibility,
        });
        if (result.error) return errorResponse(jsonResponse, response, result.error);
        return jsonResponse(response, 200, { post: signPost(result.post) });
      }
    }

    const postMatch = pathname.match(/^\/api\/posts\/([^/]+)$/);
    if (postMatch && method === "DELETE") {
      checkSameOrigin(request);
      if (!userId) return errorResponse(jsonResponse, response, "NOT_AUTHENTICATED");
      const result = store.classes.deletePost(postMatch[1], userId);
      if (result.error) return errorResponse(jsonResponse, response, result.error);
      if (result.photoFile) removeClassImage(result.photoFile);
      return jsonResponse(response, 200, { ok: true });
    }

    const postActionMatch = pathname.match(/^\/api\/posts\/([^/]+)\/(hide|unhide|photo)$/);
    if (postActionMatch) {
      checkSameOrigin(request);
      if (!userId) return errorResponse(jsonResponse, response, "NOT_AUTHENTICATED");
      const [, postId, action] = postActionMatch;
      if (action === "photo" && method === "POST") {
        const post = store.classes.getPost(postId, userId);
        if (!post) return errorResponse(jsonResponse, response, "NOT_FOUND");
        if (!post.isMine) return errorResponse(jsonResponse, response, "FORBIDDEN");
        const image = await readImage(request);
        if (image.error) {
          return jsonResponse(response, image.error === "TOO_LARGE" ? 413 : 415, {
            error: image.error === "TOO_LARGE" ? "Photo must be 6 MB or smaller." : ERROR_MESSAGES.INVALID_IMAGE,
          });
        }
        const filename = saveClassImage(image.buffer, image.extension);
        const result = store.classes.setPostPhoto(postId, userId, filename);
        if (result.error) {
          removeClassImage(filename);
          return errorResponse(jsonResponse, response, result.error);
        }
        return jsonResponse(response, 200, { post: signPost(result.post) });
      }
      if (method === "POST") {
        const result = store.classes.hidePost(postId, userId, action === "hide");
        if (result.error) return errorResponse(jsonResponse, response, result.error);
        return jsonResponse(response, 200, { post: signPost(result.post) });
      }
    }

    /* ---------------- Notifications ---------------- */

    if (pathname === "/api/notifications" && method === "GET") {
      if (!userId) return errorResponse(jsonResponse, response, "NOT_AUTHENTICATED");
      return jsonResponse(response, 200, {
        notifications: store.classes.listNotifications(userId),
        unread: store.classes.unreadNotificationCount(userId),
      });
    }

    if (pathname === "/api/notifications/read" && method === "POST") {
      checkSameOrigin(request);
      if (!userId) return errorResponse(jsonResponse, response, "NOT_AUTHENTICATED");
      const body = await readJson(request);
      return jsonResponse(response, 200, store.classes.markNotificationsRead(userId, Array.isArray(body?.ids) ? body.ids : null));
    }

    /* ---------------- Public recipes ---------------- */

    if (pathname === "/api/public/recipes" && method === "GET") {
      return jsonResponse(
        response,
        200,
        store.public.listPublicRecipes({
          query: url.searchParams.get("q") ?? "",
          page: url.searchParams.get("page") ?? 1,
          limit: url.searchParams.get("limit") ?? 24,
        }),
      );
    }

    const publicRecipeMatch = pathname.match(/^\/api\/public\/recipes\/([^/]+)$/);
    if (publicRecipeMatch && method === "GET") {
      const recipe = store.public.getPublicRecipe(publicRecipeMatch[1]);
      if (!recipe) return jsonResponse(response, 404, { error: "Recipe not found." });
      const favorite = userId ? store.isFavorite(userId, recipe.id) : false;
      return jsonResponse(response, 200, { recipe: { ...recipe, isFavorite: favorite } });
    }

    const publicPhotoMatch = pathname.match(/^\/api\/public\/recipes\/([^/]+)\/photo$/);
    if (publicPhotoMatch && method === "GET") {
      const recipe = store.public.getPublicRecipeRow(publicPhotoMatch[1]);
      if (!recipe) return jsonResponse(response, 404, { error: "Recipe not found." });
      const photos = store.classes.listPublicPhotosForRecipe(recipe.id);
      if (photos.length === 0) return jsonResponse(response, 404, { error: "No photo." });
      const filename = photos.find((candidate) => !candidate.startsWith("/"));
      if (!filename) return jsonResponse(response, 404, { error: "No photo." });
      const filePath = resolve(classMediaDir, filename);
      const extension = filename.split(".").pop()?.toLowerCase();
      const type = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" }[extension];
      if (!type || !existsSync(filePath)) return jsonResponse(response, 404, { error: "No photo." });
      const { readFileSync } = await import("node:fs");
      const content = readFileSync(filePath);
      response.writeHead(200, {
        "Content-Type": type,
        "Content-Length": content.length,
        "Cache-Control": "public, max-age=300",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(content);
      return true;
    }

    const publicReportMatch = pathname.match(/^\/api\/public\/recipes\/([^/]+)\/report$/);
    if (publicReportMatch && method === "POST") {
      checkSameOrigin(request);
      const body = await readJson(request);
      const result = store.public.createReport(publicReportMatch[1], userId, {
        reason: body?.reason,
        details: body?.details,
      });
      if (result.error) return errorResponse(jsonResponse, response, result.error);
      return jsonResponse(response, 200, result);
    }

    const publicFavoriteMatch = pathname.match(/^\/api\/public\/recipes\/([^/]+)\/favorite$/);
    if (publicFavoriteMatch && method === "POST") {
      checkSameOrigin(request);
      if (!userId) return errorResponse(jsonResponse, response, "NOT_AUTHENTICATED");
      const recipe = store.public.getPublicRecipe(publicFavoriteMatch[1]);
      if (!recipe) return errorResponse(jsonResponse, response, "NOT_FOUND");
      const added = store.addFavorite(userId, recipe.id);
      return jsonResponse(response, 200, { added, recipeId: recipe.id });
    }
    if (publicFavoriteMatch && method === "DELETE") {
      if (!userId) return errorResponse(jsonResponse, response, "NOT_AUTHENTICATED");
      store.removeFavorite(userId, publicFavoriteMatch[1]);
      return jsonResponse(response, 200, { ok: true });
    }

    /* ---------------- Site admin reports ---------------- */

    if (pathname === "/api/admin/reports" && method === "GET") {
      if (!userId) return errorResponse(jsonResponse, response, "NOT_AUTHENTICATED");
      if (!admin) return errorResponse(jsonResponse, response, "FORBIDDEN");
      return jsonResponse(response, 200, {
        reports: store.public.listReports({ status: url.searchParams.get("status") ?? "open" }),
        openCount: store.public.countOpenReports(),
      });
    }

    const resolveReportMatch = pathname.match(/^\/api\/admin\/reports\/([^/]+)\/resolve$/);
    if (resolveReportMatch && method === "POST") {
      checkSameOrigin(request);
      if (!userId) return errorResponse(jsonResponse, response, "NOT_AUTHENTICATED");
      if (!admin) return errorResponse(jsonResponse, response, "FORBIDDEN");
      const body = await readJson(request);
      const result = store.public.resolveReport(resolveReportMatch[1], userId, body?.action);
      if (result.error) return errorResponse(jsonResponse, response, result.error);
      return jsonResponse(response, 200, result);
    }

    /* ---------------- Recipe visibility ---------------- */

    const visibilityMatch = pathname.match(/^\/api\/recipes\/([^/]+)\/visibility$/);
    if (visibilityMatch && method === "PUT") {
      checkSameOrigin(request);
      if (!userId) return errorResponse(jsonResponse, response, "NOT_AUTHENTICATED");
      const body = await readJson(request);
      const result = store.setRecipeVisibility(
        visibilityMatch[1],
        body?.visibility,
        body?.classIds ?? [],
        userId,
        false,
      );
      if (result.error) return errorResponse(jsonResponse, response, result.error);
      return jsonResponse(response, 200, result);
    }

    /* ---------------- Signed class media ---------------- */

    if (pathname.startsWith("/media/class/") && (method === "GET" || method === "HEAD")) {
      const filename = decodeURIComponent(pathname.slice("/media/class/".length));
      const expires = url.searchParams.get("e");
      const signature = url.searchParams.get("s");
      if (!verifyClassMedia(filename, expires, signature, mediaSecret, now())) {
        return jsonResponse(response, 403, { error: "This photo link expired. Reload the class." });
      }
      const filePath = resolve(classMediaDir, filename);
      if (!existsSync(filePath)) return jsonResponse(response, 404, { error: "Not found." });
      const extension = filename.split(".").pop()?.toLowerCase();
      const type = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" }[extension];
      if (!type) return jsonResponse(response, 404, { error: "Not found." });
      const { readFileSync } = await import("node:fs");
      const content = readFileSync(filePath);
      response.writeHead(200, {
        "Content-Type": type,
        "Content-Length": content.length,
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(method === "HEAD" ? undefined : content);
      return true;
    }

    return false;
  }

  return route;
}
