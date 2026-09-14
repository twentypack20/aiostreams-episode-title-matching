# AIOStreams v7.2.1 — Anime Matching Activation / Episode Metadata Isolation

Baseline: exact AIOStreams v7.2 anime-classification build deployed/tested on 2026-09-14.

## Why this build exists

The v7.2 test confirmed that Jujutsu Kaisen Season 3 is now correctly classified as anime (`isAnime: true`). The same debug log also exposed two older bugs that became visible once anime classification was fixed:

1. Anime-only matching scopes were being bypassed. A request with `type=series`, `isAnime=true`, and `requestTypes=["anime"]` incorrectly failed the scope check because the code first required the literal base type (`series`) to be present. This meant the custom anime-only episode-title protection could never run when configured only for `anime`.
2. Metadata locking used a show-level key that omitted season/episode coordinates. Concurrent current-episode / precache-next-episode requests for the same series could therefore share the first request's request-specific `episodeTitle` for about two seconds. That is exactly capable of making S3E10 inherit S3E9's episode title while the filenames correctly say S3E10.

## Changes

### packages/core/src/streams/filterer.ts
- Corrects request-type scope checks for title matching, year matching, season/episode matching, and episode-title matching.
- For anime requests, the `anime` selector is authoritative.
- For non-anime requests, the literal base type (`movie` / `series`) remains authoritative.
- This makes `episodeTitleMatching.requestTypes = ["anime"]` actually execute for anime instead of being bypassed.

### packages/core/src/metadata/service.ts
- Adds season, episode, and absolute-episode coordinates to the distributed metadata lock key.
- Prevents simultaneous requests for different episodes of the same series from reusing one another's request-specific `episodeTitle`.
- Does not change the metadata providers or the returned show-level metadata itself.

## Preserved behavior

All v6/v7/v7.1/v7.2 custom behavior is preserved, including:
- AnimeAPI-backed fresh-season classification and conservative metadata fallback.
- Authoritative provider/container language propagation.
- Required English behavior.
- Episode-title mismatch protection logic and thresholds.
- Kitsu conventional/absolute bridge.
- Native AIOStreams anime playback preference.
- Torrentio/TorBox demotion behavior.
- Fresh debrid playback URL generation and retries.
- Resolver preflight behavior.

## Validation

- TypeScript syntax-transpile validation passed for both changed TypeScript files.
- Request-type truth-table regression passed: anime + [anime] executes; anime + [series] bypasses; non-anime series + [series] executes; non-anime series + [anime] bypasses.
- Verified metadata lock keys differ between S3E9 and S3E10 for the same IMDb series.
- Verified every other repository file remains byte-identical to v7.2 apart from this release note.

Full dependency/type/Docker validation remains GitHub Actions' job because the local workspace dependencies are not installed here.

## Deployment

Extract the changed-files ZIP directly over the existing v7.2 repository root and overwrite matching files. Do not delete the repository first and do not create a nested directory.

After GitHub Actions succeeds:

```bash
cd /root/aiostreams
docker compose pull aiostreams
docker compose up -d --force-recreate aiostreams
docker compose ps
```

For regression testing, keep `LOG_LEVEL=debug` and `EPISODE_TITLE_DEBUG=true` temporarily, load Jujutsu Kaisen S3E9 and then S3E10, and confirm:
- `isAnime:true`
- S3E10's requested episode title is `Tokyo Colony No. 1 - Part 4`
- there is no `Episode title matching bypassed: request type not enabled` message for anime-only episode-title matching.
