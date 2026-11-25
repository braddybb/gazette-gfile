// Wikidata helpers for state and territory members.

// qid where known; label as fallback lookup. expected = seats, for sanity checks.
export const POSITIONS = [
  { key: 'nsw_lower', jurisdiction: 'nsw', chamber: 'lower', qid: 'Q19202748', label: 'Member of the New South Wales Legislative Assembly', expected: 93, singleMember: true },
  { key: 'nsw_upper', jurisdiction: 'nsw', chamber: 'upper', qid: 'Q18810377', label: 'Member of the New South Wales Legislative Council', expected: 42 },
  { key: 'vic_lower', jurisdiction: 'vic', chamber: 'lower', qid: 'Q18534408', label: 'Member of the Victorian Legislative Assembly', expected: 88, singleMember: true },
  { key: 'vic_upper', jurisdiction: 'vic', chamber: 'upper', qid: 'Q19185341', label: 'Member of the Victorian Legislative Council', expected: 40 },
  { key: 'qld_lower', jurisdiction: 'qld', chamber: 'lower', qid: 'Q18526194', label: 'Member of the Queensland Legislative Assembly', expected: 93, singleMember: true },
  { key: 'wa_lower',  jurisdiction: 'wa',  chamber: 'lower', qid: 'Q20165902', label: 'Member of the Western Australian Legislative Assembly', expected: 59, singleMember: true },
  { key: 'wa_upper',  jurisdiction: 'wa',  chamber: 'upper', qid: 'Q19627913', label: 'Member of the Western Australian Legislative Council', expected: 37 },
  { key: 'sa_lower',  jurisdiction: 'sa',  chamber: 'lower', qid: 'Q18220900', label: 'Member of the South Australian House of Assembly', expected: 47, singleMember: true },
  { key: 'sa_upper',  jurisdiction: 'sa',  chamber: 'upper', qid: 'Q18662245', label: 'Member of the South Australian Legislative Council', expected: 22 },
  { key: 'tas_lower', jurisdiction: 'tas', chamber: 'lower', qid: 'Q19007285', label: 'Member of the Tasmanian House of Assembly', expected: 35 },
  { key: 'tas_upper', jurisdiction: 'tas', chamber: 'upper', qid: 'Q19299542', label: 'Member of the Tasmanian Legislative Council', expected: 15, singleMember: true },
  { key: 'act',       jurisdiction: 'act', chamber: 'lower', qid: 'Q6814365', label: 'Member of the Australian Capital Territory Legislative Assembly', expected: 25 },
  { key: 'nt',        jurisdiction: 'nt',  chamber: 'lower', qid: 'Q26998278', label: 'Member of the Northern Territory Legislative Assembly', expected: 25, singleMember: true },
];

export const UA = { 'User-Agent': 'GFILE/1.0 (Gazette newsroom research tool)', Accept: 'application/sparql-results+json' };
export const MAX_AGE_YEARS = 13; // no current seat is older than this without a fresh term

export async function resolveLabel(label) {
  const u = `https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en&type=item&limit=5&search=${encodeURIComponent(label)}`;
  const r = await fetch(u, { headers: UA });
  if (!r.ok) return null;
  const j = await r.json();
  const hit = (j.search || []).find(s => (s.label || '').toLowerCase() === label.toLowerCase());
  return hit ? hit.id : null;
}

const qidOf = (uri) => (uri ? String(uri).split('/').pop() : null);

export function pickCurrent(rows, pos, now = new Date()) {
  // One row per statement; prefer explicit start, else term start.
  const byStmt = new Map();
  for (const b of rows) {
    const st = b.st?.value; if (!st) continue;
    const prev = byStmt.get(st);
    const rec = prev || {
      person: qidOf(b.person?.value), name: b.personLabel?.value,
      district: b.districtLabel?.value || null, party: b.partyLabel?.value || null,
      when: b.start?.value || b.termStart?.value || null, image: b.image?.value || null,
    };
    if (!rec.party && b.party2Label?.value) rec.party = b.party2Label.value;
    if (!rec.when && (b.start?.value || b.termStart?.value)) rec.when = b.start?.value || b.termStart?.value;
    byStmt.set(st, rec);
  }
  const cutoff = new Date(now); cutoff.setFullYear(cutoff.getFullYear() - MAX_AGE_YEARS);
  let list = [...byStmt.values()].filter(r => r.person && r.name && !/^Q\d+$/.test(r.name) && (!r.when || new Date(r.when) >= cutoff));
  // Same person twice (several open statements) → keep the most recent
  const byPerson = new Map();
  for (const r of list) { const p = byPerson.get(r.person); if (!p || String(r.when || '') > String(p.when || '')) byPerson.set(r.person, r); }
  list = [...byPerson.values()].sort((a, b) => String(b.when || '').localeCompare(String(a.when || '')));
  if (pos.singleMember) {
    const seen = new Set();
    list = list.filter(r => { if (!r.district) return true; const k = r.district.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  }
  const trimmed = list.length > pos.expected ? list.length - pos.expected : 0;
  if (trimmed) list = list.slice(0, pos.expected); // most recent first
  return { list, trimmed };
}

