import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  AuthLevel,
  RegistryService,
  ResourceStatus,
  ResourceType,
  ToolRegistryStore,
  getCurrentToolRegistryEnvironment,
  type Level2CapabilityMeta,
  type Level3McpSchema,
  type Level3Schema,
  type Level3ToolSchema,
  type RegisterInput,
} from "../../tools/tool-search/registry/index.js";
import { HybridRetrievalEngine, type HybridRetrievedResource } from "../../tools/tool-search/retrieval/hybrid-retrieval.js";
import { AdaptiveTopPSelector } from "../../tools/tool-search/top-p-selector/top-p-selector.js";
import { HistoryScoreStore } from "../../tools/tool-search/retrieval/history-score.js";
import { ToolKnowledgeGraphService } from "../../tools/tool-search/knowledge-graph/neo4j-client.js";
import { ResourceLazyLoader } from "../../tools/tool-search/lazy-loader/lazy-loader.js";
import { McpConnectionPool } from "../../tools/tool-search/lazy-loader/mcp-connection-pool.js";
import { ToolRerankingPipeline } from "../../tools/tool-search/reranking/reranking-pipeline.js";
import { createNeuralLlmReranker } from "../../tools/tool-search/reranking/neural-reranker.js";
import { normalizeGraphRelation } from "../../tools/tool-search/knowledge-graph/graph-relations.js";
import { toolSearchMetrics } from "../../tools/tool-search/observability/metrics.js";

type ToolSearchRuntime = {
  store: ToolRegistryStore;
  registry: RegistryService;
  retrieval: HybridRetrievalEngine;
  topP: AdaptiveTopPSelector;
  history: HistoryScoreStore;
  graph: ToolKnowledgeGraphService;
  lazyLoader: ResourceLazyLoader;
  mcpPool: McpConnectionPool;
  reranker: ToolRerankingPipeline;
};

let runtimePromise: Promise<ToolSearchRuntime> | null = null;

const level2Schema = z
  .object({
    input_type: z.string().default("object"),
    output_type: z.string().default("object"),
    use_cases: z.array(z.string()).default([]),
    limitations: z.array(z.string()).default([]),
    preconditions: z.array(z.string()).default([]),
    dependencies: z.array(z.string()).default([]),
  })
  .strict();

const registerBodySchema = z
  .object({
    resource_id: z.string().optional(),
    resource_type: z.enum([
      ResourceType.Tool,
      ResourceType.Skill,
      ResourceType.McpServer,
    ]),
    name: z.string().min(1),
    description: z.string().default(""),
    domain: z.array(z.string()).min(1),
    capability: z.array(z.string()).min(1),
    tags: z.array(z.string()).default([]),
    version: z.string().default("1.0.0"),
    base_score: z.number().min(0).max(1).optional(),
    embeddings: z.array(z.array(z.number())).optional(),
    embedding: z.array(z.number()).optional(),
    level2: level2Schema,
    level3: z.record(z.unknown()),
    tenant_id: z.string().optional(),
    auth_level: z.enum([AuthLevel.Default, AuthLevel.Admin, AuthLevel.Guest]).optional(),
    graph_relations: z
      .array(
        z.object({
          relation_type: z.string().refine((v) => normalizeGraphRelation(v) != null, {
            message: "unsupported graph relation type",
          }),
          target_resource_id: z.string().min(1),
          weight: z.number().min(0).max(1).optional(),
        }),
      )
      .optional(),
  })
  .strict();

const searchBodySchema = z
  .object({
    raw_user_query: z.string().min(1),
    agent_context_hash: z.string().default("default"),
    query_vector: z.array(z.number()).optional(),
    limit: z.number().int().min(1).max(100).default(25),
    previous_tool_result: z.unknown().optional(),
    blacklist_resource_ids: z.array(z.string()).default([]),
  })
  .strict();

const loadBodySchema = z
  .object({
    resource_id: z.string().min(1),
  })
  .strict();

const executeBodySchema = z
  .object({
    resource_id: z.string().min(1),
    parameters: z.record(z.unknown()).default({}),
    rpc_method: z.string().optional(),
    timeout_ms: z.number().int().min(1).max(60_000).optional(),
  })
  .strict();

const graphQuerySchema = z
  .object({
    source_resource_id: z.string().optional(),
    target_resource_id: z.string().optional(),
    relation_type: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(25),
  })
  .strict();

