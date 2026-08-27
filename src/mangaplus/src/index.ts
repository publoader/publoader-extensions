/**
 * MangaPlus extension — publoader extension API v2.
 *
 * Ported from the Python extension (`mangaplus.py`, v0.3.00). The API only
 * serves protobuf (`format=json` has returned 403 since mid-2026), so
 * responses are decoded with the vendored schema in `mangaplus.proto`; see
 * `proto.ts` for how the decoded shape mirrors the Python dicts.
 *
 * Endpoints, cheap ones first:
 *   title_list/allV2   — the whole catalogue: untracked series, and evidence
 *                        that a tracked series is still published
 *   web/web_homeV4     — update feed naming each title's newest chapter id and
 *                        when it went up
 *   title_list/updated — a second update feed, widening that coverage
 *   title_detailV3     — the expensive one, a single series' chapter lists.
 *                        The Python entrypoint called it for every tracked
 *                        series every run; it is now called only for series the
 *                        listings say have moved. `planner.ts` owns that
 *                        decision and states the correctness argument.
 */

import type {
  ChapterInput,
  CollectInput,
  CollectResult,
  ExtensionContext,
  ExtensionFactory,
  ExtensionRuntime,
  MangaInput,
} from "./api";
import {
  ProtoDecodeError,
  decodeResponse,
  type PbAllTitlesGroup,
  type PbChapter,
  type PbResponse,
  type PbSuccessResult,
  type PbTitle,
} from "./proto";
import {
  normaliseChapters,
  numberWordsPattern,
  type OverrideOptions,
  type RawChapter,
} from "./normalise";
import { buildListing, type Listing } from "./listing";
import { planFetch } from "./planner";
import {
  chapterAvailability,
  deadFindingsTrustworthy,
  outcomeFromResponse,
  type ChapterAvailability,
  type ViewerOutcome,
} from "./availability";
import { decryptImage, looksLikeImage } from "./images";

const API_BASE = "https://jumpg-webapi.tokyo-cdn.com/api/";
const CHAPTER_URL = (chapterId: string) =>
  `https://mangaplus.shueisha.co.jp/viewer/${chapterId}`;
const MANGA_URL = (mangaId: string) => `https://mangaplus.shueisha.co.jp/titles/${mangaId}`;

/** Stand-in for a missing timestamp, matching the Python DEFAULT_TIMESTAMP. */
const DEFAULT_TIMESTAMP = 1;
/** An update is only "new" if it went up within this window. */
const UPDATE_WINDOW_SECONDS = 3 * 24 * 60 * 60;
/** Concurrent title_detailV3 calls. */
const TITLE_CONCURRENCY = 4;
/**
 * Concurrent manga_viewer calls. Higher than the detail concurrency because a
 * viewer response is small and a clean run makes one call per chapter of the
 * catalogue, but still low enough to look like reading rather than scraping —
 * MangaPlus answers a client it dislikes with a ban, and a ban would make the
 * whole availability check worthless for that run.
 */
const VIEWER_CONCURRENCY = 6;
/**
 * Hard ceiling on viewer calls in one run. Reaching it leaves the remaining
 * chapters unjudged, which keeps them — the safe direction — and is logged
 * rather than passed over silently.
 */
const MAX_VIEWER_CALLS = 20000;
/** What `manga_viewer` is asked for; matches what the site itself requests. */
const VIEWER_PARAMS = { split: "yes", img_quality: "high" } as const;

const LANGUAGE_MAP: Record<string, string> = {
  ENGLISH: "en",
  SPANISH: "es",
  FRENCH: "fr",
  INDONESIAN: "id",
  PORTUGUESE_BR: "pt-br",
  RUSSIAN: "ru",
  THAI: "th",
  GERMAN: "de",
  VIETNAMESE: "vi",
};
const LANGUAGES = Object.values(LANGUAGE_MAP);

