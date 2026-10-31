import { z } from "zod";
import { AffectStateSchema, AttentionSchema, DrivesSchema, PerceptSchema } from "./affect.ts";
import { CauseSchema, DirectiveSchema, PhysicsTuningSchema } from "./directive.ts";
import { CapabilityDescriptorSchema } from "./capability.ts";
import { PoseSchema } from "./pose.ts";

export * from "./affect.ts";
export * from "./directive.ts";
export * from "./capability.ts";
export * from "./world.ts";
export * from "./pose.ts";

const FORBIDDEN_KEY =
  /^(x|y|z|pos|position|px|pixel|pixels|screen|screenX|screenY|coord|coords|coordinate|width|height|dpi|dpr|rect|offset|anchorX|anchorY|cx|cy|windowWidth|windowHeight|top|left|right|bottom)$/i;

type AnySchema = { _def: Record<string, unknown> };

/** zod 3 把 shape 存成函数，zod 4 存成对象；两种都得认，否则扫描会静默返回空。 */
function childSchemas(schema: AnySchema): Array<{ key: string; value: unknown } | unknown> {
  const def = schema._def;
  const out: Array<{ key: string; value: unknown } | unknown> = [];
  const raw = typeof def.shape === "function" ? (def.shape as () => Record<string, unknown>)() : def.shape;
  if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) out.push({ key, value });
  }
  for (const k of ["type", "innerType", "valueType", "element", "arrayType", "defaultValue"]) {
    if (def[k]) out.push(def[k]);
  }
  if (Array.isArray(def.options)) out.push(...def.options);
  if (Array.isArray(def.values)) out.push(...def.values);
  return out;
}

export function collectKeys(schema: unknown, prefix = ""): string[] {
  const seen = new Set<string>();
  const walk = (s: unknown, path: string): void => {
    if (!s || typeof s !== "object" || !("_def" in (s as object))) return;
    const as = s as AnySchema;
    for (const child of childSchemas(as)) {
      if (child && typeof child === "object" && "key" in child && "value" in child) {
        const { key, value } = child as { key: string; value: unknown };
        const p = path ? `${path}.${key}` : key;
        seen.add(p);
        walk(value, p);
      } else {
        walk(child, path);
      }
    }
  };
  walk(schema, prefix);
  return [...seen];
}

/** 契约层的存在理由：心智不知道像素，所以心智可读写的契约里不许出现像素。 */
export function findPixelLeak(schemas: Record<string, unknown>): string[] {
  const leaks: string[] = [];
  for (const [name, schema] of Object.entries(schemas)) {
    for (const key of collectKeys(schema)) {
      const leaf = key.split(".").pop() ?? "";
      if (FORBIDDEN_KEY.test(leaf)) leaks.push(`${name}.${key}`);
    }
  }
  return leaks;
}

/** 心智可读写的全部契约。这里出现任何屏幕量，"接任何壳"当场作废。 */
export const MIND_FACING_SCHEMAS: Record<string, unknown> = {
  AffectStateSchema,
  DrivesSchema,
  AttentionSchema,
  PerceptSchema,
  DirectiveSchema,
  PhysicsTuningSchema,
  CauseSchema,
};

/** 壳侧声明允许像素与尺寸（world.view 就是像素标尺），它属于身体说明书而非心智输出。 */
export const SHELL_FACING_SCHEMAS: Record<string, unknown> = {
  CapabilityDescriptorSchema,
};

export const CompanionVersionSchema = z.object({
  protocol: z.literal(1),
  mind: z.literal(1),
  body: z.literal(1),
});
