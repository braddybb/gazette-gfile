// Old-media deep scan for one person: the KFile groundwork.
// 1. Web search for old interviews, transcripts, op-eds, profiles, student media (AI-driven search)
// 2. Reads each page (or its Wayback copy) and keeps only quotes whose exact words are on the page
// 3. Archived tweets and old websites from the Wayback Machine
// 4. Pre-cutoff YouTube videos and Trove newspaper articles (if keys are set)
// Everything lands in a review queue (gf_leads). Nothing goes on the record until a reporter keeps it.
import { db, upsert, requireUser, env, log } from '../lib/gfile.mjs';
import { htmlToText, pdfToText } from '../lib/parse.mjs';
import { verifyQuote, tweetFromHtml, waybackRaw, waybackView, tsToDate, parseCdx, spread, windowsAround, yearOf } from '../lib/scan.mjs';

const CAP = Number(process.env.SCAN_DAILY_CAP || 5);
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const QUOTE_MODEL = process.env.QUOTE_MODEL || 'claude-haiku-5-5';
const SEARCH_TOOL = process.env.WEB_SEARCH_TOOL || 'web_search_20250305';
const MAX_PAGES = 15;
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; GFILE newsroom research)' };

async function timed(url, ms = 20000, opts = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, headers: { ...UA, ...(opts.headers || {}) }, signal: ctl.signal }); }
  finally { clearTimeout(t); }
}

async function claude(body) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`AI service ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

async function pool(items, size, fn) {
  let i = 0; const out = [];
  await Promise.all(Array.from({ length: size }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch (e) { out[k] = null; } }
  }));
  return out;
}

// ───────── 1. Web search ─────────
const LEADS_TOOL = {
  name: 'record_leads',
  description: 'Record the pages found.',
  input_schema: {
    type: 'object',
    properties: {
      leads: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            title: { type: 'string' },
            outlet: { type: 'string' },
            date: { type: 'string', description: 'YYYY-MM-DD, YYYY-MM or YYYY if known' },
            kind: { type: 'string', enum: ['interview', 'transcript', 'article', 'opinion', 'profile', 'video', 'student_media', 'other'] },
            why: { type: 'string', description: 'One line: what they say or do here' },
          },
          required: ['url', 'title', 'why'],
        },
      },
    },
    required: ['leads'],
  },
};

async function webSearch(person, beforeYear) {
  const aliases = (person.aliases || []).filter(Boolean);
  const facts = [
    `Name: ${person.full_name}${aliases.length ? ` (also known as: ${aliases.join(', ')})` : ''}`,
    `Now: ${[person.party, person.chamber, person.electorate, person.council].filter(Boolean).join(', ')}`,
    person.notes ? `Background notes from our reporters: ${person.notes}` : null,
  ].filter(Boolean).join('\n');
  const system = `You are a researcher on an Australian political accountability desk, doing KFile-style archive research.
