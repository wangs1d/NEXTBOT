export type ToolRecallGoldenCase = {
  id: string;
  query: string;
  expected: string[];
  forbidden?: string[];
  group: string;
  topK: number;
};

export const TOOL_RECALL_GOLDEN: ToolRecallGoldenCase[] = [
  { id: "location_city", query: "我现在在哪个城市", expected: ["clock.get_user_location"], forbidden: ["place"], group: "location_place", topK: 3 },
  { id: "location_now", query: "我现在在哪儿", expected: ["clock.get_user_location"], forbidden: ["place"], group: "location_place", topK: 3 },
  { id: "location_relocate", query: "重新定位一下我的位置", expected: ["clock.get_user_location"], group: "location_place", topK: 3 },
  { id: "place_home", query: "我家在哪里", expected: ["place"], forbidden: ["clock.get_user_location"], group: "location_place", topK: 3 },
  { id: "place_favorites", query: "看看我收藏的地方", expected: ["place"], group: "location_place", topK: 3 },
  { id: "place_search", query: "帮我搜一下附近的星巴克", expected: ["geo.place_search"], group: "location_place", topK: 3 },
  { id: "place_distance", query: "公司和家相距多远", expected: ["geo.distance"], group: "location_place", topK: 3 },

  { id: "weather_cold", query: "外头冷不冷", expected: ["weather.get_local"], forbidden: ["smart_home", "device"], group: "weather_web", topK: 3 },
  { id: "weather_rain", query: "明天北京会下雨吗", expected: ["weather.get_local"], forbidden: ["web_search"], group: "weather_web", topK: 3 },
  { id: "weather_umbrella", query: "今天出门要不要带伞", expected: ["weather.get_local"], group: "weather_web", topK: 3 },
  { id: "web_hot", query: "今天有什么热搜", expected: ["web_search"], forbidden: ["commitment.list", "calendar"], group: "weather_web", topK: 3 },
  { id: "web_crypto", query: "比特币现在什么价", expected: ["web_search", "finance"], group: "weather_web", topK: 3 },
  { id: "web_news", query: "搜一下 iPhone 17 的最新新闻", expected: ["web_search"], group: "weather_web", topK: 3 },
  { id: "fetch_page", query: "把这个网页的正文读出来", expected: ["web_fetch"], forbidden: ["web_search"], group: "weather_web", topK: 3 },
  { id: "fetch_url", query: "提取一下 example.com 这个页面的内容", expected: ["web_fetch"], group: "weather_web", topK: 3 },

  { id: "calendar_meeting", query: "明天早上九点提醒我开会", expected: ["calendar"], forbidden: ["geofence"], group: "calendar_geofence_watch", topK: 3 },
  { id: "calendar_alarm", query: "帮我定个明早七点的闹钟", expected: ["calendar"], group: "calendar_geofence_watch", topK: 3 },
  { id: "calendar_cancel", query: "取消我明天的日程", expected: ["calendar"], forbidden: ["geofence"], group: "calendar_geofence_watch", topK: 3 },
  { id: "calendar_list", query: "我今天有哪些安排", expected: ["calendar"], group: "calendar_geofence_watch", topK: 3 },
  { id: "geofence_arrive", query: "我到公司的时候提醒我", expected: ["geofence"], forbidden: ["calendar"], group: "calendar_geofence_watch", topK: 3 },
  { id: "geofence_leave", query: "离开家的时候提醒我关窗", expected: ["geofence"], forbidden: ["calendar"], group: "calendar_geofence_watch", topK: 3 },
  { id: "watch_rate", query: "帮我盯着美联储降息", expected: ["watch.track"], forbidden: ["calendar"], group: "calendar_geofence_watch", topK: 3 },
  { id: "watch_stock", query: "这支股票跌破 100 就告诉我", expected: ["watch.track"], group: "calendar_geofence_watch", topK: 3 },

  { id: "interest_phone", query: "我喜欢苹果手机", expected: ["interest.manage"], group: "interest_life_obs", topK: 3 },
  { id: "interest_cancel", query: "我不再关注华为手机了", expected: ["interest.manage"], group: "interest_life_obs", topK: 3 },
  { id: "life_sister", query: "记住我妹妹叫小满", expected: ["life.manage"], forbidden: ["interest.manage"], group: "interest_life_obs", topK: 3 },
  { id: "life_like", query: "以后叫我起床不要超过八点", expected: ["life.manage"], group: "interest_life_obs", topK: 3 },
  { id: "obs_previous", query: "刚才折叠起来的工具结果是什么", expected: ["obs_recall"], group: "interest_life_obs", topK: 3 },

  { id: "finance_month", query: "这个月我一共花了多少", expected: ["finance"], forbidden: ["web_search"], group: "finance_payment_shopping_ride", topK: 3 },
  { id: "finance_bill", query: "查一下我的账单明细", expected: ["finance"], group: "finance_payment_shopping_ride", topK: 3 },
  { id: "payment_wallet", query: "用钱包付款", expected: ["payment", "finance"], group: "finance_payment_shopping_ride", topK: 3 },
  { id: "payment_auth", query: "看看支付授权是不是正常的", expected: ["payment"], group: "finance_payment_shopping_ride", topK: 3 },
  { id: "shopping_headphones", query: "推荐一款适合通勤的耳机", expected: ["shopping.suggest"], forbidden: ["web_search"], group: "finance_payment_shopping_ride", topK: 3 },
  { id: "shopping_laptop", query: "预算八千帮我挑台笔记本", expected: ["shopping.suggest"], group: "finance_payment_shopping_ride", topK: 3 },
  { id: "ride_airport", query: "打车去机场", expected: ["ride_hailing"], forbidden: ["geo.distance"], group: "finance_payment_shopping_ride", topK: 3 },
  { id: "ride_order", query: "查一下我的打车订单", expected: ["ride_hailing"], group: "finance_payment_shopping_ride", topK: 3 },

  { id: "home_light", query: "把客厅灯打开", expected: ["smart_home"], forbidden: ["device"], group: "home_device_phone", topK: 3 },
  { id: "home_dim", query: "客厅有点暗，把灯调亮一点", expected: ["smart_home"], group: "home_device_phone", topK: 3 },
  { id: "home_ac", query: "空调温度调到二十六度", expected: ["smart_home"], forbidden: ["weather.get_local"], group: "home_device_phone", topK: 3 },
  { id: "device_camera", query: "看一下门口摄像头", expected: ["device"], forbidden: ["phone.camera_capture"], group: "home_device_phone", topK: 3 },
  { id: "device_status", query: "我的设备现在是什么状态", expected: ["device"], group: "home_device_phone", topK: 3 },
  { id: "phone_battery", query: "我手机还有多少电", expected: ["phone.battery"], forbidden: ["device"], group: "home_device_phone", topK: 3 },
  { id: "phone_notifications", query: "看一下手机上的通知", expected: ["phone.notifications"], forbidden: ["device"], group: "home_device_phone", topK: 3 },
  { id: "phone_camera", query: "用手机拍张照片", expected: ["phone.camera_capture"], forbidden: ["device"], group: "home_device_phone", topK: 3 },

  { id: "voice_goodnight", query: "用语音跟我说晚安", expected: ["voice.speak"], forbidden: ["voice.send_message"], group: "communication_media_agent", topK: 3 },
  { id: "voice_message", query: "发一条语音消息", expected: ["voice.send_message"], forbidden: ["voice.speak"], group: "communication_media_agent", topK: 3 },
  { id: "mail_recent", query: "最近有什么新邮件", expected: ["mail.recent"], forbidden: ["phone.notifications"], group: "communication_media_agent", topK: 3 },
  { id: "browser_sessions", query: "我有哪些浏览器登录态", expected: ["browser.session.list"], group: "communication_media_agent", topK: 3 },
  { id: "phone_sms", query: "给妈妈发条短信", expected: ["phone", "sms.send"], group: "communication_media_agent", topK: 3 },
  { id: "world_friend", query: "给好友发个消息", expected: ["world.link", "phone"], group: "communication_media_agent", topK: 3 },
  { id: "agent_capability", query: "你都能帮我做什么", expected: ["agent"], forbidden: ["proactivity"], group: "communication_media_agent", topK: 3 },
  { id: "proactive_tasks", query: "看看你给我设了哪些主动任务", expected: ["proactivity", "commitment.list"], group: "communication_media_agent", topK: 3 },
];
