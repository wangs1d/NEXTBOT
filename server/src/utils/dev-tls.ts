import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const routesDir = dirname(fileURLToPath(import.meta.url));
/** 证书默认落位 server/certs/（与 cwd 无关） */
export const defaultTlsCertDir = resolve(routesDir, "../../certs");

export type LocalHosts = {
  dnsNames: string[];
  ips: string[];
};

export type DevTlsMaterial = {
  keyPem: string;
  certPem: string;
  caPem: string;
  certDir: string;
  caCertPath: string;
  /** 本次启动是否新产生了根 CA（调用方据此决定是否写入系统信任库） */
  caGenerated: boolean;
  /** 本次启动是否重新签发了服务器证书（SAN 变化或文件缺失） */
  leafGenerated: boolean;
  sanString: string;
};

/** 收集需要写进证书 SAN 的本机名与 IP：localhost/回环/主机名/全部局域网 IPv4 */
export function collectLocalHosts(): LocalHosts {
  const ips = new Set<string>(["127.0.0.1", "0:0:0:0:0:0:0:1"]);
  const dnsNames = new Set<string>(["localhost"]);
  const host = hostname().trim();
  if (/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host)) dnsNames.add(host);
  for (const list of Object.values(networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.internal) continue;
      if (iface.family === "IPv4" && iface.address) ips.add(iface.address);
    }
  }
  return { dnsNames: [...dnsNames], ips: [...ips] };
}

const OPENSSL_FALLBACK_PATHS = [
  "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe",
  "C:\\Program Files\\Git\\usr\\bin\\openssl.exe",
  "C:\\Program Files (x86)\\Git\\mingw64\\bin\\openssl.exe",
];

