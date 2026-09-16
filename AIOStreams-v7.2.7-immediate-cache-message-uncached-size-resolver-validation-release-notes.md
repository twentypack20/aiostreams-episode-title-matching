# AIOStreams v7.2.7 — Immediate cache message / uncached size cap / stronger resolver validation

This custom release is based on v7.2.6 and preserves the existing legal-block memory,
library-vs-cached fix, anime matching, provider media-info, language handling, fresh
playback, addon retry, and debrid retry behavior except for the targeted changes below.

## Changes

### 1. Cache-and-Play no longer leaves Stremio spinning while Real-Debrid downloads

For built-in torrent playback, once the debrid provider accepts the torrent but reports
that it is still `downloading`, `queued`, `processing`, or otherwise not yet downloaded,
AIOStreams now returns a distinct `DOWNLOAD_IN_PROGRESS` state immediately.

Result:

- the torrent is still submitted to the debrid provider normally;
- the provider continues the download independently after the Stremio request ends;
- AIOStreams does **not** poll for up to 120 seconds while Stremio appears to hang;
- the general debrid retry loop does not retry this expected in-progress state;
- Stremio is redirected to the downloading information video immediately.

A provider response of `failed` or `invalid` is still treated as an actual failure.

### 2. The downloading information video now gives useful instructions and stays visible

`packages/server/src/static/downloading.mp4` has been replaced with a one-hour static
information clip. The screen now says:

```text
[AIOStreams]
Your debrid service is downloading this file.

The download will continue in the background.
Go back to Home, then reopen this episode.
When you see ⚡ next to this link, it's ready to play.
```

The long duration prevents the old two-minute clip from ending and dropping the user
back onto Stremio's loading screen. The intended workflow is still to back out after
reading the message and reopen the episode later for a fresh stream list.

### 3. Uncached debrid results larger than 8 GB are hidden by default

A new custom safeguard filters oversized **uncached** debrid results before sorting and
final display. Cached/ready results are unaffected regardless of size.

Default:

```text
UNCACHED_MAX_SIZE_GB=8
```

Behavior:

- cached 20 GB / 50 GB result: kept normally;
- uncached result <= 8 GB: kept normally;
- uncached result > 8 GB: removed;
- unknown-size uncached result: kept;
- set `UNCACHED_MAX_SIZE_GB=0` to disable the special uncached cap.

The limit uses the stream/torrent size AIOStreams is displaying. For season packs this
is intentionally the whole pack size because that is what the debrid provider would
need to download.

### 4. External resolver validation now requires a meaningful media prefix

The v7.2.6 one-byte check was too weak: an unhealthy Torrentio-style resolver could
return media headers and a byte, pass preflight, and then leave Stremio loading forever.

Known external resolver hosts now:

- receive a bounded Range request for the start of the media;
- must produce 32 KiB promptly by default for binary media;
- must match a common media/container signature (Matroska/WebM, MP4/QuickTime, AVI,
  Ogg, FLV, ASF/WMV, MPEG audio/AAC, MPEG-TS, MPEG/Annex-B, HLS, or DASH);
- are rejected if they return an obvious text/error body under media headers;
- log the validated byte count and detected signature at debug level.

The threshold is configurable:

```text
EXTERNAL_RESOLVER_MIN_MEDIA_BYTES=32768
```

The same stronger validation is used both by final stream preflight and by the
playback-time external resolver wrapper. The preflight also forwards the Stremio client
IP headers when available so the resolver check more closely matches the real request.

Direct final debrid/CDN URLs are still not consumed by the VPS during preflight.

## Version metadata

`resources/metadata.json` reports:

- Version: `7.2.7`
- Tag: `v7.2.7-custom`
- Channel: `stable`

## Unchanged behavior

No changes were made to:

- provider-confirmed legal-unavailable memory/suppression from v7.2.6;
- Required/Preferred language policy;
- authoritative provider/container audio-language handling;
- anime episode-title matching;
- Kitsu / absolute-episode bridges;
- anime playback ranking;
- addon fetch retry policy;
- ordinary transient debrid retry policy;
- TorBox anime behavior;
- fresh final playback links.
