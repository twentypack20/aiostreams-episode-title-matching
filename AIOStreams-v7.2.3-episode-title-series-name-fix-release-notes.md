# AIOStreams v7.2.3 — Episode-title series-name conflict fix

Baseline: exact v7.2.2 tree produced from the deployed v7.2 lineage.

## Why this build exists

After v7.2.2 fixed the `Jujutsu Kaisen 0` fuzzy-title false positive, another metadata edge case appeared with **Combatants Will Be Dispatched! S1E2**.

The requested episode was correctly classified as anime and the candidate files had the correct `S01E02` identity and valid English/Japanese audio metadata. However, the episode-title conflict filter removed every otherwise-valid stream as:

`matched different episode title: Combatants Will Be Dispatched!`

That "different episode title" is also the **series title itself**. Some metadata sources expose a special/episode whose title is exactly the show title (or one of its aliases). Since the series title naturally appears in almost every normal release filename, it is not a discriminating signal for a conflicting episode.

## Code change

Changed only the episode-title conflict logic in:

- `packages/core/src/streams/filterer.ts`

Before scoring another known episode/special title as a conflict, v7.2.3 now checks whether that title normalises exactly to the requested series title or any known series alias. If it does, that title is ignored as a conflict signal.

This is intentionally conservative:

- `Combatants Will Be Dispatched! - S01E02.mkv` while requesting S1E2: **keep**; the shared series title is not a conflict.
- A known special whose title is exactly the series name: **do not reject from title text alone**; fail open and let season/episode markers and explicit OVA/special/movie signals decide.
- `Jujutsu Kaisen 0`: **still protected**; it is not equal to the series title and the v7.2.2 literal/competitive logic remains active.
- `Part 4` versus requested `Part 5`: **still protected** by the competitive other-title score.

## Preserved behavior

No v6/v7/v7.1/v7.2/v7.2.1/v7.2.2 feature is intentionally removed. This keeps:

- AnimeAPI + metadata anime classification recovery
- anime-only request-type matching
- per-episode metadata lock isolation
- episode-title OVA/special/spin-off filename-first protections
- `Jujutsu Kaisen 0` special detection and neighbouring `Part N` conflict handling
- Kitsu conventional/absolute bridge
- authoritative provider/container language replacement and propagation
- Required Languages = English / Preferred = English, Dual Audio, Dubbed
- native anime playback preference and resolver demotion
- fresh debrid playback links and retries
- final resolver preflight
- Trakt alias guard
- Addon Fetching Strategy = Default

## Regression cases

The intended behavior after this change is:

- Requested Combatants S1E2 + `Combatants Will Be Dispatched! - S01E02.mkv`: **keep**.
- Requested Combatants S1E2 + `[Starbez] Combatants Will Be Dispatched - S01E02 ...`: **keep**.
- Requested normal JJK episode + actual `Jujutsu Kaisen 0 ...` file: **can still reject as the special/movie**.
- Requested JJK Part 5 + file containing Part 4: **reject as another episode title**.
- Existing explicit OVA/special/movie checks remain active.

## Validation performed

- TypeScript syntax transpilation of the changed filterer: no diagnostics.
- `git diff --check` equivalent whitespace validation.
- Synthetic regression checks for:
  - exact series-title-as-episode-title false positive
  - series alias equality
  - `Jujutsu Kaisen 0` remaining distinct from `Jujutsu Kaisen`
  - Part 4 versus Part 5 remaining distinct
- Changed-files overlay verified byte-identical to the full v7.2.3 tree.

GitHub Actions remains the definitive full dependency/type/Docker build.

## Deployment

Copy the changed-files ZIP directly over the existing v7.2.2 repository root and overwrite matching files. Do **not** delete the repository first.

After GitHub Actions succeeds:

```bash
cd /root/aiostreams
docker compose pull aiostreams
docker compose up -d --force-recreate aiostreams
docker compose ps
```

For the first regression test, keep debug logging enabled and reopen **Combatants Will Be Dispatched! S1E2**. The removal summary should no longer show valid S01E02 files as `matched different episode title: Combatants Will Be Dispatched!`.
