import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { BrainEngine } from '../core/engine.ts';
import { operations } from '../core/operations.ts';
import { VERSION } from '../version.ts';
import { buildToolDefs } from './tool-defs.ts';
import { dispatchToolCall, validateParams, buildOperationContext } from './dispatch.ts';
import { getBrainHotMemoryMeta } from '../core/facts/meta-hook.ts';
import { loadConfig } from '../core/config.ts';
import {
  resolveSocketPath,
  startResolveIpcServer,
  cleanupStaleSocket,
} from '../core/context/resolve-ipc.ts';
import { resolveEntitiesToPointers, logDeliveredReflexPointers } from '../core/context/retrieval-reflex.ts';

/**
 * LOCAL PATCH (Egor): federated READ grant for the stdio MCP caller.
 *
 * Upstream pins the stdio caller's ctx.sourceId to 'default' (see the dispatch
 * call below), and `resolveRequestedScope` is fail-closed for remote callers —
 * an omitted `source_id` OR `__all__` both collapse to the caller's grant. With
 * no grant, that grant is just the scalar 'default', so an unqualified agent
 * query only ever searches the `default` source. A multi-source brain's OTHER
 * federated sources are invisible over MCP unless the agent names them, even
 * though `gbrain query` on the CLI federates across them automatically.
 *
 * This returns every federated source id so the dispatch below can hand the
 * stdio caller a federated `allowedSources` READ scope (sourceScopeOpts then
 * emits `{sourceIds}` and the query/search/get_page ops span them all). WRITE
 * authority stays scalar at ctx.sourceId='default', so `put_page` is unaffected
 * (allowedSources is read-only federation, independent of write target — see the
 * AuthInfo doc in operations.ts).
 *
 * Cheap id+config query on purpose: `listSources` counts pages per source, which
 * is wasted work on the per-call hot path. Archived sources are excluded so a
 * soft-deleted source is never silently re-granted. Fail-closed: any error → []
 * → sourceScopeOpts falls back to the scalar 'default' scope (upstream behavior).
 * Resolved per-call so a freshly added/federated source is visible without a
 * `gbrain serve` restart. Re-apply after gbrain updates; replicate on VPS.
 */
async function federatedReadGrant(engine: BrainEngine): Promise<string[]> {
  try {
    const rows = await engine.executeRaw<{ id: string; config: unknown }>(
      `SELECT id, config FROM sources WHERE archived IS NOT TRUE`,
    );
    return rows
      .filter((r) => {
        const cfg =
          typeof r.config === 'string'
            ? (() => {
                try {
                  return JSON.parse(r.config as string) as Record<string, unknown>;
                } catch {
                  return {};
                }
              })()
            : ((r.config ?? {}) as Record<string, unknown>);
        return cfg.federated === true;
      })
      .map((r) => r.id);
  } catch {
    return []; // fail-closed → scalar sourceId='default' scope (upstream behavior)
  }
}

