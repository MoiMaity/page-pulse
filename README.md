# Page Pulse

A URL audit service. Give it an address, it fetches the page once and reports what came back — status and redirect chain, document weight, metadata, headings and alt text, caching and security headers — scored out of 100 across five categories.

This is the production build of the task: the interesting part is not the audit, it is everything wrapped around it. Validation and SSRF protection, a hard timeout and byte cap on every outbound fetch, a bounded concurrency queue that sheds load instead of collapsing, a configurable cache window, per-client rate limiting, one structured log line per request with a traceable request ID, one error shape for every failure, and a test suite that runs offline in CI on every push.

- **Live:** `https://page-pulse-oozv.onrender.com/` 
- **Repo:** `https://github.com/MoiMaity/page-pulse`

---

## Contents

- [Quick start](#quick-start)
- [API contract](#api-contract)
- [Errors](#errors)
- [Caching](#caching)
- [Rate limiting](#rate-limiting)
- [Concurrency and timeouts](#concurrency-and-timeouts)
- [Logging](#logging)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Tests and CI](#tests-and-ci)
- [Deploy](#deploy)
- [Known limits](#known-limits)

---

## Quick start

```bash
git clone https://github.com/<your-username>/page-pulse.git
cd page-pulse
cp .env.example .env
npm install            # first run: generates package-lock.json — commit it
npm run dev            # http://localhost:3000
```

> **Commit `package-lock.json`.** CI and the Dockerfile both use `npm ci`, which
> refuses to run without a lockfile. Run `npm install` once before your first
> push and commit the result; after that `npm ci` is the right command everywhere.

```bash
curl -s "http://localhost:3000/api/audit?url=example.com" | jq '.result.scores'
```

Requires Node 20 or newer. There is no database and no external service: state is in-process by design (see [Known limits](#known-limits)).

---

## API contract

Base URL: `https://<your-deployment>`
All responses are `application/json; charset=utf-8`. Every response carries an `X-Request-Id` header.

### `GET /api/audit`

Audit a URL. Parameters go in the query string.

### `POST /api/audit`

Identical behaviour; parameters go in a JSON body (`Content-Type: application/json`, max 8 KB).

#### Parameters

| Name | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `url` | string | yes | — | Absolute URL, or a bare host (`example.com/pricing`) which is upgraded to `https://`. Max 2048 chars. Only `http` and `https`. |
| `maxAge` | integer (seconds) | no | `CACHE_TTL_SECONDS` (300) | Oldest cached result the client will accept. `0` forces a refetch. Clamped to `CACHE_MAX_TTL_SECONDS`. |
| `fresh` | boolean | no | `false` | `true` skips the cache read entirely and refreshes the entry. |

Unknown parameters are **rejected**, not ignored — a typo fails loudly rather than silently changing behaviour.

#### Example request

```bash
curl -s -X POST https://<your-deployment>/api/audit \
  -H 'content-type: application/json' \
  -H 'x-request-id: checkout-regression-42' \
  -d '{"url": "https://example.com", "maxAge": 60}'
```

#### `200 OK`

```jsonc
{
  "requestId": "checkout-regression-42",
  "durationMs": 412,
  "cache": {
    "hit": false,
    "ageSeconds": 0,
    "windowSeconds": 60,
    "expiresAt": "2026-07-25T10:31:00.000Z"
  },
  "result": {
    "requestedUrl": "https://example.com/",
    "finalUrl": "https://www.example.com/",
    "fetchedAt": "2026-07-25T10:30:00.000Z",

    "http": {
      "status": 200,
      "contentType": "text/html; charset=utf-8",
      "contentEncoding": "gzip",
      "cacheControl": "public, max-age=600",
      "server": "nginx",
      "redirects": [
        { "from": "https://example.com/", "to": "https://www.example.com/", "status": 301 }
      ],
      "responseTimeMs": 268,
      "htmlBytes": 41233,
      "truncated": false
    },

    "page": {
      "title": "Example Domain",
      "titleLength": 14,
      "metaDescription": "…",
      "metaDescriptionLength": 112,
      "canonical": "https://www.example.com/",
      "viewport": "width=device-width, initial-scale=1",
      "robots": null,
      "charset": "utf-8",
      "lang": "en",
      "openGraph": { "og:title": "Example Domain" },
      "favicon": "/favicon.ico"
    },

    "content": {
      "wordCount": 842,
      "headings": { "h1": 1, "h2": 4 },
      "images": { "total": 12, "missingAlt": 2 },
      "links": { "total": 38, "internal": 31, "external": 7, "vagueText": 1, "empty": 0 },
      "scripts": 6,
      "blockingScripts": 1,
      "stylesheets": 2,
      "inlineStyles": 4
    },

    "security": {
      "https": true,
      "hsts": "max-age=31536000",
      "contentSecurityPolicy": "default-src 'self'",
      "xContentTypeOptions": "nosniff",
      "xFrameOptions": "DENY",
      "referrerPolicy": "strict-origin-when-cross-origin",
      "permissionsPolicy": null,
      "mixedContentReferences": 0
    },

    "checks": [
      {
        "id": "meta_description_length",
        "category": "seo",
        "weight": 2,
        "status": "warn",
        "message": "The meta description is 112 characters; aim for 50–160."
      }
    ],

    "scores": {
      "availability": 100,
      "seo": 88,
      "accessibility": 92,
      "performance": 75,
      "security": 96,
      "overall": 89,
      "grade": "B",
      "summary": { "passed": 22, "warnings": 3, "failed": 1, "total": 26 }
    }
  }
}
```

`checks[].status` is always one of `pass`, `warn`, `fail`. Check `id` values are stable and safe to assert on in your own tests; `message` is human-facing and may be reworded.

Scores are weighted: each check contributes its `weight`, scoring full for `pass`, half for `warn`, nothing for `fail`. A category score is the weighted percentage of its own checks; `overall` is the weighted percentage of all of them.

#### Response headers

| Header | Meaning |
| --- | --- |
| `X-Request-Id` | Echoed from the request if well-formed, otherwise generated. Quote this in bug reports. |
| `X-Cache` | `HIT` or `MISS`. |
| `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` | Current allowance and seconds until the window resets. |
| `Retry-After` | Present on `429` and `503`. |

### `GET /healthz`

Liveness probe. Never rate limited, never touches the network.

```json
{ "status": "ok", "uptimeSeconds": 3600, "version": "1.0.0", "env": "production" }
```

### `GET /api/stats`

Operational counters: cache size and hit ratio, active and queued audits, coalesced requests, tracked rate-limit clients, memory. Rate limited like any other `/api` route.

---

## Errors

Every failure — validation, policy, upstream, crash — uses one envelope. There is no second shape to special-case.

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The request parameters are invalid.",
    "details": [{ "field": "url", "message": "url is required" }],
    "requestId": "01J2K…",
    "timestamp": "2026-07-25T10:30:00.000Z"
  }
}
```

`details` appears only when there is something field-specific to say. Switch on `code`, not on `message`.

| Status | `code` | When |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Missing, malformed or unknown parameters. |
| 400 | `INVALID_URL` | `url` could not be parsed. |
| 400 | `UNSUPPORTED_PROTOCOL` | Not `http` or `https`. |
| 400 | `INVALID_JSON` | Body is not valid JSON. |
| 400 | `DNS_RESOLUTION_FAILED` | The hostname does not resolve. |
| 403 | `URL_NOT_ALLOWED` | Credentials in the URL, or the target resolves to a private, loopback or link-local address. |
| 404 | `NOT_FOUND` | No such route. |
| 413 | `PAYLOAD_TOO_LARGE` | Request body over the limit. |
| 415 | `UNSUPPORTED_CONTENT_TYPE` | The target returned 2xx with something that is not HTML. |
| 429 | `RATE_LIMITED` | Client allowance exhausted. Honour `Retry-After`. |
| 500 | `INTERNAL_ERROR` | Unexpected. Quote the `requestId`. |
| 502 | `UPSTREAM_UNREACHABLE` | DNS, TLS or connection failure at the target. |
| 502 | `UPSTREAM_TOO_LARGE` | Target declared a body over `FETCH_MAX_BYTES`. |
| 502 | `TOO_MANY_REDIRECTS` | Redirect chain longer than `FETCH_MAX_REDIRECTS`. |
| 502 | `UPSTREAM_INVALID_REDIRECT` | Redirect with a missing or unparsable `Location`. |
| 503 | `SERVER_BUSY` | Audit queue full. Retry after `Retry-After`. |
| 504 | `UPSTREAM_TIMEOUT` | Target did not respond within `FETCH_TIMEOUT_MS`. |

A target site answering `404` or `500` is **not** an error here: that is a finding. You get `200` with `http.status` set and the `http_status_ok` check failed.

---

## Caching

A repeat audit of the same URL inside the window is served from memory without refetching.

- The cache key is `protocol + host + path + query`. Fragments are stripped, so `/pricing#plans` and `/pricing` share an entry. Different query strings are different pages.
- The default window is `CACHE_TTL_SECONDS` (300s). A client may narrow it per request with `maxAge`, up to `CACHE_MAX_TTL_SECONDS`.
- `fresh=true` skips the read and refreshes the entry.
- `CACHE_TTL_SECONDS=0` disables cache reads entirely.
- Entries are stored for `CACHE_MAX_TTL_SECONDS` and evicted LRU past `CACHE_MAX_ENTRIES`, so a short default window and a client asking for a longer one can coexist.
- Concurrent audits of the same URL are **coalesced**: the first does the fetch, the rest await it and the response is marked `"coalesced": true`. A cache alone would let ten simultaneous cold requests hit the target ten times.

`X-Cache: HIT | MISS` on every audit response, and `cache.ageSeconds` tells you how stale the served result is.

---

## Rate limiting

Fixed window, per client, applied to `/api/*` before any outbound work happens.

- Key: `X-Api-Key` when present, otherwise the client IP derived through `TRUST_PROXY` hops.
- Defaults: 20 requests per 60 seconds. `RateLimit-*` headers on every response; `Retry-After` on `429`.
- Rejected requests still count against the window, so retry storms do not extend it.
- `/healthz` and the static page are exempt — an uptime check should never be throttled.

Fixed window rather than a token bucket because the reset time is then an exact number the client can act on.

---

## Concurrency and timeouts

Every outbound fetch passes through a bounded semaphore:

- Up to `MAX_CONCURRENT_AUDITS` (8) run at once.
- Up to `MAX_QUEUED_AUDITS` (32) wait.
- Beyond that the request is shed immediately with `503 SERVER_BUSY` and a `Retry-After`. An unbounded queue turns a spike into unbounded memory and unbounded latency; shedding is the better failure.

Each fetch is bounded three ways: a whole-operation deadline of `FETCH_TIMEOUT_MS` covering connect, redirects and body read; a `FETCH_MAX_BYTES` cap enforced while streaming, not after; and at most `FETCH_MAX_REDIRECTS` hops.

Redirects are followed manually so the SSRF guard runs on **every hop** — validating only the first URL leaves the door open to a public host that redirects to `127.0.0.1` or `169.254.169.254`. The guard rejects loopback, private, CGNAT, link-local, multicast and reserved ranges in both IPv4 and IPv6, blocks `localhost`/`.internal`/`.local` style names, and rejects a hostname if *any* resolved address is private.

---

## Logging

One JSON line per request on stdout, plus lines for cache hits and misses, redirects, rate-limit rejections and failures. Every line carries `requestId`.

```json
{"level":"info","time":"2026-07-25T10:30:00.412Z","service":"page-pulse","env":"production","requestId":"01J2K…","event":"request_completed","method":"GET","path":"/api/audit?url=example.com","status":200,"durationMs":412.35,"ip":"203.0.113.10","cache":"MISS"}
```

`X-Request-Id` is reused from the edge when it looks sane (`[A-Za-z0-9._:-]{8,128}`) and generated otherwise, so a trace ID set by your load balancer survives into these logs. `authorization` and `cookie` headers are redacted.

---

## Configuration

All configuration is environment variables, validated at boot — a bad value fails the deploy instead of the first request. See `.env.example`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Listen address. |
| `NODE_ENV` | `development` | `development` \| `test` \| `production`. |
| `LOG_LEVEL` | `info` | Pino level. |
| `TRUST_PROXY` | `1` | Proxy hops in front of the app. |
| `CACHE_TTL_SECONDS` | `300` | Default freshness window. `0` disables. |
| `CACHE_MAX_TTL_SECONDS` | `3600` | Ceiling for `maxAge`, and entry lifetime. |
| `CACHE_MAX_ENTRIES` | `500` | LRU capacity. |
| `RATE_LIMIT_WINDOW_SECONDS` | `60` | Window length. |
| `RATE_LIMIT_MAX_REQUESTS` | `20` | Requests per window per client. |
| `MAX_CONCURRENT_AUDITS` | `8` | Simultaneous outbound fetches. |
| `MAX_QUEUED_AUDITS` | `32` | Queue depth before shedding. |
| `FETCH_TIMEOUT_MS` | `8000` | Whole-fetch deadline. |
| `FETCH_MAX_BYTES` | `2000000` | Body cap; larger bodies are truncated and flagged. |
| `FETCH_MAX_REDIRECTS` | `5` | Hop limit. |
| `USER_AGENT` | `PagePulseBot/1.0 …` | Sent on every outbound request. |
| `SSRF_PROTECTION` | `strict` | `off` permits private targets — local use only. |
| `BODY_LIMIT` | `8kb` | Max JSON body. |

---

## Architecture

```
request
  │
  ├─ helmet · compression · json(8kb)
  ├─ requestId          → X-Request-Id, req.id
  ├─ requestLogger      → child logger, one line on finish
  ├─ /healthz · static  (never rate limited)
  ├─ rateLimiter        → 429 before any outbound work
  └─ /api/audit
       ├─ zod validation        → 400 VALIDATION_ERROR
       ├─ normalizeUrl          → 400 INVALID_URL / 403 URL_NOT_ALLOWED
       └─ auditor
            ├─ cache read       → X-Cache: HIT, done
            ├─ singleFlight     → share an in-progress fetch
            ├─ semaphore        → 503 SERVER_BUSY when the queue is full
            ├─ fetcher          → SSRF guard per hop, deadline, byte cap
            ├─ analyzer         → checks + weighted scores
            └─ cache write
  │
  └─ errorHandler       → one JSON envelope for everything
```

```
src/
  app.js                 composition root — every collaborator is injectable
  server.js              listen, SIGTERM handling, graceful shutdown
  config.js              env schema, parsed and frozen at boot
  logger.js              pino to stdout
  lib/
    cache.js             TTL + LRU store
    semaphore.js         bounded concurrency
    single-flight.js     request coalescing
    url-guard.js         normalisation + SSRF policy
    errors.js            HttpError and the error taxonomy
    async-handler.js     promise → next(err)
  middleware/            request-id, request-logger, rate-limit, error-handler
  routes/                audit, health
  services/
    fetcher.js           bounded HTTP with per-hop validation
    analyzer.js          pure HTML → checks + scores
    auditor.js           cache · coalesce · limit · fetch · analyze
  public/                the page at /
tests/                   9 suites, no network access
```

`createApp()` takes `fetchImpl` and `lookup` as overrides. That single decision is what makes the suite fast and hermetic: tests stub the network at the boundary and still exercise the real guard, the real cache, the real limiter.

---

## Tests and CI

```bash
npm test              # ~90 assertions across 9 suites
npm run test:coverage # thresholds enforced (70% lines/functions/statements)
npm run lint
```

The suite runs entirely offline. It covers:

| Suite | Covers |
| --- | --- |
| `validation.test.js` | Missing/empty/oversized/unknown params, bad protocols, embedded credentials, malformed JSON, bare-host upgrade |
| `audit.test.js` | Report shape, good vs neglected scoring, 404 targets, non-HTML, timeouts, unreachable hosts, oversized and streamed bodies, redirect chains, SSRF including per-hop |
| `cache.test.js` | HIT/MISS, fragment and query key handling, `fresh`, `maxAge`, disabled cache, coalescing, plus TtlCache expiry/LRU/stats units |
| `rate-limit.test.js` | Headers, 429 + `Retry-After`, per-IP and per-key isolation, counted rejections, exempt probe, limit applied before fetching |
| `concurrency.test.js` | Semaphore ceiling, FIFO handoff, load shedding, double release, plus 503 vs queueing end to end |
| `url-guard.test.js` | Normalisation, cache keys, IPv4/IPv6 private ranges, hostname blocklist, multi-answer DNS, DNS failure, disabled mode |
| `analyzer.test.js` | Metadata extraction, content counts, script text exclusion, scoring, mixed content, perf penalties, `noindex`, malformed markup |
| `health.test.js` | Liveness, stats, request-ID generation/reuse/rejection, 404 envelope |

CI (`.github/workflows/ci.yml`) runs on **every push to every branch** and on pull requests:

1. **Lint and test** on Node 20 and 22, with coverage uploaded as an artifact.
2. **Dependency audit** — fails on high-severity advisories.
3. **Docker** — builds the image, boots it, and polls `/healthz` until it answers.

---

## Deploy

Any Node host works. The repo ships a Render blueprint and a Dockerfile.

**Render (blueprint):** push the repo, then *New → Blueprint* and select it. `render.yaml` sets the build and start commands, the health check path and the environment. Or manually: *New → Web Service*, build `npm ci`, start `npm start`, health check `/healthz`, and set `NODE_ENV=production` and `TRUST_PROXY=1`.

**Fly.io:** `fly launch --no-deploy` then `fly deploy` — the Dockerfile is picked up as is. Set `fly secrets set NODE_ENV=production TRUST_PROXY=1`.

**Docker anywhere:**

```bash
docker build -t page-pulse .
docker run -p 3000:3000 -e NODE_ENV=production -e TRUST_PROXY=1 page-pulse
```

After deploying, put the URL at the top of this README and in your submission.

---

## Known limits

Stated plainly, because pretending otherwise is worse than the limits themselves.

- **State is per-process.** Cache and rate-limit counters live in memory, so with *n* replicas each enforces its own share of the limit and each keeps its own cache. `lib/cache.js` and `middleware/rate-limit.js` are deliberately small and swappable for Redis; nothing else changes.
- **Audits are static.** Page Pulse reads the HTML the server sends. It does not run JavaScript, so a client-rendered page will look emptier than it is. Real Core Web Vitals need a headless browser; `responseTimeMs` is a document-fetch measurement, not a user-experienced load time.
- **Scoring is opinionated.** The weights in `analyzer.js` are a judgement about what usually matters, not a standard. They are all in one table, deliberately, so they are easy to argue with and easy to change.
- **`robots.txt` is not consulted.** The service fetches a single page on a human's explicit request, as a browser would. Anything crawling more than that should read `robots.txt` first.
- **No authentication.** `X-Api-Key` is used for rate-limit bucketing only, not to authorise. Put a gateway in front for anything beyond a public demo.

---

<p align="center">
  <a href="https://digitalheroesco.com">Built for Digital Heroes Training Task</a>
</p>
