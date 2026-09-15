AIOStreams safe resolver preflight and playback retry patch
==============================================

Files changed
-------------
- packages/core/src/streams/filterer.ts
- packages/core/src/main/resources.ts
- packages/core/src/transformers/stremio.ts
- packages/core/src/utils/external-resolver.ts
- packages/core/src/utils/index.ts
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
- Checks final HTTP(S) results for movies, series, and anime when CHECK_LIMIT is 0.
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

Direct Torrentio resolver URLs are now wrapped by AIOStreams at response
formatting time, so the same retry policy can cover Torrentio-to-TorBox and
Torrentio-to-Real-Debrid playback routes as well.

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

External Torrentio resolver playback wrapper
---------------------------------------------
Direct Torrentio resolver links previously bypassed AIOStreams after they were
returned to Stremio, so DEBRID_RESOLVE_RETRIES could not help them. This update
wraps supported Torrentio /resolve/... URLs in an encrypted local endpoint:

  /api/v1/debrid/external-resolver/...

At playback time AIOStreams now follows only known resolver/API hops, retries
transient failures using the existing DEBRID_RESOLVE_* settings, and redirects
Stremio to the final CDN/media URL without downloading the video on the VPS.
If all server-side attempts fail for a temporary reason, it redirects to the
original Torrentio URL for one final client-side attempt. Permanent resolver
errors use the usual AIOStreams error clip.

The wrapper is enabled by default. Optional settings:

  EXTERNAL_RESOLVER_PLAYBACK_WRAPPER: "true"
  EXTERNAL_RESOLVER_TIMEOUT_MS: "10000"
  EXTERNAL_RESOLVER_MAX_HOPS: "5"
  EXTERNAL_RESOLVER_FALLBACK_TO_ORIGINAL: "true"

The initial URL is restricted to an allowlisted Torrentio host/path, and only
known resolver API hosts are followed. Final media/CDN hosts are never fetched
by AIOStreams; they are handed back to Stremio.

Universal preflight aliases
---------------------------
The final resolver preflight now applies to movies and ordinary series as well
as anime. Existing ANIME_PREFLIGHT_* variables still work. New generic aliases
are also accepted and take priority when both are set:

  PLAYBACK_PREFLIGHT_CHECK
  PLAYBACK_PREFLIGHT_CHECK_LIMIT
  PLAYBACK_PREFLIGHT_TIMEOUT_MS
  PLAYBACK_PREFLIGHT_CONCURRENCY
  PLAYBACK_PREFLIGHT_INCONCLUSIVE_MODE
  PLAYBACK_HIDE_LEGAL_UNAVAILABLE

Initial addon stream-fetch retry + Trakt guard
----------------------------------------------
This custom build now adds a retry layer to the *initial* stream-list request
made to configured addons such as Torrentio. This is intentionally separate
from the existing playback/debrid resolver retry and final playback preflight.

Default behavior:
- 1 initial addon request plus 2 retries.
- Exponential delays of 300 ms then 600 ms (capped by the configured maximum).
- Retries HTTP 5xx responses (including 502 Bad Gateway), network errors, and
  timeouts.
- Does not retry deterministic parse/schema/invalid-response failures.
- Does not retry HTTP 4xx responses.
- Does not retry HTTP 429 by default; rate-limit retry is opt-in.
- If all attempts fail, AIOStreams keeps the existing behavior: that addon
  contributes zero streams while other addons continue normally.

Optional docker-compose environment overrides:

  ADDON_FETCH_RETRIES: "2"
  ADDON_FETCH_RETRY_DELAY_MS: "300"
  ADDON_FETCH_RETRY_MAX_DELAY_MS: "1500"
  ADDON_FETCH_RETRY_ON_RATE_LIMIT: "false"

Useful logs:

  docker logs aiostreams --since 20m 2>&1 \
    | grep -Ei 'addon fetch.*retry|addon fetch failed|502|503|504'

Successful recovery is logged as:

  addon fetch retry succeeded

Trakt alias guard
-----------------
AIOStreams' Trakt alias lookup uses a server-side TRAKT_CLIENT_ID. It is not
connected to the user's Trakt login/scrobbling inside Stremio.

