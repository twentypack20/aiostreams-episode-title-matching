AIOStreams anime playback preflight patch
========================================

Files changed:
- packages/core/src/streams/filterer.ts

What this patch adds
--------------------
This patch builds on the anime playback fallback patch. It keeps the existing
logic that prefers AIOStreams debrid playback URLs over Torrentio resolve URLs,
but adds an optional preflight check for the top anime playback links.

The preflight check sends a lightweight HTTP Range request to the top anime
stream URLs before returning them to Stremio. If a stream clearly returns a hard
failure such as HTTP 451 / legal-unavailable, HTTP 403/404/410, or a text/html
error body containing "Unavailable for Legal Reasons" / "Try a different file",
AIOStreams removes that stream from the result list.

It intentionally keeps timeout/transient network failures instead of removing
them, to avoid false negatives on slow debrid providers.

Recommended docker-compose.yml environment
------------------------------------------
Under services.aiostreams.environment, use:

  PREFER_AIOSTREAMS_PLAYBACK_FOR_ANIME: "true"
  TORRENTIO_ANIME_RESOLVE_MODE: "demote"
  TORBOX_ANIME_MODE: "demote"
  ANIME_PREFLIGHT_PLAYBACK_CHECK: "true"
  ANIME_PREFLIGHT_PLAYBACK_CHECK_LIMIT: "5"
  ANIME_PREFLIGHT_PLAYBACK_TIMEOUT_MS: "3500"
  ANIME_HIDE_LEGAL_UNAVAILABLE: "true"
  ALLOW_FOREIGN_ORIGINAL_UNKNOWN_LANGUAGE_FALLBACK: "false"

Why demote instead of fallback/block?
-------------------------------------
The earlier TorBox anime block/fallback was intentionally conservative, but it
could hide good TorBox anime links that were not tested. With preflight enabled,
it is safer to let TorBox and Torrentio resolver links remain as lower-ranked
fallbacks, while AIOStreams playback links are preferred and obvious failures are
removed.

Modes still supported
---------------------
TORBOX_ANIME_MODE:
- allow    = leave TorBox anime normally
- demote   = keep TorBox anime but rank below non-TorBox results
- fallback = show TorBox anime only when no non-TorBox result exists
- block    = remove TorBox anime entirely

TORRENTIO_ANIME_RESOLVE_MODE:
- allow    = leave Torrentio resolver links normally
- demote   = keep them but rank below AIOStreams/non-Torrentio playback
- fallback = show them only when no non-Torrentio result exists
- block    = remove them entirely

Deployment
----------
1. Copy/overwrite the changed file into your repo.
2. Commit and push.
3. Wait for GitHub Actions to build the image.
4. On the VPS:

   cd /root/aiostreams
   docker compose pull
   docker compose up -d --force-recreate

Verify env vars:

   docker inspect aiostreams --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E 'PREFER_AIOSTREAMS|TORRENTIO_ANIME|TORBOX_ANIME|ANIME_PREFLIGHT|ALLOW_FOREIGN'

Verify patched code:

   docker cp aiostreams:/app/packages/core/dist/streams/filterer.js /tmp/filterer.js
   grep -E 'ANIME_PREFLIGHT_PLAYBACK_CHECK|preflightAnimePlaybackStreams|TORBOX_ANIME_MODE' /tmp/filterer.js

Notes
-----
The preflight check is not a perfect proof that every link will play in every
Stremio player. It only removes clear hard failures before they reach the user.
Codec/player incompatibilities can still happen, especially with AV1, HEVC, or
unusual containers.
