/**
 * Unit tests for the fetch planner. Run with:
 *
 *   node --test src/planner.test.ts
 *
 * Node 22.18+/24 strips the types itself, so there is no build step and no test
 * dependency; `assert` and `node:test` are all these use.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { planFetch, type ListingEntry, type PlanInput } from "./planner.ts";

const NOW = 1_800_000_000;
const WINDOW_START = NOW - 3 * 24 * 60 * 60;
/** Inside the update window. */
const RECENT = NOW - 3600;
/** Long outside it. */
const ANCIENT = NOW - 90 * 24 * 60 * 60;

function plan(overrides: Partial<PlanInput> = {}) {
  const base: PlanInput = {
    tracked: [],
    trackedSubset: null,
    cleanRun: false,
    postedChapterIds: new Set<string>(),
    listing: new Map<string, ListingEntry>(),
    updateFeedsAvailable: true,
    windowStart: WINDOW_START,
  };
  return planFetch({ ...base, ...overrides });
}

test("a title whose latest listed chapter is already posted is skipped", () => {
  const result = plan({
    tracked: ["100"],
    postedChapterIds: new Set(["9001"]),
    listing: new Map([
      ["100", { latestChapterId: "9001", latestChapterTimestamp: RECENT, inCatalogue: true }],
    ]),
  });

  assert.deepEqual(result.fetch, []);
  assert.deepEqual(result.skipped, [{ mangaId: "100", reason: "latest-chapter-posted" }]);
  assert.equal(result.skipCounts["latest-chapter-posted"], 1);
  assert.equal(result.candidates, 1);
  assert.equal(result.full, false);
});

test("a title with a new latest chapter is fetched", () => {
  const result = plan({
    tracked: ["100"],
    postedChapterIds: new Set(["9001"]),
    listing: new Map([
      ["100", { latestChapterId: "9002", latestChapterTimestamp: RECENT, inCatalogue: true }],
    ]),
  });

  assert.deepEqual(result.fetch, ["100"]);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.full, true);
});

test("a posted latest chapter is overruled by a strictly newer timestamp elsewhere", () => {
  const listing = new Map<string, ListingEntry>([
    [
      "100",
      {
        latestChapterId: "9001",
        latestChapterTimestamp: RECENT - 7200,
        updatedRecently: true,
        updatedTimestamp: RECENT,
        inCatalogue: true,
      },
    ],
  ]);
  const result = plan({ tracked: ["100"], postedChapterIds: new Set(["9001"]), listing });

  assert.deepEqual(result.fetch, ["100"], "feeds disagree, so the detail call decides");
});

test("agreeing feeds still skip a posted latest chapter", () => {
  const listing = new Map<string, ListingEntry>([
    [
      "100",
      {
        latestChapterId: "9001",
        latestChapterTimestamp: RECENT,
        updatedRecently: true,
        updatedTimestamp: RECENT,
        inCatalogue: true,
      },
    ],
  ]);
  const result = plan({ tracked: ["100"], postedChapterIds: new Set(["9001"]), listing });

  assert.deepEqual(result.skipped, [{ mangaId: "100", reason: "latest-chapter-posted" }]);
});

test("a catalogue title no update feed mentions is skipped", () => {
  const result = plan({
    tracked: ["100"],
    listing: new Map([["100", { inCatalogue: true }]]),
  });

  assert.deepEqual(result.skipped, [{ mangaId: "100", reason: "no-update-signal" }]);
});

test("an unposted chapter older than the update window is skipped", () => {
  // collect() drops chapters older than the window, so a detail call here
  // could not have produced an update.
  const result = plan({
    tracked: ["100"],
    listing: new Map([
      ["100", { latestChapterId: "9002", latestChapterTimestamp: ANCIENT, inCatalogue: true }],
    ]),
  });

  assert.deepEqual(result.skipped, [{ mangaId: "100", reason: "outside-update-window" }]);
});

