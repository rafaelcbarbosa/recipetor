import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(value, length) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function publicOrigin(request) {
  const configured = process.env.RECIPETOR_PUBLIC_ORIGIN || process.env.RECIPETOR_ORIGIN;
  if (configured) return configured.replace(/\/$/, "");
  const forwarded = request.headers["x-forwarded-proto"];
  const protocol = (Array.isArray(forwarded) ? forwarded[0] : forwarded) || "http";
  return `${protocol}://${request.headers.host ?? "localhost"}`;
}

function withMeta(html, { title, description, image, url, noindex = false, jsonLd = null }) {
  const tags = [
    `<title>${escapeHtml(title)}</title>`,
    `<meta name="description" content="${escapeHtml(description)}">`,
    `<meta property="og:type" content="article">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta property="og:url" content="${escapeHtml(url)}">`,
    `<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}">`,
    `<meta name="twitter:title" content="${escapeHtml(title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(description)}">`,
    noindex ? `<meta name="robots" content="noindex, nofollow">` : "",
    image ? `<meta property="og:image" content="${escapeHtml(image)}">` : "",
    jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, "\\u003c")}</script>` : "",
  ]
    .filter(Boolean)
    .join("\n    ");

  let output = html;
  // Drop the generic document title and description from the built shell.
  output = output.replace(/<title>[\s\S]*?<\/title>/i, "");
  output = output.replace(/<meta\s+name="description"[^>]*>/i, "");
  output = output.replace(/<\/head>/i, `    ${tags}\n  </head>`);
  return output;
}

function sendHtml(response, status, html) {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache",
    "Content-Length": Buffer.byteLength(html),
    "X-Content-Type-Options": "nosniff",
  });
  response.end(html);
  return true;
}

function notFoundPage(origin) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex, nofollow">
    <title>Recipe not found · Recipetor</title>
  </head>
  <body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f3ec;color:#29251f;font-family:system-ui,sans-serif;text-align:center;padding:24px">
    <main>
      <p style="font-size:44px;margin:0 0 8px">🥄</p>
      <h1 style="font-size:22px;margin:0 0 8px">This recipe isn't available</h1>
      <p style="color:#6b635a;margin:0 0 20px">It may have been made private, or the link is wrong.</p>
      <a href="${escapeHtml(origin)}/" style="display:inline-block;padding:12px 20px;border-radius:999px;background:#29251f;color:#fff;text-decoration:none">Open Recipetor</a>
    </main>
  </body>
</html>`;
}

export function createPublicPageHandler({ store, distDir, now = () => Date.now() }) {
  const indexPath = resolve(distDir, "index.html");

  function shell() {
    if (!existsSync(indexPath)) return null;
    return readFileSync(indexPath, "utf8");
  }

  return function handlePublicPage(request, response, pathname) {
    if (request.method !== "GET" && request.method !== "HEAD") return false;

    const recipeMatch = pathname.match(/^\/r\/([^/]+)\/?$/);
    if (recipeMatch) {
      const html = shell();
      const recipe = store.public.getPublicRecipe(recipeMatch[1]);
      if (!recipe) {
        return sendHtml(response, 404, notFoundPage(publicOrigin(request)));
      }
      if (!html) return false;
      const origin = publicOrigin(request);
      const url = `${origin}/r/${recipe.id}`;
      const description = truncate(
        recipe.description ||
          `${recipe.title} — a family recipe shared on Recipetor.${
            recipe.sourceCredit ? ` Source: ${recipe.sourceCredit}` : ""
          }`,
        200,
      );
      const image = recipe.imageUrl
        ? recipe.imageUrl.startsWith("http")
          ? recipe.imageUrl
          : `${origin}${recipe.imageUrl}`
        : null;
      const jsonLd = {
        "@context": "https://schema.org",
        "@type": "Recipe",
        name: recipe.title,
        description: recipe.description || undefined,
        recipeCategory: recipe.category || undefined,
        recipeCuisine: recipe.cuisine || undefined,
        prepTime: recipe.prepTimeMinutes ? `PT${recipe.prepTimeMinutes}M` : undefined,
        recipeYield: recipe.baseServings ? String(recipe.baseServings) : undefined,
        image: image || undefined,
        recipeIngredient: Array.isArray(recipe.ingredients)
          ? recipe.ingredients.map((item) =>
              [item.amount, item.unit, item.name].filter(Boolean).join(" ").trim(),
            )
          : undefined,
        recipeInstructions: Array.isArray(recipe.steps)
          ? recipe.steps.map((step) => ({ "@type": "HowToStep", text: step }))
          : undefined,
        url,
        isAccessibleForFree: true,
      };
      return sendHtml(
        response,
        200,
        withMeta(html, {
          title: `${recipe.title} · Recipetor`,
          description,
          image,
          url,
          jsonLd,
        }),
      );
    }

    if (/^\/(join|classes)(\/|$)/.test(pathname)) {
      const html = shell();
      if (!html) return false;
      return sendHtml(
        response,
        200,
        withMeta(html, {
          title: "Recipetor",
          description: "A private space for your cooking class.",
          image: null,
          url: `${publicOrigin(request)}${pathname}`,
          noindex: true,
        }),
      );
    }

    return false;
  };
}
