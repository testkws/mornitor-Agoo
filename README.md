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
Edge Function and dashboard. Apply `0002_public_read_monitoring.sql` only if
public access is intended; it grants the `anon`
role SELECT on the five monitoring tables and the two read RPCs; its revert
statements are in a comment at the bottom). Worker setup must already be
configured. Anyone with the URL can read worker IDs, place evidence, and logs,
so keep sensitive data out of event payloads. Worker credentials and ingestion
stay closed to `anon`.

The UI uses charcoal (`#4A4A4A`), cool gray (`#CBCBCB`), soft ivory (`#FFFFE3`),
and slate (`#6D8196`). It follows the system light/dark preference and has a
manual theme toggle that remembers your choice. The dark palette carries the
same understated character, while warning and error colors remain distinct for
operational status.

## Overview metrics

Performance cards use completed attempts in the rolling last 24 hours, based on
the worker completion timestamp. The success rate is `found` plus
`found_no_phone` divided by all completed attempts. The retry rate is attempts
marked `retry_wait` with outcome `lookup_error`, divided by all completed
attempts; scheduled rechecks after a non-error result are excluded. CAPTCHA /
blocks counts `BLOCKED` errors; consent-required errors are shown separately.
Rates without attempts are displayed as unavailable rather than zero.

Pending queue and worker status use the most recently uploaded snapshots. The
queue total includes both `pending` and `retry_wait`, including rechecks that
may not be due yet. A recent worker heartbeat means one was received within
three minutes, and a pause reason is the last reported value. Resume and exit
snapshots update that state in worker sequence order; historical exits remain
visible separately. Upload delays can make these snapshots lag behind the worker.

The overview performs five exact, count-only queries against existing public
monitoring tables per refresh. The queries return counts rather than attempt
records, but database work grows with attempt history and viewer traffic. Counts
are separate reads, so rates can briefly differ while new uploads arrive.

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
