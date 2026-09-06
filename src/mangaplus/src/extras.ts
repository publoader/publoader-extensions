/**
 * Giving MangaPlus "ex" chapters a MangaDex chapter number.
 *
 * MangaPlus numbers an extra chapter `ex` and relies on its position in the
 * chapter list to say where it belongs. MangaDex has no such notion: every
 * chapter needs a number, so the number has to be inferred from the
 * neighbours. The rules that matter, in the order they matter:
 *
 *  1. ORDER. Several extras can sit between the same two numbered chapters
 *     (`10, ex, ex, 11`). They must come out ascending, in list order.
 *  2. NO COLLISIONS. The inferred number must not be one MangaPlus already
 *     uses for a real chapter; `11, 11.5, ex` must not put the extra on 11.5.
 *  3. STABILITY. An extra keeps the number it was first given. It is uploaded
 *     the day it appears, when it is still the newest chapter in the list, and
 *     renumbering it later means a duplicate or an edit on MangaDex.
 *
 * The previous implementation derived the decimal from the gap between two
 * list indices, which satisfied none of the three: `10, ex, ex, 11` produced
 * 10.5 then 10.2, `11, 11.5, ex` produced a second 11.5, and a trailing extra
 * moved from 10.1 to 10.5 as soon as chapter 11 was published.
 *
 * Instead: anchor each run of extras to the chapter *before* it (fixed the
 * moment that chapter exists, which is what buys stability) and walk up the
 * conventional ".5, .6, .7" ladder, skipping numbers the title already uses.
 * Only when the ladder does not fit — a real ".5" is in the way, or the gap to
 * the next chapter is narrower than the run — does it subdivide the gap.
 */

/**
 * Chapter numbers as integer hundredths, so `10.5 + 0.1` cannot drift into
 * 10.600000000000001 and so the "already taken" set compares exactly.
 * MangaDex accepts at most two decimals, which is the same resolution.
 */
export type Hundredths = number;

/** How far the ladder will climb before giving up. */
const LADDER_LIMIT = 64;

/** `ex`, `EX.`, `#ex`, `extra 2` — MangaPlus's spellings of "no number". */
const DEFAULT_EXTRA_MARKERS = ["ex", "extra"];

/** Names that mean "this chapter has no place in the numbering at all". */
const UNNUMBERED = /^(?:one[-. ]?shot|pilot)$/i;