export function registerToolRegistryRoutes(app: FastifyInstance): void {
  app.post("/api/resource/register", async (request, reply) => {
    const started = Date.now();
    const parsed = registerBodySchema.safeParse(request.body);
    if (!parsed.success) return validationError(reply, parsed.error);
    const tenant = resolveTenantId(request, parsed.data.tenant_id);
    if (!tenant) return tenantError(reply);

    const runtime = await getRuntime();
    const input: RegisterInput = {
      ...parsed.data,
      tenant_id: tenant,
      embedding: parsed.data.embedding ?? hashTextToVector(parsed.data.name + parsed.data.description, 16),
      level2: {
        ...parsed.data.level2,
        resource_id: parsed.data.resource_id ?? "",
      } satisfies Level2CapabilityMeta,
      level3: parsed.data.level3 as Level3Schema,
      graph_relations: parsed.data.graph_relations ?? [],
    };
    const result = await runtime.registry.register(input);
    if (!result.ok) {
      return reply.code(400).send(envelope(false, tenant, started, result));
    }
    return reply.code(201).send(envelope(true, tenant, started, result));
  });

  app.post("/api/resource/search", async (request, reply) => {
    const started = Date.now();
    const parsed = searchBodySchema.safeParse(request.body);
    if (!parsed.success) return validationError(reply, parsed.error);
    const tenant = resolveTenantId(request);
    if (!tenant) return tenantError(reply);
    const runtime = await getRuntime();
    toolSearchMetrics.recordSearch();
    // 2026-10-01 单评分器归一：诊断检索直接走 hybrid 引擎（与主链路同评分核心），
    // 规则意图分解层已退役。
    const candidates = await runtime.registry.listByTenant(tenant);
    const retrieved = await runtime.retrieval.search({
      query: parsed.data.raw_user_query,
      candidates,
      queryVector: parsed.data.query_vector,
      limit: parsed.data.limit,
    });
    return envelope(true, tenant, started, {
      candidates: retrieved.map(toCandidateWire),
      candidate_count: retrieved.length,
    });
  });

  app.post("/api/resource/load", async (request, reply) => {
    const started = Date.now();
    const parsed = loadBodySchema.safeParse(request.body);
    if (!parsed.success) return validationError(reply, parsed.error);
    const tenant = resolveTenantId(request);
    if (!tenant) return tenantError(reply);
    const runtime = await getRuntime();
    toolSearchMetrics.recordLazyLoad();
    const result = await runtime.lazyLoader.load(parsed.data.resource_id);
    const code = result.ok ? 200 : result.error_code === "RESOURCE_NOT_FOUND" ? 404 : 400;
    return reply.code(code).send(envelope(result.ok, tenant, started, result));
  });

  app.post("/api/resource/execute", async (request, reply) => {
    const started = Date.now();
    const parsed = executeBodySchema.safeParse(request.body);
    if (!parsed.success) return validationError(reply, parsed.error);
    const tenant = resolveTenantId(request);
    if (!tenant) return tenantError(reply);
    const runtime = await getRuntime();
    toolSearchMetrics.recordExecute();
    const result = await executeResource(runtime, parsed.data);
    const code = result.ok ? 200 : result.error_code === "RESOURCE_NOT_FOUND" ? 404 : 400;
    return reply.code(code).send(envelope(result.ok, tenant, started, result));
  });

  app.get("/api/resource/health-check", async (request, reply) => {
    const started = Date.now();
    const tenant = resolveTenantId(request);
    if (!tenant) return tenantError(reply);
    const runtime = await getRuntime();
    const query = request.query as { resource_id?: string } | undefined;
    if (query?.resource_id) {
      const record = await runtime.store.getRecord(query.resource_id);
      if (!record) {
        return reply
          .code(404)
          .send(envelope(false, tenant, started, { error_code: "RESOURCE_NOT_FOUND" }));
      }
      return envelope(true, tenant, started, {
        resources: [healthSummary(record.level1.resource_id, record.level1.status)],
        lazy_loader_cache: runtime.lazyLoader.cacheStats(),
        mcp_connections: runtime.mcpPool.listStates(),
      });
    }
    const records = await runtime.registry.listByTenant(tenant);
    return envelope(true, tenant, started, {
      resources: records.map((r) => healthSummary(r.level1.resource_id, r.level1.status)),
      lazy_loader_cache: runtime.lazyLoader.cacheStats(),
      mcp_connections: runtime.mcpPool.listStates(),
    });
  });

  app.post("/api/graph/query", async (request, reply) => {
    const started = Date.now();
    const parsed = graphQuerySchema.safeParse(request.body);
    if (!parsed.success) return validationError(reply, parsed.error);
    const tenant = resolveTenantId(request);
    if (!tenant) return tenantError(reply);
    if (parsed.data.relation_type && !normalizeGraphRelation(parsed.data.relation_type)) {
      return reply.code(400).send(
        envelope(false, tenant, started, {
          error_code: "INVALID_GRAPH_RELATION",
          error_message: `unsupported relation_type ${parsed.data.relation_type}`,
        }),
      );
    }
    const runtime = await getRuntime();
    toolSearchMetrics.recordGraphQuery();
    const edges = await runtime.graph.query(parsed.data);
    return envelope(true, tenant, started, { edges });
  });

  app.get("/api/tool-search/metrics", async (request, reply) => {
    const runtime = await getRuntime();
    const query = request.query as { format?: string } | undefined;
    if (query?.format === "prometheus") {
      return reply
        .type("text/plain; version=0.0.4")
        .send(toolSearchMetrics.toPrometheus());
    }
    return {
      ok: true,
      metrics: toolSearchMetrics.snapshot(),
      lazy_loader_cache: runtime.lazyLoader.cacheStats(),
      mcp_connections: runtime.mcpPool.listStates(),
    };
  });

  app.post<{ Params: { id: string } }>(
    "/api/resource/:id/version/publish",
    async (request, reply) => {
      const started = Date.now();
      const tenant = resolveTenantId(request);
      if (!tenant) return tenantError(reply);
      const body = z
        .object({ version: z.string(), is_canary: z.boolean().default(false) })
        .safeParse(request.body);
      if (!body.success) return validationError(reply, body.error);
      const runtime = await getRuntime();
      const result = await runtime.registry.publishVersion(
        request.params.id,
        body.data.version,
        body.data.is_canary,
      );
      await runtime.lazyLoader.invalidate(request.params.id);
      return reply.code(result.ok ? 200 : 400).send(envelope(result.ok, tenant, started, result));
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/resource/:id/version/rollback",
    async (request, reply) => {
      const started = Date.now();
      const tenant = resolveTenantId(request);
      if (!tenant) return tenantError(reply);
      const body = z.object({ target_version: z.string() }).safeParse(request.body);
      if (!body.success) return validationError(reply, body.error);
      const runtime = await getRuntime();
      const result = await runtime.registry.rollbackVersion(
        request.params.id,
        body.data.target_version,
      );
      await runtime.lazyLoader.invalidate(request.params.id);
      return reply.code(result.ok ? 200 : 400).send(envelope(result.ok, tenant, started, result));
    },
  );
}

async function getRuntime(): Promise<ToolSearchRuntime> {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const store = new ToolRegistryStore();
      await store.initialize();
      const history = new HistoryScoreStore();
      const graph = new ToolKnowledgeGraphService(store);
      const retrieval = new HybridRetrievalEngine({ historyStore: history });
      const lazyLoader = new ResourceLazyLoader(store, graph);
      return {
        store,
        registry: new RegistryService(store),
        retrieval,
        topP: new AdaptiveTopPSelector(),
        history,
        graph,
        lazyLoader,
        mcpPool: new McpConnectionPool(),
        // 与检索主链路同构（金丝雀评估才反映生产行为）：神经重排钩子一并注入
        reranker: new ToolRerankingPipeline({ llmReranker: createNeuralLlmReranker() }),
      };
    })();
  }
  return runtimePromise;
}

