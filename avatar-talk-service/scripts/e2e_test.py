# 端到端验证脚本：TTS → 提交 ComfyUI → 等待 → 下载视频
import asyncio
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from comfy_client import fetch_output_video, free_memory, submit_workflow, wait_for_result
from tts import synth_text_to_wav

SERVICE_DIR = Path(__file__).resolve().parent.parent
AVATAR_DIR = SERVICE_DIR / "assets" / "avatar_frames"
TTS_DIR = SERVICE_DIR / "data" / "tts"
VIDEOS_DIR = SERVICE_DIR / "videos"


def build_workflow(audio_path: str) -> dict:
    tpl = (SERVICE_DIR / "workflows" / "musetalk_s2v_api.json").read_text(encoding="utf-8")
    raw = tpl.replace("{{AVATAR_DIR}}", str(AVATAR_DIR).replace("\\", "/"))
    raw = raw.replace("{{AUDIO_PATH}}", audio_path.replace("\\", "/"))
    return json.loads(raw)


async def main() -> None:
    t0 = time.time()
    text = "你好呀，很高兴认识你，今天过得怎么样？我叫小九，以后可以经常来找我聊天哦。"
    wav = await synth_text_to_wav(text, str(TTS_DIR))
    print(f"[1] TTS 完成: {wav} ({time.time() - t0:.1f}s)")

    t1 = time.time()
    prompt_id = await submit_workflow(build_workflow(wav))
    print(f"[2] 已提交 ComfyUI: {prompt_id} ({time.time() - t1:.1f}s)")

    outputs = await wait_for_result(prompt_id, timeout=1800.0)
    t2 = time.time()
    print(f"[3] 生成完成 ({time.time() - t1:.1f}s)")

    video_path = None
    for node_output in outputs.values():
        try:
            video_path = await fetch_output_video(node_output, str(VIDEOS_DIR))
            break
        except RuntimeError:
            continue
    if video_path is None:
        print("FAIL: outputs 中没有视频:", json.dumps(outputs, ensure_ascii=False)[:400])
        return

    await free_memory()
    print(f"[4] 视频已保存: {video_path}")
    print(f"总耗时: {time.time() - t0:.1f}s")


if __name__ == "__main__":
    asyncio.run(main())
