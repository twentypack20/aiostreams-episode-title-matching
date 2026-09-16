import { ParsedStream, UserData } from '../db/schemas.js';
import {
  createLogger,
  RegexAccess,
  getTimeTakenSincePoint,
  formatMilliseconds,
  constants,
  compileRegex,
  formRegexFromKeywords,
  isKnownExternalResolverHopUrl,
  parseMediaInfo,
} from '../utils/index.js';
import { LANGUAGES, StreamType } from '../utils/constants.js';
import {
  StreamSelector,
  extractNamesFromExpression,
} from '../parser/streamExpression.js';
import StreamUtils, {
  getTrustedSelectedFileSize,
  shouldPassthroughStage,
} from './utils.js';
import {
  normaliseTitle,
  preprocessTitle,
  titleMatchWithLang,
} from '../parser/utils.js';
import { partial_ratio } from 'fuzzball';
import { formatBitrate, formatBytes } from '../formatters/utils.js';
import { iso6391ToLanguage } from '../utils/languages.js';
import { ReleaseDate } from '../metadata/tmdb.js';
import { StreamContext, ExtendedMetadata } from './context.js';
import {
  DebridFailureCache,
  getDebridService,
  isTorrentDebridService,
  providerMediaInfoConfig,
} from '../debrid/index.js';

const logger = createLogger('filterer');

type ResolverPreflightCacheEntry = {
  expiresAt: number;
  mediaBytes?: number;
  mediaSignature?: string;
  reportedFileSize?: number;
  probe2Start?: number;
  probe2Bytes?: number;
};

// Successful external resolver validation can be moderately expensive because
// v7.2.8 uses two small Range probes. Cache only successful validations; failed
// or inconclusive checks should be re-evaluated on the next request.
const resolverPreflightSuccessCache = new Map<
  string,
  ResolverPreflightCacheEntry
>();
const RESOLVER_PREFLIGHT_SUCCESS_CACHE_TTL_MS = 10 * 60 * 1000;

interface Reason {
  total: number;
  details: Record<string, number>;
}

export interface FilterStatistics {
  removed: {
    titleMatching: Reason;
    yearMatching: Reason;
    seasonEpisodeMatching: Reason;
    episodeTitleMatching: Reason;
    excludeSeasonPacks: Reason;
    noDigitalRelease: Reason;
    excludedStreamType: Reason;
    requiredStreamType: Reason;
    excludedResolution: Reason;
    requiredResolution: Reason;
    excludedQuality: Reason;
    requiredQuality: Reason;
    excludedEncode: Reason;
    requiredEncode: Reason;
    excludedVisualTag: Reason;
    requiredVisualTag: Reason;
    excludedAudioTag: Reason;
    requiredAudioTag: Reason;
    excludedAudioChannel: Reason;
    requiredAudioChannel: Reason;
    excludedLanguage: Reason;
    requiredLanguage: Reason;
    excludedSubtitle: Reason;
    requiredSubtitle: Reason;
    excludedReleaseGroup: Reason;
    requiredReleaseGroup: Reason;
    excludedCached: Reason;
    excludedUncached: Reason;
    excludedRegex: Reason;
    requiredRegex: Reason;
    excludedKeywords: Reason;
    requiredKeywords: Reason;
    excludedSeederRange: Reason;
    requiredSeederRange: Reason;
    excludedAgeRange: Reason;
    requiredAgeRange: Reason;
    excludedFilterCondition: Reason;
    requiredFilterCondition: Reason;
    size: Reason;
    bitrate: Reason;
  };
  included: {
    passthrough: Reason;
    resolution: Reason;
    quality: Reason;
    encode: Reason;
    visualTag: Reason;
    audioTag: Reason;
    audioChannel: Reason;
    language: Reason;
    subtitle: Reason;
    streamType: Reason;
    releaseGroup: Reason;
    size: Reason;
    seeder: Reason;
    age: Reason;
    regex: Reason;
    keywords: Reason;
    streamExpression: Reason;
  };
}

export interface PhaseTimingStats {
  /** Total ms spent in this phase across all streams and all filter() calls */
  totalMs: number;
  /** Maximum ms for any single stream evaluation */
  maxMs: number;
  /** Minimum ms for any single stream evaluation */
  minMs: number;
  /** Number of per-stream evaluations tracked */
  count: number;
}

export interface FilterTimings {
  /** Total wall-clock ms spent inside all filter() calls for this request */
  totalMs: number;
  /** Ms spent awaiting metadata (context.getMetadata, getReleaseDates, etc.) */
  metadataMs: number;
  /** Ms spent evaluating includedStreamExpressions */
  expressionMs: number;
  /** Ms spent compiling regex / keyword patterns */
  regexCompileMs: number;
  /** Ms spent sequentially pre-computing per-stream regex/keyword decisions before the filter
   *  pass. Pre-computed sequentially (not inside Promise.all) so this value is accurate. */
  regexTestMs: number;
  /** Ms spent in the core per-stream shouldKeepStream filter pass */
  filterPassMs: number;
  /** Number of filter() calls accumulated */
  calls: number;
  /** Per-stream phase timings from the shouldKeepStream pass, accumulated across all filter() calls */
  phases: {
    titleMatch: PhaseTimingStats;
    yearMatch: PhaseTimingStats;
    seasonEpisodeMatch: PhaseTimingStats;
    episodeTitleMatch: PhaseTimingStats;
  };
}

class StreamFilterer {
  private userData: UserData;
  private filterStatistics: FilterStatistics;
  private filterTimings: FilterTimings;

  constructor(userData: UserData) {
    this.userData = userData;
    this.filterStatistics = {
      removed: {
        titleMatching: { total: 0, details: {} },
        yearMatching: { total: 0, details: {} },
        seasonEpisodeMatching: { total: 0, details: {} },
        episodeTitleMatching: { total: 0, details: {} },
        excludeSeasonPacks: { total: 0, details: {} },
        noDigitalRelease: { total: 0, details: {} },
        excludedStreamType: { total: 0, details: {} },
        requiredStreamType: { total: 0, details: {} },
        excludedResolution: { total: 0, details: {} },
        requiredResolution: { total: 0, details: {} },
        excludedQuality: { total: 0, details: {} },
        requiredQuality: { total: 0, details: {} },
        excludedEncode: { total: 0, details: {} },
        requiredEncode: { total: 0, details: {} },
        excludedVisualTag: { total: 0, details: {} },
        requiredVisualTag: { total: 0, details: {} },
        excludedAudioTag: { total: 0, details: {} },
        requiredAudioTag: { total: 0, details: {} },
        excludedAudioChannel: { total: 0, details: {} },
        requiredAudioChannel: { total: 0, details: {} },
        excludedLanguage: { total: 0, details: {} },
        requiredLanguage: { total: 0, details: {} },
        excludedSubtitle: { total: 0, details: {} },
        requiredSubtitle: { total: 0, details: {} },
        excludedReleaseGroup: { total: 0, details: {} },
        requiredReleaseGroup: { total: 0, details: {} },
        excludedCached: { total: 0, details: {} },
        excludedUncached: { total: 0, details: {} },
        excludedRegex: { total: 0, details: {} },
        requiredRegex: { total: 0, details: {} },
        excludedKeywords: { total: 0, details: {} },
        requiredKeywords: { total: 0, details: {} },
        excludedSeederRange: { total: 0, details: {} },
        requiredSeederRange: { total: 0, details: {} },
        excludedAgeRange: { total: 0, details: {} },
        requiredAgeRange: { total: 0, details: {} },
        excludedFilterCondition: { total: 0, details: {} },
        requiredFilterCondition: { total: 0, details: {} },
        size: { total: 0, details: {} },
        bitrate: { total: 0, details: {} },
      },
      included: {
        passthrough: { total: 0, details: {} },
        resolution: { total: 0, details: {} },
        quality: { total: 0, details: {} },
        encode: { total: 0, details: {} },
        visualTag: { total: 0, details: {} },
        audioTag: { total: 0, details: {} },
        audioChannel: { total: 0, details: {} },
        language: { total: 0, details: {} },
        subtitle: { total: 0, details: {} },
        streamType: { total: 0, details: {} },
        releaseGroup: { total: 0, details: {} },
        size: { total: 0, details: {} },
        seeder: { total: 0, details: {} },
        age: { total: 0, details: {} },
        regex: { total: 0, details: {} },
        keywords: { total: 0, details: {} },
        streamExpression: { total: 0, details: {} },
      },
    };
    this.filterTimings = {
      totalMs: 0,
      metadataMs: 0,
      expressionMs: 0,
      regexCompileMs: 0,
      regexTestMs: 0,
      filterPassMs: 0,
      calls: 0,
      phases: {
        titleMatch: { totalMs: 0, maxMs: 0, minMs: Infinity, count: 0 },
        yearMatch: { totalMs: 0, maxMs: 0, minMs: Infinity, count: 0 },
        seasonEpisodeMatch: { totalMs: 0, maxMs: 0, minMs: Infinity, count: 0 },
        episodeTitleMatch: { totalMs: 0, maxMs: 0, minMs: Infinity, count: 0 },
      },
    };
  }

  private incrementRemovalReason(
    reason: keyof FilterStatistics['removed'],
    detail?: string
  ) {
    this.filterStatistics.removed[reason].total++;
    if (detail) {
      this.filterStatistics.removed[reason].details[detail] =
        (this.filterStatistics.removed[reason].details[detail] || 0) + 1;
    }
  }

  private incrementIncludedReason(
    reason: keyof FilterStatistics['included'],
    detail?: string
  ) {
    this.filterStatistics.included[reason].total++;
    if (detail) {
      this.filterStatistics.included[reason].details[detail] =
        (this.filterStatistics.included[reason].details[detail] || 0) + 1;
    }
  }

  public getFilterStatistics() {
    return this.filterStatistics;
  }

  public getFilterTimings(): FilterTimings {
    return {
      ...this.filterTimings,
      phases: {
        titleMatch: { ...this.filterTimings.phases.titleMatch },
        yearMatch: { ...this.filterTimings.phases.yearMatch },
        seasonEpisodeMatch: { ...this.filterTimings.phases.seasonEpisodeMatch },
        episodeTitleMatch: { ...this.filterTimings.phases.episodeTitleMatch },
      },
    };
  }

  public resetFilterTimings(): void {
    this.filterTimings = {
      totalMs: 0,
      metadataMs: 0,
      expressionMs: 0,
      regexCompileMs: 0,
      regexTestMs: 0,
      filterPassMs: 0,
      calls: 0,
      phases: {
        titleMatch: { totalMs: 0, maxMs: 0, minMs: Infinity, count: 0 },
        yearMatch: { totalMs: 0, maxMs: 0, minMs: Infinity, count: 0 },
        seasonEpisodeMatch: { totalMs: 0, maxMs: 0, minMs: Infinity, count: 0 },
        episodeTitleMatch: { totalMs: 0, maxMs: 0, minMs: Infinity, count: 0 },
      },
    };
  }

  public generateFilterSummary(
    streams: ParsedStream[],
    finalStreams: ParsedStream[],
    type: string,
    id: string
  ): void {
    const totalFiltered = streams.length - finalStreams.length;
    const summary = [
      '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `  🔍 Filter Summary for ${id} (${type})`,
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `  📊 Total Streams : ${streams.length}`,
      `  ✔️ Kept         : ${finalStreams.length}`,
      `  ❌ Filtered     : ${totalFiltered}`,
    ];

    // Add filter details if any streams were filtered
    const { filterDetails, includedDetails } = this.getFormattedFilterDetails();

    if (filterDetails.length > 0) {
      summary.push('\n  🔎 Filter Details:');
      summary.push(...filterDetails);
    }
    if (includedDetails.length > 0) {
      summary.push('\n  🔎 Included Details:');
      summary.push(...includedDetails);
    }
    summary.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.debug(summary.join('\n'));
  }

  public getFormattedFilterDetails(): {
    filterDetails: string[];
    includedDetails: string[];
  } {
    const filterDetails: string[] = [];
    for (const [reason, stats] of Object.entries(
      this.filterStatistics.removed
    )) {
      if (stats.total > 0) {
        // Convert camelCase to Title Case with spaces
        const formattedReason = reason
          .replace(/([A-Z])/g, ' $1')
          .replace(/^./, (str) => str.toUpperCase());

        filterDetails.push(`\n  📌 ${formattedReason} (${stats.total})`);
        for (const [detail, count] of Object.entries(stats.details)) {
          filterDetails.push(`    • ${count}× ${detail}`);
        }
      }
    }

    const includedDetails: string[] = [];
    for (const [reason, stats] of Object.entries(
      this.filterStatistics.included
    )) {
      if (stats.total > 0) {
        const formattedReason = reason
          .replace(/([A-Z])/g, ' $1')
          .replace(/^./, (str) => str.toUpperCase());
        includedDetails.push(`\n  📌 ${formattedReason} (${stats.total})`);
        for (const [detail, count] of Object.entries(stats.details)) {
          includedDetails.push(`    • ${count}× ${detail}`);
        }
      }
    }

    return { filterDetails, includedDetails };
  }

