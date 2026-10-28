/**
 * 内置 Skill：出行与通勤（travel.*，与旅游规划同族）
 *
 * 在 travel-planning（旅游行程规划）基础上扩展日常出行能力：
 *   - travel.departure-advice  实时路况 + 天气 → 建议出发时间
 *   - travel.parse-ticket      邮件/短信提取的机票/火车票/酒店订单结构化入库（票夹）
 *   - travel.list-tickets      票夹列表（未过期票务）
 *   - travel.packing-list      根据目的地天气预报生成打包清单
 *
 * 数据源：
 *   - 路况/路线：高德 v3 驾车路径规划（实时时长估算），无 Key 自动降级 OSRM（computeRoute）
 *   - 天气：Open-Meteo（WeatherService.getBrief，免费无 Key）
 *   - 票夹：travel-ticket-store（data/travel-tickets 落盘）
 *
 * 到站约车（opt-in）：用户在录入机票/火车票时勾选「到站约车」→ parse-ticket
 * 返回 rideReminder 建议（到站前 25 分钟），由 agent 用 calendar 工具创建提醒；
 * 到点后 agent 主动触达用户并协助约车（本项目无网约车直连 API，提醒+协助是 v1 形态）。
 */
import type { SkillDefinition } from "../types.js";
import type { PlanningService } from "./travel-planning-service.js";
import {
  travelTicketStore,
  type StoredTravelTicket,
  type TicketSource,
  type TicketType,
} from "./travel-ticket-store.js";
import { geocodeCity, WeatherService } from "../../services/weather-service.js";
import { amapDrivingRoute, amapGeocode } from "../../services/route-duration-service.js";

type Deps = {
  travelPlanningService: PlanningService;
  weatherService: WeatherService;
};

