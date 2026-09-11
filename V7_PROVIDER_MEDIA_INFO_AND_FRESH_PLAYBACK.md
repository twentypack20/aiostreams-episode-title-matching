# AIOStreams v7 — Actual Audio Metadata + Fresh Playback Links

This custom update is built directly on the v6 addon-fetch retry / Trakt-guard baseline.
It addresses two issues seen during anime playback:

1. A release can be labelled `English` / `Dual Audio` even when the selected video
   actually contains no English audio track.
2. A native AIOStreams debrid link can occasionally resolve successfully but later
   fail to start, especially when a temporary final provider/CDN URL was cached before
   the user actually clicked the stream.

## 1. Actual provider/container audio metadata

Release-name parsing is no longer allowed to override real container metadata.

When StremThru supplies `media_info` for the selected cached file, AIOStreams parses
that information and treats its audio languages as authoritative. For example:

- release text: `English / Dual Audio`
- actual tracks: `Japanese + Portuguese`
- v7 effective languages: `Japanese + Portuguese`

With `English` required, that stream is rejected instead of being kept because of
its filename/release tags.

If StremThru did not provide media information, v7 can make a bounded direct provider
lookup when enough provider identifiers are available:

- Real-Debrid: `/unrestrict/link` -> `/streaming/mediaInfos/{id}`
- TorBox: `/api/stream/createstream` metadata

The direct lookup is fail-open. If provider media information cannot be obtained,
AIOStreams falls back to the existing release/filename language parsing rather than
removing the stream merely because a metadata API timed out.

Provider lookups are capped, concurrent, short-timeout, and cached. Actual media
information already returned by StremThru does not need an extra provider request.

### Environment variables

```text
PROVIDER_MEDIA_INFO_LOOKUP=true
PROVIDER_MEDIA_INFO_LOOKUP_LIMIT=6
PROVIDER_MEDIA_INFO_TIMEOUT_MS=2500
PROVIDER_MEDIA_INFO_CACHE_TTL=86400
```

`PROVIDER_MEDIA_INFO_LOOKUP_LIMIT=0` disables only the additional direct provider
fallback; authoritative `media_info` already supplied by StremThru is still used.

## 2. Fresh final debrid URL on the real playback request

Native AIOStreams playback URLs use:

```text
/api/v1/debrid/playback/...
```

v7 no longer executes this native route during server-side final preflight. Doing so
could create/cache a temporary or client-IP-sensitive final provider link from the VPS
before the Stremio client actually clicked the stream.

When Stremio really clicks a native AIOStreams playback link, v7 now bypasses the
cached final playback URL by default and asks the configured provider for a fresh one.
Every retry also forces a fresh resolve.

```text
PLAYBACK_FORCE_FRESH_DEBRID_LINK=true
```

Set it to `false` to restore normal final-link cache reuse. Retry attempts still force
a fresh link so transient resolver failures can recover.

This does not proxy video bytes through the VPS. AIOStreams still redirects Stremio to
the final provider/CDN URL.

## 3. Playback diagnostics

The native playback route now logs safe diagnostic fields such as:

- provider
- playback type
- short hash prefix
- file index
- whether a client IP was available
- attempt / total attempts
- whether a fresh resolve was forced
- final destination hostname

It does not log the provider credential or the full signed media URL.

Useful log command after a failed click:

```bash
docker compose logs aiostreams --since 3m 2>&1 \
  | grep -Ei 'playback resolve|playback URL resolved|debrid resolve|retry|failed|error|timeout'
```

## 4. Interaction with v6 preflight

Keep the faster v6 settings currently in use:

```text
PLAYBACK_PREFLIGHT_CHECK=true
PLAYBACK_PREFLIGHT_CHECK_LIMIT=6
PLAYBACK_PREFLIGHT_TIMEOUT_MS=3000
PLAYBACK_PREFLIGHT_CONCURRENCY=6
PLAYBACK_PREFLIGHT_INCONCLUSIVE_MODE=keep
PLAYBACK_HIDE_LEGAL_UNAVAILABLE=true
```

For native AIOStreams `/api/v1/debrid/playback/...` links, v7 treats server-side
preflight as passed without prematurely resolving the final provider URL. External
resolver and already-direct URLs keep the existing preflight behavior.

## 5. Recommended current configuration

```text
# Actual media-track verification / fallback provider lookup
PROVIDER_MEDIA_INFO_LOOKUP=true
PROVIDER_MEDIA_INFO_LOOKUP_LIMIT=6
PROVIDER_MEDIA_INFO_TIMEOUT_MS=2500
PROVIDER_MEDIA_INFO_CACHE_TTL=86400

# Fresh final provider URL when the user actually clicks a native link
PLAYBACK_FORCE_FRESH_DEBRID_LINK=true

# Existing v6 stream-list reliability settings
ADDON_FETCH_RETRIES=1
ADDON_FETCH_RETRY_DELAY_MS=300
ADDON_FETCH_RETRY_MAX_DELAY_MS=1500
ADDON_FETCH_RETRY_ON_RATE_LIMIT=false

PLAYBACK_PREFLIGHT_CHECK=true
PLAYBACK_PREFLIGHT_CHECK_LIMIT=6
PLAYBACK_PREFLIGHT_TIMEOUT_MS=3000
PLAYBACK_PREFLIGHT_CONCURRENCY=6
PLAYBACK_PREFLIGHT_INCONCLUSIVE_MODE=keep
PLAYBACK_HIDE_LEGAL_UNAVAILABLE=true

DEBRID_RESOLVE_RETRIES=2
DEBRID_RESOLVE_RETRY_DELAY_MS=750
DEBRID_RESOLVE_RETRY_MAX_DELAY_MS=4000
DEBRID_RESOLVE_RETRY_ON_RATE_LIMIT=false
DEBRID_RESOLVE_RETRY_UNKNOWN_ERRORS=true
```

Keep **Addon Fetching Strategy = Default** in the AIOStreams configurator. The earlier
6-second Dynamic cutoff was confirmed to return incomplete stream lists for some
anime episodes.

## 6. Expected Jujutsu Kaisen regression test

Use the same episode that previously displayed `English / Dual Audio` while Stremio's
actual track selector showed only Japanese and Portuguese.

Expected v7 behavior when `English` is required:

- if actual media info is available and contains no English audio -> stream is removed;
- if actual media info contains English -> stream remains;
- if actual media info is unavailable -> existing release-name fallback remains in use.

Also click several of the first six native AIOStreams results. Each real playback
request should log `forceFresh: true`, and a successful resolve should log the final
host without exposing the full signed URL.
