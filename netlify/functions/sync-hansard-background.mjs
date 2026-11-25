// Pulls recent federal Hansard speeches for a rotating batch of members and files
// them as statements. First pass on a person goes deeper (up to 300 speeches);
// later passes just top up. Then posts any new matches for watched topics to Slack.
import { db, upsert, log, requireUser, isCron, oaSpeeches, hansardRowToStatement, slack } from '../lib/gfile.mjs';

const BATCH = Number(process.env.HANSARD_BATCH || 60);

export default async (req) => {
  if (!isCron(req) && !(await requireUser(req))) return new Response('Unauthorised', { status: 401 });
  const startedAt = new Date();
  const summary = { people: 0, statements: 0, alerts: 0, errors: [] };
  // slot lets the nightly job run several batches at once without overlapping
  const slot = Math.max(0, Math.min(9, Number(new URL(req.url).searchParams.get('slot') || 0)));
  summary.slot = slot;

  try {
    const people = await db(
      `gf_people?select=id,full_name,oa_person_id,hansard_synced_at&jurisdiction=eq.federal&status=eq.sitting&oa_person_id=not.is.null&order=hansard_synced_at.asc.nullsfirst&limit=${BATCH}&offset=${slot * BATCH}`
    );
    for (const p of people) {
      try {
        const firstPass = !p.hansard_synced_at;
        const pages = firstPass ? 3 : 1;
        const num = firstPass ? 100 : 50;
        const rows = [];
        for (let page = 1; page <= pages; page++) {
          const data = await oaSpeeches(p.oa_person_id, { num, page });
          const got = Array.isArray(data?.rows) ? data.rows : Array.isArray(data) ? data : [];
          rows.push(...got);
          if (got.length < num) break;
        }
        const stmts = rows.map(r => hansardRowToStatement(r, p.id)).filter(Boolean);
        // de-dupe within the batch before upserting
        const unique = [...new Map(stmts.map(s => [s.external_id, s])).values()];
        for (let i = 0; i < unique.length; i += 100) {
          await upsert('gf_statements', unique.slice(i, i + 100), 'external_id');
        }
        await db(`gf_people?id=eq.${p.id}`, { method: 'PATCH', body: { hansard_synced_at: new Date().toISOString() } });
        summary.people++;
        summary.statements += unique.length;
      } catch (e) {
        summary.errors.push(`${p.full_name}: ${e.message}`);
      }
    }

    // Watches → Slack
    const watches = await db('gf_watches?select=id,topic,person_id');
    if (slot === 0 && watches.length && process.env.SLACK_WEBHOOK_URL) {
      // Everything filed since the last alert run (any slot, any manual sync), so nothing is missed or repeated.
      const [last] = await db('gf_sync_log?select=ran_at&job=eq.hansard-alerts&order=ran_at.desc&limit=1');
      const since = last ? last.ran_at : new Date(startedAt.getTime() - 24 * 3600 * 1000).toISOString();
      const until = new Date().toISOString();
      const site = (process.env.URL || '').replace(/\/$/, '');
      const lines = [];
      for (const w of watches) {
        const q = encodeURIComponent(w.topic);
        const personFilter = w.person_id ? `&person_id=eq.${w.person_id}` : '';
        const hits = await db(
          `gf_statements?select=id,said_on,source_url,quote,person_id,gf_people(full_name)&fts=wfts(english).${q}&created_at=gte.${encodeURIComponent(since)}&created_at=lt.${encodeURIComponent(until)}${personFilter}&order=said_on.desc&limit=5`
        );
        for (const h of hits) {
          const who = h.gf_people?.full_name || 'Unknown';
          const snippet = h.quote.replace(/\s+/g, ' ').slice(0, 180);
          lines.push(`• *${who}* on _${w.topic}_ (${h.said_on || 'undated'}): "${snippet}…" ${h.source_url ? `<${h.source_url}|Hansard>` : ''}${site ? ` · <${site}/#person/${h.person_id}|File>` : ''}`);
        }
      }
      await log('hansard-alerts', true, { since, until, matches: lines.length });
      if (lines.length) {
        await slack(`*GFILE: new matches for watched topics*\n${lines.slice(0, 25).join('\n')}${lines.length > 25 ? `\n…and ${lines.length - 25} more` : ''}`);
        summary.alerts = lines.length;
      }
    }

    await log('sync-hansard', summary.errors.length === 0, summary);
  } catch (e) {
    summary.errors.push(e.message);
    await log('sync-hansard', false, summary);
  }
  return new Response('ok');
};
