import { Router, Request, Response, NextFunction } from 'express';
import {
  APIError,
  constants,
  createLogger,
  formatZodError,
  DebridError,
  DebridFailureCache,
  PlaybackInfoSchema,
  getDebridService,
  ServiceAuthSchema,
  fromUrlSafeBase64,
  Cache,
  PlaybackInfo,
  ServiceAuth,
  decryptString,
  metadataStore,
  fileInfoStore,
  TitleMetadata,
  FileInfoSchema,
  getSimpleTextHash,
  FileInfo,
  maskSensitiveInfo,
  getNzbFallbacks,
  isNzbRetryableError,
  DistributedLock,
  type NzbFallback,
  isSupportedExternalResolverUrl,
  isKnownExternalResolverHopUrl,
  getExternalResolverProvider,
} from '@aiostreams/core';
import { z, ZodError } from 'zod';
import { StaticFiles } from '../../app.js';
import { corsMiddleware } from '../../middlewares/cors.js';
const router: Router = Router();
const logger = createLogger('server');

type ResolveRetryDecision = {
  retry: boolean;
  reason: string;
  retryAfterMs?: number;
};

const parseIntegerEnv = (
  value: string | undefined,
  fallback: number,
  min: number,
  max: number
): number => {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
};

const parseBooleanEnv = (
  value: string | undefined,
  fallback: boolean
): boolean => {
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
};

const resolveRetryConfig = {
  retries: parseIntegerEnv(process.env.DEBRID_RESOLVE_RETRIES, 2, 0, 5),
  delayMs: parseIntegerEnv(
    process.env.DEBRID_RESOLVE_RETRY_DELAY_MS,
    750,
    100,
    30_000
  ),
  maxDelayMs: parseIntegerEnv(
    process.env.DEBRID_RESOLVE_RETRY_MAX_DELAY_MS,
    4_000,
    100,
    30_000
  ),
  retryRateLimits: parseBooleanEnv(
    process.env.DEBRID_RESOLVE_RETRY_ON_RATE_LIMIT,
    false
  ),
  retryUnknownErrors: parseBooleanEnv(
    process.env.DEBRID_RESOLVE_RETRY_UNKNOWN_ERRORS,
    true
  ),
};

const playbackFreshLinkConfig = {
  // Debrid CDN links can be temporary or client-IP-sensitive.  Generate a fresh
  // final link for real playback requests by default instead of reusing an
  // hour-old cached redirect. Retries always force-refresh regardless.
  forceFresh: parseBooleanEnv(
    process.env.PLAYBACK_FORCE_FRESH_DEBRID_LINK,
    true
  ),
};

const playbackCdnDiagnosticConfig = {
  // Disabled by default. When enabled, real client playback resolves trigger a
  // tiny delayed Range probe against the final CDN URL. The signed URL itself
  // is never logged, and external-resolver preflight requests are excluded.
  enabled: parseBooleanEnv(
    process.env.PLAYBACK_CDN_DIAGNOSTIC_PROBE,
    false
  ),
  timeoutMs: parseIntegerEnv(
    process.env.PLAYBACK_CDN_DIAGNOSTIC_TIMEOUT_MS,
    5_000,
    500,
    30_000
  ),
  delayMs: parseIntegerEnv(
    process.env.PLAYBACK_CDN_DIAGNOSTIC_DELAY_MS,
    1_500,
    0,
    10_000
  ),
};

const permanentResolveErrorCodes = new Set<DebridError['code']>([
  'BAD_REQUEST',
  'CONFLICT',
  'FORBIDDEN',
  'GONE',
  'METHOD_NOT_ALLOWED',
  'NOT_FOUND',
  'NOT_IMPLEMENTED',
  'PAYMENT_REQUIRED',
  'PROXY_AUTHENTICATION_REQUIRED',
  'STORE_LIMIT_EXCEEDED',
  'STORE_MAGNET_INVALID',
  'UNAUTHORIZED',
  'UNAVAILABLE_FOR_LEGAL_REASONS',
  'UNPROCESSABLE_ENTITY',
  'UNSUPPORTED_MEDIA_TYPE',
  'NO_MATCHING_FILE',
]);

const transientResolveErrorCodes = new Set<DebridError['code']>([
  'BAD_GATEWAY',
  'INTERNAL_SERVER_ERROR',
  'SERVICE_UNAVAILABLE',
]);

const transientNetworkErrorCodes = new Set([
  'ABORT_ERR',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const getHeader = (
  headers: Record<string, string> | undefined,
  name: string
): string | undefined => {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === target
  );
  return entry?.[1];
};

const parseRetryAfterMs = (error: unknown): number | undefined => {
  if (!(error instanceof DebridError)) return undefined;
  const value = getHeader(error.headers, 'retry-after');
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.floor(seconds * 1000);
  }

  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) return undefined;
  return Math.max(0, retryAt - Date.now());
};

const findErrorCode = (error: unknown): string | undefined => {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (typeof record.code === 'string') return record.code.toUpperCase();
    current = record.cause;
  }

  return undefined;
};

const getErrorStatusCode = (error: unknown): number | undefined => {
  if (!error || typeof error !== 'object') return undefined;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === 'number' ? statusCode : undefined;
};

const isCacheAndPlayDownloadTimeout = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return (
    getErrorStatusCode(error) === 408 &&
    /timed out waiting for magnet to download/i.test(message)
  );
};

const isCacheAndPlayDownloadInProgress = (error: unknown): boolean =>
  error instanceof DebridError && error.code === 'DOWNLOAD_IN_PROGRESS';

