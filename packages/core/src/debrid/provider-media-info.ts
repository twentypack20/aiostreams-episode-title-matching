import {
  BuiltinServiceId,
  Cache,
  ParsedMediaInfo,
  appConfig,
  createLogger,
  getSimpleTextHash,
  parseMediaInfo,
} from '../utils/index.js';
import { DebridFile } from './base.js';
import { fetch, type RequestInit } from 'undici';

const logger = createLogger('debrid:media-info');

const probeCache = Cache.getInstance<string, ParsedMediaInfo | null>(
  'provider-media-info',
  10_000
);

const parseIntegerEnv = (
  value: string | undefined,
  fallback: number,
  min: number,
  max: number
): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
};

const parseBooleanEnv = (
  value: string | undefined,
  fallback: boolean
): boolean => {
  if (value === undefined || value.trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
};

export const providerMediaInfoConfig = {
  enabled: parseBooleanEnv(process.env.PROVIDER_MEDIA_INFO_LOOKUP, true),
  limit: parseIntegerEnv(
    process.env.PROVIDER_MEDIA_INFO_LOOKUP_LIMIT,
    6,
    0,
    25
  ),
  timeoutMs: parseIntegerEnv(
    process.env.PROVIDER_MEDIA_INFO_TIMEOUT_MS,
    2500,
    500,
    10_000
  ),
  cacheTtlSeconds: parseIntegerEnv(
    process.env.PROVIDER_MEDIA_INFO_CACHE_TTL,
    86_400,
    60,
    604_800
  ),
};

const toNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

const valuesOfObject = (value: unknown): Record<string, unknown>[] => {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is Record<string, unknown> =>
        typeof item === 'object' && item !== null
    );
  }
  if (typeof value !== 'object' || value === null) return [];
  return Object.values(value).filter(
    (item): item is Record<string, unknown> =>
      typeof item === 'object' && item !== null
  );
};

const mediaInfoFromRealDebrid = (
  payload: unknown
): ParsedMediaInfo | undefined => {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const record = payload as Record<string, any>;
  const details =
    typeof record.details === 'object' && record.details !== null
      ? record.details
      : {};

  const audio = valuesOfObject(details.audio).map((track) => ({
    lang: track.lang_iso ?? track.lang,
    title: track.title,
    codec: track.codec,
    ch: toNumber(track.channels),
  }));
  const subtitle = valuesOfObject(details.subtitles).map((track) => ({
    lang: track.lang_iso ?? track.lang,
    title: track.title,
  }));
  const videoTrack = valuesOfObject(details.video)[0];
  const durationSeconds = toNumber(record.duration);
  const bitrate = toNumber(record.bitrate);

  return parseMediaInfo({
    video: videoTrack
      ? {
          codec: videoTrack.codec,
          w: toNumber(videoTrack.width),
          h: toNumber(videoTrack.height),
        }
      : undefined,
    audio,
    subtitle,
    format:
      durationSeconds || bitrate
        ? {
            n: String(record.filename ?? ''),
            dur: durationSeconds ? durationSeconds * 1_000_000 : 0,
            s: toNumber(record.size) ?? 0,
            br: bitrate ?? 0,
          }
        : undefined,
  });
};

const mediaInfoFromTorBox = (payload: unknown): ParsedMediaInfo | undefined => {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const root = payload as Record<string, any>;
  const data =
    typeof root.data === 'object' && root.data !== null ? root.data : root;
  const metadata =
    typeof data.metadata === 'object' && data.metadata !== null
      ? data.metadata
      : undefined;
  if (!metadata) return undefined;

  const audios = Array.isArray(metadata.audios) ? metadata.audios : [];
  const subtitles = Array.isArray(metadata.subtitles) ? metadata.subtitles : [];
  const video =
    typeof metadata.video === 'object' && metadata.video !== null
      ? metadata.video
      : undefined;

  const audio = audios.map((track: Record<string, any>) => ({
    lang:
      track.language ??
      track.language_code ??
      track.lang ??
      track.language_full,
    title: track.title ?? track.language_full,
    codec: track.codec,
    ch_layout: track.channel_layout,
    ch: toNumber(track.channels),
  }));
  const subtitle = subtitles.map((track: Record<string, any>) => ({
    lang:
      track.language ??
      track.language_code ??
      track.lang ??
      track.language_full,
    title: track.title ?? track.language_full,
  }));

  const durationSeconds = toNumber(video?.duration);
  const bitrate = toNumber(video?.bitrate);

  return parseMediaInfo({
    video: video
      ? {
          codec: video.codec,
          w: toNumber(video.width),
          h: toNumber(video.height),
        }
      : undefined,
    audio,
    subtitle,
    format:
      durationSeconds || bitrate
        ? {
            n: String(video?.file_name ?? data.name ?? ''),
            dur: durationSeconds ? durationSeconds * 1_000_000 : 0,
            s: toNumber(video?.size ?? data.size) ?? 0,
            br: bitrate ?? 0,
          }
        : undefined,
  });
};