/** "2026-09-10 08:30" / ISO / "08:30"（早于当前则视为明天）→ Date */
function parseFlexibleTime(raw: string): Date | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\d{1,2}:\d{2}$/.test(s)) {
    const now = new Date();
    const [h, m] = s.split(":").map(Number);
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
    if (d.getTime() < Date.now() + 10 * 60_000) d.setDate(d.getDate() + 1);
    return d;
  }
  const normalized = s.includes("T") ? s : s.replace(" ", "T");
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatHM(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 本地时间 "YYYY-MM-DD HH:mm"（toISOString 会给 UTC，通知时间必须按用户本地时区） */
function formatLocal(d: Date): string {
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `${ymd} ${formatHM(d)}`;
}

export function createTravelCommuteBuiltinSkills(deps: Deps): SkillDefinition[] {
  const { travelPlanningService, weatherService } = deps;

  /** 1. 实时路况 + 天气 → 建议出发时间 */
  const departure_advice: SkillDefinition = {
    metadata: {
      name: "travel.departure-advice",
      version: "1.0.0",
      displayName: "出发时间建议（路况+天气）",
      description:
        "结合实时路况与天气，为一次市内/跨城出行建议出发时间。输入出发地、目的地与期望到达时间（可选），" +
        "返回：驾车耗时估算（含实时路况）、沿途/目的地天气、是否下雨、缓冲建议与「最晚几点出门」。" +
        "当用户问「明天几点出门」「现在走来得及吗」「去机场/高铁站怎么安排出发」等通勤出发问题时调用。",
      kind: "builtin",
      tags: ["travel", "通勤", "路况", "天气", "出发时间", "commute"],
      icon: "🚦",
      parameters: [
        { name: "from", type: "string", required: true, description: "出发地（如「家」「公司·望京」「北京南站」）" },
        { name: "to", type: "string", required: true, description: "目的地（如「首都机场 T3」「虹桥火车站」）" },
        { name: "arriveBy", type: "string", required: false, description: "期望到达时间（YYYY-MM-DD HH:mm 或 HH:mm；只传 HH:mm 早于当前则视为明天）" },
      ],
      outputSchema: {
        ok: "是否成功",
        from: "出发地",
        to: "目的地",
        durationMin: "驾车耗时（分钟，含实时路况估算）",
        distanceKm: "距离（公里）",
        routeSource: "路线数据来源（amap=含实时路况 / osrm=无路况兜底）",
        weather: "目的地天气 {weatherText,tempC,rainPct,summary}",
        suggestedDeparture: "建议出发时间（HH:mm）",
        arriveBy: "期望到达时间",
        bufferMin: "预留缓冲（分钟：找车/安检/天气）",
        advice: "给用户看的建议文案（直接复述即可）",
      },
      permissions: ["network:external"],
      timeoutMs: 30_000,
    },
    handler: async (input) => {
      const from = typeof input.from === "string" ? input.from.trim() : "";
      const to = typeof input.to === "string" ? input.to.trim() : "";
      if (!from || !to) return { ok: false, error: "缺少必填参数 from / to" };
      const arriveByRaw = typeof input.arriveBy === "string" ? input.arriveBy.trim() : "";
      const arriveByDate = arriveByRaw ? parseFlexibleTime(arriveByRaw) : null;
      if (arriveByRaw && !arriveByDate) {
        return { ok: false, error: `arriveBy 无法解析：${arriveByRaw}（示例：2026-09-10 08:30 或 08:30）` };
      }

      // 1) 路线：高德实时（优先）→ OSRM 兜底（无路况）
      let durationMin = 0;
      let distanceKm = 0;
      let routeSource = "";
      const origin = await amapGeocode(from);
      const dest = await amapGeocode(to);
      if (origin && dest) {
        const r = await amapDrivingRoute(origin, dest);
        if (r) {
          durationMin = r.durationMin;
          distanceKm = r.distanceKm;
          routeSource = "amap";
        }
      }
      if (!routeSource) {
        try {
          const r = await travelPlanningService.computeRoute(from, to);
          if (r && typeof r.durationMin === "number" && r.durationMin > 0) {
            durationMin = Math.round(r.durationMin);
            distanceKm = Math.round((Number(r.distanceKm) || 0) * 10) / 10;
            routeSource = "osrm";
          }
        } catch {
          // 继续走失败分支
        }
      }
      if (!routeSource || durationMin <= 0) {
        return { ok: false, error: "路线计算失败（高德与兜底均不可用），请稍后重试或换更具体的地名" };
      }

      // 2) 天气：目的地坐标（高德编码成功时直接用坐标，否则城市名地理编码）
      let weather: { weatherText: string; tempC: number; rainPct: number; summary: string } | null = null;
      let hourly: Array<{ hour: string; weatherText: string; rainPct: number; tempC: number }> = [];
      try {
        let lat = NaN;
        let lon = NaN;
        if (dest) {
          const [lng, ltd] = dest.split(",").map(Number);
          lon = lng;
          lat = ltd;
        }
        let brief = null;
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          // auto：日历日和逐小时由目的地坐标推导，不能按中国时区算（境外目的地会错一天）
          brief = await weatherService.getBrief(lat, lon, "auto", to);
        } else {
          const hit = await geocodeCity(to);
          if (hit) brief = await weatherService.getBrief(hit.latitude, hit.longitude, "auto", to);
        }
        if (brief) {
          weather = {
            weatherText: brief.weatherText,
            tempC: Math.round(brief.currentTempC),
            rainPct: Math.round(brief.peakRainPct),
            summary: brief.summaryLine,
          };
          hourly = brief.hourlyForecast.map((h) => ({
            hour: h.hour,
            weatherText: h.weatherText,
            rainPct: h.precipitationProbabilityPct,
            tempC: Math.round(h.temperatureC),
          }));
        }
      } catch {
        // 天气失败不阻塞出发建议
      }

      // 3) 出发时刻：到达时间 - 路耗时 - 缓冲（雨天 +15、无到达时间则给"现在"口径）
      const now = new Date();
      const rainAhead = (() => {
        if (!arriveByDate) return (weather?.rainPct ?? 0) >= 40;
        const target = `${String(arriveByDate.getHours()).padStart(2, "0")}:00`;
        const h = hourly.find((x) => x.hour.startsWith(target));
        return (h?.rainPct ?? weather?.rainPct ?? 0) >= 40;
      })();
      const bufferMin = 10 + (rainAhead ? 15 : 0);
      let suggestedDeparture: string | null = null;
      if (arriveByDate) {
        const dep = new Date(arriveByDate.getTime() - (durationMin + bufferMin) * 60_000);
        suggestedDeparture = formatHM(dep);
      }
      const arriveByLabel = arriveByDate ? formatHM(arriveByDate) : null;

      const parts: string[] = [];
      if (arriveByDate) {
        parts.push(`${arriveByDate.getMonth() + 1}月${arriveByDate.getDate()}日 ${formatHM(arriveByDate)} 前到达 ${to}`);
      }
      parts.push(`车程约 ${durationMin} 分钟${distanceKm ? `（约 ${distanceKm} km）` : ""}${routeSource === "amap" ? "，已含实时路况" : "（无实时路况，估算值）"}`);
      if (weather) parts.push(`目的地天气：${weather.weatherText} ${weather.tempC}°C，降水概率 ${weather.rainPct}%`);
      if (rainAhead) parts.push("有降雨可能，建议多留缓冲并带伞");
      if (suggestedDeparture) {
        parts.push(`建议最晚 ${suggestedDeparture} 出发（含 ${bufferMin} 分钟缓冲）`);
      } else {
        parts.push(`如果现在出发，预计 ${formatHM(new Date(now.getTime() + durationMin * 60_000))} 前后到达`);
      }

      return {
        ok: true,
        from,
        to,
        durationMin,
        distanceKm,
        routeSource,
        ...(weather ? { weather } : {}),
        ...(suggestedDeparture ? { suggestedDeparture, arriveBy: arriveByLabel, bufferMin } : {}),
        advice: parts.join("；") + "。",
      };
    },
  };

  /** 2. 票务结构化入库（短信/邮件提取结果 → 票夹） */
  const parse_ticket: SkillDefinition = {
    metadata: {
      name: "travel.parse-ticket",
      version: "1.0.0",
      displayName: "票务入库（机票/火车票/酒店）",
      description:
        "把用户短信、邮件或口述中的行程订单提取为结构化票务并存入统一票夹。支持三类：flight 机票 / train 火车票 / hotel 酒店。" +
        "当用户说「我收到航班的短信了」「帮我把这个订单记下来」「这是我的火车票信息」并提供了出行信息时调用：" +
        "先从用户提供的文本中提取字段（航班号/车次/酒店名、出发到达机场车站与时间、座位、确认号），再调本工具入库。" +
        "酒店录入 checkInDate/checkOutDate/roomType；机票火车票录入 departTime/arriveTime/from*/to*。" +
        "用户希望到站后帮忙约车时置 arrivalRideOptIn=true（opt-in，默认 false），返回值会给出到站前提醒的创建建议。" +
        "更新已有票（如值机后）传 ticketId 与 markRideReminderCreated=true 标记提醒已建。",
      kind: "builtin",
      tags: ["travel", "票务", "机票", "火车票", "酒店", "票夹", "行程"],
      icon: "🎫",
      parameters: [
        { name: "type", type: "string", required: true, enum: ["flight", "train", "hotel"], description: "票务类型" },
        { name: "source", type: "string", required: false, enum: ["sms", "email", "manual"], description: "来源，默认 manual" },
        { name: "carrier", type: "string", required: true, description: "航司/车次/酒店名（如「东方航空」「G1027」「亚朵·成都春熙路」）" },
        { name: "code", type: "string", required: false, description: "航班号/确认号（如 MU5107；酒店填确认号）" },
        { name: "passenger", type: "string", required: false, description: "乘机人/乘车人/入住人" },
        { name: "fromCity", type: "string", required: false, description: "出发城市" },
        { name: "fromStation", type: "string", required: false, description: "出发机场/车站（含航站楼更佳）" },
        { name: "toCity", type: "string", required: false, description: "到达城市" },
        { name: "toStation", type: "string", required: false, description: "到达机场/车站" },
        { name: "departTime", type: "string", required: false, description: "起飞/发车时间（YYYY-MM-DD HH:mm）" },
        { name: "arriveTime", type: "string", required: false, description: "到达时间" },
        { name: "seat", type: "string", required: false, description: "舱位/席别/座位" },
        { name: "gate", type: "string", required: false, description: "航站楼/检票口/登机口" },
        { name: "checkInDate", type: "string", required: false, description: "酒店入住日期 YYYY-MM-DD" },
        { name: "checkOutDate", type: "string", required: false, description: "酒店退房日期 YYYY-MM-DD" },
        { name: "roomType", type: "string", required: false, description: "酒店房型" },
        { name: "arrivalRideOptIn", type: "boolean", required: false, description: "用户是否希望到站后协助约车（默认 false）" },
        { name: "ticketId", type: "string", required: false, description: "更新已有票时传入" },
        { name: "markRideReminderCreated", type: "boolean", required: false, description: "true=标记该票的到站约车提醒已创建（防重复）" },
        { name: "rawText", type: "string", required: false, description: "原始短信/邮件片段（≤500字，回查语境用）" },
      ],
      outputSchema: {
        ok: "是否成功",
        ticketId: "票 ID",
        summary: "票务一行摘要",
        deduped: "是否合并了已存在的同票",
        rideReminder: "到站约车提醒建议 {arriveTime, remindAt, note}（opt-in 时返回）",
        displayNote: "展示提示（勿复述原文）",
      },
      permissions: [],
      timeoutMs: 5_000,
    },
    handler: async (input) => {
      const type = String(input.type ?? "") as TicketType;
      if (!["flight", "train", "hotel"].includes(type)) {
        return { ok: false, error: "type 须为 flight / train / hotel 之一" };
      }
      const carrier = String(input.carrier ?? "").trim();
      if (!carrier) return { ok: false, error: "缺少必填参数 carrier（航司/车次/酒店名）" };
      const source = (["sms", "email", "manual"].includes(String(input.source)) ? String(input.source) : "manual") as TicketSource;
      const str = (k: string): string | undefined => {
        const v = typeof input[k] === "string" ? input[k].trim() : "";
        return v || undefined;
      };

      const code = str("code");
      const departTime = str("departTime");
      const checkInDate = str("checkInDate");

      // 去重合并：同类型+同主码+同出发/入住日期视为同一张票
      const existing = input.ticketId
        ? travelTicketStore.get(String(input.ticketId))
        : code
          ? travelTicketStore.findByCode(type, code, departTime ?? checkInDate)
          : null;

      const optIn = input.arrivalRideOptIn === true || existing?.arrivalRideOptIn === true;
      const base: Omit<StoredTravelTicket, "ticketId" | "createdAt"> = {
        type,
        source,
        carrier,
        code,
        passenger: str("passenger"),
        fromCity: str("fromCity"),
        fromStation: str("fromStation"),
        toCity: str("toCity"),
        toStation: str("toStation"),
        departTime,
        arriveTime: str("arriveTime"),
        seat: str("seat"),
        gate: str("gate"),
        checkInDate,
        checkOutDate: str("checkOutDate"),
        roomType: str("roomType"),
        rawText: str("rawText")?.slice(0, 500),
        arrivalRideOptIn: optIn,
        arrivalRideReminderCreated:
          input.markRideReminderCreated === true
            ? true
            : (existing?.arrivalRideReminderCreated ?? false),
      };

      const saved = travelTicketStore.save({
        ...(existing ? { ...existing, ...base } : base),
        ticketId: existing?.ticketId,
      });

      const summary =
        type === "hotel"
          ? `${carrier}${base.roomType ? ` ${base.roomType}` : ""}，${checkInDate ?? "?"} 入住${base.checkOutDate ? `，${base.checkOutDate} 退房` : ""}`
          : `${carrier}${code ? ` ${code}` : ""}，${departTime ?? "?"} ${base.fromStation ?? base.fromCity ?? ""}→${base.toStation ?? base.toCity ?? ""}${base.seat ? `，${base.seat}` : ""}`;

      // 到站约车：opt-in 且有到达时间 → 给出提醒创建建议（agent 用 calendar 工具落地）
      let rideReminder: { arriveTime: string; remindAt: string; note: string } | null = null;
      if (optIn && (type === "flight" || type === "train") && base.arriveTime && !base.arrivalRideReminderCreated) {
        const arr = parseFlexibleTime(base.arriveTime);
        if (arr) {
          const remindAt = new Date(arr.getTime() - 25 * 60_000);
          rideReminder = {
            arriveTime: base.arriveTime,
            remindAt: formatLocal(remindAt),
            note:
              "请用 calendar.create_from_text 创建一条 reminder：" +
              `「${base.arriveTime} ${carrier}${code ? ` ${code}` : ""} 即将到站${base.toStation ?? base.toCity ?? ""}，用户已预约到站约车协助」，` +
              "创建成功后再调一次本工具（带 ticketId 与 markRideReminderCreated=true）防止重复提醒。",
          };
        }
      }

      return {
        ok: true,
        ticketId: saved.ticketId,
        summary,
        deduped: !!existing,
        ...(rideReminder ? { rideReminder } : {}),
        displayNote:
          "票务已入库（票夹统一管理）。回复用一两句话自然确认入库内容即可，不要复述原始短信/邮件全文，" +
          (optIn && type !== "hotel"
            ? "并确认到站约车需求已记下（若返回 rideReminder 请先创建日程提醒）。"
            : "如用户提供的信息不全可追问出发/到达时间。"),
      };
    },
  };

  /** 3. 票夹列表 */
  const list_tickets: SkillDefinition = {
    metadata: {
      name: "travel.list-tickets",
      version: "1.0.0",
      displayName: "查看票夹",
      description:
        "列出票夹中未过期的机票/火车票/酒店订单（按出发/入住时间排序）。当用户问「我最近有什么行程」「我的机票/酒店信息」「下周要出差吗」时调用；" +
        "也用于行程问答前先确认用户已录入哪些票。无已录入票时返回空列表并提示可用 travel.parse-ticket 录入。",
      kind: "builtin",
      tags: ["travel", "票夹", "行程", "机票", "酒店"],
      icon: "🗂️",
      parameters: [
        { name: "limit", type: "number", required: false, description: "最多返回条数，默认 10" },
      ],
      outputSchema: {
        ok: "是否成功",
        tickets: "票列表 [{ticketId,type,carrier,code,departTime/arriveTime,fromCity,toCity,seat,checkInDate,checkOutDate,arrivalRideOptIn}]",
        displayNote: "展示提示",
      },
      permissions: [],
      timeoutMs: 5_000,
    },
    handler: async (input) => {
      const limit = typeof input.limit === "number" && input.limit > 0 ? Math.min(Math.floor(input.limit), 50) : 10;
      const tickets = travelTicketStore.listUpcoming(limit);
      return {
        ok: true,
        count: tickets.length,
        tickets: tickets.map((t) => ({
          ticketId: t.ticketId,
          type: t.type,
          carrier: t.carrier,
          ...(t.code ? { code: t.code } : {}),
          ...(t.type === "hotel"
            ? { checkInDate: t.checkInDate, checkOutDate: t.checkOutDate, ...(t.roomType ? { roomType: t.roomType } : {}) }
            : { departTime: t.departTime, ...(t.arriveTime ? { arriveTime: t.arriveTime } : {}), fromCity: t.fromCity, toCity: t.toCity, ...(t.fromStation ? { fromStation: t.fromStation } : {}), ...(t.toStation ? { toStation: t.toStation } : {}), ...(t.seat ? { seat: t.seat } : {}), ...(t.gate ? { gate: t.gate } : {}) }),
          ...(t.arrivalRideOptIn && t.type !== "hotel" ? { arrivalRideOptIn: true } : {}),
        })),
        displayNote: tickets.length
          ? "以上是票夹中的未过期行程。向用户概述时按时间自然组织（如「周六早上的高铁去杭州…」），不要罗列 JSON；用户追问某张票细节再展开。"
          : "票夹为空。可以提示用户：把收到的航班/火车票短信或订单邮件内容发给你，就能自动整理进票夹。",
      };
    },
  };

  /** 4. 打包清单（目的地天气预报驱动） */
  const packing_list: SkillDefinition = {
    metadata: {
      name: "travel.packing-list",
      version: "1.0.0",
      displayName: "生成打包清单",
      description:
        "根据目的地未来几天的天气预报自动生成打包清单：按温度/降水/大风逐日调整衣物、雨具、防晒等，并按天数补充换洗衣物数量，可选偏好（户外/商务/亲子/滑雪/海岛）。" +
        "当用户说「去X要带什么」「帮我列个行李清单」「出发前帮我看看要带啥」时调用。行程太远（>7天预报不可得）时退化为按季节的通用清单。",
      kind: "builtin",
      tags: ["travel", "打包", "行李", "清单", "天气"],
      icon: "🧳",
      parameters: [
        { name: "destination", type: "string", required: true, description: "目的地（如 成都/大理/札幌）" },
        { name: "startDate", type: "string", required: false, description: "出发日期 YYYY-MM-DD（不传按今天）" },
        { name: "days", type: "number", required: false, description: "行程天数，默认 3" },
        { name: "preferences", type: "array", required: false, description: "偏好标签（如 ['户外','商务','亲子','滑雪','海岛']）" },
      ],
      outputSchema: {
        ok: "是否成功",
        destination: "目的地",
        weatherOutlook: "逐日天气概览 [{date,weatherText,minC,maxC,rainPct}]（预报可得时）",
        weatherNote: "天气一句话结论",
        categories: "分类清单 [{category, items:[…]}]",
        displayNote: "展示提示",
      },
      permissions: ["network:external"],
      timeoutMs: 20_000,
    },
    handler: async (input) => {
      const destination = typeof input.destination === "string" ? input.destination.trim() : "";
      if (!destination) return { ok: false, error: "缺少必填参数 destination" };
      const days = typeof input.days === "number" && input.days > 0 ? Math.min(Math.floor(input.days), 30) : 3;
      const startDate = typeof input.startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.startDate.trim())
        ? input.startDate.trim()
        : new Date().toISOString().slice(0, 10);
      const prefs = Array.isArray(input.preferences)
        ? input.preferences.filter((p): p is string => typeof p === "string")
        : [];

      // 1) 天气预报：open-meteo 按目的地坐标取逐日（最多 7 天窗口）
      let perDay: Array<{ date: string; weatherText: string; minC: number; maxC: number; rainPct: number }> = [];
      try {
        const hit = await geocodeCity(destination);
        if (hit) {
          const offsetDays = Math.max(0, Math.round((Date.parse(`${startDate}T00:00:00`) - Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00`)) / 86_400_000));
          const forecastDays = Math.min(7, offsetDays + days);
          const params = new URLSearchParams({
            latitude: String(hit.latitude),
            longitude: String(hit.longitude),
            timezone: "auto",
            daily: ["weather_code", "temperature_2m_max", "temperature_2m_min", "precipitation_probability_max"].join(","),
            forecast_days: String(forecastDays),
          });
          const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, {
            signal: AbortSignal.timeout(12_000),
          });
          const json = (await res.json()) as {
            daily?: {
              time?: string[];
              weather_code?: number[];
              temperature_2m_max?: number[];
              temperature_2m_min?: number[];
              precipitation_probability_max?: (number | null)[];
            };
          };
          const d = json.daily;
          if (d?.time?.length) {
            perDay = d.time.map((date, i) => ({
              date,
              weatherText: WMO_PACK_TEXT[d.weather_code?.[i] ?? 0] ?? "未知",
              minC: Math.round(d.temperature_2m_min?.[i] ?? 0),
              maxC: Math.round(d.temperature_2m_max?.[i] ?? 0),
              rainPct: Math.round(d.precipitation_probability_max?.[i] ?? 0),
            })).slice(offsetDays, offsetDays + days);
          }
        }
      } catch {
        // 预报不可得 → 通用清单
      }

      const tripDays = perDay.length || days;
      const minC = perDay.length ? Math.min(...perDay.map((d) => d.minC)) : null;
      const maxC = perDay.length ? Math.max(...perDay.map((d) => d.maxC)) : null;
      const peakRain = perDay.length ? Math.max(...perDay.map((d) => d.rainPct)) : 0;
      const hasSnow = perDay.some((d) => /雪/.test(d.weatherText));
      const hasRain = peakRain >= 40 || perDay.some((d) => /雨/.test(d.weatherText));
      const windy = perDay.length > 0 && minC != null && maxC != null && maxC - minC >= 12;

      const categories: Array<{ category: string; items: string[] }> = [];
      const push = (category: string, items: string[]) => {
        if (items.length) categories.push({ category, items });
      };

      // 证件文件
      push("证件文件", ["身份证", "手机充电宝/充电线", ...(prefs.includes("出境") || /[^\u4e00-\u9fa5]/.test(destination) ? ["护照/签证", "少量外币现金"] : [])]);

      // 衣物（按温度带）
      const clothes: string[] = [];
      if (minC != null) {
        if (minC <= 0) clothes.push("羽绒服/厚外套", "毛衣/抓绒", "保暖内衣", "帽子围巾手套");
        else if (minC <= 10) clothes.push("厚外套/大衣", "毛衣或卫衣", "长袖打底");
        else if (minC <= 18) clothes.push("外套/夹克", "长袖+薄外套");
        else if (minC <= 26) clothes.push("长袖/短袖+薄外套（早晚温差）");
        else clothes.push("短袖T恤", "透气长裤/短裙");
      } else {
        const month = Number(startDate.slice(5, 7));
        if ([12, 1, 2].includes(month)) clothes.push("冬季外套", "毛衣", "保暖衣物");
        else if ([3, 4, 11].includes(month)) clothes.push("春秋外套", "长袖");
        else clothes.push("夏季衣物", "短袖");
      }
      if (hasSnow) clothes.push("防水鞋", "防滑手套");
      if (windy) clothes.push("可叠穿层次（昼夜温差大）");
      const laundry = tripDays > 7;
      clothes.push(`换洗衣物（${laundry ? `行程 ${tripDays} 天，建议按 4-5 套+中途洗衣` : `行程 ${tripDays} 天，按天带`})`);
      push("衣物", clothes);

      // 雨具与防晒
      const rainSun: string[] = [];
      if (hasRain) rainSun.push("折叠伞/轻便雨衣");
      if (maxC != null && maxC >= 26) rainSun.push("防晒霜", "太阳镜/遮阳帽");
      if (prefs.includes("海岛") || prefs.includes("海岛度假") || (maxC != null && maxC >= 30)) rainSun.push("泳衣", "拖鞋");
      push("雨具/防晒", rainSun);

      // 洗漱与健康
      const care: string[] = ["牙刷/牙膏等洗漱包", "常用药品（感冒/肠胃/创可贴）"];
      if (prefs.includes("亲子")) care.push("儿童常用药与退热贴", "零食/玩具安抚物");
      push("洗漱/健康", care);

      // 偏好加项
      const extras: string[] = [];
      if (prefs.includes("户外") || prefs.includes("徒步")) extras.push("登山鞋", "双肩包", "便携水壶");
      if (prefs.includes("商务")) extras.push("正装/皮鞋", "笔记本电脑与转接头", "名片");
      if (prefs.includes("滑雪")) extras.push("滑雪服/雪镜（或现场租）", "防水手套");
      if (prefs.includes("亲子")) extras.push("婴儿车/儿童背包（按年龄）");
      push("按你的偏好加项", extras);

      const weatherNote = perDay.length
        ? `${destination} 期间约 ${minC}–${maxC}°C，${perDay[0].weatherText}为主${hasRain ? "，有降雨（峰值概率 " + peakRain + "%）" : ""}${hasSnow ? "，可能降雪" : ""}。`
        : `出行日期超出 7 天预报窗口，${destination} 清单按季节通用版生成，临近出发可再让我更新。`;

      return {
        ok: true,
        destination,
        startDate,
        days: tripDays,
        ...(perDay.length ? { weatherOutlook: perDay } : {}),
        weatherNote,
        categories,
        displayNote:
          "清单已按目的地天气生成。展示时按分类自然口语化概括（重点讲天气驱动的取舍，如「那边有雨，记得带伞」），" +
          "清单本身会以卡片完整展示，不要逐条复述全部条目。",
      };
    },
  };

  return [departure_advice, parse_ticket, list_tickets, packing_list];
}

/** 打包清单用 WMO 简表（复用 weather-service 的语义，避免额外依赖其内部实现） */
const WMO_PACK_TEXT: Record<number, string> = {
  0: "晴", 1: "大部晴朗", 2: "多云", 3: "阴", 45: "雾", 48: "雾凇",
  51: "毛毛雨", 53: "毛毛雨", 55: "毛毛雨", 61: "小雨", 63: "中雨", 65: "大雨",
  66: "冻雨", 67: "冻雨", 71: "小雪", 73: "中雪", 75: "大雪", 77: "雪粒",
  80: "阵雨", 81: "阵雨", 82: "强阵雨", 85: "阵雪", 86: "阵雪", 95: "雷暴",
  96: "雷暴伴冰雹", 99: "雷暴伴冰雹",
};

/**
 * 注册出行通勤内置 Skills 到 SkillManager。
 */
export function registerTravelCommuteBuiltinSkills(
  register: (skill: SkillDefinition) => void,
  deps: Deps,
): void {
  for (const s of createTravelCommuteBuiltinSkills(deps)) {
    register(s);
  }
}
