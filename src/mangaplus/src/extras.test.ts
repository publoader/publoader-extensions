/**
 * The numbering of `ex` chapters, which is the one place this extension
 * invents a value rather than passing one through.
 *
 * Each test states a chapter list the way MangaPlus lists it and asserts the
 * whole row of MangaDex numbers, because the interesting failures are
 * relational: an extra that sorts before its predecessor, or one that lands on
 * a number a real chapter already owns, is only visible next to its
 * neighbours.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { chapterValue, formatValue, isExtra } from "./extras.ts";
import { normaliseChapters, type OverrideOptions, type RawChapter } from "./normalise.ts";

/** One MangaPlus chapter list; `names` are the raw `name` fields. */
function number(names: readonly (string | null)[], options: OverrideOptions = {}): (string | null)[] {
  const chapters: RawChapter[] = names.map((name, index) => ({
    chapterId: `c${index}`,
    chapterUrl: "",
    chapterTimestamp: index,
    chapterExpire: 0,
    chapterTitle: null,
    chapterNumber: name,
    chapterLanguage: "en",
    mangaId: "1",
    mangaName: "m",
    mangaUrl: "",
  }));
  return normaliseChapters([chapters], options, null).map((chapter) => chapter.chapterNumber);
}

/** Numbers in the order MangaDex would sort them. */
function ascending(numbers: readonly (string | null)[]): boolean {
  const values = numbers.filter((value): value is string => value !== null).map(Number);
  return values.every((value, index) => index === 0 || value > values[index - 1]);
}

test("a lone extra takes the .5 a human would have given it", () => {
  assert.deepEqual(number(["#1", "ex", "#2"]), ["1", "1.5", "2"]);
});

test("consecutive extras ascend instead of doubling back", () => {
  // The old index-gap rule produced 10.5 then 10.2 here, putting the second
  // extra before the first.
  const numbers = number(["#10", "ex", "ex", "#11"]);
  assert.deepEqual(numbers, ["10", "10.5", "10.6", "11"]);
  assert.ok(ascending(numbers));
});

test("a long run of extras stays in reading order", () => {
  const numbers = number(["#10", "ex", "ex", "ex", "ex", "#11"]);
  assert.deepEqual(numbers, ["10", "10.5", "10.6", "10.7", "10.8", "11"]);
  assert.ok(ascending(numbers));
});

test("an extra after a decimal chapter does not reuse its number", () => {
  // The old rule read the "11" out of "11.5" and appended ".5" again.
  assert.deepEqual(number(["#11", "#11.5", "ex", "#12"]), ["11", "11.5", "11.6", "12"]);
});

test("extras squeezed under an existing .5 pack into the gap below it", () => {
  assert.deepEqual(number(["#10", "ex", "#10.5", "#11"]), ["10", "10.1", "10.5", "11"]);
  assert.deepEqual(number(["#10", "ex", "ex", "#10.5", "#11"]), [
    "10",
    "10.1",
    "10.2",
    "10.5",
    "11",
  ]);
});

test("a gap too narrow for tenths subdivides further", () => {
  assert.deepEqual(number(["#10", "#10.1", "ex", "ex", "#10.2"]), [
    "10",
    "10.1",
    "10.11",
    "10.12",
    "10.2",
  ]);
});

test("the newest chapter being an extra gives it the number it will keep", () => {
  // Chapters are uploaded the day they appear, when nothing follows them yet.
  // The old rule numbered this 10.1 and then renamed it to 10.5 once chapter
  // 11 was published, which is a duplicate on MangaDex.
  assert.deepEqual(number(["#10", "ex"]), ["10", "10.5"]);
  assert.deepEqual(number(["#10", "ex", "#11"]), ["10", "10.5", "11"]);
});

test("a run of trailing extras is stable once the next chapter arrives", () => {
  assert.deepEqual(number(["#10", "ex", "ex"]), ["10", "10.5", "10.6"]);
  assert.deepEqual(number(["#10", "ex", "ex", "#11"]), ["10", "10.5", "10.6", "11"]);
});

