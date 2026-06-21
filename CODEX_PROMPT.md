# Codex Task: Add Episode Title Matching to AIOStreams

You are modifying a fork of `Viren070/AIOStreams`. Implement a conservative `episodeTitleMatching` feature in the stream filtering pipeline.

## Context

AIOStreams currently has title, year, and season/episode matching. There is an open feature request for episode title matching because anime specials/spinoffs can pass strict season/episode matching when filenames contain a matching number but the actual episode title/content is wrong.

Example failure:

- Requested: `Overlord S01E03 - Battle of Carne Village`
- Bad stream filename: `Ple Ple Pleiades OVA Clementine The Fugitive Part 3.mkv`

We need a filter that can reject obvious episode-title conflicts without globally blocking OVAs/specials.

## Requirements

### 1. Add config schema

Add `episodeTitleMatching` beside `titleMatching`, `yearMatching`, and `seasonEpisodeMatching` in the user-data schema.

Fields:

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

Default in filterer:

```ts
{
  enabled: false,
  strict: false,
  mode: 'mismatchOnly',
  similarityThreshold: 0.82,
  requestTypes: ['series', 'anime']
}
```

### 2. Add metadata support

Extend stream request metadata/context to expose:

```ts
episodeTitle?: string;
seasonEpisodeTitles?: Array<{
  season: number;
  episode: number;
  title: string;
}>;
```

Use existing TMDB/TVDB episode-detail fetching where possible. If only a single episode detail fetch exists, add title/name to that result first. Sibling-title support can be added if there is an existing seasons/episodes metadata structure available.

### 3. Add filter statistic

Add `episodeTitleMatching` to removed filter statistics and formatted filter detail output.

### 4. Implement filterer logic

In `packages/core/src/streams/filterer.ts`, add a `performEpisodeTitleMatch(stream)` helper close to `performTitleMatch()` and `performSeasonEpisodeMatch()`.

Call it after `performSeasonEpisodeMatch(stream)`.

Pseudo-code:

```ts
const performEpisodeTitleMatch = (stream: ParsedStream) => {
  const opts = {
    enabled: false,
    strict: false,
    mode: 'mismatchOnly',
    similarityThreshold: 0.82,
    requestTypes: ['series', 'anime'],
    ...(this.userData.episodeTitleMatching ?? {}),
  };

  if (!opts.enabled) return true;
  if (!parsedId) return true;
  if (!requestedMetadata?.episodeTitle) return true;

  if (opts.requestTypes?.length &&
      (!opts.requestTypes.includes(type) || (isAnime && !opts.requestTypes.includes('anime')))) {
    return true;
  }

  if (opts.addons?.length && !opts.addons.includes(stream.addon.preset.id)) {
    return true;
  }

  const episodes = stream.parsedFile?.episodes ?? [];
  const seasons = stream.parsedFile?.seasons ?? [];

  // Avoid breaking normal season packs / multi-episode packs in default mode.
  if (!opts.strict && (episodes.length > 1 || seasons.length > 0)) {
    return true;
  }

  const candidateText = [
    stream.filename,
    stream.folderName,
    stream.parsedFile?.title,
    stream.name,
    stream.description,
  ].filter(Boolean).join(' ');

  const candidate = normaliseTitle(candidateText);
  const requested = normaliseTitle(requestedMetadata.episodeTitle);

  const requestedScore = partial_ratio(candidate, requested) / 100;
  if (requestedScore >= opts.similarityThreshold) {
    return true;
  }

  const otherTitle = (requestedMetadata.seasonEpisodeTitles ?? []).find((ep) => {
    if (!ep.title || ep.title === requestedMetadata.episodeTitle) return false;
    const otherScore = partial_ratio(candidate, normaliseTitle(ep.title)) / 100;
    return otherScore >= opts.similarityThreshold;
  });

  if (otherTitle) {
    this.incrementRemovalReason(
      'episodeTitleMatching',
      `${stream.filename ?? stream.name ?? 'Unknown stream'} matched different episode title: ${otherTitle.title}`
    );
    return false;
  }

  if (opts.mode === 'requireMatch' || opts.strict) {
    this.incrementRemovalReason(
      'episodeTitleMatching',
      `${stream.filename ?? stream.name ?? 'Unknown stream'} did not match requested episode title: ${requestedMetadata.episodeTitle}`
    );
    return false;
  }

  return true;
};
```

Important: adjust property names to match actual `ParsedStream` shape.

### 5. UI

Add a Matching UI section called `Episode Title Matching` with:

- Enable toggle
- Strict toggle
- Mode dropdown: `Mismatch only` / `Require match`
- Similarity threshold slider/number
- Request Types selector, default series/anime
- Addons selector

If UI work is too broad for first pass, expose the config in schema and allow JSON/import use first.

### 6. Tests / manual validation

Manual test:

- Enable feature for anime/series.
- Request Overlord S01E03.
- Verify `Ple Ple Pleiades OVA Clementine The Fugitive Part 3.mkv` is removed if sibling/special title data is available or if candidate strongly conflicts.
- Verify normal `Overlord S01E03` releases remain.
- Verify opening/searching Ple Ple Pleiades itself does not globally block it.

### 7. Keep behavior conservative

Do not globally block `OVA`, `special`, `recap`, etc. This feature should be request-aware and title-aware.
