# Monitoring dashboard on Vercel

This standalone static website reads monitoring data from Supabase. The scraper
continues running on Ubuntu; the ingestion Edge Function stays on Supabase.

## Deploy

1. Push this folder to a Git repository, or use the existing repository.
2. Import the repository in Vercel. Set **Root Directory** to
   `docs/google-maps-standalone/monitoring` (or `.` if this folder is its own repository).
3. Set these Vercel environment variables for Production, and Preview if needed:
   - `SUPABASE_URL`: `https://YOUR_PROJECT_REF.supabase.co`
   - `SUPABASE_PUBLISHABLE_KEY`: your public Supabase publishable key or legacy anon key.
4. Deploy. The included `vercel.json` selects Other, runs `node build.mjs`, and
   serves `dist`. No npm dependencies or manual `config.js` are needed.
5. Open the deployment URL. No sign-in is required.

The dashboard is read-only and public under the existing optional public-read
configuration. Apply `0001_google_scraper_monitoring.sql` and
`0003_monitoring_state_snapshots.sql` before deploying the updated worker,
Edge Function and dashboard, and `0004_monitoring_activity.sql` before
deploying this dashboard: the Overview charts read its
`monitoring_activity` function. Until it is applied, those charts show
"Activity data is unavailable" while the queue, coverage and worker cards
keep working. Apply `0002_public_read_monitoring.sql` only if
public access is intended; it grants the `anon`
role SELECT on the five monitoring tables and the read RPCs (its revert
statements are in a comment at the bottom). `0002` and `0004` can be applied
in either order. Worker setup must already be
configured. Anyone with the URL can read worker IDs, place evidence, and logs,
so keep sensitive data out of event payloads. Worker credentials and ingestion
stay closed to `anon`.

## Language

The dashboard is Thai by default. The **EN / ไทย** button in the header switches
language; the choice is stored in `localStorage` (`lang`) and the page reloads.
Thai is the source language: every string is passed through `t("ข้อความไทย")`
and `i18n.js` holds the English catalog (static `index.html` text is translated
from the same catalog). Add new UI text to that catalog as well.

The UI uses white cards with thin borders and one indigo accent (`#4F46E5`
for actions, `#EEEFFF` for chips). Charts use a single indigo ramp: five
ordered steps for the inspection-time donut and lighter steps for the
heatmap. Place coverage uses four distinct hues plus grey. It follows the
system light/dark preference and has a manual theme toggle that remembers
your choice. The adjacent loop button switches dark/light themes every 250 ms;
press it again to stop on the current theme. Looping does not overwrite your
saved theme preference. Good, warning and error colors remain distinct for operational
status, and every change indicator also carries an arrow and a sign.

The filter bar under the tabs holds the date range (Overview only) and the
worker selector, which applies across all sections. On Places and Logs, select
**Apply filters** to use edited filters; **Reset filters** clears the filters in
that section while keeping the selected worker. Log date filters use the
browser's local time. Tables can scroll horizontally on smaller screens.

## Export place monitoring data

On **Places**, select **Export monitoring CSV** to download the full monitoring
records for the selected worker and applied place filters, across all pages.
Apply edited filters before exporting. The button captures the worker and filters
when clicked, so later changes do not alter an export already in progress. If
no rows match, nothing is downloaded. If a request fails, the result count
changes, or duplicate rows are detected, the export stops without downloading a
partial file; retry it. Each page is a separate read, not a transaction: updates
can still produce a mixed-time result, and changes that preserve the count may
not be detected. Large exports are held in browser memory. Upload delays can
also mean the monitoring data is behind the worker.

This file is a **raw monitoring snapshot**, intended for a database staging
table. It can contain pending, unmatched, failed, or unapproved suggestions,
raw candidates and phone numbers that the scraper's eligibility checks would
exclude or suppress. Do not treat `google_proposal` or `candidates` as accepted
contact data. The file does not include the complete attempt history, logs, or
worker records. The same OSM ID can appear for multiple workers.

