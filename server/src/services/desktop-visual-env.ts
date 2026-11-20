/** desktop_visual 本机执行体的纯 env 判定（叶子模块：不 import 任何项目内模块）。 */

function parseBooleanEnv(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** 与 SubprocessDesktopVisual.isEnabled 同源（desktop-visual-subprocess 复用本函数）。 */
export function isVisualEnabled(env: NodeJS.ProcessEnv): boolean {
  return (
    parseBooleanEnv(env.DESKTOP_VISUAL_ENABLED) ||
    parseBooleanEnv(env.DESKTOP_VISUAL_AGENT_ENABLED)
  );
}