export async function startMcpServer(engine: BrainEngine) {
  const server = new Server(
    { name: 'gbrain', version: VERSION },
    { capabilities: { tools: {} } },
  );

  // Generate tool definitions from operations. Extracted to buildToolDefs so
  // the subagent tool registry (v0.15+) can call the same mapper against a
  // filtered OPERATIONS subset instead of duplicating this shape.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: buildToolDefs(operations),
  }));

  // Dispatch tool calls via shared dispatch.ts (parity with HTTP transport).
  // MCP stdio callers are remote/untrusted; dispatch defaults remote=true.
  // The MCP SDK's response type widened in 1.29 to allow a managed-task wrapper;
  // gbrain ops are synchronous, so we return the legacy `{ content, isError? }`
  // shape and cast through `any` (the SDK accepts it via the ServerResult union).
  server.setRequestHandler(CallToolRequestSchema, async (request: any): Promise<any> => {
    const { name, arguments: params } = request.params;
    // v0.28: stdio MCP has no per-token auth (local pipe). Default the
    // takes-holder allow-list to ['world'] so agent-facing callers don't
    // see private hunches via takes_list / takes_search / query. Operators
    // who want stdio to see everything should call ops directly via
    // `gbrain call <op>` (sets remote=false in src/cli.ts).
    // v0.31: source defaults to 'default' for stdio (no per-token scope).
    // Operators who want a different source on stdio MCP should set
    // GBRAIN_SOURCE in the env or use --source via `gbrain call`.
    const sourceId = process.env.GBRAIN_SOURCE || 'default';
    // LOCAL PATCH (Egor): grant the stdio caller a federated READ scope across
    // every federated source so an unqualified agent query federates like the
    // CLI does (see federatedReadGrant). WRITE authority stays scalar at
    // `sourceId` (put_page still lands in 'default'). An explicit GBRAIN_SOURCE
    // pin opts out — the operator chose one source on purpose, so no grant.
    // Synthetic stdio identity. stdio is a local pipe with no OAuth token, but
    // AuthInfo requires token/clientId/scopes — these satisfy the type. scopes:[]
    // mirrors pre-patch behavior EXACTLY (ctx.auth was undefined, so every
    // `ctx.auth?.scopes ?? []` read already saw []), so no op gains or loses a
    // privilege; the ONLY thing added is `allowedSources` (federated READ scope).
    // Note: this tightens explicit access — naming a NON-federated source over
    // MCP now returns permission_denied (the correct isolation posture; federate
    // a source, or set GBRAIN_SOURCE, to read it over MCP).
    const auth = process.env.GBRAIN_SOURCE
      ? undefined
      : {
          token: 'stdio-local',
          clientId: 'stdio-local',
          clientName: 'stdio-local',
          scopes: [],
          allowedSources: await federatedReadGrant(engine),
        };
    return dispatchToolCall(engine, name, params, {
      remote: true,
      takesHoldersAllowList: ['world'],
      sourceId,
      ...(auth ? { auth } : {}),
      // v0.31 (eD3): _meta.brain_hot_memory injection so Claude Desktop /
      // Code see the brain's relevant hot memory automatically alongside
      // every tool-call response. Best-effort; absorbs errors.
      metaHook: getBrainHotMemoryMeta,
    });
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Retrieval Reflex (#1981, D9=C): on a PGLite brain, serve owns the single
  // connection, so the context engine resolves salient entities THROUGH us over
  // a local unix socket rather than opening a second (impossible) connection.
  // Best-effort; failure to bind never blocks the MCP server.
  let resolveServer: import('node:net').Server | null = null;
  let resolveSocket: string | null = null;
  try {
    const cfg = loadConfig();
    if (cfg?.engine === 'pglite' && cfg.database_path) {
      resolveSocket = resolveSocketPath(cfg.database_path);
      const defaultSource = process.env.GBRAIN_SOURCE || 'default';
      resolveServer = await startResolveIpcServer(
        resolveSocket,
        (req) =>
          resolveEntitiesToPointers(
            engine,
            req.sourceId || defaultSource,
            req.candidates ?? [],
            {
              priorContextText: req.priorContextText,
              maxPointers: req.maxPointers,
              suppression: req.suppression,
            },
          ),
        // The IPC resolve path IS the ambient reflex channel. Logging happens
        // at DELIVERY (post-write), not inside the resolver — a block the
        // client's 250ms budget abandoned was never injected, and counting it
        // would corrupt the volunteered-vs-used precision stats (red-team).
        (block) => logDeliveredReflexPointers(engine, block.pointers),
      );
    }
  } catch {
    /* resolve IPC is best-effort; never block serve */
  }

  // Exit cleanly when MCP client disconnects (stdin EOF) or on signals.
  // Without this, orphaned serve processes accumulate and contend for the
  // PGLite write lock, causing ingest jobs (email-sync) to time out.
  let shuttingDown = false;
  const shutdown = (reason: string, code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`[gbrain-serve] shutdown: ${reason}\n`);
    try { resolveServer?.close(); } catch { /* noop */ }
    if (resolveSocket) cleanupStaleSocket(resolveSocket);
    Promise.resolve(engine.disconnect?.())
      .catch(() => {})
      .finally(() => process.exit(code));
  };
  // v0.34.1 (#870): when MCP_STDIO=1, the wrapping gateway (OpenClaw's
  // bundle-mcp layer, others) often pipes the JSON-RPC handshake then
  // closes its stdin half. Treating that as a permanent disconnect kills
  // the server before the first tool call arrives. Signal handlers and
  // transport.onclose still cover the legitimate shutdown paths.
  if (process.env.MCP_STDIO !== '1') {
    process.stdin.on('end', () => shutdown('stdin end'));
    process.stdin.on('close', () => shutdown('stdin close'));
  }
  // @ts-ignore — SDK exposes onclose on transport
  transport.onclose = () => shutdown('transport close');
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));
}

// Backward compat: used by `gbrain call` command (trusted local path).
// v0.31.8 (D22): accept opts.sourceId so `gbrain call --source X <op> <json>`
// can scope the op handler to that source. resolveSourceId() in call.ts is
// the upstream resolver; this layer just passes the resolved id through.
export async function handleToolCall(
  engine: BrainEngine,
  tool: string,
  params: Record<string, unknown>,
  opts?: { sourceId?: string },
): Promise<unknown> {
  const op = operations.find(o => o.name === tool);
  if (!op) throw new Error(`Unknown tool: ${tool}`);

  const validationError = validateParams(op, params);
  if (validationError) throw new Error(validationError);

  const ctx = buildOperationContext(engine, params, {
    remote: false,
    logger: { info: console.log, warn: console.warn, error: console.error },
    ...(opts?.sourceId ? { sourceId: opts.sourceId } : {}),
  });

  return op.handler(ctx, params);
}
