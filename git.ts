import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError, Store, commitInfo, treeEntries, type Repository } from './store.ts';
import { packets, pkt, readPack, sideband, writePack } from './pack.ts';

const zero = '0'.repeat(40);
const flush = Buffer.from('0000'), delim = Buffer.from('0001');
const cache = new WeakMap<Repository, Map<string, Buffer>>();
function closure(repo: Repository, roots: string[], depth = Infinity, boundary = new Set<string>()) {
  const seen = new Set<string>(), shallow = new Set<string>();
  const visit = (sha: string, generation: number) => {
    if (seen.has(sha)) return;
    const object = repo.objects.get(sha);
    if (!object) throw new Error('Missing object');
    seen.add(sha);
    if (object.type === 'commit') {
      const c = commitInfo(repo, sha); visit(c.tree, generation);
      if (generation >= depth || boundary.has(sha)) { if (c.parents.length) shallow.add(sha); }
      else for (const p of c.parents) visit(p, generation + 1);
    } else if (object.type === 'tree') {
      for (const e of treeEntries(repo, sha)) if (e.mode !== '160000') visit(e.sha, generation);
    } else if (object.type === 'tag') visit(object.data.toString().split('\n')[0].slice(7), generation);
  };
  for (const root of roots) if (repo.objects.has(root)) visit(root, 1);
  return { seen, shallow };
}
function ancestor(repo: Repository, old: string, tip: string): boolean {
  const stack = [tip], seen = new Set<string>();
  while (stack.length) {
    const sha = stack.pop()!;
    if (sha === old) return true;
    if (seen.has(sha)) continue; seen.add(sha);
    if (repo.objects.get(sha)?.type === 'commit') stack.push(...commitInfo(repo, sha).parents);
  }
  return false;
}
function refs(repo: Repository) {
  const head = `refs/heads/${repo.default_branch}`;
  return [...(repo.refs.has(head) ? [['HEAD', repo.refs.get(head)!]] : []), ...repo.refs] as [string, string][];
}
function peel(repo: Repository, sha: string): string | undefined {
  let target = sha; const seen = new Set<string>();
  while (repo.objects.get(target)?.type === 'tag' && !seen.has(target)) {
    seen.add(target); target = repo.objects.get(target)!.data.toString().split('\n')[0].slice(7);
  }
  return target === sha ? undefined : target;
}
export async function git(store: Store, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(decodeURIComponent(url.pathname));
  if (!match) throw new ApiError(404, 'Not Found');
  const repo = store.getRepo(match[1], match[2]), route = match[3];
  const service = route === 'info/refs' ? url.searchParams.get('service') : route;
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') throw new ApiError(404, 'Not Found');
  const v2 = service === 'git-upload-pack' && req.headers['git-protocol'] === 'version=2';
  let response: Buffer;
  if (req.method === 'GET' && route === 'info/refs') {
    if (v2) response = Buffer.concat(['version 2\n', 'ls-refs=unborn\n', 'fetch=shallow\n', 'object-format=sha1\n'].map(pkt).concat(flush));
    else {
      const caps = service === 'git-receive-pack' ? 'report-status side-band-64k delete-refs ofs-delta' : `side-band-64k shallow ofs-delta symref=HEAD:refs/heads/${repo.default_branch}`;
      const all = refs(repo), lines = all.length ? all : [['capabilities^{}', zero]];
      response = Buffer.concat([pkt(`# service=${service}\n`), flush, ...lines.map(([name, sha], i) => pkt(`${sha} ${name}${i === 0 ? `\0${caps}` : ''}\n`)), flush]);
    }
    res.writeHead(200, { 'content-type': `application/x-${service}-advertisement`, 'cache-control': 'no-cache' }); res.end(response); return;
  }
  if (req.method !== 'POST' || route !== service) throw new ApiError(404, 'Not Found');
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > 64 * 1024 * 1024) throw new ApiError(413, 'Pack too large'); chunks.push(chunk); }
  const body = Buffer.concat(chunks);
  let parsed;
  try { parsed = packets(body); } catch { throw new ApiError(400, 'Malformed packet'); }
  const lines = parsed.lines.map(b => b.toString().trimEnd());
  if (service === 'git-receive-pack') {
    let unpack = 'ok';
    try {
      if (parsed.end < body.length) for (const [sha, object] of readPack(body.subarray(parsed.end), repo.objects)) repo.objects.set(sha, object);
    } catch (error) { unpack = error instanceof Error ? error.message : 'Invalid pack'; }
    const reports = [pkt(`unpack ${unpack}\n`)];
    for (const line of lines) {
      const [old, next, ref] = line.split('\0')[0].split(' ');
      let reason = '';
      if (!/^[a-f0-9]{40}$/.test(old) || !/^[a-f0-9]{40}$/.test(next) || !/^refs\/(heads|tags)\/[^\s]+$/.test(ref || '')) reason = 'invalid ref';
      else if (unpack !== 'ok') reason = 'unpacker error';
      else if ((repo.refs.get(ref) || zero) !== old) reason = 'stale ref';
      else if (next !== zero && !repo.objects.has(next)) reason = 'missing object';
      else if (old !== zero && next !== zero && !ancestor(repo, old, next)) reason = 'non-fast-forward';
      if (!reason) {
        if (next === zero) repo.refs.delete(ref); else repo.refs.set(ref, next);
        if (repo.refs.size === 1 && ref.startsWith('refs/heads/')) repo.default_branch = ref.slice(11);
        cache.delete(repo);
      }
      reports.push(pkt(reason ? `ng ${ref} ${reason}\n` : `ok ${ref}\n`));
    }
    reports.push(flush);
    const report = Buffer.concat(reports);
    response = lines[0]?.includes('side-band-64k') ? sideband(report) : report;
  } else if (v2 && lines.includes('command=ls-refs')) {
    const prefixes = lines.filter(x => x.startsWith('ref-prefix ')).map(x => x.slice(11));
    const result = refs(repo).filter(([name]) => !prefixes.length || prefixes.some(p => name.startsWith(p))).map(([name, sha]) => {
      const target = lines.includes('peel') ? peel(repo, sha) : undefined;
      return pkt(`${sha} ${name}${name === 'HEAD' && lines.includes('symrefs') ? ` symref-target:refs/heads/${repo.default_branch}` : ''}${target ? ` peeled:${target}` : ''}\n`);
    });
    response = Buffer.concat([...result, flush]);
  } else {
    // v0 wants and negotiation are separated by a flush; v2 uses a delimiter.
    if (!v2 && parsed.end < body.length) lines.push(...packets(body.subarray(parsed.end)).lines.map(b => b.toString().trimEnd()));
    const values = (prefix: string) => lines.filter(l => l.startsWith(prefix + ' ')).map(l => l.split(' ')[1]);
    const wants = values('want'), haves = values('have'), boundary = values('shallow');
    const depth = Number(values('deepen')[0]) || Infinity;
    if (depth < 1 || !wants.length) throw new ApiError(400, 'Invalid fetch request');
    const key = `${wants.join(',')}:${depth}:${haves.join(',')}:${boundary.join(',')}`;
    let packs = cache.get(repo); if (!packs) cache.set(repo, packs = new Map());
    // Objects are immutable: an identical want/have/depth request can reuse its
    // entire framed response, not just deflation, avoiding repeated graph walks.
    const responseKey = `response:${v2}:${key}`;
    const cached = packs.get(responseKey);
    if (cached) {
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': cached.length });
      res.end(cached); return;
    }
    const wanted = closure(repo, wants, depth);
    const held = closure(repo, haves, Infinity, new Set(boundary)).seen;
    const ids = [...wanted.seen].filter(sha => !held.has(sha));
    let pack = packs.get(key);
    if (!pack) { pack = writePack(ids.map(sha => repo.objects.get(sha)!)); if (packs.size > 16) packs.clear(); packs.set(key, pack); }
    const shallow = depth !== Infinity ? [...wanted.shallow].map(sha => pkt(`shallow ${sha}\n`)) : [];
    const unshallow = boundary.filter(sha => wanted.seen.has(sha) && !wanted.shallow.has(sha)).map(sha => pkt(`unshallow ${sha}\n`));
    response = v2
      ? Buffer.concat([...(shallow.length || unshallow.length ? [pkt('shallow-info\n'), ...shallow, ...unshallow, delim] : []), pkt('packfile\n'), sideband(pack)])
      : Buffer.concat([...shallow, ...unshallow, ...(shallow.length ? [flush] : []), pkt('NAK\n'), sideband(pack)]);
    packs.set(responseKey, response);
  }
  res.writeHead(200, { 'content-type': `application/x-${service}-result`, 'content-length': response.length }); res.end(response);
}
