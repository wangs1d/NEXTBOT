// 工具：life.manage —— 用户生活模型（人物关系）管理（LLM 在对话中自主调用）
//
// 生活模型（Life Model）让私人管家能回答「我妹妹叫什么」「我和老王最近怎么样」——
// 这些答案不是一段文本，而是一个实体 + 一条关系边。本工具让模型在对话中：
//   - add    记住一个人/宠物（「我妹妹叫小满」「我家猫叫团子」）
//   - query  查询用户生活里的人物/关系（「我妹妹叫什么」「谁是我的上司」）
//   - list   列出当前已知的关系一览
//   - forget 忘掉某个人（「忘了我说过的那个同事」→ 实体 + 边 + 轨迹三清）
//
// 安全性：写本地生活模型存储（同一 agentic sqlite），无任何外部副作用（不触网、
// 不调第三方），动作全部可回滚（forget 删除 / add 幂等合并别名）。
import type { LifeEntityKind, RelationKind } from "../agentic-memory/life-model-store.js";
import type { LifeModelStore } from "../agentic-memory/life-model-store.js";
import { resolveActorId } from "../agent/actor-id.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

const ENTITY_KINDS: readonly LifeEntityKind[] = ["person", "pet", "org", "place"];
const RELATION_KINDS: readonly RelationKind[] = [
  "family",
  "partner",
  "friend",
  "colleague",
  "acquaintance",
  "pet_owner",
];

/**
 * life.manage 的 LLM 工具声明（并入 getBuiltinAgentChatTools）。
 * 让模型在对话中看到完整的描述与参数；执行体在 registerLifeManageTools。
 */
export const LIFE_MANAGE_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "life.manage",
      description: [
        "用户生活模型（人物关系）管理。",
        "当用户提到生活中的人物/宠物及其与自己的关系时（如「我妹妹叫小满」「我养了只猫叫团子」「我上司姓陈」），",
        "调 action=add 记住这个人和关系（name=名字，relation=关系大类，subKind=具体关系如「妹妹」「上司」，kind=person/pet/org）；",
        "用户问「我妹妹叫什么」「谁是我的上司」「我和某某是什么关系」时调 action=query；",
        "action=list 查看已知的关系一览；用户说「忘掉那个人」时 action=forget（会一并删除该人的关系与轨迹）。",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["add", "query", "list", "forget"],
            description: "操作类型：add 记住并建关系、query 查询、list 一览、forget 忘掉某个人",
          },
          name: {
            type: "string",
            description: "人物/宠物的名字（如「小满」「团子」）；add/query/forget 必填",
          },
          relation: {
            type: "string",
            enum: ["family", "partner", "friend", "colleague", "acquaintance", "pet_owner"],
            description:
              "关系大类：family 家人 / partner 伴侣 / friend 朋友 / colleague 同事 / acquaintance 熟人 / pet_owner 宠物",
          },
          subKind: {
            type: "string",
            description: "具体关系（可选，如「妹妹」「丈夫」「上司」「大学同学」）",
          },
          kind: {
            type: "string",
            enum: ["person", "pet", "org", "place"],
            description: "实体类别：person 人物 / pet 宠物 / org 组织 / place 地点（缺省 person）",
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },
];

/**
 * 注册生活模型管理工具。
 * @param toolRegistry 统一工具注册中心
 * @param store LifeModelStore 实例（装配层注入）
 */
