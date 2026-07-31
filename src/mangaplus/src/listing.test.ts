/**
 * Unit tests for the listing assembly. Run with:
 *
 *   node --test src/listing.test.ts
 *
 * These deliberately start from encoded protobuf bytes rather than hand-written
 * decoded objects. The field numbers below are transcribed from
 * `mangaplus.proto`, so if a JSON name in `proto.ts` or a field read in
 * `listing.ts` drifts, these fail — which matters because the runtime symptom
 * of that drift is a run that skips every series and uploads nothing.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildListing, epochSeconds } from "./listing.ts";
import { decodeResponse } from "./proto.ts";
import { planFetch } from "./planner.ts";

// --- the smallest protobuf encoder that can express these messages ---------

const WIRE_VARINT = 0;
const WIRE_LENGTH = 2;

function varint(value: number): number[] {
  const out: number[] = [];
  let remaining = value;
  do {
    const byte = remaining & 0x7f;
    remaining >>>= 7;
    out.push(remaining > 0 ? byte | 0x80 : byte);
  } while (remaining > 0);
  return out;
}

function tag(field: number, wireType: number): number[] {
  return varint((field << 3) | wireType);
}

function uint32Field(field: number, value: number): number[] {
  return [...tag(field, WIRE_VARINT), ...varint(value)];
}

function boolField(field: number, value: boolean): number[] {
  return [...tag(field, WIRE_VARINT), ...varint(value ? 1 : 0)];
}

function stringField(field: number, value: string): number[] {
  const bytes = [...new TextEncoder().encode(value)];
  return [...tag(field, WIRE_LENGTH), ...varint(bytes.length), ...bytes];
}

function messageField(field: number, body: readonly number[]): number[] {
  return [...tag(field, WIRE_LENGTH), ...varint(body.length), ...body];
}

// --- message builders, field numbers straight from mangaplus.proto ---------

function title(titleId: number, name: string, language?: number): number[] {
  return [
    ...uint32Field(1, titleId),
    ...stringField(2, name),
    ...(language === undefined ? [] : uint32Field(7, language)),
  ];
}

interface ListedChapter {
  titleId: number;
  name: string;
  chapterId?: number;
  isLatest?: boolean;
}

/** UpdatedTitleV2Group: one release of one chapter across languages. */
function releaseGroup(chapters: readonly ListedChapter[], chapterStartTime?: number): number[] {
  return [
    ...stringField(1, "The Series"),
    ...stringField(2, "#123"),
    ...chapters.flatMap((chapter) =>
      messageField(3, [
        ...messageField(1, title(chapter.titleId, chapter.name)),
        ...(chapter.chapterId === undefined ? [] : uint32Field(2, chapter.chapterId)),
        ...stringField(3, "#123"),
        ...(chapter.isLatest === undefined ? [] : boolField(5, chapter.isLatest)),
      ]),
    ),
    ...(chapterStartTime === undefined ? [] : uint32Field(6, chapterStartTime)),
  ];
}

/** A `web/web_homeV4` response: SuccessResult.web_home_view_v4 = 38. */
function webHomeResponse(groups: readonly (readonly number[])[]): Uint8Array {
  const view = groups.flatMap((group) =>
    messageField(2, [...stringField(1, "Updates"), ...messageField(2, group)]),
  );
  return new Uint8Array(messageField(1, messageField(38, view)));
}

/** A `title_list/updated` response: SuccessResult.title_updated_view = 20. */
function updatedResponse(
  entries: readonly { titleId: number; name: string; stamp?: string }[],
): Uint8Array {
  const view = entries.flatMap((entry) =>
    messageField(1, [
      ...messageField(1, title(entry.titleId, entry.name)),
      ...(entry.stamp === undefined ? [] : stringField(2, entry.stamp)),
    ]),
  );
  return new Uint8Array(messageField(1, messageField(20, view)));
}

