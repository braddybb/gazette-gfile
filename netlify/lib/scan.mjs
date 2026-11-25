// Helpers for the old-media deep scan. Pure functions where possible.
import { stripHtml } from './gfile.mjs';

const normQ = (s) => String(s || '').toLowerCase()
  .replace(/[“”„"]/g, '"').replace(/[‘’`']/g, "'").replace(/[–—]/g, '-')
  .replace(/&nbsp;| /g, ' ').replace(/\s+/g, ' ').trim();

// A quote only counts if its words really are in the page. Ellipses split it into pieces
// that must each appear, in order.
export function verifyQuote(quote, pageText) {
  const page = normQ(pageText);
  const q = normQ(quote).replace(/^["'\s]+|["'\s]+$/g, '');
  if (q.split(' ').length < 4) return false;
  const pieces = q.split(/\s*(?:\.\.\.|…|\[\s*\.\.\.\s*\])\s*/).map(p => p.trim()).filter(Boolean);
  let from = 0;
  for (const piece of pieces) {
    if (piece.split(' ').length < 3 && pieces.length > 1) continue;
    const at = page.indexOf(piece, from);
    if (at === -1) return false;
    from = at + piece.length;
  }
  return true;
}

// Old Twitter page (as captured by the Wayback Machine) → tweet text + date
export function tweetFromHtml(html) {
  const h = String(html || '');
  let text = null;
  const og = h.match(/<meta\s+(?:property|name)=["']og:description["']\s+content=["']([\s\S]*?)["']\s*\/?>/i)
          || h.match(/<meta\s+content=["']([\s\S]*?)["']\s+(?:property|name)=["']og:description["']/i);
  if (og) text = stripHtml(og[1]).replace(/^[“"]|[”"]$/g, '').trim();
  if (!text) {
    const p = h.match(/<p[^>]+class=["'][^"']*(?:js-tweet-text|tweet-text|TweetTextSize)[^"']*["'][^>]*>([\s\S]*?)<\/p>/i);
    if (p) text = stripHtml(p[1]).trim();
  }
  if (!text) {
    const e = h.match(/<span[^>]+class=["']entry-content["'][^>]*>([\s\S]*?)<\/span>/i); // 2009–2010 layout
    if (e) text = stripHtml(e[1]).trim();
  }
  const t = h.match(/data-time=["'](\d{9,11})["']/) || h.match(/data-time-ms=["'](\d{12,14})["']/);
  let date = null;
  if (t) { const n = Number(t[1]); date = new Date(n > 1e11 ? n : n * 1000).toISOString().slice(0, 10); }
  return text && text.length > 3 ? { text, date } : null;
}

export const waybackRaw = (ts, original) => `https://web.archive.org/web/${ts}id_/${original}`;
export const waybackView = (ts, original) => `https://web.archive.org/web/${ts}/${original}`;
export const tsToDate = (ts) => (/^\d{8}/.test(ts || '') ? `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}` : null);

// CDX JSON → [{timestamp, original}]
export function parseCdx(json) {
  if (!Array.isArray(json) || json.length < 2) return [];
  const [head, ...rows] = json;
  const ti = head.indexOf('timestamp'), oi = head.indexOf('original');
  return rows.map(r => ({ timestamp: r[ti], original: r[oi] })).filter(r => r.timestamp && r.original);
}

// Pick n items spread evenly across a list (so 40 tweets cover the whole period, not one month)
export function spread(list, n) {
  if (list.length <= n) return list;
  const step = list.length / n;
  return Array.from({ length: n }, (_, i) => list[Math.floor(i * step)]);
}

// Windows of text around mentions of the person, for the quote extractor
export function windowsAround(text, names, width = 1800, max = 12000) {
  const lower = text.toLowerCase();
  const hits = [];
  for (const n of names.filter(Boolean)) {
    const k = n.toLowerCase();
    let i = lower.indexOf(k);
    while (i !== -1 && hits.length < 40) { hits.push(i); i = lower.indexOf(k, i + k.length); }
  }
  if (!hits.length) return '';
  hits.sort((a, b) => a - b);
  const spans = [];
  for (const h of hits) {
    const s = Math.max(0, h - width / 3), e = Math.min(text.length, h + (2 * width) / 3);
    const last = spans[spans.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e); else spans.push([s, e]);
  }
  let out = '';
  for (const [s, e] of spans) { if (out.length > max) break; out += (out ? '\n[…]\n' : '') + text.slice(s, e); }
  return out.slice(0, max);
}

export function yearOf(d) {
  const m = String(d || '').match(/(19|20)\d\d/);
  return m ? Number(m[0]) : null;
}

// ───────── Source quality ─────────
// Encyclopedias, profile aggregators and pages that can't be read without a login.
// They describe people in the third person, so they are not a source of the person's own words.
export const SKIP_HOSTS = /(^|\.)(wikipedia\.org|wikiwand\.com|grokipedia\.com|wikidata\.org|dbpedia\.org|everybodywiki\.com|peoplepill\.com|alchetron\.com|famousbirthdays\.com|prabook\.com|notable-people\.com|notablepeople\.\w+|celebsagewiki\.com|biographon\.com|wikitia\.com|ballotpedia\.org|linkedin\.com|facebook\.com|instagram\.com|x\.com|twitter\.com|tiktok\.com|pinterest\.\w+|quora\.com|reddit\.com)$/i;
export const BLOCKED_FOR_SEARCH = ['wikipedia.org', 'wikiwand.com', 'grokipedia.com', 'everybodywiki.com', 'peoplepill.com', 'alchetron.com', 'famousbirthdays.com', 'prabook.com', 'linkedin.com', 'pinterest.com', 'quora.com'];
export function skipHost(url) {
  try { return SKIP_HOSTS.test(new URL(url).hostname.replace(/^www\./, '')); } catch { return false; }
}

const norm2 = (s) => String(s || '').toLowerCase()
  .replace(/[“”„"]/g, '"').replace(/[‘’`']/g, "'").replace(/[–—]/g, '-')
  .replace(/&nbsp;| /g, ' ').replace(/\s+/g, ' ').trim();

// Does the page actually mention this person by name (not just their surname)?
export function mentionsPerson(text, person) {
  const t = norm2(text);
  const names = [person.full_name, ...(person.aliases || [])].filter(Boolean).map(norm2);
  const first = norm2((person.first_name || person.full_name || '').split(' ')[0]);
  const last = norm2(person.last_name || (person.full_name || '').split(' ').pop());
  if (names.some(n => n && t.includes(n))) return true;
  // "Ms Wilson", "Cr Wilson", "Senator Wilson", or first and last name close together
  if (new RegExp(`\\b(mr|mrs|ms|miss|dr|cr|councillor|senator|minister|premier|treasurer|mayor)\\.? ${last}\\b`).test(t)) return true;
  const i = t.indexOf(first), j = t.indexOf(last);
  return i !== -1 && j !== -1 && Math.abs(i - j) < 40;
}

// Is this quote plausibly the person's own words, not text written about them?
// 1. People don't refer to themselves by surname. 2. Their name (or a speaker label) should be
// near the quote on the page — "Wilson said", "MS WILSON:", "said Ms Wilson" — unless it's their own site.
export function attributedQuote(quote, pageText, person, { ownSite = false } = {}) {
  const q = norm2(quote).replace(/^["'\s]+|["'\s]+$/g, '');
  const last = norm2(person.last_name || (person.full_name || '').split(' ').pop());
  const first = norm2((person.first_name || person.full_name || '').split(' ')[0]);
  if (last && new RegExp(`\\b${last.replace(/[^a-z' -]/g, '')}\\b`).test(q)) return false;
  if (/^(he|she|they) (has|had|was|is|said|says|told|vowed|announced|pledged|supported|opposed)\b/.test(q)) return false;
  if (ownSite) return true;
  const page = norm2(pageText);
  const piece = q.split(/\s*(?:\.\.\.|…)\s*/)[0].slice(0, 60);
  const at = page.indexOf(piece);
  if (at === -1) return false;
  const around = page.slice(Math.max(0, at - 350), Math.min(page.length, at + q.length + 350));
  const nameNear = (last && around.includes(last)) || (first && first.length > 2 && around.includes(first));
  const speechCue = /\b(said|says|told|added|argued|claimed|declared|insisted|explained|wrote|writes|according to)\b|:\s*$/.test(around) || /[a-z]+:\s/.test(around.slice(0, 350));
  return nameNear && speechCue;
}

// Best guess at when a page was published, from its own metadata or URL
export function publishedFromHtml(html, url = '') {
  const h = String(html || '');
  const pick = (re) => { const m = h.match(re); return m ? m[1] : null; };
  const raw = pick(/<meta[^>]+(?:property|name|itemprop)=["'](?:article:published_time|og:published_time|datePublished|pubdate|publishdate|date|dc\.date|DC\.date\.issued|sailthru\.date)["'][^>]*content=["']([^"']+)["']/i)
    || pick(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name|itemprop)=["'](?:article:published_time|datePublished|pubdate|date)["']/i)
    || pick(/"datePublished"\s*:\s*"([^"]+)"/i)
    || pick(/<time[^>]+datetime=["']([^"']+)["']/i);
  const iso = raw && String(raw).match(/((?:19|20)\d\d)-(\d\d)-(\d\d)/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const u = String(url).match(/\/((?:19|20)\d\d)\/(\d\d)\/(\d\d)\//);
  if (u) return `${u[1]}-${u[2]}-${u[3]}`;
  return null;
}

// Pull the list of refused domains out of the search tool's error message
export function refusedDomains(message) {
  const m = String(message || '').match(/not accessible to our user agent:\s*\[([^\]]*)\]/i);
  return m ? [...m[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map(x => (x[1] || x[2]).toLowerCase()) : [];
}