Previously FETCH_TRAKT_ALIASES defaulted to true even when TRAKT_CLIENT_ID was
unset, which could cause repeated Trakt 403 responses. This build skips Trakt
alias requests when the client ID is missing. No environment change is needed
for that safe behavior.

To use Trakt aliases intentionally, configure a valid server-side client ID:

  TRAKT_CLIENT_ID: "..."
  FETCH_TRAKT_ALIASES: "true"

To disable Trakt aliases explicitly:

  FETCH_TRAKT_ALIASES: "false"

AIOStreams v7: actual audio metadata + fresh playback links
----------------------------------------------------------
See V7_PROVIDER_MEDIA_INFO_AND_FRESH_PLAYBACK.md for the complete behavior,
configuration, deployment notes, and regression tests.

Key defaults:
  PROVIDER_MEDIA_INFO_LOOKUP=true
  PROVIDER_MEDIA_INFO_LOOKUP_LIMIT=6
  PROVIDER_MEDIA_INFO_TIMEOUT_MS=2500
  PROVIDER_MEDIA_INFO_CACHE_TTL=86400
  PLAYBACK_FORCE_FRESH_DEBRID_LINK=true

When actual provider/container media metadata is present, its audio languages are
authoritative over filename/release guesses. Native AIOStreams playback requests
also force a fresh final debrid/CDN link on the real Stremio click by default.

AIOStreams v7.1: resolver language propagation repair
-----------------------------------------------------
See V7_1_RESOLVER_LANGUAGE_PROPAGATION.md.

v7.1 preserves the v7 provider-media and fresh-playback work, then closes the
remaining language gap for equivalent resolver copies of the same torrent file:
  - authoritative media languages propagate by exact infoHash + fileIdx;
  - conflicting provider language sets fail open instead of being guessed;
  - Dual Audio / Dubbed no longer satisfy Required English by themselves;
  - anime duplicate matching prefers infoHash + fileIdx when available;
  - successful external resolver playback now has safe info-level diagnostics.

No new environment variables are required.

AIOStreams v7.2: anime classification freshness repair
------------------------------------------------------
See V7_2_ANIME_CLASSIFICATION.md.

v7.2 preserves v7.1 and adds the current nattadasu/animeApi relation dataset as
an additive anime-mapping source so newly released seasons do not silently lose
anime-only safeguards. If relation mapping still misses, metadata can recover
classification via TMDB/TVDB IDs or a conservative Japanese + Animation
fallback before filtering/ranking.

Default (no override required):
  ANIME_DB_ANIMEAPI_REFRESH_INTERVAL=86400

v7.2.2 continuation: fixes false-positive known-episode-title conflicts exposed by v7.2.1. Normal anime episode filenames that share the franchise name with a numbered special (for example Jujutsu Kaisen vs Jujutsu Kaisen 0) are no longer rejected from fuzzy overlap alone; neighbouring Part N titles are compared competitively against the requested title.

AIOStreams v7.2.3 continuation: ignores known episode/special titles that are exactly the series title (or one of its aliases) when checking for a conflicting episode title. This prevents ordinary filenames such as "Combatants Will Be Dispatched! - S01E02.mkv" from being rejected merely because metadata also contains a special/episode named "Combatants Will Be Dispatched!". Existing Jujutsu Kaisen 0 and neighbouring Part N protections remain active.

v7.2.4 diagnostic probe: optional PLAYBACK_CDN_DIAGNOSTIC_PROBE performs a tiny delayed Range GET against freshly resolved final CDN URLs for real client playback only, logs host/status/timing/header metadata without logging signed URLs, and skips external-resolver preflight requests. Disabled by default.

AIOStreams v7.2.5: clearer language removal diagnostics
-------------------------------------------------------
v7.2.5 does not loosen or otherwise change language filtering. It only makes
Removal Reasons distinguish actual provider/container audio evidence from
release-name/parser language tags:
  - provider/container metadata is labelled "Verified audio";
  - filename/release parser output is labelled "Parser/source languages";
  - anime entries rejected because English appears only as unverified source
    metadata now explicitly say "English audio unconfirmed; likely
    subtitle/source metadata".

The v7.2.4 final-CDN diagnostic probe remains available in source and remains
disabled by default. No CDN diagnostic environment variables are required for
normal operation.