Find pages where this person speaks or is quoted${beforeYear ? `, published BEFORE ${beforeYear}` : ''}: radio and TV transcripts (ABC AM, PM, Lateline, 7.30, Q&A, local radio), interviews, op-eds they wrote, letters to the editor, profiles, student newspaper pieces, think-tank or union publications, old council or business roles, podcasts, forum or debate write-ups.
Search widely and creatively: use their aliases, earlier jobs, hometown and old roles. Make sure it is the same person, not a namesake.
Include only URLs that appeared in your search results. Never construct or guess a URL.
When finished, call record_leads with up to 25 of the best pages, oldest first.`;
  const messages = [{ role: 'user', content: `${facts}\n\nFind their old media appearances${beforeYear ? ` from before ${beforeYear}` : ''}.` }];
  const seenUrls = new Map();
  const searchErrors = new Set();
  let lastStop = null, searches = 0;
  let leads = null;
  for (let turn = 0; turn < 6 && !leads; turn++) {
    const res = await claude({
      model: MODEL, max_tokens: 4000, system, messages,
      tools: [{ type: SEARCH_TOOL, name: 'web_search', max_uses: 12 }, LEADS_TOOL],
    });
    lastStop = res.stop_reason;
    for (const block of res.content || []) {
      if (block.type === 'server_tool_use') searches++;
      if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
        for (const r of block.content) if (r.url) seenUrls.set(r.url, { title: r.title, page_age: r.page_age });
      } else if (block.type === 'web_search_tool_result' && block.content?.error_code) {
        searchErrors.add(block.content.error_code);
      }
      if (block.type === 'tool_use' && block.name === 'record_leads') leads = block.input?.leads || [];
    }
    if (leads) break;
    if (res.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: res.content }); continue; }
    if (res.stop_reason === 'end_turn') {
      messages.push({ role: 'assistant', content: res.content });
      messages.push({ role: 'user', content: 'Now call record_leads with what you found.' });
    }
  }
  const strip = (u) => String(u || '').replace(/[#?].*$/, '').replace(/\/$/, '');
  const seenStripped = new Map([...seenUrls.keys()].map(u => [strip(u), u]));
  // Only keep URLs that really came back from search
  const valid = (leads || [])
    .map(l => ({ ...l, url: seenUrls.has(l.url) ? l.url : seenStripped.get(strip(l.url)) }))
    .filter(l => l.url);
  if (!seenUrls.size) {
    const why = searchErrors.size ? `search error: ${[...searchErrors].join(', ')}`
      : searches === 0 ? 'the AI never ran a search — check web search is enabled for your organisation in the Anthropic Console'
      : `no results came back (stopped: ${lastStop})`;
    throw new Error(`Web search found nothing — ${why}`);
  }
  if (!valid.length) {
    return [...seenUrls.entries()].slice(0, 20).map(([url, m]) => ({ url, title: m.title, why: null, date: m.page_age || null }));
  }
  return valid;
}

async function readPage(url, year) {
  const tryFetch = async (u) => {
    const r = await timed(u, 20000);
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 15e6) return null;
    const isPdf = buf.slice(0, 5).toString() === '%PDF-';
    return isPdf ? await pdfToText(buf) : htmlToText(buf.toString('utf8'));
  };
  let text = null, archive_url = null;
  try { text = await tryFetch(url); } catch (_) {}
  if (!text || text.length < 300) {
    try {
      const a = await (await timed(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}${year ? `&timestamp=${year}0101` : ''}`, 15000)).json();
      const snap = a?.archived_snapshots?.closest;
      if (snap?.available && snap.url) {
        const archived = await tryFetch(snap.url.replace(/^http:/, 'https:').replace(/\/web\/(\d+)\//, '/web/$1id_/'));
        if (archived && archived.length > (text || '').length) { text = archived; archive_url = snap.url.replace(/^http:/, 'https:'); }
      }
    } catch (_) {}
  }
  return { text, archive_url };
}

const QUOTES_TOOL = {
  name: 'record_quotes',
  description: 'Record what this page shows.',
  input_schema: {
    type: 'object',
    properties: {
      same_person: { type: 'boolean', description: 'Is this clearly the same person (not a namesake)?' },
      published: { type: 'string', description: 'Publication or broadcast date shown on the page: YYYY-MM-DD, YYYY-MM or YYYY. Empty if not shown.' },
      outlet: { type: 'string' },
      summary: { type: 'string', description: 'One sentence on what they say or do here.' },
      quotes: { type: 'array', items: { type: 'string' }, description: 'Up to 5 passages spoken or written by this person, copied EXACTLY character for character from the text. Not paraphrased. Not words said about them by others.' },
    },
    required: ['same_person', 'quotes'],
  },
};

async function extractQuotes(person, page, lead) {
  const names = [person.full_name, person.last_name, ...(person.aliases || [])];
  const excerpt = windowsAround(page, names);
  if (!excerpt) return null; // page doesn't mention them
  const res = await claude({
    model: QUOTE_MODEL, max_tokens: 1500,
    system: 'You extract verbatim quotes for journalists. Copy text exactly; never paraphrase, tidy or merge sentences. If unsure it is the same person, say so.',
    tools: [QUOTES_TOOL], tool_choice: { type: 'tool', name: 'record_quotes' },
    messages: [{ role: 'user', content: `PERSON: ${person.full_name} (${[person.party, person.electorate].filter(Boolean).join(', ')})${person.notes ? `\nBackground: ${person.notes.slice(0, 500)}` : ''}\nPAGE TITLE: ${lead.title || ''}\n\nPAGE TEXT (excerpts):\n${excerpt}` }],
  });
  const call = (res.content || []).find(c => c.type === 'tool_use');
  return call ? call.input : null;
}

