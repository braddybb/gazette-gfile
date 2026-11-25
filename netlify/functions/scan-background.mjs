// Old-media deep scan for one person: the KFile groundwork.
// 1. Web search for old interviews, transcripts, op-eds, profiles, student media (AI-driven search)
// 2. Reads each page (or its Wayback copy) and keeps only quotes whose exact words are on the page
// 3. Archived tweets and old websites from the Wayback Machine
// 4. Pre-cutoff YouTube videos and Trove newspaper articles (if keys are set)
// Everything lands in a review queue (gf_leads). Nothing goes on the record until a reporter keeps it.
import { db, upsert, requireUser, env, log } from '../lib/gfile.mjs';
import { htmlToText, pdfToText } from '../lib/parse.mjs';
import { verifyQuote, tweetFromHtml, waybackRaw, waybackView, tsToDate, parseCdx, spread, windowsAround, yearOf, skipHost, BLOCKED_FOR_SEARCH, mentionsPerson, attributedQuote, publishedFromHtml, refusedDomains } from '../lib/scan.mjs';

const CAP = Number(process.env.SCAN_DAILY_CAP || 5);
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const QUOTE_MODEL = process.env.QUOTE_MODEL || 'claude-haiku-5-5';
const SEARCH_TOOL = process.env.WEB_SEARCH_TOOL || 'web_search_20250305';
const MAX_PAGES = Number(process.env.SCAN_MAX_PAGES || 60);
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

// Several focused searches run side by side, each digging a different seam, then merged.
const ANGLES = [
  { key: 'broadcast', brief: 'RADIO AND TV: transcripts and write-ups of interviews — ABC (AM, PM, The World Today, Lateline, 7.30, Insiders, Q&A, local ABC radio), Sky, commercial and regional radio, podcasts. Transcript pages on abc.net.au, parliament and party sites are gold.' },
  { key: 'print', brief: 'PRINT: newspaper and magazine articles quoting them, op-eds they wrote and letters to the editor — national papers and especially regional and local papers in the areas they lived and worked. Also archived copies of those articles.' },
  { key: 'before', brief: 'BEFORE OFFICE: their life before parliament or council — previous jobs and employers (publications, annual reports, submissions to inquiries, evidence to parliamentary committees), industry bodies, unions, think tanks, businesses, community groups, student politics and student newspapers, preselection contests and earlier campaigns.' },
  { key: 'ownwords', brief: 'THEIR OWN WORDS ONLINE: their old websites, blogs, media releases, e-newsletters, campaign material, conference and event speeches, party publications, and news stories quoting their old social media posts.' },
  { key: 'about', brief: 'COVERAGE ABOUT THEM: profiles, investigations, controversies, court or tribunal mentions, business dealings, preselection fights and anything written about them where they respond or are quoted.' },
];
const PARLIAMENT_DOMAINS = ['aph.gov.au', 'parlinfo.aph.gov.au', 'parliament.nsw.gov.au', 'parliament.vic.gov.au', 'parliament.qld.gov.au', 'parliament.wa.gov.au', 'parliament.sa.gov.au', 'parliament.tas.gov.au', 'parliament.act.gov.au', 'hansard.act.gov.au', 'parliament.nt.gov.au'];
// Searches locked to specific sites, so the deep archives actually get reached
const OUTLETS = {
  national: ['theaustralian.com.au', 'afr.com', 'smh.com.au', 'theage.com.au', 'brisbanetimes.com.au', 'watoday.com.au', 'theguardian.com', 'news.com.au', 'canberratimes.com.au', 'sbs.com.au', 'thesaturdaypaper.com.au', 'themonthly.com.au', 'crikey.com.au', 'theconversation.com', 'insidestory.org.au', 'michaelwest.com.au', 'independentaustralia.net'],
  tabloid: ['dailytelegraph.com.au', 'heraldsun.com.au', 'couriermail.com.au', 'adelaidenow.com.au', 'perthnow.com.au', 'themercury.com.au', 'ntnews.com.au', 'geelongadvertiser.com.au', 'goldcoastbulletin.com.au', 'townsvillebulletin.com.au', 'cairnspost.com.au', 'weeklytimesnow.com.au', 'thewest.com.au', 'skynews.com.au'],
  regional: ['standard.net.au', 'thecourier.com.au', 'bendigoadvertiser.com.au', 'theadvocate.com.au', 'examiner.com.au', 'newcastleherald.com.au', 'illawarramercury.com.au', 'dailyadvertiser.com.au', 'bordermail.com.au', 'northerndailyleader.com.au', 'portnews.com.au', 'centralwesterndaily.com.au', 'westernadvocate.com.au', 'dailyliberal.com.au', 'theland.com.au', 'queenslandcountrylife.com.au', 'stockandland.com.au', 'farmweekly.com.au'],
  broadcast: ['2gb.com', '3aw.com.au', '4bc.com.au', '6pr.com.au', '9news.com.au', '7news.com.au', 'skynews.com.au', 'sbs.com.au', 'abc.net.au', 'nine.com.au', '10play.com.au', 'triplej.net.au'],
};

