// Pulls every sitting federal MP and senator from OpenAustralia, matches them to
// They Vote For You, and refreshes their voting records. Runs nightly via cron,
// or on demand from the Admin tab. Background function: up to 15 minutes.
import {
  db, upsert, log, requireUser, isCron, oa, tvfy,
  oaMemberToPerson, tvfyPersonSummary, normName, normPlace,
} from '../lib/gfile.mjs';

async function pool(items, size, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: size }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx]); } catch (e) { out[idx] = { error: e.message }; }
    }
  });
  await Promise.all(workers);
  return out;
}

export default async (req) => {
  if (!isCron(req) && !(await requireUser(req))) return new Response('Unauthorised', { status: 401 });

  const summary = { reps: 0, senators: 0, matched_tvfy: 0, retired: 0, policy_rows: 0, errors: [] };
  try {
    // 1. Members from OpenAustralia
    const [repsRaw, senRaw] = await Promise.all([oa('getRepresentatives'), oa('getSenators')]);
    const reps = (Array.isArray(repsRaw) ? repsRaw : []).map(m => oaMemberToPerson(m, 'house'));
    const sens = (Array.isArray(senRaw) ? senRaw : []).map(m => oaMemberToPerson(m, 'senate'));
    summary.reps = reps.length;
    summary.senators = sens.length;
    if (reps.length < 100 || sens.length < 50) throw new Error(`Suspiciously few members returned (${reps.length} reps, ${sens.length} senators) — aborting so nobody is wrongly marked former.`);

    // 2. Match to They Vote For You
    let tvfyPeople = [];
    try { tvfyPeople = (await tvfy('people.json')).map(tvfyPersonSummary); }
    catch (e) { summary.errors.push(`TVFY list: ${e.message}`); }
    const tvById = new Map(tvfyPeople.map(p => [p.id, p]));
    const tvByName = new Map();
    for (const p of tvfyPeople) {
      const k = normName(p.name);
      tvByName.set(k, tvByName.has(k) ? null : p); // null = ambiguous, don't guess
    }
    for (const p of [...reps, ...sens]) {
      let hit = tvById.get(p.oa_person_id);
      if (hit && normName(hit.name).split(' ').pop() !== normName(p.full_name).split(' ').pop()) hit = null; // ids disagree on surname — don't trust
      if (!hit) {
        const byName = tvByName.get(normName(p.full_name));
        if (byName && (p.chamber === 'senate' || normPlace(byName.electorate) === normPlace(p.electorate))) hit = byName;
      }
      p.tvfy_id = hit ? hit.id : null;
    }
    // Never let two people share one voting record — if a match is claimed twice, drop both.
    const claims = new Map();
    for (const p of [...reps, ...sens]) if (p.tvfy_id) claims.set(p.tvfy_id, (claims.get(p.tvfy_id) || 0) + 1);
    for (const p of [...reps, ...sens]) {
      if (p.tvfy_id && claims.get(p.tvfy_id) > 1) p.tvfy_id = null;
      if (p.tvfy_id) summary.matched_tvfy++;
    }

    // 3. Upsert people
    const saved = await upsert('gf_people', [...reps, ...sens], 'oa_person_id');
    const sittingIds = new Set(saved.map(r => r.id));

    // 4. Anyone we synced before who's no longer sitting → former
    const prior = await db('gf_people?select=id&jurisdiction=eq.federal&status=eq.sitting&oa_person_id=not.is.null');
    const gone = prior.filter(r => !sittingIds.has(r.id)).map(r => r.id);
    if (gone.length) {
      await db(`gf_people?id=in.(${gone.join(',')})`, { method: 'PATCH', body: { status: 'former' } });
      summary.retired = gone.length;
    }

    // 5. Voting records
    const withTv = saved.filter(r => r.tvfy_id);
    await pool(withTv, 5, async (person) => {
      const d = await tvfy(`people/${person.tvfy_id}.json`);
      await db(`gf_people?id=eq.${person.id}`, {
        method: 'PATCH',
        body: {
          rebellions: d.rebellions ?? null,
          votes_attended: d.votes_attended ?? null,
          votes_possible: d.votes_possible ?? null,
          ...(Array.isArray(d.offices) && d.offices.length
            ? { offices: d.offices.map(o => o.position || o.name).filter(Boolean) }
            : {}),
        },
      });
      const rows = (d.policy_comparisons || [])
        .filter(pc => pc.policy && pc.policy.id != null)
        .map(pc => ({
          person_id: person.id,
          tvfy_policy_id: String(pc.policy.id),
          policy_name: pc.policy.name || `Policy ${pc.policy.id}`,
          policy_description: pc.policy.description || null,
          agreement: pc.agreement != null ? Number(pc.agreement) : null,
          voted: pc.voted ?? null,
          updated_at: new Date().toISOString(),
        }));
      for (let i = 0; i < rows.length; i += 200) await upsert('gf_policy_positions', rows.slice(i, i + 200), 'person_id,tvfy_policy_id');
      summary.policy_rows += rows.length;
    }).then(results => {
      const errs = results.filter(r => r && r.error);
      if (errs.length) summary.errors.push(`${errs.length} voting-record fetches failed (first: ${errs[0].error})`);
    });

    await log('sync-people', summary.errors.length === 0, summary);
  } catch (e) {
    summary.errors.push(e.message);
    await log('sync-people', false, summary);
  }
  return new Response('ok');
};