// ───────── 3. Wayback: tweets and old sites ─────────
async function archivedTweets(handle, beforeYear) {
  const h = String(handle).replace(/^@/, '').replace(/^https?:\/\/(www\.)?(twitter|x)\.com\//i, '').split(/[/?]/)[0];
  if (!/^[A-Za-z0-9_]{1,15}$/.test(h)) return [];
  const to = beforeYear ? `&to=${beforeYear - 1}1231` : '';
  const r = await timed(`https://web.archive.org/cdx/search/cdx?url=twitter.com/${h}/status/*&output=json&fl=timestamp,original&filter=statuscode:200&collapse=urlkey&limit=2000${to}`, 30000);
  if (!r.ok) return [];
  const rows = parseCdx(await r.json()).filter(x => /\/status(es)?\/\d+/.test(x.original));
  const pick = spread(rows, 40);
  const got = await pool(pick, 4, async (row) => {
    const res = await timed(waybackRaw(row.timestamp, row.original), 20000);
    if (!res.ok) return null;
    const tw = tweetFromHtml(await res.text());
    if (!tw) return null;
    const original = row.original.replace(/^http:/, 'https:').replace(/:80\//, '/');
    return {
      kind: 'tweet', url: original, archive_url: waybackView(row.timestamp, row.original),
      title: `Archived tweet by @${h}`, outlet: 'Twitter (Wayback Machine)',
      published_on: tw.date || tsToDate(row.timestamp), year: yearOf(tw.date || row.timestamp),
      snippet: tw.date ? null : `Tweet date not shown; archived ${tsToDate(row.timestamp)}.`,
      quotes: [{ text: tw.text, verified: true }],
    };
  });
  return got.filter(Boolean);
}

async function archivedSites(urls, beforeYear) {
  const out = [];
  for (const u of urls.slice(0, 5)) {
    const to = beforeYear ? `&to=${beforeYear - 1}1231` : '';
    const r = await timed(`https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(u)}&output=json&fl=timestamp,original&filter=statuscode:200&collapse=timestamp:4&limit=30${to}`, 30000);
    if (!r.ok) continue;
    for (const row of parseCdx(await r.json()).slice(0, 12)) {
      out.push({
        kind: 'archive', url: `${row.original}#${row.timestamp.slice(0, 4)}`, archive_url: waybackView(row.timestamp, row.original),
        title: `${row.original.replace(/^https?:\/\//, '')} as archived in ${row.timestamp.slice(0, 4)}`, outlet: 'Wayback Machine',
        published_on: tsToDate(row.timestamp), year: Number(row.timestamp.slice(0, 4)), snippet: 'Old website snapshot. Check bio, policy pages, blog posts and media releases.', quotes: [],
      });
    }
  }
  return out;
}

// ───────── 4. YouTube and Trove ─────────
async function youtube(person, beforeYear) {
  const key = process.env.YOUTUBE_API_KEY; if (!key) return [];
  const before = beforeYear ? `&publishedBefore=${beforeYear}-01-01T00:00:00Z` : '';
  const r = await timed(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=25&regionCode=AU&q=${encodeURIComponent(`"${person.full_name}"`)}${before}&key=${key}`);
  if (!r.ok) return [];
  const last = (person.last_name || '').toLowerCase();
  return ((await r.json()).items || [])
    .filter(v => v.id?.videoId && `${v.snippet?.title} ${v.snippet?.description}`.toLowerCase().includes(last))
    .map(v => ({
      kind: 'video', url: `https://www.youtube.com/watch?v=${v.id.videoId}`, title: v.snippet.title,
      outlet: `YouTube · ${v.snippet.channelTitle}`, published_on: (v.snippet.publishedAt || '').slice(0, 10) || null,
      year: yearOf(v.snippet.publishedAt), snippet: (v.snippet.description || '').slice(0, 400), quotes: [],
    }));
}

async function trove(person, beforeYear) {
  const key = process.env.TROVE_API_KEY; if (!key) return [];
  const dateQ = beforeYear ? ` date:[1950-01-01T00:00:00Z TO ${beforeYear - 1}-12-31T00:00:00Z]` : '';
  const r = await timed(`https://api.trove.nla.gov.au/v3/result?category=newspaper&encoding=json&n=20&sortby=dateDesc&q=${encodeURIComponent(`"${person.full_name}"${dateQ}`)}`, 20000, { headers: { 'X-API-KEY': key } });
  if (!r.ok) return [];
  const j = await r.json();
  const arts = (j.category || []).flatMap(c => c.records?.article || []);
  return arts.map(a => ({
    kind: 'trove', url: a.troveUrl || `https://nla.gov.au/nla.news-article${a.id}`, title: a.heading || 'Newspaper article',
    outlet: a.title?.title || 'Trove', published_on: a.date || null, year: yearOf(a.date),
    snippet: (a.snippet ? String(a.snippet).replace(/<[^>]+>/g, '') : '').slice(0, 400), quotes: [],
  }));
}

// ───────── Handler ─────────
async function fail(id, msg) {
  await db(`gf_scans?id=eq.${id}`, { method: 'PATCH', body: { status: 'error', error: msg.slice(0, 500), finished_at: new Date().toISOString() } });
}

