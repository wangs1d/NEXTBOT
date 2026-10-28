/**
 * 平板适配器 —— 复用 WsRemoteAdapter 基类，扩展 phone 协议
 *
 * 平板与手机同属移动设备族，复用 PHONE_BRIDGE_TOKEN 鉴权，
 * 但能力清单有差异：
 *  - 去掉 phone.call（平板通常无蜂窝通话）
 *  - 加大屏特性：media.display（投屏接收）、agent.embodiment（可作为 Agent 形象载体）
 *  - 保留摄像头 / 麦克风 / 扬声器 / 屏幕 / 输入 / 传感器 / 通知
 *
 * 通过 createWsRemoteAdapterFactory 生成工厂，无需独立子类。
 */
import type { CapabilityDeclaration } from "../device-model.js";
import { createWsRemoteAdapterFactory } from "./ws-remote-adapter.js";

const TABLET_DEFAULT_CAPABILITIES: CapabilityDeclaration[] = [
  {
    id: "camera",
    actions: ["take_photo", "start_stream", "stop_stream", "list_cameras"],
    streams: ["video", "photo"],
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
  {
    id: "screen",
    actions: ["show_ui", "dismiss_ui", "navigate", "set_orientation", "set_brightness"],
  },
  {
    id: "input",
    actions: ["tap", "swipe", "type_text", "press_key"],
  },
  {
    id: "sensor.location",
    actions: ["get_location", "start_tracking", "stop_tracking"],
    streams: ["location"],
  },
  {
    id: "sensor.battery",
    actions: ["get_battery"],
    streams: ["battery"],
  },
  {
    id: "notification",
    actions: ["show", "cancel", "cancel_all"],
  },
  {
    id: "agent.speak",
    actions: ["speak", "stop_speak"],
  },
  {
    id: "agent.listen",
    actions: ["start_listen", "stop_listen"],
  },
  // 平板大屏特性：可作为投屏接收端
  {
    id: "media.display",
    actions: ["start_cast", "stop_cast", "set_quality"],
    streams: ["cast_video"],
  },
  // 平板可作为 Agent 形象载体（具身）
  {
    id: "agent.embodiment",
    actions: ["set_avatar", "set_expression", "play_gesture"],
  },
];

export function createTabletAdapterFactory() {
  return createWsRemoteAdapterFactory("tablet", TABLET_DEFAULT_CAPABILITIES);
}
