/**
 * Which tracked series actually need a `title_detailV3` call this run.
 *
 * `title_detailV3` is one request per series and the catalogue is hundreds of
 * series, so walking all of them every run costs hundreds of requests to learn
 * that a handful of titles moved. MangaPlus' listing endpoints already say
 * which titles moved and when, for a fixed two or three requests, so a run can
 * spend its per-series calls only where the listing says something changed.
 *
 * This module is the decision, kept pure and I/O-free so it can be tested
 * without touching the network: `index.ts` collects the listing evidence,
 * `planFetch` decides, `index.ts` issues the calls.
 *
 * The safety rule behind every predicate below: a title is skipped only when
 * the evidence says a detail call could not have produced an *update* —
 * because `collect` would have filtered every chapter it returned anyway.
 * Where the evidence is absent, ambiguous, or unavailable, the title is
 * fetched. Clean runs skip nothing at all (see `planFetch`).
 */

/** What the listing endpoints told us about one title. */
export interface ListingEntry {
  /** Newest chapter id the listing advertises for this title. */
  latestChapterId?: string;
  /** Epoch seconds that chapter became readable, when the listing carries it. */
  latestChapterTimestamp?: number;
  /** An update feed named the title, whether or not it named a chapter id. */
  updatedRecently?: boolean;
  /** Epoch seconds from such a feed, when it carries a parseable timestamp. */
  updatedTimestamp?: number;
  /** The title is present in the full-catalogue listing. */
  inCatalogue?: boolean;
}

export type SkipReason =
  /** The newest chapter the listing knows of is already uploaded. */
  | "latest-chapter-posted"
  /** In the catalogue, but no update feed mentions it. */
  | "no-update-signal"
  /** Its newest known chapter predates the update window. */
  | "outside-update-window"
  /** No listing mentions it at all — no longer published, or hidden. */
  | "absent-from-listing";

export const SKIP_REASONS: readonly SkipReason[] = [
  "latest-chapter-posted",
  "no-update-signal",
  "outside-update-window",
  "absent-from-listing",
];

export interface PlanInput {
  /** Every tracked external manga id (`ctx.mangaIdMap` keys). */
  tracked: readonly string[];
  /** This segment's ids on a partitioned run, else null. */
  trackedSubset: readonly string[] | null;
  /** A clean run must fetch everything; see `planFetch`. */
  cleanRun: boolean;
  /** Chapter ids already uploaded for this extension. */
  postedChapterIds: ReadonlySet<string>;
  /** External manga id -> what the listings said. */
  listing: ReadonlyMap<string, ListingEntry>;
  /**
   * Whether any endpoint that enumerates recent updates answered. When none
   * did, absence from `listing` carries no information and nothing is skipped.
   */
  updateFeedsAvailable: boolean;
  /**
   * Epoch seconds; a chapter that became readable before this can never be an
   * update, because `collect` drops chapters older than the update window.
   */
  windowStart: number;
}

export interface SkippedTitle {
  mangaId: string;
  reason: SkipReason;
}

export interface FetchPlan {
  /** Titles needing a `title_detailV3` call, in tracked order. */
  fetch: string[];
  skipped: SkippedTitle[];
  /** Candidates considered, i.e. tracked ids after `trackedSubset`. */
  candidates: number;
  skipCounts: Record<SkipReason, number>;
  /** True when every candidate is fetched: a clean run, or no listing to trust. */
  full: boolean;
}

/** Tracked ids this job owns, in `tracked` order. */
function candidateIds(
  tracked: readonly string[],
  trackedSubset: readonly string[] | null,
): string[] {
  if (trackedSubset === null) return [...tracked];

  const wanted = new Set(trackedSubset);
  return tracked.filter((mangaId) => wanted.has(mangaId));
}

/**
 * Why this title needs no detail call, or null when it does.
 *
 * Each branch is a claim that a detail call could not yield a new chapter:
 *  - no listing knows the title, so MangaPlus is not publishing it;
 *  - the listing's newest chapter for it is already uploaded;
 *  - no update feed mentions it, so it published nothing recently;
 *  - everything the listing knows about predates the update window, so
 *    `collect`'s own window filter would discard it.
 */
function skipReason(
  entry: ListingEntry | undefined,
  postedChapterIds: ReadonlySet<string>,
  windowStart: number,
): SkipReason | null {
  if (entry === undefined) return "absent-from-listing";

  const { latestChapterId, latestChapterTimestamp, updatedTimestamp } = entry;

  if (latestChapterId !== undefined && postedChapterIds.has(latestChapterId)) {
    // Two feeds can disagree: the home page is cached independently of the
    // updates feed, so a strictly newer timestamp from the feed that names no
    // chapter outranks the chapter id from the one that does.
    const contradicted =
      updatedTimestamp !== undefined &&
      latestChapterTimestamp !== undefined &&
      updatedTimestamp > latestChapterTimestamp;
    if (!contradicted) return "latest-chapter-posted";
  }

  const mentionedByUpdateFeed =
    latestChapterId !== undefined ||
    updatedTimestamp !== undefined ||
    entry.updatedRecently === true;
  if (!mentionedByUpdateFeed) return "no-update-signal";

  // An absent timestamp is unknown, not zero — proto3 drops defaults — so it
  // never justifies a skip.
  const timestamps = [latestChapterTimestamp, updatedTimestamp].filter(
    (value): value is number => value !== undefined,
  );
  if (timestamps.length > 0 && Math.max(...timestamps) < windowStart) {
    return "outside-update-window";
  }

  return null;
}

/**
 * Split the tracked catalogue into the titles worth a detail call and the
 * titles whose listing evidence rules out an update.
 *
 * Clean runs fetch every candidate unconditionally. That is a correctness
 * requirement, not politeness: a clean run's `allChapters` is what the
 * platform diffs to detect *removed* chapters, and a title missing from it
 * reads as "everything was removed". The same applies when no update feed
 * answered — with no listing to trust, absence proves nothing.
 */
export function planFetch(input: PlanInput): FetchPlan {
  const candidates = candidateIds(input.tracked, input.trackedSubset);
  const skipCounts = Object.fromEntries(SKIP_REASONS.map((reason) => [reason, 0])) as Record<
    SkipReason,
    number
  >;

  if (input.cleanRun || !input.updateFeedsAvailable) {
    return {
      fetch: candidates,
      skipped: [],
      candidates: candidates.length,
      skipCounts,
      full: true,
    };
  }

  const fetch: string[] = [];
  const skipped: SkippedTitle[] = [];
  for (const mangaId of candidates) {
    const reason = skipReason(
      input.listing.get(mangaId),
      input.postedChapterIds,
      input.windowStart,
    );
    if (reason === null) {
      fetch.push(mangaId);
    } else {
      skipped.push({ mangaId, reason });
      skipCounts[reason] += 1;
    }
  }

  return {
    fetch,
    skipped,
    candidates: candidates.length,
    skipCounts,
    full: fetch.length === candidates.length,
  };
}