// --- Real-user session spoofing -------------------------------------------
// Present each run as an ordinary reader rather than an automated scraper: a
// coherent, randomly chosen identity spanning desktop and mobile browsers, so
// this extension's requests blend into normal user traffic instead of exposing
// a default publoader User-Agent. (publoader still identifies honestly as
// publoader/<version> when talking to MangaDex; this is only MangaPlus.)
const REAL_USER_PROFILES: Record<string, string>[] = [
  {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Sec-CH-UA": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": '"Windows"',
  },
  {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Sec-CH-UA": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": '"macOS"',
  },
  {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  },
  {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  },
  {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
    "Sec-CH-UA": '"Microsoft Edge";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": '"Windows"',
  },
  {
    "User-Agent":
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    "Sec-CH-UA": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    "Sec-CH-UA-Mobile": "?1",
    "Sec-CH-UA-Platform": '"Android"',
  },
  {
    "User-Agent":
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  },
];

function randomSessionToken(): string {
  const cryptoApi = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();

  const bytes = new Uint8Array(16);
  if (cryptoApi?.getRandomValues) cryptoApi.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function realUserHeaders(): Record<string, string> {
  const profile = REAL_USER_PROFILES[Math.floor(Math.random() * REAL_USER_PROFILES.length)];
  return {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    ...profile,
    "SESSION-TOKEN": randomSessionToken(),
  };
}

/** Epoch seconds -> ISO-8601 UTC, or null when the value isn't a real date. */
function isoFromEpoch(seconds: number): string | null {
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toChapterInput(chapter: RawChapter): ChapterInput {
  return {
    chapterTimestamp: isoFromEpoch(chapter.chapterTimestamp),
    chapterExpire: isoFromEpoch(chapter.chapterExpire),
    chapterLanguage: chapter.chapterLanguage,
    chapterNumber: chapter.chapterNumber,
    chapterTitle: chapter.chapterTitle,
    chapterVolume: null,
    chapterId: chapter.chapterId,
    chapterUrl: chapter.chapterUrl,
    mangaId: chapter.mangaId,
    // Left for the runner to resolve from the platform's tracked map.
    mdMangaId: null,
    mangaName: chapter.mangaName,
    mangaUrl: chapter.mangaUrl,
  };
}

/** `_get_language`: MangaPlus language -> MangaDex language code. */
function resolveLanguage(
  language: string,
  mangaId: string,
  options: OverrideOptions,
): string {
  const custom = options.custom_language ?? {};
  if (Object.prototype.hasOwnProperty.call(custom, mangaId)) return custom[mangaId];
  if (LANGUAGES.includes(language)) return language;
  if (Object.prototype.hasOwnProperty.call(LANGUAGE_MAP, language)) {
    return LANGUAGE_MAP[language];
  }
  return "NULL";
}

async function runWithConcurrency<I, T>(
  items: readonly I[],
  limit: number,
  worker: (item: I) => Promise<T>,
): Promise<T[]> {
  const results = new Array<T>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });

  await Promise.all(runners);
  return results;
}

class MangaPlus implements ExtensionRuntime {
  private options: OverrideOptions = {};
  private numberWords: string | null = null;

  // Explicit field, not a parameter property — see the note in proto.ts.
  private readonly ctx: ExtensionContext;

  constructor(ctx: ExtensionContext) {
    this.ctx = ctx;
  }