async function executeResource(
  runtime: ToolSearchRuntime,
  input: z.infer<typeof executeBodySchema>,
): Promise<Record<string, unknown> & { ok: boolean }> {
  const loaded = await runtime.lazyLoader.load(input.resource_id);
  if (!loaded.ok || !loaded.schema) {
    return {
      ok: false,
      error_code: loaded.error_code ?? "SCHEMA_LOAD_FAILED",
      error_message: loaded.error_message ?? "schema load failed",
    };
  }
  const validation = validateToolParameters(loaded.schema, input.parameters);
  if (!validation.ok) return validation;

  if (isMcpSchema(loaded.schema)) {
    const method = input.rpc_method ?? loaded.schema.rpc_methods[0];
    if (!method) {
      return {
        ok: false,
        error_code: "MCP_METHOD_REQUIRED",
        error_message: "rpc_method is required for MCP resource",
      };
    }
    const result = await runtime.mcpPool.call(
      loaded.schema,
      method,
      input.parameters,
      input.timeout_ms ?? 10_000,
    );
    return result.ok
      ? { ok: true, result: result.result, mcp_state: result.state }
      : {
          ok: false,
          error_code: result.error_code,
          error_message: result.error_message,
          mcp_state: result.state,
          alternatives: (await runtime.graph.getAlternatives(input.resource_id)).map(
            (r) => r.level1.resource_id,
          ),
        };
  }

  return {
    ok: true,
    resource_id: input.resource_id,
    validated: true,
    dry_run: true,
    schema_loaded_from_cache: loaded.cache_hit,
    dependency_substitutions: loaded.dependency_substitutions,
  };
}

