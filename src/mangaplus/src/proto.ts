/**
 * Minimal protobuf wire-format decoder for the MangaPlus API.
 *
 * The schema below mirrors `mangaplus.proto` field-for-field — that file stays
 * authoritative for field numbers. Only two wire types occur in these messages
 * (varint and length-delimited), so a full protobuf runtime buys nothing; this
 * decoder is ~150 lines and keeps the published bundle dependency-free.
 *
 * Output shape deliberately reproduces `google.protobuf.json_format
 * .MessageToDict` on the Python side, because the port's field lookups were
 * written against it:
 *   - keys are the protobuf JSON names (start_time_stamp -> startTimeStamp);
 *   - proto3 scalars equal to their default are ABSENT, not zero/empty — the
 *     `?? DEFAULT_TIMESTAMP` fallbacks in the port depend on this;
 *   - empty repeated fields and unset sub-messages are absent;
 *   - enums decode to their name ("SPANISH"), or the raw number if unknown.
 */

export type PbValue = string | number | boolean | PbMessage | PbValue[];
export interface PbMessage {
  [key: string]: PbValue | undefined;
}

export class ProtoDecodeError extends Error {}

type ScalarKind = "string" | "bytes" | "uint32" | "int32" | "bool";
type FieldKind = ScalarKind | { message: string } | { enum: string };

interface FieldSpec {
  name: string;
  kind: FieldKind;
  repeated?: boolean;
}

const ENUMS: Record<string, Record<number, string>> = {
  Language: {
    0: "ENGLISH",
    1: "SPANISH",
    2: "FRENCH",
    3: "INDONESIAN",
    4: "PORTUGUESE_BR",
    5: "RUSSIAN",
    6: "THAI",
    7: "GERMAN",
    8: "UNKNOWN_LANGUAGE_8",
    9: "VIETNAMESE",
  },
  "ErrorResult.Action": {
    0: "DEFAULT",
    1: "UNAUTHORIZED",
    2: "MAINTENANCE",
    3: "GEOIP_BLOCKING",
  },
};