test("an unposted chapter with no timestamp at all is fetched", () => {
  const result = plan({
    tracked: ["100"],
    listing: new Map([["100", { latestChapterId: "9002", inCatalogue: true }]]),
  });

  assert.deepEqual(result.fetch, ["100"], "absent is unknown, not zero");
});

test("a tracked title absent from every listing is skipped and reported", () => {
  const result = plan({
    tracked: ["100", "200"],
    listing: new Map([["100", { inCatalogue: true }]]),
  });

  assert.deepEqual(result.fetch, []);
  assert.deepEqual(result.skipped, [
    { mangaId: "100", reason: "no-update-signal" },
    { mangaId: "200", reason: "absent-from-listing" },
  ]);
  assert.equal(result.skipCounts["absent-from-listing"], 1);
});

test("a clean run fetches every tracked title, whatever the listing says", () => {
  const result = plan({
    tracked: ["100", "200", "300"],
    cleanRun: true,
    postedChapterIds: new Set(["9001"]),
    listing: new Map([
      ["100", { latestChapterId: "9001", latestChapterTimestamp: RECENT, inCatalogue: true }],
      ["200", { inCatalogue: true }],
    ]),
  });

  assert.deepEqual(result.fetch, ["100", "200", "300"]);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.full, true);
  assert.deepEqual(
    Object.values(result.skipCounts).filter((count) => count !== 0),
    [],
  );
});

test("a clean run still honours trackedSubset", () => {
  const result = plan({
    tracked: ["100", "200", "300"],
    trackedSubset: ["200"],
    cleanRun: true,
  });

  assert.deepEqual(result.fetch, ["200"]);
  assert.equal(result.candidates, 1);
});

test("trackedSubset intersects with the tracked map and keeps tracked order", () => {
  const listing = new Map<string, ListingEntry>([
    ["100", { latestChapterId: "9101", latestChapterTimestamp: RECENT }],
    ["200", { latestChapterId: "9201", latestChapterTimestamp: RECENT }],
    ["300", { latestChapterId: "9301", latestChapterTimestamp: RECENT }],
  ]);
  const result = plan({
    tracked: ["100", "200", "300"],
    // "400" is another extension's/segment's id and must not appear.
    trackedSubset: ["300", "200", "400"],
    listing,
  });

  assert.deepEqual(result.fetch, ["200", "300"]);
  assert.equal(result.candidates, 2);
});

test("nothing is skipped when no update feed answered", () => {
  const result = plan({
    tracked: ["100", "200"],
    updateFeedsAvailable: false,
    postedChapterIds: new Set(["9001"]),
    // Even a listing that would justify skipping is ignored: with no update
    // feed, absence from it proves nothing, so trusting part of it is unsafe.
    listing: new Map([
      ["100", { latestChapterId: "9001", latestChapterTimestamp: RECENT, inCatalogue: true }],
    ]),
  });

  assert.deepEqual(result.fetch, ["100", "200"]);
  assert.equal(result.full, true);
});

test("a mixed catalogue fetches only the titles with news", () => {
  const listing = new Map<string, ListingEntry>([
    // new chapter
    ["100", { latestChapterId: "9102", latestChapterTimestamp: RECENT, inCatalogue: true }],
    // latest already uploaded
    ["200", { latestChapterId: "9201", latestChapterTimestamp: RECENT, inCatalogue: true }],
    // quiet
    ["300", { inCatalogue: true }],
    // named by the updates feed but with no chapter id: unknown, so fetched
    ["400", { updatedRecently: true, inCatalogue: true }],
    // evergreen home-page slot, nothing recent
    ["500", { latestChapterId: "9501", latestChapterTimestamp: ANCIENT, inCatalogue: true }],
  ]);
  const result = plan({
    tracked: ["100", "200", "300", "400", "500", "600"],
    postedChapterIds: new Set(["9101", "9201"]),
    listing,
  });

  assert.deepEqual(result.fetch, ["100", "400"]);
  assert.deepEqual(result.skipCounts, {
    "latest-chapter-posted": 1,
    "no-update-signal": 1,
    "outside-update-window": 1,
    "absent-from-listing": 1,
  });
});
