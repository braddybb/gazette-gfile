# GFILE

Gazette's political accountability tool. It tracks what politicians have said, how they voted, what they've declared and who funds them, across federal and state parliaments and local councils. It also digs up old media appearances.

## What it covers

| | How it gets there |
|---|---|
| Federal MPs and senators | Synced nightly (OpenAustralia) |
| Federal Hansard | Synced nightly (OpenAustralia), plus live search |
| Federal voting records | Synced nightly (They Vote For You) |
| State and territory MPs (all eight) | Synced nightly from Wikidata: name, seat, party, photo |
| NSW Hansard, 1991 to now | Automatic through the NSW Parliament API (Admin → Sources) |
| Other state Hansards | Add each parliament's Hansard listing page as a source |
| Councillors | Import a CSV, or add them one at a time |
| Council minutes | Add each council's minutes page as a source. GFILE records who moved, seconded and voted, and who declared interests |
| Old media | Deep scan per person: web search for old interviews, transcripts, op-eds, profiles and student media; archived tweets and old websites from the Wayback Machine; YouTube; Trove |
| Donations | Import AEC or state commission CSVs |
| Interests | Reporters enter them from the registers |

## Setup

1. **Free API keys**
   - OpenAustralia: openaustralia.org.au/api/key
   - They Vote For You: theyvoteforyou.org.au, sign up, then go to API
   - YouTube (optional): Google Cloud Console → enable "YouTube Data API v3" → create an API key
   - Trove (optional): trove.nla.gov.au/about/create-something/using-api
2. **Anthropic web search:** in the Anthropic Console, check that web search is allowed for your organisation (Settings → Privacy). The old-media scan needs it.
3. **Supabase:** use the same project as the Planner. In SQL Editor, run `supabase/schema.sql`. You can safely run it again after updates. Then check in Table Editor that RLS is **on** for every `gf_` table.
4. **GitHub:** create a new repo, `gazette-gfile`, and upload this folder as is, including `package.json`. Netlify installs the PDF reader from it.
5. **index.html:** paste `SUPABASE_URL` and `SUPABASE_ANON_KEY` at the top.
6. **Netlify:** create a new site from the repo, then add these environment variables:

| Variable | |
|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | same as the Planner |
| `SUPABASE_SERVICE_ROLE_KEY` | server only; never put it in index.html |
| `OPENAUSTRALIA_KEY`, `TVFY_KEY` | step 1 |
| `ANTHROPIC_API_KEY` | same as GARI's |
| `CRON_SECRET` | any long random string |
| `YOUTUBE_API_KEY`, `TROVE_API_KEY` | optional (step 1) |
| `SLACK_WEBHOOK_URL` | optional, for Watch alerts |
| `CHECK_DAILY_CAP` | optional, contradiction checks per reporter per day (default 15) |
| `SCAN_DAILY_CAP` | optional, deep scans per reporter per day (default 5) |
| `ANTHROPIC_MODEL`, `QUOTE_MODEL` | optional (defaults `claude-sonnet-5-5`, `claude-haiku-5-5`) |
| `DOCS_PER_RUN` | optional, documents read per collector run (default 25) |

## First run (Admin tab)

1. Press **Federal members & votes** and **State & territory members**. Wait about 5 minutes, then check **Recent jobs**. The state sync lists each chamber with members found against the number of seats. If a chamber says "not found", paste its Wikidata ID in the Wikidata section at the bottom of Admin.
2. Press **Federal Hansard batch** 4 times, about a minute apart.
3. **+ Add a source → NSW Hansard.** Choose how far back to go (2007 by default). It collects about 25 sitting days a night, so a deep backfill takes a few weeks. Raise `DOCS_PER_RUN` to go faster.
4. **Councils:** import councillors by CSV first, with the council name spelled exactly as you'll use it. Then **+ Add a source → Council minutes page**. For councils on InfoCouncil, use their `xxx.infocouncil.biz` page. If names show up as "Not matched to anyone on file" under Documents, add those people, then press **Re-read**.
5. **Other state Hansards:** add the parliament's page that lists daily Hansard PDFs. If it needs a click through year pages, set "Also open sub-pages matching" under Advanced.

## Old media scan (person → Old media)

- Fill in **Research details** first: old Twitter handle, old websites, other names (maiden names, nicknames) and background (old jobs, uni, unions). They make a big difference.
- **Run deep scan** (defaults to before 2013). It takes 2–5 minutes and costs roughly 10–30c in AI and search fees.
- **How quotes are checked:** the AI suggests quotes, but GFILE keeps one only if its exact words appear in the page text. Anything else is thrown out and counted in the summary. Archived tweets come straight from the archived page.
- **Leads:** keep or dismiss each one. Press **File this quote** to put it on the person's record. Leads without quotes, such as videos, old sites and Trove articles, need a human to watch or read them. Use **Capture manually**.

## Limits worth knowing

- **Scanned PDFs:** pages that are images rather than text can't be read. These show up as failed under Documents.
- **Name matching:** it works on surname, seat and first name. Two councillors on one council with the same surname won't be matched; they're listed as unmatched instead.
- **What minutes record:** motions and votes, not speeches. A motion a councillor moved goes on their record with a note that moving a motion isn't always personal support.
- **State voting records:** state division lists aren't collected yet.
- **Facebook:** stays manual, through Capture.