const MESSAGES: Record<string, Record<number, FieldSpec>> = {
  TransitionAction: {
    1: { name: "method", kind: "int32" },
    2: { name: "url", kind: "string" },
  },
  Banner: {
    1: { name: "image_url", kind: "string" },
    2: { name: "action", kind: { message: "TransitionAction" } },
    3: { name: "id", kind: "uint32" },
  },
  Title: {
    1: { name: "title_id", kind: "uint32" },
    2: { name: "name", kind: "string" },
    3: { name: "author", kind: "string" },
    4: { name: "portrait_image_url", kind: "string" },
    5: { name: "landscape_image_url", kind: "string" },
    6: { name: "view_count", kind: "uint32" },
    7: { name: "language", kind: { enum: "Language" } },
  },
  Chapter: {
    1: { name: "title_id", kind: "uint32" },
    2: { name: "chapter_id", kind: "uint32" },
    3: { name: "name", kind: "string" },
    4: { name: "sub_title", kind: "string" },
    5: { name: "thumbnail_url", kind: "string" },
    6: { name: "start_time_stamp", kind: "uint32" },
    7: { name: "end_time_stamp", kind: "uint32" },
    8: { name: "already_viewed", kind: "bool" },
    9: { name: "is_vertical_only", kind: "bool" },
    13: { name: "view_count", kind: "uint32" },
    14: { name: "comment_count", kind: "uint32" },
  },
  ChapterGroup: {
    1: { name: "chapter_numbers", kind: "string" },
    2: { name: "first_chapter_list", kind: { message: "Chapter" }, repeated: true },
    3: { name: "mid_chapter_list", kind: { message: "Chapter" }, repeated: true },
    4: { name: "last_chapter_list", kind: { message: "Chapter" }, repeated: true },
  },
  TitleDetailView: {
    1: { name: "title", kind: { message: "Title" } },
    2: { name: "title_image_url", kind: "string" },
    3: { name: "overview", kind: "string" },
    4: { name: "background_image_url", kind: "string" },
    5: { name: "next_time_stamp", kind: "uint32" },
    7: { name: "viewing_period_description", kind: "string" },
    8: { name: "non_appearance_info", kind: "string" },
    11: { name: "banners", kind: { message: "Banner" }, repeated: true },
    14: { name: "is_simul_released", kind: "bool" },
    16: { name: "rating", kind: "int32" },
    18: { name: "number_of_views", kind: "uint32" },
    28: { name: "chapter_list_group", kind: { message: "ChapterGroup" }, repeated: true },
  },
  MangaPage: {
    1: { name: "image_url", kind: "string" },
    2: { name: "width", kind: "uint32" },
    3: { name: "height", kind: "uint32" },
    4: { name: "type", kind: "int32" },
    5: { name: "encryption_key", kind: "string" },
  },
  Page: {
    1: { name: "manga_page", kind: { message: "MangaPage" } },
  },
  MangaViewer: {
    1: { name: "pages", kind: { message: "Page" }, repeated: true },
    2: { name: "chapter_id", kind: "uint32" },
    3: { name: "chapters", kind: { message: "Chapter" }, repeated: true },
    5: { name: "title_name", kind: "string" },
    6: { name: "chapter_name", kind: "string" },
    8: { name: "is_vertical_only", kind: "bool" },
    9: { name: "title_id", kind: "uint32" },
    10: { name: "start_from_right", kind: "bool" },
  },
  UpdatedTitle: {
    1: { name: "title", kind: { message: "Title" } },
    2: { name: "updated_time_stamp", kind: "string" },
  },
  TitleUpdatedView: {
    1: { name: "latest_title", kind: { message: "UpdatedTitle" }, repeated: true },
  },
  AllTitlesGroup: {
    1: { name: "the_title", kind: "string" },
    2: { name: "titles", kind: { message: "Title" }, repeated: true },
  },
  AllTitlesViewV2: {
    1: { name: "all_titles_group", kind: { message: "AllTitlesGroup" }, repeated: true },
  },
  UpdatedChapterTitle: {
    1: { name: "title", kind: { message: "Title" } },
    2: { name: "chapter_id", kind: "uint32" },
    3: { name: "chapter_name", kind: "string" },
    4: { name: "chapter_sub_title", kind: "string" },
    5: { name: "is_latest", kind: "bool" },
  },
  UpdatedTitleV2Group: {
    1: { name: "the_title", kind: "string" },
    2: { name: "chapter_number", kind: "string" },
    3: { name: "titles", kind: { message: "UpdatedChapterTitle" }, repeated: true },
    4: { name: "view_count", kind: "uint32" },
    6: { name: "chapter_start_time", kind: "uint32" },
  },
  WebHomeGroup: {
    1: { name: "group_name", kind: "string" },
    2: { name: "title_groups", kind: { message: "UpdatedTitleV2Group" }, repeated: true },
  },
  WebHomeViewV4: {
    1: { name: "top_banners", kind: { message: "Banner" }, repeated: true },
    2: { name: "groups", kind: { message: "WebHomeGroup" }, repeated: true },
  },
  Popup: {
    1: { name: "subject", kind: "string" },
    2: { name: "body", kind: "string" },
  },
  ErrorResult: {
    1: { name: "action", kind: { enum: "ErrorResult.Action" } },
    2: { name: "english_popup", kind: { message: "Popup" } },
    3: { name: "spanish_popup", kind: { message: "Popup" } },
    4: { name: "debug_info", kind: "string" },
  },
  SuccessResult: {
    8: { name: "title_detail_view", kind: { message: "TitleDetailView" } },
    10: { name: "manga_viewer", kind: { message: "MangaViewer" } },
    20: { name: "title_updated_view", kind: { message: "TitleUpdatedView" } },
    25: { name: "all_titles_view_v2", kind: { message: "AllTitlesViewV2" } },
    38: { name: "web_home_view_v4", kind: { message: "WebHomeViewV4" } },
  },
  Response: {
    1: { name: "success", kind: { message: "SuccessResult" } },
    2: { name: "error", kind: { message: "ErrorResult" } },
  },
};