test("extras before the first numbered chapter hang below it", () => {
  assert.deepEqual(number(["ex", "#1", "#2"]), ["0.5", "1", "2"]);
  // Right-aligned: the extra next to chapter 1 keeps 0.5 whatever precedes it.
  assert.deepEqual(number(["ex", "ex", "#1"]), ["0.4", "0.5", "1"]);
  assert.deepEqual(number(["ex", "#10", "#11"]), ["9.5", "10", "11"]);
});

test("the reported list places an extra at either end of it", () => {
  // The list from the question: a prologue extra and a trailing one, with a
  // real 11.5 sitting between them.
  assert.deepEqual(number(["ex", "#10", "#11", "#11.5", "ex"]), [
    "9.5",
    "10",
    "11",
    "11.5",
    "11.6",
  ]);
});

test("extras split by an unnumbered chapter do not collide", () => {
  const numbers = number(["#10", "ex", "one-shot", "ex", "#11"]);
  assert.deepEqual(numbers, ["10", "10.5", null, "10.6", "11"]);
});

test("an extra anchors on the chapter before it across group boundaries", () => {
  const group = (names: readonly string[]): RawChapter[] =>
    names.map((name, index) => ({
      chapterId: `${name}-${index}`,
      chapterUrl: "",
      chapterTimestamp: index,
      chapterExpire: 0,
      chapterTitle: null,
      chapterNumber: name,
      chapterLanguage: "en",
      mangaId: "1",
      mangaName: "m",
      mangaUrl: "",
    }));

  // Anchoring inside the second group alone would read the extra as 49.5.
  const numbers = normaliseChapters([group(["#49", "#50"]), group(["ex", "#51"])], {}, null);
  assert.deepEqual(
    numbers.map((chapter) => chapter.chapterNumber),
    ["49", "50", "50.5", "51"],
  );
});

test("a merged release anchors on the highest chapter it covers", () => {
  // "#1,2" is itself uploaded as both chapter 1 and chapter 2, so the extra
  // after it belongs above 2, not above 1.
  assert.deepEqual(number(["#1,2", "ex", "#3"]), ["1", "2", "2.5", "3"]);
});

test("an inferred number never lands on one an override already claims", () => {
  const options: OverrideOptions = { override_chapter_numbers: { c2: "10.5" } };
  assert.deepEqual(number(["#10", "ex", "#0", "#11"], options), ["10", "10.6", "10.5", "11"]);
});

test("a chapter listed out of order does not strand the extra before it", () => {
  // A "#0" prologue appended to the end of the list is not a ceiling for an
  // extra that follows chapter 10; chapter 11 is.
  assert.deepEqual(number(["#10", "ex", "#0", "#11"]), ["10", "10.5", "0", "11"]);
});

test("overrides still win outright over the inferred number", () => {
  const options: OverrideOptions = { override_chapter_numbers: { c1: "10.25" } };
  assert.deepEqual(number(["#10", "ex", "#11"], options), ["10", "10.25", "11"]);
});

test("a title with nothing numbered leaves its extras unnumbered", () => {
  assert.deepEqual(number(["ex", "ex"]), [null, null]);
});

test("extra markers are recognised however MangaPlus spells them", () => {
  assert.deepEqual(number(["#10", "EX", "#ex.", "ex 2", "#11"]), [
    "10",
    "10.5",
    "10.6",
    "10.7",
    "11",
  ]);
  assert.ok(isExtra("ex"));
  assert.ok(isExtra("#EX."));
  assert.ok(isExtra("extra 3"));
  assert.ok(!isExtra("#12"));
  assert.ok(!isExtra("one-shot"));
  assert.ok(!isExtra("omake"));
  assert.ok(isExtra("omake", ["omake"]));
});

test("unknown markers can be added without a release", () => {
  assert.deepEqual(number(["#10", "omake", "#11"], { extra_markers: ["omake"] }), [
    "10",
    "10.5",
    "11",
  ]);
});

test("chapter values round-trip through the hundredths representation", () => {
  assert.equal(chapterValue("#010"), 1000);
  assert.equal(chapterValue("#10.5"), 1050);
  assert.equal(chapterValue("10.05"), 1005);
  assert.equal(chapterValue("#1,2"), 200);
  assert.equal(chapterValue("ex"), null);
  assert.equal(formatValue(1000), "10");
  assert.equal(formatValue(1050), "10.5");
  assert.equal(formatValue(1005), "10.05");
});
