# AIOStreams v7.1 — Resolver Language Fix

Baseline: the exact deployed `aiostreams-v7-provider-media-fresh-playback-full(1).zip` supplied on
2026-09-11.

## Why this build exists

During v7 testing, a Jujutsu Kaisen S1E24 3.21 GB stream was still labelled English/Dual Audio even
though Stremio's actual MKV track selector showed only Japanese FLAC 2.0 and Portuguese PT-BR
E-AC-3 2.0. Debug logs showed that the visible top results included Torrentio/TorBox resolver routes,
while no authoritative-media log was attached to those resolver copies.

The v7 authoritative merge itself was correct. The remaining problem was coverage and provenance:
built-in native streams did not preserve a provider-authoritative marker through parsing, and verified
languages learned for one route did not flow to an equivalent resolver route before the language
filter ran again.

## Code changes

1. `packages/core/src/builtins/base/debrid.ts`
   - Marks built-in debrid streams as provider-authoritative only when actual provider/container audio
     languages are non-empty.

2. `packages/core/src/parser/streams.ts`
   - Preserves that media-info provenance marker when addon output becomes a `ParsedStream`.

3. `packages/core/src/main/serviceWrapper.ts`
   - Marks service-wrapped native debrid results as provider-authoritative only when actual audio
     languages are non-empty.

4. `packages/core/src/streams/filterer.ts`
   - Propagates verified audio languages across equivalent playback routes by exact `infoHash + fileIdx`.
   - Refuses propagation when provider-authoritative copies disagree on the non-empty language set.

   - Removes the compatibility exception that allowed bare `Dual Audio` / `Dubbed` to satisfy
     `Required Languages = English`.
   - Prefers exact `infoHash + fileIdx` identity when comparing duplicate anime playback routes.

5. `packages/server/src/routes/api/debrid.ts`
   - Adds safe info-level success diagnostics for external resolver playback requests and redirects.
   - Logs provider/attempt/final hostname only; it does not log signed URLs or credentials.

6. `V7_1_RESOLVER_LANGUAGE_PROPAGATION.md`
   - Documents behavior and regression validation.

7. `README.txt`
   - Adds a v7.1 continuation note.

## Preserved behavior

No v6/v7 features are intentionally removed. Keep:

- Addon Fetching Strategy = Default
- Torrentio timeout around 7000 ms
- addon-fetch retry policy
- preflight 6 / 3000 ms / concurrency 6 / inconclusive=keep
- native AIOStreams anime playback preference
- Torrentio/TorBox demotion behavior
- playback-time fresh debrid URL generation and retries
- episode-title mismatch protection
- Kitsu conventional/absolute bridge
- Trakt alias guard

Language UI remains:

```text
Required Languages: English
Preferred Languages: English, Dual Audio, Dubbed
Excluded Languages: none
Included Languages: none
```

## Local validation performed

- Compared the v7.1 working tree against the exact uploaded v7 baseline.
- Syntax-transpiled every changed TypeScript file with the locally available TypeScript compiler.
- Verified that no bare `Dual Audio` / `Dubbed` required-English bypass remains.
- Verified propagation uses exact hash + file index, not hash alone.
- Verified external resolver logs expose only final hostname, not the full URL.

Full dependency/type/Docker validation still belongs to GitHub Actions because this execution
environment cannot fetch/install the pnpm workspace dependencies.

## Deployment after GitHub Actions succeeds

Copy/extract the repository contents directly over the existing repo root and overwrite matching
files. Do **not** delete the repo first and do not create a nested repo folder.

Then:

```bash
cd /root/aiostreams
docker compose pull aiostreams
docker compose up -d --force-recreate aiostreams
docker compose ps
```

For the first JJK regression test, temporarily use `LOG_LEVEL=debug`, refresh S1E24, and inspect:

```bash
docker logs aiostreams --since 5m 2>&1 \
  | grep -Ei 'provider media-info|authoritative|propagated authoritative|External resolver playback|resolver preflight'
```

After testing, return `LOG_LEVEL` to `info`.
