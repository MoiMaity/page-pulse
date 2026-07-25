import net from 'node:net';
import dns from 'node:dns/promises';
import { invalidUrl, unsupportedProtocol, urlNotAllowed, dnsResolutionFailed } from './errors.js';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan'];

/**
 * Accepts what a human would type ("example.com/pricing") and returns a URL
 * object, or throws a structured error explaining the rejection.
 * @param {string} input
 * @returns {URL}
 */
export function normalizeUrl(input) {
  if (typeof input !== 'string') throw invalidUrl();

  const trimmed = input.trim();
  if (!trimmed) throw invalidUrl('A URL is required.');

  const candidate = HAS_SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw invalidUrl(`"${input}" could not be parsed as a URL.`);
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw unsupportedProtocol(url.protocol.replace(':', ''));
  }

  if (url.username || url.password) {
    throw urlNotAllowed('URLs containing embedded credentials are rejected.');
  }

  if (!url.hostname) {
    throw invalidUrl('The URL is missing a hostname.');
  }

  // The fragment never reaches the server, so drop it for a stable cache key.
  url.hash = '';

  return url;
}

/** Stable cache key: protocol + host + path + query, fragment removed. */
export function cacheKeyFor(url) {
  return `${url.protocol}//${url.host}${url.pathname}${url.search}`;
}

/**
 * @param {string} ip dotted-quad IPv4
 * @returns {boolean} true when the address is not publicly routable
 */
export function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // unparsable means "do not trust"
  }

  const [a, b, c] = parts;

  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF protocol / TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast
  if (a === 192 && b === 168) return true; // private
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast + reserved + broadcast

  return false;
}

/**
 * @param {string} ip IPv6 literal
 * @returns {boolean} true when the address is not publicly routable
 */
export function isPrivateIPv6(ip) {
  const address = ip.toLowerCase().split('%')[0]; // strip zone index

  if (address === '::' || address === '::1') return true;

  // IPv4-mapped / IPv4-compatible: judge on the embedded v4 address.
  const mapped = address.match(/^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isPrivateIPv4(mapped[1]);

  const firstHextet = address.split(':')[0] || '0';

  if (firstHextet.startsWith('fc') || firstHextet.startsWith('fd')) return true; // unique local fc00::/7
  if (/^fe[89ab]/.test(firstHextet)) return true; // link-local fe80::/10
  if (firstHextet.startsWith('ff')) return true; // multicast

  return false;
}

/** @param {string} ip */
export function isPrivateAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateIPv4(ip);
  if (family === 6) return isPrivateIPv6(ip);
  return true;
}

/**
 * Builds the guard used before every outbound request (including every
 * redirect hop — validating only the first URL leaves an open SSRF door).
 *
 * @param {{ mode?: 'strict' | 'off', lookup?: typeof dns.lookup }} [options]
 * @returns {(url: URL) => Promise<void>}
 */
export function createUrlGuard({ mode = 'strict', lookup = dns.lookup } = {}) {
  return async function assertSafeUrl(url) {
    if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
      throw unsupportedProtocol(url.protocol.replace(':', ''));
    }
    if (mode === 'off') return;

    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');

    if (BLOCKED_HOSTNAMES.has(hostname) || BLOCKED_SUFFIXES.some((s) => hostname.endsWith(s))) {
      throw urlNotAllowed(`The hostname "${hostname}" is not permitted.`);
    }

    if (net.isIP(hostname)) {
      if (isPrivateAddress(hostname)) {
        throw urlNotAllowed(`The address "${hostname}" is not publicly routable.`);
      }
      return;
    }

    let addresses;
    try {
      addresses = await lookup(hostname, { all: true });
    } catch (cause) {
      throw dnsResolutionFailed(hostname, cause);
    }

    if (!Array.isArray(addresses) || addresses.length === 0) {
      throw dnsResolutionFailed(hostname);
    }

    // Every resolved address must be public: one private answer is enough for
    // a DNS-rebinding style attack to win.
    for (const { address } of addresses) {
      if (isPrivateAddress(address)) {
        throw urlNotAllowed(`"${hostname}" resolves to a non-public address (${address}).`);
      }
    }
  };
}
