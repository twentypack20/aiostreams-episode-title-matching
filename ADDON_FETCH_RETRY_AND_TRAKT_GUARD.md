# AIOStreams — Initial Addon Fetch Retry + Trakt Alias Guard

This update is intended to sit on top of the existing Kitsu episode bridge, playback preflight, debrid-resolution retry, and external-resolver wrapper.

## Initial addon fetch retry

The earlier retry work covered playback/debrid resolution after streams had already been discovered. It could not recover when Torrentio itself returned a transient `502` while AIOStreams was fetching the initial stream list.

This patch retries that initial addon fetch when the failure is transient:

- HTTP 5xx: retry
- timeout: retry
- common network/connectivity errors: retry
- HTTP 429: off by default, opt-in
- other HTTP 4xx: do not retry
- parse/schema/invalid-response errors: do not retry
- unknown application errors: do not retry

Defaults are 2 retries after the initial attempt with 300 ms exponential backoff capped at 1500 ms.

Environment variables:

```text
ADDON_FETCH_RETRIES=2
ADDON_FETCH_RETRY_DELAY_MS=300
ADDON_FETCH_RETRY_MAX_DELAY_MS=1500
ADDON_FETCH_RETRY_ON_RATE_LIMIT=false
```

## Trakt alias guard

Trakt alias lookup requires AIOStreams' own server-side `TRAKT_CLIENT_ID`. A Stremio user's Trakt login/scrobbling session is separate.

When `TRAKT_CLIENT_ID` is not configured, this build skips alias requests instead of sending an empty API key and producing repeated `403 Forbidden` responses.

No configuration is required for the safe skip. To use aliases, configure a valid `TRAKT_CLIENT_ID`.
