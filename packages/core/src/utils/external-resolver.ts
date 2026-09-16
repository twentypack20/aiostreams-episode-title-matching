const splitHosts = (value: string | undefined, defaults: string[]): Set<string> => {
  const hosts = (value?.trim() ? value.split(',') : defaults)
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  return new Set(hosts);
};

const initialResolverHosts = splitHosts(
  process.env.EXTERNAL_RESOLVER_INITIAL_HOSTS,
  ['torrentio.strem.fun']
);

const resolverHopHosts = splitHosts(
  process.env.EXTERNAL_RESOLVER_HOP_HOSTS,
  ['torrentio.strem.fun', 'api.torbox.app', 'api.real-debrid.com']
);

const parseHttpUrl = (value: string): URL | undefined => {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Returns true only for resolver URLs that AIOStreams is willing to wrap.
 * This deliberately uses a small allowlist so the playback wrapper cannot be
 * turned into a general-purpose encrypted open redirect or SSRF endpoint.
 */
export const isSupportedExternalResolverUrl = (value: string): boolean => {
  const parsed = parseHttpUrl(value);
  if (!parsed) return false;
  return (
    initialResolverHosts.has(parsed.hostname.toLowerCase()) &&
    /^\/resolve(?:\/|$)/i.test(parsed.pathname)
  );
};

/**
 * Returns true for known resolver-to-resolver hops. Final media/CDN hosts are
 * intentionally not part of this allowlist; external-resolver callers may
 * still validate a resolver-produced final target with bounded Range probes.
 */
export const isKnownExternalResolverHopUrl = (value: string): boolean => {
  const parsed = parseHttpUrl(value);
  if (!parsed) return false;
  return resolverHopHosts.has(parsed.hostname.toLowerCase());
};

export const getExternalResolverProvider = (
  value: string
): string | undefined => {
  const parsed = parseHttpUrl(value);
  if (!parsed || !isSupportedExternalResolverUrl(value)) return undefined;
  const match = parsed.pathname.match(/^\/resolve\/([^/]+)/i);
  return match?.[1]?.toLowerCase();
};