  public async filter(
    streams: ParsedStream[],
    context: StreamContext
  ): Promise<ParsedStream[]> {
    // Defensive: callers outside StreamFetcher may invoke filter() directly.
    // Ensure late metadata-based anime promotion is visible before capturing
    // the request classification in local variables.
    await context.ensureAnimeClassification();
    const { type: requestType, id, parsedId, isAnime } = context;
    const type = context.contentType;
    if (requestType !== type) {
      logger.debug(
        { id, requestType, contentType: type, isAnime },
        'using semantic series type for episodic stream filtering'
      );
    }
    const episodeTitleDebug = process.env.EPISODE_TITLE_DEBUG === 'true';
    const boolEnv = (value: string | undefined): boolean =>
      /^(1|true|yes|on)$/i.test(value ?? '');
    const allowForeignOriginalUnknownLanguageFallback = boolEnv(
      process.env.ALLOW_FOREIGN_ORIGINAL_UNKNOWN_LANGUAGE_FALLBACK
    );
    const legacyDisableTorboxForAnime = boolEnv(process.env.DISABLE_TORBOX_FOR_ANIME);
    const torboxAnimeMode = (
      process.env.TORBOX_ANIME_MODE ||
      (legacyDisableTorboxForAnime ? 'block' : 'allow')
    ).toLowerCase();
    const preferAIOStreamsPlaybackForAnime = boolEnv(
      process.env.PREFER_AIOSTREAMS_PLAYBACK_FOR_ANIME
    );
    const torrentioAnimeResolveMode = (
      process.env.TORRENTIO_ANIME_RESOLVE_MODE || 'allow'
    ).toLowerCase();

    // Custom safeguard for uncached debrid results. The limit is applied only
    // when we can trust `stream.size` as the selected file/episode size; an
    // unknown whole-season-pack size must not hide a small episode inside it.
    // Cached/ready results remain exempt. Set UNCACHED_MAX_SIZE_GB=0 to disable.
    const uncachedMaxSizeGbRaw = Number(
      process.env.UNCACHED_MAX_SIZE_GB ?? '8'
    );
    const uncachedMaxSizeBytes =
      Number.isFinite(uncachedMaxSizeGbRaw) && uncachedMaxSizeGbRaw > 0
        ? uncachedMaxSizeGbRaw * 1_000_000_000
        : undefined;

    // One physical torrent file can arrive through several playback routes
    // (for example native AIOStreams plus Torrentio/TorBox resolver copies).
    // If any copy already has provider/container-verified audio languages, make
    // those languages authoritative for the other copies of the exact same
    // file before language filtering. Match only infoHash + fileIdx: hash-only
    // propagation would be unsafe for season packs containing multiple files.
    const authoritativeLanguagesByFile = new Map<
      string,
      Map<string, string[]>
    >();
    for (const stream of streams) {
      const hash = stream.torrent?.infoHash;
      const fileIdx = stream.torrent?.fileIdx;
      const languages = stream.parsedFile?.languages;
      if (
        stream.mediaInfoSource !== 'provider' ||
        !hash ||
        fileIdx === undefined ||
        !languages?.length
      ) {
        continue;
      }

      const authoritativeLanguages = languages.filter(
        (language) => language !== 'Original'
      );
      if (authoritativeLanguages.length === 0) continue;

      const identity = `${hash.toLowerCase()}:${fileIdx}`;
      const normalisedLanguages = authoritativeLanguages.map((language) =>
        language.toLowerCase()
      );
      const signature = [...new Set(normalisedLanguages)].sort().join('|');
      const candidates =
        authoritativeLanguagesByFile.get(identity) ?? new Map<string, string[]>();
      candidates.set(signature, [...authoritativeLanguages]);
      authoritativeLanguagesByFile.set(identity, candidates);
    }

    let propagatedAuthoritativeLanguages = 0;
    for (const stream of streams) {
      if (stream.mediaInfoSource === 'provider') continue;
      const hash = stream.torrent?.infoHash;
      const fileIdx = stream.torrent?.fileIdx;
      if (!hash || fileIdx === undefined) continue;

      const identity = `${hash.toLowerCase()}:${fileIdx}`;
      const candidates = authoritativeLanguagesByFile.get(identity);
      if (!candidates?.size) continue;

      if (candidates.size !== 1) {
        logger.warn(
          'Conflicting provider/container audio languages for equivalent torrent file; keeping release metadata fallback',
          {
            id,
            hashPrefix: hash.slice(0, 10),
            fileIdx,
            languageSets: [...candidates.keys()],
          }
        );
        continue;
      }

      const languages = [...candidates.values()][0];
      stream.parsedFile = {
        ...(stream.parsedFile ?? {
          audioChannels: [],
          visualTags: [],
          audioTags: [],
          languages: [],
        }),
        languages: [...languages],
      };
      stream.mediaInfoSource = 'provider';
      propagatedAuthoritativeLanguages += 1;

      logger.debug(
        'Propagated authoritative provider/container audio languages to equivalent resolver stream',
        {
          id,
          addon: stream.addon.name,
          hashPrefix: hash.slice(0, 10),
          fileIdx,
          languages: stream.parsedFile.languages,
        }
      );
    }

    if (propagatedAuthoritativeLanguages > 0) {
      logger.debug(
        'Completed authoritative audio-language propagation across equivalent playback routes',
        { id, propagated: propagatedAuthoritativeLanguages }
      );
    }

    // v7.2.11: After reusing any provider metadata already present on an
    // equivalent native route, Torrentio/TorBox resolver streams can still
    // carry only vague release tags such as "Dual Audio" or "Unknown" even
    // when TorBox knows the
    // selected file's real container tracks. Before Required Language runs, ask
    // TorBox's cache-status endpoint for those ambiguous anime candidates and
    // use selected-file media_info when it is available. This is a read-only
    // cache check (checkOwned=false); it does not add the torrent to the user's
    // cloud. A single batched hash lookup covers many resolver streams.
    const torboxResolverMediaInfoHashLimitRaw = Number(
      process.env.TORBOX_RESOLVER_MEDIA_INFO_HASH_LIMIT ?? '40'
    );
    const torboxResolverMediaInfoHashLimit = Number.isFinite(
      torboxResolverMediaInfoHashLimitRaw
    )
      ? Math.min(
          100,
          Math.max(0, Math.floor(torboxResolverMediaInfoHashLimitRaw))
        )
      : 40;

    const isTorboxResolverAudioLookupCandidate = (
      stream: ParsedStream
    ): boolean => {
      if (!isAnime) return false;
      if (!this.userData.requiredLanguages?.includes('English' as any)) {
        return false;
      }
      if (stream.mediaInfoSource === 'provider') return false;
      if (stream.service?.id?.toLowerCase() !== 'torbox') return false;
      if (!stream.torrent?.infoHash || stream.torrent.fileIdx === undefined) {
        return false;
      }

      const languages = stream.parsedFile?.languages?.length
        ? stream.parsedFile.languages
        : ['Unknown'];

      // v7.2.12: English parsed from release text is not automatically trusted
      // here. A release can say both "Dual Audio" and "Eng Subs", causing
      // the parser to surface English even when the selected media file has only
      // Japanese audio. Include ambiguous English-bearing candidates in the
      // TorBox selected-file lookup so provider/container tracks can correct the
      // release-name guess before Required Language filtering.
      //
      // Do not spend provider calls on releases that already explicitly claim a
      // different non-English language (Chinese/French/etc.). Target only vague
      // audio labels plus English/Japanese, which can be authoritatively resolved
      // into the normal English tier or the verified Japanese fallback tier.
      const lookupEligibleLanguages = new Set([
        'Unknown',
        'Dual Audio',
        'Multi',
        'Dubbed',
        'English',
        'Japanese',
        'Original',
      ]);
      return languages.every((language) =>
        lookupEligibleLanguages.has(language)
      );
    };

    const torboxResolverAudioLookupAttemptedFiles = new Set<string>();

    if (
      providerMediaInfoConfig.enabled &&
      torboxResolverMediaInfoHashLimit > 0
    ) {
      const torboxServiceConfig = this.userData.services?.find(
        (service) => service.id === 'torbox' && service.enabled !== false
      );
      const torboxToken = torboxServiceConfig?.credentials?.apiKey;
      const candidates = streams.filter(isTorboxResolverAudioLookupCandidate);

      if (torboxToken && candidates.length > 0) {
        const uniqueHashes = [
          ...new Set(
            candidates.map((stream) => stream.torrent!.infoHash!.toLowerCase())
          ),
        ].slice(0, torboxResolverMediaInfoHashLimit);

        try {
          const debridService = getDebridService('torbox', torboxToken);
          if (isTorrentDebridService(debridService)) {
            const checks = await debridService.checkMagnets(
              uniqueHashes,
              id,
              false
            );
            const checksByHash = new Map(
              checks
                .filter((check) => check.hash)
                .map((check) => [check.hash!.toLowerCase(), check])
            );

            // v7.2.13: remember the exact TorBox torrent files for which the
            // selected-file media-info lookup was actually attempted. If the
            // provider returns no usable audio tracks for one of these files,
            // later language filtering can distinguish "provider unavailable"
            // from "provider never checked" without pretending release-name
            // guesses are authoritative.
            for (const stream of candidates) {
              const hash = stream.torrent?.infoHash?.toLowerCase();
              const fileIdx = stream.torrent?.fileIdx;
              if (
                hash &&
                fileIdx !== undefined &&
                uniqueHashes.includes(hash)
              ) {
                torboxResolverAudioLookupAttemptedFiles.add(
                  `${hash}:${fileIdx}`
                );
              }
            }

            let enriched = 0;
            let japaneseOnly = 0;
            let englishConfirmed = 0;

            for (const stream of candidates) {
              const hash = stream.torrent?.infoHash?.toLowerCase();
              const fileIdx = stream.torrent?.fileIdx;
              if (
                !hash ||
                fileIdx === undefined ||
                !uniqueHashes.includes(hash)
              ) {
                continue;
              }

              const check = checksByHash.get(hash);
              const providerFile = check?.files?.find(
                (file) => Number(file.index ?? file.id) === Number(fileIdx)
              );
              const authoritativeMediaInfo = providerFile?.mediaInfo
                ? parseMediaInfo(providerFile.mediaInfo)
                : undefined;
              const providerLanguages =
                authoritativeMediaInfo?.languages?.filter(
                  (language) => language !== 'Original'
                );
              if (!providerLanguages?.length) continue;

              stream.parsedFile = {
                ...(stream.parsedFile ?? {
                  audioChannels: [],
                  visualTags: [],
                  audioTags: [],
                  languages: [],
                }),
                languages: [...new Set(providerLanguages)],
              };
              stream.mediaInfoSource = 'provider';
              enriched += 1;

              const normalised = new Set(
                providerLanguages.map((language) => language.toLowerCase())
              );
              if (normalised.has('english')) englishConfirmed += 1;
              if (normalised.has('japanese') && !normalised.has('english')) {
                japaneseOnly += 1;
              }

              logger.debug(
                'Enriched TorBox resolver audio languages from provider/container metadata',
                {
                  id,
                  addon: stream.addon.name,
                  hashPrefix: hash.slice(0, 10),
                  fileIdx,
                  filename: stream.filename,
                  providerLanguages,
                }
              );
            }

            logger.debug(
              'Completed TorBox resolver provider audio-language enrichment',
              {
                id,
                candidates: candidates.length,
                uniqueHashes: uniqueHashes.length,
                enriched,
                englishConfirmed,
                japaneseOnly,
              }
            );
          }
        } catch (error) {
          logger.warn(
            'TorBox resolver provider audio-language enrichment failed; keeping existing release metadata',
            {
              id,
              candidates: candidates.length,
              error: error instanceof Error ? error.message : String(error),
            }
          );
        }
      }
    }

    const start = Date.now();
    // Sub-phase timing accumulators for this filter() call
    let metadataMs = 0;
    let expressionMs = 0;
    let regexCompileMs = 0;
    let filterPassMs = 0;
    let regexTestMs = 0;
    // Per-stream phase timing accumulators (accumulated during the filter pass, then merged into filterTimings)
    const phases = {
      titleMatch: { totalMs: 0, maxMs: 0, minMs: Infinity, count: 0 },
      yearMatch: { totalMs: 0, maxMs: 0, minMs: Infinity, count: 0 },
      seasonEpisodeMatch: { totalMs: 0, maxMs: 0, minMs: Infinity, count: 0 },
      episodeTitleMatch: { totalMs: 0, maxMs: 0, minMs: Infinity, count: 0 },
    };
    const accumPhase = (
      s: { totalMs: number; maxMs: number; minMs: number; count: number },
      ms: number
    ) => {
      s.totalMs += ms;
      s.count++;
      if (ms > s.maxMs) s.maxMs = ms;
      if (ms < s.minMs) s.minMs = ms;
    };

    const metadataStart = Date.now();
    const isRegexAllowed = await RegexAccess.isRegexAllowed(this.userData, [
      ...(this.userData.excludedRegexPatterns ?? []),
      ...(this.userData.requiredRegexPatterns ?? []),
      ...(this.userData.includedRegexPatterns ?? []),
      ...(this.userData.preferredRegexPatterns ?? []).map(
        (regex) => regex.pattern
      ),
    ]);

    // Get metadata from context (already fetched in parallel with addon requests)
    const requestedMetadata: ExtendedMetadata | undefined =
      await context.getMetadata();
    const releaseDates: ReleaseDate[] | undefined =
      await context.getReleaseDates();
    const episodeAirDate: string | undefined =
      await context.getEpisodeAirDate();
    let originalLanguage = requestedMetadata?.originalLanguage
      ? iso6391ToLanguage(requestedMetadata.originalLanguage)
      : undefined;

    const episodeRuntime = await context.getEpisodeRuntime();
    const episodeTitleFromDetails = await context.getEpisodeTitle();
    const requestedEpisodeTitle =
      requestedMetadata?.episodeTitle ?? episodeTitleFromDetails;
    const logEpisodeTitleDebug = (message: string, extra: Record<string, unknown> = {}) => {
      if (!episodeTitleDebug) return;
      logger.info(message, {
        id,
        type,
        isAnime,
        requestedTitle: requestedMetadata?.title,
        requestedEpisodeTitle,
        season: parsedId?.season,
        episode: parsedId?.episode,
        ...extra,
      });
    };
    metadataMs = Date.now() - metadataStart;
    if (metadataMs > 10) {
      logger.debug(
        `Metadata + regex access resolved in ${formatMilliseconds(metadataMs)}`,
        { id }
      );
    }
    const runtimeToUse =
      episodeRuntime ||
      (requestedMetadata?.runtime ? requestedMetadata.runtime : undefined);

    if (episodeRuntime) {
      logger.debug(`Using episode runtime: ${episodeRuntime} minutes`, {
        id,
        episode: `${parsedId?.season}:${parsedId?.episode}`,
      });
    } else if (requestedMetadata?.runtime) {
      logger.debug(
        `Using series average runtime: ${requestedMetadata.runtime} minutes`,
        {
          id,
        }
      );
    }

    let yearWithinTitle: string | undefined;
    let yearWithinTitleRegex: RegExp | undefined;

    if (requestedMetadata?.title) {
      yearWithinTitle = requestedMetadata.title.match(
        /\b(19\d{2}|20\d{2})\b/
      )?.[0];
      if (yearWithinTitle) {
        yearWithinTitleRegex = new RegExp(yearWithinTitle, 'g');
      }
      logger.info(`Using metadata from context`, {
        id,
        title: requestedMetadata.title,
        year: requestedMetadata.year,
        hasGenres: !!requestedMetadata.genres?.length,
        originalLanguage: originalLanguage,
      });
    }

    // fill in bitrate from metadata runtime and size if missing and enabled
    if (this.userData.bitrate?.useMetadataRuntime !== false) {
      streams.forEach((stream) => {
        const isFolderSize =
          stream.parsedFile?.seasons?.length &&
          stream.parsedFile.seasons.length > 0 &&
          (!stream.parsedFile.episodes ||
            stream.parsedFile.episodes.length === 0);
        let doBitrateCalculation = true;

        if (
          (stream.bitrate === undefined || !Number.isFinite(stream.bitrate)) &&
          runtimeToUse &&
          stream.size &&
          (!isFolderSize || type === 'series') // only calculate for folder sizes if it's a series
        ) {
          let episodeCount = stream.parsedFile?.episodes?.length || 0;
          let finalSize = stream.size;

          if (!stream.folderSize && episodeCount > 5 && type === 'series') {
            finalSize = stream.size / episodeCount;
            logger.silly(
              `Assuming episode pack for stream ${stream.filename} with ${episodeCount} episodes, dividing size by episode count for bitrate calculation`,
              {
                originalSize: formatBytes(stream.size, 1024),
                adjustedSize: formatBytes(finalSize, 1024),
              }
            );
          } else if (isFolderSize && type === 'series') {
            // For folder/season pack size, calculate per-episode size for bitrate calculation
            // Get total episodes across all seasons in the pack
            let totalEpisodes = 0;
            let hasUnknownSeasons = false;

            for (const season of stream.parsedFile?.seasons || []) {
              const seasonData = requestedMetadata?.seasons?.find(
                (s) => s.season_number === season
              );

              if (seasonData?.episode_count) {
                totalEpisodes += seasonData.episode_count;
              } else {
                // If we can't find episode count for any season, we can't reliably calculate
                hasUnknownSeasons = true;
                break;
              }
            }

            if (!hasUnknownSeasons && totalEpisodes > 0) {
              logger.silly(
                `Calculating bitrate for season pack ${stream.filename} using total of ${totalEpisodes} episodes`,
                {
                  seasons: stream.parsedFile?.seasons,
                }
              );
              finalSize = finalSize / totalEpisodes;
            } else {
              doBitrateCalculation = false;
              logger.silly(
                `Cannot calculate bitrate for season pack ${stream.filename}: ${hasUnknownSeasons ? 'unknown season data' : 'no episodes found'}`,
                {
                  seasons: stream.parsedFile?.seasons,
                }
              );
            }
          }

          if (doBitrateCalculation && runtimeToUse) {
            stream.bitrate = Math.round((finalSize * 8) / (runtimeToUse * 60));
          }
        }
      });
    }

    const applyDigitalReleaseFilter = (): boolean => {
      const config = this.userData.digitalReleaseFilter;
      if (!config?.enabled) return true;

      // Preconditions: check content type is in scope
      const filterRequestTypes = config.requestTypes;
      if (
        filterRequestTypes?.length &&
        ((isAnime && !filterRequestTypes.includes('anime')) ||
          (!isAnime && !filterRequestTypes.includes(type)))
      ) {
        return true;
      }
      if (!['movie', 'series', 'anime'].includes(type)) return true;

      // Parse and validate release date (required for all subsequent rules)
      const releaseDate = requestedMetadata?.releaseDate
        ? new Date(requestedMetadata.releaseDate)
        : null;
      if (!releaseDate || isNaN(releaseDate.getTime())) {
        logger.debug(
          `[DigitalReleaseFilter] No valid release date for "${requestedMetadata?.title}", allowing`
        );
        return true;
      }

      // Precompute values referenced by rules
      const today = new Date();
      const tolerance = config.tolerance ?? 0;
      const msPerDay = 1000 * 60 * 60 * 24;
      const daysBetween = (from: Date, to: Date) =>
        Math.floor((to.getTime() - from.getTime()) / msPerDay);
      const title = requestedMetadata?.title;
      const daysSinceRelease = daysBetween(releaseDate, today);
      const isSeries = type === 'series' || type === 'anime';

      // Episode air date (series/anime only)
      const epDateStr = isSeries
        ? episodeAirDate || requestedMetadata?.releaseDate
        : null;
      const epDate =
        epDateStr && !isNaN(new Date(epDateStr).getTime())
          ? new Date(epDateStr)
          : null;
      const daysSinceEpisode = epDate ? daysBetween(epDate, today) : null;
      const epLabel = `S${parsedId?.season}E${parsedId?.episode}`;

      // Digital release dates (TMDB types 4-6: Digital, Physical, TV)
      const digitalDates = (releaseDates ?? []).filter(
        (rd) => rd.type >= 4 && rd.type <= 6
      );
      const pastDigitalRelease = digitalDates.some(
        (rd) => new Date(rd.release_date) <= today
      );
      const closestFutureDigital = pastDigitalRelease
        ? null
        : digitalDates.length > 0
          ? digitalDates
              .map((rd) => ({
                date: rd.release_date,
                daysUntil: Math.ceil(
                  (new Date(rd.release_date).getTime() - today.getTime()) /
                    msPerDay
                ),
              }))
              .sort((a, b) => a.daysUntil - b.daysUntil)[0]
          : null;

      const formatDate = (dateStr: string | Date) =>
        new Date(dateStr).toLocaleDateString(undefined, {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        });

      logger.debug(`[DigitalReleaseFilter] Evaluating "${title}"`, {
        releaseDate: formatDate(releaseDate),
        daysSinceRelease,
        isSeries,
        episodeAirDate: epDate ? formatDate(epDate) : 'N/A',
        daysSinceEpisode: daysSinceEpisode ?? 'N/A',
        digitalReleaseDates:
          digitalDates.map((rd) => formatDate(rd.release_date)).join(', ') ||
          'None',
        pastDigitalRelease,
        closestFutureDigital: closestFutureDigital
          ? `${formatDate(closestFutureDigital.date)} (${closestFutureDigital.daysUntil}d away)`
          : 'None',
      });

      // Rules evaluated top-to-bottom; first matching rule determines the outcome.
      // allow: true = let streams through, false = block streams
      // level: log level for the rule's reason (default: 'debug')
      type FilterRule = {
        when: () => boolean;
        allow: boolean;
        reason: () => string;
        level?: 'debug' | 'info';
      };
      const rules: FilterRule[] = [
        // General
        {
          when: () => Math.abs(daysSinceRelease) <= tolerance,
          allow: true,
          reason: () =>
            `"${title}" within tolerance (${Math.abs(daysSinceRelease)}d <= ${tolerance}d)`,
        },
        {
          when: () => daysSinceRelease < 0,
          allow: false,
          level: 'info',
          reason: () =>
            `"${title}" releases in ${Math.abs(daysSinceRelease)} days`,
        },
        // Series / Anime episode rules
        {
          when: () => isSeries && daysSinceEpisode === null,
          allow: true,
          reason: () => `No episode air date available`,
        },
        {
          when: () =>
            isSeries &&
            daysSinceEpisode !== null &&
            Math.abs(daysSinceEpisode) <= tolerance,
          allow: true,
          reason: () =>
            `Episode ${epLabel} within tolerance (${Math.abs(daysSinceEpisode!)}d <= ${tolerance}d)`,
        },
        {
          when: () =>
            isSeries && daysSinceEpisode !== null && daysSinceEpisode < 0,
          allow: false,
          level: 'info',
          reason: () =>
            `"${title}" ${epLabel} airs in ${Math.abs(daysSinceEpisode!)} days`,
        },
        {
          when: () => isSeries,
          allow: true,
          reason: () => `Episode has aired`,
        },
        // Movie rules
        {
          when: () => daysSinceRelease > 365,
          allow: true,
          reason: () => `Movie over 1 year old, likely has digital release`,
        },
        {
          when: () => !releaseDates?.length,
          allow: true,
          reason: () => `No TMDB release dates for "${title}"`,
        },
        {
          when: () => pastDigitalRelease,
          allow: true,
          reason: () => `Digital release found for "${title}"`,
        },
        {
          when: () =>
            closestFutureDigital !== null &&
            closestFutureDigital.daysUntil <= tolerance,
          allow: true,
          reason: () =>
            `Digital release for "${title}" within tolerance (${closestFutureDigital!.daysUntil}d <= ${tolerance}d)`,
        },
        {
          when: () => digitalDates.length > 0,
          allow: false,
          level: 'info',
          reason: () =>
            `"${title}" no digital release yet (closest: ${closestFutureDigital ? formatDate(closestFutureDigital.date) : 'None'}, ${closestFutureDigital?.daysUntil}d away)`,
        },
        // Fallback
        {
          when: () => true,
          allow: false,
          level: 'info',
          reason: () =>
            `"${title}" no digital release data (${daysSinceRelease}d since theatrical)`,
        },
      ];

      for (const rule of rules) {
        if (rule.when()) {
          const action = rule.allow ? 'ALLOWING' : 'BLOCKING';
          logger[rule.level ?? 'debug'](
            `[DigitalReleaseFilter] ${action} - ${rule.reason()}`
          );
          return rule.allow;
        }
      }

      return true;
    };

    const performTitleMatch = (stream: ParsedStream) => {
      const titleMatchingOptions = {
        mode: 'exact',
        similarityThreshold: 0.85,
        ...(this.userData.titleMatching ?? {}),
      };
      if (!titleMatchingOptions || !titleMatchingOptions.enabled) {
        return true;
      }
      if (
        !requestedMetadata ||
        !requestedMetadata.titles ||
        requestedMetadata.titles.length === 0
      ) {
        return true;
      }

      let streamTitle = stream.parsedFile?.title;
      if (
        titleMatchingOptions.requestTypes?.length &&
        ((isAnime && !titleMatchingOptions.requestTypes.includes('anime')) ||
          (!isAnime && !titleMatchingOptions.requestTypes.includes(type)))
      ) {
        return true;
      }

      if (
        titleMatchingOptions.addons?.length &&
        !titleMatchingOptions.addons.includes(stream.addon.preset.id)
      ) {
        return true;
      }

      if (!streamTitle || !stream.filename) {
        // only filter out movies without a year as series results usually don't include a year
        return false;
      }

      // Extract title strings for preprocessTitle
      const titleStrings = requestedMetadata.titles.map((t) => t.title);

      streamTitle = preprocessTitle(streamTitle, stream.filename, titleStrings);

      const normalisedStreamTitle = normaliseTitle(streamTitle);

      // Single-pass match that also returns the language of the best matching title
      let result: { matched: boolean; language?: string };
      if (titleMatchingOptions.mode === 'exact') {
        result = titleMatchWithLang(
          normalisedStreamTitle,
          requestedMetadata.titles,
          {
            threshold: titleMatchingOptions.similarityThreshold,
            limitTitles: 100,
          }
        );
      } else {
        result = titleMatchWithLang(
          normalisedStreamTitle,
          requestedMetadata.titles,
          {
            threshold: titleMatchingOptions.similarityThreshold,
            scorer: partial_ratio,
            limitTitles: 100,
          }
        );
      }

      if (result.matched && result.language && stream.parsedFile) {
        const lang = result.language.toLowerCase();
        // Skip common languages where a title match doesn't reliably indicate
        // the stream is in that language (English/Japanese titles are universal)
        const isCommon = lang === 'en' || (isAnime && lang === 'ja');

        // Don't infer language if the stream already carries a specific language tag.
        // Unknown / Dual Audio / Multi / Dubbed are non-specific and don't count.
        const nonSpecificLanguages = [
          'Unknown',
          'Dual Audio',
          'Multi',
          'Dubbed',
        ];
        const hasSpecificLanguage = stream.parsedFile.languages.some(
          (l) => !nonSpecificLanguages.includes(l)
        );

        if (!isCommon && !hasSpecificLanguage) {
          const inferredLanguage = iso6391ToLanguage(lang);
          if (
            inferredLanguage &&
            !stream.parsedFile.languages.includes(inferredLanguage) &&
            LANGUAGES.includes(inferredLanguage as any)
          ) {
            stream.parsedFile.languages.push(inferredLanguage);
            logger.debug(
              `Inferred language "${inferredLanguage}" for stream "${stream.filename}" from matched title language (${lang})`
            );
          }
        }
      }

      return result.matched;
    };

    const findYearInString = (string: string) => {
      const regexes = [
        /[([*]?(?!^)(?<!\d|Cap[. ]?)((?:19\d{2}|20[012]\d{2}))(?!\d|kbps)[*)\]]?/i,
        /[([]?((?:19\d{2}|20[012]\d{1}))(?!\d|kbps)[)\]]?/i,
      ];
      for (const regex of regexes) {
        const match = string.match(regex);
        if (match && match[1]) {
          return match[1];
        }
      }
      return undefined;
    };

    const performYearMatch = (stream: ParsedStream) => {
      const yearMatchingOptions = {
        tolerance: 1,
        strict: true,
        ...this.userData.yearMatching,
      };

      if (!yearMatchingOptions || !yearMatchingOptions.enabled) {
        return true;
      }

      if (!requestedMetadata || !requestedMetadata.year) {
        return true;
      }

      if (
        yearMatchingOptions.requestTypes?.length &&
        ((isAnime && !yearMatchingOptions.requestTypes.includes('anime')) ||
          (!isAnime && !yearMatchingOptions.requestTypes.includes(type)))
      ) {
        return true;
      }

      if (
        yearMatchingOptions.addons?.length &&
        !yearMatchingOptions.addons.includes(stream.addon.preset.id)
      ) {
        return true;
      }

      let streamYear = stream.parsedFile?.year;
      if (yearWithinTitleRegex && yearWithinTitle) {
        const filenameWithoutYear = stream.filename
          ? stream.filename.replace(yearWithinTitleRegex, '')
          : undefined;
        const foldernameWithoutYear = stream.folderName
          ? stream.folderName.replace(yearWithinTitle, '')
          : undefined;

        const strings = [filenameWithoutYear, foldernameWithoutYear].filter(
          (s): s is string => s !== undefined
        );

        for (const string of strings) {
          const newStreamYear = findYearInString(string);
          if (newStreamYear) {
            streamYear = newStreamYear;
            if (stream.parsedFile) {
              stream.parsedFile.year = newStreamYear;
            }
            break;
          }
        }

        if (
          streamYear === yearWithinTitle &&
          yearWithinTitle !== requestedMetadata.year.toString()
        ) {
          streamYear = undefined;
          if (stream.parsedFile) stream.parsedFile.year = undefined;
        }
      }

      if (!streamYear) {
        // if no year is present, filter out if its a movie IF strict is true, keep otherwise
        return type === 'movie' && yearMatchingOptions.strict ? false : true;
      }

      // streamYear can be a string like "2004" or "2012-2020"
      // Calculate the requested year range.
      // When useInitialAirDate is enabled for series/anime, compare against
      // only the initial air year instead of the full year range.
      const useInitialOnly =
        yearMatchingOptions.useInitialAirDate &&
        (type === 'series' || type === 'anime');

      let requestedYearRange: [number, number] = [
        requestedMetadata.year,
        requestedMetadata.year,
      ];
      if (requestedMetadata.yearEnd && !useInitialOnly) {
        requestedYearRange[1] = requestedMetadata.yearEnd;
      }

      // Calculate the stream year range
      let streamYearRange: [number, number];
      if (streamYear.includes('-')) {
        const [min, max] = streamYear.split('-').map(Number);
        streamYearRange = [min, max];
      } else {
        const yearNum = Number(streamYear);
        streamYearRange = [yearNum, yearNum];
      }

      // Apply tolerance to the stream year range
      const tolerance = yearMatchingOptions.tolerance ?? 1;
      streamYearRange[0] -= tolerance;
      streamYearRange[1] += tolerance;

      // If the requested year range and stream year range overlap, accept the stream
      const [requestedStart, requestedEnd] = requestedYearRange;
      const [streamStart, streamEnd] = streamYearRange;
      return requestedStart <= streamEnd && requestedEnd >= streamStart;
    };

    const performSeasonEpisodeMatch = (stream: ParsedStream) => {
      const seasonEpisodeMatchingOptions = this.userData.seasonEpisodeMatching;
      if (
        !seasonEpisodeMatchingOptions ||
        !seasonEpisodeMatchingOptions.enabled
      ) {
        return true;
      }

      if (!parsedId) return true;
      const requestedSeason = Number.isInteger(Number(parsedId.season))
        ? Number(parsedId.season)
        : undefined;
      const requestedEpisode = Number.isInteger(Number(parsedId.episode))
        ? Number(parsedId.episode)
        : undefined;

      // v13: Anime specials/OVAs are often numbered differently across metadata
      // providers, AniDB/TVDB order, and torrent filenames. A valid requested
      // special can be published as S00Exx, S01Exx, OVA/OAD, "Tales", "Visions",
      // "Digression", "Part 1", etc. Let obvious special-title candidates pass
      // season/episode matching and rely on episode-title/language/cache filters
      // later, instead of killing them here solely because the number differs.
      const streamLooksLikeRequestedAnimeSpecialCandidate =
        streamLooksLikeRequestedAnimeSpecial(stream);

      if (
        seasonEpisodeMatchingOptions.requestTypes?.length &&
        ((isAnime &&
          !seasonEpisodeMatchingOptions.requestTypes.includes('anime')) ||
          (!isAnime &&
            !seasonEpisodeMatchingOptions.requestTypes.includes(type)))
      ) {
        return true;
      }

      if (
        seasonEpisodeMatchingOptions.addons?.length &&
        !seasonEpisodeMatchingOptions.addons.includes(stream.addon.preset.id)
      ) {
        return true;
      }

      // if the requested content is a movie and season/episode is present, filter out
      if (
        type === 'movie' &&
        (stream.parsedFile?.seasons?.length ||
          stream.parsedFile?.episodes?.length)
      ) {
        return false;
      }
      let seasons = stream.parsedFile?.seasons;

      // if the requested content is series and no season or episode info is present, filter out if strict is true
      if (type === 'series' && seasonEpisodeMatchingOptions.strict) {
        if (
          !stream.parsedFile?.seasons?.length &&
          !stream.parsedFile?.episodes?.length
        ) {
          return false;
        }

        if (
          !stream.parsedFile.seasons?.length &&
          stream.parsedFile.episodes?.length
        ) {
          // assume season is 1 when empty and episode is present in strict mode.
          seasons = [1];
        }
      }

      if (
        requestedSeason &&
        seasons &&
        seasons.length > 0 &&
        !seasons.includes(requestedSeason)
      ) {
        if (
          seasons[0] === 1 &&
          stream.parsedFile?.episodes?.length &&
          requestedMetadata?.absoluteEpisode &&
          stream.parsedFile?.episodes?.includes(
            requestedMetadata.absoluteEpisode
          )
        ) {
          // allow if absolute episode matches AND season is 1
        } else if (
          seasons[0] === 1 &&
          stream.parsedFile?.episodes?.length &&
          requestedMetadata?.relativeAbsoluteEpisode &&
          stream.parsedFile?.episodes?.includes(
            requestedMetadata.relativeAbsoluteEpisode
          )
        ) {
          // allow if relative absolute episode (AniDB episode) matches AND season is 1
        } else if (streamLooksLikeRequestedAnimeSpecialCandidate) {
          logEpisodeTitleDebug('Season/episode matching allowed loose anime special season mismatch', {
            filename: stream.filename,
            folderName: stream.folderName,
            parsedTitle: stream.parsedFile?.title,
            parsedSeasons: stream.parsedFile?.seasons,
            parsedEpisodes: stream.parsedFile?.episodes,
            requestedSeason,
            requestedEpisode,
            requestedEpisodeTitle,
          });
        } else {
          return false;
        }
      }

      if (
        requestedEpisode &&
        stream.parsedFile?.episodes?.length &&
        !stream.parsedFile?.episodes?.includes(requestedEpisode)
      ) {
        if (
          requestedMetadata?.absoluteEpisode &&
          stream.parsedFile?.episodes?.includes(
            requestedMetadata.absoluteEpisode
          ) &&
          (!seasons?.length || seasons[0] === 1)
        ) {
          // allow if absolute episode matches AND (no season OR season is 1)
        } else if (
          requestedMetadata?.relativeAbsoluteEpisode &&
          stream.parsedFile?.episodes?.includes(
            requestedMetadata.relativeAbsoluteEpisode
          ) &&
          (!seasons?.length || seasons[0] === 1)
        ) {
          // allow if relative absolute episode (AniDB episode) matches AND (no season OR season is 1)
        } else if (streamLooksLikeRequestedAnimeSpecialCandidate) {
          logEpisodeTitleDebug('Season/episode matching allowed loose anime special episode mismatch', {
            filename: stream.filename,
            folderName: stream.folderName,
            parsedTitle: stream.parsedFile?.title,
            parsedSeasons: stream.parsedFile?.seasons,
            parsedEpisodes: stream.parsedFile?.episodes,
            requestedSeason,
            requestedEpisode,
            requestedEpisodeTitle,
          });
        } else {
          return false;
        }
      }

      return true;
    };

    const performEpisodeTitleMatch = (stream: ParsedStream) => {
      const episodeTitleMatchingOptions = {
        enabled: false,
        strict: false,
        mode: 'mismatchOnly',
        similarityThreshold: 0.82,
        requestTypes: ['series', 'anime'],
        ...(this.userData.episodeTitleMatching ?? {}),
      };

      logEpisodeTitleDebug('Episode title matching check started', {
        addon: stream.addon?.name,
        addonPresetId: stream.addon?.preset?.id,
        filename: stream.filename,
        folderName: stream.folderName,
        originalName: stream.originalName,
        indexer: stream.indexer,
        streamType: stream.type,
        service: stream.service,
        parsedTitle: stream.parsedFile?.title,
        parsedSeasons: stream.parsedFile?.seasons,
        parsedEpisodes: stream.parsedFile?.episodes,
        parsedSeasonPack: stream.parsedFile?.seasonPack,
        parsedLanguages: stream.parsedFile?.languages,
        parsedResolution: stream.parsedFile?.resolution,
        passthroughs: stream.passthrough,
        episodeTitleMatchingOptions,
      });

      if (!episodeTitleMatchingOptions.enabled) {
        logEpisodeTitleDebug('Episode title matching bypassed: disabled', { filename: stream.filename, parsedTitle: stream.parsedFile?.title });
        return true;
      }

      if (!parsedId || !requestedEpisodeTitle) {
        logEpisodeTitleDebug('Episode title matching bypassed: missing parsedId or requested episode title', {
          filename: stream.filename,
          parsedTitle: stream.parsedFile?.title,
          hasParsedId: !!parsedId,
          hasRequestedEpisodeTitle: !!requestedEpisodeTitle,
        });
        return true;
      }

      const requestedSeason = Number.isInteger(Number(parsedId.season))
        ? Number(parsedId.season)
        : undefined;
      const requestedEpisode = Number.isInteger(Number(parsedId.episode))
        ? Number(parsedId.episode)
        : undefined;

      if (!requestedSeason || !requestedEpisode) {
        logEpisodeTitleDebug('Episode title matching bypassed: missing requested season or episode', {
          filename: stream.filename,
          parsedTitle: stream.parsedFile?.title,
          requestedSeason,
          requestedEpisode,
        });
        return true;
      }

      if (
        episodeTitleMatchingOptions.requestTypes?.length &&
        ((isAnime &&
          !episodeTitleMatchingOptions.requestTypes.includes('anime')) ||
          (!isAnime &&
            !episodeTitleMatchingOptions.requestTypes.includes(type)))
      ) {
        logEpisodeTitleDebug('Episode title matching bypassed: request type not enabled', {
          filename: stream.filename,
          parsedTitle: stream.parsedFile?.title,
          requestTypes: episodeTitleMatchingOptions.requestTypes,
        });
        return true;
      }

      if (
        episodeTitleMatchingOptions.addons?.length &&
        !episodeTitleMatchingOptions.addons.includes(stream.addon.preset.id)
      ) {
        logEpisodeTitleDebug('Episode title matching bypassed: addon not selected', {
          filename: stream.filename,
          parsedTitle: stream.parsedFile?.title,
          addonPresetId: stream.addon?.preset?.id,
          configuredAddons: episodeTitleMatchingOptions.addons,
        });
        return true;
      }

      const seasons = stream.parsedFile?.seasons ?? [];
      const episodes = stream.parsedFile?.episodes ?? [];
      const isMultiEpisode = episodes.length > 1;
      const isSeasonPack = !!stream.parsedFile?.seasonPack;

      // Do not skip multi-episode/season-pack-looking results entirely here.
      // Some false positives (especially anime OVAs/specials labelled as "Part 3")
      // can be parsed as multi-episode or pack-like. Mismatch-only mode should still
      // get a chance to reject obvious different-title/extra-title results.
      // We only avoid strict "must contain episode title" rejection for packs later.
      const avoidStrictEpisodeTitleRequirement = isMultiEpisode || isSeasonPack;

      const primaryCandidateText = [
        stream.filename,
        stream.folderName,
        stream.parsedFile?.title,
        stream.originalName,
      ]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .join(' ');

      const displayCandidateText = [
        stream.originalDescription,
        stream.message,
      ]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .join(' ');

      const candidateText = [primaryCandidateText, displayCandidateText]
        .filter((value) => value.trim().length > 0)
        .join(' ');

      if (!candidateText) {
        return true;
      }

      const threshold = episodeTitleMatchingOptions.similarityThreshold ?? 0.82;
      const normalisedCandidate = normaliseTitle(candidateText);
      const normalisedPrimaryCandidate = normaliseTitle(primaryCandidateText || candidateText);
      const normalisedRequestedEpisodeTitle = normaliseTitle(requestedEpisodeTitle);
      // Do not allow display/formatter text to short-circuit mismatch checks.
      // Some addons can include the requested episode title in display text even when
      // the raw filename is a different OVA/special/spin-off. Raw filename checks below
      // should get the first chance to reject those false positives.

      const requestPrimaryTitles = [requestedMetadata?.title]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => normaliseTitle(value))
        .filter((value, index, array) => value.length > 0 && array.indexOf(value) === index);

      const requestAliasTitles = requestedMetadata?.titles
        ?.map((title) => title.title)
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => normaliseTitle(value))
        .filter((value, index, array) => value.length > 0 && array.indexOf(value) === index) ?? [];

