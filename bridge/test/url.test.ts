import assert from "node:assert/strict";
import test from "node:test";
import { BridgeError } from "../src/errors.ts";
import { canonicalizeInstagramUrl } from "../src/url.ts";

test("canonicalizes Instagram post and reel links", () => {
  assert.equal(
    canonicalizeInstagramUrl("https://www.instagram.com/reel/ABC123/?igsh=tracking#comment"),
    "https://www.instagram.com/reel/ABC123/",
  );
  assert.equal(
    canonicalizeInstagramUrl("https://instagram.com/p/ABC123"),
    "https://www.instagram.com/p/ABC123/",
  );
  assert.equal(
    canonicalizeInstagramUrl("https://www.instagram.com/tv/ABC123/"),
    "https://www.instagram.com/tv/ABC123/",
  );
});

test("rejects non-Instagram and non-public URLs", () => {
  const cases = [
    "https://example.com/reel/ABC123/",
    "http://instagram.com/p/ABC123/",
    "https://instagram.com:8443/p/ABC123/",
    "https://instagram.com/stories/user/123/",
    "https://instagram.com/p/",
    "not a url",
    "",
  ];
  for (const input of cases) {
    assert.throws(
      () => canonicalizeInstagramUrl(input),
      (error) => error instanceof BridgeError && error.code === "INVALID_URL",
      input,
    );
  }
});
