# AIOStreams v7.2 — Anime classification freshness repair

## Problem reproduced

The deployed v7.1 build correctly classified Jujutsu Kaisen Season 2 as anime,
but the same IMDb title (`tt12343534`) was classified as ordinary `series` for
Season 3. Debug logs showed `hasAnimeEntry=false`, so `queryType` became
`series` and anime-only episode-title protection was bypassed even though the
normal metadata service correctly returned Japanese original language and the
`Animation` genre.

The failure was caused by the older v7/v7.1 AnimeDatabase relation sources not
having a sufficiently fresh season mapping. It was not caused by the v7.1
provider-audio fix.

## v7.2 changes

### 1. Backport nattadasu/animeApi as a relation source

The old monolithic AnimeDatabase now downloads and indexes the same current
AnimeAPI relation dataset used by newer upstream AIOStreams:

`https://raw.githubusercontent.com/nattadasu/animeApi/refs/heads/v3/database/animeapi.json`

Indexed identifiers include AniDB, AniList, Anime-Planet, AniSearch, IMDb,
Kitsu, LiveChart, MAL, Notify.moe, SIMKL, TMDB, TVDB, and Trakt.

AnimeAPI is additive. Existing Fribb/Kitsu/Anime-Lists/Anitrakt mappings remain
in place and retain priority where they already provide a precise match.

Data-source attribution: `nattadasu/animeApi`; its compiled database is licensed
under ODbL v1.0 + DbCL v1.0. The dataset is downloaded at runtime and is not
bundled in these release ZIPs.

### 2. Conservative season fallback

When legacy Kitsu/Anime-Lists/synonym matching cannot identify a season, v7.2
may use AnimeAPI's exact Trakt season hint as a last resort.

It does **not** trust this cross-provider hint when AnimeAPI marks
`trakt_may_invalid=true`, because split-cour anime can use different season
coordinates between MAL/Trakt/TMDB/TVDB.

### 3. Metadata-provider-ID recovery

If the initial request ID still misses the anime relation database, the metadata
response's TMDB and TVDB IDs are tried against AnimeDatabase before filtering.
This can recover an anime mapping when IMDb is stale but another provider's
mapping is current.

### 4. Conservative metadata safety net

If no mapping can be recovered, a request is promoted to anime only when both
are true:

- original language is Japanese (`ja`, `jpn`, or `Japanese`), and
- the metadata genres contain `Animation`.

This intentionally avoids broad title-based guessing. The fallback changes
`isAnime` and `queryType` before anime-only filtering/ranking runs.

### 5. Late-promotion integration

Metadata already starts in parallel with addon fetching. Before SeaDex/filter
processing, v7.2 waits for that existing metadata promise only when the initial
anime lookup missed, then re-evaluates classification. If the request is
promoted, SeaDex is started as well.

The filterer also performs the same check defensively for direct callers.

## Diagnostics

At debug level, initial stream-context creation now includes an
`animeClassificationSource` field. Expected sources include:

- `kitsu-id`
- `anime-database`
- `anime-database-metadata-id`
- `metadata-fallback`
- `none`

A late recovery emits:

`promoted request to anime classification`

AnimeAPI season fallback selection emits:

`selected AnimeApi season fallback`

## New optional environment setting

No override is required. Default:

```text
ANIME_DB_ANIMEAPI_REFRESH_INTERVAL=86400
```

This refreshes the AnimeAPI relation dataset daily.

## Preserved behavior

v7.2 is based on the exact deployed v7.1 tree. It does not intentionally remove
or relax:

- authoritative provider/container language handling;
- exact `infoHash + fileIdx` language propagation;
- Required English semantics;
- v7 fresh playback links and resolver retries;
- final resolver preflight / `inconclusive=keep`;
- anime episode-title mismatch protection;
- Kitsu conventional/absolute bridge;
- anime playback ranking and native AIOStreams preference;
- Torrentio/TorBox anime demotion behavior;
- addon-fetch retries;
- Trakt alias guard.

## Validation target after deployment

With temporary `LOG_LEVEL=debug`, opening Jujutsu Kaisen S3E5 should no longer
show a stream context with `isAnime=false`. Preferably the new AnimeAPI mapping
will classify it immediately as `anime-database`; if the downloaded mapping is
still incomplete, the conservative metadata fallback should promote it before
filtering.
