/**
 * 临时验证脚本：验证麦当劳 / 瑞幸 MCP 端点连通性与鉴权行为
 * 用法：cd server && npx tsx scripts/verify-order-mcp-endpoints.ts
 * 无 Token 请求 initialize：预期返回 401/403 类错误（证明端点在线、鉴权生效）；
 * 拿到真实 Token 后用 scripts/verify-yby6-mcp.ts 的方式即可走全链路。验证完可删除
 */

const ENDPOINTS = [
  { name: "麦当劳 mcd", url: "https://mcp.mcd.cn" },
  { name: "瑞幸 luckin", url: "https://gwmcp.lkcoffee.com/order/user/mcp" },
];

async function probe(name: string, url: string) {
  console.log(`\n=== ${name} (${url}) ===`);
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "nextbot", version: "1.0.0" },
    },
  };

  // 1) 无 Token
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const raw = (await res.text()).slice(0, 300);
    console.log(`无 Token   -> HTTP ${res.status} ${raw}`);
  } catch (e) {
    console.log(`无 Token   -> 请求失败: ${(e as Error).message}`);
  }

  // 2) 伪造 Token
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer invalid-token-for-connectivity-test",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const raw = (await res.text()).slice(0, 300);
    console.log(`伪造 Token -> HTTP ${res.status} ${raw}`);
  } catch (e) {
    console.log(`伪造 Token -> 请求失败: ${(e as Error).message}`);
  }
}

async function main() {
  for (const ep of ENDPOINTS) {
    await probe(ep.name, ep.url);
  }
  console.log("\nDONE");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
