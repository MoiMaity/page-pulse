const form = document.getElementById('audit-form');
const urlInput = document.getElementById('url');
const maxAgeInput = document.getElementById('maxAge');
const freshInput = document.getElementById('fresh');
const submit = document.getElementById('submit');
const statusEl = document.getElementById('status');
const report = document.getElementById('report');
const traceLine = document.getElementById('trace-line');
const traceLegend = document.getElementById('trace-legend');

const CATEGORIES = ['availability', 'seo', 'accessibility', 'performance', 'security'];
const MARKS = { pass: '●', warn: '▲', fail: '■' };

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const url = urlInput.value.trim();
  if (!url) {
    setStatus('Enter an address to audit.', 'error');
    urlInput.focus();
    return;
  }

  const params = new URLSearchParams({ url });
  if (maxAgeInput.value !== '') params.set('maxAge', maxAgeInput.value);
  if (freshInput.checked) params.set('fresh', 'true');

  submit.disabled = true;
  setStatus(`Fetching ${url}…`);

  try {
    const response = await fetch(`/api/audit?${params.toString()}`, {
      headers: { accept: 'application/json' },
    });
    const payload = await response.json();

    if (!response.ok) {
      const { code, message, details } = payload.error ?? {};
      const extra = Array.isArray(details) ? ` (${details.map((d) => `${d.field}: ${d.message}`).join('; ')})` : '';
      setStatus(`${code || response.status} — ${message || 'The audit failed.'}${extra}`, 'error');
      report.hidden = true;
      return;
    }

    render(payload, response.headers.get('X-Cache'));
  } catch {
    setStatus('The service could not be reached. Check your connection and try again.', 'error');
  } finally {
    submit.disabled = false;
  }
});

function render(payload, cacheHeader) {
  const { result, cache, durationMs, requestId } = payload;

  setStatus(
    `${cacheHeader === 'HIT' ? 'Served from cache' : 'Freshly fetched'} in ${durationMs}ms · ` +
      `window ${cache.windowSeconds}s · request ${requestId}`,
  );

  document.getElementById('grade').textContent = result.scores.grade;
  document.getElementById('overall').textContent = `${result.scores.overall}/100`;

  const { summary } = result.scores;
  setFacts({
    'Final URL': result.finalUrl,
    Status: `HTTP ${result.http.status}`,
    'Response time': `${result.http.responseTimeMs} ms`,
    'Document size': formatBytes(result.http.htmlBytes),
    Redirects: String(result.http.redirects.length),
    Checks: `${summary.passed} passed · ${summary.warnings} warned · ${summary.failed} failed`,
  });

  drawTrace(result.scores);
  drawBars(result.scores);
  drawChecks(result.checks);

  document.getElementById('raw').textContent = JSON.stringify(payload, null, 2);
  report.hidden = false;
}

function setFacts(facts) {
  const dl = document.getElementById('facts');
  dl.replaceChildren();
  for (const [term, value] of Object.entries(facts)) {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.append(dt, dd);
  }
}

/** The signature: one peak per category, peak height carries the score. */
function drawTrace(scores) {
  const width = 600;
  const baseline = 60;
  const points = [[0, baseline]];

  CATEGORIES.forEach((category, index) => {
    const score = scores[category] ?? 0;
    const amplitude = 6 + (score / 100) * 46;
    const cx = 62 + index * 118;

    points.push([cx - 26, baseline]);
    points.push([cx - 10, baseline + 9]);
    points.push([cx, baseline - amplitude]);
    points.push([cx + 10, baseline + 11]);
    points.push([cx + 24, baseline]);
  });

  points.push([width, baseline]);

  traceLine.setAttribute('points', points.map(([x, y]) => `${x},${y}`).join(' '));
  traceLine.classList.remove('drawing');
  void traceLine.getBBox();
  traceLine.classList.add('drawing');

  traceLegend.replaceChildren();
  for (const category of CATEGORIES) {
    const li = document.createElement('li');
    const value = document.createElement('b');
    value.textContent = scores[category] ?? '—';
    li.append(value, document.createTextNode(category));
    traceLegend.append(li);
  }
  traceLegend.hidden = false;
}

function drawBars(scores) {
  const container = document.getElementById('bars');
  container.replaceChildren();

  for (const category of CATEGORIES) {
    const value = scores[category] ?? 0;

    const row = document.createElement('div');
    row.className = 'bar';

    const label = document.createElement('span');
    label.textContent = category;

    const track = document.createElement('span');
    track.className = 'bar-track';
    const fill = document.createElement('span');
    fill.className = 'bar-fill';
    fill.style.width = `${value}%`;
    track.append(fill);

    const number = document.createElement('span');
    number.className = 'bar-value';
    number.textContent = value;

    row.append(label, track, number);
    container.append(row);
  }
}

function drawChecks(checks) {
  const container = document.getElementById('checks');
  container.replaceChildren();

  for (const category of CATEGORIES) {
    const group = checks.filter((check) => check.category === category);
    if (group.length === 0) continue;

    const section = document.createElement('section');
    section.className = 'check-group';

    const heading = document.createElement('h3');
    heading.textContent = category;
    section.append(heading);

    // Problems first — that is what someone is here to fix.
    const order = { fail: 0, warn: 1, pass: 2 };
    for (const check of [...group].sort((a, b) => order[a.status] - order[b.status])) {
      const row = document.createElement('div');
      row.className = 'check';
      row.dataset.status = check.status;

      const mark = document.createElement('span');
      mark.className = 'check-mark';
      mark.textContent = MARKS[check.status];
      mark.setAttribute('aria-label', check.status);

      const body = document.createElement('p');
      body.style.margin = '0';
      const id = document.createElement('span');
      id.className = 'check-id';
      id.textContent = check.id.replace(/_/g, ' ');
      body.append(id, document.createTextNode(check.message));

      row.append(mark, body);
      section.append(row);
    }

    container.append(section);
  }
}

function setStatus(message, tone) {
  statusEl.textContent = message;
  if (tone) statusEl.dataset.tone = tone;
  else delete statusEl.dataset.tone;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
