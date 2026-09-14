# AIOStreams v7.2 — Release / validation notes

Baseline: the exact v7.1 tree reconstructed from the user's deployed v7 ZIP plus
the v7→v7.1 resolver-language patch.

## Reason for this release

Jujutsu Kaisen S2 requests were correctly `isAnime=true`, while S3E5/S3E6/S3E7
were `isAnime=false` / `hasAnimeEntry=false`. Normal metadata still knew the
show was Japanese animation, so the failure was isolated to stale/incomplete
AnimeDatabase season mapping. This disabled anime-only safeguards such as the
episode-title mismatch check for the affected season.

## Changed files

- `packages/core/src/config/schema/metadata.ts`
  - Adds daily AnimeAPI refresh configuration.
- `packages/core/src/utils/anime-database.ts`
  - Adds nattadasu/animeApi as an additive relation source.
  - Indexes provider IDs and season IDs/hints.
  - Preserves existing mapping priority.
  - Uses reliable AnimeAPI Trakt season data only as a last-resort season hint.
  - Rejects `trakt_may_invalid=true` as cross-system season proof.
- `packages/core/src/streams/context.ts`
  - Records anime-classification provenance.
  - Can promote a missed request through metadata TMDB/TVDB IDs.
  - Adds conservative Japanese + Animation metadata fallback.
  - Starts SeaDex after a late promotion.
- `packages/core/src/streams/fetcher.ts`
  - Finalizes classification before SeaDex/filter processing.
- `packages/core/src/streams/filterer.ts`
  - Defensive classification finalization before capturing `isAnime`.
- `packages/core/src/main/resources.ts`
  - Finalizes classification for meta/service-wrapped processing too.
- `packages/docs/content/docs/configuration/environment-variables.mdx`
  - Documents `ANIME_DB_ANIMEAPI_REFRESH_INTERVAL`.
- `V7_2_ANIME_CLASSIFICATION.md`
  - Design and validation documentation.
- `README.txt`
  - v7.2 continuation note.

## Safety decisions

- No hard-coded Jujutsu Kaisen exception.
- AnimeAPI is additive rather than replacing the legacy relation sources.
- Existing Kitsu/Anime-Lists/synonym matches win before the AnimeAPI season
  fallback.
- `trakt_may_invalid=true` is deliberately excluded from cross-provider season
  fallback because of split-cour numbering differences.
- Metadata fallback requires both Japanese original language and Animation
  genre; it does not classify from title text alone.
- The AnimeAPI database itself is not bundled into this repository; AIOStreams
  downloads it into its existing anime-database data directory at runtime.

## Local validation performed

- TypeScript syntax-transpiled all changed `.ts` files with TypeScript 5.8.3.
- `git diff --check` passes.
- Synthetic AnimeAPI parser check using the documented v3 schema/sample shape.
- Synthetic fresh-season regression: stale legacy S1/S2 candidates plus a
  reliable AnimeAPI S3 candidate selects S3.
- Synthetic split-cour regression: `trakt_may_invalid=true` is not accepted as
  season proof.
- Metadata fallback tests:
  - Japanese + Animation => anime
  - Japanese without Animation => no promotion
  - English + Animation => no promotion
- Static regression checks confirm the v7.1 authoritative-language propagation
  and Dual-Audio/English protections remain present.

The complete workspace dependency/type/Docker build cannot be reproduced in the
local artifact environment because the pnpm workspace dependencies are not
installed. GitHub Actions remains the definitive full build test.

## Deployment

Extract/copy the changed-files ZIP directly over the existing repository root
and overwrite matching files. Do **not** delete the existing repository first,
and do not create a nested repository directory.

After GitHub Actions builds/publishes successfully:

```bash
cd /root/aiostreams
docker compose pull aiostreams
docker compose up -d --force-recreate aiostreams
docker compose ps
```

No new environment line is required; the AnimeAPI refresh defaults to one day.
For first validation, temporarily leave `LOG_LEVEL=debug` enabled.
