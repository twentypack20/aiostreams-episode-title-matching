# AIOStreams v7.2.4 - Final CDN diagnostic probe

Built directly from the exact v7.2.3 full-source baseline.

## Purpose

This is a diagnostic-only follow-up for intermittent TV/Stremio playback hangs where AIOStreams successfully resolves a stream and returns a 307 redirect, but the player remains stuck loading after handoff to the debrid CDN.

The observed failure path was:

- client requested a valid stream;
- AIOStreams received the request normally;
- TorBox resolved the playback URL on attempt 1;
- AIOStreams returned a 307 within a few hundred milliseconds;
- playback still remained stuck on the TV.

That means the missing visibility is what happens to the final CDN URL after resolution.

## New diagnostic probe

`packages/server/src/routes/api/debrid.ts` adds an optional final-CDN probe.

Enable with:

```yaml
environment:
  PLAYBACK_CDN_DIAGNOSTIC_PROBE: "true"
  PLAYBACK_CDN_DIAGNOSTIC_TIMEOUT_MS: "5000"
  PLAYBACK_CDN_DIAGNOSTIC_DELAY_MS: "1500"
```

Defaults:

- `PLAYBACK_CDN_DIAGNOSTIC_PROBE=false`
- `PLAYBACK_CDN_DIAGNOSTIC_TIMEOUT_MS=5000`
- `PLAYBACK_CDN_DIAGNOSTIC_DELAY_MS=1500`

When enabled, after a fresh final playback URL is resolved for a real client request, AIOStreams waits the configured diagnostic delay and sends a tiny GET with:

```text
Range: bytes=0-1
Accept-Encoding: identity
```

The response body is cancelled immediately after headers are received.

The probe does **not** block the 307 redirect returned to Stremio.

## What is logged

Successful probes log only safe diagnostic fields:

- provider
- playback route (`external-resolver` or `native-debrid`)
- final CDN hostname
- response hostname after redirects
- HTTP status
- whether the response was successful
- whether HTTP 206 Partial Content was returned
- milliseconds until response headers arrived
- configured timeout
- content type
- content length, when present
- content range, when present
- accept-ranges header, when present

Failed probes log:

- provider
- route
- final CDN hostname
- elapsed time
- timeout
- safe error name/code

The signed playback URL, query string, access token, and credentials are never logged.

## Preflight protection

External resolver preflight requests already identify themselves with:

```text
User-Agent: AIOStreams resolver preflight
```

v7.2.4 deliberately skips the CDN diagnostic probe for those requests so normal stream-list preflight does not generate a batch of CDN probes. The probe is intended to represent actual client playback clicks.

Native AIOStreams playback preflight is already skipped by the existing v7 behavior, so native diagnostic probes represent real playback resolve requests.

## Important interpretation note

The diagnostic probe originates from the VPS, not the TV. A 2xx/206 result is strong evidence that the exact final CDN object was reachable from the VPS at that moment. A 401/403 result is less conclusive because some debrid/CDN links may be client-IP-sensitive.

## Preserved behavior

No v7.2.3 filtering, language, metadata, anime classification, playback preference, retry, or preflight behavior is intentionally changed. The diagnostic probe is disabled by default.

## Validation

- TypeScript syntax/transpile check passed with zero diagnostics.
- Probe is fire-and-forget and does not delay the client 307 redirect.
- Signed URLs are never included in probe logs.
- External resolver preflight requests are excluded.
- Both external resolver playback and native debrid playback are covered.
