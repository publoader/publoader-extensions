import assert from "node:assert/strict";
import { test } from "node:test";
import { hasExpired } from "./normalise.ts";

const NOW = 1_757_332_800; // 2026-09-08T12:00:00Z, epoch seconds.

test("a stated expiry in the past has closed", () => {
  assert.equal(hasExpired(NOW - 86_400, NOW), true);
});

test("a stated expiry in the future has not", () => {
  assert.equal(hasExpired(NOW + 86_400, NOW), false);
});

test("an absent expiry never expires", () => {
  // The regression this guards: proto3 drops zero values, so a chapter that
  // never rotates out arrives with endTimeStamp absent. It used to be stood in
  // as DEFAULT_TIMESTAMP (epoch second 1), which read as "expired in 1970" --
  // skipping the chapter from every upload, and, once the platform started
  // hard-deleting still-listed expired chapters as paywalled, marking the
  // permanently-free chapters for deletion.
  assert.equal(hasExpired(null, NOW), false);
});

test("an expiry exactly at now has not closed yet", () => {
  assert.equal(hasExpired(NOW, NOW), false);
});
