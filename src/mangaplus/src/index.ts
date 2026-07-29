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

async function runWithConcurrency<T>(
  items: readonly string[],
  limit: number,
  worker: (item: string) => Promise<T>,
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

  constructor(private readonly ctx: ExtensionContext) {}

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

    for (const chapters of perManga) {
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
      cleanRun: input.cleanRun,
    });

    return {
      updatedChapters: updatedChapters.map(toChapterInput),
      // Only a clean run fetched every tracked series, so only a clean run can
      // claim to report the full catalogue. Anything else must send null —
      // absence means "no removal information", never "everything was removed".
      allChapters: input.cleanRun ? allChapters.map(toChapterInput) : null,
      untrackedManga,
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
   * `_request_api`. Returns the `success` message, or null when the request,
   * the decode, or the API itself failed — every caller treats null as "skip
   * this piece of work", exactly as the Python original did.
   */
  private async requestApi(
    path: string,
    params: Record<string, string | number> = {},
  ): Promise<PbSuccessResult | null> {
    const url = new URL(path, API_BASE);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }

    let raw: Uint8Array;
    try {
      const response = await this.ctx.fetch(url, { headers: realUserHeaders() });
      if (response.status !== 200) {
        this.ctx.log("MangaPlus API request failed", {
          url: url.toString(),
          status: response.status,
        });
        return null;
      }
      raw = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      this.ctx.log("Couldn't get details from the MangaPlus API", {
        url: url.toString(),
        error: String(error),
      });
      return null;
    }

    let decoded: PbResponse;
    try {
      decoded = decodeResponse(raw);
    } catch (error) {
      const kind = error instanceof ProtoDecodeError ? "protobuf" : "unexpected";
      this.ctx.log("Couldn't decode the MangaPlus API response", {
        url: url.toString(),
        kind,
        error: String(error),
      });
      return null;
    }

    const success = decoded.success;
    if (!success || Object.keys(success).length === 0) {
      // The Python version raised a Discord webhook here; on the platform the
      // job log is the operator-visible channel.
      this.ctx.log("MangaPlus API returned an error", {
        url: url.toString(),
        action: decoded.error?.action,
        subject: decoded.error?.englishPopup?.subject,
        body: decoded.error?.englishPopup?.body,
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

  /** `_chapter_updates` for one series: every chapter it currently lists. */
  private async fetchMangaChapters(externalMangaId: string): Promise<RawChapter[]> {
    const success = await this.requestApi("title_detailV3", { title_id: externalMangaId });
    if (success === null) return [];

    const detail = success.titleDetailView ?? {};
    const manga = this.normaliseManga(detail.title ?? {});
    if (manga === null) {
      this.ctx.log("MangaPlus title detail had no title id", { externalMangaId });
      return [];
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

    return normaliseChapters(groups, this.options, this.numberWords);
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
