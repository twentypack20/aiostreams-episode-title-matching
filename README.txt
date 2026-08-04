AIOStreams safe anime resolver preflight patch
==============================================

Files changed
-------------
- packages/core/src/streams/filterer.ts
- packages/core/src/main/resources.ts
- packages/server/src/routes/api/debrid.ts
- .env.sample

Why the previous universal preflight failed
-------------------------------------------
The prior version used GET + Range and followed every redirect through to the
final media response. That had two serious problems:

1. AIOStreams represents many debrid failures by redirecting to small MP4 error
   videos such as unavailable_for_legal_reasons.mp4, download_failed.mp4, and
   no_matching_file.mp4. Because the old checker followed the redirect and saw
   video/mp4, it incorrectly marked the error video as playable.

2. The old checker touched the final debrid/CDN media URL from the VPS. That is
   not the same network path or client IP that Stremio will use, and it may
   consume or interfere with temporary/provider-bound playback links.

What this version does
----------------------
- Checks all final HTTP(S) anime results when CHECK_LIMIT is 0.
- Uses redirect: manual for AIOStreams and Torrentio resolver routes.
- Detects AIOStreams static error-video redirects before they are followed.
- Follows only resolver-to-resolver hops.
- Treats a non-error redirect to a direct media/CDN URL as resolver success.
- Never downloads a byte from the final debrid/CDN media URL.
- Uses HEAD only for already-direct URLs; if HEAD is unsupported, the result is
  inconclusive rather than falling back to a destructive GET.
- Logs a per-link debug result without logging the sensitive resolver URL.

This is a resolver validation check, not a guarantee that a specific Stremio
player/device can decode the file or that a provider link will remain valid.
A server-side check cannot perfectly reproduce playback from the client device.

Recommended docker-compose.yml environment
------------------------------------------
  PREFER_AIOSTREAMS_PLAYBACK_FOR_ANIME: "true"
  TORRENTIO_ANIME_RESOLVE_MODE: "demote"
  TORBOX_ANIME_MODE: "demote"

  ANIME_PREFLIGHT_PLAYBACK_CHECK: "true"
  ANIME_PREFLIGHT_PLAYBACK_CHECK_LIMIT: "0"
  ANIME_PREFLIGHT_PLAYBACK_TIMEOUT_MS: "7000"
  ANIME_PREFLIGHT_PLAYBACK_CONCURRENCY: "3"
  ANIME_PREFLIGHT_INCONCLUSIVE_MODE: "keep"
  ANIME_HIDE_LEGAL_UNAVAILABLE: "true"

Use "keep" during the first test. After confirming the logs classify known bad
links correctly, change inconclusive mode to "demote" or "remove" if desired.

Emergency rollback
------------------
To disable all preflight behavior without rebuilding:

  ANIME_PREFLIGHT_PLAYBACK_CHECK: "false"

Then recreate the container.

Deployment
----------
1. Replace the changed source files or apply filterer.patch.
2. Commit and push so GitHub Actions rebuilds the image.
3. On the VPS:

   cd /root/aiostreams
   docker compose pull aiostreams
   docker compose up -d --force-recreate aiostreams

4. Verify the live environment:

   docker inspect aiostreams \
     --format '{{range .Config.Env}}{{println .}}{{end}}' \
     | grep -E 'ANIME_PREFLIGHT|PREFER_AIOSTREAMS|TORRENTIO_ANIME|TORBOX_ANIME'

5. Inspect the resolver-preflight logs:

   docker logs aiostreams --since 20m 2>&1 \
     | grep -Ei 'resolver preflight|preflight result'

Playback-time debrid resolution retry
-------------------------------------
The resolver preflight runs while the stream list is built. A separate failure
can still happen after a user clicks an AIOStreams cloud/playback link: the
playback route calls the configured debrid service and either redirects to the
real media URL or redirects to an AIOStreams error video.

This patch retries temporary failures inside the AIOStreams playback route
before it returns that error video. It applies to links using:

  /api/v1/debrid/playback/...

It cannot change retry behavior inside a direct third-party resolver URL such
as torrentio.strem.fun/resolve/....

Default behavior:
- 1 initial resolution attempt plus 2 retries.
- Exponential delays of 750 ms and 1500 ms.
- Retries transient server/network errors and unknown 5xx-style failures.
- Does not retry permanent conditions such as legal blocks, invalid files,
  authentication failures, payment/account limits, or no matching file.
- Does not retry HTTP 429/rate limits by default, because repeated rejected
  requests can worsen provider throttling.
- Does not log encrypted credentials, resolver URLs, or final media URLs.

Recommended docker-compose.yml environment
------------------------------------------
  DEBRID_RESOLVE_RETRIES: "2"
  DEBRID_RESOLVE_RETRY_DELAY_MS: "750"
  DEBRID_RESOLVE_RETRY_MAX_DELAY_MS: "4000"
  DEBRID_RESOLVE_RETRY_ON_RATE_LIMIT: "false"
  DEBRID_RESOLVE_RETRY_UNKNOWN_ERRORS: "true"

DEBRID_RESOLVE_RETRIES counts retries after the initial attempt. Set it to 0 to
turn playback-time retries off without rebuilding.

Useful logs
-----------
  docker logs aiostreams --since 20m 2>&1 \
    | grep -Ei 'debrid resolve.*retry|retries exhausted'

A successful automatic recovery is logged as:

  Debrid resolve retry succeeded

AIOStreams will still return its normal error video if all allowed attempts
fail or if the failure is classified as permanent.
