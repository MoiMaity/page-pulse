import * as cheerio from 'cheerio';

const CATEGORIES = ['availability', 'seo', 'accessibility', 'performance', 'security'];
const VAGUE_LINK_TEXT = new Set(['click here', 'here', 'read more', 'more', 'link', 'this', 'learn more']);

/**
 * Turns a fetched page into a report: measured facts, a list of pass/warn/fail
 * checks, and a weighted score per category.
 *
 * Pure and synchronous — everything it needs is in `page`, which makes it
 * trivially testable against fixture HTML.
 *
 * @param {object} page output of fetchPage()
 */
export function analyze(page) {
  const $ = cheerio.load(page.html || '');
  const finalUrl = new URL(page.finalUrl);
  const headers = page.headers || {};

  $('script, style, noscript, template').remove();
  const textContent = $('body').text().replace(/\s+/g, ' ').trim();

  const $full = cheerio.load(page.html || '');
  const facts = collectFacts($full, finalUrl, headers, page, textContent);
  const checks = runChecks(facts, page);
  const scores = score(checks);

  return {
    requestedUrl: page.requestedUrl,
    finalUrl: page.finalUrl,
    fetchedAt: new Date().toISOString(),
    http: {
      status: page.status,
      contentType: headers['content-type'] || null,
      contentEncoding: headers['content-encoding'] || null,
      cacheControl: headers['cache-control'] || null,
      server: headers.server || null,
      redirects: page.redirects,
      responseTimeMs: page.timings.totalMs,
      htmlBytes: page.bytes,
      truncated: page.truncated,
    },
    page: facts.meta,
    content: facts.content,
    security: facts.security,
    checks,
    scores,
  };
}