export default async (req) => {
  const user = await requireUser(req);
  if (!user) return new Response('Unauthorised', { status: 401 });
  let body = {}; try { body = await req.json(); } catch (_) {}
  const scanId = String(body.scan_id || '');
  if (!/^[0-9a-f-]{36}$/i.test(scanId)) return new Response('Bad scan id', { status: 400 });
  const [scan] = await db(`gf_scans?id=eq.${scanId}&select=*`);
  if (!scan || scan.requested_by !== user.id || scan.status !== 'queued') return new Response('Not found', { status: 404 });

  try {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const recent = await db(`gf_scans?select=id&requested_by=eq.${user.id}&status=in.(running,done)&created_at=gte.${since}`);
    if (recent.length >= CAP) return await fail(scanId, `Daily limit of ${CAP} deep scans reached. Try again tomorrow.`), new Response('capped');
    await db(`gf_scans?id=eq.${scanId}`, { method: 'PATCH', body: { status: 'running' } });

    const [person] = await db(`gf_people?id=eq.${scan.person_id}&select=*`);
    const beforeYear = scan.before_year || null;
    const summary = { web: 0, web_verified_quotes: 0, web_dropped: 0, tweets: 0, archives: 0, videos: 0, trove: 0, errors: [] };
    const leads = [];
    const tag = (l) => ({ ...l, person_id: person.id, scan_id: scanId });

    if (!process.env.YOUTUBE_API_KEY) summary.errors.push('YouTube skipped (no YOUTUBE_API_KEY set)');
    if (!process.env.TROVE_API_KEY) summary.errors.push('Trove skipped (no TROVE_API_KEY set)');
    if (!person.handles?.twitter) summary.notes = 'No Twitter handle in Research details, so archived tweets were skipped.';
    // Run the independent sources side by side
    const [webLeads, tweets, sites, vids, tro] = await Promise.all([
      webSearch(person, beforeYear).catch(e => { summary.errors.push(`Web search: ${e.message}`); return []; }),
      person.handles?.twitter ? archivedTweets(person.handles.twitter, beforeYear).catch(e => { summary.errors.push(`Tweets: ${e.message}`); return []; }) : [],
      (person.old_urls || []).length ? archivedSites(person.old_urls, beforeYear).catch(e => { summary.errors.push(`Old sites: ${e.message}`); return []; }) : [],
      youtube(person, beforeYear).catch(e => { summary.errors.push(`YouTube: ${e.message}`); return []; }),
      trove(person, beforeYear).catch(e => { summary.errors.push(`Trove: ${e.message}`); return []; }),
    ]);

    // Read each web lead and keep only verified quotes
    const checked = await pool(webLeads.slice(0, MAX_PAGES), 4, async (l) => {
      const year = yearOf(l.date);
      const { text, archive_url } = await readPage(l.url, year || beforeYear);
      if (!text) return { kind: 'web', url: l.url, archive_url, title: l.title, outlet: l.outlet || null, published_on: /^\d{4}-\d{2}-\d{2}$/.test(l.date || '') ? l.date : null, year, snippet: `${l.why || ''} (Couldn't open the page to check quotes.)`.trim(), quotes: [] };
      const q = await extractQuotes(person, text, l);
      if (!q) return null;                    // page never mentions them
      if (q.same_person === false) return null;
      const verified = (q.quotes || []).filter(s => verifyQuote(s, text)).slice(0, 5);
      summary.web_dropped += (q.quotes || []).length - verified.length;
      summary.web_verified_quotes += verified.length;
      const pub = q.published || l.date || '';
      return {
        kind: 'web', url: l.url, archive_url, title: l.title, outlet: q.outlet || l.outlet || null,
        published_on: /^\d{4}-\d{2}-\d{2}$/.test(pub) ? pub : null, year: yearOf(pub),
        snippet: q.summary || l.why || null, quotes: verified.map(text => ({ text, verified: true })),
      };
    });
    const web = checked.filter(Boolean).filter(l => !beforeYear || !l.year || l.year < beforeYear);
    summary.web = web.length;
    leads.push(...web);
    for (const l of webLeads.slice(MAX_PAGES)) leads.push({ kind: 'web', url: l.url, title: l.title, outlet: l.outlet || null, year: yearOf(l.date), snippet: `${l.why || ''} (Not opened: over the per-scan page limit.)`.trim(), quotes: [] });
    leads.push(...tweets, ...sites, ...vids, ...tro);
    Object.assign(summary, { tweets: tweets.length, archives: sites.length, videos: vids.length, trove: tro.length });

    const rows = [...new Map(leads.map(tag).map(l => [l.url, l])).values()];
    for (let i = 0; i < rows.length; i += 100) await upsert('gf_leads', rows.slice(i, i + 100), 'person_id,url', { ignore: true });
    summary.total = rows.length;
    await db(`gf_scans?id=eq.${scanId}`, { method: 'PATCH', body: { status: 'done', summary, finished_at: new Date().toISOString() } });
    await log('scan', summary.errors.filter(e => !/skipped/.test(e)).length === 0, { person: person.full_name, ...summary });
  } catch (e) {
    await fail(scanId, e.message);
  }
  return new Response('ok');
};
