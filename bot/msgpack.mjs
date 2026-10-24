// Minimal MessagePack codec for Alpaca's options data stream (which speaks MessagePack only). No dependencies.
// Covers what the stream uses: nil, booleans, integers, floats, strings, binary, arrays and maps.
export function encode(v) { const parts = []; put(v, parts); return Buffer.concat(parts); }
function put(v, out) {
  if (v === null || v === undefined) return out.push(Buffer.from([0xc0]));
  if (v === true || v === false) return out.push(Buffer.from([v ? 0xc3 : 0xc2]));
  if (typeof v === 'number') {
    if (Number.isInteger(v)) {
      if (v >= 0 && v < 128) return out.push(Buffer.from([v]));
      if (v < 0 && v >= -32) return out.push(Buffer.from([0x100 + v]));
      if (v >= 0 && v <= 0xff) return out.push(Buffer.from([0xcc, v]));
      if (v >= 0 && v <= 0xffff) { const b = Buffer.alloc(3); b[0] = 0xcd; b.writeUInt16BE(v, 1); return out.push(b); }
      if (v >= 0 && v <= 0xffffffff) { const b = Buffer.alloc(5); b[0] = 0xce; b.writeUInt32BE(v, 1); return out.push(b); }
      if (v < 0 && v >= -128) { const b = Buffer.alloc(2); b[0] = 0xd0; b.writeInt8(v, 1); return out.push(b); }
      if (v < 0 && v >= -32768) { const b = Buffer.alloc(3); b[0] = 0xd1; b.writeInt16BE(v, 1); return out.push(b); }
      if (v < 0 && v >= -2147483648) { const b = Buffer.alloc(5); b[0] = 0xd2; b.writeInt32BE(v, 1); return out.push(b); }
      const b = Buffer.alloc(9); b[0] = v < 0 ? 0xd3 : 0xcf; v < 0 ? b.writeBigInt64BE(BigInt(v), 1) : b.writeBigUInt64BE(BigInt(v), 1); return out.push(b);
    }
    const b = Buffer.alloc(9); b[0] = 0xcb; b.writeDoubleBE(v, 1); return out.push(b);
  }
  if (typeof v === 'string') {
    const s = Buffer.from(v, 'utf8'), n = s.length;
    if (n < 32) out.push(Buffer.from([0xa0 | n])); else if (n <= 0xff) out.push(Buffer.from([0xd9, n])); else if (n <= 0xffff) { const b = Buffer.alloc(3); b[0] = 0xda; b.writeUInt16BE(n, 1); out.push(b); } else { const b = Buffer.alloc(5); b[0] = 0xdb; b.writeUInt32BE(n, 1); out.push(b); }
    return out.push(s);
  }
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    const n = v.length; if (n <= 0xff) out.push(Buffer.from([0xc4, n])); else if (n <= 0xffff) { const b = Buffer.alloc(3); b[0] = 0xc5; b.writeUInt16BE(n, 1); out.push(b); } else { const b = Buffer.alloc(5); b[0] = 0xc6; b.writeUInt32BE(n, 1); out.push(b); }
    return out.push(Buffer.from(v));
  }
  if (Array.isArray(v)) {
    const n = v.length; if (n < 16) out.push(Buffer.from([0x90 | n])); else if (n <= 0xffff) { const b = Buffer.alloc(3); b[0] = 0xdc; b.writeUInt16BE(n, 1); out.push(b); } else { const b = Buffer.alloc(5); b[0] = 0xdd; b.writeUInt32BE(n, 1); out.push(b); }
    for (const x of v) put(x, out); return;
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v), n = keys.length; if (n < 16) out.push(Buffer.from([0x80 | n])); else if (n <= 0xffff) { const b = Buffer.alloc(3); b[0] = 0xde; b.writeUInt16BE(n, 1); out.push(b); } else { const b = Buffer.alloc(5); b[0] = 0xdf; b.writeUInt32BE(n, 1); out.push(b); }
    for (const k of keys) { put(k, out); put(v[k], out); } return;
  }
  throw new Error('msgpack: cannot encode ' + typeof v);
}
// Decodes one value from a Buffer. Unknown extension types are returned as { ext, data }.
export function decode(buf) { const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf); const r = { b, i: 0 }; const v = read(r); return v; }
function read(r) {
  const b = r.b, t = b[r.i++];
  if (t <= 0x7f) return t;
  if (t >= 0xe0) return t - 0x100;
  if ((t & 0xf0) === 0x80) return map(r, t & 0x0f);
  if ((t & 0xf0) === 0x90) return arr(r, t & 0x0f);
  if ((t & 0xe0) === 0xa0) return str(r, t & 0x1f);
  switch (t) {
    case 0xc0: return null; case 0xc2: return false; case 0xc3: return true;
    case 0xc4: return bin(r, b[r.i++]); case 0xc5: { const n = b.readUInt16BE(r.i); r.i += 2; return bin(r, n); } case 0xc6: { const n = b.readUInt32BE(r.i); r.i += 4; return bin(r, n); }
    case 0xca: { const v = b.readFloatBE(r.i); r.i += 4; return v; } case 0xcb: { const v = b.readDoubleBE(r.i); r.i += 8; return v; }
    case 0xcc: return b[r.i++]; case 0xcd: { const v = b.readUInt16BE(r.i); r.i += 2; return v; } case 0xce: { const v = b.readUInt32BE(r.i); r.i += 4; return v; } case 0xcf: { const v = Number(b.readBigUInt64BE(r.i)); r.i += 8; return v; }
    case 0xd0: { const v = b.readInt8(r.i); r.i += 1; return v; } case 0xd1: { const v = b.readInt16BE(r.i); r.i += 2; return v; } case 0xd2: { const v = b.readInt32BE(r.i); r.i += 4; return v; } case 0xd3: { const v = Number(b.readBigInt64BE(r.i)); r.i += 8; return v; }
    case 0xd9: return str(r, b[r.i++]); case 0xda: { const n = b.readUInt16BE(r.i); r.i += 2; return str(r, n); } case 0xdb: { const n = b.readUInt32BE(r.i); r.i += 4; return str(r, n); }
    case 0xdc: { const n = b.readUInt16BE(r.i); r.i += 2; return arr(r, n); } case 0xdd: { const n = b.readUInt32BE(r.i); r.i += 4; return arr(r, n); }
    case 0xde: { const n = b.readUInt16BE(r.i); r.i += 2; return map(r, n); } case 0xdf: { const n = b.readUInt32BE(r.i); r.i += 4; return map(r, n); }
    case 0xd4: return ext(r, 1); case 0xd5: return ext(r, 2); case 0xd6: return ext(r, 4); case 0xd7: return ext(r, 8); case 0xd8: return ext(r, 16);
    case 0xc7: return ext(r, b[r.i++]); case 0xc8: { const n = b.readUInt16BE(r.i); r.i += 2; return ext(r, n); } case 0xc9: { const n = b.readUInt32BE(r.i); r.i += 4; return ext(r, n); }
    default: throw new Error('msgpack: unknown type 0x' + t.toString(16));
  }
}
const str = (r, n) => { const s = r.b.toString('utf8', r.i, r.i + n); r.i += n; return s; };
const bin = (r, n) => { const s = r.b.subarray(r.i, r.i + n); r.i += n; return Buffer.from(s); };
const arr = (r, n) => { const out = []; for (let k = 0; k < n; k++) out.push(read(r)); return out; };
const map = (r, n) => { const out = {}; for (let k = 0; k < n; k++) { const key = read(r); out[key] = read(r); } return out; };
const ext = (r, n) => { const type = r.b.readInt8(r.i); r.i += 1; const data = bin(r, n); if (type === -1) return tsExt(data); return { ext: type, data }; };
// timestamp extension (type -1): 32-, 64- or 96-bit; returned as an ISO string like the JSON stream would give
function tsExt(d) {
  let sec, ns = 0;
  if (d.length === 4) sec = d.readUInt32BE(0); else if (d.length === 8) { const x = d.readBigUInt64BE(0); ns = Number(x >> 34n); sec = Number(x & 0x3ffffffffn); } else { ns = d.readUInt32BE(0); sec = Number(d.readBigInt64BE(4)); }
  return new Date(sec * 1000 + Math.floor(ns / 1e6)).toISOString();
}
