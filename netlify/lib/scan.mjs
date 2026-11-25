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
