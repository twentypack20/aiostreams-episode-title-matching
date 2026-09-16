import { ParsedStream, PassthroughStage } from '../db/schemas.js';

/**
 * Return the selected media-file size only when `stream.size` is trustworthy.
 *
 * Many season-pack results expose the whole torrent size as `stream.size`.
 * Applying per-file limits or playback-size validation to that value would
 * incorrectly treat (for example) a 1 GB episode inside a 15 GB season pack
 * as a 15 GB file. We therefore accept the size only when there is evidence
 * that it belongs to a specific file rather than the parent pack.
 */
export function getTrustedSelectedFileSize(
  stream: ParsedStream
): number | undefined {
  const size = stream.size;
  if (!Number.isFinite(size) || !size || size <= 0) return undefined;

  if (!stream.parsedFile?.seasonPack) return size;

  // A separate, materially larger folder size is strong evidence that
  // `size` is the selected file and `folderSize` is the parent pack.
  if (
    Number.isFinite(stream.folderSize) &&
    stream.folderSize! > size * 1.05
  ) {
    return size;
  }

  // A file index or episode-looking filename identifies *which* file is wanted,
  // but it does not prove where `stream.size` came from. Some external addons
  // keep the parent torrent size while also supplying fileIdx/filename. Trusting
  // those fields alone would recreate the season-pack bug this helper exists to
  // prevent. If the per-file size cannot be distinguished from the pack size,
  // fail open and leave size-based filtering/validation disabled for this stream.
  return undefined;
}

/**
 * Check if a stream should passthrough a specific stage.
 * Returns true if:
 * - stream.addon.resultPassthrough is true
 * - stream.passthrough is true (passthrough all stages)
 * - stream.passthrough is an array that includes the specified stage
 */
export function shouldPassthroughStage(
  stream: ParsedStream,
  stage: PassthroughStage
): boolean {
  // Addon-level passthrough always bypasses all stages
  if (stream.addon.resultPassthrough) {
    return true;
  }

  // Check stream-level passthrough
  if (stream.passthrough === true) {
    // true = passthrough all stages
    return true;
  }

  if (Array.isArray(stream.passthrough)) {
    // Array = passthrough only specified stages
    return stream.passthrough.includes(stage);
  }

  return false;
}

class StreamUtils {
  public static createDownloadableStream(stream: ParsedStream): ParsedStream {
    const copy = structuredClone(stream);
    copy.url = undefined;
    copy.externalUrl = stream.url;
    copy.message = `Download the stream above via your browser`;
    copy.id = `${stream.id}-external-download`;
    copy.type = 'external';
    // remove uneccessary info that is already present in the original stream above
    copy.parsedFile = undefined;
    copy.size = undefined;
    copy.folderSize = undefined;
    copy.torrent = undefined;
    copy.indexer = undefined;
    copy.age = undefined;
    copy.duration = undefined;
    copy.folderName = undefined;
    copy.filename = undefined;
    copy.regexMatched = undefined;
    copy.addon.name = '';
    return copy;
  }

  // ensure we have a unique list of streams after merging
  public static mergeStreams(streams: ParsedStream[]): ParsedStream[] {
    const mergedStreams = new Map<string, ParsedStream>();
    for (const stream of streams) {
      mergedStreams.set(stream.id, stream);
    }
    return Array.from(mergedStreams.values());
  }
}

export default StreamUtils;