  async collect(input: CollectInput): Promise<CollectResult> {
    this.options = await this.loadOverrideOptions();
    this.numberWords = numberWordsPattern(this.options);

    const tracked = [...this.ctx.mangaIdMap.keys()];
    this.ctx.log("Collecting MangaPlus updates", {
      tracked: tracked.length,
      cleanRun: input.cleanRun,
      partitioned: input.trackedSubset !== null,
    });

    const listing = await this.fetchListing();
    const untrackedManga = this.findUntrackedManga(listing.catalogue);

    const now = Math.floor(Date.now() / 1000);
    const postedChapterIds = new Set(input.postedChapterIds);
    const plan = planFetch({
      tracked,
      trackedSubset: input.trackedSubset,
      cleanRun: input.cleanRun,
      postedChapterIds,
      listing: listing.entries,
      updateFeedsAvailable: listing.updateFeedsAvailable,
      windowStart: now - UPDATE_WINDOW_SECONDS,
    });
    this.ctx.log("MangaPlus fetch plan", {
      candidates: plan.candidates,
      detailCalls: plan.fetch.length,
      skipped: plan.candidates - plan.fetch.length,
      skipReasons: plan.skipCounts,
      // A tracked series no listing mentions is skipped until the next clean
      // run, so name the first few: a series that vanished from MangaPlus and
      // one publoader has mistracked look identical from here.
      absentFromListing: plan.skipped
        .filter((title) => title.reason === "absent-from-listing")
        .slice(0, 20)
        .map((title) => title.mangaId),
    });

    const allChapters: RawChapter[] = [];
    const updatedChapters: RawChapter[] = [];

    const perManga = await runWithConcurrency(plan.fetch, TITLE_CONCURRENCY, (mangaId) =>
      this.fetchMangaChapters(mangaId),
    );

    const failedManga: string[] = [];

    perManga.forEach((result, index) => {
      if (result.failed) {
        const mangaId = plan.fetch[index];
        if (mangaId !== undefined) failedManga.push(mangaId);
      }
    });

    for (const { chapters } of perManga) {
      allChapters.push(...chapters);
      for (const chapter of chapters) {
        // MangaPlus rotates free chapters out; anything already expired, or
        // older than the update window, is not a new upload.
        if (postedChapterIds.has(chapter.chapterId)) continue;
        if (chapter.chapterExpire < now) continue;
        if (chapter.chapterTimestamp < now - UPDATE_WINDOW_SECONDS) continue;
        updatedChapters.push(chapter);
      }
    }

    this.ctx.log("MangaPlus collection finished", {
      listingTitles: listing.entries.size,
      listingSources: listing.sources,
      candidates: plan.candidates,
      detailCalls: plan.fetch.length,
      chapters: allChapters.length,
      updatedChapters: updatedChapters.length,
      untrackedManga: untrackedManga.length,
      failedManga: failedManga.length,
      cleanRun: input.cleanRun,
    });

    if (failedManga.length > 0) {
      // Named, not counted: a title that fails every run is a series to untrack
      // or a bug, and neither shows up in a total.
      this.ctx.log("MangaPlus could not read some series; their removal pass is skipped", {
        failed: failedManga.length,
        of: plan.fetch.length,
        mangaIds: failedManga.slice(0, 20),
      });
    }

    // Every fetched series failing is the API refusing us, not a catalogue that
    // emptied itself. Publishing that as a clean run's catalogue would claim
    // MangaPlus has nothing at all.
    if (plan.fetch.length > 0 && failedManga.length === plan.fetch.length) {
      throw new Error(
        `MangaPlus: every fetched series failed (${failedManga.length}); ` +
          `treating this as a source failure rather than an empty catalogue`,
      );
    }

    return {
      updatedChapters: updatedChapters.map(toChapterInput),
      // Only a clean run fetched every tracked series, so only a clean run can
      // claim to report the full catalogue. Anything else must send null —
      // absence means "no removal information", never "everything was removed".
      allChapters: input.cleanRun ? allChapters.map(toChapterInput) : null,
      untrackedManga,
      // Series that could not be read. Without this the entries missing from
      // `allChapters` above would read as removals and unpublish them.
      failedManga,
    };
  }

  private async loadOverrideOptions(): Promise<OverrideOptions> {
    // data_files declares the logical name and the filename; which one
    // dataFile() keys on is the runner's business, so try both.
    for (const name of ["override_options", "override_options.json"]) {
      try {
        return JSON.parse(await this.ctx.dataFile(name)) as OverrideOptions;
      } catch {
        continue;
      }
    }
    this.ctx.log("No readable override_options; continuing without overrides");
    return {};
  }

  /**
   * One API call, decoded but not judged.
   *
   * Split out of `requestApi` because the availability check needs the
   * distinction `requestApi` throws away. "MangaPlus answered, and its answer
   * was an error" and "we never got an answer" both mean "skip this work" to
   * every other caller, but to the dead-chapter check they are opposites: the
   * first can be a statement about the chapter, the second is never a statement
   * about anything.
   */
  private async requestResponse(
    path: string,
    params: Record<string, string | number> = {},
  ): Promise<{ kind: "answered"; response: PbResponse; url: string } | { kind: "failed"; detail: string; url: string }> {
    const url = new URL(path, API_BASE);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }
    const href = url.toString();

    let raw: Uint8Array;
    try {
      const response = await this.ctx.fetch(url, { headers: realUserHeaders() });
      if (response.status !== 200) {
        return { kind: "failed", detail: `status ${response.status}`, url: href };
      }
      raw = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      return { kind: "failed", detail: `transport: ${String(error)}`, url: href };
    }

