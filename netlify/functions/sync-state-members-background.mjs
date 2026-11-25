// Current members of every state and territory parliament, from Wikidata (free, CC0, kept current by
// Wikipedia editors). Gives name, seat, party and photo. Anyone synced before who's no longer
// listed is marked former. Position IDs can be overridden from Admin (settings key wikidata_positions).
import { db, upsert, log, requireUser, isCron } from '../lib/gfile.mjs';
import { POSITIONS, UA, resolveLabel, pickCurrent } from '../lib/state.mjs';


export default async (req) => {
  if (!isCron(req) && !(await requireUser(req))) return new Response('Unauthorised', { status: 401 });
  const summary = { chambers: {}, errors: [] };
  try {
    const [setting] = await db('gf_settings?key=eq.wikidata_positions&select=value');
    const overrides = setting?.value || {};
    const keepIds = [];
    let anyFailed = false;

    for (const pos of POSITIONS) {
      try {
        const qid = overrides[pos.key] || pos.qid || await resolveLabel(pos.label);
        if (!qid) { summary.chambers[pos.key] = { error: 'position not found on Wikidata — set its ID in Admin' }; anyFailed = true; continue; }
        const q = `SELECT ?st ?person ?personLabel ?districtLabel ?partyLabel ?party2Label ?start ?termStart ?image ?firstStart WHERE {
          ?person p:P39 ?st . ?st ps:P39 wd:${qid} .
          FILTER NOT EXISTS { ?st pq:P582 [] }
          FILTER NOT EXISTS { ?person wdt:P570 [] }
          OPTIONAL { ?st pq:P768 ?district }
          OPTIONAL { ?st pq:P4100 ?party }
          OPTIONAL { ?st pq:P580 ?start }
          OPTIONAL { ?st pq:P2937 ?term . ?term wdt:P580 ?termStart }
          OPTIONAL { ?person p:P102 ?ps . ?ps ps:P102 ?party2 . FILTER NOT EXISTS { ?ps pq:P582 [] } }
          OPTIONAL { ?person wdt:P18 ?image }
          OPTIONAL { SELECT ?person (MIN(?s0) AS ?firstStart) WHERE { ?person p:P39 ?x0 . ?x0 ps:P39 wd:${qid} . OPTIONAL { ?x0 pq:P580 ?a0 } OPTIONAL { ?x0 pq:P2937 ?t0 . ?t0 wdt:P580 ?b0 } BIND(COALESCE(?a0, ?b0) AS ?s0) } GROUP BY ?person }
          SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
        }`;
        const r = await fetch(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(q)}`, { headers: UA });
        if (!r.ok) throw new Error(`Wikidata ${r.status}`);
        const rows = (await r.json()).results?.bindings || [];
        const { list, trimmed } = pickCurrent(rows, pos);
        if (list.length < pos.expected * 0.6) { // too few → probably bad data; don't touch this chamber
          summary.chambers[pos.key] = { qid, found: list.length, expected: pos.expected, error: 'too few members found — skipped so nobody is wrongly marked former' };
          anyFailed = true; continue;
        }
        const people = list.map(m => {
          const parts = m.name.trim().split(/\s+/);
          return {
            wikidata_id: m.person, full_name: m.name.trim(), first_name: parts.slice(0, -1).join(' ') || null,
            last_name: parts.slice(-1)[0], jurisdiction: pos.jurisdiction, chamber: pos.chamber, status: 'sitting',
            electorate: m.district, state: pos.jurisdiction.toUpperCase(), party: m.party,
            photo_url: m.image ? `${m.image.replace(/^http:/, 'https:')}?width=240` : null,
            ...(m.firstStart ? { first_elected: Number(String(m.firstStart).slice(0, 4)) } : {}),
          };
        });
        const saved = await upsert('gf_people', people, 'wikidata_id');
        keepIds.push(...saved.map(s => s.id));
        summary.chambers[pos.key] = { qid, found: list.length, expected: pos.expected, ...(trimmed ? { trimmed_older: trimmed } : {}) };
      } catch (e) {
        summary.chambers[pos.key] = { error: e.message }; anyFailed = true;
      }
    }

    // Retire state MPs no longer listed — only if every chamber synced cleanly
    if (!anyFailed) {
      const prior = await db('gf_people?select=id&wikidata_id=not.is.null&jurisdiction=neq.federal&chamber=neq.council&status=eq.sitting');
      const keep = new Set(keepIds);
      const gone = prior.filter(p => !keep.has(p.id)).map(p => p.id);
      for (let i = 0; i < gone.length; i += 100) {
        await db(`gf_people?id=in.(${gone.slice(i, i + 100).join(',')})`, { method: 'PATCH', body: { status: 'former' } });
      }
      summary.retired = gone.length;
    } else {
      summary.retired = 0;
      summary.errors.push('Some chambers failed, so nobody was marked former this run.');
    }
    await log('sync-state-members', !anyFailed, summary);
  } catch (e) {
    summary.errors.push(e.message);
    await log('sync-state-members', false, summary);
  }
  return new Response('ok');
};
