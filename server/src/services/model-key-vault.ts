/**
 * 用户自有模型 key 的静态加密仓。
 *
 * 为什么落盘：云端主动轮次（定时提醒、主动性消息、后台整理）在客户端离线时也要跑，
 * 而那时内存里没有用户的 key。只用运营方 provider 就等于**替用户花钱**，所以绑定
 * 必须比连接活得更久。
 *
 * 落盘口径见 secret-vault（AES-256-GCM、一 actor 一份密文、主密钥缺失拒写盘、
 * 状态口只给 model/baseUrl）。主密钥回退链与派生盐沿用本仓原有的一套
 * （`MODEL_KEY_SECRET` / `nextbot-model-key-v1`），改了会解不开已落盘的绑定。
 *
 * 残余风险（要给上线的人看）：主密钥和密文若同机同备份，泄露数据根≈泄露密钥链，
 * 所以生产必须把 `MODEL_KEY_SECRET` 放在 systemd unit / 外部secret里，而不是数据根。
 */

import { createEncryptedRecordStore } from "./secret-vault.js";

export interface StoredModelKey {
  actorId: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  savedAt: string;
}

function isStoredModelKey(v: unknown): v is StoredModelKey {
  const r = v as Partial<StoredModelKey> | null;
  return Boolean(r?.actorId && r.apiKey && r.baseUrl && r.model);
}

const vault = createEncryptedRecordStore<StoredModelKey>({
  dirName: "model-keys",
  deriveSalt: "nextbot-model-key-v1",
  secretEnvNames: ["MODEL_KEY_SECRET", "WELLNESS_DATA_SECRET", "BROWSER_SESSION_SECRET", "SESSION_SECRET"],
  validate: isStoredModelKey,
});

/** 主密钥是否可用（不可用时仓不写不读，绑定退回纯内存）。 */
export function modelKeyVaultEnabled(): boolean {
  return vault.enabled();
}

/**
 * 保存一份绑定；主密钥缺失或 actorId 为空返回 false（调用方继续按内存走）。
 * 每次上送都覆盖同一 actor 的旧值——绑定内容变了就是换了 key。
 */
export function saveModelKey(
  actorId: string,
  binding: { baseUrl: string; apiKey: string; model: string },
): boolean {
  return vault.save(actorId, {
    actorId: String(actorId ?? "").trim(),
    baseUrl: binding.baseUrl,
    apiKey: binding.apiKey,
    model: binding.model,
    savedAt: new Date().toISOString(),
  });
}

/** 该 actor 是否有落盘绑定（有而取不出 provider = 主密钥轮换/密文损坏，不能再兜底花钱）。 */
export function hasModelKey(actorId: string): boolean {
  return vault.exists(actorId);
}

/** 删除某 actor 的持久绑定（用户在 UI 清空配置时走这里）。 */
export function deleteModelKey(actorId: string): void {
  vault.remove(actorId);
}

export interface LoadedModelKeys {
  entries: StoredModelKey[];
  /** 解不开的份数（多半是主密钥轮换过）：只计数，不外传内容 */
  undecryptable: number;
}

/** 开机/首次取用时把落盘绑定读回内存；主密钥缺失返回空。 */
export function loadModelKeys(): LoadedModelKeys {
  return vault.loadAll();
}

/** 观测用：落盘份数（不含任何密钥信息）。 */
export function modelKeyCount(): number {
  return vault.count();
}
