# AIOStreams v7.2.9 — Final-CDN Range validation fix

This custom release is based directly on the deployed v7.2.8 codebase. It is a
narrow follow-up to the v7.2.8 two-Range validator and does not intentionally
change provider ranking, debrid cache semantics, anime matching, language
handling, Cache-and-Play behavior, or native debrid playback.

## Why v7.2.9 was needed

v7.2.8 contained the two-Range validation machinery, but one resolver path could
still bypass it:

```text
Torrentio / external resolver
  -> HTTP redirect
  -> final debrid/CDN URL
  -> v7.2.8 treated the redirect itself as success
```

That meant a resolver could return a valid-looking CDN redirect while the final
media object was missing, blocked, truncated, non-seekable, or otherwise bad.
The Dallas/Twilight diagnostics exposed this because the final preflight said
`passed` but there were no probe-1/probe-2 log entries for the actual CDN URL.

## Changes

### 1. Final resolver-produced CDN targets are now actually validated

When a supported external resolver such as Torrentio redirects to a non-resolver
HTTP(S) URL, AIOStreams now follows that target only for bounded validation and
runs the same two-point media check that v7.2.8 intended:

Probe 1:

- requests about 64 KiB from byte 0;
- verifies a recognised media/container signature;
- records total object size from `Content-Range` when available;
- uses full `Content-Length` only when the server ignored the first Range and
  returned HTTP 200.

Probe 2:

- requests another about 64 KiB around 25% into the object;
- requires HTTP `206 Partial Content`;
- requires `Content-Range` to begin at the exact requested offset;
- requires the requested bytes to actually be returned;
- requires total size to remain consistent across probes when both responses
  expose it.

The redirect is no longer sufficient by itself to mark the stream playable.

### 2. The fix applies at both listing time and click time

The final-CDN validation now applies in both places where the gap existed:

- final resolver preflight while AIOStreams builds the Stremio stream list;
- `/api/v1/debrid/external-resolver/...` when the user actually clicks an
  external-resolver/Torrentio result.

Native AIOStreams `/api/v1/debrid/playback/...` links remain intentionally
excluded from listing-time execution so fresh native debrid playback behavior is
not regressed.

### 3. Trusted selected-file size behavior is preserved

The v7.2.8 selected-file-size safety rules remain unchanged. Resolver-reported
media size is compared only when AIOStreams has a trustworthy individual
file/episode size.

A season pack whose only known size is the whole torrent remains exempt from
per-episode size enforcement. The Dallas-style `~1 GB episode inside ~15 GB
season pack` case therefore remains protected from whole-pack miscomparison.

### 4. Successful validation cache now keys the actual final target

Listing-time success caching was tightened so AIOStreams first resolves the
external resolver and then keys successful media validation using:

- provider/torrent/file identity;
- trustworthy expected file size when available;
- the actual final CDN/media target URL.

A changed final CDN target cannot inherit the prior target's success simply
because the source resolver URL or torrent identity is the same.

Click-time validation also has a 10-minute in-memory success cache keyed from the
source resolver URL, expected size, and actual final target URL. The cache key is
hashed and the signed CDN URL is not logged.

Only successful validations are cached. Failed and inconclusive validations are
not cached.

### 5. Clear final-target diagnostics

Debug logging now makes the final target check explicit. Successful uncached
validation produces:

```text
Resolver media validation probe 1
Resolver media validation probe 2 headers
Resolver media validation probe 2 body
Resolver media validation passed
```

The click-time wrapper uses the corresponding `External resolver ...` messages.
Cache reuse logs `... media validation cache hit` and a final `... validation
passed` verdict with `cacheHit: true`.

The signed resolver/CDN URL itself is not written to these validation logs; only
safe facts such as host, offsets, byte counts, status, signature, and sizes are
logged.

## Unchanged behavior

No intentional changes were made to:

- Real-Debrid legal/infringing provider+hash suppression;
- `☁️ / ⏳ / ⚡` semantics;
- no-repeat Cache-and-Play timeout behavior;
- immediate downloading-message behavior;
- long-running downloading informational video;
- provider/container authoritative audio-language metadata;
- anime classification, episode-title matching, or Kitsu bridges;
- fresh native debrid playback links;
- TorBox provider-media-info handling;
- v7.2.8 uncached-size/season-pack safeguards;
- `UNCACHED_MAX_SIZE_GB=0` remaining an effective disable switch.

## Environment settings

No new environment variables are required. Existing v7.2.8 settings continue to
apply:

```text
EXTERNAL_RESOLVER_PROBE_BYTES=65536
EXTERNAL_RESOLVER_SIZE_TOLERANCE_PERCENT=25
```

The success cache TTL remains 10 minutes in memory.

## Version metadata

`resources/metadata.json` reports:

- Version: `7.2.9`
- Tag: `v7.2.9-custom`
- Channel: `stable`

## Recommended first live test

After deploying v7.2.9, temporarily disable Real-Debrid on the test account and
open the same New Moon/TorBox-only stream list. For a Torrentio result, debug
logs should now show both Range probes against the final TorBox/CDN host before
`Resolver preflight result` reports `passed`.

Then play the result. Click-time logs should either show a fresh two-probe
validation or a short-lived validation-cache hit for the same final target.