async function canRunOpenssl(bin: string): Promise<boolean> {
  try {
    await execFileAsync(bin, ["version"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** 定位 openssl：显式 env 优先，其次 PATH，最后 Git for Windows 自带副本 */
export async function resolveOpensslBin(
  override: string | null = null,
): Promise<string | null> {
  const candidates = [
    ...(override ? [override] : []),
    "openssl",
    ...OPENSSL_FALLBACK_PATHS,
  ];
  for (const bin of candidates) {
    if (isAbsolute(bin) && !existsSync(bin)) continue;
    if (await canRunOpenssl(bin)) return bin;
  }
  return null;
}

function buildSanString(hosts: LocalHosts): string {
  const parts = [
    ...hosts.dnsNames.map((d) => `DNS:${d}`),
    ...hosts.ips.map((ip) => `IP:${ip}`),
  ];
  return parts.join(",");
}

type RunResult = { stdout: string; stderr: string };

async function openssl(
  bin: string,
  args: string[],
  cwd?: string,
): Promise<RunResult> {
  return execFileAsync(bin, args, { timeout: 60_000, cwd, windowsHide: true });
}

async function generateCa(
  bin: string,
  certDir: string,
): Promise<void> {
  await openssl(bin, [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-sha256",
    "-days",
    "3650",
    "-nodes",
    "-keyout",
    "ca.key",
    "-out",
    "ca.crt",
    "-subj",
    "/CN=NextBot Local Dev CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  ], certDir);
}

async function generateLeaf(
  bin: string,
  certDir: string,
  sanString: string,
): Promise<void> {
  // x509 -req 默认不复制 CSR 扩展，SAN 等通过 extfile 显式下发
  const extFile = join(certDir, "leaf.ext");
  writeFileSync(
    extFile,
    [
      "basicConstraints=CA:FALSE",
      "keyUsage=digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      `subjectAltName=${sanString}`,
      "",
    ].join("\n"),
    "utf8",
  );
  await openssl(bin, [
    "req",
    "-newkey",
    "rsa:2048",
    "-sha256",
    "-nodes",
    "-keyout",
    "server.key",
    "-out",
    "server.csr",
    "-subj",
    "/CN=NextBot Local Dev",
  ], certDir);
  await openssl(bin, [
    "x509",
    "-req",
    "-in",
    "server.csr",
    "-sha256",
    "-days",
    "825",
    "-CA",
    "ca.crt",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-out",
    "server.crt",
    "-extfile",
    "leaf.ext",
  ], certDir);
  rmSync(join(certDir, "server.csr"), { force: true });
  rmSync(extFile, { force: true });
}

/**
 * 确保本地开发 TLS 证书可用：缺 CA 则生成自签根 CA（10 年），缺服务器证书或
 * SAN 未覆盖当前本机 IP/主机名（DHCP 换网常见）则用该 CA 重签（825 天）。
 * CA 复用是关键——信任库装一次即可，换 IP 只换叶子证书。
 *
 * 返回 null 表示环境里找不到 openssl，调用方回退到纯 HTTP 并提示。
 */
export async function ensureDevTlsCertificate(opts: {
  certDir?: string;
  dnsNames?: string[];
  ips?: string[];
  opensslBin?: string | null;
  log?: (line: string) => void;
}): Promise<DevTlsMaterial | null> {
  const log = opts.log ?? (() => {});
  const certDir = opts.certDir
    ? resolve(opts.certDir)
    : defaultTlsCertDir;
  const bin = await resolveOpensslBin(opts.opensslBin ?? null);
  if (!bin) {
    log("[https] 未找到 openssl，无法生成本地证书，本次仅提供 HTTP（可设 OPENSSL_BIN 指定路径）");
    return null;
  }

  const hosts: LocalHosts = {
    dnsNames: opts.dnsNames ?? collectLocalHosts().dnsNames,
    ips: opts.ips ?? collectLocalHosts().ips,
  };
  const sanString = buildSanString(hosts);

  mkdirSync(certDir, { recursive: true });
  const caCertPath = join(certDir, "ca.crt");
  const caKeyPath = join(certDir, "ca.key");
  const serverCertPath = join(certDir, "server.crt");
  const serverKeyPath = join(certDir, "server.key");
  const sanMarkerPath = join(certDir, "server.san.txt");

  // 生成与重签过程中 leaf/CA 可能跨进程交错（node --watch 重启竞态），
  // 但生成是幂等补齐语义且窗口极小，容忍该竞态而不引入锁文件。
  let caGenerated = false;
  if (!existsSync(caCertPath) || !existsSync(caKeyPath)) {
    await generateCa(bin, certDir);
    // CA 换新后旧的信任记录随之失效，叶子证书必须重签（信任库下次启动按指纹检测重装）
    caGenerated = true;
  }
  let leafGenerated = false;
  const sanMarker = existsSync(sanMarkerPath)
    ? readFileSync(sanMarkerPath, "utf8").trim()
    : "";
  if (!existsSync(serverCertPath) || !existsSync(serverKeyPath) || sanMarker !== sanString) {
    await generateLeaf(bin, certDir, sanString);
    writeFileSync(sanMarkerPath, sanString, "utf8");
    leafGenerated = true;
  }

  return {
    keyPem: readFileSync(serverKeyPath, "utf8"),
    certPem: readFileSync(serverCertPath, "utf8"),
    caPem: readFileSync(caCertPath, "utf8"),
    certDir,
    caCertPath,
    caGenerated,
    leafGenerated,
    sanString,
  };
}

/** PEM → DER 的 SHA-1 指纹（Windows 证书库的主键标识） */
export function caCertThumbprint(caPem: string): string {
  const der = Buffer.from(caPem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, ""), "base64");
  return createHash("sha1").update(der).digest("hex").toUpperCase();
}

/** 查询 CA 是否已在当前用户 Root 库（按指纹；只读操作，幂等可重复调用） */
export async function isCaTrustedInUserStore(thumbprint: string): Promise<boolean> {
  if (process.platform !== "win32") return false;
  try {
    await execFileAsync("certutil", ["-user", "-store", "Root", thumbprint], {
      timeout: 15_000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 让 Windows 信任本地根 CA（Chrome/Edge 走系统证书库，装完出锁标）。
 *
 * Root 库写入是 Windows 强制确认的高危操作（防恶意 CA）：certutil 会弹出一次
 * 安全确认框，必须由用户本人点「是」。因此这里：
 *   - 已信任（按指纹检测）→ 直接返回 true，零打扰；
 *   - 未信任 → detached 拉起 certutil 弹确认框（不阻塞启动），用户点「是」后
 *     证书入库，下次启动检测即通过；拒绝则每次启动会再弹，可设 TLS_AUTO_TRUST=0 关闭。
 *
 * 仅 win32 生效；返回值表示「此刻已受信」。
 */
export async function trustCaOnWindows(
  caCertPath: string,
  opts: { enabled?: boolean; log?: (line: string) => void } = {},
): Promise<boolean> {
  const log = opts.log ?? (() => {});
  if (process.platform !== "win32") {
    log(
      `[https] 非 Windows 平台：请手动信任 ${caCertPath}（macOS: security add-trusted-cert；Linux: copy to /usr/local/share/ca-certificates）`,
    );
    return false;
  }
  if (opts.enabled === false) {
    log(`[https] TLS_AUTO_TRUST=0：如浏览器仍显示"不安全"，请手动安装 ${caCertPath} 到「受信任的根证书颁发机构 → 当前用户」`);
    return false;
  }
  const thumbprint = caCertThumbprint(readFileSync(caCertPath, "utf8"));
  if (await isCaTrustedInUserStore(thumbprint)) return true;

  const child = spawn(
    "certutil",
    ["-user", "-addstore", "Root", caCertPath],
    { detached: true, stdio: "ignore", windowsHide: false },
  );
  child.unref();
  log(
    `[https] Windows 将弹出安全确认框（安装本地根 CA），请点「是」——仅此一次，点完刷新浏览器即可去掉"不安全"标志。` +
      `若被拒绝，下次启动会再次弹出；不想弹窗可设 TLS_AUTO_TRUST=0 改为手动安装。`,
  );
  return false;
}
