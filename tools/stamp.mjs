// Build stamp + Content-Security-Policy for the site. Run after ANY edit to index.html:
//   node tools/stamp.mjs            bump the build number, write ver.txt, refresh the CSP script hashes
//   node tools/stamp.mjs --check    CI: fail if the hashes or the build number are out of date
// Why: the page's own scripts are inline, so the policy whitelists them by exact SHA-256 hash. Any script that is
// not the page's own (injected through a bug, an extension, or a poisoned feed) is then refused by the browser.
import fs from 'node:fs';
import crypto from 'node:crypto';

const FILE = 'index.html', VER = 'ver.txt';
const CSP_HOSTS = {
  script: ["'wasm-unsafe-eval'", 'https://cdn.jsdelivr.net/npm/libsodium@0.7.13/', 'https://cdn.jsdelivr.net/npm/libsodium-wrappers@0.7.13/', 'https://www.gstatic.com/firebasejs/10.14.1/'],   // exact folders only, not whole CDNs   // wasm-unsafe-eval: lets libsodium (key sealing) compile its WebAssembly; JS eval stays blocked                      // libsodium (SRI-pinned), Firebase (optional accounts feature)
  style: ["'unsafe-inline'", 'https://fonts.googleapis.com'],
  font: ['https://fonts.gstatic.com'],
  connect: ['https://api.github.com', 'https://*.github.io', 'https://finnhub.io', 'wss://ws.finnhub.io', 'https://api.telegram.org',  'https://financialmodelingprep.com', 'https://query1.finance.yahoo.com',
    'https://*.workers.dev', 'https://api.allorigins.win', 'https://corsproxy.io',                            // price relays (no keys travel through them)
    'https://*.googleapis.com', 'https://*.firebaseio.com', 'wss://*.firebaseio.com'],                          // Firebase, only if accounts are switched on
};
const html = fs.readFileSync(FILE, 'utf8');
const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const hashes = inline.map(c => "'sha256-" + crypto.createHash('sha256').update(c, 'utf8').digest('base64') + "'");
const policy = [
  "default-src 'self'",
  `script-src 'self' ${hashes.join(' ')} ${CSP_HOSTS.script.join(' ')}`,
  `style-src 'self' ${CSP_HOSTS.style.join(' ')}`,
  `font-src 'self' ${CSP_HOSTS.font.join(' ')}`,
  "img-src 'self' data: blob:",
  `connect-src 'self' ${CSP_HOSTS.connect.join(' ')}`,
  "frame-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'",
].join('; ');
const meta = `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
const metaRe = /<meta http-equiv="Content-Security-Policy" content="[^"]*">/;
const verNow = (html.match(/const BUILD_V = '(\d+)'/) || [])[1];

if (process.argv.includes('--check')) {
  const problems = [];
  if (!metaRe.test(html)) problems.push('no Content-Security-Policy meta tag');
  else if (html.match(metaRe)[0] !== meta) problems.push('CSP script hashes are stale (index.html changed after the last stamp)');
  if (!verNow) problems.push('no BUILD_V in index.html');
  else if (fs.readFileSync(VER, 'utf8').trim() !== verNow) problems.push(`ver.txt (${fs.readFileSync(VER, 'utf8').trim()}) does not match BUILD_V (${verNow})`);
  // every host the page's code opens a connection to (fetch / tryJson / WebSocket / EventSource) must be allowed by
  // connect-src — otherwise the browser blocks it silently (this is how the Finnhub live stream broke on 2026-10-22)
  const allowed = CSP_HOSTS.connect.map(h => new RegExp('^' + h.replace(/[.]/g, '\\.').replace('*', '[a-z0-9-]+') + '$'));
  const used = new Set([...html.matchAll(/(?:fetch|tryJson|WebSocket|EventSource)\(\s*['"`]((?:https|wss):\/\/[^/'"`?$]+)/g)].map(m => m[1]));
  for (const h of used) if (!allowed.some(re => re.test(h))) problems.push(`the page connects to ${h} but connect-src does not allow it — add it to CSP_HOSTS.connect`);
  for (const [n, c] of inline.entries()) { try { new Function(c); } catch (e) { problems.push(`inline script #${n + 1} does not parse: ${e.message}`); } }
  if (problems.length) { console.error('stamp check FAILED:\n  - ' + problems.join('\n  - ') + '\nRun: node tools/stamp.mjs'); process.exit(1); }
  console.log(`stamp check OK: build ${verNow}, ${inline.length} inline scripts hashed`);
  process.exit(0);
}

const v = String(Math.floor(Date.now() / 1000));
let out = html.replace(/const BUILD_V = '\d+';/, `const BUILD_V = '${v}';`);
// the hash must cover the script AFTER the build number is written into it
const inline2 = [...out.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const hashes2 = inline2.map(c => "'sha256-" + crypto.createHash('sha256').update(c, 'utf8').digest('base64') + "'");
const meta2 = meta.replace(hashes.join(' '), hashes2.join(' '));
out = metaRe.test(out) ? out.replace(metaRe, meta2) : out.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n' + meta2);
fs.writeFileSync(FILE, out); fs.writeFileSync(VER, v);
console.log(`stamped build ${v}; CSP covers ${inline2.length} inline scripts`);
