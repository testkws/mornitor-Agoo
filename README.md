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
5. Open the deployment URL and sign in with your approved Supabase Auth account.

The database migration, approved-user entry in `monitoring_access`, and worker
setup must already be configured. Disable public signup in Supabase Auth. Set
its Site URL to your production dashboard URL and configure redirect URLs if
using account recovery or other email authentication flows.

Both environment values become public browser configuration. Never supply a
worker token, Supabase secret key, or service-role key. The build rejects secret
and service-role keys. Database RLS controls access to the monitoring data.
Environment changes require a redeployment. Only files in `dist` are published.

## Local use

For the original no-build workflow, copy `config.example.js` to `config.js`, fill
in its public settings, and serve this folder with `python3 -m http.server 8080`.

To try the Vercel build locally, set the two environment variables above, run
`node build.mjs`, then `python3 -m http.server 8080 --directory dist`.
