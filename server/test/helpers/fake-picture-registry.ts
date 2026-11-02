import type { PictureKit } from "@nextbot/picture";
import type {
  PictureKitRegistry,
  PicturePartition,
} from "../../src/services/picture-kit-registry.js";
import { PictureTrashService } from "../../src/services/picture-trash-service.js";

/** 单分区假注册表：把已有的真实 PictureKit 直接交出去，不建目录、不管生命周期。 */
export function fakePictureRegistry(kit: PictureKit, actorId = "test-actor"): PictureKitRegistry {
  const partition: PicturePartition = {
    actorId,
    dirName: actorId,
    kit,
    trash: new PictureTrashService(`${kit.store.rootDir}/trash`, kit, actorId),
  };
  const resolve = async () => partition;
  return {
    forActor: resolve,
    forRequest: resolve,
    forContext: resolve,
  } as unknown as PictureKitRegistry;
}