const fetchJson = async (
  url: string,
  init: RequestInit,
  signal: AbortSignal
): Promise<unknown> => {
  const response = await fetch(url, { ...init, signal });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
};

export function canLookupProviderMediaInfo(options: {
  serviceId: BuiltinServiceId;
  downloadId?: string | number;
  file: DebridFile;
}): boolean {
  if (options.serviceId === 'realdebrid') {
    return typeof options.file.link === 'string' && options.file.link.length > 0;
  }

  if (options.serviceId === 'torbox') {
    const downloadId = Number(options.downloadId);
    const fileId = Number(options.file.id ?? options.file.index);
    return (
      Number.isFinite(downloadId) &&
      downloadId >= 0 &&
      Number.isFinite(fileId) &&
      fileId >= 0
    );
  }

  return false;
}

const lookupRealDebridMediaInfo = async (
  token: string,
  file: DebridFile,
  signal: AbortSignal
): Promise<ParsedMediaInfo | undefined> => {
  if (!file.link) return undefined;

  const body = new URLSearchParams({ link: file.link });
  const unrestricted = (await fetchJson(
    'https://api.real-debrid.com/rest/1.0/unrestrict/link',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': appConfig.http.defaultUserAgent,
      },
      body,
    },
    signal
  )) as Record<string, unknown>;

  const id = unrestricted.id;
  if (typeof id !== 'string' || !id) return undefined;

  const mediaInfo = await fetchJson(
    `https://api.real-debrid.com/rest/1.0/streaming/mediaInfos/${encodeURIComponent(id)}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': appConfig.http.defaultUserAgent,
      },
    },
    signal
  );

  return mediaInfoFromRealDebrid(mediaInfo);
};

const lookupTorBoxMediaInfo = async (
  token: string,
  downloadId: string | number | undefined,
  file: DebridFile,
  signal: AbortSignal
): Promise<ParsedMediaInfo | undefined> => {
  if (downloadId === undefined || downloadId === null) return undefined;
  const numericDownloadId = Number(downloadId);
  const fileId = file.id ?? file.index;
  if (!Number.isFinite(numericDownloadId) || numericDownloadId < 0) {
    return undefined;
  }
  if (fileId === undefined || !Number.isFinite(Number(fileId))) {
    return undefined;
  }

  const params = new URLSearchParams({
    id: String(numericDownloadId),
    file_id: String(fileId),
    type: 'torrent',
    chosen_audio_index: '0',
  });
  const payload = await fetchJson(
    `https://api.torbox.app/v1/api/stream/createstream?${params.toString()}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': appConfig.http.defaultUserAgent,
      },
    },
    signal
  );

  return mediaInfoFromTorBox(payload);
};

export async function lookupProviderMediaInfo(options: {
  serviceId: BuiltinServiceId;
  token: string;
  hash: string;
  downloadId?: string | number;
  file: DebridFile;
}): Promise<ParsedMediaInfo | undefined> {
  if (!providerMediaInfoConfig.enabled) return undefined;
  if (!canLookupProviderMediaInfo(options)) return undefined;

  const cacheKey = [
    options.serviceId,
    getSimpleTextHash(options.token),
    options.hash.toLowerCase(),
    String(options.file.id ?? options.file.index ?? options.file.name ?? ''),
  ].join(':');
  const cached = await probeCache.get(cacheKey);
  if (cached !== undefined) return cached ?? undefined;

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    providerMediaInfoConfig.timeoutMs
  );

  try {
    const mediaInfo =
      options.serviceId === 'realdebrid'
        ? await lookupRealDebridMediaInfo(
            options.token,
            options.file,
            controller.signal
          )
        : await lookupTorBoxMediaInfo(
            options.token,
            options.downloadId,
            options.file,
            controller.signal
          );

    await probeCache.set(
      cacheKey,
      mediaInfo ?? null,
      providerMediaInfoConfig.cacheTtlSeconds
    );

    if (mediaInfo?.languages?.length) {
      logger.debug('Provider media-info lookup found authoritative audio languages', {
        service: options.serviceId,
        languages: mediaInfo.languages,
        file: options.file.name,
      });
    }
    return mediaInfo;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const timedOut =
      error instanceof Error &&
      (error.name === 'AbortError' || /abort|timeout/i.test(message));
    logger.debug(
      'Provider media-info lookup unavailable; using release metadata fallback',
      {
        service: options.serviceId,
        file: options.file.name,
        reason: timedOut ? 'timeout' : message,
      }
    );
    await probeCache.set(
      cacheKey,
      null,
      Math.min(providerMediaInfoConfig.cacheTtlSeconds, 300)
    );
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}
