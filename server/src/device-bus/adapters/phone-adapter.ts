/**
 * 手机适配器 —— 通过 device.* 协议与远程手机客户端通信
 *
 * 与现有 phone-bridge-coordinator 并存：
 *  - 老客户端走 phone.bridge.register / phone.bridge.invoke（单连接、按 userId）
 *  - 新客户端走 device.register / device.invoke（多设备并存、按 deviceId）
 *
 * 默认能力清单覆盖手机常见感官 / 执行器：
 *  - 摄像头 / 麦克风 / 扬声器 / 屏幕 / 输入
 *  - 位置 / 电量传感器
 *  - 通知 / Agent 语音出入口
 *
 * 具体可调用 actions 由端侧协议约定（如 camera.take_photo / sensor.location.get / notification.show），
 * 适配器只做透传，不感知 action 语义。
 */
import type {
  DeviceAdapter,
  DeviceAdapterFactory,
  DeviceAdapterInit,
  AdapterStaticInfo,
} from "../device-adapter.js";
import { WsRemoteAdapter } from "./ws-remote-adapter.js";

const PHONE_DEFAULT_CAPABILITIES = [
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
    actions: ["show_ui", "dismiss_ui", "navigate"],
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
  {
    id: "phone.call",
    actions: ["dial", "hangup", "answer", "send_sms", "read_sms"],
  },
];

class PhoneAdapter extends WsRemoteAdapter {
  readonly kind = "phone" as const;
  protected readonly defaultCapabilities = PHONE_DEFAULT_CAPABILITIES;
}

export function createPhoneAdapterFactory(): DeviceAdapterFactory & AdapterStaticInfo {
  return Object.assign(
    (init: DeviceAdapterInit): DeviceAdapter => new PhoneAdapter(init),
    {
      kind: "phone" as const,
      requiresConnection: true,
      defaultCapabilities: PHONE_DEFAULT_CAPABILITIES,
    },
  );
}