The dashboard CSV is **not** the `google-maps-standalone/v1` JSONL format used
by `python -m server.manage google-maps import-results`. For that existing
backend importer, generate `results.jsonl` on the scraper machine with
`python -m google_scraper export results.jsonl`, then use the documented
[preview and import workflow](../README.md#import-run-and-export). Monitoring
snapshots do not contain all the information needed to reproduce its validation.

### CSV structure

The header uses the `public.monitoring_place_results` column names, in this
order. There is one row per `(worker_id, osm_id)`.

| Column | PostgreSQL type | Meaning |
| --- | --- | --- |
| `worker_id` | `uuid` | Worker that reported the place; part of the key. |
| `osm_id` | `text` | OSM identity, e.g. `node/123`; part of the key. |
| `source_record` | `jsonb` | Source place fields, typically name, coordinates, province, district and aliases. |
| `queue_status` | `text` | Most recently reported queue state. |
| `outcome` | `text`, nullable | Most recently reported result, e.g. `found`, `ambiguous` or `not_found`. |
| `google_proposal` | `jsonb`, nullable | Latest proposal or pending suggestion; fields vary and are not necessarily approved. |
| `candidates` | `jsonb` | Array of raw Google candidates; candidate fields vary. |
| `matching_method` | `text`, nullable | Reported matching method. |
| `similarity`, `distance_m` | `double precision`, nullable | Matching score and distance in metres. |
| `review_flag` | `boolean` | Whether the reported result is flagged for review. |
| `latest_error_code`, `latest_error_message` | `text`, nullable | Latest reported error, if any. |
| `latest_attempt_id` | `uuid`, nullable | Most recently reported attempt ID; the attempt itself is not exported. |
| `checked_at`, `worker_updated_at` | `timestamptz`, nullable | Worker-reported check and update times. |
| `received_at` | `timestamptz` | Time Supabase received the latest snapshot. |
| `last_sequence` | `bigint` | Latest worker event sequence applied to this row. |

The file is UTF-8 CSV with a header and CRLF record endings. All non-null
fields are quoted, quotes are doubled, and nested JSON values are serialized
as JSON text inside their CSV fields. An unquoted empty field means SQL NULL;
`""` means an empty string. PostgreSQL's default CSV NULL handling preserves
this distinction. PostgREST represents both SQL NULL and a JSON `null` value as
JSON null, so a JSON `null` in `google_proposal` is exported as SQL NULL.
Strings are not modified for spreadsheet safety: do not open untrusted data in
a spreadsheet that executes formulas. Leading `+` in phone numbers and other
source characters are preserved for database import.

Browser JSON parsing uses JavaScript numbers; integers outside the safe range
cause an error instead of a download, while high-precision fractional JSON
numbers may be rounded. If exact numeric precision or a transactionally
consistent backup is required, export directly from the database instead.

For example, in `psql`, create a staging table and load the downloaded file:

```sql
CREATE TABLE monitoring_places_stage (
  worker_id uuid NOT NULL,
  osm_id text NOT NULL,
  source_record jsonb NOT NULL,
  queue_status text NOT NULL,
  outcome text,
  google_proposal jsonb,
  candidates jsonb NOT NULL,
  matching_method text,
  similarity double precision,
  distance_m double precision,
  review_flag boolean NOT NULL,
  latest_error_code text,
  latest_error_message text,
  latest_attempt_id uuid,
  checked_at timestamptz,
  worker_updated_at timestamptz,
  received_at timestamptz NOT NULL,
  last_sequence bigint NOT NULL,
  PRIMARY KEY (worker_id, osm_id)
);
\copy monitoring_places_stage FROM '/path/to/monitoring-places.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')
```

Replace the path with the downloaded filename. `\copy` reads from the machine
running `psql`; it is a `psql` command, not SQL for the Supabase editor. Use an
empty staging table or handle duplicate keys before importing the same data
again. Validate and transform staged rows for the destination database's schema
and acceptance rules.

The visible dashboard refreshes every five minutes; the refresh button, filters,
pagination, and worker selection update immediately. Polling pauses in hidden
tabs. Place lists and collapsed log and attempt details transfer only their
summary fields; full evidence loads when opened. Loaded log and attempt details
are cached in memory until the page is closed or reloaded. Searches containing
special characters use the existing full-place search to preserve its behavior.

## Overview metrics

The Overview follows the date range in the filter bar: **24 hours**, **7 days**
(default) or **30 days**. 24 hours is a rolling window drawn as hourly points.
7 and 30 days cover today plus the earlier 6 or 29 calendar days, drawn as daily
points. The arrows step back and forward by whole periods. Days, weekdays and
hours use the browser's local time; attempts are placed by the worker's
completion timestamp.

Every figure with an arrow is compared with the period of equal length
immediately before the selected one. For the current period that is the same
elapsed time, not a whole calendar period, so a part-finished day is compared
with an equally long stretch. Counts show the difference, the success rate
shows percentage points, and inspection time shows seconds. The arrow and sign
give the direction; the colour says whether that direction is good.

- **Key metrics.** Completed attempts; success rate (`found` plus
  `found_no_phone` divided by all completed attempts); average inspection time
  (worker start to completion, excluding queue time, over attempts with both
  timestamps). Rates without attempts are shown as unavailable, not zero.
- **Activity over time.** One line for the chosen metric: completed attempts,
  matched, success rate, lookup errors or average inspection time. **Show
  previous period** adds the comparison period as a dashed line. Hover, tap or
  use the arrow keys on the chart for exact values; **Show as table** lists
  them.
- **Busiest times.** Completed attempts by weekday and hour of day.
- **Inspection time.** Share of timed attempts under 10 s, 10–20 s, 20–30 s,
  30–60 s, and 1 min or more, with the average in the centre.
- **Errors and blocks.** Lookup errors (`lookup_error` outcomes); CAPTCHA /
  blocks (`BLOCKED` errors) with consent-required errors shown separately; the
  retry rate (attempts marked `retry_wait` with outcome `lookup_error`, divided
  by all completed attempts, so scheduled rechecks after a non-error result are
  excluded); and the five most frequent error codes.

Three cards ignore the date range and always show the most recently uploaded
snapshots:

- **Queue snapshot.** The total includes both `pending` and `retry_wait`,
  including rechecks that may not be due yet. For the current period it adds a
  rough estimate of how long pending places would take at the period's pace.
  Attempts include rechecks, so treat it as a lower bound.
- **Place coverage.** The latest outcome of every place: found, found without a
  phone, ambiguous, not found, and no result yet (never checked, or the last
  check ended in an error).
- **Workers.** A recent worker heartbeat means one was received within ten
  minutes, and a pause reason is the last reported value. With five-minute
  refreshes, a stopped worker can take about 10–15 minutes after its last
  heartbeat to appear as not reporting. Resume and exit snapshots update that
  state in worker sequence order; historical exits remain visible separately.
  The usage bar compares the reported daily usage with the daily limit.

Upload delays can make all of these lag behind the worker.

Each refresh makes two requests: `monitoring_overview` for the snapshots and
`monitoring_activity` for the selected range. The second returns hourly totals
for the range and its comparison period (at most 31 days each), not attempt
records, and uses the `monitoring_attempts_completed` index. Changing the chart
metric or the comparison line does not issue a request. The two requests are
separate reads, so figures can briefly differ while new uploads arrive. Hours
are numbered from the start of the range the browser sends, so the local-time
charts are exact in any time zone.

Each place's attempt history shows the time from the worker starting an attempt
to completing it, excluding queue time. Durations are unavailable when either
timestamp is missing or invalid, or the completion time precedes the start.
The Places chart compares the latest recorded attempt for each place on the
current page, longest first, and counts places without a usable duration.
Imported snapshots and running attempts may not yet have timing records. The
dashboard batches timing reads for the visible page and caches completed
attempt timings in memory, so unchanged attempts are not downloaded again on
each refresh.

Places with a pending nearest-match suggestion show **Suggested nearest match —
awaiting review** and the suggestion UUID in their details. These suggestions
are excluded from normal scraper exports until approved on the scraper server,
but are included in the raw monitoring CSV. The dashboard remains read-only.
Monitoring updates can lag while uploads are queued.

Both environment values become public browser configuration. Never supply a
worker token, Supabase secret key, or service-role key. The build rejects secret
and service-role keys. Database RLS controls access to the monitoring data.
Environment changes require a redeployment. Only files in `dist` are published.

## Local use

For the original no-build workflow, copy `config.example.js` to `config.js`, fill
in its public settings, and serve this folder with `python3 -m http.server 8080`.

To try the Vercel build locally, set the two environment variables above, run
`node build.mjs`, then `python3 -m http.server 8080 --directory dist`.

## Browser tests

The dashboard tests use pytest and Playwright with Chromium. They use simulated
monitoring data and block network requests; no Supabase account is needed.

```sh
python -m pip install 'pytest>=8,<10' 'playwright>=1.48,<2'
python -m playwright install chromium
python -m pytest -q tests/test_dashboard.py
```
