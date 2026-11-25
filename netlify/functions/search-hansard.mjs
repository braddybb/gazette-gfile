// Live search of federal Hansard via OpenAustralia, for anything not yet in the archive.
// Hits from people already in GFILE are filed automatically, so the archive grows with use.
import { db, upsert, requireUser, oa, hansardRowToStatement, stripHtml, json } from '../lib/gfile.mjs';

export default async (req) => {
  const user = await requireUser(req);
  if (!user) return json({ error: 'Sign in again' }, 401);

  const url = new URL(req.url);
  const q = (url.searchParams.get('q') || '').trim();
  const page = Math.max(1, Number(url.searchParams.get('page') || 1));
  if (q.length < 2) return json({ error: 'Search term too short' }, 400);

  let data;
  try {
    data = await oa('getHansard', { search: q, order: 'd', num: '40', page: String(page) });
  } catch (e) {
    return json({ error: e.message }, 502);
  }
  const rows = Array.isArray(data?.rows) ? data.rows : [];

  // Map OpenAustralia speaker ids to our people
  const oaIds = [...new Set(rows.map(r => r.speaker?.person_id).filter(Boolean).map(String))];
  let byOa = new Map();
  if (oaIds.length) {
    const people = await db(`gf_people?select=id,full_name,oa_person_id&oa_person_id=in.(${oaIds.map(encodeURIComponent).join(',')})`);
    byOa = new Map(people.map(p => [p.oa_person_id, p]));
  }

  const toFile = [];
  const results = rows.map(r => {
    const sp = r.speaker || {};
    const person = byOa.get(String(sp.person_id || ''));
    if (person) {
      const s = hansardRowToStatement(r, person.id);
      if (s) toFile.push(s);
    }
    return {
      gid: r.gid,
      date: r.hdate || null,
      speaker: person?.full_name || [sp.first_name, sp.last_name].filter(Boolean).join(' ') || 'Unknown speaker',
      party: sp.party || null,
      electorate: sp.constituency || null,
      person_id: person?.id || null,
      debate: stripHtml(r.parent?.body || ''),
      excerpt: stripHtml(r.extract || r.body || '').slice(0, 700),
      url: r.listurl ? (String(r.listurl).startsWith('http') ? r.listurl : `https://www.openaustralia.org.au${r.listurl}`) : null,
    };
  });

  if (toFile.length) {
    const unique = [...new Map(toFile.map(s => [s.external_id, s])).values()];
    try { await upsert('gf_statements', unique, 'external_id', { ignore: true }); } catch (_) { /* filing is best-effort */ }
  }

  const total = Number(data?.info?.total_results || data?.searchdescription?.total || 0) || null;
  return json({ q, page, total, filed: toFile.length, results });
};