/** protobuf's json_name: drop each underscore, upper-case what follows. */
function jsonName(protoName: string): string {
  return protoName.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

const JSON_NAMES = new Map<string, string>();
for (const fields of Object.values(MESSAGES)) {
  for (const field of Object.values(fields)) {
    JSON_NAMES.set(field.name, jsonName(field.name));
  }
}

const TEXT_DECODER = new TextDecoder("utf-8");

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH = 2;
const WIRE_FIXED32 = 5;

class Reader {
  pos: number;
  // Explicit fields rather than TS parameter properties: these modules are
  // executed directly by node --test, whose type-stripping loader does not
  // implement parameter properties.
  readonly buf: Uint8Array;
  readonly end: number;

  constructor(buf: Uint8Array, start: number, end: number) {
    this.buf = buf;
    this.end = end;
    this.pos = start;
  }

  /** A reader over a sub-range of the same buffer. */
  sub(start: number, stop: number): Reader {
    return new Reader(this.buf, start, stop);
  }

  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (this.pos >= this.end) throw new ProtoDecodeError("truncated varint");
      const byte = this.buf[this.pos++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 63n) throw new ProtoDecodeError("varint longer than 64 bits");
    }
  }

  /** Start/end offsets of the next length-delimited field, cursor advanced. */
  slice(): [number, number] {
    const length = Number(this.varint());
    const start = this.pos;
    const stop = start + length;
    if (length < 0 || stop > this.end) throw new ProtoDecodeError("truncated field");
    this.pos = stop;
    return [start, stop];
  }

  string(start: number, stop: number): string {
    return TEXT_DECODER.decode(this.buf.subarray(start, stop));
  }

  bytes(start: number, stop: number): string {
    // MessageToDict base64-encodes `bytes`; no consumed field uses it, so the
    // hex form here is only ever a debugging aid.
    let out = "";
    for (let i = start; i < stop; i++) out += this.buf[i].toString(16).padStart(2, "0");
    return out;
  }

  skip(wireType: number): void {
    switch (wireType) {
      case WIRE_VARINT:
        this.varint();
        return;
      case WIRE_FIXED64:
        this.pos += 8;
        return;
      case WIRE_LENGTH:
        this.slice();
        return;
      case WIRE_FIXED32:
        this.pos += 4;
        return;
      default:
        throw new ProtoDecodeError(`unsupported wire type ${wireType}`);
    }
  }
}

function isVarintKind(kind: FieldKind): boolean {
  if (kind === "uint32" || kind === "int32" || kind === "bool") return true;
  return typeof kind === "object" && "enum" in kind;
}

function scalarFromVarint(kind: FieldKind, raw: bigint): { value: PbValue; isDefault: boolean } {
  if (kind === "bool") return { value: raw !== 0n, isDefault: raw === 0n };
  if (kind === "uint32") {
    const value = Number(BigInt.asUintN(32, raw));
    return { value, isDefault: value === 0 };
  }
  if (kind === "int32") {
    const value = Number(BigInt.asIntN(32, raw));
    return { value, isDefault: value === 0 };
  }
  if (typeof kind === "object" && "enum" in kind) {
    const number = Number(BigInt.asIntN(32, raw));
    return { value: ENUMS[kind.enum]?.[number] ?? number, isDefault: number === 0 };
  }
  throw new ProtoDecodeError("varint on a non-varint field");
}

function decodeMessage(reader: Reader, typeName: string): PbMessage {
  const spec = MESSAGES[typeName];
  const singular = new Map<number, { value: PbValue; isDefault: boolean }>();
  const repeated = new Map<number, PbValue[]>();

  while (reader.pos < reader.end) {
    const tag = Number(reader.varint());
    const fieldNumber = tag >>> 3;
    const wireType = tag & 7;
    const field = spec[fieldNumber];

    // Unknown fields, and known fields carrying an unexpected wire type, are
    // skipped rather than fatal: the API adds fields without warning.
    if (!field || wireType !== (isVarintKind(field.kind) ? WIRE_VARINT : WIRE_LENGTH)) {
      reader.skip(wireType);
      continue;
    }

    if (wireType === WIRE_VARINT) {
      singular.set(fieldNumber, scalarFromVarint(field.kind, reader.varint()));
      continue;
    }

    const [start, stop] = reader.slice();
    if (field.kind === "string" || field.kind === "bytes") {
      const value =
        field.kind === "string" ? reader.string(start, stop) : reader.bytes(start, stop);
      singular.set(fieldNumber, { value, isDefault: value === "" });
    } else if (typeof field.kind === "object" && "message" in field.kind) {
      const nested = decodeMessage(reader.sub(start, stop), field.kind.message);
      if (field.repeated) {
        const list = repeated.get(fieldNumber) ?? [];
        list.push(nested);
        repeated.set(fieldNumber, list);
      } else {
        singular.set(fieldNumber, { value: nested, isDefault: false });
      }
    } else {
      // Packed repeated scalars do not occur in this schema.
      throw new ProtoDecodeError(`unexpected length-delimited field ${typeName}.${field.name}`);
    }
  }

  const out: PbMessage = {};
  for (const [fieldNumber, entry] of singular) {
    if (entry.isDefault) continue;
    out[JSON_NAMES.get(spec[fieldNumber].name) ?? spec[fieldNumber].name] = entry.value;
  }
  for (const [fieldNumber, list] of repeated) {
    if (list.length === 0) continue;
    out[JSON_NAMES.get(spec[fieldNumber].name) ?? spec[fieldNumber].name] = list;
  }
  return out;
}

