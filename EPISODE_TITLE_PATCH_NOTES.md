# Episode Title Matching Patch Notes

This fork adds a conservative `episodeTitleMatching` filter to AIOStreams.

What changed:

- Added `episodeTitleMatching` to `UserDataSchema`.
- Added episode title fields to metadata/context:
  - `episodeTitle`
  - `seasonEpisodeTitles[]`
- Uses Cinemeta episode video titles when available.
- Uses TMDB episode detail `name` when available.
- Adds a new AIOStreams UI card under `Filters -> Matching -> Episode Title Matching`.
- Adds a new removal reason/stat bucket: `Episode Title Matching`.
- Adds passthrough stage `episodeTitle`.
- Includes custom Docker image workflow and sample compose file from the handoff package.

Recommended first test settings:

- Episode Title Matching: Enabled
- Mode: Mismatch Only
- Strict: Off
- Similarity Threshold: 0.82
- Request Types: anime, series
- Season/Episode Matching: Enabled + Strict On

The filter is intentionally conservative: it does not require normal releases like `Show S01E03 1080p` to contain the episode title. It only removes obvious conflicts when metadata provides the selected episode title, or when a candidate looks like an extra/special/spinoff that does not match the selected episode/title.

I could not run a full build in this sandbox because `pnpm` dependencies could not be downloaded from npm. Please run this after pushing to GitHub or on a machine with internet:

```bash
corepack enable
pnpm install
pnpm run build
```

## v2: Different-title / spin-off detection

This update improves `Episode Title Matching` in `Mismatch Only` mode. The v1 logic could remove streams that matched a different known episode title, but it was too conservative for spin-off / OVA false positives such as a normal `Overlord` episode returning a `Ple Ple Pleiades OVA` file.

The v2 logic adds a generic raw-filename check:

- It uses the raw filename / folder / parsed title, not addon display descriptions that may contain the requested metadata title.
- It strips common release noise such as release groups, quality tags, codecs, years, sizes, and SxxExx/episode markers to estimate the actual candidate title.
- It allows normal releases that contain the requested series title or requested episode title.
- It allows season packs and multi-episode packs when strict mode is off.
- It rejects streams that look like a different title, OVA, special, recap, movie, spin-off, chibi/omake, trailer, etc. for the requested episode.
- It does not rely on franchise-specific regex patterns.

Recommended settings remain:

- Episode Title Matching: Enabled
- Mode: Mismatch Only
- Strict: Off
- Similarity Threshold: 0.82
- Request Types: anime, series

## v3 - Pack/OVA mismatch pass

v2 still skipped some Ple/Pure Pleiades false positives in mismatch-only mode because they could be parsed as multi-episode or pack-like results. v3 no longer skips multi-episode/season-pack-looking streams before the mismatch-only checks. Instead, it only avoids the final strict "must contain episode title" rejection for those pack-like results.

Recommended settings remain:

- Episode Title Matching: Enabled
- Matching Mode: Mismatch Only
- Strict: Off
- Similarity Threshold: 0.82
- Request Types: anime, series


## V5 - Filename-first OVA/special rejection

v4 could still allow a false positive if the parser or alias metadata made a bad stream look related to the requested series. v5 adds a filename-first pass for anime episode requests:

- It inspects only the raw filename/folder/original name before trusting parsed title aliases.
- If the raw filename contains OVA/OAD/ONA/special/movie/spin-off style signals,
- and the raw filename does not contain the requested primary series title,
- and the raw filename does not contain the requested episode title,
- it rejects the stream in Mismatch Only mode.

This is designed to reject files like `Ple Ple Pleiades OVA Clementine The Fugitive Part 3.mkv` for normal `Overlord S01E03`, while still allowing those files when the requested primary title is actually `Ple Ple Pleiades`.


## V6 - Do not trust display text for mismatch-only early allow

V5 still allowed some Ple/Pure Pleiades false positives because the display/formatter text could contain the requested episode title (for example, `Overlord - Battle of Carne Village`) even when the raw filename was a different OVA/special file.

V6 removes that early display-text shortcut so raw filename/folder/parsed-title checks run first. Mismatch-only mode now rejects special/OVA/movie-looking raw filenames before any broad display text can make the stream look valid.

Recommended settings remain:

- Episode Title Matching: Enabled
- Matching Mode: Mismatch Only
- Strict: Off
- Similarity Threshold: 0.82
- Request Types: anime, series


## V7 - Move requested-title early allow after raw mismatch checks

v6 source still allowed streams too early when the candidate/display text matched the requested episode title. Some addon/formatter text can include the requested metadata title even when the raw filename is a different OVA/special/spin-off. v7 removes that early return before mismatch-only checks and only allows requested episode-title matches after the raw filename OVA/special/movie rejection has had a chance to run.

Recommended settings remain:

- Episode Title Matching: Enabled
- Matching Mode: Mismatch Only
- Strict: Off
- Similarity Threshold: 0.82
- Request Types: anime, series


## V8 - Episode title debug logging

Adds opt-in debug logging with `EPISODE_TITLE_DEBUG=true` to print the exact stream fields and episode-title matching decisions. This is intended to diagnose cases where a visible stream title/episode does not match the raw filename fields used by the filter, or where an addon sets passthrough behaviour before episode-title matching runs.


## V9 - Filename-only OVA/special rejection

The v8 debug logs showed the bad `Ple Ple Pleiades OVA...` stream was allowed by the non-strict pack passthrough because the stream came from an `Overlord` batch folder. The older checks treated `filename + folderName` as the filename signal, so the folder title made `hasRequestedPrimarySeriesTitleInFilename` true.

V9 adds filename-only checks before the pack passthrough:

- If the actual filename contains OVA/OAD/ONA/special/movie/spin-off style terms,
- and the actual filename does not contain the requested primary series title,
- and the actual filename does not contain the requested episode title,
- reject it in Mismatch Only mode.

This should reject `Ple Ple Pleiades OVA Clementine The Fugitive Part 3.mkv` for normal `Overlord S1E3`, while still allowing normal files like `Overlord - S01E03.mkv` from season-pack folders.


## V10 - Actual filename-only OVA rejection

V9 still let some spin-off files through because `hasRequestedPrimarySeriesTitleInFilenameOnly` included `parsedTitle`, and the parser could infer `Overlord` from the surrounding folder/batch even when the literal filename was `Ple Ple Pleiades OVA...`.

V10 adds stricter actual-filename-only checks that use only the literal filename and the release title extracted from that filename. The OVA/special/movie rejection now uses those stricter checks before non-strict pack passthrough.
