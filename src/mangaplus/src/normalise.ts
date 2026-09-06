/**
 * Chapter number and title normalisation, ported field-for-field from the
 * Python extension (`mangaplus.py`, `_normalise_chapter_number` /
 * `_normalise_chapter_title` / `normalise_chapter_fields`).
 *
 * The regexes and the branch order are load-bearing: they decide what chapter
 * number and title land on MangaDex, and every override in
 * `override_options.json` was tuned against this exact behaviour.
 *
 * The one deliberate departure from the Python original is how `ex` chapters
 * are numbered: that now lives in `extras.ts`, which places a whole run of
 * them at once instead of deriving a decimal from a pair of list indices.
 */

import {
  assignExtras,
  chapterValue,
  formatValue,
  isExtra,
  type Hundredths,
  type NumberedSlot,
} from "./extras.ts";

/** A chapter before number/title normalisation; timestamps are epoch seconds. */
export interface RawChapter {
  chapterId: string;
  /**
   * Which of `title_detailV3`'s three per-group lists this chapter came from.
   *
   * Internal to the extension — `toChapterInput` never emits it. It exists
   * because MangaPlus' free window is "the first few chapters and the last
   * few", so a chapter in the middle list is the one most likely to be listed
   * but unreadable. The availability check spends its per-run budget on those
   * first. It is a hint about where to look, never evidence on its own: plenty
   * of mid-list chapters of an ongoing series are perfectly readable, and only
   * `manga_viewer` decides.
   */
  listSlot?: "first" | "mid" | "last";
  chapterUrl: string;
  chapterTimestamp: number;
  chapterExpire: number;
  chapterTitle: string | null;
  chapterNumber: string | null;
  chapterLanguage: string;
  mangaId: string;
  mangaName: string | null;
  mangaUrl: string;
}

export interface OverrideOptions {
  /** External manga ids whose chapter titles are always dropped. */
  empty?: string[];
  /** External manga ids whose chapter titles are passed through untouched. */
  noformat?: string[];
  /** External manga id -> title-prefix regex. */
  custom?: Record<string, string>;
  /** External manga id -> MangaDex language code. */
  custom_language?: Record<string, string>;
  /** Spelled-out numbers stripped from title prefixes. */
  num2words?: string[];
  /** Chapter id -> every chapter number it should be uploaded as. */
  multi_chapters?: Record<string, string[]>;
  /** Chapter id -> the chapter number to force. */
  override_chapter_numbers?: Record<string, string>;
  /** External manga ids that never have chapters; never reported as untracked. */
  no_chapters?: string[];
  /** Master chapter id -> alternate ids; consumed by the platform, not here. */
  same?: Record<string, string[]>;
  /** Extra chapter-name spellings beyond "ex"/"extra", e.g. "omake". */
  extra_markers?: string[];
  /**
   * Check each candidate chapter's real page count via `manga_viewer`, and
   * treat a chapter serving fewer than one page as dead.
   *
   * OFF by default, and deliberately so: it costs one request per chapter, and
   * MangaPlus answers a client it dislikes with an outright account ban rather
   * than a rate-limit — one un-throttled burst of these was enough to earn one.
   * A ban would take publoader off MangaPlus entirely, which is a worse outcome
   * than the dead links it would find, so switching this on is a decision to
   * make deliberately rather than a default to inherit.
   */
  verify_pages?: boolean;
}

/** publoader's chapter-number validator (utils/utils.py). */
const CHAPTER_NUMBER_RE = /^(0|[1-9]\d*)((\.\d+){1,2})?[a-z]?$/i;

/** Python's `string.punctuation`, escaped for use inside a character class. */
const PUNCTUATION = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
const WORD_SPLIT_RE = new RegExp(`[\\s${PUNCTUATION.replace(/[\\\]^-]/g, "\\$&")}]+`);

const COLON_RE = /^(?:\S+\s*)?\d+(?:[,\-.]\d{0,2})?\s?:\s?/i;
const NO_TITLE_RE = /^\S+\s*\d+(?:[,\-.]\d{0,2})?$/i;
const HASHTAG_RE = /^(?:\S+\s*)?#\d+(?:[,\-.]\d{0,2})?\s?/i;
const PERIOD_DASH_RE = /^(?:\S+\s*)?\d+(?:[,\-.]\d{0,2})?\s?[./\-]\s?/i;
const SPACES_RE = /^(?:\S+\s*)?\d+(?:[,\-.]\d{0,2})?\s?/i;
const FINAL_CHAPTER_RE = /^(?:final|last)\s?(?:chapter|ep|episode)\s?[:.]\s?/i;

