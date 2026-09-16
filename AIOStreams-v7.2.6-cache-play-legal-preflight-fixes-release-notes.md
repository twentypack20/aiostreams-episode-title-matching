# AIOStreams v7.2.6 — Cache-and-Play / legal-block / resolver reliability fixes

This custom release is based on v7.2.5 and preserves all existing anime matching,
provider-media-info, language, fresh-playback, debrid retry, and resolver behavior except
for the targeted fixes below.

## Changes

### 1. Cache-and-Play download timeouts no longer enter the debrid retry loop

When an uncached torrent has already been submitted to the debrid provider and the
Cache-and-Play wait reaches its timeout, the resulting HTTP 408 is now treated as a
terminal Cache-and-Play state rather than a transient resolver failure.

Result:

- the torrent remains downloading on the debrid provider;
- AIOStreams does not repeat the full wait two more times because of
  `DEBRID_RESOLVE_RETRIES`;
- Stremio is redirected to the existing `downloading.mp4` message:
  "The file is being downloaded to your debrid. Try again later."

Ordinary transient debrid/network failures still use the configured retry policy.

### 2. Real-Debrid/provider legal blocks are remembered and suppressed

When a provider explicitly returns HTTP 451 / `UNAVAILABLE_FOR_LEGAL_REASONS`,
AIOStreams now stores that failure by **provider + torrent infohash**.

With `PLAYBACK_HIDE_LEGAL_UNAVAILABLE=true`, later stream listings suppress the known
blocked provider/hash combination before Stremio sees it. A block learned for
Real-Debrid does not suppress the same torrent on another debrid provider.

The default remembered legal-block TTL is 30 days. It can be changed with:

```text
BUILTIN_DEBRID_LEGAL_UNAVAILABLE_CACHE_TTL=2592000
```

The first encounter can still appear once because the provider only exposes the legal
status when the magnet is actually submitted/resolved.

### 3. External resolver preflight now verifies that media bytes actually begin

Known resolver-hop hosts (not direct debrid/CDN hosts) must now produce at least one
media body byte after returning media headers before the route is classified as
playable.

This targets the observed Torrentio failure mode where the resolver returned a valid
URL/HTTP response immediately but Stremio then loaded forever without receiving media.

Direct final debrid/CDN URLs are still not consumed by the VPS during preflight.

The playback-time external resolver applies the same one-byte check. If a resolver host
returns media headers but never produces media data, AIOStreams returns a download-failed
message instead of handing Stremio a known-hanging route.

### 4. "In debrid library" no longer means "cached/ready"

A torrent that merely exists in the user's debrid library can still be downloading.
AIOStreams now marks a debrid torrent as cached/ready only when the provider reports
`cached` or `downloaded`.

This prevents a still-downloading torrent from being relabeled as `RD ⚡` merely because
Cache-and-Play already added it to the Real-Debrid library.

## Version metadata

`resources/metadata.json` reports:

- Version: `7.2.6`
- Tag: `v7.2.6-custom`
- Channel: `stable`

## Unchanged behavior

No changes were made to:

- Required/Preferred language policy
- authoritative provider/container audio-language handling
- anime episode-title matching
- Kitsu / absolute-episode bridges
- anime playback ranking
- addon fetch retry policy
- ordinary debrid retry policy
- TorBox anime behavior
- fresh final playback links
