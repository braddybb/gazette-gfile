// Document collector: finds new Hansard / council minutes documents for each source, reads them,
// and files who-said-what (Hansard speeches) and who-did-what (moved, seconded, voted, declared
// interests) against people on file. Runs nightly; can be run for one source from Admin.
import { db, upsert, log, requireUser, isCron } from '../lib/gfile.mjs';
import { pdfToText, htmlToText, splitHansard, matchSpeaker, parseMinutes, matchCouncillor, findDate, extractLinks } from '../lib/parse.mjs';

const DOCS_PER_RUN = Number(process.env.DOCS_PER_RUN || 25);
const MAX_BYTES = 40 * 1024 * 1024;
const TIME_BUDGET_MS = 12 * 60 * 1000;
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; GFILE newsroom research; +https://gazettenews.au)' };

async function fetchWithTimeout(url, ms = 60000, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, headers: { ...UA, ...(opts.headers || {}) }, signal: ctl.signal }); }
  finally { clearTimeout(t); }
}

// ───────── Discovery ─────────
async function discoverNswHansard(source) {
  const now = new Date().getFullYear();
  const since = Math.max(1991, Number(source.config?.since_year || now - 1));
  const done = new Set(source.last_result?.done_years || []);
  const docs = [];
  const finished = [];
  for (let y = now; y >= since; y--) {
    if (done.has(y) && y < now - 1) continue; // older years only need one pass
    const r = await fetchWithTimeout(`https://api.parliament.nsw.gov.au/api/hansard/search/year/${y}`, 30000, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`NSW Hansard year ${y} → ${r.status}`);
    const days = await r.json();
    for (const d of Array.isArray(days) ? days : []) {
      for (const e of d.Events || []) {
        if (!e.PdfDocId) continue;
        const lower = /assembly/i.test(e.Chamber || '');
        docs.push({
          source_id: source.id,
          url: `https://api.parliament.nsw.gov.au/api/hansard/search/daily/pdf/${e.PdfDocId}`,
          title: `NSW ${e.Chamber || 'Parliament'} Hansard${e.Uncorrected ? ' (uncorrected proof)' : ''}`,
          doc_date: (d.date || '').slice(0, 10) || null,
          chamber: lower ? 'lower' : 'upper',
        });
      }
    }
    finished.push(y);
  }
  return { docs, done_years: [...new Set([...done, ...finished])] };
}

async function discoverListing(source) {
  const c = source.config || {};
  if (!c.url) throw new Error('No listing page URL set');
  const include = new RegExp(c.link_pattern || (source.doc_type === 'minutes' ? 'minute|_MIN_' : 'hansard|proof|daily|\\.pdf'), 'i');
  const exclude = c.exclude_pattern ? new RegExp(c.exclude_pattern, 'i') : (source.doc_type === 'minutes' ? /agenda|attachment|business paper|_AGN_|_ATT_/i : null);
  const follow = c.follow_pattern ? new RegExp(c.follow_pattern, 'i') : null;

  const pages = [c.url];
  const seenPages = new Set();
  const found = new Map();
  while (pages.length && seenPages.size < Number(c.max_pages || 25)) {
    const pageUrl = pages.shift();
    if (seenPages.has(pageUrl)) continue;
    seenPages.add(pageUrl);
    const r = await fetchWithTimeout(pageUrl, 30000);
    if (!r.ok) { if (pageUrl === c.url) throw new Error(`Listing page → ${r.status}`); continue; }
    const html = await r.text();
    for (const l of extractLinks(html, pageUrl)) {
      const hay = `${l.url} ${l.text}`;
      const isDoc = /\.pdf(\?|$)/i.test(l.url) || /\/pdf\//i.test(l.url) || /download/i.test(l.url);
      if (isDoc && include.test(hay) && !(exclude && exclude.test(hay))) {
        if (!found.has(l.url)) found.set(l.url, { source_id: source.id, url: l.url, title: l.text || null, doc_date: findDate(l.text) || findDate(l.url), chamber: c.chamber || null });
      } else if (follow && follow.test(hay) && pageUrl === c.url && !seenPages.has(l.url)) {
        pages.push(l.url);
      }
    }
  }
  // Don't backfill forever: optional since date
  let docs = [...found.values()];
  if (c.since) docs = docs.filter(d => !d.doc_date || d.doc_date >= c.since);
  return { docs };
}