function domainAngles(person) {
  const out = [
    { key: 'national papers', domains: OUTLETS.national, brief: 'NATIONAL AND INDEPENDENT MEDIA ONLY: articles quoting them, interviews, op-eds and letters they wrote, profiles and investigations.' },
    { key: 'metro tabloids', domains: OUTLETS.tabloid, brief: 'NEWS CORP AND METRO PAPERS ONLY: articles quoting them, op-eds, interviews and profiles, especially state and local coverage.' },
    { key: 'regional papers', domains: OUTLETS.regional, brief: 'REGIONAL AND RURAL PAPERS ONLY: local coverage quoting them, columns they wrote, letters, community events, candidacy and preselection coverage.' },
    { key: 'radio & TV', domains: OUTLETS.broadcast, brief: 'RADIO AND TV SITES ONLY: interview transcripts, audio and video pages, and write-ups of interviews they gave.' },
    { key: 'parliament', domains: PARLIAMENT_DOMAINS, brief: 'PARLIAMENT ARCHIVES ONLY: their press releases, radio and TV interview transcripts, and media statements held in the Parliamentary Library (ParlInfo media collection), plus committee hearing evidence they gave or questions they asked, and older Hansard.' },
    { key: 'abc', domains: ['abc.net.au'], brief: 'ABC ONLY: transcripts and stories where they are interviewed or quoted — AM, PM, The World Today, Lateline, 7.30, Insiders, Q&A, Four Corners, RN programs and ABC local radio and regional news.' },
    { key: 'gov', domains: ['gov.au'], brief: 'GOVERNMENT SITES ONLY: ministerial and shadow-ministerial media releases and transcripts, submissions they wrote or signed to inquiries, council minutes or reports naming them, and annual reports of bodies they led.' },
  ];
  const own = [...new Set((person.old_urls || []).map(u => { try { return new URL(/^https?:/.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, ''); } catch { return null; } }).filter(Boolean))];
  if (own.length) out.push({ key: 'own sites', domains: own.slice(0, 5), brief: 'THEIR OWN WEBSITES ONLY: media releases, speeches, newsletters, columns, blog posts and policy pages.' });
  return out;
}

