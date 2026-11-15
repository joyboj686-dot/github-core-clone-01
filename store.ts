import { createHash } from 'node:crypto';

export interface GitObject { type: string; data: Buffer }
export interface Repository {
  id: number; name: string; private: boolean; description: string; default_branch: string;
  refs: Map<string, string>; objects: Map<string, GitObject>;
  labels: Map<string, any>; issues: Map<number, any>; pulls: Map<number, any>;
  comments: Map<number, any[]>; nextNumber: number;
}
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export const now = process.env.MAKEFUN_TRIAL_NOW || '2026-01-01T00:00:00.000Z';
export function hashObject(type: string, data: Buffer): string {
  return createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');
}
export function putObject(repo: Repository, type: string, data: Buffer): string {
  const sha = hashObject(type, data);
  repo.objects.set(sha, { type, data });
  return sha;
}
export function commitInfo(repo: Repository, sha: string) {
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'commit') throw new ApiError(404, 'Commit not found');
  const text = object.data.toString();
  const split = text.indexOf('\n\n');
  const headers = text.slice(0, split).split('\n');
  return { tree: headers.find(x => x.startsWith('tree '))?.slice(5) || '',
    parents: headers.filter(x => x.startsWith('parent ')).map(x => x.slice(7)), message: text.slice(split + 2) };
}
export function treeEntries(repo: Repository, sha: string) {
  const data = repo.objects.get(sha)?.data;
  if (!data) throw new ApiError(404, 'Tree not found');
  const entries: { mode: string; name: string; sha: string }[] = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(32, i), nul = data.indexOf(0, space);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new ApiError(400, 'Invalid tree');
    entries.push({ mode: data.toString('ascii', i, space), name: data.toString('utf8', space + 1, nul), sha: data.subarray(nul + 1, nul + 21).toString('hex') });
    i = nul + 21;
  }
  return entries;
}
export function resolveRef(repo: Repository, ref?: string | null): string | undefined {
  return repo.refs.get(ref || `refs/heads/${repo.default_branch}`) || repo.refs.get(`refs/heads/${ref}`) || (ref && repo.objects.has(ref) ? ref : undefined);
}
export function filesAt(repo: Repository, sha?: string): Map<string, string> {
  const files = new Map<string, string>();
  if (!sha) return files;
  const visit = (tree: string, prefix: string) => {
    for (const e of treeEntries(repo, tree)) {
      if (e.mode === '40000' || e.mode === '040000') visit(e.sha, `${prefix}${e.name}/`);
      else files.set(`${prefix}${e.name}`, e.sha);
    }
  };
  visit(commitInfo(repo, sha).tree, '');
  return files;
}
export function buildTree(repo: Repository, files: Map<string, string>): string {
  const build = (prefix: string): string => {
    const entries = new Map<string, { mode: string; sha: string }>();
    for (const [path, sha] of files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length), slash = rest.indexOf('/');
      if (slash < 0) entries.set(rest, { mode: '100644', sha });
      else {
        const name = rest.slice(0, slash);
        if (!entries.has(name)) entries.set(name, { mode: '40000', sha: build(`${prefix}${name}/`) });
      }
    }
    const sorted = [...entries].sort(([a, av], [b, bv]) => Buffer.compare(Buffer.from(a + (av.mode === '40000' ? '/' : '')), Buffer.from(b + (bv.mode === '40000' ? '/' : ''))));
    return putObject(repo, 'tree', Buffer.concat(sorted.flatMap(([name, e]) => [Buffer.from(`${e.mode} ${name}\0`), Buffer.from(e.sha, 'hex')])));
  };
  return build('');
}
export function commitFiles(repo: Repository, branch: string, files: Map<string, string>, message: string): string {
  const parent = resolveRef(repo, branch);
  const tree = buildTree(repo, files);
  const epoch = Math.floor(Date.parse(now) / 1000);
  const who = `Forge <forge@example.invalid> ${epoch} +0000`;
  const data = Buffer.from(`tree ${tree}\n${parent ? `parent ${parent}\n` : ''}author ${who}\ncommitter ${who}\n\n${message}`);
  const sha = putObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${branch}`, sha);
  return sha;
}
export class Store {
  repos = new Map<string, Repository>();
  owner: string | null = null;
  nextId = 1;
  bindOwner(owner: string) {
    // Owner discovery never changes an already established authenticated namespace.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(owner)) throw new ApiError(404, 'Not Found');
    this.owner ??= owner;
  }
  createRepo(input: any): Repository {
    if (typeof input.name !== 'string' || !/^[\w.-]{1,100}$/.test(input.name)) throw new ApiError(422, 'Invalid repository name');
    if (this.repos.has(input.name)) throw new ApiError(422, 'Repository already exists');
    const repo: Repository = { id: this.nextId++, name: input.name, private: !!input.private, description: input.description || '', default_branch: 'main', refs: new Map(), objects: new Map(), labels: new Map(), issues: new Map(), pulls: new Map(), comments: new Map(), nextNumber: 1 };
    this.repos.set(repo.name, repo);
    return repo;
  }
  getRepo(owner: string, name: string): Repository {
    this.bindOwner(owner);
    const repo = this.owner === owner ? this.repos.get(name) : undefined;
    if (!repo) throw new ApiError(404, 'Not Found');
    return repo;
  }
  repoView(repo: Repository) {
    return { id: repo.id, node_id: Buffer.from(`Repository:${repo.id}`).toString('base64'), name: repo.name,
      full_name: `${this.owner || 'user'}/${repo.name}`, owner: { login: this.owner || 'user' }, private: repo.private,
      description: repo.description, default_branch: repo.default_branch, created_at: now, updated_at: now };
  }
}
