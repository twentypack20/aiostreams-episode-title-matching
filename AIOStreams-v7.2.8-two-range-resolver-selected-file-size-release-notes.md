# AIOStreams v7.2.8 — Two-range resolver validation / selected-file size safety

This custom release is based on v7.2.7 and preserves the immediate Cache-and-Play
message, provider-confirmed legal-block suppression, library-vs-cached fix, anime
matching, provider media-info, language handling, fresh playback, addon retry, and
debrid retry behavior except for the targeted changes below.

## Changes

### 1. The uncached size cap now uses only a trustworthy selected-file size

v7.2.7 could treat a season pack's whole torrent size as the episode size. A 990 MB
episode inside a 15.38 GB season pack could therefore be removed by an 8 GB uncached
limit even though the selected episode itself was small.

v7.2.8 adds a shared selected-file-size helper. `UNCACHED_MAX_SIZE_GB` is now applied
only when AIOStreams has evidence that `stream.size` represents a specific file, such
as:

- a separate, larger `folderSize` is present;
- an explicit torrent `fileIdx` identifies one file; or
- a season-pack resolver result exposes an exact episode filename with exactly one
  parsed episode number.

If a season pack exposes only its whole-pack size and the individual file size cannot
be trusted, the special uncached cap does **not** remove it.

Cached/ready results remain exempt from the special uncached cap.

Default remains:

```text
UNCACHED_MAX_SIZE_GB=8
```

Set it to `0` to disable the special cap entirely.

### 2. External resolver media validation now uses two Range probes

A valid 32 KiB MP4 prefix was still not sufficient proof that a Torrentio-style
resolver would provide a usable media object. v7.2.8 replaces the single-prefix test
with two bounded probes for seekable media returned directly by a known resolver host.

Probe 1:

- requests the start of the media;
- reads 64 KiB by default;
- requires a recognised media/container signature;
- records the `Content-Range` total size when available.

Probe 2:

- requests another 64 KiB approximately 25% into the media object;
- requires HTTP `206 Partial Content`;
- requires `Content-Range` to start at exactly the byte AIOStreams requested;
- requires the server to actually return the requested bytes;
- checks that the total media size remains consistent across both probes.

HLS/DASH manifests remain exempt from the second byte-range probe because they are not
single seekable media files.

### 3. Expected episode/file size is compared against resolver media size

When AIOStreams has a trustworthy selected-file size, it is carried into the external
resolver playback wrapper. The resolver-reported total media size must be reasonably
close to that expected file size.

This is designed to reject cases such as:

```text
Expected episode: ~1.0 GB
Resolver response: small MP4/error/placeholder object
=> reject before Stremio is redirected to it
```

The default allowed difference is 25%:

```text
EXTERNAL_RESOLVER_SIZE_TOLERANCE_PERCENT=25
```

Whole season-pack sizes are never substituted as the expected episode size when the
individual file size is unknown.

### 4. Successful resolver validation is cached briefly

Successful two-probe validations are cached in memory for 10 minutes using the
provider/torrent/file identity when available. Reopening the same episode shortly
after a successful check therefore does not repeatedly spend another ~128 KiB of VPS
bandwidth validating the same candidate.

Failed and inconclusive checks are not cached.

### 5. Resolver diagnostics are more explicit

Debug logs for final resolver preflight now include, when available:

- `expectedFileSize`
- `reportedFileSize`
- `mediaBytes`
- `mediaSignature`
- `probe2Start`
- `probe2Bytes`
- `cacheHit`

The playback-time wrapper logs the same core validation facts under
`External resolver media validation passed`.

## Environment variables

Preferred v7.2.8 settings:

```text
EXTERNAL_RESOLVER_PROBE_BYTES=65536
EXTERNAL_RESOLVER_SIZE_TOLERANCE_PERCENT=25
```

`EXTERNAL_RESOLVER_MIN_MEDIA_BYTES` remains supported as a backwards-compatible alias
for the probe byte count when `EXTERNAL_RESOLVER_PROBE_BYTES` is not set.

## Version metadata

`resources/metadata.json` reports:

- Version: `7.2.8`
- Tag: `v7.2.8-custom`
- Channel: `stable`

## Unchanged behavior

No changes were made to:

- immediate Cache-and-Play downloading-message behavior from v7.2.7;
- the one-hour downloading information video;
- provider-confirmed legal-unavailable memory/suppression;
- Required/Preferred language policy;
- authoritative provider/container audio-language handling;
- anime episode-title matching;
- Kitsu / absolute-episode bridges;
- anime playback ranking;
- addon fetch retry policy;
- ordinary transient debrid retry policy;
- TorBox anime behavior;
- fresh final playback links.