async function webSearchAngle(person, beforeYear, angle, keywords) {
  const aliases = (person.aliases || []).filter(Boolean);
  const facts = [
    `Name: ${person.full_name}${aliases.length ? ` (also known as: ${aliases.join(', ')})` : ''}`,
    `Now: ${[person.party, person.chamber, person.electorate, person.council].filter(Boolean).join(', ')}`,
    person.notes ? `Background notes from our reporters: ${person.notes}` : null,
  ].filter(Boolean).join('\n');
  const system = `You are a researcher on an Australian political accountability desk, doing KFile-style archive research.
Find pages where this person speaks, writes or is directly quoted${beforeYear ? `, published BEFORE ${beforeYear}` : ''}.
Your seam for this search: ${angle.brief}${keywords ? `\nFOCUS: the reporter is digging into these topics, so search for the person together with each of them and prioritise pages about them: ${keywords}` : ''}
Prefer pages where they state positions, opinions, promises, criticisms or claims — the things a reporter could hold them to now. ${beforeYear ? `Everything must be from BEFORE ${beforeYear}, when they were not yet in office: their earlier career, advocacy, business, lobbying, student and community life, and the people and causes they were tied to.` : ''}
Skip Wikipedia and other encyclopedias or profile aggregators, their current official parliament bio, and recent news.
Run many different searches: vary keywords, add topics they would have spoken about, their old roles, towns, organisations and aliases. Make sure it is the same person, not a namesake.
Include only URLs that appeared in your search results. Never construct or guess a URL.
When finished, call record_leads with up to 15 of the best pages, oldest first.`;
  const messages = [{ role: 'user', content: `${facts}\n\nFind their old ${angle.key === 'before' ? 'pre-politics record' : 'media appearances'}${beforeYear ? ` from before ${beforeYear}` : ''}.` }];
  const seenUrls = new Map();
  const searchErrors = new Set();
  let lastStop = null, searches = 0;
  let leads = null;
  let domains = angle.domains ? [...angle.domains] : null;
  for (let turn = 0; turn < 6 && !leads; turn++) {
    let res;
    try {
      res = await claude({
        model: MODEL, max_tokens: 4000, system, messages,
        tools: [{ type: SEARCH_TOOL, name: 'web_search', max_uses: Number(process.env.SEARCHES_PER_ANGLE || 6), ...(domains ? { allowed_domains: domains } : { blocked_domains: BLOCKED_FOR_SEARCH }) }, LEADS_TOOL],
      });
    } catch (e) {
      // Sites that block AI crawlers are refused by the search tool. Respect that: drop them and carry on.
      const refused = refusedDomains(e.message);
      if (domains && refused.length) {
        domains = domains.filter(d => !refused.includes(d.toLowerCase()));
        REFUSED_SITES.push(...refused);
        if (!domains.length) throw new Error('SKIP: every site in this search blocks AI search');
        turn--; continue;
      }
      throw e;
    }
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
  const valid = (leads || [])
    .map(l => ({ ...l, url: seenUrls.has(l.url) ? l.url : seenStripped.get(strip(l.url)) }))
    .filter(l => l.url);
  if (!seenUrls.size) {
    const why = searchErrors.size ? `search error: ${[...searchErrors].join(', ')}`
      : searches === 0 ? 'the AI never ran a search — check web search is enabled for your organisation in the Anthropic Console'
      : `no results came back (stopped: ${lastStop})`;
    throw new Error(why);
  }
  if (!valid.length) return [...seenUrls.entries()].slice(0, 10).map(([url, m]) => ({ url, title: m.title, why: null, date: m.page_age || null }));
  return valid;
}

async function webSearch(person, beforeYear, summary, keywords) {
  const angles = [...ANGLES, ...domainAngles(person)];
  const results = await Promise.all(angles.map(a => webSearchAngle(person, beforeYear, a, keywords).then(r => ({ a, r }), e => ({ a, e }))));
  const failed = results.filter(x => x.e);
  if (failed.length === angles.length) throw new Error(`Web search found nothing — ${failed[0].e.message}`);
  for (const f of failed) if (!/no results came back|^SKIP:/.test(f.e.message)) summary.errors.push(`Web search (${f.a.key}): ${f.e.message}`);
  if (REFUSED_SITES.length) summary.blocked_sites = [...new Set(REFUSED_SITES)].sort();
  summary.searches = angles.map(a => a.key);
  const merged = new Map();
  for (const { r } of results) for (const l of r || []) if (!merged.has(l.url) && !skipHost(l.url)) merged.set(l.url, l);
  return [...merged.values()].sort((x, y) => String(x.date || '9999').localeCompare(String(y.date || '9999')));
}

async function readPage(url, year) {
  const tryFetch = async (u) => {
    const r = await timed(u, 20000);
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 15e6) return null;
    const isPdf = buf.slice(0, 5).toString() === '%PDF-';
    if (isPdf) return await pdfToText(buf);
    const html = buf.toString('utf8');
    lastHtml = html;
    return htmlToText(html);
  };
  let text = null, archive_url = null, lastHtml = '';
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
  return { text, archive_url, html: lastHtml };
}

