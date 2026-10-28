import { useEffect } from "react";
import { dispatchEmbodimentCommand } from "../bridge/agent-bridge";
import { parseHostCommand, SPHERE_HOST_MSG } from "../embed-protocol";

/** 接收 postMessage 的具身指令（父页 WS 转发） */
export function useEmbodimentCommandRelay(enabled = true) {
  useEffect(() => {
    if (!enabled) return;

    const onMessage = (ev: MessageEvent) => {
      const d = ev.data as { type?: string } & Record<string, unknown>;
      if (d?.type !== SPHERE_HOST_MSG.command) return;
      const cmd = parseHostCommand(d);
      if (cmd) dispatchEmbodimentCommand(cmd);
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [enabled]);
}