function collectFacts($, finalUrl, headers, page, textContent) {
  const title = text($('head > title').first()) || text($('title').first());
  const metaDescription = attr($, 'meta[name="description"]', 'content');
  const canonical = attr($, 'link[rel="canonical"]', 'href');
  const viewport = attr($, 'meta[name="viewport"]', 'content');
  const robots = attr($, 'meta[name="robots"]', 'content');
  const charset =
    attr($, 'meta[charset]', 'charset') ||
    (/charset=([\w-]+)/i.exec(attr($, 'meta[http-equiv="content-type"]', 'content') || '')?.[1] ?? null);
  const lang = $('html').attr('lang') || null;

  const openGraph = {};
  $('meta[property^="og:"]').each((_, el) => {
    const key = $(el).attr('property');
    const value = $(el).attr('content');
    if (key && value) openGraph[key] = value;
  });

  const images = $('img');
  const imagesMissingAlt = images.filter((_, el) => {
    const alt = $(el).attr('alt');
    return alt === undefined || alt === null;
  }).length;

  const headings = {};
  let previousLevel = 0;
  let skippedHeadingLevel = false;
  $('h1, h2, h3, h4, h5, h6').each((_, el) => {
    const level = Number(el.tagName.slice(1));
    headings[el.tagName.toLowerCase()] = (headings[el.tagName.toLowerCase()] || 0) + 1;
    if (previousLevel && level > previousLevel + 1) skippedHeadingLevel = true;
    previousLevel = level;
  });

  let internalLinks = 0;
  let externalLinks = 0;
  let vagueLinks = 0;
  let emptyLinks = 0;

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    const label = $(el).text().replace(/\s+/g, ' ').trim().toLowerCase();

    if (!label && !$(el).find('img[alt]').length && !$(el).attr('aria-label')) emptyLinks += 1;
    else if (VAGUE_LINK_TEXT.has(label)) vagueLinks += 1;

    try {
      const resolved = new URL(href, finalUrl);
      if (resolved.host === finalUrl.host) internalLinks += 1;
      else if (resolved.protocol === 'http:' || resolved.protocol === 'https:') externalLinks += 1;
    } catch {
      /* mailto:, tel:, javascript: and malformed hrefs are not page links */
    }
  });

  const isHttps = finalUrl.protocol === 'https:';
  let mixedContent = 0;
  if (isHttps) {
    $('[src], [href]').each((_, el) => {
      const value = $(el).attr('src') || $(el).attr('href');
      if (value && /^http:\/\//i.test(value)) mixedContent += 1;
    });
  }

  const blockingScripts = $('head script[src]').filter((_, el) => {
    const $el = $(el);
    return $el.attr('defer') === undefined && $el.attr('async') === undefined;
  }).length;

  return {
    meta: {
      title,
      titleLength: title ? title.length : 0,
      metaDescription,
      metaDescriptionLength: metaDescription ? metaDescription.length : 0,
      canonical,
      viewport,
      robots,
      charset,
      lang,
      openGraph,
      favicon: attr($, 'link[rel~="icon"]', 'href'),
    },
    content: {
      wordCount: textContent ? textContent.split(' ').filter(Boolean).length : 0,
      headings,
      images: { total: images.length, missingAlt: imagesMissingAlt },
      links: { total: internalLinks + externalLinks, internal: internalLinks, external: externalLinks, vagueText: vagueLinks, empty: emptyLinks },
      scripts: $('script').length,
      blockingScripts,
      stylesheets: $('link[rel="stylesheet"]').length,
      inlineStyles: $('[style]').length,
    },
    security: {
      https: isHttps,
      hsts: headers['strict-transport-security'] || null,
      contentSecurityPolicy: headers['content-security-policy'] || null,
      xContentTypeOptions: headers['x-content-type-options'] || null,
      xFrameOptions: headers['x-frame-options'] || null,
      referrerPolicy: headers['referrer-policy'] || null,
      permissionsPolicy: headers['permissions-policy'] || null,
      mixedContentReferences: mixedContent,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Checks                                                                     */
/* -------------------------------------------------------------------------- */

function runChecks(facts, page) {
  const { meta, content, security } = facts;
  const checks = [];
  const add = (id, category, weight, status, message) => checks.push({ id, category, weight, status, message });

  // Availability -----------------------------------------------------------
  add(
    'http_status_ok',
    'availability',
    3,
    page.status < 400 ? 'pass' : 'fail',
    `The page responded with HTTP ${page.status}.`,
  );
  add(
    'redirect_chain_short',
    'availability',
    1,
    page.redirects.length === 0 ? 'pass' : page.redirects.length === 1 ? 'warn' : 'fail',
    page.redirects.length === 0
      ? 'The URL resolved without redirects.'
      : `The URL went through ${page.redirects.length} redirect(s) before resolving.`,
  );

  // SEO ---------------------------------------------------------------------
  add('title_present', 'seo', 3, meta.title ? 'pass' : 'fail',
    meta.title ? `Title: "${truncate(meta.title, 70)}"` : 'The page has no <title> element.');

  add('title_length', 'seo', 2,
    !meta.title ? 'fail' : meta.titleLength >= 15 && meta.titleLength <= 60 ? 'pass' : 'warn',
    `The title is ${meta.titleLength} characters; 15–60 renders without truncation in search results.`);

  add('meta_description_present', 'seo', 3, meta.metaDescription ? 'pass' : 'fail',
    meta.metaDescription ? 'A meta description is present.' : 'The page has no meta description.');

  add('meta_description_length', 'seo', 2,
    !meta.metaDescription ? 'fail' : meta.metaDescriptionLength >= 50 && meta.metaDescriptionLength <= 160 ? 'pass' : 'warn',
    `The meta description is ${meta.metaDescriptionLength} characters; aim for 50–160.`);

  const h1Count = content.headings.h1 || 0;
  add('single_h1', 'seo', 2, h1Count === 1 ? 'pass' : h1Count === 0 ? 'fail' : 'warn',
    `The page has ${h1Count} <h1> element(s); exactly one describes the page best.`);

  add('canonical_present', 'seo', 1, meta.canonical ? 'pass' : 'warn',
    meta.canonical ? `Canonical URL: ${truncate(meta.canonical, 80)}` : 'No canonical link, so duplicate URLs may compete.');

  add('indexable', 'seo', 2, /noindex/i.test(meta.robots || '') ? 'fail' : 'pass',
    /noindex/i.test(meta.robots || '') ? 'The robots meta tag blocks indexing.' : 'Nothing in the markup blocks indexing.');

  const hasOg = Boolean(meta.openGraph['og:title'] && (meta.openGraph['og:description'] || meta.openGraph['og:image']));
  add('social_preview', 'seo', 1, hasOg ? 'pass' : 'warn',
    hasOg ? 'Open Graph tags are set for link previews.' : 'Open Graph tags are missing, so shared links preview poorly.');

  add('has_content', 'seo', 1, content.wordCount >= 250 ? 'pass' : content.wordCount >= 50 ? 'warn' : 'fail',
    `The page contains roughly ${content.wordCount} words of text.`);

  // Accessibility -----------------------------------------------------------
  const { total: imageCount, missingAlt } = content.images;
  add('images_have_alt', 'accessibility', 3,
    imageCount === 0 ? 'pass' : missingAlt === 0 ? 'pass' : missingAlt / imageCount <= 0.2 ? 'warn' : 'fail',
    imageCount === 0 ? 'The page has no images to describe.' : `${missingAlt} of ${imageCount} images have no alt attribute.`);

  add('viewport_meta', 'accessibility', 2, meta.viewport ? 'pass' : 'fail',
    meta.viewport ? 'A viewport meta tag is set for small screens.' : 'No viewport meta tag, so the page will not scale on mobile.');

  add('lang_attribute', 'accessibility', 2, meta.lang ? 'pass' : 'fail',
    meta.lang ? `The document language is declared as "${meta.lang}".` : 'The <html> element has no lang attribute, so screen readers guess.');

  add('heading_order', 'accessibility', 1, content.headings.h1 || content.headings.h2 ? 'pass' : 'warn',
    Object.keys(content.headings).length ? 'The page uses heading elements to structure content.' : 'The page has no headings.');

  add('descriptive_links', 'accessibility', 1,
    content.links.empty === 0 && content.links.vagueText === 0 ? 'pass' : content.links.empty > 0 ? 'fail' : 'warn',
    `${content.links.empty} link(s) have no accessible name and ${content.links.vagueText} use non-descriptive text.`);

  add('charset_declared', 'accessibility', 1, meta.charset ? 'pass' : 'warn',
    meta.charset ? `Character encoding declared as ${meta.charset}.` : 'No character encoding is declared in the markup.');

  // Performance -------------------------------------------------------------
  const ms = page.timings.totalMs;
  add('response_time', 'performance', 3, ms <= 800 ? 'pass' : ms <= 2000 ? 'warn' : 'fail',
    `The document took ${ms}ms to fetch.`);

  add('document_weight', 'performance', 2,
    page.bytes <= 150_000 ? 'pass' : page.bytes <= 400_000 ? 'warn' : 'fail',
    `The HTML document is ${formatBytes(page.bytes)}${page.truncated ? ' (truncated at the read limit)' : ''}.`);

  add('compression_enabled', 'performance', 2, page.headers['content-encoding'] ? 'pass' : 'warn',
    page.headers['content-encoding']
      ? `The response is compressed with ${page.headers['content-encoding']}.`
      : 'The response is served uncompressed.');

  add('cache_headers', 'performance', 1, page.headers['cache-control'] || page.headers.etag ? 'pass' : 'warn',
    page.headers['cache-control'] || page.headers.etag
      ? 'Caching headers are present.'
      : 'No Cache-Control or ETag header, so every visit refetches.');

  add('render_blocking_scripts', 'performance', 2,
    content.blockingScripts === 0 ? 'pass' : content.blockingScripts <= 2 ? 'warn' : 'fail',
    `${content.blockingScripts} script(s) in <head> block rendering (no defer or async).`);

  // Security ----------------------------------------------------------------
  add('https', 'security', 3, security.https ? 'pass' : 'fail',
    security.https ? 'The page is served over HTTPS.' : 'The page is served over plain HTTP.');

  add('hsts', 'security', 2, security.hsts ? 'pass' : security.https ? 'warn' : 'fail',
    security.hsts ? 'Strict-Transport-Security is set.' : 'No Strict-Transport-Security header.');

  add('content_security_policy', 'security', 2, security.contentSecurityPolicy ? 'pass' : 'warn',
    security.contentSecurityPolicy ? 'A Content-Security-Policy is set.' : 'No Content-Security-Policy header.');

  add('x_content_type_options', 'security', 1, /nosniff/i.test(security.xContentTypeOptions || '') ? 'pass' : 'warn',
    /nosniff/i.test(security.xContentTypeOptions || '') ? 'MIME sniffing is disabled.' : 'No X-Content-Type-Options: nosniff header.');

  const framingProtected =
    Boolean(security.xFrameOptions) || /frame-ancestors/i.test(security.contentSecurityPolicy || '');
  add('clickjacking_protection', 'security', 1, framingProtected ? 'pass' : 'warn',
    framingProtected ? 'Framing is restricted.' : 'Nothing prevents the page being framed by another site.');

  add('referrer_policy', 'security', 1, security.referrerPolicy ? 'pass' : 'warn',
    security.referrerPolicy ? `Referrer-Policy: ${security.referrerPolicy}` : 'No Referrer-Policy header.');

  add('no_mixed_content', 'security', 2,
    !security.https || security.mixedContentReferences === 0 ? 'pass' : 'fail',
    security.mixedContentReferences === 0
      ? 'No insecure sub-resources referenced.'
      : `${security.mixedContentReferences} sub-resource(s) are loaded over plain HTTP.`);

  return checks;
}

/* -------------------------------------------------------------------------- */
/* Scoring                                                                    */
/* -------------------------------------------------------------------------- */

const STATUS_VALUE = { pass: 1, warn: 0.5, fail: 0 };

function score(checks) {
  const byCategory = {};

  for (const category of CATEGORIES) {
    const relevant = checks.filter((check) => check.category === category);
    byCategory[category] = weighted(relevant);
  }

  const overall = weighted(checks);

  return {
    ...byCategory,
    overall,
    grade: grade(overall),
    summary: {
      passed: checks.filter((c) => c.status === 'pass').length,
      warnings: checks.filter((c) => c.status === 'warn').length,
      failed: checks.filter((c) => c.status === 'fail').length,
      total: checks.length,
    },
  };
}

function weighted(checks) {
  if (checks.length === 0) return null;
  const totalWeight = checks.reduce((sum, c) => sum + c.weight, 0);
  const earned = checks.reduce((sum, c) => sum + c.weight * STATUS_VALUE[c.status], 0);
  return Math.round((earned / totalWeight) * 100);
}

function grade(value) {
  if (value >= 90) return 'A';
  if (value >= 80) return 'B';
  if (value >= 70) return 'C';
  if (value >= 60) return 'D';
  return 'F';
}

/* -------------------------------------------------------------------------- */

function text($el) {
  const value = $el.text?.();
  return value ? value.replace(/\s+/g, ' ').trim() || null : null;
}

function attr($, selector, name) {
  const value = $(selector).first().attr(name);
  return value ? value.trim() : null;
}

function truncate(value, max) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
