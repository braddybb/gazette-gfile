// Shared helpers for GFILE's Netlify functions. No npm dependencies.

const env = (k, fallback) => {
  const v = process.env[k];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing environment variable ${k}`);
  }
  return v;
};
export { env };

// ───────── Supabase REST (service role — bypasses RLS, server side only) ─────────
export async function db(path, { method = 'GET', body, prefer, headers = {} } = {}) {
  const url = `${env('SUPABASE_URL').replace(/\/$/, '')}/rest/v1/${path}`;
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const res = await fetch(url, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

// ignore: true keeps existing rows untouched (used when we only have an excerpt).
// PostgREST needs every row in a batch to have the same keys; missing ones fall back to column defaults.
export const upsert = (table, rows, onConflict, { ignore = false } = {}) => {
  if (!rows.length) return Promise.resolve([]);
  const keys = [...new Set(rows.flatMap(r => Object.keys(r)))];
  return db(`${table}?on_conflict=${onConflict}&columns=${keys.join(',')}`, {
    method: 'POST',
    body: rows,
    prefer: `resolution=${ignore ? 'ignore' : 'merge'}-duplicates,missing=default,return=representation`,
  });
};

export async function log(job, ok, detail) {
  try { await db('gf_sync_log', { method: 'POST', body: [{ job, ok, detail }] }); } catch (_) { /* never let logging break a job */ }
}

// ───────── Auth: confirm the caller is a signed-in Gazette user ─────────
export async function requireUser(req) {
  const auth = req.headers.get('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const res = await fetch(`${env('SUPABASE_URL').replace(/\/$/, '')}/auth/v1/user`, {
    headers: { apikey: env('SUPABASE_ANON_KEY'), Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const user = await res.json();
  return user && user.id ? user : null;
}

// Lets the nightly cron call the sync jobs without a user session.
export function isCron(req) {
  const secret = process.env.CRON_SECRET;
  return !!secret && req.headers.get('x-cron-secret') === secret;
}

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

// ───────── OpenAustralia (federal Hansard + members) ─────────
export async function oa(fn, params = {}) {
  const qs = new URLSearchParams({ key: env('OPENAUSTRALIA_KEY'), output: 'js', ...params });
  const res = await fetch(`https://www.openaustralia.org.au/api/${fn}?${qs}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenAustralia ${fn} → ${res.status}${text ? `: ${text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)}` : ''}`);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`OpenAustralia ${fn} returned non-JSON: ${text.slice(0, 200)}`); }
  if (data && data.error) throw new Error(`OpenAustralia ${fn}: ${data.error}`);
  return data;
}

// One person's speeches. OpenAustralia's person lookup can throw server errors, so fall back
// to its search syntax (speaker:ID), which reaches the same data a different way.
export async function oaSpeeches(personId, { num = 50, page = 1 } = {}) {
  const attempts = [
    { person: personId, num: String(num), page: String(page) },
    { search: `speaker:${personId}`, order: 'd', num: String(num), page: String(page) },
    { person: personId, num: '20', page: String(page) },
  ];
  let lastErr;
  for (const a of attempts) {
    try { return await oa('getHansard', a); } catch (e) { lastErr = e; if (!/→ 5\d\d/.test(e.message)) break; }
  }
  throw lastErr;
}

// ───────── They Vote For You (federal voting records) ─────────
export async function tvfy(path) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`https://theyvoteforyou.org.au/api/v1/${path}${sep}key=${encodeURIComponent(env('TVFY_KEY'))}`);
  if (!res.ok) throw new Error(`They Vote For You ${path} → ${res.status}`);
  return res.json();
}

// ───────── Text helpers ─────────
export function stripHtml(s = '') {
  return String(s)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const normName = (s = '') =>
  String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(hon|dr|mr|mrs|ms|senator|the|mp|am|ao|oam|ac)\b\.?/g, '')
    .replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();

export const normPlace = (s = '') => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// OpenAustralia member rows → gf_people rows. Defensive about field names.
export function oaMemberToPerson(m, chamber) {
  const name = m.full_name || m.name || [m.first_name, m.last_name].filter(Boolean).join(' ');
  const parts = String(name).trim().split(/\s+/);
  const offices = Array.isArray(m.office)
    ? m.office.map(o => o.position || o.dept || o.title).filter(Boolean)
    : [];
  return {
    full_name: String(name).trim(),
    first_name: m.first_name || parts.slice(0, -1).join(' ') || null,
    last_name: m.last_name || parts.slice(-1)[0] || null,
    jurisdiction: 'federal',
    chamber,
    status: 'sitting',
    electorate: m.constituency || null,
    state: chamber === 'senate' ? (m.constituency || null) : null,
    party: m.party || null,
    offices,
    photo_url: m.image ? (String(m.image).startsWith('http') ? m.image : `https://www.openaustralia.org.au${m.image}`) : null,
    oa_person_id: String(m.person_id),
  };
}

// They Vote For You person list entry → { id, name, electorate, house }
export function tvfyPersonSummary(p) {
  const lm = p.latest_member || p;
  const nm = lm.name || {};
  const name = typeof nm === 'string' ? nm : [nm.first, nm.last].filter(Boolean).join(' ');
  return { id: String(p.id), name, electorate: lm.electorate || '', house: lm.house || '' };
}

// OpenAustralia getHansard row → gf_statements row
export function hansardRowToStatement(row, personId) {
  const body = stripHtml(row.body || row.extract || '');
  if (!row.gid || body.length < 40) return null;
  const parentTitle = stripHtml(row.parent?.body || '');
  const url = row.listurl
    ? (String(row.listurl).startsWith('http') ? row.listurl : `https://www.openaustralia.org.au${row.listurl}`)
    : null;
  return {
    person_id: personId,
    said_on: row.hdate || null,
    source_type: 'hansard',
    source_title: parentTitle ? `Hansard: ${parentTitle}` : 'Hansard',
    source_url: url,
    quote: body.length > 6000 ? body.slice(0, 6000) + ' […]' : body,
    context: row.proof === true ? 'Proof transcript (not yet final)' : null,
    external_id: `oa:${row.gid}`,
    verified: false,
  };
}

export async function slack(text) {
  const hook = process.env.SLACK_WEBHOOK_URL;
  if (!hook) return false;
  const res = await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  return res.ok;
}
