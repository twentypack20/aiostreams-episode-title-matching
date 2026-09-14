# AIOStreams v7.2.2 — Episode-title fuzzy conflict fix

Baseline: exact v7.2.1 tree produced from the deployed v7.2 lineage.

## Why this build exists

v7.2.1 correctly re-enabled anime-only episode-title matching after v7.2 restored anime classification, but that exposed an older false-positive in the custom mismatch-only episode-title filter.

For Jujutsu Kaisen season 3, valid S03E10/S03E11 files were removed as if they matched the known special title `Jujutsu Kaisen 0`. The old conflict check rejected a stream whenever *any other* known episode/special title fuzzy-matched above the threshold. Because `Jujutsu Kaisen 0` shares the full series name with every normal episode, ordinary filenames such as `Jujutsu Kaisen S03E11...` can score above the 0.82 threshold even though they are not the movie/special.

Neighbouring titles such as `Tokyo Colony No. 1 - Part 4` and `Part 5` are also intentionally very similar, so a threshold-only conflict check is unsafe there too.

## Code change

Changed only:

- `packages/core/src/streams/filterer.ts`

The known-other-episode conflict check is now competitive instead of threshold-only:

1. Score the candidate against the **requested** episode title.
2. Score it against each **other** known episode title.
3. Reject for a different known title only when that other title is materially better than the requested title, or when the other title is literally present while the requested title is not.
4. A franchise-numbered special whose title is only `series title + number` (for example `Jujutsu Kaisen 0`) may no longer conflict from fuzzy franchise-name overlap alone. It must be literally present in the candidate.

This preserves actual `Jujutsu Kaisen 0` detection while preventing normal `Jujutsu Kaisen S03E..` releases from being removed just because they contain the franchise name.

## Preserved behavior

No v6/v7/v7.1/v7.2/v7.2.1 feature is intentionally removed. In particular this keeps:

- v7.2 AnimeAPI + metadata anime classification recovery
- v7.2.1 anime request-type matching fix
- v7.2.1 per-episode metadata lock isolation
- episode-title OVA/special/spin-off filename-first protections
- Kitsu conventional/absolute bridge
- authoritative provider/container language replacement + propagation
- required English / preferred English, Dual Audio, Dubbed behavior
- native anime playback preference and resolver demotion
- fresh debrid playback links and retries
- final resolver preflight
- Trakt alias guard
- Addon Fetching Strategy = Default behavior

## Regression cases

The intended behavior after this change is:

- Requested S3E11 Part 5 + filename containing Part 5: **keep**.
- Requested S3E11 Part 5 + filename containing Part 4: **reject as another episode title**.
- Requested S3E11 + generic filename `[Judas] JUJUTSU KAISEN - S03E11v2.mkv`: **do not reject as `Jujutsu Kaisen 0`**.
- Requested normal episode + actual file titled `Jujutsu Kaisen 0 ...`: **can still reject as the special/movie**.
- Existing OVA/special/spin-off checks remain active.

## Validation performed

- TypeScript syntax transpilation of the changed filterer: no diagnostics.
- Patch/overlay/full-tree equivalence checks.
- Synthetic fuzzy-score regression checks for:
  - correct `Part 5` versus neighbouring `Part 4`
  - wrong `Part 4` while requesting `Part 5`
  - generic S03E11 filename versus `Jujutsu Kaisen 0`
  - actual `Jujutsu Kaisen 0` filename

GitHub Actions remains the definitive full dependency/type/Docker build.

## Deployment

Copy the changed-files ZIP directly over the existing v7.2.1 repository root and overwrite matching files. Do **not** delete the repository first.

After GitHub Actions succeeds:

```bash
cd /root/aiostreams
docker compose pull aiostreams
docker compose up -d --force-recreate aiostreams
docker compose ps
```

For the first regression test, keep debug logging enabled and open S3E10/S3E11. The removal summary should no longer show normal S03E10/S03E11 files as `matched different episode title: Jujutsu Kaisen 0`.
