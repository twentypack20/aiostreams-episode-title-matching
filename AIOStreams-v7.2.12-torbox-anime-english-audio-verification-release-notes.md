# AIOStreams v7.2.12 — TorBox anime English-audio verification hardening

Baseline: exact v7.2.11 provider-audio/anime-fallback repository produced on
2026-09-16.

## Why this release exists

The v7.2.11 Code Geass movie regression test confirmed that the new anime movie
classification and Japanese-only fallback tier were working correctly, but it
also exposed one remaining false-positive English-audio path.

The first displayed Code Geass movie result came from a release folder labelled:

```text
[Dual Audio - 1080p HD with Eng Subs]
```

Release parsing therefore surfaced `Dual Audio` plus `English`, even though the
actual file contained only one Japanese audio track. Stremio's audio selector
confirmed that the playable file exposed Japanese (`jpn`) only.

The same request also showed that v7.2.11's new TorBox provider lookup reported
`englishConfirmed: 0`, because the false-positive stream was excluded from that
lookup as soon as release parsing had already guessed `English`.

That created two related holes:

1. English-bearing ambiguous release metadata was skipped by the TorBox
   selected-file media-info enrichment.
2. `Dual Audio`/`Dubbed` release text could still count as a strong English
   signal on a TorBox anime result even when the real selected-file audio tracks
   had not confirmed English.

## Fix

v7.2.12 keeps the v7.2.11 design, but closes those two holes narrowly for TorBox
anime results.

### 1. Ambiguous parsed English now participates in TorBox provider lookup

The resolver media-info enrichment candidate set now permits `English` alongside
its existing vague language tags:

```text
Unknown
Dual Audio
Multi
Dubbed
English
Japanese
Original
```

This means a TorBox anime result such as `Dual Audio + English` is no longer
assumed to be settled merely because the release parser found the word
`English`. The exact `infoHash + fileIdx` can still be checked against TorBox's
selected-file `media_info`.

If TorBox reports:

- **English + Japanese**: provider/container metadata becomes authoritative and
  the result remains in the normal English-capable tier.
- **Japanese only**: provider/container metadata becomes authoritative and the
  result is retained as the already-existing Japanese-only anime fallback,
  sorted below normal English-capable results.
- **No usable media-info**: the original release metadata is retained, but the
  new strong-English check below prevents vague `Dual Audio + Eng Subs` text
  from manufacturing an English track.

The lookup remains read-only (`checkOwned=false`) and still does not add magnets
or start downloads.

### 2. TorBox anime release text no longer treats subtitle-driven English as audio

For foreign-original anime backed by an exact TorBox torrent file, AIOStreams
now distinguishes explicit English **audio/dub** wording from vague language or
subtitle wording before accepting release metadata as proof of English audio.

Ambiguous conditions include:

- `Dual Audio`
- `Multi`
- `Dubbed`
- `Unknown`
- `English Subs` / `Eng Subs`
- `English Subtitles`
- `Subbed`
- `Multi Subs`

When one of those conditions is present and provider/container metadata has not
already confirmed English, the result is accepted as strong English evidence
only if the release text explicitly says English audio/dub, for example:

```text
English Audio
Eng Audio
English Dub
Eng Dub
Dub English
```

Therefore a folder such as:

```text
Dual Audio - 1080p HD with Eng Subs
```

no longer qualifies as English audio by itself.

This hardening is intentionally scoped to TorBox anime with a concrete
`infoHash + fileIdx`, where selected-file provider verification is available.
Non-anime behavior is unchanged.

## Expected Code Geass regression result

For the exact Code Geass movie used to discover the bug:

- if TorBox exposes media-info for the Cerberus release and it confirms Japanese
  only, the release should display as Japanese-only and join the bottom fallback
  tier;
- if TorBox exposes English + Japanese, it should remain the normal top-tier
  dual-audio result;
- if TorBox exposes no usable media-info, `Dual Audio + Eng Subs` alone should
  no longer create a false English flag, so the result should be rejected by
  Required English rather than falsely advertised as an English dub.

The three previously verified Japanese-only results should continue to remain
available beneath any confirmed English-capable result.

## Changed files

### `packages/core/src/streams/filterer.ts`

- Allows ambiguous release-parsed `English` to enter the existing TorBox
  selected-file media-info enrichment candidate set.
- Adds subtitle-text detection for English-subtitle markers.
- Adds explicit English-audio/dub detection.
- For foreign-original TorBox anime with an exact torrent-file identity, vague
  audio/subtitle release metadata no longer counts as strong English-audio
  evidence unless explicit English audio/dub wording is present.
- Preserves provider/container metadata as the highest-priority source.
- Preserves the v7.2.11 verified Japanese-only fallback behavior.

### `resources/metadata.json`

Version/tag updated to:

```text
7.2.12
v7.2.12-custom
```

## Preserved behavior

v7.2.12 is based directly on v7.2.11 and intentionally preserves:

- episodic anime `series` semantics and genuine anime-movie `movie` semantics;
- correct TMDB TV/movie namespace behavior;
- Zilean/Torznab TV-vs-movie search selection;
- exact `infoHash + fileIdx` provider-language propagation;
- v7.2.11 TorBox resolver selected-file media-info enrichment;
- provider-confirmed English as normal Required-English evidence;
- provider-confirmed Japanese-only anime fallback behavior;
- Japanese-only fallback demotion below normal anime results;
- subtitle-only English protection;
- episode-title and season/episode matching safeguards;
- Real-Debrid legal/infringing-file suppression;
- cache-and-play behavior and immediate downloading state;
- uncached selected-file-size safeguards;
- fresh debrid playback URL behavior;
- v7.2.8 two-point Range validation;
- v7.2.9 final-CDN validation and success cache.

## Local validation performed

- `filterer.ts` syntax-transpiles with TypeScript 5.8.3 with zero diagnostics.
- Static regression checks confirm that:
  - `English` no longer excludes a TorBox anime resolver result from provider
    audio lookup;
  - the Code Geass-style `Dual Audio + Eng Subs` pattern is not considered
    strong English audio when provider confirmation is absent;
  - explicit `English Dub` / `English Audio` wording remains a strong fallback
    signal;
  - provider-confirmed English still wins;
  - provider-confirmed Japanese-only still enters the fallback tier;
  - non-anime behavior is unchanged.
- Patch application is verified against the exact v7.2.11 full repository.
- Full-repository ZIP equality is verified after patch application.

A full pnpm workspace build is not available in this artifact environment
because it runs Node 22 while the repository requires Node 24 and workspace
`node_modules` are not installed. GitHub Actions remains the definitive full
TypeScript/frontend/Docker validation.

## Post-deployment regression target

Reopen the same Code Geass movie with debug logging.

The important checks are:

```text
Enriched TorBox resolver audio languages from provider/container metadata
Completed TorBox resolver provider audio-language enrichment
Language filter allowed verified Japanese-only anime fallback stream
Language filter rejected likely subtitle-only English anime stream
```

Then verify the displayed language flags against Stremio's actual audio-track
selector. The Cerberus release must no longer display an English flag unless its
selected-file provider metadata actually confirms English audio (or its release
text explicitly identifies an English dub/audio track rather than English
subtitles).