/** Decode a top-level `Response` message. */
export function decodeResponse(bytes: Uint8Array): PbResponse {
  return decodeMessage(new Reader(bytes, 0, bytes.length), "Response") as PbResponse;
}

// ---------------------------------------------------------------------------
// Typed views over the decoded messages. Every field is optional because
// proto3 defaults are dropped (see the note at the top of this file).
// ---------------------------------------------------------------------------

export interface PbTitle {
  titleId?: number;
  name?: string;
  author?: string;
  /** Language enum NAME; absent means ENGLISH. */
  language?: string;
}

export interface PbChapter {
  titleId?: number;
  chapterId?: number;
  /** Chapter number as displayed, e.g. "#001" or "ex". */
  name?: string;
  subTitle?: string;
  startTimeStamp?: number;
  endTimeStamp?: number;
}

export interface PbChapterGroup {
  chapterNumbers?: string;
  firstChapterList?: PbChapter[];
  midChapterList?: PbChapter[];
  lastChapterList?: PbChapter[];
}

export interface PbTitleDetailView {
  title?: PbTitle;
  chapterListGroup?: PbChapterGroup[];
}

export interface PbAllTitlesGroup {
  theTitle?: string;
  titles?: PbTitle[];
}

/** One language's release of a chapter, as the web home page lists it. */
export interface PbUpdatedChapterTitle {
  title?: PbTitle;
  chapterId?: number;
  chapterName?: string;
  chapterSubTitle?: string;
  /** Set when this is the title's newest chapter. */
  isLatest?: boolean;
}

/** One release on the web home page: the same chapter across languages. */
export interface PbUpdatedTitleV2Group {
  theTitle?: string;
  chapterNumber?: string;
  titles?: PbUpdatedChapterTitle[];
  /** Epoch seconds the chapter became readable. */
  chapterStartTime?: number;
}

export interface PbWebHomeGroup {
  groupName?: string;
  titleGroups?: PbUpdatedTitleV2Group[];
}

/**
 * An entry in `title_list/updated`. The wire type of `updated_time_stamp` was
 * derived empirically as a string; it is typed loosely here because a numeric
 * encoding would decode to a number, and the reader coerces either.
 */
export interface PbUpdatedTitle {
  title?: PbTitle;
  updatedTimeStamp?: string | number;
}

/** One image of a chapter, as `manga_viewer` returns it. */
export interface PbMangaPage {
  imageUrl?: string;
  width?: number;
  height?: number;
  /**
   * Repeating-key XOR key, as hex. Absent on the quality this extension
   * requests — those pages arrive as ordinary JPEGs — but still set on others,
   * so `decryptImage` handles both.
   */
  encryptionKey?: string;
}

/**
 * One entry of `MangaViewer.pages`. The array also carries advertisement and
 * "last page" entries under field numbers this schema does not declare, so an
 * entry with no `mangaPage` is deliberately possible and is not a manga page.
 */
export interface PbPage {
  mangaPage?: PbMangaPage;
}

export interface PbMangaViewer {
  pages?: PbPage[];
  chapterId?: number;
  titleId?: number;
}

export interface PbSuccessResult {
  titleDetailView?: PbTitleDetailView;
  mangaViewer?: PbMangaViewer;
  allTitlesViewV2?: { allTitlesGroup?: PbAllTitlesGroup[] };
  titleUpdatedView?: { latestTitle?: PbUpdatedTitle[] };
  webHomeViewV4?: { groups?: PbWebHomeGroup[] };
}

export interface PbPopup {
  subject?: string;
  body?: string;
}

export interface PbResponse {
  success?: PbSuccessResult;
  error?: { action?: string | number; englishPopup?: PbPopup; debugInfo?: string };
}