function discoverUrlList(source) {
  const urls = (source.config?.urls || []).filter(u => /^https?:\/\//.test(u));
  return { docs: urls.map(u => ({ source_id: source.id, url: u, title: null, doc_date: findDate(u), chamber: source.config?.chamber || null })) };
}

// ───────── Parsing ─────────
const peopleCache = new Map();
async function peopleFor(source) {
  const key = source.doc_type === 'minutes' ? `council:${(source.council || '').toLowerCase()}` : `parl:${source.jurisdiction}`;
  if (peopleCache.has(key)) return peopleCache.get(key);
  const q = source.doc_type === 'minutes'
    ? `gf_people?select=id,first_name,last_name,full_name,electorate,chamber,status&chamber=eq.council&council=ilike.${encodeURIComponent(source.council || '__none__')}`
    : `gf_people?select=id,first_name,last_name,full_name,electorate,chamber,status&jurisdiction=eq.${encodeURIComponent(source.jurisdiction)}&chamber=neq.council`;
  const rows = await db(q);
  peopleCache.set(key, rows);
  return rows;
}

async function readDocument(url) {
  const r = await fetchWithTimeout(url, 90000);
  if (!r.ok) throw new Error(`Download → ${r.status}`);
  const len = Number(r.headers.get('content-length') || 0);
  if (len > MAX_BYTES) throw new Error(`Too large (${Math.round(len / 1e6)} MB)`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error(`Too large (${Math.round(buf.length / 1e6)} MB)`);
  const isPdf = buf.slice(0, 5).toString() === '%PDF-' || /pdf/i.test(r.headers.get('content-type') || '');
  return isPdf ? pdfToText(buf) : htmlToText(buf.toString('utf8'));
}

async function parseDocument(doc, source) {
  const text = await readDocument(doc.url);
  if (text.replace(/\s/g, '').length < 80) throw new Error('No readable text (scanned image PDF?)');
  const people = await peopleFor(source);
  if (!people.length) {
    throw new Error(source.doc_type === 'minutes'
      ? `No councillors on file for "${source.council}". Add or import them first.`
      : `No ${source.jurisdiction.toUpperCase()} MPs on file. Run the state members sync first.`);
  }

  if (source.doc_type === 'hansard') {
    const pool = doc.chamber ? people.filter(p => p.chamber === doc.chamber) : people;
    const segs = splitHansard(text);
    const rows = [];
    segs.forEach((s, i) => {
      const p = matchSpeaker(s, pool.length ? pool : people) || (pool.length ? matchSpeaker(s, people) : null);
      if (!p) return;
      rows.push({
        person_id: p.id, said_on: doc.doc_date, source_type: 'hansard',
        source_title: doc.title || `${source.name}`, source_url: doc.url,
        quote: s.text.length > 6000 ? s.text.slice(0, 6000) + ' […]' : s.text,
        context: s.heading.length < 200 ? `Speaker line: ${s.heading}` : null,
        external_id: `doc:${doc.id}:${i}`, verified: false,
      });
    });
    for (let i = 0; i < rows.length; i += 200) await upsert('gf_statements', rows.slice(i, i + 200), 'external_id', { ignore: true });
    return { segments: segs.length, matched: rows.length };
  }

  // minutes
  const acts = parseMinutes(text);
  const rows = [], stmts = [], unmatched = new Set();
  for (const a of acts) {
    const p = matchCouncillor(a.name, people);
    if (!p) { unmatched.add(a.name); continue; }
    rows.push({
      person_id: p.id, document_id: doc.id, council: source.council, meeting_date: doc.doc_date,
      item: a.item, action: a.action, detail: a.detail, source_url: doc.url,
      external_id: `doc:${doc.id}:${a.action}:${p.id}:${a.at}`,
    });
    if (a.action === 'moved' && a.detail) {
      stmts.push({
        person_id: p.id, said_on: doc.doc_date, source_type: 'document',
        source_title: `Motion moved at ${source.council} council meeting${a.item ? ` · ${a.item}` : ''}`.slice(0, 300),
        source_url: doc.url, quote: a.detail,
        context: 'Motion this councillor moved, from the official minutes. Moving a motion is not always personal support — check the debate.',
        external_id: `doc:${doc.id}:motion:${p.id}:${a.at}`, verified: false,
      });
    }
  }
  const uniq = [...new Map(rows.map(r => [r.external_id, r])).values()];
  for (let i = 0; i < uniq.length; i += 200) await upsert('gf_council_actions', uniq.slice(i, i + 200), 'external_id', { ignore: true });
  if (stmts.length) await upsert('gf_statements', stmts, 'external_id', { ignore: true });
  return { segments: acts.length, matched: uniq.length, unmatched: [...unmatched].slice(0, 20) };
}

// ───────── Handler ─────────
export default async (req) => {
  if (!isCron(req) && !(await requireUser(req))) return new Response('Unauthorised', { status: 401 });
  const started = Date.now();
  let only = null;
  try { only = (await req.json())?.source_id || null; } catch (_) {}
  const summary = { sources: 0, discovered: 0, parsed: 0, failed: 0, errors: [] };

  try {
    const sources = await db(`gf_sources?select=*&enabled=eq.true${only ? `&id=eq.${only}` : ''}`);
    // 1. Discover
    for (const s of sources) {
      let result = {};
      try {
        const found = s.kind === 'nsw_hansard_api' ? await discoverNswHansard(s)
          : s.kind === 'listing_page' ? await discoverListing(s)
          : discoverUrlList(s);
        const unique = [...new Map(found.docs.map(d => [d.url, d])).values()];
        let added = 0;
        for (let i = 0; i < unique.length; i += 200) {
          const ins = await upsert('gf_documents', unique.slice(i, i + 200), 'url', { ignore: true });
          added += ins.length;
        }
        summary.discovered += added;
        result = { ok: true, found: unique.length, new: added, ...(found.done_years ? { done_years: found.done_years } : {}) };
      } catch (e) {
        result = { ok: false, error: e.message, done_years: s.last_result?.done_years };
        summary.errors.push(`${s.name}: ${e.message}`);
      }
      await db(`gf_sources?id=eq.${s.id}`, { method: 'PATCH', body: { last_run_at: new Date().toISOString(), last_result: result } });
      summary.sources++;
    }

    // 2. Parse new documents, newest first
    const byId = new Map(sources.map(s => [s.id, s]));
    const ids = [...byId.keys()];
    if (ids.length) {
      const docs = await db(`gf_documents?select=*&status=eq.new&source_id=in.(${ids.join(',')})&order=doc_date.desc.nullslast&limit=${DOCS_PER_RUN}`);
      for (const d of docs) {
        if (Date.now() - started > TIME_BUDGET_MS) break;
        try {
          const r = await parseDocument(d, byId.get(d.source_id));
          await db(`gf_documents?id=eq.${d.id}`, { method: 'PATCH', body: {
            status: 'parsed', segments: r.segments, matched: r.matched, parsed_at: new Date().toISOString(),
            error: r.unmatched?.length ? `Not matched to anyone on file: ${r.unmatched.join(', ')}` : null,
          } });
          summary.parsed++;
        } catch (e) {
          await db(`gf_documents?id=eq.${d.id}`, { method: 'PATCH', body: { status: 'error', error: e.message.slice(0, 500), parsed_at: new Date().toISOString() } });
          summary.failed++;
        }
      }
    }
    await log('ingest', summary.errors.length === 0, summary);
  } catch (e) {
    summary.errors.push(e.message);
    await log('ingest', false, summary);
  }
  return new Response('ok');
};
