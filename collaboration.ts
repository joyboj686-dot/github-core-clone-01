import { ApiError, Store, now, commitInfo, commitFiles, filesAt, resolveRef, type Repository } from './store.ts';

export function createIssue(store: Store, repo: Repository, input: any) {
  if (typeof input.title !== 'string' || !input.title.trim()) throw new ApiError(422, 'Title is required');
  const labels = (input.labels || []).map((name: string) => {
    const label = repo.labels.get(name); if (!label) throw new ApiError(422, `Unknown label: ${name}`); return label;
  });
  const number = repo.nextNumber++;
  const issue = { id: store.nextId++, node_id: '', number, title: input.title, body: input.body || '', state: 'open', labels, created_at: now, updated_at: now };
  issue.node_id = Buffer.from(`Issue:${issue.id}`).toString('base64');
  repo.issues.set(number, issue); return issue;
}
export function listIssues(repo: Repository, state = 'open', direction = 'desc') {
  return [...repo.issues.values()].filter(i => state === 'all' || i.state === state).sort((a, b) => direction === 'asc' ? a.number - b.number : b.number - a.number);
}
export function addComment(store: Store, repo: Repository, number: number, body: string) {
  if (!repo.issues.has(number) && !repo.pulls.has(number)) throw new ApiError(404, 'Not Found');
  if (typeof body !== 'string') throw new ApiError(422, 'Body required');
  const comment = { id: store.nextId++, body, created_at: now, updated_at: now };
  const comments = repo.comments.get(number) || []; comments.push(comment); repo.comments.set(number, comments);
  return comment;
}
export function createPull(store: Store, repo: Repository, input: any) {
  const head = typeof input.head === 'string' ? input.head.split(':').pop()! : '', base = input.base;
  const headSha = resolveRef(repo, head), baseSha = resolveRef(repo, base);
  if (!input.title || !headSha || !baseSha) throw new ApiError(422, 'Title and existing head/base branches required');
  if (repo.pulls.size && [...repo.pulls.values()].some(p => p.state === 'open' && p.head.ref === head && p.base.ref === base)) throw new ApiError(422, 'Pull request already exists');
  const number = repo.nextNumber++, id = store.nextId++;
  const pull = { id, node_id: Buffer.from(`PullRequest:${id}`).toString('base64'), number,
    title: input.title, body: input.body || '', state: 'open', head: { ref: head, sha: headSha }, base: { ref: base, sha: baseSha },
    merged: false, merged_at: null, merge_commit_sha: null, created_at: now, updated_at: now };
  repo.pulls.set(number, pull); return pull;
}
function mergeBase(repo: Repository, a: string, b: string): string | undefined {
  const ancestors = new Set<string>(), stack = [a];
  while (stack.length) { const sha = stack.pop()!; if (ancestors.has(sha)) continue; ancestors.add(sha); stack.push(...commitInfo(repo, sha).parents); }
  const queue = [b], seen = new Set<string>();
  while (queue.length) { const sha = queue.shift()!; if (ancestors.has(sha)) return sha; if (seen.has(sha)) continue; seen.add(sha); queue.push(...commitInfo(repo, sha).parents); }
}
export function pullFiles(repo: Repository, pull: any) {
  const head = resolveRef(repo, pull.head.ref)!, base = resolveRef(repo, pull.base.ref)!;
  const common = mergeBase(repo, head, base), before = filesAt(repo, common), after = filesAt(repo, head);
  return [...new Set([...before.keys(), ...after.keys()])].filter(p => before.get(p) !== after.get(p)).map(filename => {
    const old = before.get(filename), next = after.get(filename);
    const lines = (sha?: string) => sha ? (repo.objects.get(sha)!.data.toString().match(/[^\n]+(?:\n|$)/g) || []).length : 0;
    const additions = lines(next), deletions = lines(old);
    return { filename, status: !old ? 'added' : !next ? 'removed' : 'modified', additions, deletions, changes: additions + deletions };
  });
}
export function mergePull(repo: Repository, pull: any) {
  if (pull.state !== 'open') throw new ApiError(405, 'Pull request is not open');
  const head = resolveRef(repo, pull.head.ref)!, base = resolveRef(repo, pull.base.ref)!;
  const common = filesAt(repo, mergeBase(repo, head, base)), incoming = filesAt(repo, head), current = filesAt(repo, base);
  for (const path of new Set([...common.keys(), ...incoming.keys()])) {
    const old = common.get(path), next = incoming.get(path), local = current.get(path);
    if (next === old) continue;
    if (local !== old && local !== next) throw new ApiError(405, 'Merge conflict');
    if (next) current.set(path, next); else current.delete(path);
  }
  const sha = commitFiles(repo, pull.base.ref, current, `${pull.title} (#${pull.number})\n`);
  pull.state = 'closed'; pull.merged = true; pull.merged_at = now; pull.merge_commit_sha = sha;
  return { sha, merged: true, message: 'Pull request successfully merged' };
}
export function collaboration(store: Store, repo: Repository, method: string, route: string, body: any, url: URL): [number, unknown] | null {
  if (route === 'labels') {
    if (method === 'POST') { if (!body.name) throw new ApiError(422, 'Label name required'); const label = { name: body.name, color: body.color || 'ededed' }; repo.labels.set(body.name, label); return [201, label]; }
    if (method === 'GET') return [200, [...repo.labels.values()]];
  }
  if (route === 'issues') {
    if (method === 'POST') return [201, createIssue(store, repo, body)];
    if (method === 'GET') return [200, listIssues(repo, url.searchParams.get('state') || 'open', url.searchParams.get('direction') || 'desc')];
  }
  const issueRoute = /^issues\/(\d+)(\/comments)?$/.exec(route);
  if (issueRoute) {
    const number = Number(issueRoute[1]), issue = repo.issues.get(number);
    if (!issue) throw new ApiError(404, 'Not Found');
    if (issueRoute[2]) {
      if (method === 'POST') return [201, addComment(store, repo, number, body.body)];
      if (method === 'GET') return [200, repo.comments.get(number) || []];
    } else {
      if (method === 'PATCH') { for (const key of ['title', 'body', 'state']) if (typeof body[key] === 'string') issue[key] = body[key]; }
      if (method === 'GET' || method === 'PATCH') return [200, issue];
    }
  }
  if (route === 'pulls') {
    if (method === 'POST') return [201, createPull(store, repo, body)];
    if (method === 'GET') { const state = url.searchParams.get('state') || 'open'; return [200, [...repo.pulls.values()].filter(p => state === 'all' || p.state === state)]; }
  }
  const pullRoute = /^pulls\/(\d+)(?:\/(files|merge))?$/.exec(route);
  if (pullRoute) {
    const pull = repo.pulls.get(Number(pullRoute[1])); if (!pull) throw new ApiError(404, 'Not Found');
    if (!pullRoute[2] && method === 'GET') return [200, pull];
    if (pullRoute[2] === 'files' && method === 'GET') return [200, pullFiles(repo, pull)];
    if (pullRoute[2] === 'merge' && method === 'PUT') return [200, mergePull(repo, pull)];
  }
  return null;
}