/** A `title_list/allV2` response: SuccessResult.all_titles_view_v2 = 25. */
function catalogueResponse(
  groups: readonly { theTitle: string; titles: readonly number[][] }[],
): Uint8Array {
  const view = groups.flatMap((group) =>
    messageField(1, [
      ...stringField(1, group.theTitle),
      ...group.titles.flatMap((one) => messageField(2, one)),
    ]),
  );
  return new Uint8Array(messageField(1, messageField(25, view)));
}

function success(bytes: Uint8Array) {
  const decoded = decodeResponse(bytes);
  assert.ok(decoded.success, "the fixture must decode to a success response");
  return decoded.success;
}

const NOW = 1_800_000_000;

// --- tests -----------------------------------------------------------------

test("the web home feed yields a latest chapter id and timestamp per title", () => {
  const bytes = webHomeResponse([
    releaseGroup(
      [
        { titleId: 100, name: "Series (English)", chapterId: 9002, isLatest: true },
        { titleId: 101, name: "Series (Spanish)", chapterId: 9003, isLatest: true },
      ],
      NOW - 3600,
    ),
  ]);

  const listing = buildListing({
    catalogue: null,
    webHome: success(bytes),
    updated: null,
  });

  // Each language is its own tracked title with its own chapter id.
  assert.deepEqual(listing.entries.get("100"), {
    updatedRecently: true,
    latestChapterId: "9002",
    latestChapterTimestamp: NOW - 3600,
  });
  assert.deepEqual(listing.entries.get("101"), {
    updatedRecently: true,
    latestChapterId: "9003",
    latestChapterTimestamp: NOW - 3600,
  });
  assert.equal(listing.sources.webHome, 2);
  assert.equal(listing.updateSignals, 2);
  assert.equal(listing.updateFeedsAvailable, true);
});

test("a title in several home-page groups keeps its newest release", () => {
  const bytes = webHomeResponse([
    // An evergreen slot showing an old chapter...
    releaseGroup([{ titleId: 100, name: "Series", chapterId: 8001 }], NOW - 90 * 86_400),
    // ...and today's release, which is the one that counts.
    releaseGroup([{ titleId: 100, name: "Series", chapterId: 9002, isLatest: true }], NOW - 3600),
  ]);

  const listing = buildListing({ catalogue: null, webHome: success(bytes), updated: null });

  assert.deepEqual(listing.entries.get("100"), {
    updatedRecently: true,
    latestChapterId: "9002",
    latestChapterTimestamp: NOW - 3600,
  });
});

test("is_latest breaks ties between groups sharing a timestamp", () => {
  const bytes = webHomeResponse([
    releaseGroup([{ titleId: 100, name: "Series", chapterId: 8001 }], NOW - 3600),
    releaseGroup([{ titleId: 100, name: "Series", chapterId: 9002, isLatest: true }], NOW - 3600),
  ]);

  const listing = buildListing({ catalogue: null, webHome: success(bytes), updated: null });

  assert.equal(listing.entries.get("100")?.latestChapterId, "9002");
});

test("a home-page mention with no chapter id still marks the title updated", () => {
  const bytes = webHomeResponse([releaseGroup([{ titleId: 100, name: "Series" }], NOW - 3600)]);

  const listing = buildListing({ catalogue: null, webHome: success(bytes), updated: null });

  assert.deepEqual(listing.entries.get("100"), { updatedRecently: true });
});

test("the updated feed contributes a timestamp when it carries one", () => {
  const bytes = updatedResponse([
    { titleId: 100, name: "Series", stamp: String(NOW - 7200) },
    { titleId: 200, name: "Other", stamp: "2 hours ago" },
    { titleId: 300, name: "No stamp" },
  ]);

  const listing = buildListing({ catalogue: null, webHome: null, updated: success(bytes) });

  assert.deepEqual(listing.entries.get("100"), {
    updatedRecently: true,
    updatedTimestamp: NOW - 7200,
  });
  // An unparseable stamp still means "this title updated".
  assert.deepEqual(listing.entries.get("200"), { updatedRecently: true });
  assert.deepEqual(listing.entries.get("300"), { updatedRecently: true });
  assert.equal(listing.sources.updated, 3);
});