function validateToolParameters(
  schema: Level3Schema,
  params: Record<string, unknown>,
): { ok: true } | { ok: false; error_code: string; error_message: string } {
  if (!isToolSchema(schema)) return { ok: true };
  const missing = schema.required_fields.filter((field) => params[field] === undefined);
  if (missing.length > 0) {
    return {
      ok: false,
      error_code: "MISSING_REQUIRED_PARAMETERS",
      error_message: `missing required parameters: ${missing.join(", ")}`,
    };
  }
  return { ok: true };
}

function isToolSchema(schema: Level3Schema): schema is Level3ToolSchema {
  return (schema as { parameters?: unknown }).parameters !== undefined;
}

function isMcpSchema(schema: Level3Schema): schema is Level3McpSchema {
  return (schema as { transport?: unknown }).transport !== undefined;
}

function toCandidateWire(candidate: HybridRetrievedResource): Record<string, unknown> {
  const record = candidate.resource;
  return {
    resource_id: record.level1.resource_id,
    resource_type: record.level1.resource_type,
    name: record.level1.name,
    description: record.level1.description,
    domain: record.level1.domain,
    capability: record.level1.capability,
    version: record.level1.version,
    status: record.level1.status,
    score: candidate.final_score,
    score_components: candidate.components,
    parameter_hint: {
      input_type: record.level2.input_type,
      output_type: record.level2.output_type,
      required_dependencies: record.level2.dependencies,
    },
  };
}

function resolveTenantId(request: FastifyRequest, fallback?: string): string | null {
  const header = request.headers["x-tenant-id"];
  const tenant = (Array.isArray(header) ? header[0] : header) ?? fallback;
  const normalized = tenant?.trim();
  return normalized || null;
}

function envelope(
  ok: boolean,
  tenantId: string,
  startedAt: number,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const elapsed = Date.now() - startedAt;
  toolSearchMetrics.recordHttp(ok, elapsed);
  return {
    ok,
    tenant_id: tenantId,
    environment: getCurrentToolRegistryEnvironment(),
    elapsed_ms: elapsed,
    ...body,
  };
}

function validationError(reply: FastifyReply, error: z.ZodError): FastifyReply {
  return reply.code(400).send({ ok: false, error: error.flatten() });
}

function tenantError(reply: FastifyReply): FastifyReply {
  return reply.code(400).send({
    ok: false,
    error_code: "TENANT_ID_REQUIRED",
    error_message: "x-tenant-id header or tenant_id body field is required",
  });
}

function healthSummary(resourceId: string, status: ResourceStatus): Record<string, unknown> {
  return { resource_id: resourceId, status, alive: status === ResourceStatus.Online };
}

function hashTextToVector(text: string, dim: number): number[] {
  const out = new Array<number>(dim).fill(0);
  const bytes = Buffer.from(text || "tool");
  for (let i = 0; i < dim; i++) {
    out[i] = ((bytes[i % bytes.length] ?? 0) / 127.5) - 1;
  }
  const norm = Math.sqrt(out.reduce((sum, v) => sum + v * v, 0));
  return norm > 0 ? out.map((v) => v / norm) : out;
}
