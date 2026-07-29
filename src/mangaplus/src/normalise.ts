/**
 * Chapter number and title normalisation, ported field-for-field from the
 * Python extension (`mangaplus.py`, `_normalise_chapter_number` /
 * `_normalise_chapter_title` / `normalise_chapter_fields`).
 *
 * The regexes and the branch order are load-bearing: they decide what chapter
 * number and title land on MangaDex, and every override in
 * `override_options.json` was tuned against this exact behaviour.
 */

/** A chapter before number/title normalisation; timestamps are epoch seconds. */
export interface RawChapter {
  chapterId: string;
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

/**
 * `_get_surrounding_chapter`: the nearest chapter whose number starts with a
 * plain integer, searching backwards from the current chapter or forwards from
 * it (the forward search includes the current chapter itself, as in Python —
 * it only ever survives the integer test if its own number parses, which an
 * "ex" chapter never does).
 */
function getSurroundingChapter(
  chapters: readonly RawChapter[],
  current: RawChapter,
  nextChapterSearch: boolean,
): RawChapter | null {
  const index = indexOfChapter(chapters, current);
  if (index < 0) return null;

  const search = nextChapterSearch
    ? chapters.slice(index)
    : chapters.slice(0, index).reverse();

  for (const chapter of search) {
    // Python raised TypeError on a null number here; skipping is strictly safer.
    if (chapter.chapterNumber === null) continue;

    const match = /^#?(\d+)/.exec(chapter.chapterNumber);
    const number = match
      ? match[1]
      : stripHashes(chapter.chapterNumber).split(WORD_SPLIT_RE)[0];

    if (strictInt(number) !== null) return chapter;
  }
  return null;
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

/**
 * `_normalise_chapter_number`. Returns one entry per MangaDex chapter number
 * the chapter should be uploaded as — usually one, more when the
 * `multi_chapters` override says MangaPlus merged several chapters into one.
 */
export function normaliseChapterNumber(
  chapters: readonly RawChapter[],
  chapter: RawChapter,
  options: OverrideOptions,
): (string | null)[] {
  const currentNumber = stripChapterNumber(chapter.chapterNumber);
  let chapterNumber: string | number | null =
    chapter.chapterNumber === null ? null : currentNumber;

  if (chapterNumber === "ex") {
    const previousChapter = getSurroundingChapter(chapters, chapter, false);
    const nextChapter = getSurroundingChapter(chapters, chapter, true);

    let nextChapterNumber: number | null = null;
    if (nextChapter !== null) {
      const head = stripChapterNumber(nextChapter.chapterNumber).split(/[.\-,]/)[0];
      const parsed = strictInt(head);
      nextChapterNumber = parsed === null ? null : parsed - 1;
    }

    let previousChapterNumber: string | null = null;
    if (previousChapter !== null) {
      const stripped = stripChapterNumber(previousChapter.chapterNumber);
      previousChapterNumber = stripped.includes(",")
        ? stripped.split(",")[stripped.split(",").length - 1]
        : stripped.split(/[.\-]/)[0];
    }

    let firstIndex: RawChapter | null = null;
    let secondIndex: RawChapter | null = null;

    if (previousChapter === null) {
      if (nextChapter === null) {
        chapterNumber = null;
      } else {
        chapterNumber = nextChapterNumber;
        firstIndex = nextChapter;
        secondIndex = chapter;
      }
    } else {
      chapterNumber = previousChapterNumber;
      firstIndex = chapter;
      secondIndex = previousChapter;
    }

    if (chapterNumber === "ex") chapterNumber = null;

    // Unreachable: reaching this branch means currentNumber === "ex". Kept so
    // the port stays a line-for-line mirror of the original.
    if (chapterNumber !== null && currentNumber !== "ex") {
      const distance = Math.abs(Number(currentNumber) - Number(chapterNumber));
      if (distance >= 5) chapterNumber = null;
    }

    if (chapterNumber !== null) {
      let chapterDecimal: string | number = "5";

      const firstPosition = firstIndex === null ? -1 : indexOfChapter(chapters, firstIndex);
      const secondPosition = secondIndex === null ? -1 : indexOfChapter(chapters, secondIndex);
      if (firstPosition >= 0 && secondPosition >= 0) {
        const difference = firstPosition - secondPosition;
        if (nextChapter === null) chapterDecimal = difference;

        // Several extra chapters can sit before the same numbered chapter; the
        // index gap keeps them from colliding on the same ".5".
        if (difference > 1) {
          const secondNumber = secondIndex === null ? null : secondIndex.chapterNumber;
          if (secondNumber !== null && secondNumber.includes(".")) {
            const decimal = strictInt(secondNumber.split(".")[secondNumber.split(".").length - 1]);
            if (decimal !== null) chapterDecimal = decimal + 1;
          } else {
            chapterDecimal = difference;
          }
        }
      }

      chapterNumber = `${chapterNumber}.${chapterDecimal}`;
    }
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
): RawChapter[] {
  const numbers = normaliseChapterNumber(chapters, chapter, options);
  const title = normaliseChapterTitle(chapter, numbers, options, numberWords);
  return numbers.map((number) => ({ ...chapter, chapterNumber: number, chapterTitle: title }));
}

/** `normalise_chapters`: every chapter of every chapter-list group. */
export function normaliseChapters(
  groups: readonly RawChapter[][],
  options: OverrideOptions,
  numberWords: string | null,
): RawChapter[] {
  const normalised: RawChapter[] = [];
  for (const chapters of groups) {
    for (const chapter of chapters) {
      normalised.push(...normaliseChapterFields(chapters, chapter, options, numberWords));
    }
  }
  return normalised;
}
