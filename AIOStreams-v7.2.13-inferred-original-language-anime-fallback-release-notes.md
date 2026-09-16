# AIOStreams v7.2.13 — inferred original-language anime fallback

Baseline: exact v7.2.12 TorBox anime English-audio verification repository produced on 2026-09-16.

## Why this release exists

v7.2.12 correctly stopped an anime release such as:

```text
Code Geass - Movies Pack Complete [Dual Audio - 1080p HD with Eng Subs]
```

from manufacturing an English audio flag when TorBox did not provide selected-file media-info. The regression test also confirmed in Stremio that this exact Cerberus file actually exposed only a Japanese audio track.

However, v7.2.12 responded too aggressively: after rejecting the false English evidence it discarded the whole otherwise-playable stream instead of retaining it as the same Japanese/original-language fallback tier used for verified Japanese-only anime.

## Fix

v7.2.13 keeps the v7.2.12 English-audio hardening and adds one narrowly scoped recovery path.

For a TorBox anime stream, AIOStreams now remembers whether selected-file media-info was actually requested for the exact `infoHash + fileIdx`.

If all of the following are true:

- the request is anime;
- English is required and Japanese is not explicitly required;
- the title metadata says the original language is Japanese;
- TorBox selected-file media-info was actually queried for this exact torrent file;
- TorBox returned no usable provider/container audio languages for it;
- release parsing currently claims English, but only through an ambiguous language set such as `Dual Audio + English` / subtitle-derived English;
- there is no explicit English-audio/dub wording such as `English Dub` or `English Audio`;
- there is no parsed concrete third-language audio evidence;

then the stream is no longer discarded. Instead AIOStreams:

1. replaces the unverified release-language guess with `Japanese + Original`;
2. marks the stream internally as `original-language-inferred` rather than provider-verified;
3. allows it through Required English only as an anime fallback;
4. demotes it to the bottom together with provider-verified Japanese-only anime streams;
5. renders Japanese rather than a false English flag.

This preserves the distinction between:

- **provider-verified Japanese-only** — TorBox/container metadata explicitly reported Japanese and no English; and
- **inferred Japanese-original fallback** — TorBox lookup was attempted but had no usable track metadata, while release-derived English was judged ambiguous/untrustworthy.

## What is intentionally not inferred

The fallback is deliberately narrow. AIOStreams does **not** turn every `Unknown`, `Dual Audio`, or other anime result into Japanese.

It requires an English-bearing ambiguous result that was actually checked through the TorBox selected-file lookup. Results with concrete unrelated languages remain conservative. Explicit English-audio/dub wording also remains valid fallback evidence and is not downgraded merely because provider media-info is unavailable.

Non-anime behavior is unchanged.

## Changed files

### `packages/core/src/streams/filterer.ts`

- Tracks exact TorBox `infoHash + fileIdx` files for which provider audio lookup was actually attempted after a successful batch check.
- Adds the narrow inferred Japanese-original fallback decision.
- Rewrites ambiguous false-English release languages to `Japanese + Original` only for that fallback.
- Adds explicit diagnostic logging for the inference and the later Required-Language allowance.
- Preserves provider/container metadata as authoritative when available.

### `packages/core/src/streams/sorter.ts`

- Demotes both provider-verified Japanese-only fallbacks and inferred-original-language fallbacks beneath normal English-capable anime results.
- Logs separate counts for provider-verified vs inferred fallbacks.

### `packages/core/src/db/schemas.ts`

Adds the internal parsed-stream marker:

```text
animeLanguageFallback: original-language-inferred
```

This keeps inferred original-language fallback state distinct from `mediaInfoSource: provider`.

### `resources/metadata.json`

Version/tag updated to:

```text
7.2.13
v7.2.13-custom
```

## Expected Code Geass regression result

For the exact Cerberus release that v7.2.12 removed:

- it must **not** return to the normal English/dual-audio tier;
- it should survive as a Japanese/original-language fallback when TorBox again returns no usable selected-file audio tracks;
- its displayed language should be Japanese rather than English/Japanese;
- it should be sorted with the other Japanese-only fallback results at the bottom;
- an actual provider-confirmed English+Japanese result would still stay in the normal higher-ranked tier.

Expected diagnostic messages include:

```text
Inferred Japanese-original anime fallback after TorBox audio lookup returned no usable tracks
Language filter allowed inferred Japanese-original anime fallback stream
demoted Japanese-only anime fallback streams
```

The sort log includes separate `providerVerified` and `inferredOriginalLanguage` counts.

## Preserved behavior

v7.2.13 is based directly on v7.2.12 and intentionally preserves:

- v7.2.12 TorBox anime English-audio verification hardening;
- v7.2.11 selected-file provider audio enrichment;
- provider-confirmed English as normal Required-English evidence;
- provider-confirmed Japanese-only anime fallback behavior;
- Japanese-only fallback demotion;
- anime movie vs episodic-series semantic classification;
- TMDB TV/movie namespace and Zilean TV/movie search selection;
- episode-title and season/episode matching safeguards;
- Real-Debrid legal/infringing-file suppression;
- cache-and-play behavior and immediate downloading state;
- uncached selected-file-size safeguards;
- fresh debrid playback URL behavior;
- two-point Range validation and final-CDN validation/success cache.

## Local validation performed

- `filterer.ts`, `sorter.ts`, and `schemas.ts` syntax-transpile under TypeScript 5.8.3 with zero diagnostics.
- Focused regression checks confirm:
  - `Dual Audio + Eng Subs` with no provider tracks enters the inferred Japanese fallback;
  - explicit `English Dub` does not get downgraded;
  - `Unknown` alone does not get automatically assumed Japanese;
  - `English + Italian` does not get inferred as Japanese;
  - provider-confirmed language metadata remains authoritative.
- Patch application is verified against the exact v7.2.12 full repository.
- Full-repository ZIP equality is verified after patch application.
- ZIP integrity and SHA256 verification are performed for release artifacts.

A full pnpm workspace build is not available in this artifact environment because it runs Node 22 while the repository requires Node 24 and workspace `node_modules` are not installed. GitHub Actions remains the definitive full TypeScript/frontend/Docker validation.