// Earliest Wayback capture — a page first archived after the cut-off can't have been published before it
async function firstCaptureYear(url) {
  try {
    const rows = await cdx(`url=${encodeURIComponent(url.replace(/^https?:\/\//, ''))}&output=json&fl=timestamp,original&limit=1`, 20000);
    return rows[0] ? Number(rows[0].timestamp.slice(0, 4)) : null;
  } catch { return null; }
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
      quotes: { type: 'array', items: { type: 'string' }, description: 'Up to 6 passages spoken or written by this person, copied EXACTLY character for character from the text. Not paraphrased. ONLY words this person said or wrote: text in quotation marks attributed to them, lines under their name in a transcript, or text they authored (op-ed, release, letter). NEVER narrative sentences that describe them (e.g. "Smith vowed to…", "She was elected…"). Choose statements of position, opinion, promise, criticism or factual claim about issues (policy, their electorate, opponents, industries, social questions) — the kind a reporter could compare with what they say now. Skip thanks, greetings, pleasantries, family tributes and procedural lines.' },
    },
    required: ['same_person', 'quotes'],
  },
};

let SCAN_KEYWORDS = '';
const REFUSED_SITES = [];
async function extractQuotes(person, page, lead) {
  const names = [person.full_name, person.last_name, ...(person.aliases || []), ...SCAN_KEYWORDS.split(',').map(k => k.trim()).filter(k => k.length > 3)];
  let excerpt = windowsAround(page, names);
  if (!excerpt && lead.ownSite) excerpt = page.slice(0, 10000);
  if (!excerpt) return null; // page doesn't mention them
  const res = await claude({
    model: QUOTE_MODEL, max_tokens: 1500,
    system: 'You extract verbatim quotes for journalists. Copy text exactly; never paraphrase, tidy or merge sentences. If unsure it is the same person, say so.',
    tools: [QUOTES_TOOL], tool_choice: { type: 'tool', name: 'record_quotes' },
    messages: [{ role: 'user', content: `${SCAN_KEYWORDS ? `PRIORITY TOPICS (choose quotes about these first): ${SCAN_KEYWORDS}\n` : ''}PERSON: ${person.full_name} (${[person.party, person.electorate].filter(Boolean).join(', ')})${person.notes ? `\nBackground: ${person.notes.slice(0, 500)}` : ''}\nPAGE TITLE: ${lead.title || ''}\n\nPAGE TEXT (excerpts):\n${excerpt}` }],
  });
  const call = (res.content || []).find(c => c.type === 'tool_use');
  return call ? call.input : null;
}