/** Python's `int(s)`: the whole string must be an optionally signed integer. */
function strictInt(value: string): number | null {
  const trimmed = value.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

function stripHashes(value: string): string {
  return value.replace(/^#+/, "").replace(/#+$/, "");
}

/** `_strip_chapter_number`: drop the leading `#` and the leading zeros. */
export function stripChapterNumber(value: string | number | null): string {
  const stripped = stripHashes(String(value).trim());
  const parts = stripped.split(/[.\-]/);
  const head = parts[0].replace(/^0+/, "");
  parts[0] = head === "" ? "0" : head;
  return parts.join(".");
}

/**
 * The Python `Chapter` dataclass compares these five fields, and
 * `list.index()` (used to locate neighbouring chapters) relies on it.
 */
function chapterIdentity(chapter: RawChapter): string {
  return JSON.stringify([
    chapter.chapterId,
    chapter.chapterNumber,
    chapter.chapterLanguage,
    chapter.mangaId,
    chapter.mangaName,
  ]);
}

function indexOfChapter(chapters: readonly RawChapter[], target: RawChapter): number {
  const key = chapterIdentity(target);
  return chapters.findIndex((chapter) => chapterIdentity(chapter) === key);
}

/** `re.sub(pattern, "", value, count)` — replace at most `count` matches. */
function replaceLimited(value: string, pattern: RegExp, count: number): string {
  let result = value;
  for (let i = 0; i < count; i++) {
    const next = result.replace(pattern, "");
    if (next === result) break;
    result = next;
  }
  return result;
}

/** Every extra-chapter marker this title should recognise. */
function extraMarkers(options: OverrideOptions): readonly string[] {
  return options.extra_markers ?? [];
}

/**
 * The MangaDex numbers already spoken for by overrides on chapters of this
 * list. They are uploaded like any other number, so an inferred extra must
 * not land on one.
 */
function reservedValues(
  chapters: readonly RawChapter[],
  options: OverrideOptions,
): Hundredths[] {
  const forced = options.override_chapter_numbers ?? {};
  const multi = options.multi_chapters ?? {};

  const reserved: Hundredths[] = [];
  for (const chapter of chapters) {
    const numbers = Object.prototype.hasOwnProperty.call(forced, chapter.chapterId)
      ? [forced[chapter.chapterId]]
      : (multi[chapter.chapterId] ?? []);

    for (const number of numbers) {
      const value = chapterValue(number);
      if (value !== null) reserved.push(value);
    }
  }
  return reserved;
}

/**
 * Chapter id -> the MangaDex number inferred for it, for every extra chapter
 * in the list. Built once per title because an extra's number depends on its
 * neighbours and on what its siblings were given.
 */
export function buildExtraAssignment(
  chapters: readonly RawChapter[],
  options: OverrideOptions,
): Map<string, string | null> {
  const markers = extraMarkers(options);
  const slots: NumberedSlot[] = chapters.map((chapter) => {
    const extra = isExtra(chapter.chapterNumber, markers);
    return { extra, value: extra ? null : chapterValue(chapter.chapterNumber) };
  });

  const assigned = assignExtras(slots, reservedValues(chapters, options));

  const numbers = new Map<string, string | null>();
  for (let index = 0; index < chapters.length; index += 1) {
    if (!slots[index].extra) continue;
    const value = assigned[index];
    numbers.set(chapters[index].chapterId, value === null ? null : formatValue(value));
  }
  return numbers;
}

/**
 * `_normalise_chapter_number`. Returns one entry per MangaDex chapter number
 * the chapter should be uploaded as — usually one, more when the
 * `multi_chapters` override says MangaPlus merged several chapters into one.
 *
 * `assignment` comes from `buildExtraAssignment` over the title's whole
 * chapter list; without it the extras are placed using only `chapters`, which
 * is correct but blind to any group the caller did not pass in.
 */
export function normaliseChapterNumber(
  chapters: readonly RawChapter[],
  chapter: RawChapter,
  options: OverrideOptions,
  assignment?: ReadonlyMap<string, string | null>,
): (string | null)[] {
  const currentNumber = stripChapterNumber(chapter.chapterNumber);
  let chapterNumber: string | number | null =
    chapter.chapterNumber === null ? null : currentNumber;

  if (isExtra(chapter.chapterNumber, extraMarkers(options))) {
    const numbers = assignment ?? buildExtraAssignment(chapters, options);
    chapterNumber = numbers.get(chapter.chapterId) ?? null;
  } else if (
    typeof chapterNumber === "string" &&
    ["one-shot", "one.shot"].includes(chapterNumber.toLowerCase())
  ) {
    chapterNumber = null;
  } else if (
    typeof chapterNumber === "string" &&
    (chapterNumber.toLowerCase().startsWith("spin-off") ||
      chapterNumber.toLowerCase().startsWith("spin.off"))
  ) {
    // The original passed re.I as re.sub's `count`, so this is a
    // case-sensitive replace of at most two matches on the lowered string.
    chapterNumber = replaceLimited(
      chapterNumber.toLowerCase(),
      /(?:spin-off|spin\.off)\s?/,
      2,
    ).trim();
  }

  const split: (string | null)[] =
    chapterNumber === null
      ? [null]
      : String(chapterNumber)
          .split(",")
          .map((part) => stripChapterNumber(part));

  let numbers: (string | null)[] = split.map((number) =>
    number === null || !CHAPTER_NUMBER_RE.test(number) ? null : number,
  );

  const forced = options.override_chapter_numbers ?? {};
  const multiChapters = options.multi_chapters ?? {};
  if (Object.prototype.hasOwnProperty.call(forced, chapter.chapterId)) {
    numbers = [forced[chapter.chapterId]];
  } else if (Object.prototype.hasOwnProperty.call(multiChapters, chapter.chapterId)) {
    numbers = [...multiChapters[chapter.chapterId]];
  }

  return numbers;
}

/** `_normalise_chapter_title`: strip the "Chapter 12: " style prefix. */
export function normaliseChapterTitle(
  chapter: RawChapter,
  chapterNumbers: readonly (string | null)[],
  options: OverrideOptions,
  numberWordsPattern: string | null,
): string | null {
  const wordNumbersRe =
    numberWordsPattern === null
      ? null
      : new RegExp(
          `^(?:\\S+\\s*)\\s?${numberWordsPattern}\\s?(?:${numberWordsPattern}\\s?)?:\\s?`,
          "i",
        );

  const originalTitle = String(chapter.chapterTitle).trim();
  let normalisedTitle: string | null = originalTitle;
  let patternToUse: RegExp | null = null;

  const empty = options.empty ?? [];
  const noformat = options.noformat ?? [];
  const custom = options.custom ?? {};

  if (
    (empty.includes(chapter.mangaId) && !chapterNumbers.includes(null)) ||
    originalTitle.toLowerCase() === "final chapter"
  ) {
    normalisedTitle = null;
  } else if (noformat.includes(chapter.mangaId)) {
    normalisedTitle = originalTitle;
  } else if (Object.prototype.hasOwnProperty.call(custom, chapter.mangaId)) {
    // Unanchored, like the Python original: a custom regex may target the
    // middle or the tail of the title, not only its prefix.
    patternToUse = new RegExp(custom[chapter.mangaId], "i");
  } else if (FINAL_CHAPTER_RE.test(originalTitle)) {
    patternToUse = FINAL_CHAPTER_RE;
  } else if (wordNumbersRe !== null && wordNumbersRe.test(originalTitle)) {
    patternToUse = wordNumbersRe;
  } else if (COLON_RE.test(originalTitle)) {
    patternToUse = COLON_RE;
  } else if (NO_TITLE_RE.test(originalTitle)) {
    patternToUse = NO_TITLE_RE;
  } else if (PERIOD_DASH_RE.test(originalTitle)) {
    patternToUse = PERIOD_DASH_RE;
  } else if (HASHTAG_RE.test(originalTitle)) {
    patternToUse = HASHTAG_RE;
  } else if (SPACES_RE.test(originalTitle)) {
    patternToUse = SPACES_RE;
  }

  if (patternToUse !== null) {
    normalisedTitle = originalTitle.replace(patternToUse, "").trim();
  }

  if (normalisedTitle !== null && ["", "none", "null"].includes(normalisedTitle.toLowerCase())) {
    normalisedTitle = null;
  }

  return normalisedTitle;
}

/** `num2words` as the alternation the title regexes embed. */
export function numberWordsPattern(options: OverrideOptions): string | null {
  const words = options.num2words;
  if (words === undefined || words === null) return null;
  return `(${words.join("|")})`;
}

/**
 * `normalise_chapter_fields`: one output chapter per normalised chapter
 * number, all sharing the normalised title.
 */
export function normaliseChapterFields(
  chapters: readonly RawChapter[],
  chapter: RawChapter,
  options: OverrideOptions,
  numberWords: string | null,
  assignment?: ReadonlyMap<string, string | null>,
): RawChapter[] {
  const numbers = normaliseChapterNumber(chapters, chapter, options, assignment);
  const title = normaliseChapterTitle(chapter, numbers, options, numberWords);
  return numbers.map((number) => ({ ...chapter, chapterNumber: number, chapterTitle: title }));
}

/**
 * `normalise_chapters`: every chapter of every chapter-list group.
 *
 * The extra-chapter numbers are worked out across the groups joined together,
 * in list order. MangaPlus splits a title's chapters into a "first", "mid" and
 * "last" list per group and can start a group with an `ex`, whose anchor is
 * then the last chapter of the previous group — invisible to anything looking
 * at one group alone.
 */
export function normaliseChapters(
  groups: readonly RawChapter[][],
  options: OverrideOptions,
  numberWords: string | null,
): RawChapter[] {
  const ordered = groups.flat();
  const assignment = buildExtraAssignment(ordered, options);

  const normalised: RawChapter[] = [];
  for (const chapters of groups) {
    for (const chapter of chapters) {
      normalised.push(
        ...normaliseChapterFields(chapters, chapter, options, numberWords, assignment),
      );
    }
  }
  return normalised;
}
