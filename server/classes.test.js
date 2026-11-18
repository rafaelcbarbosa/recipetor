import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer } from "./index.js";
import { createRecipeStore } from "./recipe-store.js";

const recipe = {
  title: "Class Lemon Pasta",
  description: "A bright lemon pasta.",
  category: "Dinner",
  prepTimeMinutes: 25,
  basePortions: 4,
  emoji: "🍽️",
  color: "lemon",
  ingredients: [
    { amount: 12, unit: "oz", name: "spaghetti", nutrition: { calories: 220, protein: 8, carbs: 43, fat: 1 } },
    { amount: 2, unit: "units", name: "lemons", nutrition: { calories: 34, protein: 1, carbs: 11, fat: 0 } },
  ],
  steps: ["Boil the pasta.", "Toss with lemon and butter."],
  totals: { calories: 219, protein: 7, carbs: 14, fat: 15 },
};

function createTestStore() {
  const directory = mkdtempSync(join(tmpdir(), "recipetor-classes-"));
  const databasePath = join(directory, "recipes.sqlite");
  const store = createRecipeStore(databasePath, {
    generateCode: () => "123456",
    emailSender: async () => true,
  });
  const distDir = join(directory, "dist");
  const mediaDir = join(directory, "media");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(
    join(distDir, "index.html"),
    `<!doctype html><html><head><title>Recipetor</title><meta name="description" content="App"></head><body><div id="root"></div></body></html>`,
  );
  return {
    store,
    mediaDir,
    distDir,
    cleanup() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function startServer(store, options = {}) {
  const server = createServer({ store, extractorAvailable: () => true, ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function stopServer(server) {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function request(baseUrl, path, { method = "GET", body, token } = {}) {
  const headers = { Origin: baseUrl };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createVerifiedUser(baseUrl, email) {
  await request(baseUrl, "/api/auth/register", { method: "POST", body: { email, password: "secret1" } });
  await request(baseUrl, "/api/auth/verify-email", { method: "POST", body: { email, code: "123456" } });
  const login = await request(baseUrl, "/api/auth/login", {
    method: "POST",
    body: { email, password: "secret1" },
  });
  return login.json();
}

async function setupClass(baseUrl, admin, { joinMode = "approve" } = {}) {
  const created = await request(baseUrl, "/api/classes", {
    method: "POST",
    token: admin.token,
    body: { name: "Thursday Cooking Club", joinMode },
  });
  assert.equal(created.status, 200);
  const createdBody = await created.json();
  const detail = await request(baseUrl, `/api/classes/${createdBody.class.id}`, { token: admin.token });
  const detailBody = await detail.json();
  return { classId: createdBody.class.id, joinCode: detailBody.class.joinCode };
}

test("approval flow, one-post-per-child, and pending families blocked by URL", async () => {
  const { store, cleanup, distDir, mediaDir } = createTestStore();
  const { server, baseUrl } = await startServer(store, { distDir, mediaDir });

  try {
    const admin = await createVerifiedUser(baseUrl, "teacher@example.com");
    const parent = await createVerifiedUser(baseUrl, "parent@example.com");
    const otherParent = await createVerifiedUser(baseUrl, "other@example.com");
    const { classId, joinCode } = await setupClass(baseUrl, admin);

    const join = await request(baseUrl, "/api/classes/join", {
      method: "POST",
      token: parent.token,
      body: { code: joinCode, children: ["Mia"] },
    });
    assert.equal(join.status, 200);
    assert.equal((await join.json()).pending, true);

    // A pending parent cannot open the gallery, even by URL.
    const blockedGallery = await request(baseUrl, `/api/classes/${classId}/gallery`, { token: parent.token });
    assert.equal(blockedGallery.status, 404);
    const blockedClass = await request(baseUrl, `/api/classes/${classId}`, { token: parent.token });
    const blockedBody = await blockedClass.json();
    assert.equal(blockedBody.pending, true);

    const requests = await (
      await request(baseUrl, `/api/classes/${classId}/requests`, { token: admin.token })
    ).json();
    assert.equal(requests.requests.length, 1);
    assert.equal(requests.requests[0].children[0].displayName, "Mia");

    // Joining as the second family while the first is still pending.
    const joinOther = await request(baseUrl, "/api/classes/join", {
      method: "POST",
      token: otherParent.token,
      body: { code: joinCode, children: ["Leo"] },
    });
    assert.equal(joinOther.status, 200);
    const parentMembership = await (
      await request(baseUrl, "/api/classes", { token: parent.token })
    ).json();
    assert.equal(parentMembership.classes[0].status, "pending");

    // Approve the first family only.
    const approved = await request(baseUrl, `/api/classes/${classId}/requests/${requests.requests[0].id}`, {
      method: "POST",
      token: admin.token,
      body: { decision: "approve" },
    });
    assert.equal(approved.status, 200);

    const detail = await (await request(baseUrl, `/api/classes/${classId}`, { token: parent.token })).json();
    assert.equal(detail.pending, false);
    assert.equal(detail.class.children[0].displayName, "Mia");

    // Switch the class to "anyone with the code" — pending families stay pending.
    const opened = await request(baseUrl, `/api/classes/${classId}`, {
      method: "PATCH",
      token: admin.token,
      body: { joinMode: "open" },
    });
    assert.equal(opened.status, 200);
    const stillPending = await (
      await request(baseUrl, `/api/classes/${classId}`, { token: otherParent.token })
    ).json();
    assert.equal(stillPending.pending, true);

    // Admin starts a Cook-Along.
    const cookAlongResponse = await request(baseUrl, `/api/classes/${classId}/cook-alongs`, {
      method: "POST",
      token: admin.token,
      body: { title: "Soup week", prompt: "Any soup." },
    });
    assert.equal(cookAlongResponse.status, 200);
    const cookAlong = (await cookAlongResponse.json()).cookAlong;

    const saved = store.saveImported("https://www.instagram.com/p/CLASSPOST/", recipe, parent.user.id);
    const recipeId = saved.recipe.id;
    const childId = detail.class.children[0].id;

    const post = await request(baseUrl, `/api/cook-alongs/${cookAlong.id}/posts`, {
      method: "POST",
      token: parent.token,
      body: { childId, recipeId, note: "Mia loved it" },
    });
    assert.equal(post.status, 200);
    const postBody = await post.json();
    assert.equal(postBody.post.childName, "Mia");

    // The recipe became Class only on first post.
    const classRecipe = await (await request(baseUrl, `/api/recipes/${recipeId}`, { token: parent.token })).json();
    assert.equal(classRecipe.recipe.visibility, "class");

    const duplicate = await request(baseUrl, `/api/cook-alongs/${cookAlong.id}/posts`, {
      method: "POST",
      token: parent.token,
      body: { childId, recipeId },
    });
    assert.equal(duplicate.status, 409);

    // Another family cannot post under someone else's child.
    const approvedOther = await request(baseUrl, "/api/classes/join", {
      method: "POST",
      token: otherParent.token,
      body: { code: joinCode, children: ["Leo"] },
    });
    // Still pending, so posting is forbidden.
    assert.equal(approvedOther.status, 200);
    const otherBlocked = await request(baseUrl, `/api/cook-alongs/${cookAlong.id}/posts`, {
      method: "POST",
      token: otherParent.token,
      body: { childId, recipeId },
    });
    assert.equal(otherBlocked.status, 403);

    // Admin can hide a post, but parents then cannot see it.
    const hide = await request(baseUrl, `/api/posts/${postBody.post.id}/hide`, { method: "POST", token: admin.token });
    assert.equal(hide.status, 200);
    const parentPosts = await (
      await request(baseUrl, `/api/cook-alongs/${cookAlong.id}/posts`, { token: parent.token })
    ).json();
    assert.equal(parentPosts.posts.length, 0);
    const adminPosts = await (
      await request(baseUrl, `/api/cook-alongs/${cookAlong.id}/posts`, { token: admin.token })
    ).json();
    assert.equal(adminPosts.posts.length, 1);

    // A group admin cannot publish a family's recipe.
    const forbidden = await request(baseUrl, `/api/recipes/${recipeId}/visibility`, {
      method: "PUT",
      token: admin.token,
      body: { visibility: "public" },
    });
    assert.equal(forbidden.status, 403);

    // The owner can.
    const published = await request(baseUrl, `/api/recipes/${recipeId}/visibility`, {
      method: "PUT",
      token: parent.token,
      body: { visibility: "public" },
    });
    assert.equal(published.status, 200);

    // Public API never exposes the child or class name.
    const publicRecipe = await (await request(baseUrl, `/api/public/recipes/${recipeId}`)).json();
    assert.equal(publicRecipe.recipe.visibility, "public");
    const serialized = JSON.stringify(publicRecipe);
    assert.ok(!serialized.includes("Mia"));
    assert.ok(!serialized.includes("Thursday Cooking Club"));

    const page = await fetch(`${baseUrl}/r/${recipeId}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Class Lemon Pasta/);
    assert.match(html, /og:title/);
    assert.ok(!html.includes("Mia"));
    assert.ok(!html.includes("Thursday Cooking Club"));

    // Regenerating the code rejects the old one.
    const regenerated = await request(baseUrl, `/api/classes/${classId}/regenerate-code`, {
      method: "POST",
      token: admin.token,
    });
    assert.equal(regenerated.status, 200);
    const stale = await request(baseUrl, "/api/classes/join", {
      method: "POST",
      token: otherParent.token,
      body: { code: joinCode, children: ["Leo"] },
    });
    assert.equal(stale.status, 404);

    // Deleting the recipe removes the post and the public page.
    const deleted = await request(baseUrl, `/api/recipes/${recipeId}`, { method: "DELETE", token: parent.token });
    assert.equal(deleted.status, 200);
    const gone = await fetch(`${baseUrl}/r/${recipeId}`);
    assert.equal(gone.status, 404);
    const postsAfter = await (
      await request(baseUrl, `/api/cook-alongs/${cookAlong.id}/posts`, { token: admin.token })
    ).json();
    assert.equal(postsAfter.posts.length, 0);
  } finally {
    await stopServer(server);
    cleanup();
  }
});

test("private and class-only recipes are filtered for other families", async () => {
  const { store, cleanup, distDir, mediaDir } = createTestStore();
  const { server, baseUrl } = await startServer(store, { distDir, mediaDir });

  try {
    const owner = await createVerifiedUser(baseUrl, "owner@example.com");
    const stranger = await createVerifiedUser(baseUrl, "stranger@example.com");
    const outsider = await createVerifiedUser(baseUrl, "outsider@example.com");
    const admin = await createVerifiedUser(baseUrl, "teacher@example.com");
    const saved = store.saveImported("https://www.instagram.com/p/PRIVATE1/", recipe, owner.user.id);

    const anonymous = await request(baseUrl, `/api/recipes/${saved.recipe.id}`);
    assert.equal(anonymous.status, 404);
    const anonymousPage = await fetch(`${baseUrl}/r/${saved.recipe.id}`);
    assert.equal(anonymousPage.status, 404);

    const strangerGet = await request(baseUrl, `/api/recipes/${saved.recipe.id}`, { token: stranger.token });
    assert.equal(strangerGet.status, 404);
    const strangerList = await (await request(baseUrl, "/api/recipes", { token: stranger.token })).json();
    assert.equal(strangerList.recipes.some((item) => item.id === saved.recipe.id), false);

    const ownerGet = await request(baseUrl, `/api/recipes/${saved.recipe.id}`, { token: owner.token });
    assert.equal(ownerGet.status, 200);

    const { classId, joinCode } = await setupClass(baseUrl, admin, { joinMode: "open" });
    const join = await request(baseUrl, "/api/classes/join", {
      method: "POST",
      token: stranger.token,
      body: { code: joinCode, children: ["Sam"] },
    });
    assert.equal(join.status, 200);
    assert.equal((await join.json()).pending, false);

    // Owners may only share into classes they belong to.
    const ownerJoin = await request(baseUrl, "/api/classes/join", {
      method: "POST",
      token: owner.token,
      body: { code: joinCode, children: ["Ada"] },
    });
    assert.equal(ownerJoin.status, 200);

    const classOnly = await request(baseUrl, `/api/recipes/${saved.recipe.id}/visibility`, {
      method: "PUT",
      token: owner.token,
      body: { visibility: "class", classIds: [classId] },
    });
    assert.equal(classOnly.status, 200);

    const strangerGetClass = await request(baseUrl, `/api/recipes/${saved.recipe.id}`, { token: stranger.token });
    assert.equal(strangerGetClass.status, 200);
    const outsiderGet = await request(baseUrl, `/api/recipes/${saved.recipe.id}`, { token: outsider.token });
    assert.equal(outsiderGet.status, 404);
    const ownerGetClass = await request(baseUrl, `/api/recipes/${saved.recipe.id}`, { token: owner.token });
    assert.equal(ownerGetClass.status, 200);
    const anonymousGetClass = await request(baseUrl, `/api/recipes/${saved.recipe.id}`);
    assert.equal(anonymousGetClass.status, 404);
    const publicPage = await fetch(`${baseUrl}/r/${saved.recipe.id}`);
    assert.equal(publicPage.status, 404);
  } finally {
    await stopServer(server);
    cleanup();
  }
});

test("class photos use signed links that expire and cannot be forged", async () => {
  const { store, cleanup, distDir, mediaDir } = createTestStore();
  const { server, baseUrl } = await startServer(store, { distDir, mediaDir });

  try {
    const admin = await createVerifiedUser(baseUrl, "teacher@example.com");
    const parent = await createVerifiedUser(baseUrl, "parent@example.com");
    const { classId, joinCode } = await setupClass(baseUrl, admin, { joinMode: "open" });
    await request(baseUrl, "/api/classes/join", {
      method: "POST",
      token: parent.token,
      body: { code: joinCode, children: ["Mia"] },
    });
    const detail = await (await request(baseUrl, `/api/classes/${classId}`, { token: parent.token })).json();
    const cookAlong = (
      await (
        await request(baseUrl, `/api/classes/${classId}/cook-alongs`, {
          method: "POST",
          token: admin.token,
          body: { title: "Photo week" },
        })
      ).json()
    ).cookAlong;
    const saved = store.saveImported("https://www.instagram.com/p/PHOTOPOST/", recipe, parent.user.id);
    const post = (
      await (
        await request(baseUrl, `/api/cook-alongs/${cookAlong.id}/posts`, {
          method: "POST",
          token: parent.token,
          body: { childId: detail.class.children[0].id, recipeId: saved.recipe.id },
        })
      ).json()
    ).post;

    const png = Buffer.from(
      "89504e470d0a1a0a0000000d494844520000000100000001080600000" +
        "01f15c4890000000d4944415478da63fcffff3f030005fe02fea72d" +
        "67250000000049454e44ae426082",
      "hex",
    );
    const upload = await fetch(`${baseUrl}/api/posts/${post.id}/photo`, {
      method: "POST",
      headers: { "Content-Type": "image/png", Origin: baseUrl, Authorization: `Bearer ${parent.token}` },
      body: png,
    });
    assert.equal(upload.status, 200);
    const uploaded = (await upload.json()).post;
    assert.match(uploaded.photoUrl, /^\/media\/class\/.+[?]e=\d+&s=/);

    const valid = await fetch(`${baseUrl}${uploaded.photoUrl}`);
    assert.equal(valid.status, 200);
    assert.equal(valid.headers.get("content-type"), "image/png");

    const forged = await fetch(`${baseUrl}${uploaded.photoUrl.replace(/s=[a-f0-9]+/, "s=deadbeefdeadbeefdeadbeefdeadbeef")}`);
    assert.equal(forged.status, 403);

    const expired = await fetch(`${baseUrl}${uploaded.photoUrl.replace(/e=\d+/, "e=1")}`);
    assert.equal(expired.status, 403);

    const anonymousList = await request(baseUrl, `/api/cook-alongs/${cookAlong.id}/posts`);
    assert.equal(anonymousList.status, 401);
  } finally {
    await stopServer(server);
    cleanup();
  }
});

test("removed families' children and posts disappear from other parents", async () => {
  const { store, cleanup, distDir, mediaDir } = createTestStore();
  const { server, baseUrl } = await startServer(store, { distDir, mediaDir });

  try {
    const admin = await createVerifiedUser(baseUrl, "teacher@example.com");
    const parent = await createVerifiedUser(baseUrl, "parent@example.com");
    const witness = await createVerifiedUser(baseUrl, "witness@example.com");
    const { classId, joinCode } = await setupClass(baseUrl, admin, { joinMode: "open" });
    await request(baseUrl, "/api/classes/join", {
      method: "POST",
      token: parent.token,
      body: { code: joinCode, children: ["Mia"] },
    });
    await request(baseUrl, "/api/classes/join", {
      method: "POST",
      token: witness.token,
      body: { code: joinCode, children: ["Noah"] },
    });
    const parentDetail = await (await request(baseUrl, `/api/classes/${classId}`, { token: parent.token })).json();
    const cookAlong = (
      await (
        await request(baseUrl, `/api/classes/${classId}/cook-alongs`, {
          method: "POST",
          token: admin.token,
          body: { title: "Week one" },
        })
      ).json()
    ).cookAlong;
    const saved = store.saveImported("https://www.instagram.com/p/REMOVED/", recipe, parent.user.id);
    await request(baseUrl, `/api/cook-alongs/${cookAlong.id}/posts`, {
      method: "POST",
      token: parent.token,
      body: { childId: parentDetail.class.children[0].id, recipeId: saved.recipe.id },
    });

    const members = await (await request(baseUrl, `/api/classes/${classId}/members`, { token: admin.token })).json();
    const parentMember = members.members.find((member) => member.userId === parent.user.id);
    assert.ok(parentMember);

    const removed = await request(baseUrl, `/api/classes/${classId}/members/${parentMember.id}`, {
      method: "DELETE",
      token: admin.token,
    });
    assert.equal(removed.status, 200);

    const witnessPosts = await (
      await request(baseUrl, `/api/cook-alongs/${cookAlong.id}/posts`, { token: witness.token })
    ).json();
    assert.equal(witnessPosts.posts.length, 0);

    const gallery = await (
      await request(baseUrl, `/api/classes/${classId}/gallery`, { token: admin.token })
    ).json();
    assert.equal(gallery.posts.length, 0);

    const removedDetail = await (await request(baseUrl, `/api/classes/${classId}`, { token: parent.token })).json();
    assert.equal(removedDetail.class, null);
    assert.equal(removedDetail.removed, true);
  } finally {
    await stopServer(server);
    cleanup();
  }
});

test("pending families can cancel, and parents manage only their own children", async () => {
  const { store, cleanup, distDir, mediaDir } = createTestStore();
  const { server, baseUrl } = await startServer(store, { distDir, mediaDir });

  try {
    const admin = await createVerifiedUser(baseUrl, "teacher@example.com");
    const parent = await createVerifiedUser(baseUrl, "parent@example.com");
    const other = await createVerifiedUser(baseUrl, "other@example.com");
    const { classId, joinCode } = await setupClass(baseUrl, admin);

    await request(baseUrl, "/api/classes/join", {
      method: "POST",
      token: parent.token,
      body: { code: joinCode, children: ["Mia"] },
    });
    const cancelled = await request(baseUrl, `/api/classes/${classId}/cancel-request`, {
      method: "POST",
      token: parent.token,
    });
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json()).cancelled, true);

    const requests = await (await request(baseUrl, `/api/classes/${classId}/requests`, { token: admin.token })).json();
    assert.equal(requests.requests.length, 0);
    const again = await request(baseUrl, `/api/classes/${classId}/cancel-request`, {
      method: "POST",
      token: parent.token,
    });
    assert.equal(again.status, 404);

    // Rejoin and get approved, then add and remove a child.
    const rejoin = await request(baseUrl, "/api/classes/join", {
      method: "POST",
      token: parent.token,
      body: { code: joinCode, children: ["Mia"] },
    });
    assert.equal(rejoin.status, 200);
    const pending = await (await request(baseUrl, `/api/classes/${classId}/requests`, { token: admin.token })).json();
    await request(baseUrl, `/api/classes/${classId}/requests/${pending.requests[0].id}`, {
      method: "POST",
      token: admin.token,
      body: { decision: "approve" },
    });

    const added = await request(baseUrl, `/api/classes/${classId}/children`, {
      method: "POST",
      token: parent.token,
      body: { displayName: "Leo" },
    });
    assert.equal(added.status, 200);
    const addedChild = (await added.json()).children.find((child) => child.displayName === "Leo");

    // Another approved family cannot delete this child.
    await request(baseUrl, "/api/classes/join", {
      method: "POST",
      token: other.token,
      body: { code: joinCode, children: ["Noa"] },
    });
    const otherRequests = await (
      await request(baseUrl, `/api/classes/${classId}/requests`, { token: admin.token })
    ).json();
    const otherRequest = otherRequests.requests.find((item) => item.userId === other.user.id);
    await request(baseUrl, `/api/classes/${classId}/requests/${otherRequest.id}`, {
      method: "POST",
      token: admin.token,
      body: { decision: "approve" },
    });
    const forbidden = await request(baseUrl, `/api/classes/${classId}/children/${addedChild.id}`, {
      method: "DELETE",
      token: other.token,
    });
    assert.equal(forbidden.status, 403);

    const removed = await request(baseUrl, `/api/classes/${classId}/children/${addedChild.id}`, {
      method: "DELETE",
      token: parent.token,
    });
    assert.equal(removed.status, 200);
    const detail = await (await request(baseUrl, `/api/classes/${classId}`, { token: parent.token })).json();
    assert.equal(detail.class.children.some((child) => child.id === addedChild.id), false);
  } finally {
    await stopServer(server);
    cleanup();
  }
});
