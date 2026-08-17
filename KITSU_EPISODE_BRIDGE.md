# AIOStreams — Kitsu Episode Number Bridge

Companion patch for AIOMetadata v5.

## Supported Kitsu episode IDs

Legacy:

```text
kitsu:<kitsuId>:<absoluteEpisode>
```

Extended bridge:

```text
kitsu:<kitsuId>:<absoluteEpisode>:<mappedSeason>:<mappedEpisode>
```

For an extended request AIOStreams keeps three facts at once:

- `season` / `episode`: conventional mapped S/E used by normal season/episode matching
- `absoluteEpisode`: Kitsu/anime episode number used as the alternate anime match
- upstream addon request ID: normalized back to `kitsu:<kitsuId>:<absoluteEpisode>` so existing addons are not asked to understand the custom extension

## Matching behavior

The existing season/episode filter is preserved for anime. It can accept:

1. the mapped conventional season/episode pair, or
2. the existing absolute-episode fallback logic for anime releases.

This keeps the protection against wrong OVAs/specials/episodes instead of disabling anime matching.

## Files changed

- `packages/core/src/utils/id-parser.ts`
- `packages/core/src/streams/context.ts`
- `packages/core/src/streams/fetcher.ts`
- `packages/core/src/builtins/base/debrid.ts`
- `packages/core/src/main/resources.ts`
- `packages/core/src/utils/anime-database.ts`
- `packages/core/src/builtins/seadex/addon.ts`
