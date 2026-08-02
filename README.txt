AIOStreams final anime playback preflight patch
==============================================

Files changed
-------------
- packages/core/src/streams/filterer.ts
- packages/core/src/main/resources.ts

What changed
------------
The previous preflight ran inside the basic filter stage. That meant it ran too
early, checked only the first configured number of provider-specific URLs, and
could check streams that were later removed while missing streams that survived
sorting, result limits, and stream-expression filtering.

This version moves preflight to the end of the stream pipeline, immediately
before the final streams are proxied/returned to Stremio. It checks the exact
final anime playback links that AIOStreams intends to show.

It no longer restricts checks to one provider. Every final HTTP(S) playback URL
is eligible, including:
- AIOStreams /api/v1/debrid/playback/... links
- Torrentio /resolve/realdebrid/... links
- Torrentio /resolve/torbox/... links
- Other direct HTTP(S) stream URLs

A lightweight GET with Range: bytes=0-0 is used so the full video is not
downloaded. The checker follows redirects and validates the final response.
It removes clear hard failures, including:
- HTTP 4xx failures such as 403, 404, 410, 451
- legal/unavailable messages
- successful HTTP 200 text/HTML/JSON error responses
- resolver JSON containing an error or success=false
- empty responses and unexpected non-media pages

Temporary failures such as timeouts, 429, and common gateway/server errors are
classified as inconclusive. They can be kept, demoted, or removed with an env
setting.

Recommended docker-compose.yml environment
------------------------------------------
Under services.aiostreams.environment, use:

  PREFER_AIOSTREAMS_PLAYBACK_FOR_ANIME: "true"
  TORRENTIO_ANIME_RESOLVE_MODE: "demote"
  TORBOX_ANIME_MODE: "demote"

  ANIME_PREFLIGHT_PLAYBACK_CHECK: "true"
  ANIME_PREFLIGHT_PLAYBACK_CHECK_LIMIT: "0"
  ANIME_PREFLIGHT_PLAYBACK_TIMEOUT_MS: "7000"
  ANIME_PREFLIGHT_PLAYBACK_CONCURRENCY: "3"
  ANIME_PREFLIGHT_INCONCLUSIVE_MODE: "keep"
  ANIME_HIDE_LEGAL_UNAVAILABLE: "true"

  ALLOW_FOREIGN_ORIGINAL_UNKNOWN_LANGUAGE_FALLBACK: "false"

Preflight settings
------------------
ANIME_PREFLIGHT_PLAYBACK_CHECK_LIMIT:
- 0 = check every final playable result
- positive number = check only that many final results

ANIME_PREFLIGHT_PLAYBACK_CONCURRENCY:
- Number of links checked at the same time
- Recommended: 3

ANIME_PREFLIGHT_INCONCLUSIVE_MODE:
- keep   = leave timed-out/rate-limited/transient-error links in place
- demote = keep them but move them below verified links
- remove = hide them when they cannot be verified

Recommended first test
----------------------
Use "keep" first. This removes definite failures without hiding working links
merely because a debrid provider was temporarily slow. After observing logs, use
"demote" or "remove" only if desired.

Important limitation
--------------------
This verifies HTTP playback availability, not whether every Stremio player can
decode every codec/container/audio combination. A link can pass HTTP preflight
and still fail on a particular device because of player/codec compatibility.

Because the check runs after result limiting, failed links are removed from the
final list but are not automatically replaced with lower-ranked candidates in
this version.

Deployment
----------
1. Commit and push the changed source files.
2. Wait for GitHub Actions to build the image.
3. On the VPS:

   cd /root/aiostreams
   docker compose pull
   docker compose up -d --force-recreate

4. Verify env vars:

   docker inspect aiostreams \
     --format '{{range .Config.Env}}{{println .}}{{end}}' \
     | grep -E 'PREFER_AIOSTREAMS|TORRENTIO_ANIME|TORBOX_ANIME|ANIME_PREFLIGHT|ALLOW_FOREIGN'

5. Verify compiled code:

   docker cp aiostreams:/app/packages/core/dist/streams/filterer.js /tmp/filterer.js
   grep -E 'preflightPlaybackStreams|ANIME_PREFLIGHT_PLAYBACK_CONCURRENCY|ANIME_PREFLIGHT_INCONCLUSIVE_MODE' /tmp/filterer.js
