AIOStreams anime playback fallback patch
=======================================

This patch replaces the blunt anime TorBox block with safer fallback controls and
adds anime playback-route cleanup for the Torrentio/AIOStreams resolver issue we
found.

Changed file:
  packages/core/src/streams/filterer.ts

New / updated env vars:

  PREFER_AIOSTREAMS_PLAYBACK_FOR_ANIME="true"
    - For anime, scores AIOStreams' own /api/v1/debrid/playback/ links above
      Torrentio resolver links.
    - If the same file appears through both AIOStreams playback and
      torrentio.strem.fun/resolve, hides the Torrentio resolver duplicate.

  TORRENTIO_ANIME_RESOLVE_MODE="fallback"
    Modes:
      allow    = show Torrentio resolver anime links normally
      demote   = keep them, but push them below non-Torrentio playback links
      fallback = hide them when AIOStreams/non-Torrentio playback links exist;
                 show them only if they are the only anime options
      block    = remove all Torrentio resolver anime links

  TORBOX_ANIME_MODE="fallback"
    Modes:
      allow    = show TorBox anime links normally
      demote   = keep them, but push them below non-TorBox links
      fallback = hide TorBox anime links when non-TorBox links exist;
                 show TorBox only if it is the only anime option
      block    = remove TorBox anime links entirely

  ALLOW_FOREIGN_ORIGINAL_UNKNOWN_LANGUAGE_FALLBACK="false"
    - Keeps the earlier safety change: Unknown language does not bypass English
      requirements for foreign-original content unless explicitly enabled.

Recommended docker-compose.yml environment lines:

  PREFER_AIOSTREAMS_PLAYBACK_FOR_ANIME: "true"
  TORRENTIO_ANIME_RESOLVE_MODE: "fallback"
  TORBOX_ANIME_MODE: "fallback"
  ALLOW_FOREIGN_ORIGINAL_UNKNOWN_LANGUAGE_FALLBACK: "false"

Important:
  Remove or override the older env var:
    DISABLE_TORBOX_FOR_ANIME: "true"

  If DISABLE_TORBOX_FOR_ANIME is still present and TORBOX_ANIME_MODE is not set,
  the code treats it as TORBOX_ANIME_MODE=block for backwards compatibility.
  Setting TORBOX_ANIME_MODE=fallback overrides the old flag.

Deploy flow:
  1. Extract this ZIP at the repo root and overwrite the file.
  2. Commit and push.
  3. Wait for GitHub Actions to build the Docker image.
  4. On VPS:
       cd /root/aiostreams
       docker compose pull
       docker compose up -d --force-recreate

Expected behavior for the Mushoku / Jobless Reincarnation issue:
  - The Torrentio Real-Debrid duplicate above the working AIOStreams playback
    link should be hidden.
  - AIOStreams playback links should rank first for anime.
  - TorBox anime is not permanently deleted; it appears only as fallback when
    no non-TorBox anime options exist.
