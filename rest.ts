import { collaboration } from './collaboration.ts';
import type { ServerResponse } from 'node:http';
import { ApiError, Store, commitFiles, commitInfo, filesAt, putObject, resolveRef, treeEntries } from './store.ts';

export function rest(store: Store, method: string, url: URL, body: any, res: ServerResponse): [number, unknown] {
  const path = decodeURIComponent(url.pathname).replace(/\/$/, '');
  if (method === 'GET' && path === '/api/v3') {
    res.setHeader('X-OAuth-Scopes', 'repo, read:org');
    return [200, { current_user_url: '/api/v3/user' }];
  }
  if (method === 'GET' && path === '/api/v3/meta') return [200, { installed_version: '1.0.0' }];
  if (path === '/api/v3/user/repos') {
    if (method === 'POST') return [201, store.repoView(store.createRepo(body))];
    if (method === 'GET') {
      const per = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page')) || 30));
      const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
      const all = [...store.repos.values()];
      if (page * per < all.length) {
        const next = new URL(url); next.searchParams.set('page', String(page + 1));
        res.setHeader('Link', `<${next}>; rel="next"`);
      }
      return [200, all.slice((page - 1) * per, page * per).map(r => store.repoView(r))];
    }
  }
  if (method === 'GET' && path === '/api/v3/user' && store.owner) return [200, { login: store.owner, id: 1 }];
  const match = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (!match) throw new ApiError(404, 'Not Found');
  const [, owner, name, route = ''] = match;
  const repo = store.getRepo(owner, name);
  const result = collaboration(store, repo, method, route, body, url);
  if (result) return result;
  if (!route) {
    if (method === 'GET') return [200, store.repoView(repo)];
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.default_branch === 'string') repo.default_branch = body.default_branch;
      return [200, store.repoView(repo)];
    }
    if (method === 'DELETE') { store.repos.delete(name); return [204, null]; }
  }
  if (route === 'git/refs' && method === 'POST') {
    if (!/^refs\/heads\/.+/.test(body.ref) || !repo.objects.has(body.sha)) throw new ApiError(422, 'Invalid ref');
    if (repo.refs.has(body.ref)) throw new ApiError(422, 'Reference already exists');
    repo.refs.set(body.ref, body.sha);
    return [201, { ref: body.ref, object: { sha: body.sha, type: 'commit' } }];
  }
  if (route.startsWith('git/refs/') && method === 'GET') {
    const ref = `refs/${route.slice(9)}`, sha = repo.refs.get(ref);
    if (!sha) throw new ApiError(404, 'Not Found');
    return [200, { ref, object: { sha, type: 'commit' } }];
  }
  if (route === 'branches' && method === 'GET') return [200, [...repo.refs].filter(([r]) => r.startsWith('refs/heads/')).map(([r, sha]) => ({ name: r.slice(11), commit: { sha } }))];
  if (route.startsWith('branches/') && method === 'GET') {
    const name = route.slice(9), sha = resolveRef(repo, name);
    if (!sha) throw new ApiError(404, 'Not Found');
    return [200, { name, commit: { sha } }];
  }
  if (route === 'commits' && method === 'GET') {
    let sha = resolveRef(repo, url.searchParams.get('sha'));
    const list = [], seen = new Set<string>();
    while (sha && !seen.has(sha)) {
      seen.add(sha); const c = commitInfo(repo, sha);
      list.push({ sha, commit: { message: c.message }, parents: c.parents.map(sha => ({ sha })) }); sha = c.parents[0];
    }
    return [200, list];
  }
  if (route === 'contents' || route.startsWith('contents/')) {
    const file = route.slice(9), branch = body.branch || url.searchParams.get('ref') || repo.default_branch;
    const tip = resolveRef(repo, branch), files = filesAt(repo, tip), old = files.get(file);
    const view = (path: string, sha: string) => {
      const data = repo.objects.get(sha)!.data;
      return { type: 'file', name: path.split('/').pop(), path, sha, size: data.length, encoding: 'base64', content: data.toString('base64') };
    };
    if (method === 'GET') {
      if (old) return [200, view(file, old)];
      const prefix = file ? `${file}/` : '';
      const entries = new Map();
      for (const [p, sha] of files) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length), slash = rest.indexOf('/');
        if (slash < 0) entries.set(rest, view(p, sha));
        else {
          const name = rest.slice(0, slash), path = `${prefix}${name}`;
          let tree = tip ? commitInfo(repo, tip).tree : '';
          for (const part of path.split('/')) tree = treeEntries(repo, tree).find(e => e.name === part)!.sha;
          entries.set(name, { type: 'dir', name, path, sha: tree });
        }
      }
      if (!entries.size) throw new ApiError(404, 'Not Found');
      return [200, [...entries.values()]];
    }
    if (method === 'PUT') {
      if (!repo.refs.has(`refs/heads/${branch}`) && repo.refs.size > 0) throw new ApiError(404, 'Branch not found');
      if (old && body.sha !== old) throw new ApiError(409, 'Content SHA does not match');
      if (!file || typeof body.content !== 'string') throw new ApiError(422, 'Missing content or path');
      const sha = putObject(repo, 'blob', Buffer.from(body.content, 'base64')); files.set(file, sha);
      const commit = commitFiles(repo, branch, files, body.message || 'Update content');
      return [old ? 200 : 201, { content: view(file, sha), commit: { sha: commit } }];
    }
    if (method === 'DELETE') {
      if (!old) throw new ApiError(404, 'Not Found');
      if (body.sha !== old) throw new ApiError(409, 'Content SHA does not match');
      files.delete(file);
      return [200, { commit: { sha: commitFiles(repo, branch, files, body.message || 'Delete content') } }];
    }
  }
  throw new ApiError(404, 'Not Found');
}