      const requestTitles = [...requestPrimaryTitles, ...requestAliasTitles]
        .filter((value, index, array) => value.length > 0 && array.indexOf(value) === index);

      const titleContains = (haystack: string, needle: string) => {
        if (!haystack || !needle) return false;
        return (
          haystack === needle ||
          haystack.includes(needle) ||
          needle.includes(haystack)
        );
      };

      const titleMatches = (haystack: string, needle: string, minScore = 0.9) => {
        if (!haystack || !needle) return false;
        return titleContains(haystack, needle) || partial_ratio(haystack, needle) / 100 >= minScore;
      };

      const stripReleaseNoiseForTitle = (value: string) => {
        let cleaned = value
          .replace(/\.[a-z0-9]{2,5}$/i, ' ')
          // Drop common release-group tags and technical bracket groups, but leave the actual title text.
          .replace(/^\s*[\[(][^\])]+[\])]\s*/g, ' ')
          .replace(/[\[(][^\])]*(?:1080p|720p|2160p|480p|x26[45]|h\.?26[45]|hevc|avc|web[- .]?dl|webrip|bluray|bdrip|dvdrip|aac|flac|opus|truehd|atmos|dual[ ._-]?audio|multi|proper|repack|v\d)[^\])]*[\])]/gi, ' ')
          .replace(/[._-]+/g, ' ')
          .replace(/\bS\d{1,2}\s*E\d{1,3}\b/gi, ' ')
          .replace(/\b\d{1,2}\s*x\s*\d{1,3}\b/gi, ' ')
          .replace(/\b(?:episode|ep)\s*\d{1,3}\b/gi, ' ')
          .replace(/\b(?:part|pt)\s*\d{1,3}\b/gi, ' ')
          .replace(/\b(?:vol(?:ume)?|season)\s*\d{1,3}\b/gi, ' ')
          .replace(/\b(?:19|20)\d{2}\b/g, ' ')
          .replace(/\b(?:2160p|1080p|720p|576p|540p|480p|360p|uhd|hdr10?|dv|dolby|vision|bluray|blu ray|bdrip|web dl|webrip|hdtv|x26[45]|h 26[45]|hevc|avc|aac|flac|opus|truehd|atmos|dts|dual audio|dubbed|subbed|multi|gb|jp|jpn|eng|es|fr|pt|mkv|mp4|avi)\b/gi, ' ')
          .replace(/\b\d+(?:\.\d+)?\s*(?:gb|mb|kb)\b/gi, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        return normaliseTitle(cleaned);
      };

      const filenameOnlyText = typeof stream.filename === 'string' ? stream.filename : '';
      const filenameAndParsedTitleText = [stream.filename, stream.parsedFile?.title]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .join(' ');
      const rawFilenameText = [stream.filename, stream.folderName, stream.originalName]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .join(' ');
      const rawIdentityText = [rawFilenameText, stream.parsedFile?.title]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .join(' ');
      const normalisedFilenameOnly = normaliseTitle(filenameOnlyText || stream.parsedFile?.title || '');
      const normalisedFilenameAndParsedTitle = normaliseTitle(filenameAndParsedTitleText || primaryCandidateText);
      const normalisedRawFilename = normaliseTitle(rawFilenameText || primaryCandidateText);
      const normalisedRawIdentity = normaliseTitle(rawIdentityText || primaryCandidateText);
      const rawReleaseTitle = stripReleaseNoiseForTitle(rawIdentityText || primaryCandidateText);
      const rawFilenameReleaseTitle = stripReleaseNoiseForTitle(rawFilenameText || primaryCandidateText);
      const filenameOnlyReleaseTitle = stripReleaseNoiseForTitle(filenameOnlyText || stream.parsedFile?.title || '');
      const rawReleaseTitleWords = rawReleaseTitle.split(/\s+/).filter(Boolean);
      const rawFilenameReleaseTitleWords = rawFilenameReleaseTitle.split(/\s+/).filter(Boolean);

      const hasRequestedSeriesTitle = requestTitles.some(
        (title) =>
          titleMatches(normalisedPrimaryCandidate, title, 0.9) ||
          titleMatches(normalisedRawIdentity, title, 0.9) ||
          titleMatches(rawReleaseTitle, title, 0.9)
      );

      const hasRequestedPrimarySeriesTitleInFilename = requestPrimaryTitles.some(
        (title) =>
          titleMatches(normalisedRawFilename, title, 0.9) ||
          titleMatches(rawFilenameReleaseTitle, title, 0.9)
      );

      const hasRequestedPrimarySeriesTitleInFilenameOnly = requestPrimaryTitles.some(
        (title) =>
          titleMatches(normalisedFilenameOnly, title, 0.9) ||
          titleMatches(normalisedFilenameAndParsedTitle, title, 0.9) ||
          titleMatches(filenameOnlyReleaseTitle, title, 0.9)
      );

      // v10: actual file-name only means the literal file name and the release title
      // extracted from that file name. Do not include parsedTitle here, because parsers
      // can infer the requested series title from the surrounding folder/metadata even
      // when the real file is a spin-off/OVA inside a franchise batch.
      const hasRequestedPrimarySeriesTitleInActualFilenameOnly = requestPrimaryTitles.some(
        (title) =>
          titleMatches(normalisedFilenameOnly, title, 0.9) ||
          titleMatches(filenameOnlyReleaseTitle, title, 0.9)
      );

      const hasRequestedEpisodeTitle =
        titleMatches(normalisedPrimaryCandidate, normalisedRequestedEpisodeTitle, threshold) ||
        titleMatches(normalisedRawIdentity, normalisedRequestedEpisodeTitle, threshold) ||
        titleMatches(rawReleaseTitle, normalisedRequestedEpisodeTitle, threshold);

      const hasRequestedEpisodeTitleInFilename =
        titleMatches(normalisedRawFilename, normalisedRequestedEpisodeTitle, threshold) ||
        titleMatches(rawFilenameReleaseTitle, normalisedRequestedEpisodeTitle, threshold);

      const hasRequestedEpisodeTitleInFilenameOnly =
        titleMatches(normalisedFilenameOnly, normalisedRequestedEpisodeTitle, threshold) ||
        titleMatches(normalisedFilenameAndParsedTitle, normalisedRequestedEpisodeTitle, threshold) ||
        titleMatches(filenameOnlyReleaseTitle, normalisedRequestedEpisodeTitle, threshold);

      const hasRequestedEpisodeTitleInActualFilenameOnly =
        titleMatches(normalisedFilenameOnly, normalisedRequestedEpisodeTitle, threshold) ||
        titleMatches(filenameOnlyReleaseTitle, normalisedRequestedEpisodeTitle, threshold);

      // Do not return early on hasRequestedEpisodeTitle here.
      // The formatted/display text can contain the requested episode title even when
      // the raw filename is a different OVA/special/spin-off. Run mismatch-only
      // raw-filename checks first, then allow requested episode title matches later.

      // Compare a possible conflicting episode title against the requested episode
      // title, rather than rejecting on any fuzzy match above the threshold. Anime
      // franchises often have specials whose title is just the series name plus a
      // number (for example, "Jujutsu Kaisen 0"). A normal episode filename such
      // as "Jujutsu Kaisen S03E11..." can fuzzy-match that title very strongly
      // even though it is clearly not the movie/special. Likewise, neighbouring
      // episode titles such as "Part 4" and "Part 5" are intentionally similar.
      //
      // A different known episode title is therefore considered a conflict only when
      // it is a better match than the requested title by a useful margin, or when the
      // candidate literally contains that other title while not literally containing
      // the requested one. Series-title + numeric-suffix specials require literal
      // containment before they can conflict, preventing the franchise name alone
      // from removing ordinary episodes.
      const episodeTitleCandidateForms = [
        normalisedCandidate,
        normalisedPrimaryCandidate,
        rawReleaseTitle,
      ].filter((value) => value.length > 0);

      const requestedEpisodeScore = Math.max(
        ...episodeTitleCandidateForms.map(
          (value) => partial_ratio(value, normalisedRequestedEpisodeTitle) / 100
        )
      );
      const requestedEpisodeExact = episodeTitleCandidateForms.some((value) =>
        value.includes(normalisedRequestedEpisodeTitle)
      );

      const isSeriesTitlePlusNumericSuffix = (episodeTitle: string) =>
        requestTitles.some((seriesTitle) => {
          if (!seriesTitle || !episodeTitle.startsWith(seriesTitle)) return false;
          const remainder = episodeTitle.slice(seriesTitle.length);
          return /^\d{1,4}$/.test(remainder);
        });

      const conflictingTitle = requestedMetadata?.seasonEpisodeTitles?.find(
        (episodeInfo) => {
          if (!episodeInfo.title) return false;
          if (
            episodeInfo.season === requestedSeason &&
            episodeInfo.episode === requestedEpisode
          ) {
            return false;
          }

          const otherTitle = normaliseTitle(episodeInfo.title);
          if (!otherTitle) return false;

          // Some metadata providers expose a special/episode whose title is
          // literally the series title (or one of its aliases). That text is
          // present in virtually every normal release filename, so it cannot
          // safely identify a conflicting episode. Treat exact series-title
          // episode names as non-discriminating and let season/episode markers,
          // explicit special/OVA signals, and the other mismatch guards decide.
          const isSeriesTitleOnly = requestTitles.some(
            (seriesTitle) => seriesTitle === otherTitle
          );
          if (isSeriesTitleOnly) {
            return false;
          }

          const otherExact = episodeTitleCandidateForms.some((value) =>
            value.includes(otherTitle)
          );

          // Do not fuzzy-match a franchise-numbered special from the shared series
          // name alone. An actual "Series 0" release will still be caught because
          // its normalised filename literally contains the complete title.
          if (isSeriesTitlePlusNumericSuffix(otherTitle) && !otherExact) {
            return false;
          }

          const otherScore = Math.max(
            ...episodeTitleCandidateForms.map(
              (value) => partial_ratio(value, otherTitle) / 100
            )
          );

          if (otherScore < threshold) return false;

          if (otherExact && !requestedEpisodeExact) {
            return true;
          }

          // Keep mismatch-only matching conservative. Closely related titles such
          // as "Part 4" / "Part 5" should not remove the correct episode merely
          // because both clear the similarity threshold. The other title must win.
          return otherScore - requestedEpisodeScore >= 0.02;
        }
      );

      if (conflictingTitle) {
        this.incrementRemovalReason(
          'episodeTitleMatching',
          `${stream.filename || stream.parsedFile?.title || 'Unknown stream'} matched different episode title: ${conflictingTitle.title}`
        );
        return false;
      }

      const explicitEpisodeMarkerPatterns = [
        new RegExp(`\\bS0?${requestedSeason}\\s*E0?${requestedEpisode}\\b`, 'i'),
        new RegExp(`\\b0?${requestedSeason}\\s*x\\s*0?${requestedEpisode}\\b`, 'i'),
        new RegExp(`\\bseason\\s*0?${requestedSeason}\\s*(?:episode|ep)\\s*0?${requestedEpisode}\\b`, 'i'),
        new RegExp(`\\b(?:episode|ep)\\s*0?${requestedEpisode}\\b`, 'i'),
      ];

      const hasExplicitRequestedEpisodeMarker = explicitEpisodeMarkerPatterns.some((pattern) =>
        pattern.test(rawIdentityText)
      );

      const extraSignalPattern =
        /\b(ova|oad|ona|omake|specials?|recaps?|bonus|extras?|spin[ ._-]?off|chibi|movie|film|the[ ._-]?movie|pilot|trailer|teaser|pv|cm)\b/i;

      const hasAnimeExtraSignal = extraSignalPattern.test(rawIdentityText);
      const hasFilenameAnimeExtraSignal = extraSignalPattern.test(rawFilenameText || rawIdentityText);
      const hasFilenameOnlyAnimeExtraSignal = extraSignalPattern.test(filenameOnlyText || stream.parsedFile?.title || '');

      logEpisodeTitleDebug('Episode title matching computed fields', {
        filename: stream.filename,
        folderName: stream.folderName,
        originalName: stream.originalName,
        parsedTitle: stream.parsedFile?.title,
        filenameOnlyText,
        filenameAndParsedTitleText,
        rawFilenameText,
        rawIdentityText,
        primaryCandidateText,
        normalisedCandidate,
        normalisedPrimaryCandidate,
        normalisedFilenameOnly,
        normalisedFilenameAndParsedTitle,
        normalisedRawFilename,
        normalisedRawIdentity,
        rawReleaseTitle,
        rawFilenameReleaseTitle,
        filenameOnlyReleaseTitle,
        requestTitles,
        requestPrimaryTitles,
        normalisedRequestedEpisodeTitle,
        hasRequestedSeriesTitle,
        hasRequestedPrimarySeriesTitleInFilename,
        hasRequestedPrimarySeriesTitleInFilenameOnly,
        hasRequestedPrimarySeriesTitleInActualFilenameOnly,
        hasRequestedEpisodeTitle,
        hasRequestedEpisodeTitleInFilename,
        hasRequestedEpisodeTitleInFilenameOnly,
        hasRequestedEpisodeTitleInActualFilenameOnly,
        hasAnimeExtraSignal,
        hasFilenameAnimeExtraSignal,
        hasFilenameOnlyAnimeExtraSignal,
      });

      const releaseTitleLooksMeaningful =
        rawReleaseTitleWords.length >= 2 &&
        !rawReleaseTitleWords.every((word) => /^\d+$/.test(word));

      const filenameReleaseTitleLooksMeaningful =
        rawFilenameReleaseTitleWords.length >= 2 &&
        !rawFilenameReleaseTitleWords.every((word) => /^\d+$/.test(word));

      const releaseTitleHasExtraWordsBeyondRequestedTitle = requestTitles.some((title) => {
        if (!titleContains(rawReleaseTitle, title)) return false;
        const remaining = rawReleaseTitle
          .replace(new RegExp(`\\b${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), ' ')
          .split(/\s+/)
          .filter((word) => word.length > 2 && !/^\d+$/.test(word));
        return remaining.length >= 2;
      });

      if (episodeTitleMatchingOptions.mode === 'mismatchOnly') {
        // v10: make the OVA/special check use literal filename-only matches.
        // Torrent/debrid results can come from a season/franchise folder named "Overlord",
        // while the file itself is a spin-off like "Ple Ple Pleiades OVA...". The older
        // check looked at filename+folder together, so the folder title caused a false pass.
        if (
          isAnime &&
          hasFilenameOnlyAnimeExtraSignal &&
          !hasRequestedEpisodeTitleInActualFilenameOnly &&
          !hasRequestedPrimarySeriesTitleInActualFilenameOnly
        ) {
          this.incrementRemovalReason(
            'episodeTitleMatching',
            `${stream.filename || stream.parsedFile?.title || 'Unknown stream'} actual filename-only looks like a different OVA/special/movie title for the requested episode: ${requestedEpisodeTitle}`
          );
          return false;
        }

        // v2: reject generic spin-off / OVA / movie / different-title false positives.
        // This is intentionally based on the raw filename/folder/parsed title only, not on
        // display description/message text, because addon descriptions may include the requested title.
        if (
          isAnime &&
          hasFilenameAnimeExtraSignal &&
          !hasRequestedEpisodeTitleInFilename &&
          !hasRequestedPrimarySeriesTitleInFilename
        ) {
          this.incrementRemovalReason(
            'episodeTitleMatching',
            `${stream.filename || stream.parsedFile?.title || 'Unknown stream'} filename looks like a different OVA/special/movie title for the requested episode: ${requestedEpisodeTitle}`
          );
          return false;
        }

        if (
          hasAnimeExtraSignal &&
          !hasRequestedEpisodeTitle &&
          (!hasRequestedSeriesTitle || (!hasExplicitRequestedEpisodeMarker && releaseTitleHasExtraWordsBeyondRequestedTitle))
        ) {
          this.incrementRemovalReason(
            'episodeTitleMatching',
            `${stream.filename || stream.parsedFile?.title || 'Unknown stream'} looks like a different extra/special/movie title for the requested episode: ${requestedEpisodeTitle}`
          );
          return false;
        }

        if (
          !hasExplicitRequestedEpisodeMarker &&
          (releaseTitleLooksMeaningful || filenameReleaseTitleLooksMeaningful) &&
          !hasRequestedSeriesTitle &&
          !hasRequestedEpisodeTitle
        ) {
          this.incrementRemovalReason(
            'episodeTitleMatching',
            `${stream.filename || stream.parsedFile?.title || 'Unknown stream'} looks like a different title for the requested episode: ${requestedEpisodeTitle}`
          );
          return false;
        }
      }

      if (hasRequestedEpisodeTitle) {
        logEpisodeTitleDebug('Episode title matching allowed: requested episode title matched after mismatch checks', {
          filename: stream.filename,
          parsedTitle: stream.parsedFile?.title,
          rawFilenameText,
          rawIdentityText,
        });
        return true;
      }

      if (!episodeTitleMatchingOptions.strict && avoidStrictEpisodeTitleRequirement) {
        logEpisodeTitleDebug('Episode title matching allowed: non-strict pack/multi-episode passthrough', {
          filename: stream.filename,
          parsedTitle: stream.parsedFile?.title,
          parsedEpisodes: stream.parsedFile?.episodes,
          parsedSeasonPack: stream.parsedFile?.seasonPack,
          rawFilenameText,
          rawIdentityText,
        });
        return true;
      }

      if (
        episodeTitleMatchingOptions.mode === 'requireMatch' ||
        episodeTitleMatchingOptions.strict
      ) {
        this.incrementRemovalReason(
          'episodeTitleMatching',
          `${stream.filename || stream.parsedFile?.title || 'Unknown stream'} did not match requested episode title: ${requestedEpisodeTitle}`
        );
        return false;
      }

      return true;
    };

    const expressionStart = Date.now();
    const includedStreamsByExpression =
      await this.applyIncludedStreamExpressions(streams, context);
    expressionMs = Date.now() - expressionStart;
    if (includedStreamsByExpression.length > 0) {
      logger.info(
        `${includedStreamsByExpression.length} streams were included by stream expressions`
      );
    }

    // Early digital release filter check - if it returns false, filter out streams
    // except those with passthrough for 'digitalRelease' stage or those from addons not in the filter list
    if (!applyDigitalReleaseFilter()) {
      const digitalReleaseFilterAddons =
        this.userData.digitalReleaseFilter?.addons;
      const passthroughDigitalRelease = streams.filter((stream) => {
        // Check if stream has passthrough for this stage
        if (shouldPassthroughStage(stream, 'digitalRelease')) {
          return true;
        }
        // If addons filter is set and stream is not from a filtered addon, bypass
        if (
          digitalReleaseFilterAddons &&
          digitalReleaseFilterAddons.length > 0 &&
          stream.addon.preset.id &&
          !digitalReleaseFilterAddons.includes(stream.addon.preset.id)
        ) {
          return true;
        }
        return false;
      });
      const filteredCount = streams.length - passthroughDigitalRelease.length;
      if (filteredCount > 0) {
        this.filterStatistics.removed.noDigitalRelease.total = filteredCount;
        this.filterStatistics.removed.noDigitalRelease.details[
          'No digital release available'
        ] = filteredCount;
      }
      if (passthroughDigitalRelease.length > 0) {
        this.incrementIncludedReason(
          'passthrough',
          `digitalRelease (${passthroughDigitalRelease.length})`
        );
      }

      if (passthroughDigitalRelease.length === 0) {
        const finalStreams: ParsedStream[] = [];
        const totalMs = Date.now() - start;
        this.filterTimings.totalMs += totalMs;
        this.filterTimings.metadataMs += metadataMs;
        this.filterTimings.expressionMs += expressionMs;
        this.filterTimings.calls++;
        logger.info(
          `Applied basic filters in ${getTimeTakenSincePoint(start)}`
        );
        return finalStreams;
      }
      // Continue with only passthrough streams
      streams = passthroughDigitalRelease;
    }

    const regexCompileStart = Date.now();
    const excludedRegexPatterns =
      isRegexAllowed &&
      this.userData.excludedRegexPatterns &&
      this.userData.excludedRegexPatterns.length > 0
        ? await Promise.all(
            this.userData.excludedRegexPatterns.map(
              async (pattern) => await compileRegex(pattern)
            )
          )
        : undefined;

    const requiredRegexPatterns =
      isRegexAllowed &&
      this.userData.requiredRegexPatterns &&
      this.userData.requiredRegexPatterns.length > 0
        ? await Promise.all(
            this.userData.requiredRegexPatterns.map(
              async (pattern) => await compileRegex(pattern)
            )
          )
        : undefined;

    const includedRegexPatterns =
      isRegexAllowed &&
      this.userData.includedRegexPatterns &&
      this.userData.includedRegexPatterns.length > 0
        ? await Promise.all(
            this.userData.includedRegexPatterns.map(
              async (pattern) => await compileRegex(pattern)
            )
          )
        : undefined;

    const excludedKeywordsPattern =
      this.userData.excludedKeywords &&
      this.userData.excludedKeywords.length > 0
        ? await formRegexFromKeywords(this.userData.excludedKeywords)
        : undefined;

    const requiredKeywordsPattern =
      this.userData.requiredKeywords &&
      this.userData.requiredKeywords.length > 0
        ? await formRegexFromKeywords(this.userData.requiredKeywords)
        : undefined;

    const includedKeywordsPattern =
      this.userData.includedKeywords &&
      this.userData.includedKeywords.length > 0
        ? await formRegexFromKeywords(this.userData.includedKeywords)
        : undefined;
    regexCompileMs = Date.now() - regexCompileStart;

    // test many regexes against many attributes and return true if at least one regex matches any attribute
    // and false if no regex matches any attribute
    const testRegexes = (stream: ParsedStream, patterns: RegExp[]): boolean => {
      const file = stream.parsedFile;
      const stringsToTest = [
        stream.filename,
        file?.releaseGroup,
        stream.indexer,
        stream.folderName,
      ].filter((v) => v !== undefined);

      for (const string of stringsToTest) {
        for (const pattern of patterns) {
          if (pattern.test(string)) {
            return true;
          }
        }
      }
      return false;
    };

    const filterBasedOnCacheStatus = (
      stream: ParsedStream,
      mode: 'and' | 'or',
      addonIds: string[] | undefined,
      serviceIds: string[] | undefined,
      streamTypes: StreamType[] | undefined,
      cached: boolean
    ) => {
      const isAddonFilteredOut =
        addonIds &&
        addonIds.length > 0 &&
        addonIds.some((addonId) => stream.addon.preset.id === addonId) &&
        stream.service?.cached === cached;
      const isServiceFilteredOut =
        serviceIds &&
        serviceIds.length > 0 &&
        serviceIds.some((serviceId) => stream.service?.id === serviceId) &&
        stream.service?.cached === cached;
      const isStreamTypeFilteredOut =
        streamTypes &&
        streamTypes.length > 0 &&
        streamTypes.includes(stream.type) &&
        stream.service?.cached === cached;

      if (mode === 'and') {
        return !(
          isAddonFilteredOut &&
          isServiceFilteredOut &&
          isStreamTypeFilteredOut
        );
      } else {
        return !(
          isAddonFilteredOut ||
          isServiceFilteredOut ||
          isStreamTypeFilteredOut
        );
      }
    };

    const normaliseRange = (
      range: [number, number] | undefined,
      defaults: { min: number; max: number }
    ): [number | undefined, number | undefined] | undefined => {
      if (!range) return undefined;
      const [min, max] = range;
      const normMin = min === defaults.min ? undefined : min;
      const normMax = max === defaults.max ? undefined : max;
      return normMin === undefined && normMax === undefined
        ? undefined
        : [normMin, normMax];
    };

    const normaliseSeederRange = (
      seederRange: [number, number] | undefined
    ) => {
      return normaliseRange(seederRange, {
        min: constants.MIN_SEEDERS,
        max: constants.MAX_SEEDERS,
      });
    };

    const normaliseAgeRange = (ageRange: [number, number] | undefined) => {
      return normaliseRange(ageRange, {
        min: constants.MIN_AGE_HOURS,
        max: constants.MAX_AGE_HOURS,
      });
    };

    const normaliseSizeRange = (sizeRange: [number, number] | undefined) => {
      return normaliseRange(sizeRange, {
        min: constants.MIN_SIZE,
        max: constants.MAX_SIZE,
      });
    };

    const normaliseBitrateRange = (
      bitrateRange: [number, number] | undefined
    ) => {
      return normaliseRange(bitrateRange, {
        min: constants.MIN_BITRATE,
        max: constants.MAX_BITRATE,
      });
    };

    const getSeederStreamType = (
      stream: ParsedStream
    ): 'p2p' | 'cached' | 'uncached' | undefined => {
      switch (stream.type) {
        case 'debrid':
          return stream.service?.cached ? 'cached' : 'uncached';
        case 'p2p':
          return 'p2p';
        default:
          return undefined;
      }
    };

    const getAgeStreamType = (
      stream: ParsedStream
    ): 'debrid' | 'usenet' | 'p2p' | undefined => {
      switch (stream.type) {
        case 'debrid':
          return 'debrid';
        case 'usenet':
          return 'usenet';
        case 'p2p':
          return 'p2p';
        default:
          return undefined;
      }
    };

    const normaliseLooseText = (value: string | undefined): string =>
      (value ?? '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();

    const formatLanguageRemovalEvidence = (
      candidate: ParsedStream,
      languages: string[] | undefined
    ): string => {
      const languageList = languages?.length
        ? languages.join(', ')
        : 'Unknown';
      const evidenceLabel =
        candidate.mediaInfoSource === 'provider'
          ? 'Verified audio'
          : 'Parser/source languages';
      return `${evidenceLabel}: ${languageList}`;
    };

    const hasStrongEnglishAudioSignal = (stream: ParsedStream): boolean => {
      const file = stream.parsedFile;
      const languages = file?.languages ?? [];
      const languageSet = new Set(languages.map((lang) => lang.toLowerCase()));
      const originalLanguageLower = originalLanguage?.toLowerCase();

      // Provider/container media info is stronger evidence than release-name
      // heuristics. If the actual tracks say English is present, accept that as
      // a strong English-audio signal; if it is absent, do not let a filename
      // saying "Dual Audio" manufacture an English track.
      if (stream.mediaInfoSource === 'provider') {
        return languageSet.has('english');
      }

      const haystack = normaliseLooseText(
        [
          stream.filename,
          stream.folderName,
          stream.originalName,
          file?.title,
          file?.releaseGroup,
        ]
          .filter(Boolean)
          .join(' ')
      );
      const hasExplicitEnglishAudioText =
        /\b(english audio|eng audio|en audio|audio english|audio eng|audio en|english dub|eng dub|en dub|dub english|dub eng|dub en|dubbed english|dubbed eng)\b/.test(
          haystack
        );
      const hasSubtitleText =
        /\b(english subs?|eng subs?|en subs?|english subtitles?|eng subtitles?|subbed|multi subs?|multisubs?)\b/.test(
          haystack
        );
      const hasVagueAudioTag = ['dual audio', 'multi', 'dubbed', 'unknown'].some(
        (language) => languageSet.has(language)
      );

      // v7.2.12: TorBox gives us a way to inspect the exact selected file. For
      // foreign-original anime, do not let ambiguous release-name metadata such
      // as "Dual Audio + Eng Subs" manufacture an English audio track. The
      // resolver enrichment above now includes English-bearing ambiguous
      // candidates and will replace this metadata when TorBox exposes actual
      // container tracks. If it cannot, keep only an explicit English-audio/dub
      // statement as a strong fallback signal.
      if (
        isAnime &&
        originalLanguageLower &&
        originalLanguageLower !== 'english' &&
        stream.service?.id?.toLowerCase() === 'torbox' &&
        stream.torrent?.infoHash &&
        stream.torrent.fileIdx !== undefined &&
        (hasVagueAudioTag || hasSubtitleText)
      ) {
        return hasExplicitEnglishAudioText;
      }

      if (languageSet.has('dual audio') || languageSet.has('dubbed')) {
        return true;
      }

      if (languageSet.has('original') && languageSet.has('english')) {
        return true;
      }

      if (
        originalLanguageLower &&
        originalLanguageLower !== 'english' &&
        languageSet.has(originalLanguageLower) &&
        languageSet.has('english')
      ) {
        return true;
      }

      return (
        hasExplicitEnglishAudioText ||
        /\b(dual audio|dual audio eng|multi audio|multi audio eng|dubbed|dub)\b/.test(
          haystack
        )
      );
    };

    const shouldRejectLikelySubtitleOnlyEnglishAnime = (
      stream: ParsedStream
    ): boolean => {
      const file = stream.parsedFile;
      const languages = file?.languages?.length ? file.languages : ['Unknown'];

      if (!isAnime) return false;
      if (!this.userData.requiredLanguages?.includes('English' as any)) {
        return false;
      }
      if (!originalLanguage || originalLanguage === 'English') return false;
      if (!languages.includes('English' as any)) return false;

      return !hasStrongEnglishAudioSignal(stream);
    };

    const shouldAllowVerifiedJapaneseOnlyAnimeFallbackStream = (
      stream: ParsedStream
    ): boolean => {
      if (!isAnime) return false;
      if (!this.userData.requiredLanguages?.includes('English' as any)) {
        return false;
      }
      if (this.userData.requiredLanguages?.includes('Japanese' as any)) {
        return false;
      }
      if (stream.mediaInfoSource !== 'provider') return false;

      const languages = stream.parsedFile?.languages ?? [];
      const languageSet = new Set(
        languages.map((language) => language.toLowerCase())
      );
      return languageSet.has('japanese') && !languageSet.has('english');
    };

    const shouldInferJapaneseOriginalAnimeFallbackStream = (
      stream: ParsedStream
    ): boolean => {
      if (!isAnime) return false;
      if (!this.userData.requiredLanguages?.includes('English' as any)) {
        return false;
      }
      if (this.userData.requiredLanguages?.includes('Japanese' as any)) {
        return false;
      }
      if (originalLanguage?.toLowerCase() !== 'japanese') return false;
      if (stream.mediaInfoSource === 'provider') return false;
      if (stream.service?.id?.toLowerCase() !== 'torbox') return false;

      const hash = stream.torrent?.infoHash?.toLowerCase();
      const fileIdx = stream.torrent?.fileIdx;
      if (!hash || fileIdx === undefined) return false;
      if (!torboxResolverAudioLookupAttemptedFiles.has(`${hash}:${fileIdx}`)) {
        return false;
      }

      const languages = stream.parsedFile?.languages?.length
        ? stream.parsedFile.languages
        : ['Unknown'];
      const languageSet = new Set(
        languages.map((language) => language.toLowerCase())
      );

      // This inference is deliberately narrow. It only repairs streams that
      // currently claim English from ambiguous release/subtitle parsing, like
      // "Dual Audio + Eng Subs". Unknown-only or unrelated foreign-language
      // releases are still left conservative rather than being assumed Japanese.
      if (!languageSet.has('english')) return false;
      const inferenceEligibleLanguages = new Set([
        'unknown',
        'dual audio',
        'multi',
        'dubbed',
        'english',
        'japanese',
        'original',
      ]);
      if (
        [...languageSet].some(
          (language) => !inferenceEligibleLanguages.has(language)
        )
      ) {
        return false;
      }

      // Explicit English-audio/dub wording remains valid fallback evidence when
      // TorBox cannot expose media_info. Only ambiguous/subtitle-derived English
      // is downgraded to the known Japanese original language.
      return !hasStrongEnglishAudioSignal(stream);
    };

    const shouldAllowInferredJapaneseOriginalAnimeFallbackStream = (
      stream: ParsedStream
    ): boolean =>
      stream.animeLanguageFallback === 'original-language-inferred' &&
      isAnime &&
      originalLanguage?.toLowerCase() === 'japanese' &&
      !!this.userData.requiredLanguages?.includes('English' as any) &&
      !this.userData.requiredLanguages?.includes('Japanese' as any);

    const shouldAllowUnknownEnglishOriginalStream = (
      stream: ParsedStream
    ): boolean => {
      if (!this.userData.requiredLanguages?.includes('English' as any)) {
        return false;
      }
      if (!originalLanguage || originalLanguage !== 'English') {
        return false;
      }

      const languages = stream.parsedFile?.languages?.length
        ? stream.parsedFile.languages
        : ['Unknown'];

      if (languages.includes('English' as any)) {
        return true;
      }

      // Many older English-language TV/movie releases do not carry a language
      // marker in the filename, so parser output becomes Unknown or Multi even
      // though the content metadata itself says the original language is English.
      // Allow only vague language values here; still reject explicit non-English
      // languages such as Russian/Italian when English is required.
      const allowedVagueLanguages = new Set(['Unknown', 'Multi', 'Original']);
      return languages.every((lang) => allowedVagueLanguages.has(lang));
    };

    const requestedTitleLooksLikeAnimeSpecial = (): boolean => {
      if (!isAnime || !requestedEpisodeTitle) return false;

      const requestedSeason = Number.isInteger(Number(parsedId?.season))
        ? Number(parsedId?.season)
        : undefined;

      return (
        requestedSeason === 0 ||
        /\b(ova|oad|ona|specials?|extra|bonus|digressions?|tales?|visions?|journals?|movie|film|coleus|veldora|scarlet[ ._-]?bond)\b/i.test(
          requestedEpisodeTitle
        )
      );
    };

    const streamLooksLikeRequestedAnimeSpecial = (
      stream: ParsedStream
    ): boolean => {
      if (!requestedTitleLooksLikeAnimeSpecial()) return false;

      const requestedEpisodeTitleNormalised = requestedEpisodeTitle
        ? normaliseTitle(requestedEpisodeTitle)
        : '';
      const streamSpecialIdentityText = [
        stream.filename,
        stream.folderName,
        stream.originalName,
        stream.parsedFile?.title,
      ]
        .filter((value): value is string =>
          typeof value === 'string' && value.trim().length > 0
        )
        .join(' ');
      const streamSpecialIdentityNormalised = normaliseTitle(
        streamSpecialIdentityText
      );

      return (
        !!streamSpecialIdentityText &&
        ((requestedEpisodeTitleNormalised &&
          (streamSpecialIdentityNormalised.includes(
            requestedEpisodeTitleNormalised
          ) ||
            partial_ratio(
              streamSpecialIdentityNormalised,
              requestedEpisodeTitleNormalised
            ) /
              100 >=
              0.82)) ||
          /\b(ova|oad|ona|specials?|extra|bonus|digressions?|tales?|visions?|journals?|movie|film|coleus|veldora|scarlet[ ._-]?bond)\b/i.test(
            streamSpecialIdentityText
          ))
      );
    };

    const shouldAllowAnimeSpecialUnknownLanguageFallbackStream = (
      stream: ParsedStream
    ): boolean => {
      if (!this.userData.requiredLanguages?.includes('English' as any)) {
        return false;
      }
      if (!isAnime) return false;
      if (!originalLanguage || originalLanguage === 'English') return false;
      if (!requestedTitleLooksLikeAnimeSpecial()) return false;
      if (!streamLooksLikeRequestedAnimeSpecial(stream)) return false;

      const languages = stream.parsedFile?.languages?.length
        ? stream.parsedFile.languages
        : ['Unknown'];

      // v14: last-resort anime special/movie fallback. Some special/movie entries
      // have a single cached candidate where the provider exposes no useful
      // language metadata at all, so it parses as Unknown. Allow Unknown only for
      // anime special/movie requests whose stream already looks like the requested
      // special; do not allow Unknown globally or for normal anime episodes.
      return languages.every((lang) => lang === 'Unknown');
    };

    const shouldAllowForeignOriginalUnknownLanguageFallbackStream = (
      stream: ParsedStream
    ): boolean => {
      if (!allowForeignOriginalUnknownLanguageFallback) {
        return false;
      }
      if (!this.userData.requiredLanguages?.includes('English' as any)) {
        return false;
      }
      if (!originalLanguage || originalLanguage === 'English') {
        return false;
      }

      const languages = stream.parsedFile?.languages?.length
        ? stream.parsedFile.languages
        : ['Unknown'];

      // Optional fallback for foreign-original shows/movies with no confirmed
      // English links. Disabled by default because Unknown is not a real
      // language signal; enable only for a multilingual/last-resort config with
      // ALLOW_FOREIGN_ORIGINAL_UNKNOWN_LANGUAGE_FALLBACK=true.
      return languages.every((lang) => lang === 'Unknown');
    };

    const isTorboxStream = (stream: ParsedStream): boolean => {
      if (stream.service?.id?.toLowerCase() === 'torbox') {
        return true;
      }

      const bingeGroupParts = (stream.bingeGroup ?? '')
        .toLowerCase()
        .split('|')
        .map((part) => part.trim());

      if (bingeGroupParts.includes('torbox')) {
        return true;
      }

      const urlText = `${stream.url ?? ''} ${stream.externalUrl ?? ''}`.toLowerCase();
      return /\/resolve\/torbox\//.test(urlText) || /[?&]service=torbox\b/.test(urlText);
    };

    const getStreamUrlText = (stream: ParsedStream): string =>
      `${stream.url ?? ''} ${stream.externalUrl ?? ''}`.toLowerCase();

    const isAIOStreamsDebridPlaybackStream = (stream: ParsedStream): boolean =>
      /\/api\/v1\/debrid\/playback\//.test(getStreamUrlText(stream));

    const isTorrentioResolveStream = (stream: ParsedStream): boolean => {
      const urlText = getStreamUrlText(stream);
      return /torrentio\.strem\.fun/.test(urlText) && /\/resolve\//.test(urlText);
    };

    const normaliseStreamIdentity = (value: string | undefined): string =>
      (value ?? '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\.(mkv|mp4|avi|mov|wmv|m4v)$/i, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();

    const getDuplicateKey = (stream: ParsedStream): string | undefined => {
      // Hash + file index is the strongest identity available for a resolver
      // stream. Prefer it over display/filename text so the same torrent file
      // returned through native AIOStreams and Torrentio is recognised even if
      // the two addons format the release name differently. Never collapse a
      // season pack by hash alone when a file index is unavailable.
      const hash = stream.torrent?.infoHash || stream.videoHash;
      const fileIdx = stream.torrent?.fileIdx;
      if (hash && fileIdx !== undefined) {
        return `hash:${hash.toLowerCase()}:file:${fileIdx}`;
      }

      const filenameKey = normaliseStreamIdentity(
        stream.filename || stream.parsedFile?.title || stream.originalName
      );
      if (filenameKey.length >= 12) {
        return `name:${filenameKey}`;
      }

      return undefined;
    };

    const animePlaybackPreferenceScore = (stream: ParsedStream): number => {
      let score = 0;

      if (isAIOStreamsDebridPlaybackStream(stream)) score += 1000;
      if (isTorrentioResolveStream(stream)) score -= 250;

      if (stream.service?.id?.toLowerCase() === 'realdebrid') score += 80;
      if (isTorboxStream(stream)) score -= 20;

      const encode = stream.parsedFile?.encode?.toLowerCase();
      const quality = stream.parsedFile?.quality?.toLowerCase();
      const fileText = normaliseStreamIdentity(
        `${stream.filename ?? ''} ${stream.parsedFile?.title ?? ''}`
      );

      if (quality?.includes('web')) score += 30;
      if (quality?.includes('bluray remux')) score -= 20;
      if (encode === 'avc') score += 10;
      if (encode === 'hevc') score -= 5;
      if (encode === 'av1') score -= 35;
      if (/\b(yameii|toonshub)\b/.test(fileText)) score += 25;

      return score;
    };

    const optimiseAnimePlaybackStreams = (streamsToOptimise: ParsedStream[]): ParsedStream[] => {
      if (!isAnime) return streamsToOptimise;

      let result = [...streamsToOptimise];

      if (preferAIOStreamsPlaybackForAnime) {
        const groups = new Map<string, ParsedStream[]>();
        for (const stream of result) {
          const key = getDuplicateKey(stream);
          if (!key) continue;
          const existing = groups.get(key) ?? [];
          existing.push(stream);
          groups.set(key, existing);
        }

        const removeDuplicateIds = new Set<string>();
        for (const group of groups.values()) {
          const hasAIOStreamsPlayback = group.some(isAIOStreamsDebridPlaybackStream);
          if (!hasAIOStreamsPlayback) continue;

          for (const stream of group) {
            if (
              isTorrentioResolveStream(stream) &&
              !isAIOStreamsDebridPlaybackStream(stream) &&
              !shouldPassthroughStage(stream, 'filter')
            ) {
              removeDuplicateIds.add(stream.id);
            }
          }
        }

        if (removeDuplicateIds.size > 0) {
          for (const stream of result) {
            if (removeDuplicateIds.has(stream.id)) {
              this.incrementRemovalReason(
                'excludedFilterCondition',
                'Duplicate Torrentio resolver hidden; AIOStreams debrid playback preferred'
              );
            }
          }
          result = result.filter((stream) => !removeDuplicateIds.has(stream.id));
        }

        result.sort(
          (a, b) =>
            animePlaybackPreferenceScore(b) - animePlaybackPreferenceScore(a)
        );
      }

      if (torrentioAnimeResolveMode === 'block') {
        const kept: ParsedStream[] = [];
        for (const stream of result) {
          if (isTorrentioResolveStream(stream) && !shouldPassthroughStage(stream, 'filter')) {
            this.incrementRemovalReason(
              'excludedFilterCondition',
              'Torrentio resolver blocked for anime'
            );
            continue;
          }
          kept.push(stream);
        }
        result = kept;
      } else if (torrentioAnimeResolveMode === 'fallback') {
        const nonTorrentioResolve = result.filter(
          (stream) => !isTorrentioResolveStream(stream)
        );
        const torrentioResolve = result.filter(isTorrentioResolveStream);

        if (nonTorrentioResolve.length > 0 && torrentioResolve.length > 0) {
          for (const stream of torrentioResolve) {
            if (!shouldPassthroughStage(stream, 'filter')) {
              this.incrementRemovalReason(
                'excludedFilterCondition',
                'Torrentio resolver hidden for anime; AIOStreams/non-Torrentio playback available'
              );
            }
          }
          result = [
            ...nonTorrentioResolve,
            ...torrentioResolve.filter((stream) => shouldPassthroughStage(stream, 'filter')),
          ];
        }
      } else if (torrentioAnimeResolveMode === 'demote') {
        result = [
          ...result.filter((stream) => !isTorrentioResolveStream(stream)),
          ...result.filter((stream) => isTorrentioResolveStream(stream)),
        ];
      }

      if (torboxAnimeMode === 'block') {
        const kept: ParsedStream[] = [];
        for (const stream of result) {
          if (isTorboxStream(stream) && !shouldPassthroughStage(stream, 'filter')) {
            this.incrementRemovalReason(
              'excludedFilterCondition',
              'TorBox blocked for anime'
            );
            continue;
          }
          kept.push(stream);
        }
        result = kept;
      } else if (torboxAnimeMode === 'fallback') {
        const nonTorbox = result.filter((stream) => !isTorboxStream(stream));
        const torbox = result.filter((stream) => isTorboxStream(stream));

        if (nonTorbox.length > 0 && torbox.length > 0) {
          for (const stream of torbox) {
            if (!shouldPassthroughStage(stream, 'filter')) {
              this.incrementRemovalReason(
                'excludedFilterCondition',
                'TorBox hidden for anime; non-TorBox fallback available'
              );
            }
          }
          result = [
            ...nonTorbox,
            ...torbox.filter((stream) => shouldPassthroughStage(stream, 'filter')),
          ];
        }
      } else if (torboxAnimeMode === 'demote') {
        result = [
          ...result.filter((stream) => !isTorboxStream(stream)),
          ...result.filter((stream) => isTorboxStream(stream)),
        ];
      }

      return result;
    };

    const shouldKeepStream = (stream: ParsedStream): boolean => {
      const file = stream.parsedFile;

      // v7.2.13: if TorBox selected-file media-info was actually queried but
      // returned no usable audio tracks, do not discard an otherwise valid
      // Japanese-original anime stream merely because release parsing produced
      // false English from ambiguous text such as "Dual Audio + Eng Subs".
      // Replace that unverified release-language guess with the known original
      // language and retain it only as a bottom-ranked inferred fallback.
      if (
        file &&
        shouldInferJapaneseOriginalAnimeFallbackStream(stream)
      ) {
        file.languages = ['Japanese', 'Original'];
        stream.animeLanguageFallback = 'original-language-inferred';
        logEpisodeTitleDebug(
          'Inferred Japanese-original anime fallback after TorBox audio lookup returned no usable tracks',
          {
            filename: stream.filename,
            folderName: stream.folderName,
            originalName: stream.originalName,
            mediaInfoSource: stream.mediaInfoSource ?? 'release',
            originalLanguage,
          }
        );
      }

      const skipLanguageFiltering = shouldPassthroughStage(stream, 'language');
      const skipSubtitleFiltering = shouldPassthroughStage(stream, 'subtitle');

      if (originalLanguage && LANGUAGES.includes(originalLanguage as any)) {
        if (
          file?.languages &&
          file?.languages.length > 0 &&
          file?.languages.includes(originalLanguage)
        ) {
          file.languages.push('Original');
        }
      }
      // Temporarily add in our fake visual tags used for sorting/filtering
      // HDR+DV
      if (
        file?.visualTags?.some((tag) => tag.startsWith('HDR')) &&
        file?.visualTags?.some((tag) => tag.startsWith('DV'))
      ) {
        const hdrIndex = file?.visualTags?.findIndex((tag) =>
          tag.startsWith('HDR')
        );
        const dvIndex = file?.visualTags?.findIndex((tag) =>
          tag.startsWith('DV')
        );
        const insertIndex = Math.min(hdrIndex, dvIndex);
        file?.visualTags?.splice(insertIndex, 0, 'HDR+DV');
      }
      // DV Only
      if (
        file?.visualTags?.some((tag) => tag.startsWith('DV')) &&
        !file?.visualTags?.some((tag) => tag.startsWith('HDR'))
      ) {
        file?.visualTags?.push('DV Only');
      }
      // HDR Only
      if (
        file?.visualTags?.some((tag) => tag.startsWith('HDR')) &&
        !file?.visualTags?.some((tag) => tag.startsWith('DV'))
      ) {
        file?.visualTags?.push('HDR Only');
      }

      if (shouldPassthroughStage(stream, 'filter')) {
        this.incrementIncludedReason('passthrough', stream.addon.name);
        return true;
      }

      // carry out include checks first
      if (this.userData.includedStreamTypes?.includes(stream.type)) {
        this.incrementIncludedReason('streamType', stream.type);
        return true;
      }

      if (
        this.userData.includedResolutions?.includes(
          file?.resolution || ('Unknown' as any)
        )
      ) {
        const resolution = this.userData.includedResolutions.find(
          (resolution) => (file?.resolution || 'Unknown') === resolution
        );
        if (resolution) {
          this.incrementIncludedReason('resolution', resolution);
        }
        return true;
      }

      if (
        this.userData.includedQualities?.includes(
          file?.quality || ('Unknown' as any)
        )
      ) {
        const quality = this.userData.includedQualities.find(
          (quality) => (file?.quality || 'Unknown') === quality
        );
        if (quality) {
          this.incrementIncludedReason('quality', quality);
        }
        return true;
      }

      if (
        this.userData.includedVisualTags?.some((tag) =>
          (file?.visualTags.length ? file.visualTags : ['Unknown']).includes(
            tag
          )
        )
      ) {
        const tag = this.userData.includedVisualTags.find((tag) =>
          (file?.visualTags.length ? file.visualTags : ['Unknown']).includes(
            tag
          )
        );
        if (tag) {
          this.incrementIncludedReason('visualTag', tag);
        }
        return true;
      }

      if (
        this.userData.includedAudioTags?.some((tag) =>
          (file?.audioTags.length ? file.audioTags : ['Unknown']).includes(tag)
        )
      ) {
        const tag = this.userData.includedAudioTags.find((tag) =>
          (file?.audioTags.length ? file.audioTags : ['Unknown']).includes(tag)
        );
        if (tag) {
          this.incrementIncludedReason('audioTag', tag);
        }
        return true;
      }

      if (
        this.userData.includedAudioChannels?.some((channel) =>
          (file?.audioChannels.length
            ? file.audioChannels
            : ['Unknown']
          ).includes(channel)
        )
      ) {
        const channel = this.userData.includedAudioChannels.find((channel) =>
          (file?.audioChannels.length
            ? file.audioChannels
            : ['Unknown']
          ).includes(channel)
        );
        this.incrementIncludedReason('audioChannel', channel!);
        return true;
      }

      if (
        !skipLanguageFiltering &&
        this.userData.includedLanguages?.some((lang) =>
          (file?.languages.length ? file.languages : ['Unknown']).includes(lang)
        )
      ) {
        const lang = this.userData.includedLanguages.find((lang) =>
          (file?.languages.length ? file.languages : ['Unknown']).includes(lang)
        );
        this.incrementIncludedReason('language', lang!);
        return true;
      }

      if (
        !skipSubtitleFiltering &&
        this.userData.includedSubtitles?.some((lang) =>
          (file?.subtitles?.length ? file.subtitles : ['Unknown']).includes(
            lang
          )
        )
      ) {
        const lang = this.userData.includedSubtitles.find((lang) =>
          (file?.subtitles?.length ? file.subtitles : ['Unknown']).includes(
            lang
          )
        );
        this.incrementIncludedReason('subtitle', lang!);
        return true;
      }

      if (
        this.userData.includedReleaseGroups?.some(
          (group) =>
            (file?.releaseGroup || 'Unknown').toLowerCase() ===
            group.toLowerCase()
        )
      ) {
        const group = this.userData.includedReleaseGroups.find(
          (group) =>
            (file?.releaseGroup || 'Unknown').toLowerCase() ===
            group.toLowerCase()
        );
        this.incrementIncludedReason('releaseGroup', group!);
        return true;
      }

      if (
        this.userData.includedEncodes?.some(
          (encode) => (file?.encode || 'Unknown') === encode
        )
      ) {
        const encode = this.userData.includedEncodes.find(
          (encode) => (file?.encode || 'Unknown') === encode
        );
        if (encode) {
          this.incrementIncludedReason('encode', encode);
        }
        return true;
      }

      if (
        includedRegexPatterns &&
        regexDecisionsMap.get(stream.id)?.includedByRegex
      ) {
        this.incrementIncludedReason('regex', includedRegexPatterns[0].source);
        return true;
      }

      if (
        includedKeywordsPattern &&
        regexDecisionsMap.get(stream.id)?.includedByKeywords
      ) {
        this.incrementIncludedReason(
          'keywords',
          includedKeywordsPattern.source
        );
        return true;
      }

      const includedSeederRange = normaliseSeederRange(
        this.userData.includeSeederRange
      );
      const excludedSeederRange = normaliseSeederRange(
        this.userData.excludeSeederRange
      );
      const requiredSeederRange = normaliseSeederRange(
        this.userData.requiredSeederRange
      );

      const includedAgeRange = normaliseAgeRange(this.userData.includeAgeRange);
      const excludedAgeRange = normaliseAgeRange(this.userData.excludeAgeRange);
      const requiredAgeRange = normaliseAgeRange(
        this.userData.requiredAgeRange
      );

      const typeForSeederRange = getSeederStreamType(stream);
      const typeForAgeRange = getAgeStreamType(stream);

      if (
        includedSeederRange &&
        (!this.userData.seederRangeTypes?.length ||
          (typeForSeederRange &&
            this.userData.seederRangeTypes.includes(typeForSeederRange)))
      ) {
        if (
          includedSeederRange[0] &&
          (stream.torrent?.seeders ?? 0) > includedSeederRange[0]
        ) {
          this.incrementIncludedReason('seeder', `>${includedSeederRange[0]}`);
          return true;
        }
        if (
          includedSeederRange[1] &&
          (stream.torrent?.seeders ?? 0) < includedSeederRange[1]
        ) {
          this.incrementIncludedReason('seeder', `<${includedSeederRange[1]}`);
          return true;
        }
      }

      if (
        includedAgeRange &&
        (!this.userData.ageRangeTypes?.length ||
          (typeForAgeRange &&
            this.userData.ageRangeTypes.includes(typeForAgeRange)))
      ) {
        if (includedAgeRange[0] && (stream.age ?? 0) > includedAgeRange[0]) {
          this.incrementIncludedReason('age', `>${includedAgeRange[0]}h`);
          return true;
        }
        if (includedAgeRange[1] && (stream.age ?? 0) < includedAgeRange[1]) {
          this.incrementIncludedReason('age', `<${includedAgeRange[1]}h`);
          return true;
        }
      }

      // Skip stream type filtering for P2P streams when service wrapping is enabled.
      // These will be converted to debrid streams by _resolveServiceWrappedStreams later.
      const skipStreamTypeFilter =
        stream.type === 'p2p' && this.userData.serviceWrap?.enabled;

      if (
        !skipStreamTypeFilter &&
        this.userData.excludedStreamTypes?.includes(stream.type)
      ) {
        // Track stream type exclusions
        this.incrementRemovalReason('excludedStreamType', stream.type);
        return false;
      }

      // Track required stream type misses
      if (
        !skipStreamTypeFilter &&
        this.userData.requiredStreamTypes &&
        this.userData.requiredStreamTypes.length > 0 &&
        !this.userData.requiredStreamTypes.includes(stream.type)
      ) {
        this.incrementRemovalReason('requiredStreamType', stream.type);
        return false;
      }

      // info type streams can bypass remaining filters
      if (stream.type === 'info') {
        this.incrementIncludedReason('streamType', 'info');
        return true;
      }

      // Resolutions
      if (
        this.userData.excludedResolutions?.includes(
          (file?.resolution || 'Unknown') as any
        )
      ) {
        this.incrementRemovalReason(
          'excludedResolution',
          file?.resolution || 'Unknown'
        );
        return false;
      }

      if (
        this.userData.requiredResolutions &&
        this.userData.requiredResolutions.length > 0 &&
        !this.userData.requiredResolutions.includes(
          (file?.resolution || 'Unknown') as any
        )
      ) {
        this.incrementRemovalReason(
          'requiredResolution',
          file?.resolution || 'Unknown'
        );
        return false;
      }

      // Qualities
      if (
        this.userData.excludedQualities?.includes(
          (file?.quality || 'Unknown') as any
        )
      ) {
        this.incrementRemovalReason(
          'excludedQuality',
          file?.quality || 'Unknown'
        );
        return false;
      }

      if (
        this.userData.requiredQualities &&
        this.userData.requiredQualities.length > 0 &&
        !this.userData.requiredQualities.includes(
          (file?.quality || 'Unknown') as any
        )
      ) {
        this.incrementRemovalReason(
          'requiredQuality',
          file?.quality || 'Unknown'
        );
        return false;
      }

      // encode
      if (
        this.userData.excludedEncodes?.includes(
          file?.encode || ('Unknown' as any)
        )
      ) {
        this.incrementRemovalReason(
          'excludedEncode',
          file?.encode || 'Unknown'
        );
        return false;
      }

      if (
        this.userData.requiredEncodes &&
        this.userData.requiredEncodes.length > 0 &&
        !this.userData.requiredEncodes.includes(
          file?.encode || ('Unknown' as any)
        )
      ) {
        this.incrementRemovalReason(
          'requiredEncode',
          file?.encode || 'Unknown'
        );
        return false;
      }

      if (
        this.userData.excludedVisualTags?.some((tag) =>
          (file?.visualTags.length ? file.visualTags : ['Unknown']).includes(
            tag
          )
        )
      ) {
        const tag = this.userData.excludedVisualTags.find((tag) =>
          (file?.visualTags.length ? file.visualTags : ['Unknown']).includes(
            tag
          )
        );
        this.incrementRemovalReason('excludedVisualTag', tag!);
        return false;
      }

      if (
        this.userData.requiredVisualTags &&
        this.userData.requiredVisualTags.length > 0 &&
        !this.userData.requiredVisualTags.some((tag) =>
          (file?.visualTags.length ? file.visualTags : ['Unknown']).includes(
            tag
          )
        )
      ) {
        this.incrementRemovalReason(
          'requiredVisualTag',
          file?.visualTags.length ? file.visualTags.join(', ') : 'Unknown'
        );
        return false;
      }

      if (
        this.userData.excludedAudioTags?.some((tag) =>
          (file?.audioTags.length ? file.audioTags : ['Unknown']).includes(tag)
        )
      ) {
        const tag = this.userData.excludedAudioTags.find((tag) =>
          (file?.audioTags.length ? file.audioTags : ['Unknown']).includes(tag)
        );
        this.incrementRemovalReason('excludedAudioTag', tag!);
        return false;
      }

      if (
        this.userData.requiredAudioTags &&
        this.userData.requiredAudioTags.length > 0 &&
        !this.userData.requiredAudioTags.some((tag) =>
          (file?.audioTags.length ? file.audioTags : ['Unknown']).includes(tag)
        )
      ) {
        this.incrementRemovalReason(
          'requiredAudioTag',
          file?.audioTags.length ? file.audioTags.join(', ') : 'Unknown'
        );
        return false;
      }

      if (
        this.userData.excludedAudioChannels?.some((channel) =>
          (file?.audioChannels.length
            ? file.audioChannels
            : ['Unknown']
          ).includes(channel)
        )
      ) {
        const channel = this.userData.excludedAudioChannels.find((channel) =>
          (file?.audioChannels.length
            ? file.audioChannels
            : ['Unknown']
          ).includes(channel)
        );
        this.incrementRemovalReason('excludedAudioChannel', channel!);
        return false;
      }

      if (
        this.userData.requiredAudioChannels &&
        this.userData.requiredAudioChannels.length > 0 &&
        !this.userData.requiredAudioChannels.some((channel) =>
          (file?.audioChannels.length
            ? file.audioChannels
            : ['Unknown']
          ).includes(channel)
        )
      ) {
        this.incrementRemovalReason(
          'requiredAudioChannel',
          file?.audioChannels.length ? file.audioChannels.join(', ') : 'Unknown'
        );
        return false;
      }

      // languages
      if (
        !skipLanguageFiltering &&
        this.userData.excludedLanguages?.length &&
        (file?.languages.length ? file.languages : ['Unknown']).every((lang) =>
          this.userData.excludedLanguages!.includes(lang as any)
        )
      ) {
        this.incrementRemovalReason(
          'excludedLanguage',
          formatLanguageRemovalEvidence(stream, file?.languages)
        );
        return false;
      }

      if (
        !skipLanguageFiltering &&
        this.userData.requiredLanguages &&
        this.userData.requiredLanguages.length > 0 &&
        !this.userData.requiredLanguages.some((lang) =>
          (file?.languages.length ? file.languages : ['Unknown']).includes(lang)
        ) &&
        !shouldAllowUnknownEnglishOriginalStream(stream) &&
        !shouldAllowVerifiedJapaneseOnlyAnimeFallbackStream(stream) &&
        !shouldAllowInferredJapaneseOriginalAnimeFallbackStream(stream) &&
        !shouldAllowAnimeSpecialUnknownLanguageFallbackStream(stream) &&
        !shouldAllowForeignOriginalUnknownLanguageFallbackStream(stream)
      ) {
        this.incrementRemovalReason(
          'requiredLanguage',
          formatLanguageRemovalEvidence(stream, file?.languages)
        );
        return false;
      }

      if (
        !skipLanguageFiltering &&
        shouldAllowVerifiedJapaneseOnlyAnimeFallbackStream(stream)
      ) {
        logEpisodeTitleDebug(
          'Language filter allowed verified Japanese-only anime fallback stream',
          {
            filename: stream.filename,
            folderName: stream.folderName,
            originalName: stream.originalName,
            parsedLanguages: file?.languages,
            mediaInfoSource: stream.mediaInfoSource,
            originalLanguage,
          }
        );
      }

      if (
        !skipLanguageFiltering &&
        shouldAllowInferredJapaneseOriginalAnimeFallbackStream(stream)
      ) {
        logEpisodeTitleDebug(
          'Language filter allowed inferred Japanese-original anime fallback stream',
          {
            filename: stream.filename,
            folderName: stream.folderName,
            originalName: stream.originalName,
            parsedLanguages: file?.languages,
            fallbackSource: stream.animeLanguageFallback,
            originalLanguage,
          }
        );
      }

      if (
        !skipLanguageFiltering &&
        shouldAllowUnknownEnglishOriginalStream(stream)
      ) {
        logEpisodeTitleDebug('Language filter allowed English-original stream with vague language metadata', {
          filename: stream.filename,
          folderName: stream.folderName,
          originalName: stream.originalName,
          parsedLanguages: file?.languages,
          originalLanguage,
        });
      }

      if (
        !skipLanguageFiltering &&
        shouldAllowAnimeSpecialUnknownLanguageFallbackStream(stream)
      ) {
        logEpisodeTitleDebug('Language filter allowed anime special Unknown-language fallback stream', {
          filename: stream.filename,
          folderName: stream.folderName,
          originalName: stream.originalName,
          parsedTitle: stream.parsedFile?.title,
          parsedLanguages: file?.languages,
          requestedEpisodeTitle,
          originalLanguage,
        });
      }

      if (
        !skipLanguageFiltering &&
        shouldAllowForeignOriginalUnknownLanguageFallbackStream(stream)
      ) {
        logEpisodeTitleDebug('Language filter allowed foreign-original Unknown-language fallback stream', {
          filename: stream.filename,
          folderName: stream.folderName,
          originalName: stream.originalName,
          parsedTitle: stream.parsedFile?.title,
          parsedLanguages: file?.languages,
          originalLanguage,
        });
      }

      if (
        !skipLanguageFiltering &&
        shouldRejectLikelySubtitleOnlyEnglishAnime(stream)
      ) {
        const languageEvidence = formatLanguageRemovalEvidence(
          stream,
          file?.languages
        );
        this.incrementRemovalReason(
          'requiredLanguage',
          `${languageEvidence}\n      → English audio unconfirmed; likely subtitle/source metadata`
        );
        logEpisodeTitleDebug('Language filter rejected likely subtitle-only English anime stream', {
          filename: stream.filename,
          folderName: stream.folderName,
          originalName: stream.originalName,
          parsedLanguages: file?.languages,
          parsedSubtitles: file?.subtitles,
          mediaInfoSource: stream.mediaInfoSource ?? 'release',
          originalLanguage,
        });
        return false;
      }

      // subtitles
      if (
        !skipSubtitleFiltering &&
        this.userData.excludedSubtitles?.length &&
        (file?.subtitles?.length ? file.subtitles : ['Unknown']).every((sub) =>
          this.userData.excludedSubtitles!.includes(sub as any)
        )
      ) {
        this.incrementRemovalReason(
          'excludedSubtitle',
          file?.subtitles?.length ? file.subtitles.join(', ') : 'Unknown'
        );
        return false;
      }

      if (
        !skipSubtitleFiltering &&
        this.userData.requiredSubtitles &&
        this.userData.requiredSubtitles.length > 0 &&
        !this.userData.requiredSubtitles.some((sub) =>
          (file?.subtitles?.length ? file.subtitles : ['Unknown']).includes(sub)
        )
      ) {
        this.incrementRemovalReason(
          'requiredSubtitle',
          file?.subtitles?.length ? file.subtitles.join(', ') : 'Unknown'
        );
        return false;
      }

      // release group
      if (
        this.userData.excludedReleaseGroups?.some(
          (group) =>
            (file?.releaseGroup || 'Unknown').toLowerCase() ===
            group.toLowerCase()
        )
      ) {
        this.incrementRemovalReason(
          'excludedReleaseGroup',
          file?.releaseGroup || 'Unknown'
        );
        return false;
      }

      if (
        this.userData.requiredReleaseGroups &&
        this.userData.requiredReleaseGroups.length > 0 &&
        !this.userData.requiredReleaseGroups.some(
          (group) =>
            (file?.releaseGroup || 'Unknown').toLowerCase() ===
            group.toLowerCase()
        )
      ) {
        this.incrementRemovalReason(
          'requiredReleaseGroup',
          file?.releaseGroup || 'Unknown'
        );
        return false;
      }

      // uncached

      if (this.userData.excludeUncached && stream.service?.cached === false) {
        this.incrementRemovalReason('excludedUncached');
        return false;
      }

      if (this.userData.excludeCached && stream.service?.cached === true) {
        this.incrementRemovalReason('excludedCached');
        return false;
      }

      if (
        filterBasedOnCacheStatus(
          stream,
          this.userData.excludeCachedMode || 'or',
          this.userData.excludeCachedFromAddons,
          this.userData.excludeCachedFromServices,
          this.userData.excludeCachedFromStreamTypes,
          true
        ) === false
      ) {
        this.incrementRemovalReason('excludedCached');
        return false;
      }

      if (
        filterBasedOnCacheStatus(
          stream,
          this.userData.excludeUncachedMode || 'or',
          this.userData.excludeUncachedFromAddons,
          this.userData.excludeUncachedFromServices,
          this.userData.excludeUncachedFromStreamTypes,
          false
        ) === false
      ) {
        this.incrementRemovalReason('excludedUncached');
        return false;
      }

      if (
        this.userData.excludeSeasonPacks &&
        type === 'series' &&
        stream.parsedFile?.seasons?.length &&
        !stream.parsedFile?.episodes?.length
      ) {
        const seasons = stream.parsedFile?.seasons;
        const seasonStr =
          seasons?.length === 1
            ? `S${String(seasons[0]).padStart(2, '0')}`
            : seasons?.length
              ? `S${String(seasons[0]).padStart(2, '0')}-${String(seasons[seasons.length - 1]).padStart(2, '0')}`
              : undefined;
        this.incrementRemovalReason(
          'excludeSeasonPacks',
          `${stream.parsedFile.title} - ${seasonStr}`
        );
        return false;
      }

      if (
        excludedRegexPatterns &&
        regexDecisionsMap.get(stream.id)?.excludedByRegex
      ) {
        this.incrementRemovalReason('excludedRegex');
        return false;
      }
      if (
        requiredRegexPatterns &&
        requiredRegexPatterns.length > 0 &&
        !regexDecisionsMap.get(stream.id)?.requiredByRegex
      ) {
        this.incrementRemovalReason('requiredRegex');
        return false;
      }

      if (
        excludedKeywordsPattern &&
        regexDecisionsMap.get(stream.id)?.excludedByKeywords
      ) {
        this.incrementRemovalReason('excludedKeywords');
        return false;
      }

      if (
        requiredKeywordsPattern &&
        !regexDecisionsMap.get(stream.id)?.requiredByKeywords
      ) {
        this.incrementRemovalReason('requiredKeywords');
        return false;
      }

      if (
        requiredSeederRange &&
        (!this.userData.seederRangeTypes?.length ||
          (typeForSeederRange &&
            this.userData.seederRangeTypes.includes(typeForSeederRange)))
      ) {
        if (
          requiredSeederRange[0] &&
          (stream.torrent?.seeders ?? 0) < requiredSeederRange[0]
        ) {
          this.incrementRemovalReason(
            'requiredSeederRange',
            `< ${requiredSeederRange[0]}`
          );
          return false;
        }
        if (
          stream.torrent?.seeders !== undefined &&
          requiredSeederRange[1] &&
          (stream.torrent?.seeders ?? 0) > requiredSeederRange[1]
        ) {
          this.incrementRemovalReason(
            'requiredSeederRange',
            `> ${requiredSeederRange[1]}`
          );
          return false;
        }
      }

      if (
        excludedSeederRange &&
        (!this.userData.seederRangeTypes?.length ||
          (typeForSeederRange &&
            this.userData.seederRangeTypes.includes(typeForSeederRange)))
      ) {
        if (
          excludedSeederRange[0] &&
          (stream.torrent?.seeders ?? 0) > excludedSeederRange[0]
        ) {
          this.incrementRemovalReason(
            'excludedSeederRange',
            `< ${excludedSeederRange[0]}`
          );
          return false;
        }
        if (
          excludedSeederRange[1] &&
          (stream.torrent?.seeders ?? 0) < excludedSeederRange[1]
        ) {
          this.incrementRemovalReason(
            'excludedSeederRange',
            `> ${excludedSeederRange[1]}`
          );
          return false;
        }
      }

      if (
        requiredAgeRange &&
        (!this.userData.ageRangeTypes?.length ||
          (typeForAgeRange &&
            this.userData.ageRangeTypes.includes(typeForAgeRange)))
      ) {
        if (requiredAgeRange[0] && (stream.age ?? 0) < requiredAgeRange[0]) {
          this.incrementRemovalReason(
            'requiredAgeRange',
            `< ${requiredAgeRange[0]}h`
          );
          return false;
        }
        if (
          stream.age !== undefined &&
          requiredAgeRange[1] &&
          (stream.age ?? 0) > requiredAgeRange[1]
        ) {
          this.incrementRemovalReason(
            'requiredAgeRange',
            `> ${requiredAgeRange[1]}h`
          );
          return false;
        }
      }

      if (
        excludedAgeRange &&
        (!this.userData.ageRangeTypes?.length ||
          (typeForAgeRange &&
            this.userData.ageRangeTypes.includes(typeForAgeRange)))
      ) {
        if (excludedAgeRange[0] && (stream.age ?? 0) > excludedAgeRange[0]) {
          this.incrementRemovalReason(
            'excludedAgeRange',
            `< ${excludedAgeRange[0]}h`
          );
          return false;
        }
        if (excludedAgeRange[1] && (stream.age ?? 0) < excludedAgeRange[1]) {
          this.incrementRemovalReason(
            'excludedAgeRange',
            `> ${excludedAgeRange[1]}h`
          );
          return false;
        }
      }

      if (!shouldPassthroughStage(stream, 'year')) {
        const _ymStart = Date.now();
        const _ymResult = performYearMatch(stream);
        accumPhase(phases.yearMatch, Date.now() - _ymStart);
        if (!_ymResult) {
          this.incrementRemovalReason(
            'yearMatching',
            `${stream.parsedFile?.title || 'Unknown Title'} - ${stream.parsedFile?.year || 'Unknown Year'}`
          );
          return false;
        }
      }

      if (!shouldPassthroughStage(stream, 'episode')) {
        const _seStart = Date.now();
        const _seResult = performSeasonEpisodeMatch(stream);
        accumPhase(phases.seasonEpisodeMatch, Date.now() - _seStart);
        if (!_seResult) {
          const pad = (n: number) => n.toString().padStart(2, '0');
          const s = stream.parsedFile?.seasons;
          const e = stream.parsedFile?.episodes;
          const formattedSeasonString = s?.length
            ? `S${pad(s[0])}${s.length > 1 ? `-${pad(s[s.length - 1])}` : ''}`
            : undefined;
          const formattedEpisodeString = e?.length
            ? `E${pad(e[0])}${e.length > 1 ? `-${pad(e[e.length - 1])}` : ''}`
            : undefined;
          const seasonEpisode = [
            formattedSeasonString,
            formattedEpisodeString,
          ].filter(Boolean);
          const detail =
            stream.parsedFile?.title +
            ' ' +
            (seasonEpisode?.join(' • ') || 'Unknown');

          this.incrementRemovalReason('seasonEpisodeMatching', detail);
          return false;
        }
      }

      if (shouldPassthroughStage(stream, 'episodeTitle')) {
        logEpisodeTitleDebug('Episode title matching bypassed: stream has episodeTitle passthrough stage', {
          addon: stream.addon?.name,
          addonPresetId: stream.addon?.preset?.id,
          filename: stream.filename,
          folderName: stream.folderName,
          originalName: stream.originalName,
          parsedTitle: stream.parsedFile?.title,
          parsedSeasons: stream.parsedFile?.seasons,
          parsedEpisodes: stream.parsedFile?.episodes,
          passthroughs: stream.passthrough,
        });
      }

      if (!shouldPassthroughStage(stream, 'episodeTitle')) {
        const _etStart = Date.now();
        const _etResult = performEpisodeTitleMatch(stream);
        accumPhase(phases.episodeTitleMatch, Date.now() - _etStart);
        if (!_etResult) {
          return false;
        }
      }

      if (!shouldPassthroughStage(stream, 'title')) {
        const _tmStart = Date.now();
        const _tmResult = performTitleMatch(stream);
        accumPhase(phases.titleMatch, Date.now() - _tmStart);
        if (!_tmResult) {
          this.incrementRemovalReason(
            'titleMatching',
            `${stream.parsedFile?.title || 'Unknown Title'}${type === 'movie' ? ` - (${stream.parsedFile?.year || 'Unknown Year'})` : ''}`
          );
          return false;
        }
      }

      const globalSizeRange = this.userData.size?.global;
      const resolutionSizeRange = stream.parsedFile?.resolution
        ? // @ts-ignore
          this.userData.size?.resolution?.[stream.parsedFile.resolution]
        : undefined;

      let finalSizeRange: [number | undefined, number | undefined] | undefined;
      if (type === 'movie') {
        finalSizeRange =
          normaliseSizeRange(resolutionSizeRange?.movies) ||
          normaliseSizeRange(globalSizeRange?.movies);
      } else {
        finalSizeRange =
          (isAnime
            ? normaliseSizeRange(resolutionSizeRange?.anime) ||
              normaliseSizeRange(globalSizeRange?.anime)
            : undefined) ||
          normaliseSizeRange(resolutionSizeRange?.series) ||
          normaliseSizeRange(globalSizeRange?.series);
      }

      if (finalSizeRange) {
        if (
          stream.size &&
          finalSizeRange[0] &&
          stream.size < finalSizeRange[0]
        ) {
          this.incrementRemovalReason(
            'size',
            `< ${formatBytes(finalSizeRange[0], 1000)}`
          );
          return false;
        }
        if (
          stream.size &&
          finalSizeRange[1] &&
          stream.size > finalSizeRange[1]
        ) {
          this.incrementRemovalReason(
            'size',
            `> ${formatBytes(finalSizeRange[1], 1000)}`
          );
          return false;
        }
      }

      const trustedSelectedFileSize = getTrustedSelectedFileSize(stream);
      if (
        uncachedMaxSizeBytes !== undefined &&
        stream.type === 'debrid' &&
        stream.service?.cached === false &&
        trustedSelectedFileSize !== undefined &&
        trustedSelectedFileSize > uncachedMaxSizeBytes
      ) {
        this.incrementRemovalReason(
          'size',
          `Uncached selected file > ${formatBytes(uncachedMaxSizeBytes, 1000)}`
        );
        return false;
      }

      const globalBitrateRange = this.userData.bitrate?.global;
      const resolutionBitrateRange = stream.parsedFile?.resolution
        ? // @ts-ignore
          this.userData.bitrate?.resolution?.[stream.parsedFile.resolution]
        : undefined;

      let finalBitrateRange:
        | [number | undefined, number | undefined]
        | undefined;
      if (type === 'movie') {
        finalBitrateRange =
          normaliseBitrateRange(resolutionBitrateRange?.movies) ||
          normaliseBitrateRange(globalBitrateRange?.movies);
      } else {
        finalBitrateRange =
          (isAnime
            ? normaliseBitrateRange(resolutionBitrateRange?.anime) ||
              normaliseBitrateRange(globalBitrateRange?.anime)
            : undefined) ||
          normaliseBitrateRange(resolutionBitrateRange?.series) ||
          normaliseBitrateRange(globalBitrateRange?.series);
      }

      if (
        finalBitrateRange &&
        stream.bitrate !== undefined &&
        Number.isFinite(stream.bitrate)
      ) {
        if (
          finalBitrateRange[0] !== undefined &&
          stream.bitrate < finalBitrateRange[0]
        ) {
          this.incrementRemovalReason(
            'bitrate',
            `< ${formatBitrate(finalBitrateRange[0])}`
          );
          return false;
        }
        if (
          finalBitrateRange[1] !== undefined &&
          stream.bitrate > finalBitrateRange[1]
        ) {
          this.incrementRemovalReason(
            'bitrate',
            `> ${formatBitrate(finalBitrateRange[1])}`
          );
          return false;
        }
      }

      return true;
    };

    // Separate included streams by whether they have passthrough flags
    const includedWithPassthrough = includedStreamsByExpression.filter(
      (stream) => stream.passthrough !== undefined
    );
    const includedWithoutPassthrough = includedStreamsByExpression.filter(
      (stream) => stream.passthrough === undefined
    );

    if (includedWithoutPassthrough.length > 0) {
      logger.info(
        `${includedWithoutPassthrough.length} included streams (no passthrough) will skip filtering entirely`
      );
    }

    if (includedWithPassthrough.length > 0) {
      logger.info(
        `${includedWithPassthrough.length} included streams have passthrough flags and will go through filtering`
      );
    }

    // Only exclude streams without passthrough from filtering
    const filterableStreams = streams.filter(
      (stream) => !includedWithoutPassthrough.some((s) => s.id === stream.id)
    );

    const hasAnyRegexFilter = !!(
      excludedRegexPatterns ||
      requiredRegexPatterns ||
      includedRegexPatterns ||
      excludedKeywordsPattern ||
      requiredKeywordsPattern ||
      includedKeywordsPattern
    );
    const regexDecisionsMap = new Map<
      string,
      {
        includedByRegex: boolean;
        includedByKeywords: boolean;
        excludedByRegex: boolean;
        requiredByRegex: boolean;
        excludedByKeywords: boolean;
        requiredByKeywords: boolean;
      }
    >();
    if (hasAnyRegexFilter) {
      const regexTestStart = Date.now();
      for (const stream of filterableStreams) {
        regexDecisionsMap.set(stream.id, {
          includedByRegex: includedRegexPatterns
            ? testRegexes(stream, includedRegexPatterns)
            : false,
          includedByKeywords: includedKeywordsPattern
            ? testRegexes(stream, [includedKeywordsPattern])
            : false,
          excludedByRegex: excludedRegexPatterns
            ? testRegexes(stream, excludedRegexPatterns)
            : false,
          requiredByRegex: requiredRegexPatterns
            ? testRegexes(stream, requiredRegexPatterns)
            : true,
          excludedByKeywords: excludedKeywordsPattern
            ? testRegexes(stream, [excludedKeywordsPattern])
            : false,
          requiredByKeywords: requiredKeywordsPattern
            ? testRegexes(stream, [requiredKeywordsPattern])
            : true,
        });
      }
      regexTestMs = Date.now() - regexTestStart;
    }

    const filterPassStart = Date.now();
    const filteredStreams = filterableStreams.filter(shouldKeepStream);
    filterPassMs = Date.now() - filterPassStart;

    let finalStreams = StreamUtils.mergeStreams([
      ...includedWithoutPassthrough,
      ...filteredStreams,
    ]);

    finalStreams = optimiseAnimePlaybackStreams(finalStreams);

    const totalMs = Date.now() - start;
    this.filterTimings.totalMs += totalMs;
    this.filterTimings.metadataMs += metadataMs;
    this.filterTimings.expressionMs += expressionMs;
    this.filterTimings.regexCompileMs += regexCompileMs;
    this.filterTimings.regexTestMs += regexTestMs;
    this.filterTimings.filterPassMs += filterPassMs;
    this.filterTimings.calls++;
    // Merge per-stream phase stats into the accumulated filterTimings
    const mergePhase = (
      dest: PhaseTimingStats,
      src: { totalMs: number; maxMs: number; minMs: number; count: number }
    ) => {
      if (src.count === 0) return;
      dest.totalMs += src.totalMs;
      dest.count += src.count;
      if (src.maxMs > dest.maxMs) dest.maxMs = src.maxMs;
      if (src.minMs < dest.minMs) dest.minMs = src.minMs;
    };
    mergePhase(this.filterTimings.phases.titleMatch, phases.titleMatch);
    mergePhase(this.filterTimings.phases.yearMatch, phases.yearMatch);
    mergePhase(
      this.filterTimings.phases.seasonEpisodeMatch,
      phases.seasonEpisodeMatch
    );
    mergePhase(
      this.filterTimings.phases.episodeTitleMatch,
      phases.episodeTitleMatch
    );

    logger.info(
      `Applied basic filters in ${getTimeTakenSincePoint(start)}, removed ${streams.length - finalStreams.length} streams`
    );
    return finalStreams;
  }
  /**
   * Validate final resolver URLs after sorting, limiting, stream-expression
   * filtering, and fallback insertion. This applies to movies, series, and
   * anime. Resolver redirects are inspected without following the final
   * debrid/CDN media URL.
   */
  public async preflightPlaybackStreams(
    streams: ParsedStream[],
    context: StreamContext
  ): Promise<ParsedStream[]> {
    const { id } = context;
    const boolEnv = (value: string | undefined): boolean =>
      /^(1|true|yes|on)$/i.test(value ?? '');
    const numberEnv = (
      value: string | undefined,
      fallback: number,
      min: number,
      max: number
    ): number => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return fallback;
      return Math.min(max, Math.max(min, Math.floor(parsed)));
    };

    const hideLegalEnv =
      process.env.PLAYBACK_HIDE_LEGAL_UNAVAILABLE ??
      process.env.ANIME_HIDE_LEGAL_UNAVAILABLE;
    const hideLegalUnavailable =
      hideLegalEnv === undefined ? true : boolEnv(hideLegalEnv);

    let workingStreams = streams;
    if (hideLegalUnavailable && workingStreams.length > 0) {
      const legallyUnavailableIds = new Set<string>();

      await Promise.all(
        workingStreams.map(async (stream) => {
          const serviceId = stream.service?.id;
          const hash = stream.torrent?.infoHash;
          if (!serviceId || !hash) return;

          const cachedFailure = await DebridFailureCache.peek(
            serviceId,
            'torrent',
            hash
          );
          if (
            cachedFailure?.code !== 'UNAVAILABLE_FOR_LEGAL_REASONS' &&
            cachedFailure?.statusCode !== 451
          ) {
            return;
          }

          legallyUnavailableIds.add(stream.id);
          const serviceName =
            constants.SERVICE_DETAILS[serviceId]?.shortName ?? serviceId;
          this.incrementRemovalReason(
            'excludedFilterCondition',
            `Legal Unavailable (${serviceName})`
          );
          logger.debug('Suppressed provider-confirmed legal-unavailable stream', {
            id,
            streamId: stream.id,
            provider: serviceId,
            hashPrefix: hash.slice(0, 10),
          });
        })
      );

      if (legallyUnavailableIds.size > 0) {
        workingStreams = workingStreams.filter(
          (stream) => !legallyUnavailableIds.has(stream.id)
        );
        logger.info('Suppressed remembered legal-unavailable streams', {
          id,
          removed: legallyUnavailableIds.size,
        });
      }
    }

    const enabled = boolEnv(
      process.env.PLAYBACK_PREFLIGHT_CHECK ??
        process.env.ANIME_PREFLIGHT_PLAYBACK_CHECK
    );
    if (!enabled || workingStreams.length === 0) return workingStreams;

    // A limit of 0 means check every final playable stream. A positive value is
    // retained as an emergency cap for users with unusually large result lists.
    const configuredLimit = numberEnv(
      process.env.PLAYBACK_PREFLIGHT_CHECK_LIMIT ??
        process.env.ANIME_PREFLIGHT_PLAYBACK_CHECK_LIMIT,
      0,
      0,
      100
    );
    const timeoutMs = numberEnv(
      process.env.PLAYBACK_PREFLIGHT_TIMEOUT_MS ??
        process.env.ANIME_PREFLIGHT_PLAYBACK_TIMEOUT_MS,
      7000,
      500,
      30000
    );
    const concurrency = numberEnv(
      process.env.PLAYBACK_PREFLIGHT_CONCURRENCY ??
        process.env.ANIME_PREFLIGHT_PLAYBACK_CONCURRENCY,
      3,
      1,
      10
    );
    const resolverProbeBytes = numberEnv(
      process.env.EXTERNAL_RESOLVER_PROBE_BYTES ??
        process.env.EXTERNAL_RESOLVER_MIN_MEDIA_BYTES,
      64 * 1024,
      4 * 1024,
      256 * 1024
    );
    const resolverSizeTolerancePercent = numberEnv(
      process.env.EXTERNAL_RESOLVER_SIZE_TOLERANCE_PERCENT,
      25,
      0,
      100
    );
    const inconclusiveMode = (
      process.env.PLAYBACK_PREFLIGHT_INCONCLUSIVE_MODE ??
      process.env.ANIME_PREFLIGHT_INCONCLUSIVE_MODE ??
      'keep'
    ).toLowerCase();

    type PreflightStatus = 'passed' | 'failed' | 'inconclusive';
    type PreflightResult = {
      status: PreflightStatus;
      reason?: string;
      mediaBytes?: number;
      mediaSignature?: string;
      expectedFileSize?: number;
      reportedFileSize?: number;
      probe2Start?: number;
      probe2Bytes?: number;
      cacheHit?: boolean;
    };

    const getPreflightUrl = (stream: ParsedStream): string | undefined => {
      if (stream.url && /^https?:\/\//i.test(stream.url)) {
        return stream.url;
      }

      // externalUrl can legitimately point to a normal website rather than a
      // playable media resource. Only preflight it when it is clearly one of
      // the resolver/playback routes this feature is intended to validate.
      if (
        stream.externalUrl &&
        /^https?:\/\//i.test(stream.externalUrl) &&
        /\/api\/v1\/debrid\/playback\/|\/resolve\//i.test(stream.externalUrl)
      ) {
        return stream.externalUrl;
      }
      return undefined;
    };

    const readBodySnippet = async (
      response: Response,
      maxBytes: number = 64 * 1024
    ): Promise<Uint8Array> => {
      if (!response.body) return new Uint8Array();

      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;

      try {
        while (total < maxBytes) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.length === 0) continue;

          const remaining = maxBytes - total;
          const chunk =
            value.length > remaining ? value.slice(0, remaining) : value;
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

    const decodeSnippet = (bytes: Uint8Array): string => {
      try {
        return new TextDecoder('utf-8', { fatal: false }).decode(bytes).trim();
      } catch {
        return '';
      }
    };

    const findNestedHttpUrl = (
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
          const found = findNestedHttpUrl(item, depth + 1);
          if (found) return found;
        }
        return undefined;
      }
      if (typeof value === 'object') {
        for (const nested of Object.values(value as Record<string, unknown>)) {
          const found = findNestedHttpUrl(nested, depth + 1);
          if (found) return found;
        }
      }
      return undefined;
    };

    const getJsonError = (value: unknown): string | undefined => {
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

      const message = object.message;
      if (
        typeof message === 'string' &&
        /unavailable|not available|not found|forbidden|blocked|expired|invalid|failed|failure|legal reasons|different file|not cached|uncached/i.test(
          message
        )
      ) {
        return message;
      }
      return undefined;
    };

    const errorBodyPattern =
      /unavailable for legal reasons|legal reasons|try a different file|not available|unavailable|file not found|torrent not found|no (?:stream|link|file)s? found|invalid (?:torrent|magnet|link|file)|forbidden|access denied|permission denied|blocked|expired|not cached|uncached|resolver (?:error|failed)|playback (?:error|failed)|failed to (?:resolve|fetch|play)|could not (?:resolve|fetch|play)/i;

    const isMediaContentType = (contentType: string): boolean =>
      /^(video|audio)\//.test(contentType) ||
      /application\/(?:octet-stream|x-matroska|mp4|vnd\.apple\.mpegurl|x-mpegurl|dash\+xml)/.test(
        contentType
      );

    const isTextLikeContentType = (contentType: string): boolean =>
      contentType.includes('text/') ||
      contentType.includes('html') ||
      contentType.includes('json') ||
      contentType.includes('problem+json');

    const startsWithBytes = (
      bytes: Uint8Array,
      signature: number[],
      offset: number = 0
    ): boolean =>
      bytes.length >= offset + signature.length &&
      signature.every((value, index) => bytes[offset + index] === value);

    const detectMediaSignature = (
      bytes: Uint8Array,
      contentType: string
    ): string | undefined => {
      if (bytes.length === 0) return undefined;

      if (
        /application\/(?:vnd\.apple\.mpegurl|x-mpegurl)/.test(contentType)
      ) {
        const text = decodeSnippet(bytes);
        return /^#EXTM3U/i.test(text) ? 'hls-playlist' : undefined;
      }
      if (contentType.includes('dash+xml')) {
        const text = decodeSnippet(bytes);
        return /<MPD(?:\s|>)/i.test(text) ? 'dash-manifest' : undefined;
      }

      if (startsWithBytes(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
        return 'matroska/webm';
      }
      if (
        bytes.length >= 12 &&
        String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp'
      ) {
        return 'mp4/quicktime';
      }
      if (
        startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46]) &&
        bytes.length >= 12 &&
        String.fromCharCode(...bytes.slice(8, 12)) === 'AVI '
      ) {
        return 'avi';
      }
      if (startsWithBytes(bytes, [0x4f, 0x67, 0x67, 0x53])) return 'ogg';
      if (startsWithBytes(bytes, [0x46, 0x4c, 0x56])) return 'flv';
      if (
        startsWithBytes(bytes, [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11])
      ) {
        return 'asf/wmv';
      }
      if (startsWithBytes(bytes, [0x49, 0x44, 0x33])) return 'mp3-id3';
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
        startsWithBytes(bytes, [0x00, 0x00, 0x01, 0xba]) ||
        startsWithBytes(bytes, [0x00, 0x00, 0x01, 0xb3]) ||
        startsWithBytes(bytes, [0x00, 0x00, 0x00, 0x01]) ||
        startsWithBytes(bytes, [0x00, 0x00, 0x01])
      ) {
        return 'mpeg/annex-b';
      }
      return undefined;
    };

    const looksMostlyText = (bytes: Uint8Array): boolean => {
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

    const parseContentRange = (
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

    const parseContentLength = (value: string | null): number | undefined => {
      if (!value) return undefined;
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    };

    const sizesAreReasonablyClose = (
      expected: number,
      reported: number
    ): boolean => {
      if (expected <= 0 || reported <= 0) return true;
      const differenceRatio = Math.abs(reported - expected) / expected;
      return differenceRatio <= resolverSizeTolerancePercent / 100;
    };

    const getSecondProbeStart = (
      reportedFileSize?: number,
      expectedFileSize?: number
    ): number => {
      const basis = reportedFileSize ?? expectedFileSize;
      if (!basis || !Number.isFinite(basis) || basis <= 0) {
        return 1024 * 1024;
      }

      const quarter = Math.floor(basis * 0.25);
      const minimum = resolverProbeBytes * 2;
      const maximum = Math.max(0, basis - resolverProbeBytes - 1);
      return Math.min(Math.max(quarter, minimum), maximum);
    };

    const isResolverUrl = (url: string): boolean =>
      /\/api\/v1\/debrid\/(?:playback|external-resolver)\//i.test(url) ||
      isKnownExternalResolverHopUrl(url);

    const classifyRedirectTarget = (
      sourceUrl: string,
      location: string
    ):
      | PreflightResult
      | { nestedResolverUrl: string }
      | { mediaTargetUrl: string }
      | undefined => {
      let target: URL;
      try {
        target = new URL(location, sourceUrl);
      } catch {
        return {
          status: 'failed',
          reason: 'Preflight failed: resolver returned an invalid redirect URL',
        };
      }

      const path = target.pathname.toLowerCase();
      const targetText = `${path}${target.search}`.toLowerCase();

      // AIOStreams deliberately represents debrid errors as small playable MP4
      // files. Following the redirect makes those error videos look like valid
      // media, so inspect the redirect target before touching the media URL.
      if (/\/(?:unavailable_for_legal_reasons)\.mp4(?:$|[/?#])/i.test(path)) {
        return {
          status: 'failed',
          reason: 'Preflight failed: unavailable for legal reasons',
        };
      }

      if (
        /\/(?:download_failed|403|401|no_matching_file|payment_required|store_limit_exceeded|content_proxy_limit_reached)\.mp4(?:$|[/?#])/i.test(
          path
        )
      ) {
        return {
          status: 'failed',
          reason: `Preflight failed: resolver redirected to ${path.split('/').pop()}`,
        };
      }

      if (/\/(?:downloading|429|500)\.mp4(?:$|[/?#])/i.test(path)) {
        return {
          status: 'inconclusive',
          reason: `Preflight inconclusive: resolver redirected to ${path.split('/').pop()}`,
        };
      }

      if (
        /(?:unavailable[_-]for[_-]legal[_-]reasons|no[_-]matching[_-]file|download[_-]failed|payment[_-]required|store[_-]limit[_-]exceeded|content[_-]proxy[_-]limit[_-]reached)/i.test(
          targetText
        )
      ) {
        return {
          status: 'failed',
          reason: 'Preflight failed: resolver redirected to an error resource',
        };
      }

      // Resolver-to-resolver hops are followed as resolver URLs. A non-error
      // redirect to a direct media/CDN URL must still be validated: v7.2.9
      // performs the agreed two small Range probes against that actual target
      // instead of treating the redirect itself as proof of playability.
      if (isResolverUrl(target.toString())) {
        return { nestedResolverUrl: target.toString() };
      }

      return { mediaTargetUrl: target.toString() };
    };

    const inspectUrl = async (
      url: string,
      redirectDepth: number = 0,
      expectedFileSize?: number,
      cacheIdentity?: string,
      validateDirectMediaTarget: boolean = false
    ): Promise<PreflightResult> => {
      // Do not execute our own native playback route during server-side
      // preflight. Resolving it here uses the VPS request context and can warm a
      // temporary/IP-sensitive debrid link before the real Stremio client
      // clicks it. Native playback already has playback-time retries and now
      // generates a fresh final link on the real client request.
      if (/\/api\/v1\/debrid\/playback\//i.test(url)) {
        return {
          status: 'passed',
          reason: 'Native playback preflight skipped; fresh link will be generated on client click',
        };
      }

      if (redirectDepth > 3) {
        return {
          status: 'failed',
          reason: 'Preflight failed: resolver returned too many nested resolver URLs',
        };
      }

      let directValidationCacheKey: string | undefined;
      if (validateDirectMediaTarget && cacheIdentity) {
        directValidationCacheKey =
          `${cacheIdentity}:${expectedFileSize ?? '-'}:${url}`;
        const cachedValidation = resolverPreflightSuccessCache.get(
          directValidationCacheKey
        );
        if (cachedValidation && cachedValidation.expiresAt > Date.now()) {
          let validationHost = 'unknown';
          try {
            validationHost = new URL(url).host;
          } catch {}
          logger.debug('Resolver media validation cache hit', {
            id,
            host: validationHost,
            expectedFileSize,
            reportedFileSize: cachedValidation.reportedFileSize,
            probe1Bytes: cachedValidation.mediaBytes,
            signature: cachedValidation.mediaSignature,
            probe2Start: cachedValidation.probe2Start,
            probe2Bytes: cachedValidation.probe2Bytes,
          });
          logger.debug('Resolver media validation passed', {
            id,
            host: validationHost,
            expectedFileSize,
            reportedFileSize: cachedValidation.reportedFileSize,
            probe1Bytes: cachedValidation.mediaBytes,
            signature: cachedValidation.mediaSignature,
            probe2Start: cachedValidation.probe2Start,
            probe2Bytes: cachedValidation.probe2Bytes,
            cacheHit: true,
          });
          return {
            status: 'passed',
            mediaBytes: cachedValidation.mediaBytes,
            mediaSignature: cachedValidation.mediaSignature,
            expectedFileSize,
            reportedFileSize: cachedValidation.reportedFileSize,
            probe2Start: cachedValidation.probe2Start,
            probe2Bytes: cachedValidation.probe2Bytes,
            cacheHit: true,
          };
        }
        if (cachedValidation) {
          resolverPreflightSuccessCache.delete(directValidationCacheKey);
        }
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let probingResolverMediaBody = false;

      try {
        const resolverRoute = isResolverUrl(url);
        const shouldRangeProbe =
          validateDirectMediaTarget ||
          (resolverRoute && isKnownExternalResolverHopUrl(url));
        const response = await fetch(url, {
          // Resolver routes need GET because AIOStreams intentionally rejects
          // HEAD. Final resolver-produced media targets also use GET with a
          // bounded Range so the actual CDN object can be validated without
          // downloading the stream.
          method: resolverRoute || validateDirectMediaTarget ? 'GET' : 'HEAD',
          headers: {
            Accept:
              'video/*, audio/*, application/octet-stream, application/vnd.apple.mpegurl, application/dash+xml, application/json, text/plain, */*;q=0.5',
            'User-Agent': 'AIOStreams resolver preflight',
            ...(shouldRangeProbe
              ? { Range: `bytes=0-${resolverProbeBytes - 1}` }
              : {}),
            ...((resolverRoute || validateDirectMediaTarget) && this.userData.ip
              ? {
                  'X-Forwarded-For': this.userData.ip,
                  'X-Real-IP': this.userData.ip,
                }
              : {}),
          },
          redirect: 'manual',
          signal: controller.signal,
        });

        const status = response.status;
        const contentType =
          response.headers
            .get('content-type')
            ?.toLowerCase()
            .split(';')[0]
            .trim() ?? '';

        if (status >= 300 && status < 400) {
          const location = response.headers.get('location');
          try {
            await response.body?.cancel();
          } catch {}

          if (!location) {
            return {
              status: 'failed',
              reason: `Preflight failed: HTTP ${status} redirect without Location`,
            };
          }

          const classified = classifyRedirectTarget(url, location);
          if (!classified) {
            return {
              status: 'failed',
              reason: 'Preflight failed: could not classify resolver redirect',
            };
          }
          if ('nestedResolverUrl' in classified) {
            return inspectUrl(
              classified.nestedResolverUrl,
              redirectDepth + 1,
              expectedFileSize,
              cacheIdentity,
              false
            );
          }
          if ('mediaTargetUrl' in classified) {
            return inspectUrl(
              classified.mediaTargetUrl,
              redirectDepth + 1,
              expectedFileSize,
              cacheIdentity,
              true
            );
          }
          return classified;
        }

        if (status === 451 && hideLegalUnavailable) {
          try {
            await response.body?.cancel();
          } catch {}
          return {
            status: 'failed',
            reason: 'Preflight failed: unavailable for legal reasons',
          };
        }

        if ([408, 425, 429, 500, 502, 503, 504].includes(status)) {
          try {
            await response.body?.cancel();
          } catch {}
          return {
            status: 'inconclusive',
            reason: `Preflight inconclusive: HTTP ${status}`,
          };
        }

        // Some direct media servers reject HEAD. Do not fall back to GET here:
        // fetching media from the VPS defeats the purpose of a non-destructive
        // resolver check and may interfere with IP-bound debrid playback.
        if (!resolverRoute && status === 405) {
          try {
            await response.body?.cancel();
          } catch {}
          return {
            status: 'inconclusive',
            reason: 'Preflight inconclusive: direct URL does not support HEAD',
          };
        }

        if (status >= 400) {
          try {
            await response.body?.cancel();
          } catch {}
          return {
            status: 'failed',
            reason: `Preflight failed: HTTP ${status}`,
          };
        }

        if (status === 204) {
          try {
            await response.body?.cancel();
          } catch {}
          return {
            status: 'failed',
            reason: 'Preflight failed: empty HTTP 204 response',
          };
        }

        if (isMediaContentType(contentType) || validateDirectMediaTarget) {
          // v7.2.9: validate both known resolver media and resolver-produced
          // final CDN/media targets with two small Range probes. The first
          // probe validates the container and total size; the second proves the
          // server can serve bytes from deeper inside the same media object.
          if (shouldRangeProbe) {
            probingResolverMediaBody = true;
            const firstRange = parseContentRange(
              response.headers.get('content-range')
            );
            const firstContentLength = parseContentLength(
              response.headers.get('content-length')
            );
            const reportedFileSize =
              firstRange?.total ?? (status === 200 ? firstContentLength : undefined);
            const bytes = await readBodySnippet(response, resolverProbeBytes);
            probingResolverMediaBody = false;

            const mediaSignature = detectMediaSignature(bytes, contentType);
            const manifestResponse =
              mediaSignature === 'hls-playlist' ||
              mediaSignature === 'dash-manifest';
            let validationHost = 'unknown';
            try {
              validationHost = new URL(url).host;
            } catch {}
            logger.debug('Resolver media validation probe 1', {
              id,
              host: validationHost,
              requestedStart: 0,
              requestedEnd: resolverProbeBytes - 1,
              httpStatus: status,
              received: bytes.length,
              contentRangeStart: firstRange?.start,
              contentRangeEnd: firstRange?.end,
              contentRangeTotal: firstRange?.total,
              signature: mediaSignature,
              expectedFileSize,
              reportedFileSize,
            });

            if (looksMostlyText(bytes)) {
              const bodyLower = decodeSnippet(bytes).toLowerCase();
              if (errorBodyPattern.test(bodyLower)) {
                return {
                  status: 'failed',
                  reason: 'Preflight failed: resolver returned an error body with media headers',
                  mediaBytes: bytes.length,
                  expectedFileSize,
                  reportedFileSize,
                };
              }
            }

            if (!manifestResponse && bytes.length < resolverProbeBytes) {
              return {
                status: 'failed',
                reason: `Preflight failed: resolver produced only ${bytes.length} of ${resolverProbeBytes} required media bytes`,
                mediaBytes: bytes.length,
                mediaSignature,
                expectedFileSize,
                reportedFileSize,
              };
            }

            if (!mediaSignature) {
              return {
                status: 'failed',
                reason: 'Preflight failed: resolver media prefix did not match a known media/container signature',
                mediaBytes: bytes.length,
                expectedFileSize,
                reportedFileSize,
              };
            }

            // HLS/DASH are manifests rather than one seekable media file, so a
            // second byte-range probe is not meaningful for those responses.
            if (manifestResponse) {
              if (directValidationCacheKey) {
                resolverPreflightSuccessCache.set(directValidationCacheKey, {
                  expiresAt:
                    Date.now() + RESOLVER_PREFLIGHT_SUCCESS_CACHE_TTL_MS,
                  mediaBytes: bytes.length,
                  mediaSignature,
                  reportedFileSize,
                });
              }
              logger.debug('Resolver media validation passed', {
                id,
                host: validationHost,
                expectedFileSize,
                reportedFileSize,
                probe1Bytes: bytes.length,
                signature: mediaSignature,
                cacheHit: false,
              });
              return {
                status: 'passed',
                mediaBytes: bytes.length,
                mediaSignature,
                expectedFileSize,
                reportedFileSize,
              };
            }

            if (
              expectedFileSize !== undefined &&
              reportedFileSize !== undefined &&
              !sizesAreReasonablyClose(expectedFileSize, reportedFileSize)
            ) {
              return {
                status: 'failed',
                reason: `Preflight failed: resolver media size ${formatBytes(reportedFileSize, 1000)} does not match expected file size ${formatBytes(expectedFileSize, 1000)}`,
                mediaBytes: bytes.length,
                mediaSignature,
                expectedFileSize,
                reportedFileSize,
              };
            }

            const probe2Start = getSecondProbeStart(
              reportedFileSize,
              expectedFileSize
            );
            if (probe2Start <= 0) {
              return {
                status: 'failed',
                reason: 'Preflight failed: resolver media object is too small for a second Range probe',
                mediaBytes: bytes.length,
                mediaSignature,
                expectedFileSize,
                reportedFileSize,
              };
            }

            const probe2End = probe2Start + resolverProbeBytes - 1;
            const probe2Response = await fetch(url, {
              method: 'GET',
              headers: {
                Accept:
                  'video/*, audio/*, application/octet-stream, application/vnd.apple.mpegurl, application/dash+xml, */*;q=0.5',
                'User-Agent': 'AIOStreams resolver preflight',
                Range: `bytes=${probe2Start}-${probe2End}`,
                ...(this.userData.ip
                  ? {
                      'X-Forwarded-For': this.userData.ip,
                      'X-Real-IP': this.userData.ip,
                    }
                  : {}),
              },
              redirect: 'manual',
              signal: controller.signal,
            });

            const probe2Status = probe2Response.status;
            const probe2ContentType =
              probe2Response.headers
                .get('content-type')
                ?.toLowerCase()
                .split(';')[0]
                .trim() ?? '';
            const probe2Range = parseContentRange(
              probe2Response.headers.get('content-range')
            );
            logger.debug('Resolver media validation probe 2 headers', {
              id,
              host: validationHost,
              requestedStart: probe2Start,
              requestedEnd: probe2End,
              httpStatus: probe2Status,
              contentRangeStart: probe2Range?.start,
              contentRangeEnd: probe2Range?.end,
              contentRangeTotal: probe2Range?.total,
              expectedFileSize,
              reportedFileSize,
            });

            if (
              probe2Status !== 206 ||
              !probe2Range ||
              probe2Range.start !== probe2Start
            ) {
              try {
                await probe2Response.body?.cancel();
              } catch {}
              return {
                status: 'failed',
                reason: `Preflight failed: resolver did not honor second Range probe at byte ${probe2Start}`,
                mediaBytes: bytes.length,
                mediaSignature,
                expectedFileSize,
                reportedFileSize,
                probe2Start,
              };
            }

            if (!isMediaContentType(probe2ContentType)) {
              const probe2Bytes = await readBodySnippet(
                probe2Response,
                resolverProbeBytes
              );
              return {
                status: 'failed',
                reason: `Preflight failed: second Range probe returned ${probe2ContentType || 'unknown content type'}`,
                mediaBytes: bytes.length,
                mediaSignature,
                expectedFileSize,
                reportedFileSize,
                probe2Start,
                probe2Bytes: probe2Bytes.length,
              };
            }

            probingResolverMediaBody = true;
            const probe2Bytes = await readBodySnippet(
              probe2Response,
              resolverProbeBytes
            );
            probingResolverMediaBody = false;
            logger.debug('Resolver media validation probe 2 body', {
              id,
              host: validationHost,
              requestedStart: probe2Start,
              requestedEnd: probe2End,
              received: probe2Bytes.length,
              contentRangeStart: probe2Range.start,
              contentRangeEnd: probe2Range.end,
              contentRangeTotal: probe2Range.total,
              expectedFileSize,
              reportedFileSize,
            });

            if (probe2Bytes.length < resolverProbeBytes) {
              return {
                status: 'failed',
                reason: `Preflight failed: second Range probe produced only ${probe2Bytes.length} of ${resolverProbeBytes} required bytes`,
                mediaBytes: bytes.length,
                mediaSignature,
                expectedFileSize,
                reportedFileSize,
                probe2Start,
                probe2Bytes: probe2Bytes.length,
              };
            }

            if (looksMostlyText(probe2Bytes)) {
              const bodyLower = decodeSnippet(probe2Bytes).toLowerCase();
              if (errorBodyPattern.test(bodyLower)) {
                return {
                  status: 'failed',
                  reason: 'Preflight failed: second Range probe returned an error body',
                  mediaBytes: bytes.length,
                  mediaSignature,
                  expectedFileSize,
                  reportedFileSize,
                  probe2Start,
                  probe2Bytes: probe2Bytes.length,
                };
              }
            }

            const secondReportedTotal = probe2Range.total;
            if (
              reportedFileSize !== undefined &&
              secondReportedTotal !== undefined &&
              reportedFileSize !== secondReportedTotal
            ) {
              return {
                status: 'failed',
                reason: 'Preflight failed: resolver reported inconsistent media size across Range probes',
                mediaBytes: bytes.length,
                mediaSignature,
                expectedFileSize,
                reportedFileSize,
                probe2Start,
                probe2Bytes: probe2Bytes.length,
              };
            }

            const finalReportedFileSize =
              reportedFileSize ?? secondReportedTotal;
            if (
              expectedFileSize !== undefined &&
              finalReportedFileSize !== undefined &&
              !sizesAreReasonablyClose(expectedFileSize, finalReportedFileSize)
            ) {
              return {
                status: 'failed',
                reason: `Preflight failed: resolver media size ${formatBytes(finalReportedFileSize, 1000)} does not match expected file size ${formatBytes(expectedFileSize, 1000)}`,
                mediaBytes: bytes.length,
                mediaSignature,
                expectedFileSize,
                reportedFileSize: finalReportedFileSize,
                probe2Start,
                probe2Bytes: probe2Bytes.length,
              };
            }

            if (directValidationCacheKey) {
              resolverPreflightSuccessCache.set(directValidationCacheKey, {
                expiresAt:
                  Date.now() + RESOLVER_PREFLIGHT_SUCCESS_CACHE_TTL_MS,
                mediaBytes: bytes.length,
                mediaSignature,
                reportedFileSize: finalReportedFileSize,
                probe2Start,
                probe2Bytes: probe2Bytes.length,
              });
            }

            logger.debug('Resolver media validation passed', {
              id,
              host: validationHost,
              expectedFileSize,
              reportedFileSize: finalReportedFileSize,
              probe1Bytes: bytes.length,
              signature: mediaSignature,
              probe2Start,
              probe2Bytes: probe2Bytes.length,
              cacheHit: false,
            });
            return {
              status: 'passed',
              mediaBytes: bytes.length,
              mediaSignature,
              expectedFileSize,
              reportedFileSize: finalReportedFileSize,
              probe2Start,
              probe2Bytes: probe2Bytes.length,
            };
          }

          try {
            await response.body?.cancel();
          } catch {}
          return { status: 'passed' };
        }

        if (isTextLikeContentType(contentType)) {
          const bytes = await readBodySnippet(response);
          const body = decodeSnippet(bytes);
          const bodyLower = body.toLowerCase();

          if (
            hideLegalUnavailable &&
            /unavailable for legal reasons|legal reasons|infring(?:e|ing|ement)/i.test(
              bodyLower
            )
          ) {
            return {
              status: 'failed',
              reason: 'Preflight failed: unavailable for legal reasons',
            };
          }

          let parsedJson: unknown;
          if (contentType.includes('json') || /^[\[{]/.test(body)) {
            try {
              parsedJson = JSON.parse(body);
            } catch {}
          }

          if (parsedJson !== undefined) {
            const jsonError = getJsonError(parsedJson);
            if (jsonError) {
              return {
                status: 'failed',
                reason: `Preflight failed: ${jsonError.slice(0, 180)}`,
              };
            }

            const nestedUrl = findNestedHttpUrl(parsedJson);
            if (nestedUrl && nestedUrl !== url) {
              const classified = classifyRedirectTarget(url, nestedUrl);
              if (!classified) {
                return {
                  status: 'failed',
                  reason: 'Preflight failed: invalid resolver URL response',
                };
              }
              if ('nestedResolverUrl' in classified) {
                return inspectUrl(
                  classified.nestedResolverUrl,
                  redirectDepth + 1,
                  expectedFileSize,
                  cacheIdentity,
                  false
                );
              }
              if ('mediaTargetUrl' in classified) {
                return inspectUrl(
                  classified.mediaTargetUrl,
                  redirectDepth + 1,
                  expectedFileSize,
                  cacheIdentity,
                  true
                );
              }
              return classified;
            }
          }

          const plainUrl = /^https?:\/\/\S+$/i.test(body) ? body : undefined;
          if (plainUrl && plainUrl !== url) {
            const classified = classifyRedirectTarget(url, plainUrl);
            if (!classified) {
              return {
                status: 'failed',
                reason: 'Preflight failed: invalid resolver URL response',
              };
            }
            if ('nestedResolverUrl' in classified) {
              return inspectUrl(
                classified.nestedResolverUrl,
                redirectDepth + 1,
                expectedFileSize,
                cacheIdentity,
                false
              );
            }
            if ('mediaTargetUrl' in classified) {
              return inspectUrl(
                classified.mediaTargetUrl,
                redirectDepth + 1,
                expectedFileSize,
                cacheIdentity,
                true
              );
            }
            return classified;
          }

          if (errorBodyPattern.test(bodyLower)) {
            return {
              status: 'failed',
              reason: `Preflight failed: resolver error response (${status})`,
            };
          }

          return {
            status: 'failed',
            reason: `Preflight failed: unexpected ${contentType || 'text'} response`,
          };
        }

        // Ordinary non-resolver direct URLs retain the legacy non-destructive
        // behavior. Resolver-produced final media targets are handled above and
        // must pass the two-Range validation before they can reach this point.
        try {
          await response.body?.cancel();
        } catch {}
        return { status: 'passed' };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error ?? 'unknown error');
        const timedOut =
          error instanceof Error &&
          (error.name === 'AbortError' || /aborted|timeout/i.test(message));
        if (timedOut && probingResolverMediaBody) {
          return {
            status: 'failed',
            reason: `Preflight failed: resolver media body produced no bytes within ${timeoutMs} ms`,
          };
        }
        return {
          status: 'inconclusive',
          reason: timedOut
            ? `Preflight inconclusive: timed out after ${timeoutMs} ms`
            : `Preflight inconclusive: ${message}`,
        };
      } finally {
        clearTimeout(timeout);
      }
    };

    const allCandidates = workingStreams.filter(
      (stream) =>
        stream.type !== 'info' && getPreflightUrl(stream) !== undefined
    );
    const candidates =
      configuredLimit > 0
        ? allCandidates.slice(0, configuredLimit)
        : allCandidates;

    if (candidates.length === 0) return workingStreams;

    const resultById = new Map<string, PreflightResult>();
    let nextIndex = 0;
    const workerCount = Math.min(concurrency, candidates.length);

    const getPreflightCacheIdentity = (stream: ParsedStream): string => {
      const service = stream.service?.id ?? 'unknown';
      const hash = stream.torrent?.infoHash?.toLowerCase();
      const fileIdx = stream.torrent?.fileIdx;
      const fileIdentity = hash
        ? `${hash}:${fileIdx ?? '-'}:${stream.filename ?? '-'}`
        : stream.filename ?? '-';
      return `${service}:${fileIdentity}`;
    };

    const worker = async (): Promise<void> => {
      while (true) {
        const currentIndex = nextIndex++;
        if (currentIndex >= candidates.length) return;
        const stream = candidates[currentIndex];
        const url = getPreflightUrl(stream);
        if (!url) continue;

        const expectedFileSize = getTrustedSelectedFileSize(stream);
        const cacheIdentity = getPreflightCacheIdentity(stream);

        if (resolverPreflightSuccessCache.size > 2000) {
          const now = Date.now();
          for (const [key, entry] of resolverPreflightSuccessCache) {
            if (entry.expiresAt <= now) {
              resolverPreflightSuccessCache.delete(key);
            }
          }
        }

        const preflightResult = await inspectUrl(
          url,
          0,
          expectedFileSize,
          cacheIdentity,
          false
        );
        resultById.set(stream.id, preflightResult);

        let host = 'unknown';
        try {
          host = new URL(url).host;
        } catch {}
        logger.debug('Resolver preflight result', {
          id,
          streamId: stream.id,
          streamName: stream.originalName ?? stream.filename ?? stream.addon.name,
          host,
          route: isResolverUrl(url) ? 'resolver' : 'direct',
          status: preflightResult.status,
          reason: preflightResult.reason,
          mediaBytes: preflightResult.mediaBytes,
          mediaSignature: preflightResult.mediaSignature,
          expectedFileSize: preflightResult.expectedFileSize,
          reportedFileSize: preflightResult.reportedFileSize,
          probe2Start: preflightResult.probe2Start,
          probe2Bytes: preflightResult.probe2Bytes,
          cacheHit: preflightResult.cacheHit,
        });
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    const failedIds = new Set<string>();
    const inconclusiveIds = new Set<string>();

    for (const stream of candidates) {
      const result = resultById.get(stream.id);
      if (!result || result.status === 'passed') continue;

      if (result.status === 'failed') {
        failedIds.add(stream.id);
        this.incrementRemovalReason(
          'excludedFilterCondition',
          result.reason ?? 'Playback preflight failed'
        );
      } else {
        inconclusiveIds.add(stream.id);
      }
    }

    logger.info('Completed final resolver preflight', {
      id,
      checked: candidates.length,
      passed:
        candidates.length - failedIds.size - inconclusiveIds.size,
      failed: failedIds.size,
      inconclusive: inconclusiveIds.size,
      configuredLimit,
      concurrency,
      timeoutMs,
      inconclusiveMode,
    });

    let result = workingStreams.filter((stream) => !failedIds.has(stream.id));

    if (inconclusiveMode === 'remove') {
      for (const stream of result) {
        if (!inconclusiveIds.has(stream.id)) continue;
        const reason =
          resultById.get(stream.id)?.reason ??
          'Playback preflight was inconclusive';
        this.incrementRemovalReason('excludedFilterCondition', reason);
      }
      result = result.filter((stream) => !inconclusiveIds.has(stream.id));
    } else if (inconclusiveMode === 'demote') {
      result = [
        ...result.filter((stream) => !inconclusiveIds.has(stream.id)),
        ...result.filter((stream) => inconclusiveIds.has(stream.id)),
      ];
    }

    return result;
  }

  private getDisplayCondition(expression: string): string {
    const names = extractNamesFromExpression(expression);
    if (names && names.length > 0) {
      return names.join(', ');
    }
    // Fallback to truncation if no names found
    const maxLength = 50;
    if (expression.length > maxLength) {
      return expression.substring(0, maxLength - 3) + '...';
    }
    return expression;
  }

  public async applyIncludedStreamExpressions(
    streams: ParsedStream[],
    context: StreamContext
  ): Promise<ParsedStream[]> {
    const expressionContext = context.toExpressionContext();
    const selector = new StreamSelector(expressionContext);
    const streamsToKeep = new Set<string>();
    if (
      !this.userData.includedStreamExpressions ||
      this.userData.includedStreamExpressions.length === 0
    ) {
      return [];
    }
    for (const item of this.userData.includedStreamExpressions) {
      const { expression, enabled } =
        typeof item === 'string' ? { expression: item, enabled: true } : item;
      if (!enabled) continue;
      const selectedStreams = await selector.select(streams, expression);
      this.filterStatistics.included.streamExpression.total +=
        selectedStreams.length;
      const displayCondition = this.getDisplayCondition(expression);
      this.filterStatistics.included.streamExpression.details[
        displayCondition
      ] =
        (this.filterStatistics.included.streamExpression.details[
          displayCondition
        ] || 0) + selectedStreams.length;
      selectedStreams.forEach((stream) => streamsToKeep.add(stream.id));
    }
    return streams.filter((stream) => streamsToKeep.has(stream.id));
  }

  public async applyStreamExpressionFilters(
    streams: ParsedStream[],
    context: StreamContext
  ): Promise<ParsedStream[]> {
    const expressionContext = context.toExpressionContext();

    // Collect pin instructions from all selectors
    const pinInstructions = new Map<string, 'top' | 'bottom'>();

    if (
      this.userData.excludedStreamExpressions &&
      this.userData.excludedStreamExpressions.length > 0
    ) {
      const selector = new StreamSelector(expressionContext);
      const streamsToRemove = new Set<string>(); // Track actual stream objects to be removed

      for (const item of this.userData.excludedStreamExpressions) {
        const { expression, enabled } =
          typeof item === 'string' ? { expression: item, enabled: true } : item;
        if (!enabled) continue;
        try {
          // Always select from the current filteredStreams (not yet modified by this loop)
          const selectedStreams = await selector.select(
            streams.filter((stream) => !streamsToRemove.has(stream.id)),
            expression
          );

          // Track these stream objects for removal (except passthrough streams)
          let newlyRemoved = 0;
          selectedStreams.forEach((stream) => {
            if (
              !shouldPassthroughStage(stream, 'excluded') &&
              !streamsToRemove.has(stream.id)
            ) {
              streamsToRemove.add(stream.id);
              newlyRemoved++;
            }
          });

          // Update skip reasons for this condition (only count newly selected streams)
          if (newlyRemoved > 0) {
            this.filterStatistics.removed.excludedFilterCondition.total +=
              newlyRemoved;
            const displayCondition = this.getDisplayCondition(expression);
            this.filterStatistics.removed.excludedFilterCondition.details[
              displayCondition
            ] =
              (this.filterStatistics.removed.excludedFilterCondition.details[
                displayCondition
              ] || 0) + newlyRemoved;
          }
        } catch (error) {
          logger.error(
            `Failed to apply excluded stream expression "${expression}": ${error instanceof Error ? error.message : String(error)}`
          );
          // Continue with the next condition instead of breaking the entire loop
        }
      }

      logger.debug(
        { excluded: streamsToRemove.size },
        'streams removed by excluded conditions'
      );

      // Remove all marked streams at once, after processing all conditions
      streams = streams.filter((stream) => !streamsToRemove.has(stream.id));

      // Collect pin instructions from excluded selector
      for (const [id, pos] of selector.getPinInstructions()) {
        pinInstructions.set(id, pos);
      }
    }

    const requiredStreamExpressions = (
      this.userData.requiredStreamExpressions || []
    ).filter((item) => item.enabled);

    if (requiredStreamExpressions.length > 0) {
      const selector = new StreamSelector(expressionContext);
      const streamsToKeep = new Set<string>(); // Track actual stream objects to be kept

      for (const item of requiredStreamExpressions) {
        const { expression } = item;
        try {
          const selectedStreams = await selector.select(
            streams.filter(
              (stream) =>
                !streamsToKeep.has(stream.id) ||
                shouldPassthroughStage(stream, 'required')
            ),
            expression
          );

          // Track these stream objects to keep
          let newlyKept = 0;
          selectedStreams.forEach((stream) => {
            if (!streamsToKeep.has(stream.id)) {
              streamsToKeep.add(stream.id);
              newlyKept++;
            }
          });

          // Update skip reasons for this condition (only count newly selected streams)
          if (newlyKept > 0) {
            this.filterStatistics.removed.requiredFilterCondition.total +=
              newlyKept;
            const displayCondition = this.getDisplayCondition(expression);
            this.filterStatistics.removed.requiredFilterCondition.details[
              displayCondition
            ] =
              (this.filterStatistics.removed.requiredFilterCondition.details[
                displayCondition
              ] || 0) + newlyKept;
          }
        } catch (error) {
          logger.error(
            `Failed to apply required stream expression "${expression}": ${error instanceof Error ? error.message : String(error)}`
          );
          // Continue with the next condition instead of breaking the entire loop
        }
      }

      let passthroughCount = 0;
      streams.forEach((stream) => {
        if (
          shouldPassthroughStage(stream, 'required') &&
          !streamsToKeep.has(stream.id)
        ) {
          streamsToKeep.add(stream.id);
          passthroughCount++;
        }
      });

      logger.debug(
        { kept: streamsToKeep.size, passthrough: passthroughCount },
        'streams kept by required conditions'
      );
      // remove all streams that are not in the streamsToKeep set
      streams = streams.filter((stream) => streamsToKeep.has(stream.id));

      // Collect pin instructions from required selector
      for (const [id, pos] of selector.getPinInstructions()) {
        pinInstructions.set(id, pos);
      }
    }

    // Apply pin reordering from SEL pin() calls
    if (pinInstructions.size > 0) {
      const pinnedTop: ParsedStream[] = [];
      const pinnedBottom: ParsedStream[] = [];
      const rest: ParsedStream[] = [];

      for (const stream of streams) {
        const pin = pinInstructions.get(stream.id);
        if (pin === 'top') pinnedTop.push(stream);
        else if (pin === 'bottom') pinnedBottom.push(stream);
        else rest.push(stream);
      }

      streams = [...pinnedTop, ...rest, ...pinnedBottom];
      logger.info(
        `Applied SEL pinning: ${pinnedTop.length} pinned to top, ${pinnedBottom.length} pinned to bottom`
      );
    }

    return streams;
  }
}

export default StreamFilterer;
