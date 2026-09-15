# AIOStreams v7.2.5 - Clearer language removal diagnostics

Built directly from the exact v7.2.4 final-CDN diagnostic-probe full-source baseline.

## Purpose

v7.2.5 fixes a diagnostics/UI clarity problem discovered while checking **Mushoku Tensei: Jobless Reincarnation S3E11**.

A stream could appear under `Required Language` with a detail such as:

```text
English, Russian, Portuguese, Spanish, ...
```

while still being rejected for Required English. That looked contradictory even when the filtering decision was correct: those language names came from release/source parsing and could represent subtitle/source metadata rather than verified audio tracks.

The actual provider/container inspection for the same request correctly showed Japanese-only audio for several matched files, so the language policy itself did not need to be loosened.

## What changes

Language removal details now identify the evidence source.

When `mediaInfoSource === 'provider'`, removal details are shown as:

```text
Verified audio: Japanese
```

When language information comes from the filename/release parser, removal details are shown as:

```text
Parser/source languages: Japanese, Original
```

For the anime subtitle/source-language safeguard, the message is now explicit:

```text
Parser/source languages: English, Russian, Portuguese, ...
→ English audio unconfirmed; likely subtitle/source metadata
```

This wording is used by the same filter-statistics data that feeds the Stremio `Removal Reasons` entries and the debug filter summary.

## Filtering behavior is intentionally unchanged

v7.2.5 does **not** change which streams pass or fail language filtering.

In particular:

- Required Languages remains `English` in the user's intended configuration.
- Preferred Languages remains `English, Dual Audio, Dubbed`.
- Bare `Dual Audio` still does not manufacture an English audio track.
- Actual provider/container languages remain authoritative when available.
- Release/parser metadata remains fallback evidence only when authoritative track data is unavailable.
- A Japanese-original anime stream is still rejected when `English` appears only in unverified release/source metadata and there is no strong English-audio signal.
- Unknown/fail-open behavior outside the existing policy is unchanged.

## v7.2.4 CDN diagnostic probe

The v7.2.4 final-CDN diagnostic code is preserved unchanged so it can be temporarily re-enabled if intermittent playback hangs return.

The probe remains disabled by default. For normal operation, do not set:

```text
PLAYBACK_CDN_DIAGNOSTIC_PROBE
PLAYBACK_CDN_DIAGNOSTIC_TIMEOUT_MS
PLAYBACK_CDN_DIAGNOSTIC_DELAY_MS
```

The diagnostic environment variables are not needed unless actively troubleshooting playback.

## Files changed

- `packages/core/src/streams/filterer.ts`
- `README.txt`
- `AIOStreams-v7.2.5-language-removal-diagnostics-release-notes.md`

No server playback/debrid source is changed in v7.2.5.

## Validation targets

The intended removal-reason output includes these cases:

- authoritative Japanese-only provider metadata -> `Verified audio: Japanese`
- parser-only Japanese/Original -> `Parser/source languages: Japanese, Original`
- parser/source languages containing English without strong English-audio evidence -> `Parser/source languages: ... — English audio unconfirmed; likely subtitle/source metadata`

The stream keep/reject result for each case must remain identical to v7.2.4.
