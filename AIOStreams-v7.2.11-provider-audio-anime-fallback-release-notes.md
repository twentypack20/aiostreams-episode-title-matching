# AIOStreams v7.2.11 — TorBox resolver audio verification + Japanese anime fallback

Baseline: exact v7.2.10 episodic-anime series-semantics repository produced on
2026-09-16.

## Why this release exists

The v7.2.10 JoJo regression test confirmed that episodic anime is now using the
correct series semantics and metadata. It also exposed the next remaining
language gap.

For JoJo S1E2, TorBox/Zilean returned selected-file container metadata for some
releases and AIOStreams correctly saw real audio tracks such as:

```text
Japanese, English
English, Japanese
```

Those authoritative languages were propagated to matching Torrentio routes and
survived the user's Required English filter.

However, Torrentio returned many more streams than the native Torznab/Zilean
path. Some Torrentio-only releases were still represented only by vague release
labels such as `Dual Audio` or `Unknown`. Because v7 intentionally refuses to
pretend that bare `Dual Audio` proves English audio, those streams were rejected
even when TorBox may already have selected-file `media_info` capable of proving
the actual tracks.

The user also wants Japanese-only anime to remain available as a last-resort
fallback, but below all confirmed English/dual-audio choices rather than
competing with them.

## Design

v7.2.11 adds a narrow TorBox-only enrichment step before Required Language
filtering.

After the existing exact `infoHash + fileIdx` provider-language propagation has
already reused any metadata from equivalent native AIOStreams routes, unresolved
TorBox anime streams with vague language metadata are collected. AIOStreams then
performs one batched TorBox/StremThru cache-status lookup for their unique
infohashes and reads the selected file's provider `media_info` when available.

This lookup is read-only:

- `checkOwned=false` is used;
- no magnet is added to the user's TorBox cloud;
- no cache-and-play download is started;
- explicit non-English release labels such as Chinese/French are not queried;
- failure or missing media info is fail-open to the existing conservative
  language behavior.

The selected-file identity remains strict: provider metadata is applied only to
the exact `infoHash + fileIdx` stream.

## Language behavior

For anime when English is required:

1. **Provider confirms English**
   - provider/container tracks become authoritative;
   - the result passes Required English normally;
   - vague `Dual Audio`/`Unknown` release tags no longer cause a false reject.

2. **Provider confirms Japanese and no English**
   - the result is retained as a Japanese-audio fallback when Japanese is not already an explicit Required Language;
   - it is demoted below all normal unpinned anime results after the user's
     normal sort criteria run;
   - because limiting happens after sorting, a sufficiently full English result
     set can naturally push Japanese-only fallbacks out of the visible list.

3. **Provider gives no usable audio-track metadata**
   - existing conservative behavior remains;
   - bare `Dual Audio`, `Dubbed`, `Multi`, or `Unknown` still does not become
     English by assumption.

4. **Non-anime**
   - no behavior change.

## Changed files

### `packages/core/src/streams/filterer.ts`

Adds TorBox resolver selected-file audio enrichment for anime with Required
English.

Candidate streams must:

- be anime;
- be TorBox-backed;
- still lack provider-authoritative languages;
- have an `infoHash` and `fileIdx`;
- not already contain confirmed English;
- contain only vague language tags (`Unknown`, `Dual Audio`, `Multi`, `Dubbed`)
  and/or Japanese/Original.

The lookup is batched by unique hash and capped by:

```text
TORBOX_RESOLVER_MEDIA_INFO_HASH_LIMIT=40
```

The cap can be set to `0` to disable only this resolver-side enrichment.

When TorBox/StremThru exposes selected-file `media_info`, AIOStreams parses its
real audio tracks, replaces the vague release-language guess with the provider
languages, and marks the stream `mediaInfoSource: provider`.

Adds a Required Language exception only for provider-verified anime streams that
contain Japanese and no English. Parser-only Japanese does not bypass Required
English.

### `packages/core/src/streams/sorter.ts`

After the normal anime sort completes, provider-verified Japanese-without-English
fallback streams are moved to the bottom of the normal unpinned result set.

This is intentionally independent of preferred language ordering: confirmed
English choices remain ahead of the fallback tier.

### `.env.sample`

Documents:

```text
TORBOX_RESOLVER_MEDIA_INFO_HASH_LIMIT=40
```

### `resources/metadata.json`

Version/tag updated to:

```text
7.2.11
v7.2.11-custom
```

## Preserved behavior

v7.2.11 is based directly on v7.2.10 and intentionally preserves:

- episodic anime `series` semantics and `anime.series` classification;
- correct TMDB TV/TVDB/IMDb metadata namespace behavior;
- Zilean/Torznab `tvsearch` episode lookup;
- exact `infoHash + fileIdx` authoritative-language propagation;
- strict Required English handling for unverified `Dual Audio`/`Dubbed` labels;
- subtitle-only English protection;
- episode-title and season/episode matching safeguards;
- anime movie handling for genuine non-episodic movie requests;
- Real-Debrid legal/infringing-file suppression;
- cache-and-play behavior and immediate downloading state;
- uncached selected-file-size safeguards;
- fresh debrid playback URL behavior;
- v7.2.8 two-point Range validation;
- v7.2.9 final-CDN validation and success cache.

## Local validation performed

- Syntax-transpiled both changed TypeScript source files with TypeScript 5.8.3
  and zero syntax diagnostics.
- Static source checks confirm:
  - enrichment runs only for anime + Required English + TorBox;
  - provider lookup is skipped for streams already carrying authoritative media
    info;
  - only exact selected-file indexes receive provider metadata;
  - `checkMagnets(..., checkOwned=false)` is used, so the enrichment lookup is
    read-only with respect to the TorBox cloud;
  - verified English passes the existing Required Language rule;
  - verified Japanese-without-English is the only new fallback class;
  - unverified vague language tags remain subject to the existing filter;
  - sorter demotion occurs only for anime, only when English (but not Japanese) is required, and only for provider-verified Japanese-without-English streams.
- Patch application is verified against the exact v7.2.10 full repository.
- Full-repository ZIP equality is verified after patch application.

A full pnpm workspace build is not available in this artifact environment
because it runs Node 22 while the repository requires Node 24 and workspace
`node_modules` are not installed. GitHub Actions remains the definitive full
TypeScript/frontend/Docker validation.

## Post-deployment regression target

Reopen the same JoJo episode with debug logging.

Useful new log lines are:

```text
Enriched TorBox resolver audio languages from provider/container metadata
Completed TorBox resolver provider audio-language enrichment
Language filter allowed verified Japanese-only anime fallback stream  # requires EPISODE_TITLE_DEBUG=true

demoted verified Japanese-only anime fallback streams
```

For a release previously shown only as `Dual Audio`, the first line should show
its actual provider languages. If English is present it should join the normal
English results. If TorBox confirms Japanese with no English, it should remain
visible only in the bottom fallback tier.
