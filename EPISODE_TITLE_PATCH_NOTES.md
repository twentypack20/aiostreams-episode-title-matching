# Episode Title Matching Patch Notes

This fork adds a conservative `episodeTitleMatching` filter to AIOStreams.

What changed:

- Added `episodeTitleMatching` to `UserDataSchema`.
- Added episode title fields to metadata/context:
  - `episodeTitle`
  - `seasonEpisodeTitles[]`
- Uses Cinemeta episode video titles when available.
- Uses TMDB episode detail `name` when available.
- Adds a new AIOStreams UI card under `Filters -> Matching -> Episode Title Matching`.
- Adds a new removal reason/stat bucket: `Episode Title Matching`.
- Adds passthrough stage `episodeTitle`.
- Includes custom Docker image workflow and sample compose file from the handoff package.

Recommended first test settings:

- Episode Title Matching: Enabled
- Mode: Mismatch Only
- Strict: Off
- Similarity Threshold: 0.82
- Request Types: anime, series
- Season/Episode Matching: Enabled + Strict On

The filter is intentionally conservative: it does not require normal releases like `Show S01E03 1080p` to contain the episode title. It only removes obvious conflicts when metadata provides the selected episode title, or when a candidate looks like an extra/special/spinoff that does not match the selected episode/title.

I could not run a full build in this sandbox because `pnpm` dependencies could not be downloaded from npm. Please run this after pushing to GitHub or on a machine with internet:

```bash
corepack enable
pnpm install
pnpm run build
```
