-- GFILE — Supabase schema
-- Run once in the Supabase SQL editor (same project as the Planner, so logins carry over).
-- All tables are prefixed gf_ so nothing clashes with planner tables.
-- After running: check in Table Editor that RLS is ON for every gf_ table.

create extension if not exists pg_trgm;

-- ───────────── People ─────────────
create table if not exists gf_people (
  id               uuid primary key default gen_random_uuid(),
  full_name        text not null,
  first_name       text,
  last_name        text,
  jurisdiction     text not null default 'federal',   -- federal | nsw | vic | qld | wa | sa | tas | act | nt
  chamber          text,                               -- house | senate | lower | upper | council | none
  status           text not null default 'sitting',    -- sitting | candidate | former
  electorate       text,                               -- seat, or state for senators, or LGA/ward for councillors
  state            text,
  party            text,
  offices          jsonb not null default '[]'::jsonb, -- ministerial / shadow roles
  photo_url        text,
  oa_person_id     text unique,                        -- OpenAustralia person id
  tvfy_id          text unique,                        -- They Vote For You person id
  rebellions       int,
  votes_attended   int,
  votes_possible   int,
  notes            text,
  hansard_synced_at timestamptz,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists gf_people_name_trgm on gf_people using gin (full_name gin_trgm_ops);
create index if not exists gf_people_filters on gf_people (jurisdiction, chamber, status);

-- ───────────── Statements (the core of the file) ─────────────
create table if not exists gf_statements (
  id            uuid primary key default gen_random_uuid(),
  person_id     uuid not null references gf_people(id) on delete cascade,
  said_on       date,
  source_type   text not null default 'other',  -- hansard | media | social | radio | podcast | video | document | other
  source_title  text,
  source_url    text,
  quote         text not null,
  context       text,
  topics        text[] not null default '{}',
  external_id   text unique,                    -- e.g. Hansard gid, so re-syncs don't duplicate
  verified      boolean not null default false, -- a reporter has checked it against the original
  added_by      uuid,
  created_at    timestamptz not null default now(),
  fts           tsvector generated always as (
                  to_tsvector('english', coalesce(quote,'') || ' ' || coalesce(context,'') || ' ' || coalesce(source_title,''))
                ) stored
);
create index if not exists gf_statements_fts on gf_statements using gin (fts);
create index if not exists gf_statements_person_date on gf_statements (person_id, said_on desc);
create index if not exists gf_statements_created on gf_statements (created_at desc);

-- ───────────── Voting records (They Vote For You policy scores) ─────────────
create table if not exists gf_policy_positions (
  id              uuid primary key default gen_random_uuid(),
  person_id       uuid not null references gf_people(id) on delete cascade,
  tvfy_policy_id  text not null,
  policy_name     text not null,
  policy_description text,
  agreement       numeric,      -- 0–100
  voted           boolean,
  updated_at      timestamptz not null default now(),
  unique (person_id, tvfy_policy_id)
);

-- ───────────── Money (AEC Transparency Register imports) ─────────────
create table if not exists gf_donations (
  id              uuid primary key default gen_random_uuid(),
  recipient_name  text not null,
  donor_name      text not null,
  amount          numeric,
  period          text,         -- financial or calendar year as given in the export
  return_type     text,
  receipt_type    text,
  received_on     date,
  person_id       uuid references gf_people(id) on delete set null,
  source          text not null default 'aec',
  row_hash        text unique,  -- stops the same export row importing twice
  imported_by     uuid,
  created_at      timestamptz not null default now()
);
create index if not exists gf_donations_recipient_trgm on gf_donations using gin (recipient_name gin_trgm_ops);
create index if not exists gf_donations_donor_trgm on gf_donations using gin (donor_name gin_trgm_ops);

-- ───────────── Declared interests (from registers, entered by reporters) ─────────────
create table if not exists gf_interests (
  id          uuid primary key default gen_random_uuid(),
  person_id   uuid not null references gf_people(id) on delete cascade,
  category    text not null,    -- shareholding | property | directorship | gift | travel | liability | other
  detail      text not null,
  source_url  text,
  declared_on date,
  added_by    uuid,
  created_at  timestamptz not null default now()
);

-- ───────────── Contradiction checks ─────────────
create table if not exists gf_checks (
  id            uuid primary key default gen_random_uuid(),
  person_id     uuid not null references gf_people(id) on delete cascade,
  topic         text not null,
  status        text not null default 'queued',  -- queued | running | done | error
  result        jsonb,
  error         text,
  requested_by  uuid not null default auth.uid(),
  created_at    timestamptz not null default now(),
  finished_at   timestamptz
);
create index if not exists gf_checks_user_day on gf_checks (requested_by, created_at desc);

-- ───────────── Watches (Slack alerts on new Hansard matches) ─────────────
create table if not exists gf_watches (
  id          uuid primary key default gen_random_uuid(),
  topic       text not null,
  person_id   uuid references gf_people(id) on delete cascade, -- null = anyone
  created_by  uuid not null default auth.uid(),
  created_at  timestamptz not null default now()
);

-- ───────────── Sync bookkeeping (service role only) ─────────────
create table if not exists gf_sync_log (
  id          bigserial primary key,
  job         text not null,
  ok          boolean not null,
  detail      jsonb,
  ran_at      timestamptz not null default now()
);

-- ───────────── Search helper ─────────────
create or replace function gf_search_statements(q text, p_person uuid default null, max_rows int default 50)
returns table (
  id uuid, person_id uuid, said_on date, source_type text, source_title text,
  source_url text, quote text, context text, topics text[], verified boolean, rank real
)
language sql stable
security invoker
as $$
  select s.id, s.person_id, s.said_on, s.source_type, s.source_title, s.source_url,
         s.quote, s.context, s.topics, s.verified,
         ts_rank(s.fts, websearch_to_tsquery('english', q)) as rank
  from gf_statements s
  where s.fts @@ websearch_to_tsquery('english', q)
    and (p_person is null or s.person_id = p_person)
  order by rank desc, s.said_on desc nulls last
  limit least(max_rows, 200);
$$;

-- Link an unlinked donation to a person (any signed-in user; can't overwrite an existing link)
create or replace function gf_link_donation(p_donation uuid, p_person uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  update gf_donations set person_id = p_person where id = p_donation and person_id is null;
  if not found then raise exception 'Already linked or not found'; end if;
end $$;
revoke all on function gf_link_donation(uuid, uuid) from public;
grant execute on function gf_link_donation(uuid, uuid) to authenticated;

-- ───────────── updated_at trigger ─────────────
create or replace function gf_touch() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists gf_people_touch on gf_people;
create trigger gf_people_touch before update on gf_people for each row execute function gf_touch();

-- ───────────── Row Level Security ─────────────
-- Any signed-in Gazette user can read everything and add to the record.
-- Edits/deletes are limited to the person who added the row.
-- Sync jobs use the service role key, which bypasses RLS.
alter table gf_people           enable row level security;
alter table gf_statements       enable row level security;
alter table gf_policy_positions enable row level security;
alter table gf_donations        enable row level security;
alter table gf_interests        enable row level security;
alter table gf_checks           enable row level security;
alter table gf_watches          enable row level security;
alter table gf_sync_log         enable row level security;

-- people
drop policy if exists gf_people_read on gf_people;
create policy gf_people_read on gf_people for select to authenticated using (true);
drop policy if exists gf_people_insert on gf_people;
create policy gf_people_insert on gf_people for insert to authenticated with check (created_by = auth.uid());
drop policy if exists gf_people_update on gf_people;
create policy gf_people_update on gf_people for update to authenticated
  using (created_by = auth.uid()) with check (created_by = auth.uid());

-- statements
drop policy if exists gf_statements_read on gf_statements;
create policy gf_statements_read on gf_statements for select to authenticated using (true);
drop policy if exists gf_statements_insert on gf_statements;
create policy gf_statements_insert on gf_statements for insert to authenticated
  with check (added_by = auth.uid() and source_type <> 'hansard');
drop policy if exists gf_statements_update on gf_statements;
create policy gf_statements_update on gf_statements for update to authenticated
  using (added_by = auth.uid()) with check (added_by = auth.uid());
drop policy if exists gf_statements_delete on gf_statements;
create policy gf_statements_delete on gf_statements for delete to authenticated using (added_by = auth.uid());

-- policy positions: read only (sync writes them)
drop policy if exists gf_policy_read on gf_policy_positions;
create policy gf_policy_read on gf_policy_positions for select to authenticated using (true);

-- donations
drop policy if exists gf_donations_read on gf_donations;
create policy gf_donations_read on gf_donations for select to authenticated using (true);
drop policy if exists gf_donations_insert on gf_donations;
create policy gf_donations_insert on gf_donations for insert to authenticated with check (imported_by = auth.uid());
drop policy if exists gf_donations_delete on gf_donations;
create policy gf_donations_delete on gf_donations for delete to authenticated using (imported_by = auth.uid());

-- interests
drop policy if exists gf_interests_read on gf_interests;
create policy gf_interests_read on gf_interests for select to authenticated using (true);
drop policy if exists gf_interests_insert on gf_interests;
create policy gf_interests_insert on gf_interests for insert to authenticated with check (added_by = auth.uid());
drop policy if exists gf_interests_delete on gf_interests;
create policy gf_interests_delete on gf_interests for delete to authenticated using (added_by = auth.uid());

-- checks: everyone can see results; you can only queue checks as yourself
drop policy if exists gf_checks_read on gf_checks;
create policy gf_checks_read on gf_checks for select to authenticated using (true);
drop policy if exists gf_checks_insert on gf_checks;
create policy gf_checks_insert on gf_checks for insert to authenticated
  with check (requested_by = auth.uid() and status = 'queued' and result is null);

-- watches
drop policy if exists gf_watches_read on gf_watches;
create policy gf_watches_read on gf_watches for select to authenticated using (true);
drop policy if exists gf_watches_insert on gf_watches;
create policy gf_watches_insert on gf_watches for insert to authenticated with check (created_by = auth.uid());
drop policy if exists gf_watches_delete on gf_watches;
create policy gf_watches_delete on gf_watches for delete to authenticated using (created_by = auth.uid());

-- sync log: readable so the Admin tab can show when jobs last ran; only the service role writes
drop policy if exists gf_sync_log_read on gf_sync_log;
create policy gf_sync_log_read on gf_sync_log for select to authenticated using (true);

-- ═════════════════════════ v2: state parliaments, councils, old media ═════════════════════════

alter table gf_people add column if not exists wikidata_id text unique;
alter table gf_people add column if not exists council text;              -- LGA name for councillors
alter table gf_people add column if not exists ward text;
alter table gf_people add column if not exists aliases text[] not null default '{}';  -- maiden names, nicknames, old titles
alter table gf_people add column if not exists handles jsonb not null default '{}'::jsonb; -- {"twitter":"...","facebook":"...","instagram":"..."}
alter table gf_people add column if not exists old_urls text[] not null default '{}'; -- old personal / campaign / business websites
create index if not exists gf_people_council on gf_people (council);

-- Where documents come from: a parliament's Hansard, a council's minutes page, or a list of URLs
create table if not exists gf_sources (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  kind          text not null check (kind in ('nsw_hansard_api','listing_page','url_list')),
  doc_type      text not null check (doc_type in ('hansard','minutes')),
  jurisdiction  text not null,                 -- nsw | vic | ... | local
  council       text,                          -- for minutes: must match gf_people.council
  config        jsonb not null default '{}'::jsonb,
  enabled       boolean not null default true,
  created_by    uuid default auth.uid(),
  last_run_at   timestamptz,
  last_result   jsonb,
  created_at    timestamptz not null default now()
);

create table if not exists gf_documents (
  id          uuid primary key default gen_random_uuid(),
  source_id   uuid references gf_sources(id) on delete cascade,
  url         text not null unique,
  title       text,
  doc_date    date,
  chamber     text,
  status      text not null default 'new',     -- new | parsed | error | skipped
  error       text,
  segments    int,
  matched     int,
  created_at  timestamptz not null default now(),
  parsed_at   timestamptz
);
create index if not exists gf_documents_status on gf_documents (status, created_at);

-- What councillors did in meetings (from minutes)
create table if not exists gf_council_actions (
  id            uuid primary key default gen_random_uuid(),
  person_id     uuid not null references gf_people(id) on delete cascade,
  document_id   uuid references gf_documents(id) on delete cascade,
  council       text,
  meeting_date  date,
  item          text,
  action        text not null,   -- moved | seconded | voted_for | voted_against | declared_interest
  detail        text,
  source_url    text,
  external_id   text unique,
  created_at    timestamptz not null default now()
);
create index if not exists gf_council_actions_person on gf_council_actions (person_id, meeting_date desc);

-- Old media deep scans and the leads they turn up
create table if not exists gf_scans (
  id            uuid primary key default gen_random_uuid(),
  person_id     uuid not null references gf_people(id) on delete cascade,
  before_year   int,
  status        text not null default 'queued',  -- queued | running | done | error
  summary       jsonb,
  error         text,
  requested_by  uuid not null default auth.uid(),
  created_at    timestamptz not null default now(),
  finished_at   timestamptz
);

create table if not exists gf_leads (
  id            uuid primary key default gen_random_uuid(),
  scan_id       uuid references gf_scans(id) on delete set null,
  person_id     uuid not null references gf_people(id) on delete cascade,
  kind          text not null,      -- web | tweet | archive | video | trove
  url           text not null,
  archive_url   text,
  title         text,
  outlet        text,
  published_on  date,
  year          int,
  snippet       text,
  quotes        jsonb not null default '[]'::jsonb,  -- [{ "text": "...", "verified": true }]
  status        text not null default 'new',         -- new | kept | dismissed
  reviewed_by   uuid,
  created_at    timestamptz not null default now(),
  unique (person_id, url)
);
create index if not exists gf_leads_person on gf_leads (person_id, status, year);

create table if not exists gf_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

alter table gf_sources          enable row level security;
alter table gf_documents        enable row level security;
alter table gf_council_actions  enable row level security;
alter table gf_scans            enable row level security;
alter table gf_leads            enable row level security;
alter table gf_settings         enable row level security;

drop policy if exists gf_sources_read on gf_sources;
create policy gf_sources_read on gf_sources for select to authenticated using (true);
drop policy if exists gf_sources_insert on gf_sources;
create policy gf_sources_insert on gf_sources for insert to authenticated with check (created_by = auth.uid());
drop policy if exists gf_sources_update on gf_sources;
create policy gf_sources_update on gf_sources for update to authenticated using (created_by = auth.uid()) with check (created_by = auth.uid());
drop policy if exists gf_sources_delete on gf_sources;
create policy gf_sources_delete on gf_sources for delete to authenticated using (created_by = auth.uid());

drop policy if exists gf_documents_read on gf_documents;
create policy gf_documents_read on gf_documents for select to authenticated using (true);
drop policy if exists gf_council_actions_read on gf_council_actions;
create policy gf_council_actions_read on gf_council_actions for select to authenticated using (true);

drop policy if exists gf_scans_read on gf_scans;
create policy gf_scans_read on gf_scans for select to authenticated using (true);
drop policy if exists gf_scans_insert on gf_scans;
create policy gf_scans_insert on gf_scans for insert to authenticated
  with check (requested_by = auth.uid() and status = 'queued' and summary is null);

drop policy if exists gf_leads_read on gf_leads;
create policy gf_leads_read on gf_leads for select to authenticated using (true);
-- reporters triage leads (keep / dismiss) but can't rewrite what was found
create or replace function gf_review_lead(p_lead uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if p_status not in ('new','kept','dismissed') then raise exception 'Bad status'; end if;
  update gf_leads set status = p_status, reviewed_by = auth.uid() where id = p_lead;
end $$;
revoke all on function gf_review_lead(uuid, text) from public;
grant execute on function gf_review_lead(uuid, text) to authenticated;

drop policy if exists gf_settings_read on gf_settings;
create policy gf_settings_read on gf_settings for select to authenticated using (true);
drop policy if exists gf_settings_write on gf_settings;
create policy gf_settings_write on gf_settings for insert to authenticated with check (true);
drop policy if exists gf_settings_update on gf_settings;
create policy gf_settings_update on gf_settings for update to authenticated using (true) with check (true);

-- Reporters can fill in aliases/handles/old sites on anyone (helps the old-media scan),
-- without being able to change synced fields.
create or replace function gf_update_person_research(p_person uuid, p_aliases text[], p_handles jsonb, p_old_urls text[], p_notes text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  update gf_people set aliases = coalesce(p_aliases, '{}'), handles = coalesce(p_handles, '{}'::jsonb),
         old_urls = coalesce(p_old_urls, '{}'), notes = p_notes
  where id = p_person;
end $$;
revoke all on function gf_update_person_research(uuid, text[], jsonb, text[], text) from public;
grant execute on function gf_update_person_research(uuid, text[], jsonb, text[], text) to authenticated;

-- Re-read a source's documents (e.g. after adding missing councillors)
create or replace function gf_requeue_documents(p_source uuid, p_only_unmatched boolean default true)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  update gf_documents set status = 'new', error = null
  where source_id = p_source and status in ('parsed','error')
    and (not p_only_unmatched or error is not null);
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function gf_requeue_documents(uuid, boolean) from public;
grant execute on function gf_requeue_documents(uuid, boolean) to authenticated;
