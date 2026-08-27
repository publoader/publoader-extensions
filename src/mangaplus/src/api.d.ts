/**
 * Extension API v2 — local copy of the platform's type declarations so this
 * directory type-checks standalone.
 *
 * SOURCE OF TRUTH: publoader repo, `platform/src/contracts/extensionApi.ts`
 * (the zod schemas there are what actually validate a collect() result at
 * runtime). Nothing is imported across repos at build time; keep this file in
 * sync by hand when the contract moves.
 */

/** Chapter as produced by an extension (camelCase; datetimes ISO-8601 UTC). */
export interface ChapterInput {
  chapterTimestamp: string | null;
  chapterExpire: string | null;
  chapterLanguage: string | null;
  chapterNumber: string | null;
  chapterTitle: string | null;
  chapterVolume: string | null;
  chapterId: string;
  chapterUrl: string;
  mangaId: string;
  /** MangaDex title id; null lets the runner resolve it from the tracked map. */
  mdMangaId: string | null;
  mangaName: string | null;
  mangaUrl: string | null;
  images?: Uint8Array[];
}

export interface MangaInput {
  mangaId: string;
  mangaName: string;
  mangaLanguage: string;
  mangaUrl: string;
}

export interface CollectResult {
  updatedChapters: ChapterInput[];
  /** Full current catalogue; required on clean runs, null otherwise. */
  allChapters: ChapterInput[] | null;
  untrackedManga: MangaInput[];
  /**
   * External manga ids this run could not fetch, and therefore knows nothing
   * about.
   *
   * A title absent from `allChapters` is read by the platform as "the publisher
   * has nothing here any more", so a series that merely failed to load must be
   * named here rather than quietly omitted — omitting it unpublishes its whole
   * back catalogue on MangaDex. Listing it means "no information", and the
   * removal pass is skipped for that title alone.
   *
   * Optional: an extension that never reports failures behaves as before.
   */
  failedManga?: string[];
}

export interface CollectInput {
  /** Chapter ids already uploaded for this extension (empty on clean runs). */
  postedChapterIds: readonly string[];
  /** Clean run: return the full catalogue in allChapters. */
  cleanRun: boolean;
  /** One segment of a partitioned run: fetch only these external manga ids. */
  trackedSubset: readonly string[] | null;
}

export interface ExtensionContext {
  readonly manifest: Readonly<Record<string, unknown>>;
  /**
   * The extension's configuration as the DATABASE holds it — what the dashboard
   * edits, rather than what the bundle shipped with.
   *
   * Optional because an older runner does not send it, and an absent field must
   * not be mistaken for an empty configuration. The two are not merged for you:
   * how the database's copy relates to the bundled one is the extension's
   * decision to make explicitly.
   */
  readonly overrideOptions?: Readonly<Record<string, unknown>>;
  /** External manga id -> MangaDex title id, DB-authoritative. */
  readonly mangaIdMap: ReadonlyMap<string, string>;
  /** The only sanctioned network primitive; enforces manifest allowed_hosts. */
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
  /** Read a bundled data file (declared in manifest data_files). */
  dataFile(name: string): Promise<string>;
  /** Structured logging to the job's log stream (never stdout). */
  log(message: string, fields?: Record<string, unknown>): void;
}

export interface ExtensionRuntime {
  collect(input: CollectInput): Promise<CollectResult>;
}

export type ExtensionFactory = (
  ctx: ExtensionContext,
) => ExtensionRuntime | Promise<ExtensionRuntime>;
