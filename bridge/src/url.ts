import { BridgeError } from "./errors.ts";

/**
 * Accepts public Instagram post, reel, or TV links and returns a canonical URL.
 * Query strings and fragments are dropped so the same post maps to one URL.
 */
export function canonicalizeInstagramUrl(input: unknown): string {
  if (typeof input !== "string" || input.length > 2048) {
    throw new BridgeError("INVALID_URL", "Enter a valid Instagram post or reel link.");
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new BridgeError("INVALID_URL", "Enter a valid Instagram post or reel link.");
  }

  if (
    url.protocol !== "https:" ||
    !["instagram.com", "www.instagram.com"].includes(url.hostname.toLowerCase()) ||
    url.port ||
    !/^\/(?:p|reel|tv)\/[A-Za-z0-9_-]+\/?$/i.test(url.pathname)
  ) {
    throw new BridgeError("INVALID_URL", "Use a public Instagram post or reel link.");
  }

  return `https://www.instagram.com${url.pathname.replace(/\/?$/, "/")}`;
}