const classifyResolveError = (error: unknown): ResolveRetryDecision => {
  if (isCacheAndPlayDownloadInProgress(error)) {
    return {
      retry: false,
      reason: 'cache-and-play download is in progress',
    };
  }

  if (isCacheAndPlayDownloadTimeout(error)) {
    return {
      retry: false,
      reason: 'cache-and-play download wait timed out',
    };
  }

  if (error instanceof DebridError) {
    if (error.code === 'TOO_MANY_REQUESTS') {
      return {
        retry: resolveRetryConfig.retryRateLimits,
        reason: resolveRetryConfig.retryRateLimits
          ? 'debrid rate limit (opt-in retry)'
          : 'debrid rate limit',
        retryAfterMs: parseRetryAfterMs(error),
      };
    }

    if (permanentResolveErrorCodes.has(error.code)) {
      return {
        retry: false,
        reason: `permanent debrid error: ${error.code ?? 'UNKNOWN'}`,
      };
    }

    if (transientResolveErrorCodes.has(error.code)) {
      return {
        retry: true,
        reason: `transient debrid error: ${error.code}`,
        retryAfterMs: parseRetryAfterMs(error),
      };
    }

    if (
      error.statusCode === 408 ||
      error.statusCode === 425 ||
      error.statusCode === 500 ||
      error.statusCode === 502 ||
      error.statusCode === 503 ||
      error.statusCode === 504
    ) {
      return {
        retry: true,
        reason: `transient HTTP ${error.statusCode}`,
        retryAfterMs: parseRetryAfterMs(error),
      };
    }

    if (error.statusCode >= 400 && error.statusCode < 500) {
      return {
        retry: false,
        reason: `non-retryable HTTP ${error.statusCode}`,
      };
    }

    if (error.code === 'UNKNOWN' && resolveRetryConfig.retryUnknownErrors) {
      return { retry: true, reason: 'unknown debrid resolve error' };
    }

    return { retry: false, reason: 'non-retryable debrid resolve error' };
  }

  const code = findErrorCode(error);
  if (code && transientNetworkErrorCodes.has(code)) {
    return { retry: true, reason: `transient network error: ${code}` };
  }

  const name =
    error && typeof error === 'object' && 'name' in error
      ? String((error as { name?: unknown }).name ?? '')
      : '';
  if (name === 'AbortError' || name === 'TimeoutError') {
    return { retry: true, reason: name };
  }

  if (resolveRetryConfig.retryUnknownErrors) {
    return { retry: true, reason: 'unknown resolve exception' };
  }

  return { retry: false, reason: 'unknown resolve exception' };
};

const getResolveRetryDelayMs = (
  retryNumber: number,
  retryAfterMs?: number
): number => {
  const exponentialDelay =
    resolveRetryConfig.delayMs * Math.pow(2, Math.max(0, retryNumber - 1));
  return Math.min(
    resolveRetryConfig.maxDelayMs,
    Math.max(exponentialDelay, retryAfterMs ?? 0)
  );
};

const ExternalResolverPayloadSchema = z.object({
  version: z.literal(1),
  url: z.string().url(),
  expiresAt: z.number().int().positive(),
  expectedFileSize: z.number().int().positive().optional(),
});

type ExternalResolverPayload = {
  version: 1;
  url: string;
  expiresAt: number;
  expectedFileSize?: number;
};

class ExternalResolverError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly statusCode?: number,
    public readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = 'ExternalResolverError';
  }
}

const externalResolverConfig = {
  timeoutMs: parseIntegerEnv(
    process.env.EXTERNAL_RESOLVER_TIMEOUT_MS,
    10_000,
    1_000,
    60_000
  ),
  maxHops: parseIntegerEnv(
    process.env.EXTERNAL_RESOLVER_MAX_HOPS,
    5,
    1,
    10
  ),
  fallbackToOriginal: parseBooleanEnv(
    process.env.EXTERNAL_RESOLVER_FALLBACK_TO_ORIGINAL,
    true
  ),
  probeBytes: parseIntegerEnv(
    process.env.EXTERNAL_RESOLVER_PROBE_BYTES ??
      process.env.EXTERNAL_RESOLVER_MIN_MEDIA_BYTES,
    64 * 1024,
    4 * 1024,
    256 * 1024
  ),
  sizeTolerancePercent: parseIntegerEnv(
    process.env.EXTERNAL_RESOLVER_SIZE_TOLERANCE_PERCENT,
    25,
    0,
    100
  ),
};

const parseResponseRetryAfterMs = (
  response: Awaited<ReturnType<typeof fetch>>
): number | undefined => {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.floor(seconds * 1000);
  }
  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt)
    ? Math.max(0, retryAt - Date.now())
    : undefined;
};

const cancelFetchBody = async (
  response: Awaited<ReturnType<typeof fetch>>
): Promise<void> => {
  try {
    await response.body?.cancel();
  } catch {}
};

type PlaybackCdnDiagnosticRoute = 'external-resolver' | 'native-debrid';

const getSafeFetchErrorCode = (error: unknown): string | undefined => {
  if (!error || typeof error !== 'object') return undefined;

  const directCode = (error as { code?: unknown }).code;
  if (typeof directCode === 'string' || typeof directCode === 'number') {
    return String(directCode);
  }

  const cause = (error as { cause?: unknown }).cause;
  if (!cause || typeof cause !== 'object') return undefined;
  const causeCode = (cause as { code?: unknown }).code;
  if (typeof causeCode === 'string' || typeof causeCode === 'number') {
    return String(causeCode);
  }

  return undefined;
};

const probePlaybackCdnUrl = async (
  finalUrl: string,
  provider: string,
  route: PlaybackCdnDiagnosticRoute
): Promise<void> => {
  if (!playbackCdnDiagnosticConfig.enabled) return;

  if (playbackCdnDiagnosticConfig.delayMs > 0) {
    await sleep(playbackCdnDiagnosticConfig.delayMs);
  }

  let finalHost = 'unknown';
  try {
    finalHost = new URL(finalUrl).host;
  } catch {}

  const controller = new AbortController();
  const startedAt = Date.now();
  const timeout = setTimeout(
    () => controller.abort(),
    playbackCdnDiagnosticConfig.timeoutMs
  );

  try {
    const response = await fetch(finalUrl, {
      method: 'GET',
      headers: {
        Range: 'bytes=0-1',
        'Accept-Encoding': 'identity',
        'User-Agent': 'AIOStreams CDN diagnostic probe',
      },
      redirect: 'follow',
      signal: controller.signal,
    });

    const headersMs = Date.now() - startedAt;
    let responseHost = finalHost;
    try {
      responseHost = new URL(response.url).host;
    } catch {}

    const status = response.status;
    const contentType = response.headers.get('content-type') ?? undefined;
    const contentLength = response.headers.get('content-length') ?? undefined;
    const contentRange = response.headers.get('content-range') ?? undefined;
    const acceptRanges = response.headers.get('accept-ranges') ?? undefined;

    await cancelFetchBody(response);

    logger.info('Playback CDN diagnostic probe completed', {
      provider,
      route,
      finalHost,
      responseHost,
      status,
      ok: response.ok,
      partialContent: status === 206,
      headersMs,
      timeoutMs: playbackCdnDiagnosticConfig.timeoutMs,
      contentType,
      contentLength,
      contentRange,
      acceptRanges,
    });
  } catch (error) {
    logger.warn('Playback CDN diagnostic probe failed', {
      provider,
      route,
      finalHost,
      elapsedMs: Date.now() - startedAt,
      timeoutMs: playbackCdnDiagnosticConfig.timeoutMs,
      errorName: error instanceof Error ? error.name : typeof error,
      errorCode: getSafeFetchErrorCode(error),
    });
  } finally {
    clearTimeout(timeout);
  }
};

