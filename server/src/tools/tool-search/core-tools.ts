/** 桥接工具只有一个入口：tool_discover（搜索 + 加载 schema）。 */
export const TOOL_SEARCH_BRIDGE_NAMES = new Set<string>(["tool_discover"]);

export function isToolSearchBridgeName(name: string): boolean {
  return TOOL_SEARCH_BRIDGE_NAMES.has(name);
}
