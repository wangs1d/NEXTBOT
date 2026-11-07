export * from "./types.js";
export { decideRender } from "./decide.js";
export { applyBodyForm } from "./body.js";
export { applyCards, collectCardPayloads, unfoldIfCardsPresent } from "./cards.js";
// 统一出口：全项目新增渲染形态只经 renderTurn，不再各自调 decideRender
export { renderTurn } from "./turn.js";
export type { RenderTurnMode, RenderTurnResult } from "./turn.js";
export {
  buildRenderEnvelope,
  decodeLegacyText,
  projectToText,
  projectToSpeech,
  projectBlock,
  encodeCardBlock,
  encodeFormBlock,
  expandEnvelopeToDoneFields,
  compactEnvelopeForWire,
} from "./protocol.js";
export type {
  RenderEnvelope,
  RenderEnvelopeInput,
  EnvelopeBlock,
} from "./protocol.js";
// 结构化回复场景模块（新增形态只改 scenes/index.ts）
export {
  sceneRegistry,
  SceneRegistry,
  planRenderScene,
  planPreRenderScene,
  buildSceneBoundaryBlock,
  listSceneContracts,
  renderTomorrowPreviewMarkdown,
  auditResultCards,
  stripResultCardBlocks,
  RESULT_CARD_TYPES,
} from "./scenes/index.js";
export {
  buildRenderContract,
  assertRenderContract,
  RENDER_AS_FORMS,
  ENVELOPE_BLOCK_TYPES,
  KNOWN_CLIENT_EXEMPT_CARD_TYPES,
} from "./contract.js";
export type { RenderContract, RenderContractScene } from "./contract.js";
export type { SceneContext, ScenePlan, ScenePlanResult, RenderScene } from "./scenes/index.js";
