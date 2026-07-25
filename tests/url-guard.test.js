import { describe, it, expect } from 'vitest';
import {
  normalizeUrl,
  cacheKeyFor,
  isPrivateIPv4,
  isPrivateIPv6,
  createUrlGuard,
} from '../src/lib/url-guard.js';

describe('normalizeUrl', () => {
  it('adds https to a bare hostname', () => {
    expect(normalizeUrl('example.com').toString()).toBe('https://example.com/');
  });

  it('keeps an explicit http scheme', () => {
    expect(normalizeUrl('http://example.com/a').toString()).toBe('http://example.com/a');
  });

  it('drops the fragment', () => {
    expect(normalizeUrl('https://example.com/a#section').toString()).toBe('https://example.com/a');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeUrl('  example.com  ').host).toBe('example.com');
  });

  it.each(['ftp://example.com', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<h1>x'])(
    'rejects %s',
    (input) => {
      expect(codeThrownBy(() => normalizeUrl(input))).toMatch(/UNSUPPORTED_PROTOCOL|INVALID_URL/);
    },
  );

  it('rejects embedded credentials', () => {
    expect(codeThrownBy(() => normalizeUrl('https://user:pass@example.com'))).toBe('URL_NOT_ALLOWED');
  });

  it('rejects an empty value', () => {
    expect(codeThrownBy(() => normalizeUrl('   '))).toBe('INVALID_URL');
  });
});

describe('cacheKeyFor', () => {
  it('ignores the fragment but keeps the query', () => {
    expect(cacheKeyFor(normalizeUrl('https://example.com/a?b=1#c'))).toBe('https://example.com/a?b=1');
  });

  it('separates hosts that differ only by subdomain', () => {
    expect(cacheKeyFor(normalizeUrl('https://www.example.com'))).not.toBe(
      cacheKeyFor(normalizeUrl('https://example.com')),
    );
  });
});

describe('private address detection', () => {
  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '127.0.0.1',
    '100.64.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '192.0.2.5',
    '198.18.0.1',
    '203.0.113.9',
    '224.0.0.1',
    '255.255.255.255',
  ])('treats %s as private', (ip) => {
    expect(isPrivateIPv4(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '93.184.216.34', '1.1.1.1', '172.32.0.1', '192.169.0.1', '199.7.83.42'])(
    'treats %s as public',
    (ip) => {
      expect(isPrivateIPv4(ip)).toBe(false);
    },
  );

  it.each(['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1'])(
    'treats IPv6 %s as private',
    (ip) => {
      expect(isPrivateIPv6(ip)).toBe(true);
    },
  );

  it.each(['2606:4700:4700::1111', '2001:4860:4860::8888'])('treats IPv6 %s as public', (ip) => {
    expect(isPrivateIPv6(ip)).toBe(false);
  });
});

describe('createUrlGuard', () => {
  const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

  it('allows a hostname resolving to a public address', async () => {
    const guard = createUrlGuard({ lookup: publicLookup });
    await expect(guard(new URL('https://example.com'))).resolves.toBeUndefined();
  });

  it.each(['http://localhost:3000', 'http://api.internal/health', 'http://printer.local'])(
    'blocks %s by hostname',
    async (url) => {
      const guard = createUrlGuard({ lookup: publicLookup });
      await expect(guard(new URL(url))).rejects.toMatchObject({ code: 'URL_NOT_ALLOWED' });
    },
  );

  it('blocks a literal private IP without a DNS lookup', async () => {
    const guard = createUrlGuard({
      lookup: async () => {
        throw new Error('DNS should not be consulted for a literal address');
      },
    });

    await expect(guard(new URL('http://10.0.0.5/admin'))).rejects.toMatchObject({ code: 'URL_NOT_ALLOWED' });
  });

  it('blocks when any resolved address is private', async () => {
    const guard = createUrlGuard({
      lookup: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    });

    await expect(guard(new URL('https://rebind.example'))).rejects.toMatchObject({ code: 'URL_NOT_ALLOWED' });
  });

  it('reports DNS failures distinctly from policy rejections', async () => {
    const guard = createUrlGuard({
      lookup: async () => {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
      },
    });

    await expect(guard(new URL('https://nope.example'))).rejects.toMatchObject({ code: 'DNS_RESOLUTION_FAILED' });
  });

  it('can be disabled for local development', async () => {
    const guard = createUrlGuard({ mode: 'off' });
    await expect(guard(new URL('http://127.0.0.1:8080'))).resolves.toBeUndefined();
  });
});

/** Returns the `code` of the HttpError a function throws, failing loudly if it does not throw. */
function codeThrownBy(fn) {
  try {
    fn();
  } catch (error) {
    return error.code;
  }
  throw new Error('Expected the call to throw, but it returned normally');
}
