import { createHmac, timingSafeEqual } from "node:crypto";
import { createHash } from "node:crypto";

export const CLASS_MEDIA_PREFIX = "/media/class/";

export function classMediaFileName(buffer, extension) {
  const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 32);
  return `${hash}.${extension}`;
}

export function signClassMedia(filename, secret, expiresAt) {
  const payload = `${filename}:${expiresAt}`;
  const signature = createHmac("sha256", secret).update(payload).digest("hex").slice(0, 32);
  return `${CLASS_MEDIA_PREFIX}${encodeURIComponent(filename)}?e=${expiresAt}&s=${signature}`;
}

export function verifyClassMedia(filename, expires, signature, secret, now = Date.now()) {
  if (!filename || !expires || !signature) return false;
  const expiresAt = Number(expires);
  if (!Number.isFinite(expiresAt) || expiresAt < now) return false;
  const expected = createHmac("sha256", secret)
    .update(`${filename}:${expiresAt}`)
    .digest("hex")
    .slice(0, 32);
  const provided = Buffer.from(String(signature));
  const expectedBuffer = Buffer.from(expected);
  if (provided.length !== expectedBuffer.length) return false;
  return timingSafeEqual(provided, expectedBuffer);
}
