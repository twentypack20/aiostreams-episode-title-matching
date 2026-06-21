# Episode Title Matching Design

## Problem

AIOStreams currently has title matching and season/episode matching. Those can still let a wrong anime special/spinoff through when the file looks episode-like, e.g. `Part 3`, and upstream addon/debrid metadata maps it to an episode request.

Known example:

- Requested: `Overlord S01E03 - Battle of Carne Village`
- Candidate: `Ple Ple Pleiades OVA Clementine The Fugitive Part 3.mkv`

Season/episode matching can see `3` and pass it. Title matching can see franchise relationship or insufficient title parsing and pass it. The missing check is requested **episode title** vs candidate filename/title.

## Goals

- Do not globally block `OVA`, `special`, `recap`, etc.
- Do not require all good streams to contain the episode title, because many files are named only `S01E03` or `03`.
- Reject clear conflicts when a candidate strongly looks like another episode/special title.
- Make it configurable and limited by request type/addon like other matching filters.

## Config

Add a userData config block:

```ts
episodeTitleMatching: {
  enabled?: boolean;
  strict?: boolean;
  mode?: 'mismatchOnly' | 'requireMatch';
  similarityThreshold?: number;
  requestTypes?: string[];
  addons?: string[];
}
```

Suggested defaults:

```ts
episodeTitleMatching: {
  enabled: false,
  strict: false,
  mode: 'mismatchOnly',
  similarityThreshold: 0.82,
  requestTypes: ['series', 'anime']
}
```

## Algorithm

For a stream candidate:

1. If feature disabled, allow.
2. If not `series`/`anime` request, allow.
3. If there is no parsed season/episode request, allow.
4. If requested episode title is missing, allow.
5. If stream is a multi-episode pack or season pack, allow unless strict mode is explicitly enabled.
6. Build candidate text from filename, folder name, parsed file title, and stream title/name when available.
7. Normalize candidate text and requested episode title.
8. If candidate strongly matches requested episode title, allow.
9. If candidate strongly matches any known sibling/special title that is not the requested title, reject.
10. In `mismatchOnly` mode, otherwise allow.
11. In `requireMatch` or `strict` mode, reject if requested episode title was not found.

## Why mismatch-only should be default

Good releases are commonly named like:

- `Overlord S01E03 1080p BluRay`
- `[Group] Overlord - 03 [BD 1080p]`

Those do not include `Battle of Carne Village`, but they are valid.

## Data needed

Best case:

- `requestedMetadata.episodeTitle`
- `requestedMetadata.seasonEpisodeTitles[]`
- optionally `requestedMetadata.specialEpisodeTitles[]`

If sibling titles are unavailable, the filter can still do only conservative checks, but it will be less effective.

## Pitfalls

- Anime has multiple title forms: English, Romaji, Japanese, franchise/subtitle.
- Episode titles can be translated differently between providers.
- Scene filenames often omit episode titles entirely.
- Season packs and multi-episode files should not be rejected just because the exact episode title is missing.
- Specials/OVAs should still work when the requested item is the special itself.
- The filter should be logged in statistics so false positives can be debugged.

