/**
 * 降低 SSRF 风险：互联网图像拉取仅允许访问非公网保留地址的目标，
 * 除非配置严格放行列表 {@link isVisionPullHostExplicitlyAllowedByEnv}.
 */

export function parseCsvHosts(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isVisionPullHostExplicitlyAllowedByEnv(hostname: string): boolean {
  const allow = parseCsvHosts(process.env.AGENT_VISION_HTTP_PULL_ALLOW_HOSTS);
  if (allow.length === 0) return false;
  const h = hostname.toLowerCase();
  return allow.some((a) => a === h || h.endsWith(`.${a}`));
}

export function assertVisionPullUrlAllowed(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("VISION_PULL_URL_SCHEME: 仅允许 http/https");
  }
  const host = url.hostname.toLowerCase();
  if (isVisionPullHostExplicitlyAllowedByEnv(host)) {
    return;
  }
  const denyHosts = parseCsvHosts(process.env.AGENT_VISION_HTTP_PULL_BLOCKED_HOSTS);
  if (denyHosts.some((d) => host === d || host.endsWith(`.${d}`))) {
    throw new Error(`VISION_PULL_HOST_BLOCKED: ${host}`);
  }
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new Error("VISION_PULL_HOST_BLOCKED: localhost");
  }

  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m) {
    const o = m.slice(1, 5).map((x) => Number(x));
    const [a, b] = o;
    if (o.some((n) => n > 255)) {
      throw new Error("VISION_PULL_HOST_BLOCKED: invalid ipv4");
    }
    if (a === 0 || a === 127 || a === 10) {
      throw new Error("VISION_PULL_HOST_BLOCKED: private/reserved ipv4");
    }
    if (a === 100 && b >= 64 && b <= 127) {
      throw new Error("VISION_PULL_HOST_BLOCKED: cgNAT ipv4");
    }
    if (a === 172 && b >= 16 && b <= 31) {
      throw new Error("VISION_PULL_HOST_BLOCKED: private ipv4");
    }
    if (a === 192 && b === 168) {
      throw new Error("VISION_PULL_HOST_BLOCKED: private ipv4");
    }
    if (a === 169 && b === 254) {
      throw new Error("VISION_PULL_HOST_BLOCKED: link-local ipv4");
    }
    if (a >= 224) {
      throw new Error("VISION_PULL_HOST_BLOCKED: multicast/reserved ipv4");
    }
  }
}