/** Drop the decorative hashes MangaPlus wraps chapter numbers in. */
export function stripHashes(value: string): string {
  return value.replace(/^#+/, "").replace(/#+$/, "").trim();
}

/**
 * Where a chapter sits on the number line, or null when its name is not a
 * number. Merged releases (`#1,2`, `#1-2`) anchor on the highest number they
 * cover, because that is the last chapter a following extra comes after.
 */
export function chapterValue(raw: string | null): Hundredths | null {
  if (raw === null) return null;

  const cleaned = stripHashes(String(raw));
  if (cleaned === "") return null;

  let best: Hundredths | null = null;
  for (const part of cleaned.split(/[,]|(?<=\d)\s*-\s*(?=#?\d)/)) {
    const match = /^\s*#?0*(\d+)(?:\.(\d{1,2})\d*)?\s*$/.exec(part);
    if (match === null) return best === null ? null : best;

    const value = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
    if (best === null || value > best) best = value;
  }
  return best;
}

/** `10.5` back from 1050; `10.05` from 1005; `10` from 1000. */
export function formatValue(value: Hundredths): string {
  const whole = Math.floor(value / 100);
  const fraction = value % 100;
  if (fraction === 0) return String(whole);
  if (fraction % 10 === 0) return `${whole}.${fraction / 10}`;
  return `${whole}.${String(fraction).padStart(2, "0")}`;
}

/**
 * Whether a chapter name marks an extra. `markers` extends the defaults from
 * `override_options.json`, so a new MangaPlus spelling is a config change
 * rather than a release.
 */
export function isExtra(raw: string | null, markers: readonly string[] = []): boolean {
  if (raw === null) return false;

  const cleaned = stripHashes(String(raw)).toLowerCase();
  if (cleaned === "" || UNNUMBERED.test(cleaned)) return false;

  for (const marker of [...DEFAULT_EXTRA_MARKERS, ...markers]) {
    // "ex", "ex.", "ex 2", "ex2" — a trailing ordinal is MangaPlus counting
    // its own extras, and the run below already puts them in that order.
    if (new RegExp(`^${marker}\\.?\\s*\\d*$`, "i").test(cleaned)) return true;
  }
  return false;
}

/** The first free value at or above `start`, stepping by `step`. */
function collect(
  count: number,
  start: Hundredths,
  step: Hundredths,
  low: Hundredths,
  high: Hundredths | null,
  taken: ReadonlySet<Hundredths>,
): Hundredths[] | null {
  const allocated: Hundredths[] = [];
  let value = start;

  for (let attempt = 0; attempt < LADDER_LIMIT && allocated.length < count; attempt += 1) {
    if (high !== null && value >= high) return null;
    if (value > low && !taken.has(value)) allocated.push(value);
    value += step;
  }
  return allocated.length === count ? allocated : null;
}

function firstMultipleAbove(value: Hundredths, step: Hundredths): Hundredths {
  return Math.floor(value / step) * step + step;
}

/**
 * The conventional first slot after a chapter: `.5` after a whole number
 * (10 -> 10.5, the number a human would have picked), the next tenth after a
 * chapter that is already a decimal (11.5 -> 11.6, never 11.5 again).
 */
function ladderStart(low: Hundredths): Hundredths {
  return low % 100 === 0 ? low + 50 : firstMultipleAbove(low, 10);
}

/**
 * Numbers for one run of `count` consecutive extras sitting in the open
 * interval between `low` and `high` — either of which is null when the run
 * has no numbered chapter on that side. Returns a null per extra it cannot
 * place, which leaves that chapter unnumbered rather than wrong.
 */
export function allocateRun(
  count: number,
  low: Hundredths | null,
  high: Hundredths | null,
  taken: ReadonlySet<Hundredths>,
): (Hundredths | null)[] {
  if (count <= 0) return [];
  // Nothing in the whole title is numbered; there is no number line to sit on.
  if (low === null && high === null) return Array(count).fill(null);

  let floorValue: Hundredths;

  if (low !== null) {
    floorValue = low;
    const ladder = collect(count, ladderStart(low), 10, low, high, taken);
    if (ladder !== null) return ladder;
  } else {
    // A run before the first numbered chapter: hang it below that chapter.
    // Right-aligned, so the extra nearest chapter 1 is always 0.5 no matter
    // how many prologues precede it.
    floorValue = (high as Hundredths) >= 100 ? Math.floor((high as Hundredths) / 100) * 100 - 100 : 0;
    const ladder = collect(count, floorValue + 50 - (count - 1) * 10, 10, floorValue, high, taken);
    if (ladder !== null) return ladder;
  }

  // The ladder did not fit: either a real chapter already owns those tenths,
  // or the gap is too narrow for the run (10, ex, ex, 10.5). Pack the run into
  // what the gap does have, at the coarsest resolution that holds it.
  for (const step of [10, 1]) {
    const packed = collect(count, firstMultipleAbove(floorValue, step), step, floorValue, high, taken);
    if (packed !== null) return packed;
  }
  return Array(count).fill(null);
}

/** One chapter as the allocator sees it. */
export interface NumberedSlot {
  /** Its position on the number line, or null if it has no number. */
  value: Hundredths | null;
  /** Whether it is an extra awaiting a number. */
  extra: boolean;
}

/**
 * Numbers every extra in one title's chapter list, in list order.
 *
 * `slots` must cover the whole title in release order — the anchor for an
 * extra is frequently in a different `chapter_list_group` than the extra
 * itself, and searching only within a group is what made a group-leading extra
 * fall back to guessing from the chapter after it.
 *
 * `reserved` holds numbers that are already spoken for beyond the ones in
 * `slots` — the values forced by `override_chapter_numbers` and
 * `multi_chapters`, which are uploaded and can be collided with just the same.
 */
export function assignExtras(
  slots: readonly NumberedSlot[],
  reserved: readonly Hundredths[] = [],
): (Hundredths | null)[] {
  const assigned: (Hundredths | null)[] = slots.map(() => null);
  const taken = new Set<Hundredths>(reserved);
  for (const slot of slots) {
    if (!slot.extra && slot.value !== null) taken.add(slot.value);
  }

  for (let index = 0; index < slots.length; index += 1) {
    if (!slots[index].extra) continue;

    // The maximal run of extras starting here, so they can be spread over the
    // gap together instead of each one independently claiming ".5".
    let end = index;
    while (end < slots.length && slots[end].extra) end += 1;

    let low: Hundredths | null = null;
    for (let back = index - 1; back >= 0; back -= 1) {
      if (slots[back].value !== null) {
        low = slots[back].value;
        break;
      }
    }

    // The ceiling is the next chapter the run has to stay below. Chapters
    // listed out of order — a "#0" prologue appended late, a rerun of an early
    // chapter — are skipped rather than allowed to close the interval to
    // nothing, which would leave the run unnumbered.
    let high: Hundredths | null = null;
    for (let forward = end; forward < slots.length; forward += 1) {
      const value = slots[forward].value;
      if (value === null || (low !== null && value <= low)) continue;
      high = value;
      break;
    }

    const run = allocateRun(end - index, low, high, taken);
    for (let offset = 0; offset < run.length; offset += 1) {
      assigned[index + offset] = run[offset];
      if (run[offset] !== null) taken.add(run[offset] as Hundredths);
    }
    index = end - 1;
  }

  return assigned;
}
