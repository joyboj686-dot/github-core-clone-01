import { Store, ApiError, type Repository } from './store.ts';
import { createIssue, listIssues, createPull, mergePull, addComment, pullFiles } from './collaboration.ts';

type Field = { name: string; alias: string; args: any; fields: Field[]; fragment?: string };
function parse(query: string, variables: any): Field[] {
  const tokens = (query.match(/#[^\n]*|\.\.\.|\$|[A-Za-z_][A-Za-z_0-9]*|-?\d+(?:\.\d+)?|"(?:\\.|[^"\\])*"|[^\s,]/g) || []).filter(t => !t.startsWith('#'));
  let i = 0;
  const take = (s: string) => { if (tokens[i++] !== s) throw new Error(`Expected ${s}`); };
  const value = (): any => {
    const t = tokens[i++];
    if (t === '$') return variables[tokens[i++]];
    if (t === '{') { const obj: any = {}; while (tokens[i] !== '}') { const key = tokens[i++]; take(':'); obj[key] = value(); } i++; return obj; }
    if (t === '[') { const list = []; while (tokens[i] !== ']') list.push(value()); i++; return list; }
    if (t?.startsWith('"')) return JSON.parse(t);
    if (t === 'null') return null;
    if (t === 'true' || t === 'false') return t === 'true';
    if (/^-?\d/.test(t || '')) return Number(t);
    if (!t) throw new Error('Unexpected end of document');
    return t;
  };
  const selection = (): Field[] => {
    take('{'); const fields: Field[] = [];
    while (tokens[i] !== '}') {
      if (!tokens[i]) throw new Error('Unclosed selection');
      if (tokens[i] === '...') { i++; take('on'); const fragment = tokens[i++]; fields.push({ name: '', alias: '', args: {}, fields: selection(), fragment }); continue; }
      let name = tokens[i++], alias = name;
      if (tokens[i] === ':') { i++; name = tokens[i++]; }
      const args: any = {};
      if (tokens[i] === '(') { i++; while (tokens[i] !== ')') { const key = tokens[i++]; take(':'); args[key] = value(); } i++; }
      fields.push({ name, alias, args, fields: tokens[i] === '{' ? selection() : [] });
    }
    i++; return fields;
  };
  if (tokens[i] === 'query' || tokens[i] === 'mutation') {
    i++; if (tokens[i] !== '(' && tokens[i] !== '{') i++;
    if (tokens[i] === '(') { let depth = 0; do { const t = tokens[i++]; if (t === '(') depth++; if (t === ')') depth--; if (i > tokens.length) throw new Error('Unclosed variables'); } while (depth); }
  }
  return selection();
}
const schema: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'], Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login'], Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Issue: ['id', 'number', 'title', 'state', 'body'], PullRequest: ['id', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
};
const enums: Record<string, string[]> = { SearchType: ['ISSUE', 'REPOSITORY', 'USER'], IssueState: ['OPEN', 'CLOSED'], PullRequestState: ['OPEN', 'CLOSED', 'MERGED'], MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'], PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'], RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'], IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'], OrderDirection: ['ASC', 'DESC'] };
function typed(type: string, data: any, repo?: Repository): any { return { ...data, __type: type, __repo: repo }; }
function nodeId(type: string, id: number): string { return Buffer.from(`${type}:${id}`).toString('base64'); }
export function graphql(store: Store, operation: any): any {
  if (Array.isArray(operation)) return operation.map(o => graphql(store, o));
  const errors: any[] = [];
  try {
    if (typeof operation.query !== 'string') throw new Error('Query is required');
    const fields = parse(operation.query, operation.variables || {});
    const issueView = (repo: Repository, issue: any) => issue ? typed('Issue', { ...issue, id: nodeId('Issue', issue.id), state: issue.state.toUpperCase() }, repo) : null;
    const pullView = (repo: Repository, pull: any) => pull ? typed('PullRequest', { ...pull, id: nodeId('PullRequest', pull.id), state: pull.merged ? 'MERGED' : pull.state.toUpperCase(), headRefName: pull.head.ref, baseRefName: pull.base.ref, mergeable: 'MERGEABLE' }, repo) : null;
    const repoView = (repo: Repository) => typed('Repository', { id: nodeId('Repository', repo.id), databaseId: repo.id, name: repo.name, nameWithOwner: `${store.owner}/${repo.name}`, owner: typed('User', { login: store.owner }), defaultBranchRef: repo.refs.size ? { name: repo.default_branch } : null, viewerPermission: 'ADMIN', hasIssuesEnabled: true }, repo);
    const findNode = (id: string): any => {
      for (const repo of store.repos.values()) {
        if (nodeId('Repository', repo.id) === id) return repoView(repo);
        for (const issue of repo.issues.values()) if (nodeId('Issue', issue.id) === id) return issueView(repo, issue);
        for (const pull of repo.pulls.values()) if (nodeId('PullRequest', pull.id) === id) return pullView(repo, pull);
      }
      return null;
    };
    const resolve = (object: any, field: Field): any => {
      const type = object.__type, a = field.args, repo: Repository = object.__repo;
      if (field.name === '__typename') return type;
      if (schema[type] && !schema[type].includes(field.name)) { errors.push({ message: `Cannot query field "${field.name}" on type "${type}".` }); return null; }
      if (type === 'Query' || type === 'Mutation') {
        switch (field.name) {
          case 'viewer': return typed('User', { login: store.owner || 'user' });
          case '__type': return { name: a.name, fields: (schema[a.name] || []).map(name => ({ name })), enumValues: (enums[a.name] || []).map(name => ({ name })) };
          case 'repository': { try { return repoView(store.getRepo(a.owner, a.name)); } catch (e) { if (e instanceof ApiError && e.status === 404) return null; throw e; } }
          case 'node': return findNode(a.id);
        }
        const input = a.input || {};
        const node = findNode(input.repositoryId || input.issueId || input.pullRequestId || input.subjectId);
        if (!node) throw new Error('Node not found');
        const r = node.__repo;
        switch (field.name) {
          case 'createIssue': return { issue: issueView(r, createIssue(store, r, input)) };
          case 'closeIssue': { const issue = r.issues.get(node.number); issue.state = 'closed'; return { issue: issueView(r, issue) }; }
          case 'createPullRequest': return { pullRequest: pullView(r, createPull(store, r, { ...input, head: input.headRefName, base: input.baseRefName })) };
          case 'mergePullRequest': { const pull = r.pulls.get(node.number); mergePull(r, pull); return { pullRequest: pullView(r, pull) }; }
          case 'addComment': { const comment = addComment(store, r, node.number, input.body); return { commentEdge: { node: { ...comment, id: nodeId('Comment', comment.id) } } }; }
        }
      }
      if (type === 'Repository') {
        if (field.name === 'issue') return issueView(repo, repo.issues.get(a.number));
        if (field.name === 'pullRequest') return pullView(repo, repo.pulls.get(a.number));
        if (field.name === 'issues') {
          let all = listIssues(repo, 'all', a.orderBy?.direction === 'ASC' ? 'asc' : 'desc');
          if (a.states) all = all.filter(x => a.states.includes(x.state.toUpperCase()));
          const start = a.after ? Number(Buffer.from(a.after, 'base64').toString().split(':')[1]) : 0;
          const first = Math.max(0, Math.min(100, a.first ?? 30)), nodes = all.slice(start, start + first);
          return { nodes: nodes.map(x => issueView(repo, x)), pageInfo: { hasNextPage: start + first < all.length, endCursor: nodes.length ? Buffer.from(`cursor:${start + nodes.length}`).toString('base64') : null } };
        }
        if (field.name === 'pullRequests') return { nodes: [...repo.pulls.values()].filter(p => p.state === 'open').slice(0, a.first ?? 30).map(p => pullView(repo, p)) };
      }
      if (type === 'PullRequest' && field.name === 'files') return { nodes: pullFiles(repo, repo.pulls.get(object.number)).slice(0, a.first ?? 30).map(f => ({ path: f.filename })) };
      if (!(field.name in object)) { errors.push({ message: `Cannot query field "${field.name}".` }); return null; }
      return object[field.name];
    };
    const execute = (object: any, selections: Field[]): any => {
      if (object === null || object === undefined) return null;
      if (Array.isArray(object)) return object.map(x => execute(x, selections));
      if (!selections.length) return object;
      const result: any = {};
      for (const f of selections) {
        if (f.fragment) { if (object.__type === f.fragment) Object.assign(result, execute(object, f.fields)); continue; }
        result[f.alias] = execute(resolve(object, f), f.fields);
      }
      return result;
    };
    const data = execute(typed(/^\s*mutation\b/.test(operation.query) ? 'Mutation' : 'Query', {}), fields);
    return errors.length ? { data, errors } : { data };
  } catch (error) { return { data: null, errors: [{ message: error instanceof Error ? error.message : 'GraphQL error' }] }; }
}
