/**
 * 智能眼镜适配器 —— 复用 WsRemoteAdapter 基类
 *
 * 智能眼镜属于移动设备族，复用 PHONE_BRIDGE_TOKEN 鉴权。
 * 能力侧重：
 *  - 显示（AR 叠加 / 抬头显示）+ 语音（双向）+ 摄像头（第一视角）
 *  - 弱输入（无触屏，靠语音 / 按键 / 手势）
 *  - 传感器：IMU / 电量 / 可能的注视点
 *
 * 眼镜是 Agent 「具身感官」的核心载体：
 *  - agent.see：第一视角视频流
 *  - agent.speak / agent.listen：语音双向通道
 *  - agent.embodiment：AR 形象叠加
 */
import type { CapabilityDeclaration } from "../device-model.js";
import { createWsRemoteAdapterFactory } from "./ws-remote-adapter.js";

const GLASSES_DEFAULT_CAPABILITIES: CapabilityDeclaration[] = [
  // 第一视角摄像头（Agent 的眼睛）
  {
    id: "camera",
    actions: ["take_photo", "start_stream", "stop_stream", "list_cameras"],
    streams: ["video", "photo"],
    properties: { viewpoint: "first_person" },
  },
  {
    id: "microphone",
    actions: ["start_record", "stop_record"],
    streams: ["audio"],
  },
  {
    id: "speaker",
    actions: ["play_audio", "stop_playback", "set_volume"],
  },
  // AR 显示：叠加 UI / 文字 / 图像到镜片
  {
    id: "screen",
    actions: ["show_ui", "dismiss_ui", "show_text", "show_image", "clear"],
  },
  // 弱输入：物理按键 + 语音命令 + 手势
  {
    id: "input",
    actions: ["press_key", "voice_command", "gesture"],
  },
  {
    id: "sensor.battery",
    actions: ["get_battery"],
    streams: ["battery"],
  },
  // IMU：头部姿态 / 加速度
  {
    id: "sensor.motion",
    actions: ["get_orientation", "start_tracking", "stop_tracking"],
    streams: ["imu"],
  },
  {
    id: "notification",
    actions: ["show", "cancel"],
  },
  // Agent 感官通道
  {
    id: "agent.see",
    actions: ["observe_scene", "focus_object", "read_text"],
    streams: ["scene"],
  },
  {
    id: "agent.speak",
    actions: ["speak", "stop_speak"],
  },
  {
    id: "agent.listen",
    actions: ["start_listen", "stop_listen"],
  },
  // AR 具身：在镜片上呈现 Agent 形象
  {
    id: "agent.embodiment",
    actions: ["set_avatar", "set_expression", "play_gesture", "anchor_to_view"],
  },
];

export function createGlassesAdapterFactory() {
  return createWsRemoteAdapterFactory("glasses", GLASSES_DEFAULT_CAPABILITIES);
}
