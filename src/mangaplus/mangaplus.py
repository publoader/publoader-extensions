import asyncio
import logging
import re
import string
import traceback
from copy import deepcopy
from datetime import datetime, time, timezone
from pathlib import Path
from typing import List, Optional, Union

import aiohttp
import itertools
import math
import requests
from publoader.models.dataclasses import Chapter, Manga
from publoader.utils.logs import setup_extension_logs
from publoader.utils.misc import create_new_event_loop, find_key_from_list_value
from publoader.utils.utils import (
    chapter_number_regex,
    open_manga_id_map,
    open_title_regex,
)
from publoader.webhook import PubloaderWebhook

DEFAULT_TIMESTAMP = 1

__version__ = "0.2.04"

setup_extension_logs(
    logger_name="mangaplus",
    logger_filename="mangaplus",
)

logger = logging.getLogger("mangaplus")


class Extension:
    def __init__(self, extension_dirpath: Path, **kwargs):
        self.name = "mangaplus"
        self.mangadex_group_id = "4f1de6a2-f0c5-4ac5-bce5-02c7dbb67deb"
        self.manga_id_map_filename = "manga_id_map.json"
        self.override_options_filename = "override_options.json"
        self.extension_dirpath = extension_dirpath

        self.fetch_all_chapters = False
        self._posted_chapters_ids = []
        self._updated_chapters: List[Chapter] = []
        self._all_mplus_chapters: List[Chapter] = []
        self._untracked_manga: List[Manga] = []
        self._mplus_base_api_url = "https://jumpg-webapi.tokyo-cdn.com/api/"
        self._chapter_url_format = "https://mangaplus.shueisha.co.jp/viewer/{}"
        self._manga_url_format = "https://mangaplus.shueisha.co.jp/titles/{}"
        self._images_api_url = "https://jumpg-webapi.tokyo-cdn.com/api/manga_viewer?chapter_id={}&split=no&img_quality=super_high&format=json"

    @property
    def extension_languages_map(self):
        return {
            "ENGLISH": "en",
            "SPANISH": "es",
            "FRENCH": "fr",
            "INDONESIAN": "id",
            "PORTUGUESE_BR": "pt-br",
            "RUSSIAN": "ru",
            "THAI": "th",
            "GERMAN": "de",
            "VIETNAMESE": "vi",
        }

    @property
    def extension_languages(self) -> List[str]:
        return list(self.extension_languages_map.values())

    @property
    def disabled(self):
        return False

    def get_updated_chapters(self) -> List[Chapter]:
        return self._updated_chapters

    def get_all_chapters(self) -> List[Chapter]:
        return self._all_mplus_chapters if self.fetch_all_chapters else None

    def get_updated_manga(self) -> List[Manga]:
        return self._untracked_manga

    def update_external_data(
        self, posted_chapter_ids: List[str], fetch_all_chapters: bool, **kwargs
    ) -> None:
        self._posted_chapters_ids = posted_chapter_ids
        self.fetch_all_chapters = fetch_all_chapters

        self.fetch_updates()

    def run_at(self) -> time:
        return time(hour=15, minute=1, tzinfo=timezone.utc)

    def clean_at(self) -> Optional[list]:
        return [2]

    def daily_check_run(self) -> bool:
        return True

    def fetch_updates(self):
        self._manga_id_map = self._open_manga_id_map()
        self.tracked_mangadex_ids = list(self._manga_id_map.keys())
        self.tracked_manga = [
            mplus_id
            for md_id in self._manga_id_map
            for mplus_id in self._manga_id_map[md_id]
        ]
        self.override_options = self._open_override_options()
        self._num2words: Optional[str] = self._get_num2words_string()
        self.manga_no_chapters = self.override_options.get("no_chapters", [])

        self._get_untracked_manga()
        self._get_manga_chapters()

    def _open_manga_id_map(self) -> "dict":
        return open_manga_id_map(
            self.extension_dirpath.joinpath(self.manga_id_map_filename)
        )

    def _open_override_options(self) -> "dict":
        return open_title_regex(
            self.extension_dirpath.joinpath(self.override_options_filename)
        )

    def _get_language(self, language: str, manga_id: str):
        if manga_id in self.override_options.get("custom_language", {}):
            return self.override_options["custom_language"][manga_id]

        if language in self.extension_languages:
            return language

        if language in self.extension_languages_map.keys():
            return self.extension_languages_map.get(language, "NULL")

        return "NULL"

    def _get_num2words_string(self):
        num2words_list = self.override_options.get("num2words")
        if num2words_list is None:
            return

        return "(" + "|".join(self.override_options.get("num2words")) + ")"

    def _normalise_manga_object(self, title_detail_view: dict):
        title_detail = title_detail_view.get("title", {})
        title_id = str(title_detail.get("titleId"))
        title_name = title_detail.get("name")
        title_language = "en"

        if "language" in title_detail:
            title_language = self._get_language(
                title_detail.get("language", "ENGLISH"), title_id
            )
        # elif "titleLanguages" in title_detail_view:
        #     title_languages = title_detail_view.get("titleLanguages", [])
        #     language_to_change = next(
        #         (
        #             item.get("language", "ENGLISH")
        #             for item in title_languages
        #             if item.get("titleId") == title_id
        #         ),
        #         "ENGLISH",
        #     )
        #     title_language = self._get_language(language_to_change, title_id)

        manga_object = Manga(
            manga_id=title_id,
            manga_name=title_name,
            manga_language=title_language,
            manga_url=self._manga_url_format.format(title_id),
        )
        return manga_object

    async def _request_api(self, path: str, **params) -> Optional[dict]:
        """Get manga and chapter details from the api."""
        if "format" not in params:
            params["format"] = "json"

        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    self._mplus_base_api_url + path, params=params
                ) as response:
                    assert response.status == 200
                    data = await response.json()

                    success_dict = data.get("success")
                    if not success_dict:
                        error_dict = data.get("error")
                        eng_error_dict = error_dict.get("englishPopup", {})

                        description = f"Error fetching MangaPlus API:\n`{response.url}`"
                        error_body = eng_error_dict.get("body")
                        if error_body:
                            description = description + f"\n{error_body}"

                        PubloaderWebhook(
                            "mangaplus",
                            footer={"text": "extensions.mangaplus"},
                            title=eng_error_dict.get(
                                "subject", "Error fetching MangaPlus API"
                            ),
                            description=description,
                        ).send()

                    return success_dict
        except (ZeroDivisionError, aiohttp.ClientError) as e:
            logger.error(f"{e}: Couldn't get details from the mangaplus api.")
            print("Request API Error", e)
            return None

    async def _fetch_title_data(self, manga_id: int, **params) -> Optional[dict]:
        """Get manga and chapter details from the api."""
        return await self._request_api("title_detailV3", title_id=manga_id, **params)

    async def _fetch_manga(self, **params) -> Optional[dict]:
        """Get manga and chapter details from the api."""
        return await self._request_api("title_list/allV2", **params)

    async def _fetch_updates(self, **params) -> Optional[dict]:
        """Get manga and chapter details from the api."""
        return await self._request_api(
            "home_v4",
            lang="eng",
            clang="eng,esp,tha,ptb,ind,rus,fra,deu,vie",
            **params,
        )

    async def _fetch_chapter_images(self, chapter_id: str, **params) -> Optional[dict]:
        """Get manga and chapter details from the api."""
        return await self._request_api(
            "manga_viewer",
            chapter_id=chapter_id,
            **params,
        )

    def _get_untracked_manga(self):
        """Find new untracked mangaplus series."""
        logger.info("Looking for new untracked manga.")
        print("Getting new manga.")

        loop = create_new_event_loop()
        task = self._fetch_manga()
        updated_manga_response = loop.run_until_complete(task)

        if not updated_manga_response:
            logger.error("Couldn't fetch all the MangaPlus series.")
            return

        updated_manga_unmerged = updated_manga_response.get("allTitlesViewV2", {}).get(
            "AllTitlesGroup", []
        )
        for series in updated_manga_unmerged:
            manga_name = series.get("theTitle")

            for manga in series.get("titles", []):
                manga_id = str(manga.get("titleId", ""))
                if manga_id not in self.tracked_manga + self.manga_no_chapters:
                    language = self._get_language(
                        manga.get("language", "ENGLISH"), manga_id
                    )

                    self._untracked_manga.append(
                        Manga(
                            manga_id=manga_id,
                            manga_name=manga_name,
                            manga_language=language,
                            manga_url=self._manga_url_format.format(manga_id),
                        )
                    )

    def _get_manga_chapters(self):
        """Get chapters of a series."""
        logger.info("Getting all manga chapters.")
        print("Getting all chapters.")
        tasks = []

        spliced_manga = [
            self.tracked_manga[elem : elem + 3]
            for elem in range(0, len(self.tracked_manga), 3)
        ]

        loop = create_new_event_loop()
        for mangas in spliced_manga:
            task = self._chapter_updates(mangas)
            tasks.append(task)

        loop.run_until_complete(asyncio.gather(*tasks))

    def _get_updates(self):
        """Get latest chapter updates."""
        logger.info("Looking for latest chapters.")
        print("Getting new chapters.")
        loop = create_new_event_loop()
        task = self._fetch_updates()
        fetched_updates = loop.run_until_complete(task)

        if not fetched_updates:
            return

        updates_response = fetched_updates.get("homeViewV3", {})
        updated_chapters = updates_response.get("groups", [])
        latest_updates_list_unmerged = updated_chapters[:2]
        latest_updates_list_merged = list(
            itertools.chain.from_iterable(
                [
                    chapter_list.get("titleGroups", [])
                    for chapter_list in latest_updates_list_unmerged
                ]
            )
        )
        updates = []

        for updated_chapter in latest_updates_list_merged:
            start_timestamp = updated_chapter.get("chapterStartTime", DEFAULT_TIMESTAMP)
            chapter_number = updated_chapter.get("chapterNumber")
            updated_chapter_data = updated_chapter.get("titles", [])[0]
            manga_object = self._normalise_manga_object(updated_chapter_data)

            chapter_object = Chapter(
                chapter_id=updated_chapter_data.get("chapterId"),
                chapter_url=self._chapter_url_format.format(
                    updated_chapter_data.get("chapterId")
                ),
                chapter_timestamp=datetime.fromtimestamp(start_timestamp),
                chapter_title=updated_chapter_data.get("chapterSubTitle"),
                chapter_number=chapter_number,
                chapter_language=manga_object.manga_language,
                manga_id=manga_object.manga_id,
                md_manga_id=find_key_from_list_value(
                    self._manga_id_map, manga_object.manga_id
                ),
                manga_name=manga_object.manga_name,
                manga_url=self._manga_url_format.format(manga_object.manga_id),
                extension_name=self.name,
            )

            updates.extend(
                self.normalise_chapter_fields([chapter_object], chapter_object)
            )

        updated_chapters = [
            chapter
            for chapter in updates
            if str(chapter.chapter_id) not in self._posted_chapters_ids
        ]

        if updated_chapters:
            logger.info(f"MangaPlus newly updated chapters: {updated_chapters}")

        self._updated_chapters.extend(updated_chapters)

    def _decrypt_image(self, url: str, encryption_hex: str) -> bytes:
        """Decrypt the image so it can be saved.
        Args:
            url (str): The image link.
            encryption_hex (str): The key to decrypt the image.
        Returns:
            bytearray: The image data.
        """
        res = requests.get(url)
        data = bytearray(res.content)
        key = bytes.fromhex(encryption_hex)
        a = len(key)
        for s in range(len(data)):
            data[s] ^= key[s % a]
        return bytes(data)

    def _fetch_chapter_images(self, chapter_id):
        """Fetch the images."""
        if self.fetch_all_chapters:
            return

        loop = create_new_event_loop()
        task = self._fetch_chapter_images(chapter_id)
        response = loop.run_until_complete(task)
        if not response:
            logger.error(f"Error fetching images data for chapter {chapter_id}.")

        viewer = response.get("pages", [])
        pages = [
            p.get("mangaPage", {})
            for p in viewer
            if p.get("mangaPage", {}).get("imageUrl")
        ]
        images = []

        logger.debug(f"{len(pages)} images for chapter {chapter_id}.")

        for page in pages:
            try:
                image = self._decrypt_image(
                    page.get("imageUrl"), page.get("encryptionKey")
                )
                if image is not None:
                    images.append(image)
            except requests.RequestException as e:
                traceback.print_exc()
                logger.exception(f"Error fetching image data for chapter {chapter_id}.")
                break

        if len(pages) == len(images):
            return images
        return

    def _normalise_chapter_object(
        self, chapter_list: List[dict], manga_object: Manga
    ) -> List[Chapter]:
        """Return a list of chapter objects made from the api chapter lists."""
        return [
            Chapter(
                chapter_id=mplus_chapter.get("chapterId"),
                chapter_url=self._chapter_url_format.format(
                    mplus_chapter.get("chapterId")
                ),
                chapter_timestamp=datetime.fromtimestamp(
                    mplus_chapter.get("startTimeStamp", DEFAULT_TIMESTAMP)
                ),
                chapter_title=mplus_chapter.get("subTitle"),
                chapter_expire=datetime.fromtimestamp(
                    mplus_chapter.get("endTimeStamp", DEFAULT_TIMESTAMP)
                ),
                chapter_number=mplus_chapter.get("name"),
                chapter_language=manga_object.manga_language,
                manga_id=manga_object.manga_id,
                md_manga_id=find_key_from_list_value(
                    self._manga_id_map, manga_object.manga_id
                ),
                manga_name=manga_object.manga_name,
                manga_url=self._manga_url_format.format(manga_object.manga_id),
                extension_name=self.name,
            )
            for mplus_chapter in chapter_list
        ]

    async def _chapter_updates(self, mangas: list):
        """Get the updated chapters from each manga."""
        # for now, an updated chapter should've been uploaded in the past 3 days
        time_epoch_now = datetime.now()
        time_epoch_yesterday = datetime.now() - 259200
        
        for manga in mangas:
            manga_response = await self._fetch_title_data(manga_id=manga)
            if not manga_response:
                continue

            title_detail_view = manga_response.get("titleDetailView", {})
            manga_object = self._normalise_manga_object(title_detail_view)

            manga_chapters_lists = []
            manga_chapter_list_group = title_detail_view.get("chapterListGroup", [])
            for chapter_list in manga_chapter_list_group:
                manga_chapters_lists.append(
                    self._normalise_chapter_object(
                        list(
                            itertools.chain(
                                chapter_list.get("firstChapterList", []),
                                chapter_list.get("lastChapterList", []),
                            )
                        ),
                        manga_object,
                    )
                )

            normalised_chapters = self.normalise_chapters(manga_chapters_lists)
            self._all_mplus_chapters.extend(normalised_chapters)

            updated_chapters = [
                chapter
                for chapter in normalised_chapters
                if str(chapter.chapter_id) not in self._posted_chapters_ids
                and chapter.chapter_expire >= time_epoch_now
                and chapter.chapter_timestamp >= time_epoch_yesterday
            ]
            # TODO: time_epoch_yesterday is a bodge
            # consider toggling an unavailable chapter or something (preserves comment threads)

            if updated_chapters:
                logger.info(f"MangaPlus newly updated chapters: {updated_chapters}")

            self._updated_chapters.extend(updated_chapters)

    def _get_surrounding_chapter(
        self,
        chapters: List[Chapter],
        current_chapter: Chapter,
        next_chapter_search: bool = False,
    ) -> Optional[Chapter]:
        """Find the chapter before or after the current."""
        # Starts from the first chapter before the current
        index_search = reversed(chapters[: chapters.index(current_chapter)])
        if next_chapter_search:
            # Starts from the first chapter after the current
            index_search = chapters[chapters.index(current_chapter) :]

        for chapter in index_search:
            number_match = re.match(
                pattern=r"^#?(\d+)", string=chapter.chapter_number, flags=re.I
            )

            if bool(number_match):
                number = number_match.group(1)
            else:
                number = re.split(
                    r"[\s{}]+".format(re.escape(string.punctuation)),
                    chapter.chapter_number.strip("#"),
                )[0]

            try:
                int(number)
            except ValueError:
                continue
            else:
                return chapter

    def _strip_chapter_number(self, number: Union[str, int]) -> str:
        """Returns the chapter number without the un-needed # or 0."""
        stripped = str(number).strip().strip("#")

        parts = re.split(r"\.|\-", stripped)
        parts[0] = "0" if len(parts[0].lstrip("0")) == 0 else parts[0].lstrip("0")
        stripped = ".".join(parts)

        return stripped

    def _normalise_chapter_number(
        self, chapters: List[Chapter], chapter: Chapter
    ) -> List[Optional[str]]:
        """Rid the extra data from the chapter number for use in ManagDex."""
        current_number = self._strip_chapter_number(chapter.chapter_number)
        chapter_number = chapter.chapter_number

        if chapter_number is not None:
            chapter_number = current_number

        if chapter_number == "ex":
            # Get previous chapter's number for chapter number
            previous_chapter = self._get_surrounding_chapter(chapters, chapter)
            next_chapter = self._get_surrounding_chapter(
                chapters, chapter, next_chapter_search=True
            )

            next_chapter_number = None
            if next_chapter is not None:
                next_chapter_number = self._strip_chapter_number(
                    next_chapter.chapter_number
                )
                next_chapter_number = (
                    int(re.split(r"\.|\-|\,", next_chapter_number)[0]) - 1
                )

            previous_chapter_number = None
            if previous_chapter is not None:
                previous_chapter_number = self._strip_chapter_number(
                    previous_chapter.chapter_number
                )
                if "," in previous_chapter_number:
                    previous_chapter_number = previous_chapter_number.split(",")[-1]
                else:
                    previous_chapter_number = re.split(
                        r"\.|\-", previous_chapter_number
                    )[0]

            if previous_chapter is None:
                # Previous chapter isn't available, use next chapter's number
                # if available
                if next_chapter is None:
                    chapter_number = None
                else:
                    chapter_number = next_chapter_number
                    first_index = next_chapter
                    second_index = chapter
            else:
                chapter_number = previous_chapter_number
                first_index = chapter
                second_index = previous_chapter

            if chapter_number == "ex":
                chapter_number = None

            if chapter_number is not None and current_number != "ex":
                # If difference between current chapter and previous/next
                # chapter is more than 5, use None as chapter_number
                if math.sqrt((int(current_number) - int(chapter_number)) ** 2) >= 5:
                    chapter_number = None

            if chapter_number is not None:
                chapter_decimal = "5"

                # There may be multiple extra chapters before the last numbered chapter
                # Use index difference as decimal to avoid not uploading
                # non-dupes
                try:
                    chapter_difference = chapters.index(first_index) - chapters.index(
                        second_index
                    )
                    if next_chapter is None:
                        chapter_decimal = chapter_difference

                    if chapter_difference > 1:
                        second_index_number = second_index.chapter_number
                        if "." in second_index_number:
                            try:
                                second_index_decimal = int(
                                    second_index_number.rsplit(".")[-1]
                                )
                            except ValueError:
                                pass
                            else:
                                chapter_decimal = second_index_decimal + 1
                        else:
                            chapter_decimal = chapter_difference
                except (ValueError, IndexError):
                    pass

                chapter_number = f"{chapter_number}.{chapter_decimal}"
        elif chapter_number is not None and chapter_number.lower() in (
            "one-shot",
            "one.shot",
        ):
            chapter_number = None
        elif chapter_number is not None and chapter_number.lower().startswith(
            ("spin-off", "spin.off")
        ):
            chapter_number = re.sub(
                r"(?:spin\-off|spin\.off)\s?", "", chapter_number.lower(), re.I
            ).strip()

        if chapter_number is None:
            chapter_number_split = [chapter_number]
        else:
            chapter_number_split = [
                self._strip_chapter_number(chap_number)
                for chap_number in chapter_number.split(",")
            ]

        returned_chapter_numbers = []
        for num in chapter_number_split:
            if num is None or not bool(chapter_number_regex.match(num)):
                returned_chapter_numbers.append(None)
            else:
                returned_chapter_numbers.append(num)

        if (
            chapter.chapter_id
            in self.override_options.get("override_chapter_numbers", {}).keys()
        ):
            returned_chapter_numbers = [
                self.override_options.get("override_chapter_numbers", {}).get(
                    chapter.chapter_id, *returned_chapter_numbers
                )
            ]
        elif (
            chapter.chapter_id in self.override_options.get("multi_chapters", {}).keys()
        ):
            returned_chapter_numbers = self.override_options.get(
                "multi_chapters", {}
            ).get(chapter.chapter_id, returned_chapter_numbers)

        return returned_chapter_numbers

    def _normalise_chapter_title(
        self, chapter: Chapter, chapter_number: List[Optional[str]]
    ) -> Optional[str]:
        """Strip away the title prefix."""
        colon_regex = re.compile(r"^(?:\S+\s*)?\d+(?:[\,\-\.]\d{0,2})?\s?:\s?", re.I)
        no_title_regex = re.compile(r"^\S+\s*\d+(?:[\,\-\.]\d{0,2})?$", re.I)
        hashtag_regex = re.compile(r"^(?:\S+\s*)?#\d+(?:[\,\-\.]\d{0,2})?\s?", re.I)
        period_dash_regex = re.compile(
            r"^(?:\S+\s*)?\d+(?:[\,\-\.]\d{0,2})?\s?[\.\/\-]\s?", re.I
        )
        spaces_regex = re.compile(r"^(?:\S+\s*)?\d+(?:[\,\-\.]\d{0,2})?\s?", re.I)
        final_chapter_regex = re.compile(
            r"^(?:final|last)\s?(?:chapter|ep|episode)\s?[\:\.]\s?", re.I
        )
        word_numbers_regex = None
        if self._num2words is not None:
            word_numbers_regex = re.compile(
                rf"^(?:\S+\s*)\s?{self._num2words}\s?(?:{self._num2words}\s?)?\:\s?",
                re.I,
            )

        original_title = str(chapter.chapter_title).strip()
        normalised_title = original_title
        pattern_to_use: Optional[re.Pattern[str]] = None
        replace_string = ""
        custom_regex = None

        if (
            chapter.manga_id in self.override_options.get("empty", [])
            and None not in chapter_number
            or original_title.lower() in ("final chapter",)
        ):
            normalised_title = None
            custom_regex = "Empty Title"
        elif chapter.manga_id in self.override_options.get("noformat", []):
            normalised_title = original_title
            custom_regex = "Original Title"
        elif str(chapter.manga_id) in self.override_options.get("custom", {}):
            pattern_to_use = re.compile(
                self.override_options["custom"][str(chapter.manga_id)], re.I
            )
            custom_regex = "Custom Regex"
        elif final_chapter_regex.match(original_title):
            pattern_to_use = final_chapter_regex
            custom_regex = "Final Chapter Regex"
        elif word_numbers_regex is not None and word_numbers_regex.match(
            original_title
        ):
            pattern_to_use = word_numbers_regex
            custom_regex = "Word Numbers Regex"
        elif colon_regex.match(original_title):
            pattern_to_use = colon_regex
        elif no_title_regex.match(original_title):
            pattern_to_use = no_title_regex
        elif period_dash_regex.match(original_title):
            pattern_to_use = period_dash_regex
        elif hashtag_regex.match(original_title):
            pattern_to_use = hashtag_regex
        elif spaces_regex.match(original_title):
            pattern_to_use = spaces_regex

        if pattern_to_use is not None:
            normalised_title = pattern_to_use.sub(
                repl=replace_string, string=original_title, count=1
            ).strip()

        if normalised_title is not None and normalised_title.lower() in (
            "",
            "none",
            "null",
        ):
            normalised_title = None

        # logger.debug(
        #     f"Chapter title normaliser chapter_id: {chapter.chapter_id}, manga_id: {chapter.manga_id}, {custom_regex=}, regex used: {pattern_to_use!r}, {original_title=}, {normalised_title=}"
        # )
        return normalised_title

    def normalise_chapters(
        self, manga_chapters_lists: List[List[Chapter]]
    ) -> List[Chapter]:
        """Normalise the chapter fields for MangaDex."""
        updated_chapters = []

        for chapters in manga_chapters_lists:
            # Go through the last three chapters
            for chapter in chapters:
                updated_chapters.extend(
                    self.normalise_chapter_fields(chapters, chapter)
                )

        return updated_chapters

    def normalise_chapter_fields(
        self, chapters: List[Chapter], chapter: Chapter
    ) -> List[Chapter]:
        updated_chapters = []

        chapter_number_split = self._normalise_chapter_number(chapters, chapter)
        chapter_title = self._normalise_chapter_title(chapter, chapter_number_split)

        # MPlus sometimes joins two chapters as one, upload to md as
        # two different chapters
        for chap_number in chapter_number_split:
            copied_chapter = deepcopy(chapter)
            copied_chapter.chapter_number = chap_number
            copied_chapter.chapter_title = chapter_title
            updated_chapters.append(copied_chapter)

        return updated_chapters
