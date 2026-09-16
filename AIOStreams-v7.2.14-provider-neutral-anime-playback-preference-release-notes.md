# AIOStreams v7.2.14 — provider-neutral anime playback preference

Baseline: exact v7.2.13 inferred original-language anime fallback repository produced on 2026-09-16.

## Why this release exists

The custom anime duplicate/playback preference logic still contained an old provider bias from the earlier Real-Debrid-first configuration:

```ts
if (stream.service?.id?.toLowerCase() === 'realdebrid') score += 80;
if (isTorboxStream(stream)) score -= 20;
```

That gave otherwise comparable Real-Debrid streams a 100-point advantage over TorBox. It was mostly invisible while only TorBox was enabled, but it was no longer appropriate now that the custom stack is intended to work cleanly with either provider.

## Fix

v7.2.14 removes both provider-specific score adjustments from `animePlaybackPreferenceScore()`.

The anime playback preference remains based on playback characteristics rather than debrid-provider identity. Existing high-value signals are preserved, including:

- native AIOStreams debrid playback: `+1000`;
- Torrentio external resolver route: `-250`;
- existing quality/codec/release-group preferences;
- the later TorBox-specific validation and audio-language enrichment paths, which are functional capabilities rather than a blanket ranking penalty.

No Real-Debrid-to-TorBox replacement score is introduced. TorBox and Real-Debrid are now neutral at this scoring layer.

## Changed files

### `packages/core/src/streams/filterer.ts`

Removed the old Real-Debrid bonus and TorBox penalty from `animePlaybackPreferenceScore()`.

### `resources/metadata.json`

Updated custom build metadata to:

```text
7.2.14
v7.2.14-custom
```

## Intentionally unchanged

This release does **not** alter:

- TorBox provider/container audio-language enrichment;
- inferred Japanese-original anime fallbacks;
- Real-Debrid provider media-info support;
- native TorBox or Real-Debrid playback implementations;
- cache status handling;
- cloud/library handling;
- legal/451 handling;
- external-resolver two-range CDN validation;
- anime movie/series classification or episode matching;
- sort/filter settings outside this one provider-bias score.

## Expected behavior

With only TorBox enabled, results should remain functionally the same except there is no hidden TorBox `-20` score.

If Real-Debrid and TorBox are both enabled later, neither provider receives a blanket advantage in the anime playback-preference score. Selection is instead determined by native-vs-external playback, cache status, quality, codec, language and the other existing rules.
