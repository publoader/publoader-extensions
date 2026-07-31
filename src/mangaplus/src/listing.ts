/**
 * Turning the cheap listing responses into per-title update evidence.
 *
 * Kept pure and separate from `index.ts` for one reason: this is the code that
 * decides what the planner is allowed to skip, and a silent mistake here — a
 * mistyped protobuf JSON name, a field MangaPlus renumbered — would look
 * exactly like "no title has new chapters", i.e. a run that quietly uploads
 * nothing. `listing.test.ts` therefore drives this with real encoded protobuf
 * bytes, and `buildListing` reports enough about what it saw
 * (`updateSignals`) for the caller to notice the same failure at runtime.
 */

import type { ListingEntry } from "./planner";
import type { PbAllTitlesGroup, PbSuccessResult } from "./proto";

/** Everything one run learned from the listing endpoints. */
export interface Listing {
  /** External manga id -> update evidence, for the planner. */
  entries: Map<string, ListingEntry>;
  /** `allV2`'s groups, kept for untracked detection. */
  catalogue: PbAllTitlesGroup[];
  /**
   * Whether the evidence may be trusted enough to skip titles. False when no
   * update feed answered, and false when they answered but named no updates at
   * all — implausible for MangaPlus, so more likely schema drift than a quiet
   * day, and either way not something to infer "nothing to do" from.
   */
  updateFeedsAvailable: boolean;
  /** Whether at least one update feed returned a usable response. */
  feedsAnswered: boolean;
  /** Titles some update feed named. */
  updateSignals: number;
  /** Titles each feed reported, for the run summary. */
  sources: { catalogue: number; webHome: number; updated: number };
}

/**
 * An entry while it is still being assembled. `latestRank` orders the home
 * page's several mentions of one title; it is not part of the planner's input.
 */
type DraftEntry = ListingEntry & { latestRank?: readonly [number, number] };

/** `[timestamp, isLatest]` compared lexicographically. */
function outranks(
  candidate: readonly [number, number],
  incumbent: readonly [number, number],
): boolean {
  return candidate[0] === incumbent[0]
    ? candidate[1] > incumbent[1]
    : candidate[0] > incumbent[0];
}

/**
 * Epoch seconds from `title_list/updated`'s timestamp field, or undefined when
 * it isn't one — some builds return a display string, and a numeric encoding
 * would arrive as a number rather than the string the schema declares. An
 * unparseable value is not fatal: the title still counts as recently updated,
 * it just contributes no timestamp.
 */
export function epochSeconds(value: string | number | undefined): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;

  const parsed = Number(value);
  return parsed > 0 ? parsed : undefined;
}

export function buildListing(responses: {
  /** `title_list/allV2`, or null if the call failed. */
  catalogue: PbSuccessResult | null;
  /** `web/web_homeV4`, or null if the call failed. */
  webHome: PbSuccessResult | null;
  /** `title_list/updated`, or null if the call failed. */
  updated: PbSuccessResult | null;
}): Listing {
  const drafts = new Map<string, DraftEntry>();
  const draftFor = (mangaId: string): DraftEntry => {
    let draft = drafts.get(mangaId);
    if (draft === undefined) {
      draft = {};
      drafts.set(mangaId, draft);
    }
    return draft;
  };

  const catalogue = responses.catalogue?.allTitlesViewV2?.allTitlesGroup ?? [];
  let catalogueTitles = 0;
  for (const group of catalogue) {
    for (const title of group.titles ?? []) {
      if (title.titleId === undefined) continue;
      draftFor(String(title.titleId)).inCatalogue = true;
      catalogueTitles += 1;
    }
  }

  let webHomeTitles = 0;
  for (const group of responses.webHome?.webHomeViewV4?.groups ?? []) {
    for (const titleGroup of group.titleGroups ?? []) {
      const timestamp = titleGroup.chapterStartTime;
      for (const listed of titleGroup.titles ?? []) {
        const titleId = listed.title?.titleId;
        if (titleId === undefined) continue;

        webHomeTitles += 1;
        const draft = draftFor(String(titleId));
        draft.updatedRecently = true;
        if (listed.chapterId === undefined) continue;

        // One title can appear in several home-page groups — a new release plus
        // an evergreen slot showing chapter 1 — and only the newest release
        // tells us what its latest chapter is. `is_latest` breaks ties between
        // groups sharing a timestamp.
        const rank = [timestamp ?? -1, listed.isLatest === true ? 1 : 0] as const;
        if (draft.latestRank !== undefined && !outranks(rank, draft.latestRank)) continue;

        draft.latestRank = rank;
        draft.latestChapterId = String(listed.chapterId);
        draft.latestChapterTimestamp = timestamp;
      }
    }
  }

  let updatedTitles = 0;
  for (const listed of responses.updated?.titleUpdatedView?.latestTitle ?? []) {
    const titleId = listed.title?.titleId;
    if (titleId === undefined) continue;

    updatedTitles += 1;
    const draft = draftFor(String(titleId));
    draft.updatedRecently = true;
    const timestamp = epochSeconds(listed.updatedTimeStamp);
    if (timestamp !== undefined) {
      draft.updatedTimestamp = Math.max(draft.updatedTimestamp ?? 0, timestamp);
    }
  }

  const entries = new Map<string, ListingEntry>();
  let updateSignals = 0;
  for (const [mangaId, draft] of drafts) {
    const { latestRank: _rank, ...entry } = draft;
    if (entry.updatedRecently === true || entry.latestChapterId !== undefined) updateSignals += 1;
    entries.set(mangaId, entry);
  }

  return {
    entries,
    catalogue,
    feedsAnswered: responses.webHome !== null || responses.updated !== null,
    updateSignals,
    updateFeedsAvailable: updateSignals > 0,
    sources: { catalogue: catalogueTitles, webHome: webHomeTitles, updated: updatedTitles },
  };
}
