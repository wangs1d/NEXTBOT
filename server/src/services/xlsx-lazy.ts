/**
 * xlsx（~8MB，含 cpexcel 常量表）懒加载：只在真正解析 / 导出表格时加载。
 *
 * `xlsx@0.18.5` 的运行时只有 `XLSX.utils.sheet_to_json`，顶层没有这个函数
 * （但类型声明把它挂在了顶层，写 `XLSX.sheet_to_json` 能过 tsc、运行时直接
 * "is not a function"）。所以统一从这里走 utils，并用局部断言补齐类型。
 */
export type XlsxModule = typeof import("xlsx");

let cached: Promise<XlsxModule> | null = null;

export function loadXlsx(): Promise<XlsxModule> {
  return (cached ??= import("xlsx"));
}

export function sheetToJson<T>(
  xlsx: XlsxModule,
  sheet: unknown,
  opts?: Record<string, unknown>,
): T[] {
  return (
    xlsx.utils as unknown as {
      sheet_to_json: <Row>(sheet: unknown, opts?: Record<string, unknown>) => Row[];
    }
  ).sheet_to_json<T>(sheet, opts);
}
