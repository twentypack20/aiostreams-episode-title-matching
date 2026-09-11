# AIOStreams v7.1 — Resolver Language Propagation Fix

This update is a focused repair on top of the deployed v7 provider-media / fresh-playback build.
It preserves all v6/v7 behavior and fixes the remaining language-verification gap reproduced with
Jujutsu Kaisen.

## Reproduced failure

A Torrentio/TorBox resolver result could still be displayed as `English / Dual Audio`, while the
actual MKV exposed only Japanese and Portuguese audio tracks in Stremio.

The v7 provider/container merge logic was correct once authoritative media info reached a stream,
but authoritative metadata discovered while AIOStreams reprocessed the same torrent through its
native debrid path was not copied back to the original external resolver copy. The resolver copy
could therefore survive the second language-filter pass using release-name guesses.

## v7.1 changes

### 1. Propagate authoritative media info across equivalent playback routes

When any built-in/native AIOStreams result obtains provider/container-verified audio languages for a
torrent file, v7.1 preserves that provenance through stream parsing and applies the same authoritative
languages to other surviving playback routes that identify the **exact same torrent file**. This covers
built-in Torznab/debrid results as well as service-wrapped/reconfigured results.

Identity is deliberately strict:

```text
infoHash + fileIdx
```

Hash-only matching is not used for propagation, so one episode in a season pack cannot inherit the
audio languages of another episode.

If multiple provider results for the same identity disagree on the non-empty audio-language set,
AIOStreams fails open and does not propagate the conflicting metadata.

### 2. Preserve provider-language provenance through the built-in stream parser

The built-in debrid addon now marks its generated stream when `authoritativeMediaInfo.languages` is
non-empty, and the general stream parser preserves that marker on the resulting `ParsedStream`. This
is what lets the cross-route propagation pass distinguish verified languages from filename guesses.

### 3. `mediaInfoSource=provider` now means audio languages are actually authoritative

Provider metadata may contain video/codec information without usable audio-language tags. v7.1
only marks a stream as provider-authoritative for language filtering when the provider/container
returned a non-empty audio-language list.

Other provider fields can still improve the parsed media information without falsely implying that
the language list was verified.

### 4. `Dual Audio` / `Dubbed` no longer bypass Required Languages by themselves

The old anime compatibility exception that allowed `Dual Audio` or `Dubbed` to satisfy
`Required Languages = English` without an explicit English language signal has been removed.

This preserves the intended meaning:

```text
Dual Audio = two audio tracks
Dubbed     = a dub exists
English    = English audio is indicated
```

`Dual Audio` and `Dubbed` remain valid **Preferred Languages** values. They simply cannot prove
English on their own.

### 5. Stronger duplicate identity for anime playback preference

For anime duplicate/playback-route comparison, v7.1 now prefers `infoHash + fileIdx` over formatted
filename text when both are available. This helps recognise native AIOStreams and Torrentio resolver
copies of the exact same file even when their display names differ.

The old filename identity remains the fallback when a complete hash/file-index identity is not
available.

### 6. Successful external resolver playback is now visible in normal logs

The external-resolver wrapper now emits safe `info` logs for both the incoming playback request and
the successful final redirect. Logged fields include provider, attempt counts, client-IP presence,
and final hostname. Full signed URLs, debrid credentials, and tokens are not logged.

## Configuration

No new environment variables are required. Keep the existing v7 settings, including:

```text
PROVIDER_MEDIA_INFO_LOOKUP=true
PROVIDER_MEDIA_INFO_LOOKUP_LIMIT=6
PROVIDER_MEDIA_INFO_TIMEOUT_MS=2500
PROVIDER_MEDIA_INFO_CACHE_TTL=86400
PLAYBACK_FORCE_FRESH_DEBRID_LINK=true

PLAYBACK_PREFLIGHT_CHECK=true
PLAYBACK_PREFLIGHT_CHECK_LIMIT=6
PLAYBACK_PREFLIGHT_TIMEOUT_MS=3000
PLAYBACK_PREFLIGHT_CONCURRENCY=6
PLAYBACK_PREFLIGHT_INCONCLUSIVE_MODE=keep
```

Keep **Addon Fetching Strategy = Default**.

Recommended AIOStreams language UI remains:

```text
Required Languages:  English
Preferred Languages: English, Dual Audio, Dubbed
Excluded Languages:  none
Included Languages:  none
```

## Validation after deployment

For the Jujutsu Kaisen regression case, refresh S1E24 and confirm that the previously observed
3.21 GB Japanese + Portuguese file is no longer advertised as English when authoritative metadata
for its exact torrent file is obtained.

Temporarily using `LOG_LEVEL=debug` makes the propagation visible:

```bash
docker logs aiostreams --since 5m 2>&1 \
  | grep -Ei 'provider media-info|authoritative|propagated authoritative|External resolver playback|resolver preflight'
```

Expected propagation log shape:

```text
propagated authoritative provider/container media info to equivalent resolver stream
```

A clicked external resolver should now also produce normal `info` entries similar to:

```text
External resolver playback request received
External resolver playback URL resolved
```

The logs contain only safe metadata and the final hostname, not the authenticated URL.

## Build validation

The source changes were syntax-checked locally. The supplied environment cannot install the full
workspace dependencies, so the GitHub Action remains the definitive dependency, TypeScript, frontend,
and Docker image build test.
