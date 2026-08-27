/**
 * Is a chapter MangaPlus still lists actually readable?
 *
 * `title_detailV3` is the only thing the rest of this extension consults, and
 * it answers a narrower question than it looks like it does: it says a chapter
 * EXISTS, not that anyone can open it. HEART GEAR (title 100057) is the worked
 * example — chapter 1001867 ("#004") sits in the listing's `midChapterList`
 * with `endTimeStamp` 2145884400, the far-future sentinel, so the expiry filter
 * in `collect` never fires; the viewer serves it zero pages because the series
 * finished and everything between the first three chapters and the last is
 * subscriber-only. Uploaded from the listing alone, it reached MangaDex as an
 * external link to a page that shows a reader nothing.
 *
 * The listing carries no page count — its `Chapter` message has only titleId,
 * chapterId, name, subTitle, thumbnail, the two timestamps, alreadyViewed,
 * viewCount and commentCount — so the count has to come from `manga_viewer`,
 * one request per chapter. This module owns the reading of that response;
 * `index.ts` owns the requests.
 *
 * Everything here is pure, so the rule that decides mass unavailability on
 * MangaDex can be tested without the network.
 */

import type { PbMangaViewer, PbResponse } from "./proto";

/**
 * What one `manga_viewer` call told us. The three cases are not
 * interchangeable, and collapsing any two of them is the bug this module
 * exists to prevent:
 *
 *  - `served`   — MangaPlus answered with a viewer. The page count is real
 *                 evidence, including when it is zero.
 *  - `refused`  — MangaPlus answered that THIS CHAPTER cannot be served. Zero
 *                 pages by any reader's definition, and the case that actually
 *                 happens: an error envelope rather than a viewer with an
 *                 empty `pages`.
 *  - `unknown`  — the request, the transport, the decode, or MangaPlus' view of
 *                 US failed. Not evidence about the chapter at all. A timeout,
 *                 a rate limit or a ban must never card a chapter.
 */
export type ViewerOutcome =
  | { kind: "served"; viewer: PbMangaViewer | undefined }
  | { kind: "refused"; detail: string }
  | { kind: "unknown"; detail: string; clientRejected?: boolean };

export type AvailabilityVerdict = "available" | "dead" | "unknown";

export interface ChapterAvailability {
  verdict: AvailabilityVerdict;
  /** Manga pages counted; null when nothing was counted. */
  pages: number | null;
  detail?: string;
}

/**
 * MangaPlus error codes that are a statement about the chapter rather than
 * about us. Deliberately an allowlist: an unrecognised code is not evidence,
 * and `index.ts` logs the codes it saw so a genuinely chapter-level one can be
 * added here after it has been seen in a job log — rather than the reverse,
 * where a new client-level code silently unpublishes a catalogue.
 *
 *   11302  "Invalid user access" — what the viewer answers for a chapter
 *          outside its free window, verified against HEART GEAR #004 while the
 *          same client read #001-#003 in full.
 */
export const CHAPTER_LEVEL_ERROR_CODES: ReadonlySet<string> = new Set(["11302"]);

/**
 * Codes that say MangaPlus has rejected the CLIENT. Nothing about a chapter can
 * be concluded while one of these is coming back, and a run that sees one stops
 * checking rather than judging the rest of the catalogue through it.
 *
 *   10900  "Account Banned" — what the API answers to any request carrying app
 *          parameters without a real app secret, and what a blocked source IP
 *          would plausibly get too.
 */
export const CLIENT_LEVEL_ERROR_CODES: ReadonlySet<string> = new Set(["10900"]);

/** The trailing `(11302)` MangaPlus appends to a popup body. */
export function errorCode(body: string | undefined): string | null {
  if (!body) return null;
  const match = /\((\d{3,6})\)\s*$/.exec(body.trim());
  return match ? match[1] : null;
}

/**
 * Manga pages in a viewer response.
 *
 * `pages` also holds advertisement and end-of-chapter entries, which arrive
 * under field numbers `proto.ts` does not declare and so decode to an entry
 * with no `mangaPage`. Those are not pages of the chapter and are not counted:
 * a "chapter" whose only entries are an ad and a "read the next one" card has
 * nothing in it, and counting the array length would call it alive.
 */
export function countPages(viewer: PbMangaViewer | undefined): number {
  let pages = 0;
  for (const page of viewer?.pages ?? []) {
    if (page.mangaPage?.imageUrl) pages += 1;
  }
  return pages;
}

/**
 * A decoded `manga_viewer` response -> what it says about the chapter.
 *
 * Only called for a response that decoded; a transport or decode failure never
 * reaches here and is reported as `unknown` by the caller.
 */
export function outcomeFromResponse(response: PbResponse): ViewerOutcome {
  const success = response.success;
  if (success && Object.keys(success).length > 0) {
    return { kind: "served", viewer: success.mangaViewer };
  }

  const error = response.error;
  const body = error?.englishPopup?.body;
  const subject = error?.englishPopup?.subject;
  const code = errorCode(body);
  const detail = code ? `${subject ?? "error"} (${code})` : (subject ?? "error");

  // A non-DEFAULT action is MangaPlus talking about our session, our region or
  // its own downtime — never about one chapter.
  const action = error?.action;
  if (action !== undefined && action !== 0 && action !== "DEFAULT") {
    return { kind: "unknown", detail: `${detail} action=${String(action)}`, clientRejected: true };
  }

  if (code !== null && CHAPTER_LEVEL_ERROR_CODES.has(code)) {
    return { kind: "refused", detail };
  }
  return {
    kind: "unknown",
    detail,
    clientRejected: code !== null && CLIENT_LEVEL_ERROR_CODES.has(code),
  };
}

/** `manga_viewer` outcome -> is this chapter readable? */
export function chapterAvailability(outcome: ViewerOutcome): ChapterAvailability {
  if (outcome.kind === "unknown") {
    return { verdict: "unknown", pages: null, detail: outcome.detail };
  }
  if (outcome.kind === "refused") {
    return { verdict: "dead", pages: 0, detail: outcome.detail };
  }
  const pages = countPages(outcome.viewer);
  return { verdict: pages < 1 ? "dead" : "available", pages };
}

/**
 * The share of judged chapters that may be dead before the whole check is
 * disbelieved, and the sample size below which the share is not consulted.
 *
 * MangaPlus rotates chapters out of its free window constantly, so a run
 * finding a few percent dead is ordinary. A run finding a third of the
 * catalogue dead is not: that is what a rate limit or a source-IP block looks
 * like from here, and acting on it would card hundreds of readable chapters as
 * unavailable on MangaDex — expensive to undo, and visible to readers while it
 * lasts.
 */
export const DEAD_RATIO_LIMIT = 0.2;
export const DEAD_RATIO_MIN_SAMPLE = 25;

export interface DeadFindingsInput {
  /** Chapters whose availability was decided, i.e. verdict !== "unknown". */
  judged: number;
  /** How many of those came back dead. */
  dead: number;
  /** Whether any response said MangaPlus had rejected this client. */
  clientRejected: boolean;
}

/**
 * Should this run act on its dead-chapter findings?
 *
 * Failing closed here means "keep every chapter" — the same state as before
 * this check existed. The other failure direction unpublishes real chapters, so
 * the asymmetry is deliberate.
 */
export function deadFindingsTrustworthy(input: DeadFindingsInput): boolean {
  if (input.clientRejected) return false;
  if (input.dead === 0) return true;
  if (input.judged < DEAD_RATIO_MIN_SAMPLE) return true;
  return input.dead / input.judged <= DEAD_RATIO_LIMIT;
}
