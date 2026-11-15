# Memory Forge

A standalone, dependency-free GitHub-compatible in-memory forge for Node 22.
No git subprocess, installation step, external API, or persistent storage is used.

## Run

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:9 MAKEFUN_SHOP_TOKEN=test-token node main.ts
```

The unchanged starter lifecycle binds an ephemeral port and prints it, registers
with the environment, and exits only when the environment reports completion.
The dummy environment above is for local testing; registration retries while HTTP
requests are served.

## Implemented surfaces

- Authenticated REST v3 repositories, pagination, branches, commits, Git refs,
  contents, labels, issues, comments, pull requests, files, and squash merges.
- Git upload-pack v2 (and v0 compatibility), receive-pack v0, SHA-1 objects,
  checksummed packs, OFS/REF delta decoding, shallow fetch/deepen, annotated tags,
  per-ref fast-forward enforcement, and sideband framing.
- Selection-based GraphQL with variables, aliases, inline fragments, schema
  probes, cursor pagination, shared-store mutations, and batched operations.
- Streamable HTTP MCP discovery and six shared-store tools, input validation,
  per-request JSON-RPC IDs, and structured protocol errors.
- Unauthenticated health probe; JSON errors and request IDs.

Git fetch responses are cached by want/have/depth/boundary and invalidated on
pushes. Cache entries are bounded per repository. HTTP connections remain alive
across sequential operations. All generated
object metadata uses a fixed trial timestamp rather than the wall clock.

## Local verification

Verified using the unmodified kit runner on Node v22.23.5. All 120 checks pass:
Git 30/30, repositories 15/15, issues 15/15, pulls 20/20, GraphQL 20/20,
MCP 15/15, protocol 5/5.

Final full-run performance (median of three rounds):

| Workload | Operations | p50 ms | Points |
| --- | ---: | ---: | ---: |
| Push | 200 sequential | 662.534 | 41 |
| Clone | 50 concurrent shallow | 212.773 | 29 |
| Read | 2,000 sequential | 1003.646 | 43 |
| Write | 200 sequential | 141.313 | 41 |

Feature 600 + agent 200 + performance 154 = **954/1000 locally**.
Tie-break `perf_p50_us`: 376029. An earlier baseline scored 964; local timings
vary, and these results do not predict the production sandbox's score.

## Known integration caveats

The contract supplies an opaque token but no login lookup or decoding convention.
The authenticated namespace is learned from the first repository-owner request
and never rebound. A viewer query before owner discovery returns `user`.

The build brief explicitly requires `main.ts` unchanged; it remains byte-for-byte
identical to the starter. The rules separately mention an authored entrypoint
line for transcript attribution. The coordinator must resolve that conflict
before submission. No submit, bundle, or makefun check was run.

## Modules

`store.ts` owns repository state and Git objects; `rest.ts` routes REST;
`collaboration.ts` shares issues/pulls/merge operations; `pack.ts` handles wire
framing and packs; `git.ts` serves smart HTTP; `graphql.ts` parses and executes
selections; `mcp.ts` serves tools; `app.ts` authenticates and dispatches HTTP.

MIT licensed.