export function registerLifeManageTools(toolRegistry: ToolRegistry, store: LifeModelStore): void {
  toolRegistry.register(
    "life.manage",
    async (input, context) => {
      const action = String(input?.action ?? "").trim().toLowerCase();
      const actorId = resolveActorId(context);
      try {
        switch (action) {
          case "add": {
            const name = String(input?.name ?? "").trim();
            if (!name) return { ok: false, error: "action=add 需要提供 name（人物/宠物名字）" };
            const kindRaw = String(input?.kind ?? "person").trim();
            const kind: LifeEntityKind = ENTITY_KINDS.includes(kindRaw as LifeEntityKind)
              ? (kindRaw as LifeEntityKind)
              : "person";
            const entity = store.upsertEntity({
              actorId,
              kind,
              canonicalName: name,
              confidence: 0.75,
              sourceRef: "life.manage:add",
            });
            if (!entity) return { ok: false, error: "实体登记失败（名字为空或 actor 无效）" };
            let relation: RelationKind | null = null;
            const relationRaw = String(input?.relation ?? "").trim();
            if (relationRaw && RELATION_KINDS.includes(relationRaw as RelationKind)) {
              relation = relationRaw as RelationKind;
            } else if (kind === "pet") {
              relation = "pet_owner";
            }
            if (relation) {
              const selfId = store.ensureSelfEntity(actorId);
              if (selfId) {
                store.upsertEdge({
                  actorId,
                  fromEntityId: selfId,
                  toEntityId: entity.id,
                  kind: relation,
                  subKind: String(input?.subKind ?? "").trim() || null,
                  confidence: 0.7,
                  sourceRef: "life.manage:add",
                });
              }
            }
            return {
              ok: true,
              message: `已记住：${entity.canonicalName}`,
              entity: { name: entity.canonicalName, kind: entity.kind },
              relation: relation ?? null,
            };
          }
          case "query": {
            const name = String(input?.name ?? "").trim();
            if (name) {
              const entity = store.findEntityByName(actorId, name);
              if (!entity) return { ok: true, message: `没有关于「${name}」的记录`, found: false };
              const selfId = store.findEntityByName(actorId, "我")?.id ?? null;
              const edge = selfId
                ? store.getEdges(actorId).find((e) => e.fromEntityId === selfId && e.toEntityId === entity.id)
                : null;
              return {
                ok: true,
                found: true,
                entity: {
                  name: entity.canonicalName,
                  kind: entity.kind,
                  aliases: entity.aliases,
                },
                relation: edge ? { kind: edge.kind, subKind: edge.subKind, intimacy: edge.intimacy } : null,
              };
            }
            // 无名时：从 query 文本里命中实体
            const text = String(input?.query ?? "").trim();
            const hits = text ? store.matchEntitiesInText(actorId, text) : store.listEntities(actorId);
            return {
              ok: true,
              count: hits.length,
              entities: hits.slice(0, 12).map((e) => ({ name: e.canonicalName, kind: e.kind })),
            };
          }
          case "list": {
            const entities = store.listEntities(actorId).filter((e) => e.kind !== "self");
            const selfId = store.findEntityByName(actorId, "我")?.id ?? null;
            const edges = store.getEdges(actorId).filter((e) => e.kind !== "self_agent");
            return {
              ok: true,
              count: entities.length,
              entities: entities.slice(0, 12).map((e) => {
                const edge =
                  (selfId ? edges.find((x) => x.fromEntityId === selfId && x.toEntityId === e.id) : null) ??
                  null;
                return {
                  name: e.canonicalName,
                  kind: e.kind,
                  relation: edge?.kind ?? null,
                  subKind: edge?.subKind ?? null,
                };
              }),
            };
          }
          case "forget": {
            const name = String(input?.name ?? "").trim();
            if (!name) return { ok: false, error: "action=forget 需要提供 name（要忘掉的人）" };
            const entity = store.findEntityByName(actorId, name);
            if (!entity) return { ok: true, message: `没有关于「${name}」的记录`, forgotten: false };
            const removed = store.deleteEntity(actorId, entity.id);
            return {
              ok: true,
              message: `已忘掉「${entity.canonicalName}」及其关系与轨迹`,
              forgotten: true,
              removedEntities: removed.entities,
              removedEdges: removed.edges,
            };
          }
          default:
            return {
              ok: false,
              error:
                `未知 action「${action || "(空)"}」。` +
                `可选：add（记住并建关系）/ query（查询）/ list（一览）/ forget（忘掉某个人）。`,
            };
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    {
      category: "life",
      sideEffect: "write",
      riskLevel: "low",
    },
  );
}
