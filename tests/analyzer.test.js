import { describe, it, expect } from 'vitest';
import { analyze } from '../src/services/analyzer.js';
import { GOOD_PAGE, POOR_PAGE, HTML_HEADERS } from './helpers.js';

function page(overrides = {}) {
  return {
    requestedUrl: 'https://example.com/',
    finalUrl: 'https://example.com/',
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', ...HTML_HEADERS },
    html: GOOD_PAGE,
    bytes: 4200,
    truncated: false,
    redirects: [],
    timings: { totalMs: 240 },
    ...overrides,
  };
}

const statusOf = (report, id) => report.checks.find((check) => check.id === id)?.status;

describe('analyze', () => {
  it('extracts the page metadata', () => {
    const report = analyze(page());

    expect(report.page.title).toContain('Kettle Bridge Coffee');
    expect(report.page.metaDescription).toMatch(/small-batch coffee roastery/i);
    expect(report.page.canonical).toBe('https://example.com/');
    expect(report.page.lang).toBe('en');
    expect(report.page.viewport).toContain('width=device-width');
    expect(report.page.openGraph['og:title']).toBe('Kettle Bridge Coffee');
  });

  it('counts content structure', () => {
    const report = analyze(page());

    expect(report.content.headings.h1).toBe(1);
    expect(report.content.headings.h2).toBe(1);
    expect(report.content.images).toEqual({ total: 1, missingAlt: 0 });
    expect(report.content.links).toMatchObject({ internal: 1, external: 1, total: 2 });
    expect(report.content.wordCount).toBeGreaterThan(100);
  });

  it('does not count script contents as page text', () => {
    const report = analyze(page({ html: '<html><body><script>const words = "a b c d e";</script><p>one two</p></body></html>' }));

    expect(report.content.wordCount).toBe(2);
  });

  it('scores every category and an overall grade', () => {
    const report = analyze(page());

    for (const category of ['availability', 'seo', 'accessibility', 'performance', 'security']) {
      expect(report.scores[category]).toBeGreaterThanOrEqual(0);
      expect(report.scores[category]).toBeLessThanOrEqual(100);
    }
    expect(report.scores.overall).toBeGreaterThan(80);
    expect(report.scores.grade).toMatch(/[AB]/);
    expect(report.scores.summary.total).toBe(report.checks.length);
  });

  it('flags the failings of a neglected page', () => {
    const report = analyze(page({ html: POOR_PAGE, headers: { 'content-type': 'text/html' } }));

    expect(statusOf(report, 'title_present')).toBe('fail');
    expect(statusOf(report, 'meta_description_present')).toBe('fail');
    expect(statusOf(report, 'single_h1')).toBe('fail');
    expect(statusOf(report, 'viewport_meta')).toBe('fail');
    expect(statusOf(report, 'lang_attribute')).toBe('fail');
    expect(statusOf(report, 'images_have_alt')).toBe('fail');
    expect(statusOf(report, 'render_blocking_scripts')).toBe('warn');
    expect(statusOf(report, 'descriptive_links')).toBe('fail');
    expect(report.scores.overall).toBeLessThan(50);
  });

  it('detects mixed content only on HTTPS pages', () => {
    const https = analyze(page({ html: POOR_PAGE }));
    const http = analyze(page({ html: POOR_PAGE, finalUrl: 'http://example.com/' }));

    expect(https.security.mixedContentReferences).toBe(1);
    expect(statusOf(https, 'no_mixed_content')).toBe('fail');
    expect(http.security.mixedContentReferences).toBe(0);
    expect(statusOf(http, 'https')).toBe('fail');
  });

  it('penalises slow responses and heavy documents', () => {
    const fast = analyze(page({ timings: { totalMs: 200 }, bytes: 20_000 }));
    const slow = analyze(page({ timings: { totalMs: 4200 }, bytes: 900_000 }));

    expect(statusOf(fast, 'response_time')).toBe('pass');
    expect(statusOf(slow, 'response_time')).toBe('fail');
    expect(statusOf(slow, 'document_weight')).toBe('fail');
    expect(slow.scores.performance).toBeLessThan(fast.scores.performance);
  });

  it('treats a noindex directive as an SEO failure', () => {
    const report = analyze(
      page({ html: GOOD_PAGE.replace('<meta charset="utf-8" />', '<meta charset="utf-8" /><meta name="robots" content="noindex, nofollow" />') }),
    );

    expect(statusOf(report, 'indexable')).toBe('fail');
  });

  it('records the redirect chain in the availability score', () => {
    const report = analyze(
      page({
        redirects: [
          { from: 'https://example.com/', to: 'https://a.example/', status: 301 },
          { from: 'https://a.example/', to: 'https://b.example/', status: 302 },
        ],
      }),
    );

    expect(statusOf(report, 'redirect_chain_short')).toBe('fail');
  });

  it('handles an empty document without throwing', () => {
    const report = analyze(page({ html: '', bytes: 0 }));

    expect(report.scores.overall).toBeGreaterThanOrEqual(0);
    expect(report.content.wordCount).toBe(0);
  });

  it('survives malformed markup', () => {
    const report = analyze(page({ html: '<html><head><title>Half a page</title><body><p>unclosed' }));

    expect(report.page.title).toBe('Half a page');
  });
});
