# AIOStreams v7.2.10 — Episodic anime series-semantics fix

Baseline: exact v7.2.9 final-CDN Range-validation repository produced on 2026-09-16.

## Why this release exists

A TorBox-only JoJo's Bizarre Adventure S5E1 diagnostic exposed a remaining
anime TV-vs-movie classification bug.

The incoming Stremio route was:

```text
/stream/movie/tt2359704:5:1.json
```

The ID itself clearly carried season/episode coordinates, and AnimeDatabase
correctly matched it to the S5E1 anime entry. However, AIOStreams continued to
inherit the outer `movie` resource type. That produced several bad downstream
consequences:

- `queryType` became `anime.movie` instead of `anime.series`;
- metadata providers were queried using movie semantics;
- the mapped TMDB numeric ID was interpreted in TMDB's movie namespace instead
  of its TV namespace, producing unrelated metadata ("My Dad's a Detective",
  Dutch original language, 90-minute runtime) for JoJo;
- built-in Torznab/Zilean chose `movie-search` instead of `tv-search` and did
  not search with episode semantics;
- stream filtering treated episodic anime as a movie, including movie-specific
  season/episode, size, bitrate, year, and release-date behavior;
- the filter summary reported the request as a movie.

Torrentio still returned JoJo streams because that external addon accepted the
original route, which made the classification error less obvious until the
language diagnostics were inspected.

## Design

v7.2.10 separates the **transport/resource type** from the **semantic content
type**.

The original Stremio resource type is preserved when querying external addons,
so existing Torrentio/Kitsu compatibility is not disturbed. Separately, any
parsed ID that contains an explicit episode coordinate is treated semantically
as a series request.

This includes:

- ordinary `tt...:season:episode` IDs;
- TVDB/TMDB episode IDs with season/episode coordinates;
- legacy Kitsu/MAL/AniList/AniDB episode IDs that carry an episode/absolute
  episode without a conventional season pair;
- extended Kitsu bridge IDs that carry both absolute and mapped S/E numbers.

A normal movie ID without an episode coordinate remains a movie.

## Changed files

### `packages/core/src/utils/id-parser.ts`

Adds `resolveEffectiveMediaType()`.

The helper returns `series` whenever the parsed request contains an explicit
`episode` or `absoluteEpisode`; otherwise it returns the original request type.
This is the common rule used by stream context, metadata, and built-in search.

### `packages/core/src/streams/context.ts`

Adds `contentType`, the semantic movie/series type for the request.

For an episodic anime arriving through a `movie` resource:

```text
request type: movie
content type: series
queryType: anime.series
```

Metadata lookup, release-date handling, episode-detail loading, and age
calculation now use `contentType` while the original `type` remains available
for addon-route compatibility.

### `packages/core/src/metadata/service.ts`

Normalizes episodic requests to series semantics before provider lookup and
updates the parsed media type accordingly.

The normalized type is now used for:

- the metadata cache/lock key;
- TMDB provider-ID parsing and movie-vs-TV namespace selection;
- TVDB provider-ID parsing;
- IMDb/Cinemeta metadata lookup;
- Trakt alias media type through the normalized parsed ID;
- next-episode calculations;
- movie-only year requirements.

This is the key fix for the JoJo metadata collision: a mapped TMDB TV ID is no
longer looked up through TMDB's movie endpoint merely because the outer Stremio
resource said `movie`.

### `packages/core/src/builtins/base/debrid.ts`

Normalizes the built-in parsed ID before search implementations run.

This matters because Torznab/Newznab select their search endpoint from
`parsedId.mediaType`. An episodic request that arrived through `/movie/` now
uses series semantics internally, allowing `tv-search`, season/episode params,
and TV-oriented provider IDs while the external addon route itself remains
unchanged.

### `packages/core/src/streams/filterer.ts`

Uses `context.contentType` for filtering decisions.

This prevents episodic anime routed through `movie` from being subjected to
movie-specific logic such as rejecting streams merely because they contain
season/episode information. It also makes series/anime size, bitrate, year,
season-pack, and digital-release behavior apply consistently.

### `packages/core/src/main/resources.ts`

Uses the semantic content type in the final filter summary, so an episodic
request is now reported as a series rather than a movie.

### `resources/metadata.json`

Version/tag updated to:

```text
7.2.10
v7.2.10-custom
```

## Intentionally not changed yet

The planned "Japanese-only anime fallback at the bottom" is **not** included in
this build yet.

That is deliberate. The JoJo diagnostic showed that the language test was being
run against corrupt movie metadata (`originalLanguage: Dutch`). v7.2.10 first
repairs the classification and metadata namespace so the language filter can be
retested against correct anime-series metadata. If Japanese-only results are
still the remaining gap after this fix, the fallback can be added cleanly as a
second isolated change.

The v7.1 Required-English safety rule also remains intact: bare `Dual Audio` or
`Dubbed` does not, by itself, prove that an English audio track exists.

## Preserved behavior

This build is based directly on v7.2.9 and intentionally preserves all existing
custom behavior, including:

- v7 provider/container media-info lookup;
- authoritative audio-language propagation by exact `infoHash + fileIdx`;
- Required English semantics and subtitle-only English protection;
- v7.2 AnimeAPI-backed classification and late metadata promotion;
- Kitsu conventional/absolute episode bridge;
- anime title/season/episode matching protections;
- native AIOStreams anime playback preference;
- Torrentio/TorBox anime handling;
- Real-Debrid legal/infringing-file suppression;
- cache-and-play behavior and immediate downloading status;
- uncached selected-file-size safeguards;
- fresh debrid playback URL generation and retry behavior;
- v7.2.8 two-point Range validation;
- v7.2.9 final-CDN Range validation and 10-minute validation cache.

## Local validation performed

- Syntax-transpiled all six changed TypeScript source files with TypeScript
  5.8.3 with zero syntax diagnostics.
- Synthetic media-type regression checks confirm:
  - `tt2359704:5:1` received as `movie` => semantic `series`;
  - season-0 episodic IDs => semantic `series`;
  - legacy `kitsu:<id>:<absoluteEpisode>` received as `movie` => semantic
    `series`;
  - extended Kitsu bridge IDs => semantic `series`;
  - normal movie `tt1259571` with no episode coordinate => remains `movie`.
- Static source assertions confirm:
  - StreamContext builds `anime.series` from semantic type;
  - MetadataService uses semantic type for TMDB/TVDB/IMDb and cache keys;
  - built-in debrid search updates `parsedId.mediaType` before Torznab search;
  - StreamFilterer uses semantic type for its existing movie/series branches.
- `git diff --check` equivalent validation passes for the generated patch.
- Patch application is verified against the exact v7.2.9 full repository.

A full pnpm workspace build is not available in this artifact environment
because it runs Node 22 while the repository requires Node 24 and workspace
`node_modules` are not installed. GitHub Actions remains the definitive full
TypeScript/frontend/Docker validation.

## Post-deployment JoJo regression target

With `LOG_LEVEL=debug`, reopen the same JoJo S5E1 request.

Expected changes include:

```text
stream context created ... type:"movie" contentType:"series" ... queryType:"anime.series"
```

and for the built-in Zilean/Torznab path:

```text
normalised episodic builtin request to series semantics
Using search function: tvsearch
```

The metadata log should no longer show the unrelated Dutch movie metadata. It
should resolve JoJo as a TV/anime series and report the correct original
language (normally Japanese) and episode/series metadata.

Only after that clean retest should we decide whether the Japanese-only
bottom-ranked fallback is still needed.