const readFetchBodyPrefix = async (
  response: Awaited<ReturnType<typeof fetch>>,
  maxBytes: number = 1
): Promise<Uint8Array> => {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      const remaining = maxBytes - total;
      const chunk = value.length > remaining ? value.slice(0, remaining) : value;
      chunks.push(chunk);
      total += chunk.length;
      if (value.length > remaining) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {}
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return combined;
};

const startsWithMediaBytes = (
  bytes: Uint8Array,
  signature: number[],
  offset: number = 0
): boolean =>
  bytes.length >= offset + signature.length &&
  signature.every((value, index) => bytes[offset + index] === value);

const detectExternalResolverMediaSignature = (
  bytes: Uint8Array,
  contentType: string
): string | undefined => {
  if (bytes.length === 0) return undefined;

  const decode = () =>
    new TextDecoder('utf-8', { fatal: false }).decode(bytes).trim();

  if (/application\/(?:vnd\.apple\.mpegurl|x-mpegurl)/.test(contentType)) {
    return /^#EXTM3U/i.test(decode()) ? 'hls-playlist' : undefined;
  }
  if (contentType.includes('dash+xml')) {
    return /<MPD(?:\s|>)/i.test(decode()) ? 'dash-manifest' : undefined;
  }
  if (startsWithMediaBytes(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    return 'matroska/webm';
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp'
  ) {
    return 'mp4/quicktime';
  }
  if (
    startsWithMediaBytes(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'AVI '
  ) {
    return 'avi';
  }
  if (startsWithMediaBytes(bytes, [0x4f, 0x67, 0x67, 0x53])) return 'ogg';
  if (startsWithMediaBytes(bytes, [0x46, 0x4c, 0x56])) return 'flv';
  if (
    startsWithMediaBytes(bytes, [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11])
  ) {
    return 'asf/wmv';
  }
  if (startsWithMediaBytes(bytes, [0x49, 0x44, 0x33])) return 'mp3-id3';
  if (
    bytes.length >= 2 &&
    bytes[0] === 0xff &&
    (bytes[1] & 0xe0) === 0xe0
  ) {
    return 'mpeg-audio/aac';
  }
  if (
    bytes.length >= 377 &&
    bytes[0] === 0x47 &&
    bytes[188] === 0x47 &&
    bytes[376] === 0x47
  ) {
    return 'mpeg-ts';
  }
  if (
    startsWithMediaBytes(bytes, [0x00, 0x00, 0x01, 0xba]) ||
    startsWithMediaBytes(bytes, [0x00, 0x00, 0x01, 0xb3]) ||
    startsWithMediaBytes(bytes, [0x00, 0x00, 0x00, 0x01]) ||
    startsWithMediaBytes(bytes, [0x00, 0x00, 0x01])
  ) {
    return 'mpeg/annex-b';
  }
  return undefined;
};

const externalResolverPrefixLooksTextual = (bytes: Uint8Array): boolean => {
  const sample = bytes.slice(0, Math.min(bytes.length, 1024));
  if (sample.length === 0) return false;
  let printable = 0;
  for (const byte of sample) {
    if (
      byte === 0x09 ||
      byte === 0x0a ||
      byte === 0x0d ||
      (byte >= 0x20 && byte <= 0x7e)
    ) {
      printable++;
    }
  }
  return printable / sample.length >= 0.85;
};

type ParsedContentRange = {
  start: number;
  end: number;
  total?: number;
};

const parseContentRangeHeader = (
  value: string | null
): ParsedContentRange | undefined => {
  if (!value) return undefined;
  const match = value.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === '*' ? undefined : Number(match[3]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return undefined;
  }
  return {
    start,
    end,
    total: Number.isFinite(total) && total! > 0 ? total : undefined,
  };
};

const parsePositiveHeaderNumber = (value: string | null): number | undefined => {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

const externalResolverSizesAreClose = (
  expected: number,
  reported: number
): boolean => {
  if (expected <= 0 || reported <= 0) return true;
  return (
    Math.abs(reported - expected) / expected <=
    externalResolverConfig.sizeTolerancePercent / 100
  );
};

const getExternalResolverSecondProbeStart = (
  reportedFileSize?: number,
  expectedFileSize?: number
): number => {
  const basis = reportedFileSize ?? expectedFileSize;
  if (!basis || !Number.isFinite(basis) || basis <= 0) {
    return 1024 * 1024;
  }

  const quarter = Math.floor(basis * 0.25);
  const minimum = externalResolverConfig.probeBytes * 2;
  const maximum = Math.max(0, basis - externalResolverConfig.probeBytes - 1);
  return Math.min(Math.max(quarter, minimum), maximum);
};

const readFetchBodySnippet = async (
  response: Awaited<ReturnType<typeof fetch>>,
  maxBytes: number = 64 * 1024
): Promise<string> => {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      const remaining = maxBytes - total;
      const chunk = value.length > remaining ? value.slice(0, remaining) : value;
      chunks.push(chunk);
      total += chunk.length;
      if (value.length > remaining) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {}
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(combined).trim();
};

const findNestedResolverUrl = (
  value: unknown,
  depth: number = 0
): string | undefined => {
  if (depth > 5 || value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim().replace(/^['"]|['"]$/g, '');
    return /^https?:\/\/\S+$/i.test(trimmed) ? trimmed : undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNestedResolverUrl(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    for (const key of ['download', 'url', 'stream', 'location']) {
      if (!(key in object)) continue;
      const found = findNestedResolverUrl(object[key], depth + 1);
      if (found) return found;
    }
    for (const [key, nested] of Object.entries(object)) {
      if (['download', 'url', 'stream', 'location'].includes(key)) continue;
      const found = findNestedResolverUrl(nested, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
};

const getExternalResolverJsonError = (value: unknown): string | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  if (object.success === false) {
    return String(object.message ?? object.error ?? 'resolver reported success=false');
  }
  for (const key of ['error', 'errors']) {
    const error = object[key];
    if (
      error !== undefined &&
      error !== null &&
      error !== false &&
      error !== '' &&
      !(Array.isArray(error) && error.length === 0)
    ) {
      return typeof error === 'string' ? error : JSON.stringify(error);
    }
  }
  return undefined;
};

const resolverErrorBodyPattern =
  /unavailable for legal reasons|legal reasons|try a different file|not available|unavailable|file not found|torrent not found|no (?:stream|link|file)s? found|invalid (?:torrent|magnet|link|file)|forbidden|access denied|permission denied|blocked|expired|not cached|uncached|resolver (?:error|failed)|playback (?:error|failed)|failed to (?:resolve|fetch|play)|could not (?:resolve|fetch|play)/i;

const parseHttpTarget = (value: string, base: string): string => {
  let target: URL;
  try {
    target = new URL(value, base);
  } catch {
    throw new ExternalResolverError(
      'External resolver returned an invalid URL',
      false
    );
  }
  if (!['http:', 'https:'].includes(target.protocol)) {
    throw new ExternalResolverError(
      'External resolver returned an unsupported URL protocol',
      false
    );
  }
  return target.toString();
};

const resolveExternalResolverChain = async (
  sourceUrl: string,
  signal: AbortSignal,
  clientIp?: string,
  expectedFileSize?: number
): Promise<string> => {
  let currentUrl = sourceUrl;

  for (let hop = 0; hop <= externalResolverConfig.maxHops; hop++) {
    const response = await fetch(currentUrl, {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: {
        Accept:
          'video/*, audio/*, application/octet-stream, application/json, text/plain, */*;q=0.5',
        'User-Agent': 'AIOStreams external resolver playback',
        ...(isKnownExternalResolverHopUrl(currentUrl)
          ? { Range: `bytes=0-${externalResolverConfig.probeBytes - 1}` }
          : {}),
        ...(clientIp
          ? {
              'X-Forwarded-For': clientIp,
              'X-Real-IP': clientIp,
            }
          : {}),
      },
    });

    const status = response.status;
    const contentType =
      response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';

    if (status >= 300 && status < 400) {
      const location = response.headers.get('location');
      await cancelFetchBody(response);
      if (!location) {
        throw new ExternalResolverError(
          `External resolver returned HTTP ${status} without Location`,
          true,
          status
        );
      }
      const targetUrl = parseHttpTarget(location, currentUrl);
      if (isKnownExternalResolverHopUrl(targetUrl)) {
        currentUrl = targetUrl;
        continue;
      }
      return targetUrl;
    }

    if ([408, 425, 500, 502, 503, 504].includes(status)) {
      const retryAfterMs = parseResponseRetryAfterMs(response);
      await cancelFetchBody(response);
      throw new ExternalResolverError(
        `External resolver returned transient HTTP ${status}`,
        true,
        status,
        retryAfterMs
      );
    }

    if (status === 429) {
      const retryAfterMs = parseResponseRetryAfterMs(response);
      await cancelFetchBody(response);
      throw new ExternalResolverError(
        'External resolver was rate limited',
        resolveRetryConfig.retryRateLimits,
        status,
        retryAfterMs
      );
    }

    if (status >= 400) {
      const body = await readFetchBodySnippet(response, 8 * 1024);
      throw new ExternalResolverError(
        `External resolver returned HTTP ${status}${body ? `: ${body.slice(0, 180)}` : ''}`,
        false,
        status
      );
    }

    if (status === 204) {
      await cancelFetchBody(response);
      throw new ExternalResolverError(
        'External resolver returned an empty response',
        true,
        status
      );
    }

    if (
      /^(video|audio)\//.test(contentType) ||
      /application\/(?:octet-stream|x-matroska|mp4|vnd\.apple\.mpegurl|x-mpegurl|dash\+xml)/.test(
        contentType
      )
    ) {
      if (isKnownExternalResolverHopUrl(currentUrl)) {
        try {
          const firstRange = parseContentRangeHeader(
            response.headers.get('content-range')
          );
          const firstContentLength = parsePositiveHeaderNumber(
            response.headers.get('content-length')
          );
          const reportedFileSize =
            firstRange?.total ?? (status === 200 ? firstContentLength : undefined);

          const bytes = await readFetchBodyPrefix(
            response,
            externalResolverConfig.probeBytes
          );
          const mediaSignature = detectExternalResolverMediaSignature(
            bytes,
            contentType
          );
          const manifestResponse =
            mediaSignature === 'hls-playlist' ||
            mediaSignature === 'dash-manifest';

          if (externalResolverPrefixLooksTextual(bytes)) {
            const text = new TextDecoder('utf-8', { fatal: false })
              .decode(bytes)
              .trim();
            if (resolverErrorBodyPattern.test(text)) {
              throw new ExternalResolverError(
                'External resolver returned an error body with media headers',
                false,
                502
              );
            }
          }

          if (
            !manifestResponse &&
            bytes.length < externalResolverConfig.probeBytes
          ) {
            throw new ExternalResolverError(
              `External resolver produced only ${bytes.length} of ${externalResolverConfig.probeBytes} required media bytes`,
              false,
              504
            );
          }

          if (!mediaSignature) {
            throw new ExternalResolverError(
              'External resolver media prefix did not match a known media/container signature',
              false,
              502
            );
          }

          if (
            !manifestResponse &&
            expectedFileSize !== undefined &&
            reportedFileSize !== undefined &&
            !externalResolverSizesAreClose(expectedFileSize, reportedFileSize)
          ) {
            throw new ExternalResolverError(
              `External resolver media size ${reportedFileSize} does not match expected file size ${expectedFileSize}`,
              false,
              502
            );
          }

          let probe2Start: number | undefined;
          let probe2BytesLength: number | undefined;

          if (!manifestResponse) {
            probe2Start = getExternalResolverSecondProbeStart(
              reportedFileSize,
              expectedFileSize
            );
            if (probe2Start <= 0) {
              throw new ExternalResolverError(
                'External resolver media object is too small for a second Range probe',
                false,
                502
              );
            }

            const probe2End =
              probe2Start + externalResolverConfig.probeBytes - 1;
            const probe2Response = await fetch(currentUrl, {
              method: 'GET',
              redirect: 'manual',
              signal,
              headers: {
                Accept:
                  'video/*, audio/*, application/octet-stream, */*;q=0.5',
                'User-Agent': 'AIOStreams external resolver playback',
                Range: `bytes=${probe2Start}-${probe2End}`,
                ...(clientIp
                  ? {
                      'X-Forwarded-For': clientIp,
                      'X-Real-IP': clientIp,
                    }
                  : {}),
              },
            });

            const probe2Range = parseContentRangeHeader(
              probe2Response.headers.get('content-range')
            );
            const probe2ContentType =
              probe2Response.headers
                .get('content-type')
                ?.split(';')[0]
                .trim()
                .toLowerCase() ?? '';

            if (
              probe2Response.status !== 206 ||
              !probe2Range ||
              probe2Range.start !== probe2Start
            ) {
              await cancelFetchBody(probe2Response);
              throw new ExternalResolverError(
                `External resolver did not honor second Range probe at byte ${probe2Start}`,
                false,
                502
              );
            }

            if (
              !/^(video|audio)\//.test(probe2ContentType) &&
              !/application\/(?:octet-stream|x-matroska|mp4)/.test(
                probe2ContentType
              )
            ) {
              await cancelFetchBody(probe2Response);
              throw new ExternalResolverError(
                `External resolver second Range probe returned ${probe2ContentType || 'unknown content type'}`,
                false,
                502
              );
            }

            const probe2Bytes = await readFetchBodyPrefix(
              probe2Response,
              externalResolverConfig.probeBytes
            );
            probe2BytesLength = probe2Bytes.length;

            if (probe2Bytes.length < externalResolverConfig.probeBytes) {
              throw new ExternalResolverError(
                `External resolver second Range probe produced only ${probe2Bytes.length} of ${externalResolverConfig.probeBytes} required bytes`,
                false,
                504
              );
            }

            if (externalResolverPrefixLooksTextual(probe2Bytes)) {
              const text = new TextDecoder('utf-8', { fatal: false })
                .decode(probe2Bytes)
                .trim();
              if (resolverErrorBodyPattern.test(text)) {
                throw new ExternalResolverError(
                  'External resolver second Range probe returned an error body',
                  false,
                  502
                );
              }
            }

            if (
              reportedFileSize !== undefined &&
              probe2Range.total !== undefined &&
              reportedFileSize !== probe2Range.total
            ) {
              throw new ExternalResolverError(
                'External resolver reported inconsistent media size across Range probes',
                false,
                502
              );
            }
          }

          logger.debug('External resolver media validation passed', {
            host: (() => {
              try {
                return new URL(currentUrl).host;
              } catch {
                return 'unknown';
              }
            })(),
            expectedFileSize,
            reportedFileSize,
            probe1Bytes: bytes.length,
            signature: mediaSignature,
            probe2Start,
            probe2Bytes: probe2BytesLength,
          });
        } catch (error) {
          if (error instanceof ExternalResolverError) throw error;
          const message =
            error instanceof Error ? error.message : String(error ?? 'unknown error');
          if (
            error instanceof Error &&
            (error.name === 'AbortError' || /aborted|timeout/i.test(message))
          ) {
            throw new ExternalResolverError(
              `External resolver media validation timed out after requiring two ${externalResolverConfig.probeBytes}-byte probes`,
              false,
              504
            );
          }
          throw error;
        }
        return currentUrl;
      }

      await cancelFetchBody(response);
      return currentUrl;
    }

    if (
      contentType.includes('text/') ||
      contentType.includes('json') ||
      contentType.includes('html') ||
      contentType.includes('problem+json') ||
      contentType === ''
    ) {
      const body = await readFetchBodySnippet(response);
      let parsedJson: unknown;
      if (contentType.includes('json') || /^[\[{]/.test(body)) {
        try {
          parsedJson = JSON.parse(body);
        } catch {}
      }
      if (parsedJson !== undefined) {
        const jsonError = getExternalResolverJsonError(parsedJson);
        if (jsonError) {
          throw new ExternalResolverError(
            `External resolver error: ${jsonError.slice(0, 180)}`,
            false,
            status
          );
        }
        const nested = findNestedResolverUrl(parsedJson);
        if (nested) {
          const targetUrl = parseHttpTarget(nested, currentUrl);
          if (isKnownExternalResolverHopUrl(targetUrl)) {
            currentUrl = targetUrl;
            continue;
          }
          return targetUrl;
        }
      }
      const plainUrl = /^https?:\/\/\S+$/i.test(body) ? body : undefined;
      if (plainUrl) {
        const targetUrl = parseHttpTarget(plainUrl, currentUrl);
        if (isKnownExternalResolverHopUrl(targetUrl)) {
          currentUrl = targetUrl;
          continue;
        }
        return targetUrl;
      }
      if (resolverErrorBodyPattern.test(body)) {
        throw new ExternalResolverError(
          `External resolver returned an error response: ${body.slice(0, 180)}`,
          false,
          status
        );
      }
      throw new ExternalResolverError(
        `External resolver returned unexpected ${contentType || 'text'} content`,
        true,
        status
      );
    }

    await cancelFetchBody(response);
    return currentUrl;
  }

  throw new ExternalResolverError(
    'External resolver returned too many resolver hops',
    false
  );
};

const classifyExternalResolverException = (
  error: unknown
): ResolveRetryDecision => {
  if (error instanceof ExternalResolverError) {
    return {
      retry: error.retryable,
      reason: error.message,
      retryAfterMs: error.retryAfterMs,
    };
  }
  const code = findErrorCode(error);
  if (code && transientNetworkErrorCodes.has(code)) {
    return { retry: true, reason: `transient network error: ${code}` };
  }
  const name =
    error && typeof error === 'object' && 'name' in error
      ? String((error as { name?: unknown }).name ?? '')
      : '';
  if (name === 'AbortError' || name === 'TimeoutError') {
    return { retry: true, reason: name };
  }
  return {
    retry: resolveRetryConfig.retryUnknownErrors,
    reason: 'unknown external resolver error',
  };
};

router.use(corsMiddleware);

// block HEAD requests
router.use((req: Request, res: Response, next: NextFunction) => {
  if (req.method === 'HEAD') {
    res.status(405).send('Method not allowed');
  } else {
    next();
  }
});

interface ExternalResolverParams {
  encryptedResolver: string;
  filename: string;
}

router.get(
  '/external-resolver/:encryptedResolver/:filename',
  async (
    req: Request<ExternalResolverParams>,
    res: Response,
    next: NextFunction
  ) => {
    let payload: ExternalResolverPayload | undefined;
    let lastError: unknown;
    let lastDecision: ResolveRetryDecision | undefined;

    try {
      const decrypted = decryptString(req.params.encryptedResolver);
      if (!decrypted.success) {
        throw new APIError(
          constants.ErrorCode.BAD_REQUEST,
          undefined,
          'Failed to decrypt external resolver URL'
        );
      }

      try {
        payload = ExternalResolverPayloadSchema.parse(
          JSON.parse(decrypted.data)
        ) as ExternalResolverPayload;
      } catch (error) {
        throw new APIError(
          constants.ErrorCode.BAD_REQUEST,
          undefined,
          error instanceof ZodError
            ? formatZodError(error)
            : 'Failed to parse external resolver payload'
        );
      }

      if (payload.expiresAt < Date.now()) {
        throw new APIError(
          constants.ErrorCode.BAD_REQUEST,
          undefined,
          'External resolver playback link has expired'
        );
      }

      if (!isSupportedExternalResolverUrl(payload.url)) {
        throw new APIError(
          constants.ErrorCode.BAD_REQUEST,
          undefined,
          'Unsupported external resolver URL'
        );
      }

      const provider = getExternalResolverProvider(payload.url) ?? 'unknown';
      const totalAttempts = resolveRetryConfig.retries + 1;

      logger.info('External resolver playback request received', {
        provider,
        totalAttempts,
        clientIpPresent: Boolean(req.userIp),
      });

      for (let attempt = 1; attempt <= totalAttempts; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          externalResolverConfig.timeoutMs
        );

        try {
          const finalUrl = await resolveExternalResolverChain(
            payload.url,
            controller.signal,
            req.userIp,
            payload.expectedFileSize
          );
          clearTimeout(timeout);

          let finalHost = 'unknown';
          try {
            finalHost = new URL(finalUrl).host;
          } catch {}

          logger.info('External resolver playback URL resolved', {
            provider,
            attempt,
            totalAttempts,
            finalHost,
          });

          const isResolverPreflight =
            req.get('user-agent') === 'AIOStreams resolver preflight';
          if (!isResolverPreflight) {
            void probePlaybackCdnUrl(
              finalUrl,
              provider,
              'external-resolver'
            );
          }

          if (attempt > 1) {
            logger.info('External resolver retry succeeded', {
              provider,
              attempt,
              totalAttempts,
            });
          }

          res.redirect(307, finalUrl);
          return;
        } catch (error) {
          clearTimeout(timeout);
          lastError = error;
          lastDecision = classifyExternalResolverException(error);
          const isLastAttempt = attempt >= totalAttempts;

          if (!lastDecision.retry || isLastAttempt || req.destroyed) {
            break;
          }

          const delayMs = getResolveRetryDelayMs(
            attempt,
            lastDecision.retryAfterMs
          );
          logger.warn('External resolver failed temporarily; retrying', {
            provider,
            attempt,
            nextAttempt: attempt + 1,
            totalAttempts,
            delayMs,
            reason: lastDecision.reason,
          });
          await sleep(delayMs);
        }
      }

      logger.warn('External resolver retries exhausted', {
        provider,
        attempts: resolveRetryConfig.retries + 1,
        reason: lastDecision?.reason,
        message:
          lastError instanceof Error ? lastError.message : String(lastError),
      });

      // A final client-side attempt is useful when the server/VPS route had a
      // transient DNS, TLS, or CDN problem that may not affect the Stremio
      // device. Permanent resolver failures still use an AIOStreams error clip.
      if (
        lastDecision?.retry &&
        externalResolverConfig.fallbackToOriginal
      ) {
        res.redirect(307, payload.url);
        return;
      }

      let staticFile: string = StaticFiles.INTERNAL_SERVER_ERROR;
      const statusCode =
        lastError instanceof ExternalResolverError
          ? lastError.statusCode
          : undefined;
      if (statusCode === 401) staticFile = StaticFiles.UNAUTHORIZED;
      else if (statusCode === 403) staticFile = StaticFiles.FORBIDDEN;
      else if (statusCode === 429) staticFile = StaticFiles.TOO_MANY_REQUESTS;
      else if (statusCode === 451) {
        staticFile = StaticFiles.UNAVAILABLE_FOR_LEGAL_REASONS;
      } else if (statusCode === 502 || statusCode === 504) {
        staticFile = StaticFiles.DOWNLOAD_FAILED;
      }

      res.redirect(307, `/static/${staticFile}`);
    } catch (error) {
      if (error instanceof APIError || error instanceof ZodError) {
        next(error);
        return;
      }
      logger.error(
        { err: error },
        `got unexpected error during external resolver playback: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      next(
        new APIError(
          constants.ErrorCode.INTERNAL_SERVER_ERROR,
          undefined,
          error instanceof Error ? error.message : String(error)
        )
      );
    }
  }
);

interface PlaybackParams {
  encryptedStoreAuth: string;
  fileInfo: string;
  metadataId: string;
  filename: string;
}

router.get(
  '/playback/:encryptedStoreAuth/:fileInfo/:metadataId/:filename',
  async (req: Request<PlaybackParams>, res: Response, next: NextFunction) => {
    try {
      const {
        encryptedStoreAuth,
        fileInfo: encodedFileInfo,
        metadataId,
        filename,
      } = req.params;

      let fileInfo: FileInfo | undefined;

      try {
        fileInfo = FileInfoSchema.parse(
          JSON.parse(fromUrlSafeBase64(encodedFileInfo))
        );
      } catch (error: any) {
        fileInfo = await fileInfoStore()?.get(encodedFileInfo);
        if (!fileInfo) {
          logger.warn(`Could not get file info`, {
            fileInfo: encodedFileInfo,
            error,
            fileInfoStoreAvailable: fileInfoStore() ? true : false,
          });
          next(
            new APIError(
              constants.ErrorCode.BAD_REQUEST,
              undefined,
              'Failed to parse file info and not found in store.'
            )
          );
          return;
        }
      }

      const decryptedStoreAuth = decryptString(encryptedStoreAuth);
      if (!decryptedStoreAuth.success) {
        throw new APIError(
          constants.ErrorCode.BAD_REQUEST,
          undefined,
          'Failed to decrypt store auth'
        );
      }

      let storeAuth: ServiceAuth;
      try {
        storeAuth = ServiceAuthSchema.parse(
          JSON.parse(decryptedStoreAuth.data)
        );
      } catch (error: any) {
        logger.warn(`Could not parse decrypted store auth`, {
          decryptedStoreAuth: maskSensitiveInfo(decryptedStoreAuth.data),
          error,
        });
        throw new APIError(
          constants.ErrorCode.BAD_REQUEST,
          undefined,
          'Failed to parse store auth'
        );
      }

      const metadata: TitleMetadata | undefined =
        await metadataStore().get(metadataId);
      if (!metadata && !fileInfo.serviceItemId) {
        throw new APIError(
          constants.ErrorCode.BAD_REQUEST,
          undefined,
          'Metadata not found'
        );
      }

      logger.verbose(`Got metadata: ${JSON.stringify(metadata)}`);

      const playbackInfo: PlaybackInfo =
        fileInfo.type === 'torrent'
          ? {
              type: 'torrent',
              metadata: metadata,
              title: fileInfo.title,
              downloadUrl: fileInfo.downloadUrl,
              hash: fileInfo.hash,
              private: fileInfo.private,
              sources: fileInfo.sources,
              index: fileInfo.index,
              filename: filename,
              fileIndex: fileInfo.fileIndex,
              serviceItemId: fileInfo.serviceItemId,
            }
          : {
              type: 'usenet',
              metadata: metadata,
              title: fileInfo.title,
              hash: fileInfo.hash,
              nzb: fileInfo.nzb,
              easynewsUrl: fileInfo.easynewsUrl,
              index: fileInfo.index,
              filename: filename,
              fileIndex: fileInfo.fileIndex,
              serviceItemId: fileInfo.serviceItemId,
            };

      const debridInterface = getDebridService(
        storeAuth.id,
        storeAuth.credential,
        req.userIp
      );

      logger.info('Playback resolve request received', {
        provider: storeAuth.id,
        playbackType: playbackInfo.type,
        hashPrefix: fileInfo.hash?.slice(0, 10),
        fileIndex: fileInfo.fileIndex,
        clientIpPresent: Boolean(req.userIp),
        forceFresh: playbackFreshLinkConfig.forceFresh,
      });

      const resolveWithRetry = async (
        currentPlaybackInfo: PlaybackInfo,
        currentFilename: string
      ): Promise<string | undefined> => {
        const totalAttempts = resolveRetryConfig.retries + 1;

        for (let attempt = 1; attempt <= totalAttempts; attempt++) {
          try {
            const forceRefresh =
              playbackFreshLinkConfig.forceFresh || attempt > 1;
            const result = await debridInterface.resolve(
              currentPlaybackInfo,
              currentFilename,
              fileInfo.cacheAndPlay ?? false,
              fileInfo.autoRemoveDownloads,
              { forceRefresh }
            );

            if (result) {
              let finalHost = 'unknown';
              try {
                finalHost = new URL(result).host;
              } catch {}
              logger.info('Debrid playback URL resolved', {
                provider: storeAuth.id,
                attempt,
                totalAttempts,
                forceRefresh,
                finalHost,
                playbackType: currentPlaybackInfo.type,
              });

              void probePlaybackCdnUrl(
                result,
                storeAuth.id,
                'native-debrid'
              );
            }

            if (attempt > 1) {
              logger.info(
                result
                  ? `[${storeAuth.id}] Debrid resolve retry succeeded`
                  : `[${storeAuth.id}] Debrid resolve retry completed without a playback URL`,
                {
                  attempt,
                  totalAttempts,
                  playbackType: currentPlaybackInfo.type,
                }
              );
            }

            return result;
          } catch (error: unknown) {
            const decision = classifyResolveError(error);
            const isLastAttempt = attempt >= totalAttempts;

            if (!decision.retry || isLastAttempt || req.destroyed) {
              if (attempt > 1 && isLastAttempt) {
                logger.warn(
                  `[${storeAuth.id}] Debrid resolve retries exhausted`,
                  {
                    attempts: attempt,
                    playbackType: currentPlaybackInfo.type,
                    reason: decision.reason,
                    code:
                      error instanceof DebridError
                        ? error.code
                        : findErrorCode(error),
                    statusCode:
                      error instanceof DebridError
                        ? error.statusCode
                        : undefined,
                    message:
                      error instanceof Error
                        ? error.message
                        : String(error),
                  }
                );
              }
              throw error;
            }

            const retryNumber = attempt;
            const delayMs = getResolveRetryDelayMs(
              retryNumber,
              decision.retryAfterMs
            );

            logger.warn(
              `[${storeAuth.id}] Debrid resolve failed temporarily; retrying`,
              {
                attempt,
                nextAttempt: attempt + 1,
                totalAttempts,
                delayMs,
                playbackType: currentPlaybackInfo.type,
                reason: decision.reason,
                code:
                  error instanceof DebridError
                    ? error.code
                    : findErrorCode(error),
                statusCode:
                  error instanceof DebridError ? error.statusCode : undefined,
                message:
                  error instanceof Error ? error.message : String(error),
              }
            );

            await sleep(delayMs);
          }
        }

        return undefined;
      };

      const fbk = req.query.fbk as string | undefined;
      const nzbFallbacks: NzbFallback[] = fbk ? await getNzbFallbacks(fbk) : [];

      logger.debug(`Attempting debrid resolve`, {
        storeAuthId: storeAuth.id,
        fallbacks: nzbFallbacks.length,
      });

      const attempts: Array<NzbFallback | null> = [null, ...nzbFallbacks];
      const isUsenetFailover =
        fileInfo.type === 'usenet' && nzbFallbacks.length > 0;

      const outerLockKey = `nzb-failover:${storeAuth.id}:${fileInfo.hash ?? metadataId}:${filename}:${req.userIp}:${getSimpleTextHash(storeAuth.credential)}`;

      let encounteredRetryableFailure = false;

      const runFailoverChain = async (): Promise<string | undefined> => {
        for (let i = 0; i < attempts.length; i++) {
          const attempt = attempts[i];
          const isLastAttempt = i === attempts.length - 1;

          const currentPlaybackInfo: PlaybackInfo =
            attempt !== null
              ? {
                  ...(playbackInfo as PlaybackInfo & { type: 'usenet' }),
                  nzb: attempt.nzbUrl,
                  hash: attempt.hash,
                  serviceItemId: undefined,
                  fileIndex: undefined,
                  ...(attempt.filename !== undefined && {
                    filename: attempt.filename,
                    title: attempt.filename,
                  }),
                }
              : playbackInfo;

          const currentFilename = attempt?.filename ?? filename;

          try {
            const url = await resolveWithRetry(
              currentPlaybackInfo,
              currentFilename
            );
            if (attempt !== null) {
              logger.info(
                `[${storeAuth.id}] NZB failover succeeded with fallback NZB`,
                {
                  attemptIndex: i,
                  fallbackNzb: attempt.nzbUrl.substring(0, 80),
                }
              );
            }
            return url;
          } catch (error: any) {
            const isRetryable = isNzbRetryableError(error);

            if (!isRetryable || isLastAttempt) {
              throw error;
            }

            encounteredRetryableFailure = true;
            logger.warn(
              `[${storeAuth.id}] NZB resolve failed, trying ${
                attempt === null
                  ? `first fallback (1 of ${nzbFallbacks.length})`
                  : `next fallback (${i + 1} of ${nzbFallbacks.length})`
              }`,
              { code: error?.code, message: error.message }
            );
          }
        }
        return undefined;
      };

      let streamUrl: string | undefined;
      let resolveError: Error | undefined;
      try {
        if (isUsenetFailover) {
          const { result } = await DistributedLock.getInstance().withLock(
            outerLockKey,
            runFailoverChain,
            { timeout: 180_000, ttl: 185_000 }
          );
          streamUrl = result;
        } else {
          streamUrl = await resolveWithRetry(playbackInfo, filename);
        }
      } catch (err: any) {
        resolveError = err;
      }

      if (encounteredRetryableFailure) {
        debridInterface.refreshLibraryCache?.(['nzb']).catch((err) => {
          logger.warn(
            `[${storeAuth.id}] Failed to refresh library cache after NZB failover failures`,
            { error: err?.message }
          );
        });
      }

      if (resolveError) {
        const cacheAndPlayDownloadState =
          isCacheAndPlayDownloadInProgress(resolveError) ||
          isCacheAndPlayDownloadTimeout(resolveError);
        let staticFile: string = cacheAndPlayDownloadState
          ? StaticFiles.DOWNLOADING
          : StaticFiles.INTERNAL_SERVER_ERROR;
        if (resolveError instanceof DebridError) {
          logger.error(
            {
              service: storeAuth.id,
              err: resolveError,
            },
            `error during debrid resolve: ${resolveError.message}`
          );

          if (
            fileInfo.type === 'torrent' &&
            fileInfo.hash &&
            (resolveError.code === 'UNAVAILABLE_FOR_LEGAL_REASONS' ||
              resolveError.statusCode === 451)
          ) {
            await DebridFailureCache.mark(
              storeAuth.id,
              'torrent',
              fileInfo.hash,
              resolveError
            ).catch((error) => {
              logger.warn('Failed to cache legal-unavailable torrent result', {
                provider: storeAuth.id,
                hashPrefix: fileInfo.hash.slice(0, 10),
                error: error instanceof Error ? error.message : String(error),
              });
            });
          }

          switch (resolveError.code) {
            case 'DOWNLOAD_IN_PROGRESS':
              staticFile = StaticFiles.DOWNLOADING;
              break;
            case 'UNAVAILABLE_FOR_LEGAL_REASONS':
              staticFile = StaticFiles.UNAVAILABLE_FOR_LEGAL_REASONS;
              break;
            case 'STORE_LIMIT_EXCEEDED':
              staticFile = StaticFiles.STORE_LIMIT_EXCEEDED;
              break;
            case 'PAYMENT_REQUIRED':
              staticFile = StaticFiles.PAYMENT_REQUIRED;
              break;
            case 'TOO_MANY_REQUESTS':
              staticFile = StaticFiles.TOO_MANY_REQUESTS;
              break;
            case 'FORBIDDEN':
              staticFile = StaticFiles.FORBIDDEN;
              break;
            case 'UNAUTHORIZED':
              staticFile = StaticFiles.UNAUTHORIZED;
              break;
            case 'UNPROCESSABLE_ENTITY':
            case 'UNSUPPORTED_MEDIA_TYPE':
            case 'STORE_MAGNET_INVALID':
              staticFile = StaticFiles.DOWNLOAD_FAILED;
              break;
            case 'NO_MATCHING_FILE':
              staticFile = StaticFiles.NO_MATCHING_FILE;
              break;
            default:
              break;
          }
        } else {
          logger.error(
            { service: storeAuth.id, err: resolveError },
            `got unknown error during debrid resolve: ${resolveError.message}`
          );
        }

        res.redirect(307, `/static/${staticFile}`);
        return;
      }

      if (!streamUrl) {
        res.redirect(307, `/static/${StaticFiles.DOWNLOADING}`);
        return;
      }

      res.redirect(307, streamUrl);
    } catch (error: any) {
      if (error instanceof APIError || error instanceof ZodError) {
        next(error);
      } else {
        logger.error(
          { err: error },
          `got unexpected error during debrid resolve: ${error.message}`
        );
        next(
          new APIError(
            constants.ErrorCode.INTERNAL_SERVER_ERROR,
            undefined,
            error.message
          )
        );
      }
    }
  }
);

export default router;