test("the catalogue marks titles present without claiming they updated", () => {
  const bytes = catalogueResponse([
    { theTitle: "Series", titles: [title(100, "Series (English)"), title(101, "Series", 1)] },
  ]);

  const listing = buildListing({ catalogue: success(bytes), webHome: null, updated: null });

  assert.deepEqual(listing.entries.get("100"), { inCatalogue: true });
  assert.equal(listing.sources.catalogue, 2);
  assert.equal(listing.catalogue.length, 1, "kept for untracked detection");
  assert.equal(listing.catalogue[0]?.titles?.[1]?.language, "SPANISH");
  // The catalogue says nothing about updates, so it must not license skipping.
  assert.equal(listing.updateSignals, 0);
  assert.equal(listing.updateFeedsAvailable, false);
});

test("feeds that answer but name no updated title do not license skipping", () => {
  // The shape of protobuf field drift: a response that decodes fine and yields
  // nothing. Treated as "no evidence", never as "nothing to do".
  const listing = buildListing({
    catalogue: success(catalogueResponse([{ theTitle: "Series", titles: [title(100, "Series")] }])),
    webHome: success(webHomeResponse([])),
    updated: success(updatedResponse([])),
  });

  assert.equal(listing.feedsAnswered, true);
  assert.equal(listing.updateSignals, 0);
  assert.equal(listing.updateFeedsAvailable, false);

  const plan = planFetch({
    tracked: ["100", "200"],
    trackedSubset: null,
    cleanRun: false,
    postedChapterIds: new Set(["9001"]),
    listing: listing.entries,
    updateFeedsAvailable: listing.updateFeedsAvailable,
    windowStart: NOW - 3 * 86_400,
  });
  assert.deepEqual(plan.fetch, ["100", "200"], "no evidence means fetch everything");
});

test("end to end: encoded listings select only the titles with news", () => {
  const listing = buildListing({
    catalogue: success(
      catalogueResponse([
        {
          theTitle: "Series",
          titles: [title(100, "A"), title(200, "B"), title(300, "C"), title(400, "D")],
        },
      ]),
    ),
    webHome: success(
      webHomeResponse([
        // 100 released something we have not uploaded.
        releaseGroup([{ titleId: 100, name: "A", chapterId: 9102, isLatest: true }], NOW - 3600),
        // 200's newest chapter is already uploaded.
        releaseGroup([{ titleId: 200, name: "B", chapterId: 9201, isLatest: true }], NOW - 7200),
      ]),
    ),
    // 300 is named by the updates feed with no chapter id: unknown, so fetched.
    updated: success(updatedResponse([{ titleId: 300, name: "C", stamp: String(NOW - 1800) }])),
  });

  const plan = planFetch({
    tracked: ["100", "200", "300", "400", "500"],
    trackedSubset: null,
    cleanRun: false,
    postedChapterIds: new Set(["9101", "9201"]),
    listing: listing.entries,
    updateFeedsAvailable: listing.updateFeedsAvailable,
    windowStart: NOW - 3 * 86_400,
  });

  assert.deepEqual(plan.fetch, ["100", "300"]);
  assert.deepEqual(plan.skipCounts, {
    "latest-chapter-posted": 1, // 200
    "no-update-signal": 1, // 400: in the catalogue, quiet
    "outside-update-window": 0,
    "absent-from-listing": 1, // 500: no listing knows it
  });
});

test("epochSeconds accepts what the wire can carry and rejects the rest", () => {
  assert.equal(epochSeconds(String(NOW)), NOW);
  assert.equal(epochSeconds(NOW), NOW);
  assert.equal(epochSeconds("2 hours ago"), undefined);
  assert.equal(epochSeconds("2026-07-29T00:00:00Z"), undefined);
  assert.equal(epochSeconds("0"), undefined);
  assert.equal(epochSeconds(undefined), undefined);
});
