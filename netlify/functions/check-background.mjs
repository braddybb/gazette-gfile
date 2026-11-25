// Contradiction check: compares everything on file for one person on one topic and
// flags reversals, shifts and say/vote gaps. The model only returns statement IDs —
// every quote shown to reporters comes straight from the database, never from the model.
import { db, requireUser, env, isUnlimited } from '../lib/gfile.mjs';

const CAP = Number(process.env.CHECK_DAILY_CAP || 15);
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const MAX_STATEMENTS = 40;

const SYSTEM = `You are a research assistant on a political accountability desk at an Australian news organisation.
You will be given statements one politician has made (each with an ID, date and source) and, where available, their voting record on related policies.
Your job is to map how their stated position on the topic has changed over time and flag genuine tensions.

Rules:
- Use only the material provided. Never rely on outside knowledge about the person.
- Refer to statements only by their ID. Do not quote or paraphrase text that is not in the material.
- A tension needs two specific items that are hard to reconcile. Changing emphasis, new circumstances, or speaking for a party line are not reversals — call them shifts and say why.
- For each tension, state what extra context a reporter must check before publishing (e.g. the full speech, what the policy actually was at the time, whether the person was quoting someone else).
- Australian defamation law applies: be precise and conservative. If the evidence is thin, say "insufficient_evidence".
- Hansard speeches often quote opponents or read out constituents' letters. Watch for that and don't attribute those views to the speaker.
Always answer by calling the record_findings tool.`;

const TOOL = {
  name: 'record_findings',
  description: 'Record the analysis of this politician\'s position on the topic.',
  input_schema: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['clear_reversal', 'shift', 'consistent', 'insufficient_evidence'] },
      summary: { type: 'string', description: 'Two or three plain sentences a reporter can read first.' },
      timeline: {
        type: 'array',
        description: 'Their position in each period, oldest first.',
        items: {
          type: 'object',
          properties: {
            period: { type: 'string' },
            position: { type: 'string' },
            statement_ids: { type: 'array', items: { type: 'string' } },
          },
          required: ['period', 'position', 'statement_ids'],
        },
      },
      tensions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['reversal', 'shift', 'inconsistency', 'said_vs_voted'] },
            earlier_id: { type: 'string', description: 'Statement ID, or policy:<id> for a voting record' },
            later_id: { type: 'string', description: 'Statement ID, or policy:<id> for a voting record' },
            explanation: { type: 'string' },
            check_before_publishing: { type: 'string' },
            strength: { type: 'string', enum: ['strong', 'moderate', 'weak'] },
          },
          required: ['kind', 'earlier_id', 'later_id', 'explanation', 'check_before_publishing', 'strength'],
        },
      },
      story_angle: { type: 'string', description: 'One-line angle if there is a story, otherwise empty.' },
    },
    required: ['verdict', 'summary', 'timeline', 'tensions'],
  },
};

const words = (topic) =>
  topic.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2);

// Long Hansard speeches: send the part around the topic, not the whole thing.
function excerpt(text, ws, width = 1400) {
  if (text.length <= width) return text;
  const lower = text.toLowerCase();
  let at = -1;
  for (const w of ws) { const i = lower.indexOf(w); if (i !== -1 && (at === -1 || i < at)) at = i; }
  if (at === -1) return text.slice(0, width) + ' […]';
  const start = Math.max(0, at - width / 3);
  return (start > 0 ? '[…] ' : '') + text.slice(start, start + width) + ' […]';
}

async function fail(id, msg) {
  await db(`gf_checks?id=eq.${id}`, { method: 'PATCH', body: { status: 'error', error: msg, finished_at: new Date().toISOString() } });
}

