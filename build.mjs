import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
const supabasePublishableKey = (process.env.SUPABASE_PUBLISHABLE_KEY || '').trim();
let url;
try { url = new URL(supabaseUrl); } catch { throw new Error('Set SUPABASE_URL to your HTTPS Supabase project URL.'); }
if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
  throw new Error('SUPABASE_URL must be an HTTPS project URL without credentials, query, or fragment.');
}
let publicKey = supabasePublishableKey.startsWith('sb_publishable_');
if (!publicKey) {
  try {
    const payload = JSON.parse(Buffer.from(supabasePublishableKey.split('.')[1], 'base64url').toString());
    publicKey = payload.role === 'anon';
  } catch { /* Not a legacy anon key. */ }
}
if (!publicKey) {
  throw new Error('Set SUPABASE_PUBLISHABLE_KEY to a public publishable or legacy anon key. Secret and service-role keys must never be deployed.');
}
const output = path.join(root, 'dist');
await mkdir(output, { recursive: true });
for (const name of ['index.html', 'styles.css', 'app.js']) {
  await copyFile(path.join(root, name), path.join(output, name));
}
await writeFile(path.join(output, 'config.js'),
  'window.GOOGLE_MONITORING_CONFIG = ' + JSON.stringify({ supabaseUrl, supabasePublishableKey }) + ';\n');
console.log('Built monitoring dashboard in dist/.');
