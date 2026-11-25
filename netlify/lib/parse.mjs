// Turning Hansard and council minutes into who-said-what and who-did-what.
// Pure functions (apart from pdfToText) so they can be tested without a network.

import { stripHtml } from './gfile.mjs';

// ───────── Text extraction ─────────
export async function pdfToText(buffer) {
  const { getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    let out = '', lastY = null;
    for (const it of tc.items) {
      if (!('str' in it)) continue;
      const y = it.transform ? Math.round(it.transform[5]) : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2 && !out.endsWith('\n')) out += '\n';
      out += it.str;
      if (it.hasEOL) out += '\n';
      lastY = y;
    }
    pages.push(out);
  }
  return pages.join('\n\f\n');
}

export function htmlToText(html) {
  return stripHtml(String(html)
    .replace(/<(script|style|nav|header|footer)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(div|h\d|li|tr|section|article)>/gi, '\n'));
}

export const clean = (s) => String(s || '')
  .replace(/\r/g, '')
  .replace(/[   ]/g, ' ')
  .replace(/[ \t]+/g, ' ')
  .replace(/-\n(?=[a-z])/g, '')          // re-join hyphenated line breaks
  .replace(/\n{3,}/g, '\n\n');

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, "'").replace(/[^a-z' -]/g, '').trim();
const surnameKey = (s) => norm(s).replace(/['\s-]/g, '');

// ───────── Hansard ─────────
// Matches speaker headings used across Australian parliaments, e.g.
//   Mr DAVID HARRIS (Wyong—Minister for Jobs) (10:15):      NSW
//   Georgie CROZIER (Southern Metropolitan) (10:05):         Vic
//   Mr CRISAFULLI (Broadwater—LNP) (Premier) (9.31 am):      Qld
//   The Hon. S.C. MULLIGHAN (Lee—Treasurer) (14:15):         SA
//   MR R.S. LOVE (Moore — Leader of the Opposition) [10.05 am]:   WA
//   Mr ROCKLIFF (Braddon - Premier) - Honourable Speaker     Tas
const TITLE = String.raw`(?:(?:The[ \t]+)?Hon(?:ourable)?\.?[ \t]+|Mr\.?[ \t]+|Mrs\.?[ \t]+|Ms\.?[ \t]+|Miss[ \t]+|Dr\.?[ \t]+|MR\.?[ \t]+|MRS\.?[ \t]+|MS\.?[ \t]+|DR\.?[ \t]+|HON\.?[ \t]+|Senator[ \t]+)`;
const GIVEN = String.raw`(?:(?:[A-Z][a-z'’-]+|[A-Z]\.(?:[A-Z]\.)*)[ \t]+)*`;
const SURNAME = String.raw`(?:Mc|Mac|O['’]|De|Di|Van|Le)?[A-Z][A-Z'’-]+(?:[ \t]+[A-Z][A-Z'’-]{1,}){0,2}`;
const PARTICLES = new Set(['VAN', 'VON', 'DE', 'DI', 'DA', 'DEL', 'LE', 'LA', 'DU', 'ST', 'DER', 'DEN']);
const PARENS = String.raw`(?:\s*\((?:[^()]|\([^()]*\)){0,200}\))*`;
const TIME = String.raw`(?:\s*\[[^\]]{1,20}\])?`;
const SPEAKER_RE = new RegExp(String.raw`(^|\n)[ \t]*(${TITLE}*)(${GIVEN})(${SURNAME})(${PARENS})${TIME}\s*(?::|\s[-–—]\s)`, 'g');
const NOT_PEOPLE = new Set(['SPEAKER', 'PRESIDENT', 'CHAIR', 'CHAIRMAN', 'CHAIRPERSON', 'CLERK', 'MEMBERS', 'MEMBER', 'DEPUTY', 'ACTING', 'QUESTIONS', 'BILLS', 'MOTION', 'AYES', 'NOES', 'PAIRS', 'TELLERS', 'NOTICE', 'PAPERS']);

export function splitHansard(text, { minChars = 120 } = {}) {
  const t = clean(text);
  const heads = [];
  for (const m of t.matchAll(SPEAKER_RE)) {
    const title = (m[2] || '').trim(); let given = (m[3] || '').trim(); let surname = (m[4] || '').trim(); const parens = (m[5] || '').trim();
    // NSW style "DAVID HARRIS": all-caps given name(s) before the surname
    const words = surname.split(/\s+/);
    if (words.length > 1) {
      let k = words.length - 1;
      while (k > 0 && PARTICLES.has(words[k - 1].toUpperCase())) k--;
      if (k > 0) { given = [given, ...words.slice(0, k)].filter(Boolean).join(' '); surname = words.slice(k).join(' '); }
    }
    if (!title && !parens) continue;                        // need a title or an (Electorate) to be a speaker line
    const first = surname.split(/\s+/)[0].toUpperCase();
    if (NOT_PEOPLE.has(first)) continue;
    if (surname.length < 2 || surname === surname.toLowerCase()) continue;
    const electorate = (parens.match(/\(([^()—–\-]+)/) || [])[1]?.trim() || null;
    heads.push({ index: m.index + m[1].length, end: m.index + m[0].length, title, given, surname, electorate, heading: m[0].trim() });
  }
  const out = [];
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i];
    const body = t.slice(h.end, i + 1 < heads.length ? heads[i + 1].index : t.length)
      .replace(/\n\f\n/g, '\n').replace(/\s*\n\s*/g, ' ').trim();
    if (body.length < minChars) continue;
    out.push({ surname: h.surname, given: h.given, electorate: h.electorate, heading: h.heading, text: body });
  }
  return out;
}

// people: [{ id, first_name, last_name, full_name, electorate, chamber }]
export function matchSpeaker(seg, people) {
  const key = surnameKey(seg.surname.split(/\s+/).length > 1 && !/^(MC|MAC|DE|DI|VAN|LE)/.test(seg.surname) ? seg.surname : seg.surname);
  let c = people.filter(p => surnameKey(p.last_name || (p.full_name || '').split(/\s+/).pop()) === key);
  if (!c.length) { // double-barrelled or "VAN DER BERG": try last word
    const last = surnameKey(seg.surname.split(/\s+/).pop());
    c = people.filter(p => surnameKey(p.last_name || '') === last);
  }
  if (c.length > 1 && seg.electorate) {
    const e = norm(seg.electorate);
    const byE = c.filter(p => p.electorate && norm(p.electorate) === e);
    if (byE.length) c = byE;
  }
  if (c.length > 1 && seg.given) {
    const g = seg.given.replace(/\./g, ' ').trim().split(/\s+/)[0]?.toLowerCase();
    const byG = c.filter(p => (p.first_name || p.full_name || '').toLowerCase().startsWith(g.length === 1 ? g : g.slice(0, 3)));
    if (byG.length) c = byG;
  }
  return c.length === 1 ? c[0] : null;
}

// ───────── Council minutes ─────────
const CR = String.raw`(?:Crs?|Clr|Cllr|Councillors?|Deputy[ \t]+Mayor|Mayor|The[ \t]+Mayor,?[ \t]*(?:Cr|Councillor)?)\.?`;
const NAME = String.raw`((?:[A-Z][a-zA-Z'’-]+[ \t]+){0,2}(?:Mc|Mac|O['’])?[A-Z][a-zA-Z'’-]+)`;
const MOVED_RE = new RegExp(String.raw`\b(?:MOVED|Moved|moved)(?:[ \t]+by)?[ \t]*[:\-–]?[ \t]*${CR}[ \t]+${NAME}`, 'g');
const SECONDED_RE = new RegExp(String.raw`\b(?:SECONDED|Seconded|seconded)(?:[ \t]+by)?[ \t]*[:\-–]?[ \t]*${CR}[ \t]+${NAME}`, 'g');
const VOTE_RE = /\b(For(?: the [Mm]otion)?|FOR(?: THE MOTION)?|In [Ff]avour|IN FAVOUR|Voting [Ff]or|Ayes|AYES|Against(?: the [Mm]otion)?|AGAINST(?: THE MOTION)?|Voting [Aa]gainst|Noes|NOES)\s*:?\s*((?:\(?\d+\)?\s*)?(?:Crs?\.?|Councillors?|Mayor|Clr|Cllr)[^\n]{2,400})/g;
const INTEREST_RE = new RegExp(String.raw`${CR}[ \t]+${NAME}[^.\n]{0,160}?\b(?:declared?|declaration)\b[^.]{0,200}?\binterest\b[^.]*\.?|\b(?:declared?|declaration)\b[^.]{0,120}?\binterest\b[^.]{0,120}?${CR}[ \t]+${NAME}[^.]*\.?`, 'g');
const ITEM_RE = /(^|\n)\s*((?:Item\s+)?\d{1,2}(?:\.\d{1,2}){0,3}\.?\s+[A-Z][^\n]{4,140})(?=\n)/g;
const END_RE = /\b(CARRIED|Carried|LOST|Lost|DEFEATED|Defeated|The motion was|The [Mm]otion on being put|On being put|For\s*:|FOR\s*:|Against\s*:|AGAINST\s*:|Division|DIVISION|Voting [Ff]or)/;

function cleanName(n) {
  return String(n || '').replace(/\b(Cr|Crs|Clr|Cllr|Councillors?|Mayor|Deputy|The|and|Dr|Mr|Mrs|Ms)\b\.?/g, ' ')
    .replace(/[()\d]/g, ' ').replace(/\s+/g, ' ').trim();
}
function namesFromList(s) {
  return s.split(/,|;|\band\b|&|\n/).map(cleanName).filter(n => /^[A-Z][a-zA-Z'’ -]{1,40}$/.test(n) && !/^(Nil|None|The|Motion|Council)$/i.test(n));
}

export function parseMinutes(text) {
  const t = clean(text);
  const items = [...t.matchAll(ITEM_RE)].map(m => ({ at: m.index + m[1].length, title: m[2].trim() }));
  const itemAt = (pos) => { let cur = null; for (const it of items) { if (it.at <= pos) cur = it.title; else break; } return cur; };
  const actions = [];

  const moved = [...t.matchAll(MOVED_RE)];
  const seconded = [...t.matchAll(SECONDED_RE)];
  for (const m of moved) {
    const pos = m.index;
    // Motion text: the "That ..." resolution next to the moved/seconded lines
    const after = t.slice(pos, pos + 2500);
    let motion = null;
    const sec = seconded.find(s => s.index > pos && s.index - pos < 400);
    const fromAfter = after.slice(sec ? sec.index - pos + sec[0].length : m[0].length);
    const thatAfter = fromAfter.search(/\bThat\b/);
    if (thatAfter !== -1 && thatAfter < 300) {
      const rest = fromAfter.slice(thatAfter);
      const end = rest.search(END_RE);
      motion = rest.slice(0, end === -1 ? 1500 : end);
    } else {
      const before = t.slice(Math.max(0, pos - 1500), pos);
      const lastThat = before.lastIndexOf('That ');
      if (lastThat !== -1) motion = before.slice(lastThat);
    }
    motion = motion ? motion.replace(/\s*\n\s*/g, ' ').trim().slice(0, 1500) : null;
    const item = itemAt(pos);
    actions.push({ action: 'moved', name: cleanName(m[1]), item, detail: motion, at: pos });
    if (sec) actions.push({ action: 'seconded', name: cleanName(sec[1]), item, detail: motion, at: sec.index });
  }
  for (const m of t.matchAll(VOTE_RE)) {
    const side = /against|noes/i.test(m[1]) ? 'voted_against' : 'voted_for';
    // stop the list at the next vote label so "For: A, B Against: C" on one line splits properly
    const list = m[2].split(/\b(?:Against|AGAINST|Noes|NOES|For|FOR)\b\s*:/)[0];
    for (const n of namesFromList(list)) actions.push({ action: side, name: n, item: itemAt(m.index), detail: null, at: m.index });
  }
  for (const m of t.matchAll(INTEREST_RE)) {
    const name = cleanName(m[1] || m[2]);
    if (name) actions.push({ action: 'declared_interest', name, item: itemAt(m.index), detail: m[0].replace(/\s+/g, ' ').trim().slice(0, 600), at: m.index });
  }
  return actions;
}

// councillors: [{ id, first_name, last_name, full_name }]
export function matchCouncillor(name, councillors) {
  const parts = cleanName(name).split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const last = surnameKey(parts[parts.length - 1]);
  let c = councillors.filter(p => surnameKey(p.last_name || (p.full_name || '').split(/\s+/).pop()) === last);
  if (c.length > 1 && parts.length > 1) {
    const f = parts[0].toLowerCase();
    const byF = c.filter(p => (p.first_name || p.full_name || '').toLowerCase().startsWith(f));
    if (byF.length) c = byF;
  }
  return c.length === 1 ? c[0] : null;
}

// ───────── Dates ─────────
const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, sept:9, oct:10, nov:11, dec:12 };
export function findDate(s) {
  s = String(s || '');
  let m = s.match(/(?<!\d)(20\d\d|19\d\d)[-_.]?(0[1-9]|1[0-2])[-_.]?([0-2]\d|3[01])(?!\d)/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/\b([0-3]?\d)(?:st|nd|rd|th)?[\s-]+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)[a-z]*\.?[\s-]+((?:19|20)\d\d)\b/i);
  if (m) return `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/(?<!\d)([0-3]?\d)[/.]([01]?\d)[/.]((?:19|20)\d\d)(?!\d)/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/(?<!\d)([0-3]\d)([01]\d)((?:19|20)\d\d)(?!\d)/); // 26112024
  if (m && Number(m[2]) <= 12) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

// ───────── Listing pages ─────────
export function extractLinks(html, baseUrl) {
  const out = [];
  for (const m of String(html).matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const url = new URL(m[1].replace(/&amp;/g, '&'), baseUrl).href;
      const text = stripHtml(m[2]).replace(/\s+/g, ' ').trim();
      out.push({ url, text });
    } catch (_) {}
  }
  return out;
}