export default async (req) => {
  const user = await requireUser(req);
  if (!user) return new Response('Unauthorised', { status: 401 });
  let body = {};
  try { body = await req.json(); } catch (_) {}
  const checkId = String(body.check_id || '');
  if (!/^[0-9a-f-]{36}$/i.test(checkId)) return new Response('Bad check id', { status: 400 });

  const [check] = await db(`gf_checks?id=eq.${checkId}&select=*`);
  if (!check || check.requested_by !== user.id || check.status !== 'queued') return new Response('Not found', { status: 404 });

  try {
    // Daily cap per reporter
    const dayStart = new Date(); dayStart.setUTCHours(dayStart.getUTCHours() - 24);
    const recent = await db(`gf_checks?select=id&requested_by=eq.${user.id}&status=in.(running,done)&created_at=gte.${dayStart.toISOString()}`);
    if (!isUnlimited(user) && recent.length >= CAP) return await fail(checkId, `Daily limit of ${CAP} checks reached. Try again tomorrow.`), new Response('capped');

    await db(`gf_checks?id=eq.${checkId}`, { method: 'PATCH', body: { status: 'running' } });

    const [person] = await db(`gf_people?id=eq.${check.person_id}&select=full_name,party,chamber,electorate,offices`);
    const ws = words(check.topic);
    if (!ws.length) return await fail(checkId, 'Topic needs at least one real word.'), new Response('bad topic');

    const found = await db('rpc/gf_search_statements', {
      method: 'POST',
      body: { q: ws.join(' or '), p_person: check.person_id, max_rows: MAX_STATEMENTS },
    });
    if (found.length < 2) {
      await db(`gf_checks?id=eq.${checkId}`, {
        method: 'PATCH',
        body: {
          status: 'done', finished_at: new Date().toISOString(),
          result: { verdict: 'insufficient_evidence', summary: `Only ${found.length} statement${found.length === 1 ? '' : 's'} on file about "${check.topic}". Capture more (interviews, socials, old media) or run a live Hansard search, then try again.`, timeline: [], tensions: [], used_ids: found.map(f => f.id) },
        },
      });
      return new Response('thin');
    }

    // Related voting records (They Vote For You policy names)
    const orFilter = ws.map(w => `policy_name.ilike.*${encodeURIComponent(w)}*`).join(',');
    const votes = await db(`gf_policy_positions?person_id=eq.${check.person_id}&voted=eq.true&or=(${orFilter})&select=tvfy_policy_id,policy_name,policy_description,agreement&limit=15`);

    const sorted = [...found].sort((a, b) => String(a.said_on || '').localeCompare(String(b.said_on || '')));
    const material = [
      `POLITICIAN: ${person.full_name} (${person.party || 'party unknown'}, ${person.chamber || ''} ${person.electorate || ''})`,
      `TOPIC: ${check.topic}`,
      '',
      'STATEMENTS (oldest first):',
      ...sorted.map(s => `[${s.id}] ${s.said_on || 'undated'} · ${s.source_type}${s.source_title ? ` · ${s.source_title}` : ''}${s.verified ? ' · verified' : ''}\n${excerpt(s.quote, ws)}${s.context ? `\nContext note: ${s.context}` : ''}`),
      '',
      votes.length ? 'VOTING RECORD (They Vote For You agreement score, 0 = always voted against the policy, 100 = always for):' : 'VOTING RECORD: none matched this topic.',
      ...votes.map(v => `[policy:${v.tvfy_policy_id}] "${v.policy_name}" — ${v.policy_description || ''} — agreement ${v.agreement}%`),
    ].join('\n\n');

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env('ANTHROPIC_API_KEY'),
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
        system: SYSTEM,
        tools: [TOOL],
        tool_choice: { type: 'tool', name: 'record_findings' },
        messages: [{ role: 'user', content: material }],
      }),
    });
    if (!res.ok) return await fail(checkId, `AI service error ${res.status}: ${(await res.text()).slice(0, 300)}`), new Response('ai error');
    const out = await res.json();
    const call = (out.content || []).find(c => c.type === 'tool_use');
    if (!call) return await fail(checkId, 'AI returned no findings.'), new Response('no findings');

    // Drop anything pointing at IDs we didn't supply
    const validIds = new Set([...found.map(f => f.id), ...votes.map(v => `policy:${v.tvfy_policy_id}`)]);
    const r = call.input;
    r.timeline = (r.timeline || []).map(t => ({ ...t, statement_ids: (t.statement_ids || []).filter(id => validIds.has(id)) }));
    const before = (r.tensions || []).length;
    r.tensions = (r.tensions || []).filter(t => validIds.has(t.earlier_id) && validIds.has(t.later_id));
    r.dropped_invalid = before - r.tensions.length;
    r.used_ids = found.map(f => f.id);
    r.votes = votes;
    r.model = MODEL;

    await db(`gf_checks?id=eq.${checkId}`, { method: 'PATCH', body: { status: 'done', result: r, finished_at: new Date().toISOString() } });
  } catch (e) {
    await fail(checkId, e.message);
  }
  return new Response('ok');
};
