import { Store } from './store.ts';
import { createIssue, listIssues, createPull, mergePull } from './collaboration.ts';

const definitions: [string, string, string[], string[]][] = [
  ['create_repo', 'Create a repository in the authenticated namespace.', ['name', 'description', 'private'], ['name']],
  ['get_repo', 'Read a repository by owner and repository name.', ['owner', 'repo'], ['owner', 'repo']],
  ['create_issue', 'Open an issue with a title and optional body.', ['owner', 'repo', 'title', 'body'], ['owner', 'repo', 'title']],
  ['list_issues', 'List repository issues filtered by state.', ['owner', 'repo', 'state'], ['owner', 'repo']],
  ['create_pull_request', 'Open a pull request between existing branches.', ['owner', 'repo', 'title', 'body', 'head', 'base'], ['owner', 'repo', 'title', 'head', 'base']],
  ['merge_pull_request', 'Squash merge a pull request unless its changes conflict.', ['owner', 'repo', 'pull_number'], ['owner', 'repo', 'pull_number']],
];
const tools = definitions.map(([name, description, properties, required]) => ({ name, description, inputSchema: {
  type: 'object', properties: Object.fromEntries(properties.map(p => [p, { type: p === 'private' ? 'boolean' : p === 'pull_number' ? 'integer' : 'string' }])), required,
} }));
const serverInfo = { name: 'memory-forge', version: '1.0.0' };
export function mcp(store: Store, request: any): [number, any] {
  const id = request?.id ?? null;
  const error = (code: number, message: string): [number, any] => [200, { jsonrpc: '2.0', id, error: { code, message } }];
  const success = (result: any): [number, any] => [200, { jsonrpc: '2.0', id, result }];
  if (request?.jsonrpc !== '2.0' || typeof request.method !== 'string') return error(-32600, 'Invalid Request');
  if (request.method === 'server/discover') return success({ supportedVersions: ['2026-07-28'], serverInfo, capabilities: { tools: {} } });
  if (request.method === 'initialize') return success({ protocolVersion: '2025-11-25', serverInfo, capabilities: { tools: {} } });
  if (request.method === 'notifications/initialized') return [202, null];
  if (request.method === 'tools/list') return success({ tools });
  if (request.method === 'ping') return success({});
  if (request.method !== 'tools/call') return error(-32601, 'Method not found');
  const params = request.params || {}, tool = tools.find(t => t.name === params.name);
  if (!tool) return error(-32602, 'Unknown tool');
  const a = params.arguments;
  if (!a || typeof a !== 'object' || tool.inputSchema.required.some(p => a[p] === undefined || a[p] === null || a[p] === '')) return error(-32602, 'Missing required arguments');
  for (const [name, schema] of Object.entries(tool.inputSchema.properties)) {
    if (a[name] !== undefined && (schema.type === 'integer' ? !Number.isInteger(a[name]) : typeof a[name] !== schema.type)) return error(-32602, `Invalid argument: ${name}`);
  }
  try {
    let value: any;
    if (tool.name === 'create_repo') value = store.repoView(store.createRepo(a));
    else {
      const repo = store.getRepo(a.owner, a.repo);
      switch (tool.name) {
        case 'get_repo': value = store.repoView(repo); break;
        case 'create_issue': value = createIssue(store, repo, a); break;
        case 'list_issues': value = listIssues(repo, a.state || 'open'); break;
        case 'create_pull_request': value = createPull(store, repo, a); break;
        case 'merge_pull_request': {
          const pull = repo.pulls.get(a.pull_number); if (!pull) throw new Error('Pull request not found');
          value = mergePull(repo, pull); break;
        }
      }
    }
    return success({ content: [{ type: 'text', text: JSON.stringify(value) }], isError: false });
  } catch (e) { return success({ content: [{ type: 'text', text: e instanceof Error ? e.message : 'Tool execution failed' }], isError: true }); }
}
