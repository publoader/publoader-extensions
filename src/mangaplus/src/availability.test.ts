import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chapterAvailability,
  countPages,
  deadFindingsTrustworthy,
  errorCode,
  outcomeFromResponse,
} from "./availability.ts";
import type { PbResponse } from "./proto.ts";

const page = (imageUrl: string | undefined) => ({ mangaPage: imageUrl ? { imageUrl } : {} });

test("counts only entries that carry a real page image", () => {
  // `pages` also holds ads and end-of-chapter cards, which decode to an entry
  // with no mangaPage. Counting the array length would call a chapter of two
  // ads a live chapter.
  assert.equal(countPages({ pages: [page("a.jpg"), page("b.jpg")] }), 2);
  assert.equal(countPages({ pages: [page(undefined), {}] }), 0);
  assert.equal(countPages({ pages: [] }), 0);
  assert.equal(countPages(undefined), 0);
});

test("reads the trailing error code MangaPlus appends", () => {
  assert.equal(errorCode("Invalid user access(11302)"), "11302");
  assert.equal(errorCode("...cancel-my-subscription%3F(10900)"), "10900");
  assert.equal(errorCode("no code here"), null);
  assert.equal(errorCode(undefined), null);
});

test("a served viewer with pages is available", () => {
  const response: PbResponse = { success: { mangaViewer: { pages: [page("a.jpg")] } } };
  const availability = chapterAvailability(outcomeFromResponse(response));
  assert.equal(availability.verdict, "available");
  assert.equal(availability.pages, 1);
});

test("a served viewer with no pages is dead", () => {
  const response: PbResponse = { success: { mangaViewer: { pages: [] } } };
  assert.equal(chapterAvailability(outcomeFromResponse(response)).verdict, "dead");
});

test("11302 is a statement about the chapter, so it is dead", () => {
  // The case that actually happens: MangaPlus answers with an error envelope
  // rather than a viewer holding zero pages. Heart Gear #004 is the worked
  // example, and treating this as 'unknown' would miss every paywalled chapter.
  const response: PbResponse = {
    error: { englishPopup: { subject: "Invalid user", body: "Invalid user access(11302)" } },
  };
  const outcome = outcomeFromResponse(response);
  assert.equal(outcome.kind, "refused");
  assert.equal(chapterAvailability(outcome).verdict, "dead");
});

test("10900 is a statement about us, so nothing is concluded", () => {
  // A ban says nothing about any chapter. Reading it as 'dead' would card the
  // entire catalogue on the strength of one rejected client.
  const response: PbResponse = {
    error: { englishPopup: { subject: "Account Banned", body: "...(10900)" } },
  };
  const outcome = outcomeFromResponse(response);
  assert.equal(outcome.kind, "unknown");
  assert.equal(outcome.kind === "unknown" && outcome.clientRejected, true);
  assert.equal(chapterAvailability(outcome).verdict, "unknown");
});

test("an unrecognised error code concludes nothing", () => {
  // Allowlist, not denylist: a code nobody has classified yet must not be
  // allowed to unpublish chapters on a guess.
  const response: PbResponse = {
    error: { englishPopup: { subject: "Something", body: "Something odd(19999)" } },
  };
  assert.equal(chapterAvailability(outcomeFromResponse(response)).verdict, "unknown");
});

test("a non-default action is about the session, region or downtime", () => {
  const response: PbResponse = {
    error: { action: "MAINTENANCE", englishPopup: { subject: "Down", body: "later(11302)" } },
  };
  const outcome = outcomeFromResponse(response);
  assert.equal(outcome.kind, "unknown");
  assert.equal(outcome.kind === "unknown" && outcome.clientRejected, true);
});

test("findings are disbelieved when the client was rejected", () => {
  assert.equal(deadFindingsTrustworthy({ judged: 100, dead: 1, clientRejected: true }), false);
});

test("a small number of dead chapters is ordinary", () => {
  assert.equal(deadFindingsTrustworthy({ judged: 100, dead: 5, clientRejected: false }), true);
  assert.equal(deadFindingsTrustworthy({ judged: 0, dead: 0, clientRejected: false }), true);
});

test("a large share of dead chapters is a throttle, not a catalogue", () => {
  // A third of the catalogue going dead at once is what rate limiting looks
  // like from here. Acting on it would card hundreds of readable chapters.
  assert.equal(deadFindingsTrustworthy({ judged: 100, dead: 40, clientRejected: false }), false);
});

test("a tiny sample is not judged by ratio", () => {
  // Two of three dead is 66%, but three chapters is not evidence of a throttle.
  assert.equal(deadFindingsTrustworthy({ judged: 3, dead: 2, clientRejected: false }), true);
});

test("a transport failure is never evidence", () => {
  assert.equal(chapterAvailability({ kind: "unknown", detail: "timeout" }).verdict, "unknown");
});