// ───────── 3. Wayback: tweets and old sites ─────────
async function archivedTweets(handle, beforeYear) {
  const h = String(handle).replace(/^@/, '').replace(/^https?:\/\/(www\.)?(twitter|x)\.com\//i, '').split(/[/?]/)[0];
  if (!/^[A-Za-z0-9_]{1,15}$/.test(h)) return [];
  const to = beforeYear ? `&to=${beforeYear - 1}1231` : '';
  const rows = (await cdx(`url=twitter.com/${h}/status/*&output=json&fl=timestamp,original&filter=statuscode:200&collapse=urlkey&limit=1500${to}`)).filter(x => /\/status(es)?\/\d+/.test(x.original));
  const pick = spread(rows, 60);
  const got = await pool(pick, 4, async (row) => {
    const res = await timed(waybackRaw(row.timestamp, row.original), 45000);
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

async function cdx(query, ms = 120000) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await timed(`https://web.archive.org/cdx/search/cdx?${query}`, ms);
      if (r.ok) return parseCdx(await r.json());
      last = new Error(`Wayback Machine ${r.status}`);
    } catch (e) { last = new Error(e.name === 'AbortError' ? 'Wayback Machine too slow to answer — try again later' : e.message); }
    await new Promise(res => setTimeout(res, 3000));
  }
  throw last;
}

const CONTENT_PATH = /(media|news|release|speech|transcript|statement|blog|article|opinion|column|op-?ed|interview|policy|policies|issues|newsletter|letter|post|story|stories|view|views|comment|20\d\d\/|19\d\d\/)/i;
const SKIP_PATH = /\.(jpe?g|png|gif|css|js|ico|svg|woff2?|mp3|mp4|zip)(\?|$)|\/(tag|tags|category|author|feed|wp-json|wp-content|wp-includes|search|login|cart)\b|[?&](replytocom|share)=/i;

// Old websites: one snapshot a year to browse, plus every archived article-like page read for quotes.
async function archivedSites(person, beforeYear, summary) {
  const urls = person.old_urls || [];
  const out = [];
  const to = beforeYear ? `&to=${beforeYear - 1}1231` : '';
  const pages = [];
  for (const raw of urls.slice(0, 5)) {
    const u = raw.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const host = u.split('/')[0].replace(/^www\./, '');
    try {
      for (const row of (await cdx(`url=${encodeURIComponent(u)}&output=json&fl=timestamp,original&filter=statuscode:200&collapse=timestamp:4&limit=30${to}`)).slice(0, 4)) {
        out.push({
          kind: 'archive', url: `${row.original}#${row.timestamp.slice(0, 4)}`, archive_url: waybackView(row.timestamp, row.original),
          title: `${row.original.replace(/^https?:\/\//, '')} as archived in ${row.timestamp.slice(0, 4)}`, outlet: 'Wayback Machine',
          published_on: tsToDate(row.timestamp), year: Number(row.timestamp.slice(0, 4)), snippet: 'Old website home page. Browse it for bio, policy pages and links.', quotes: [],
        });
      }
      const all = await cdx(`url=${encodeURIComponent(host)}&matchType=domain&output=json&fl=timestamp,original&filter=statuscode:200&filter=mimetype:text/html&collapse=urlkey&limit=5000${to}`);
      const content = all.filter(r => CONTENT_PATH.test(r.original.replace(/^https?:\/\/[^/]+/, '')) && !SKIP_PATH.test(r.original));
      pages.push(...content.map(r => ({ ...r, host })));
      summary.site_pages_found = (summary.site_pages_found || 0) + content.length;
    } catch (e) { summary.errors.push(`Old site ${host}: ${e.message}`); }
  }
  const pick = spread(pages, Number(process.env.SCAN_SITE_PAGES || 40));
  const read = await pool(pick, 5, async (row) => {
    const res = await timed(waybackRaw(row.timestamp, row.original), 45000);
    if (!res.ok) return null;
    const html = await res.text();
    const text = htmlToText(html);
    if (text.length < 300) return null;
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.replace(/\s+/g, ' ').trim() || row.original.replace(/^https?:\/\//, '');
    const q = await extractQuotes(person, text, { title, ownSite: true }).catch(() => null);
    const verified = (q?.quotes || []).filter(x => verifyQuote(x, text) && attributedQuote(x, text, person, { ownSite: true })).slice(0, 6);
    if (!verified.length) return null;
    const pub = q.published || '';
    return {
      kind: 'archive', url: row.original.replace(/:80\//, '/'), archive_url: waybackView(row.timestamp, row.original), title,
      outlet: `${row.host} (archived)`, published_on: /^\d{4}-\d{2}-\d{2}$/.test(pub) ? pub : tsToDate(row.timestamp),
      year: yearOf(pub) || Number(row.timestamp.slice(0, 4)), snippet: q.summary || 'Page from their old website.',
      quotes: verified.map(text => ({ text, verified: true })),
    };
  });
  out.push(...read.filter(Boolean));
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
    SCAN_KEYWORDS = (scan.keywords || '').slice(0, 300);
    const summary = { web: 0, web_verified_quotes: 0, web_dropped: 0, tweets: 0, archives: 0, videos: 0, trove: 0, errors: [] };
    const leads = [];
    const tag = (l) => ({ ...l, person_id: person.id, scan_id: scanId });

    if (!process.env.YOUTUBE_API_KEY) summary.errors.push('YouTube skipped (no YOUTUBE_API_KEY set)');
    if (!process.env.TROVE_API_KEY) summary.errors.push('Trove skipped (no TROVE_API_KEY set)');
    if (!person.handles?.twitter) summary.notes = 'No Twitter handle in Research details, so archived tweets were skipped.';
    // Run the independent sources side by side
    const [webLeads, tweets, sites, vids, tro] = await Promise.all([
      webSearch(person, beforeYear, summary, scan.keywords).catch(e => { summary.errors.push(`Web search: ${e.message}`); return []; }),
      person.handles?.twitter ? archivedTweets(person.handles.twitter, beforeYear).catch(e => { summary.errors.push(`Tweets: ${e.message}`); return []; }) : [],
      (person.old_urls || []).length ? archivedSites(person, beforeYear, summary).catch(e => { summary.errors.push(`Old sites: ${e.message}`); return []; }) : [],
      youtube(person, beforeYear).catch(e => { summary.errors.push(`YouTube: ${e.message}`); return []; }),
      trove(person, beforeYear).catch(e => { summary.errors.push(`Trove: ${e.message}`); return []; }),
    ]);

    // Read each web lead and keep only verified quotes
    const checked = await pool(webLeads.slice(0, MAX_PAGES), 6, async (l) => {
      const year = yearOf(l.date);
      const { text, archive_url, html } = await readPage(l.url, year || beforeYear);
      if (!text) return { kind: 'web', url: l.url, archive_url, title: l.title, outlet: l.outlet || null, published_on: /^\d{4}-\d{2}-\d{2}$/.test(l.date || '') ? l.date : null, year, snippet: `${l.why || ''} (Couldn't open the page to check quotes. Paywalled or blocked; read it yourself.)`.trim(), quotes: [] };
      if (!mentionsPerson(text, person)) { summary.wrong_person = (summary.wrong_person || 0) + 1; return null; }
      const q = await extractQuotes(person, text, l);
      if (!q) return null;                    // page never mentions them
      if (q.same_person === false) { summary.wrong_person = (summary.wrong_person || 0) + 1; return null; }
      const metaDate = publishedFromHtml(html, l.url);
      let pageYear = yearOf(metaDate || q.published || l.date);
      if (beforeYear && !pageYear) { const fc = await firstCaptureYear(l.url); if (fc && fc >= beforeYear) pageYear = fc; }
      if (beforeYear && pageYear && pageYear >= beforeYear) { summary.too_recent = (summary.too_recent || 0) + 1; return null; }
      const verified = (q.quotes || []).filter(s => verifyQuote(s, text) && attributedQuote(s, text, person)).slice(0, 6);
      summary.web_dropped += (q.quotes || []).length - verified.length;
      summary.web_verified_quotes += verified.length;
      const pub = metaDate || q.published || l.date || '';
      return {
        kind: 'web', url: l.url, archive_url, title: l.title, outlet: q.outlet || l.outlet || null,
        published_on: /^\d{4}-\d{2}-\d{2}$/.test(pub) ? pub : null, year: pageYear || yearOf(pub),
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
    if (scan.keywords) summary.keywords = scan.keywords;
    await db(`gf_scans?id=eq.${scanId}`, { method: 'PATCH', body: { status: 'done', summary, finished_at: new Date().toISOString() } });
    await log('scan', summary.errors.filter(e => !/skipped/.test(e)).length === 0, { person: person.full_name, ...summary });
  } catch (e) {
    await fail(scanId, e.message);
  }
  return new Response('ok');
};
