// Nightly at ~2:10am Sydney: refresh federal + state members, top up federal Hansard,
// and collect new state Hansard / council minutes documents.
export const config = { schedule: '10 15 * * *' }; // 15:10 UTC

export default async () => {
  const site = (process.env.URL || '').replace(/\/$/, '');
  const headers = { 'x-cron-secret': process.env.CRON_SECRET || '' };
  if (!site || !process.env.CRON_SECRET) return new Response('URL or CRON_SECRET missing');
  const call = (fn, opts = {}) => fetch(`${site}/.netlify/functions/${fn}`, { method: 'POST', headers, ...opts });
  // Background functions return 202 immediately.
  await call('sync-people-background');
  await call('sync-state-members-background');
  // Three non-overlapping federal Hansard batches; slot 0 also sends Watch alerts.
  for (const slot of [1, 2, 0]) await call(`sync-hansard-background?slot=${slot}`);
  await call('ingest-background');
  return new Response('triggered');
};