    try {
      return { kind: "answered", response: decodeResponse(raw), url: href };
    } catch (error) {
      const kind = error instanceof ProtoDecodeError ? "protobuf" : "unexpected";
      return { kind: "failed", detail: `decode ${kind}: ${String(error)}`, url: href };
    }
  }

  /**
   * `_request_api`. Returns the `success` message, or null when the request,
   * the decode, or the API itself failed — every caller treats null as "skip
   * this piece of work", exactly as the Python original did.
   */
  private async requestApi(
    path: string,
    params: Record<string, string | number> = {},
  ): Promise<PbSuccessResult | null> {
    const outcome = await this.requestResponse(path, params);
    if (outcome.kind === "failed") {
      this.ctx.log("Couldn't get details from the MangaPlus API", {
        url: outcome.url,
        error: outcome.detail,
      });
      return null;
    }

    const success = outcome.response.success;
    if (!success || Object.keys(success).length === 0) {
      // The Python version raised a Discord webhook here; on the platform the
      // job log is the operator-visible channel.
      this.ctx.log("MangaPlus API returned an error", {
        url: outcome.url,
        action: outcome.response.error?.action,
        subject: outcome.response.error?.englishPopup?.subject,
        body: outcome.response.error?.englishPopup?.body,
      });
      return null;
    }
    return success;
  }

  /**
   * The three cheap listing calls, issued once per run: the catalogue and the
   * two update feeds. They are what lets `planner.ts` skip series, so their
   * failure modes matter more than their contents:
   *
   *  - the catalogue failing costs untracked-series detection for this run
   *    (as it always did) but not the skipping, which reads the update feeds;
   *  - BOTH update feeds failing disables skipping entirely — with no listing,
   *    absence from it proves nothing, so the run falls back to fetching every
   *    tracked series exactly as the Python version did.
   */
  private async fetchListing(): Promise<Listing> {
    const [catalogue, webHome, updated] = await Promise.all([
      this.requestApi("title_list/allV2"),
      this.requestApi("web/web_homeV4"),
      this.requestApi("title_list/updated"),
    ]);
    if (catalogue === null) this.ctx.log("Couldn't fetch all the MangaPlus series");

    const listing = buildListing({ catalogue, webHome, updated });

    if (!listing.feedsAnswered) {
      this.ctx.log("No MangaPlus update feed answered; fetching every tracked series");
    } else if (listing.updateSignals === 0) {
      // MangaPlus publishes something every day, so feeds that answer and name
      // no updated title are far more likely to have moved a protobuf field
      // number than to be idle. Fetch everything rather than read it as
      // "nothing to do" and silently upload nothing.
      this.ctx.log(
        "MangaPlus update feeds named no updated titles; fetching every tracked series",
        { webHome: webHome !== null, updated: updated !== null },
      );
    } else if (webHome === null || updated === null) {
      this.ctx.log("A MangaPlus update feed didn't answer; coverage is narrower this run", {
        webHome: webHome !== null,
        updated: updated !== null,
      });
    }

    return listing;
  }

  /**
   * `_get_untracked_manga`: catalogue entries we have no MangaDex title for.
   * Reads the catalogue the listing already fetched, so this costs no request.
   */
  private findUntrackedManga(catalogue: readonly PbAllTitlesGroup[]): MangaInput[] {
    // Membership is tested against every tracked series, not just this
    // segment's, so a partitioned run never reports a title another segment owns.
    const known = new Set([...this.ctx.mangaIdMap.keys(), ...(this.options.no_chapters ?? [])]);

    const untracked: MangaInput[] = [];
    for (const group of catalogue) {
      for (const title of group.titles ?? []) {
        if (title.titleId === undefined) continue;

        const mangaId = String(title.titleId);
        if (known.has(mangaId)) continue;

        // The Python original used the group's shared title; the per-language
        // title name is the fallback when the group has none.
        const mangaName = group.theTitle ?? title.name;
        if (mangaName === undefined) {
          this.ctx.log("Skipping untracked MangaPlus title with no name", { mangaId });
          continue;
        }

        untracked.push({
          mangaId,
          mangaName,
          mangaLanguage: resolveLanguage(title.language ?? "ENGLISH", mangaId, this.options),
          mangaUrl: MANGA_URL(mangaId),
        });
      }
    }
    return untracked;
  }

  /**
   * Ask `manga_viewer` what one chapter actually serves.
   *
   * The listing is not consulted here on purpose: the whole point is to get a
   * second, independent answer to "is this chapter real?", and the listing is
   * the source that has already been shown to say yes about chapters nobody
   * can open.
   */
  private async fetchViewerOutcome(chapterId: string): Promise<ViewerOutcome> {
    const outcome = await this.requestResponse("manga_viewer", {
      chapter_id: chapterId,
      ...VIEWER_PARAMS,
    });
    if (outcome.kind === "failed") return { kind: "unknown", detail: outcome.detail };
    return outcomeFromResponse(outcome.response);
  }

  /**
   * Which of these chapters are dead — listed by MangaPlus but serving no
   * pages.
   *
   * Returns the verdicts together with whether they may be acted on. They may
   * not be when MangaPlus has rejected this client, or when the share of dead
   * chapters is too high to be a real catalogue and too plausible to be a
   * throttle; `deadFindingsTrustworthy` states that rule. A run that cannot
   * trust its findings keeps every chapter, which is exactly the behaviour that
   * existed before this check.
   */
  private async judgeAvailability(
    chapters: readonly RawChapter[],
  ): Promise<{ verdicts: Map<string, ChapterAvailability>; trusted: boolean }> {
    const verdicts = new Map<string, ChapterAvailability>();
    // `normaliseChapters` emits one entry per MangaDex chapter number, so a
    // `multi_chapters` chapter appears several times under one MangaPlus id.
    const chapterIds = [...new Set(chapters.map((chapter) => chapter.chapterId))];
    if (chapterIds.length === 0) return { verdicts, trusted: true };

    const capped = chapterIds.length > MAX_VIEWER_CALLS;
    const toCheck = capped ? chapterIds.slice(0, MAX_VIEWER_CALLS) : chapterIds;
    if (capped) {
      this.ctx.log("Too many chapters to check for pages; the rest are left as-is", {
        chapters: chapterIds.length,
        checked: toCheck.length,
        unchecked: chapterIds.length - toCheck.length,
      });
    }

    // Set the moment any response says MangaPlus has rejected the client
    // rather than the chapter. Every call still in flight finishes, but no new
    // one starts: past that point the answers describe us, not the catalogue.
    let clientRejected = false;
    const errorDetails = new Map<string, number>();

    await runWithConcurrency(toCheck, VIEWER_CONCURRENCY, async (chapterId) => {
      if (clientRejected) return;

      const outcome = await this.fetchViewerOutcome(chapterId);
      if (outcome.kind === "unknown") {
        errorDetails.set(outcome.detail, (errorDetails.get(outcome.detail) ?? 0) + 1);
        if (outcome.clientRejected) clientRejected = true;
      }
      verdicts.set(chapterId, chapterAvailability(outcome));
    });

    let dead = 0;
    let judged = 0;
    for (const availability of verdicts.values()) {
      if (availability.verdict === "unknown") continue;
      judged += 1;
      if (availability.verdict === "dead") dead += 1;
    }

    const trusted = deadFindingsTrustworthy({ judged, dead, clientRejected });
    this.ctx.log("MangaPlus page-count check finished", {
      checked: toCheck.length,
      judged,
      dead,
      unknown: toCheck.length - judged,
      clientRejected,
      trusted,
      // Named so an error code that turns out to be chapter-level can be
      // promoted in `availability.ts` on evidence rather than on a guess.
      errors: Object.fromEntries([...errorDetails].slice(0, 10)),
    });
    if (!trusted) {
      this.ctx.log(
        "MangaPlus page-count findings are not trustworthy; no chapter will be dropped this run",
        { judged, dead, clientRejected },
      );
    }

    return { verdicts, trusted };
  }

  /**
   * Retrieve one page of a chapter about to be uploaded and confirm it is an
   * image.
   *
   * A page count is MangaPlus' word for it, and MangaPlus' word is what put a
   * dead chapter on MangaDex. This is the only step that checks the thing a
   * reader will actually experience, so it runs where it matters most and
   * costs least: over the handful of chapters a run is about to publish, never
   * over the catalogue.
   *
   *  - "bad"     — the page was served and is not an image. The chapter is
   *                treated as dead.
   *  - "unknown" — nothing could be retrieved. Not evidence; the chapter is
   *                published as it would have been before this check existed.
   */
  private async verifyFirstPage(chapterId: string): Promise<"ok" | "bad" | "unknown"> {
    const outcome = await this.requestResponse("manga_viewer", {
      chapter_id: chapterId,
      ...VIEWER_PARAMS,
    });
    if (outcome.kind === "failed") return "unknown";

    const viewer = outcome.response.success?.mangaViewer;
    const page = (viewer?.pages ?? [])
      .map((entry) => entry.mangaPage)
      .find((mangaPage) => mangaPage?.imageUrl);
    if (!page?.imageUrl) return "bad";

    try {
      const response = await this.ctx.fetch(page.imageUrl, { headers: realUserHeaders() });
      if (response.status !== 200) return "unknown";
      const body = decryptImage(
        new Uint8Array(await response.arrayBuffer()),
        page.encryptionKey,
      );
      return looksLikeImage(body) ? "ok" : "bad";
    } catch {
      return "unknown";
    }
  }

  /**
   * `_chapter_updates` for one series: every chapter it currently lists.
   *
   * `failed` separates "this series has no chapters" from "this series could
   * not be read". Both used to return an empty array, and the difference
   * matters enormously on a clean run: a title missing from the catalogue
   * snapshot is read by the platform as "the publisher dropped it", so a single
   * failed `title_detailV3` call would unpublish that series' whole back
   * catalogue on MangaDex. A failed title is reported in `failedManga` instead,
   * which holds it out of the removal pass.
   */
  private async fetchMangaChapters(
    externalMangaId: string,
  ): Promise<{ chapters: RawChapter[]; failed: boolean }> {
    const success = await this.requestApi("title_detailV3", { title_id: externalMangaId });
    if (success === null) return { chapters: [], failed: true };

    const detail = success.titleDetailView ?? {};
    const manga = this.normaliseManga(detail.title ?? {});
    if (manga === null) {
      // The response decoded but carries no title id, so it says nothing about
      // this series either. Unreadable, not empty.
      this.ctx.log("MangaPlus title detail had no title id", { externalMangaId });
      return { chapters: [], failed: true };
    }

    const groups = (detail.chapterListGroup ?? []).map((group) =>
      this.normaliseChapterObjects(
        [
          ...(group.firstChapterList ?? []),
          ...(group.midChapterList ?? []),
          ...(group.lastChapterList ?? []),
        ],
        manga,
      ),
    );

    return { chapters: normaliseChapters(groups, this.options, this.numberWords), failed: false };
  }

  /** `_normalise_manga_object`. */
  private normaliseManga(
    title: PbTitle,
  ): { mangaId: string; mangaName: string | null; language: string } | null {
    if (title.titleId === undefined) return null;

    const mangaId = String(title.titleId);
    // A missing language means the proto3 default, ENGLISH; the Python version
    // short-circuits to "en" in that case without consulting custom_language.
    const language =
      title.language === undefined
        ? "en"
        : resolveLanguage(title.language, mangaId, this.options);

    return { mangaId, mangaName: title.name ?? null, language };
  }

  /** `_normalise_chapter_object`. */
  private normaliseChapterObjects(
    chapters: readonly PbChapter[],
    manga: { mangaId: string; mangaName: string | null; language: string },
  ): RawChapter[] {
    const normalised: RawChapter[] = [];
    for (const chapter of chapters) {
      if (chapter.chapterId === undefined) continue;

      const chapterId = String(chapter.chapterId);
      normalised.push({
        chapterId,
        chapterUrl: CHAPTER_URL(chapterId),
        chapterTimestamp: chapter.startTimeStamp ?? DEFAULT_TIMESTAMP,
        chapterExpire: chapter.endTimeStamp ?? DEFAULT_TIMESTAMP,
        chapterTitle: chapter.subTitle ?? null,
        chapterNumber: chapter.name ?? null,
        chapterLanguage: manga.language,
        mangaId: manga.mangaId,
        mangaName: manga.mangaName,
        mangaUrl: MANGA_URL(manga.mangaId),
      });
    }
    return normalised;
  }
}

const factory: ExtensionFactory = (ctx) => new MangaPlus(ctx);
export default factory;
