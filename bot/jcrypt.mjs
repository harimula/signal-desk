// Journal encryption shared by the US bot (bot.mjs) and the India simulation (india.mjs).
// AES-256-GCM, key from the journal passphrase with PBKDF2-SHA256 (600k rounds; older blobs carry their own `iter`).
// The page decrypts with the same passphrase (jDecrypt in index.html).
export const JOURNAL_ITER = 600000;
export async function encryptJournal(obj, pass, iter = JOURNAL_ITER) {
  const cr = await import('node:crypto'), subtle = cr.webcrypto.subtle, enc = new TextEncoder();
  const salt = cr.randomBytes(16), iv = cr.randomBytes(12);
  const km = await subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  const key = await subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ct = Buffer.from(await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
  return { enc: 1, kdf: 'PBKDF2-SHA256', iter, salt: salt.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64') };
}
export async function decryptJournal(blob, pass) {
  const cr = await import('node:crypto'), subtle = cr.webcrypto.subtle, enc = new TextEncoder();
  const km = await subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  const key = await subtle.deriveKey({ name: 'PBKDF2', salt: Buffer.from(blob.salt, 'base64'), iterations: (() => { const n = blob.iter || 200000; if (!(n >= 1000 && n <= 5e6)) throw new Error('journal: unusual key-derivation setting'); return n; })(), hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(blob.iv, 'base64') }, key, Buffer.from(blob.ct, 'base64'));
  return JSON.parse(new TextDecoder().decode(pt));
}
