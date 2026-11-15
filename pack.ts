import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { hashObject, type GitObject } from './store.ts';

const types = ['', 'commit', 'tree', 'blob', 'tag'];
export function pkt(value: string | Buffer): Buffer {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (data.length > 65516) throw new Error('Packet too large');
  return Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, '0')), data]);
}
export function packets(data: Buffer): { lines: Buffer[]; end: number } {
  let i = 0;
  const lines: Buffer[] = [];
  while (i < data.length) {
    const header = data.toString('ascii', i, i + 4);
    if (!/^[\da-f]{4}$/i.test(header)) throw new Error('Invalid packet header');
    const n = parseInt(header, 16); i += 4;
    if (n === 0) return { lines, end: i };
    if (n === 1 || n === 2) { lines.push(Buffer.alloc(0)); continue; }
    if (n < 4 || n > 65520 || i + n - 4 > data.length) throw new Error('Truncated packet');
    lines.push(data.subarray(i, i + n - 4)); i += n - 4;
  }
  return { lines, end: i };
}
export function sideband(data: Buffer): Buffer {
  const result: Buffer[] = [];
  for (let i = 0; i < data.length; i += 65515) result.push(pkt(Buffer.concat([Buffer.from([1]), data.subarray(i, i + 65515)])));
  return Buffer.concat([...result, Buffer.from('0000')]);
}
export function writePack(objects: GitObject[]): Buffer {
  const header = Buffer.alloc(12); header.write('PACK'); header.writeUInt32BE(2, 4); header.writeUInt32BE(objects.length, 8);
  const parts = [header];
  for (const obj of objects) {
    let n = obj.data.length, byte = (types.indexOf(obj.type) << 4) | (n & 15); n = Math.floor(n / 16);
    const bytes = [];
    while (n) { bytes.push(byte | 128); byte = n & 127; n = Math.floor(n / 128); }
    bytes.push(byte); parts.push(Buffer.from(bytes), deflateSync(obj.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const size = () => { let n = 0, shift = 0, b; do { if (i >= delta.length || shift > 49) throw new Error('Invalid delta size'); b = delta[i++]; n += (b & 127) * 2 ** shift; shift += 7; } while (b & 128); return n; };
  if (size() !== base.length) throw new Error('Invalid delta base size');
  const length = size();
  if (length > 64 * 1024 * 1024) throw new Error('Delta too large');
  const out = Buffer.alloc(length); let written = 0;
  while (i < delta.length) {
    const op = delta[i++];
    if (op & 128) {
      let off = 0, n = 0;
      for (let k = 0; k < 4; k++) if (op & (1 << k)) off += delta[i++] * 2 ** (8 * k);
      for (let k = 0; k < 3; k++) if (op & (16 << k)) n += delta[i++] * 2 ** (8 * k);
      n ||= 65536;
      if (off + n > base.length || written + n > length) throw new Error('Delta copy out of bounds');
      base.copy(out, written, off, off + n); written += n;
    } else {
      if (!op || i + op > delta.length || written + op > length) throw new Error('Invalid delta insert');
      delta.copy(out, written, i, i + op); written += op; i += op;
    }
  }
  if (written !== length) throw new Error('Delta size mismatch');
  return out;
}
export function readPack(data: Buffer, existing: Map<string, GitObject>): Map<string, GitObject> {
  if (data.length < 32 || data.toString('ascii', 0, 4) !== 'PACK' || ![2, 3].includes(data.readUInt32BE(4))) throw new Error('Invalid pack header');
  const end = data.length - 20;
  if (!createHash('sha1').update(data.subarray(0, end)).digest().equals(data.subarray(end))) throw new Error('Pack checksum mismatch');
  const count = data.readUInt32BE(8), raw: any[] = [], byOffset = new Map(); let i = 12;
  if (count > 1000000) throw new Error('Too many pack objects');
  for (let k = 0; k < count; k++) {
    const offset = i, first = data[i++], type = (first >> 4) & 7;
    let n = first & 15, shift = 4, byte = first;
    while (byte & 128) { if (i >= end || shift > 49) throw new Error('Invalid pack size'); byte = data[i++]; n += (byte & 127) * 2 ** shift; shift += 7; }
    const entry: any = { offset, type };
    if (type === 6) {
      let b = data[i++], distance = b & 127;
      while (b & 128) { b = data[i++]; distance = (distance + 1) * 128 + (b & 127); }
      entry.baseOffset = offset - distance;
    } else if (type === 7) { entry.baseSha = data.subarray(i, i + 20).toString('hex'); i += 20; }
    else if (!types[type]) throw new Error('Invalid pack object type');
    const inflated: any = inflateSync(data.subarray(i, end), { info: true, maxOutputLength: 64 * 1024 * 1024 });
    i += inflated.engine.bytesWritten; entry.data = inflated.buffer;
    if (entry.data.length !== n) throw new Error('Pack object size mismatch');
    raw.push(entry); byOffset.set(offset, entry);
  }
  if (i !== end) throw new Error('Unexpected pack bytes');
  const result = new Map<string, GitObject>();
  const resolve = (entry: any): GitObject | undefined => {
    if (entry.object) return entry.object;
    if (entry.busy) throw new Error('Delta cycle');
    entry.busy = true;
    let object: GitObject;
    if (entry.type === 6 || entry.type === 7) {
      const base = entry.type === 6 ? (byOffset.has(entry.baseOffset) ? resolve(byOffset.get(entry.baseOffset)) : undefined) : result.get(entry.baseSha) || existing.get(entry.baseSha);
      if (!base) { entry.busy = false; return undefined; }
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else object = { type: types[entry.type], data: entry.data };
    entry.object = object; entry.busy = false;
    result.set(hashObject(object.type, object.data), object);
    return object;
  };
  let pending = raw;
  while (pending.length) {
    const next = pending.filter(e => !resolve(e));
    if (next.length === pending.length) throw new Error('Missing delta base');
    pending = next;
  }
  return result;
}
