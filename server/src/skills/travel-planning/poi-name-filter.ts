/**
 * POI 名称可信度过滤（真实数据保证）：
 * OSM/高德会返回大量非旅游 POI（事故多发段、公厕、停车场、收费站、施工段…），
 * 这类名称混进行程会直接毁掉整份规划的可信度。命中黑名单的一律丢弃。
 * 2026-10-27 从 travel-planning-service 抽出独立模块：Overpass 实时发现源
 * （overpass-service.ts）与主服务共用同一份黑名单，避免两处漂移。
 */
const POI_NAME_BLACKLIST = [
  '事故', '公厕', '厕所', '洗手间', '停车场', '收费站', '加油', '充电桩',
  '垃圾', '污水', '殡仪', '火葬', '墓', '变电站', '配电', '水厂', '污水处理',
  '施工', '工地', '限速', '测速', '监控', '红绿灯', '信号灯', '公交站',
  '地铁站入口', '出入口', '售票处', '检票口', '充值', '营业厅', '警务',
  '派出所', '消防', '急诊', '发热门诊', '隔离', '收费站', '养护', '道班',
  // 单位内部食堂在 OSM 里常挂 amenity=restaurant，被当「餐厅」排进行程（用户实测踩坑）
  '食堂',
  // 高德脏 POI（2026-10-15 实证：keywords「公园」会命中挂错类目的机构/地名）
  '居委会', '村委会', '工作委员会', '社区服务', '绿道', '管理处', '工作站',
  '服务区', '养护站', '道班房', '门禁', '值班室',
];

export function isPlausiblePoiName(name: string): boolean {
  const n = (name || '').trim();
  if (n.length < 2 || n.length > 30) return false;
  if (POI_NAME_BLACKLIST.some((bad) => n.includes(bad))) return false;
  // 纯数字/纯符号名（如「1号」「①」）对行程毫无意义
  if (!/[\u4e00-\u9fa5A-Za-z]/.test(n)) return false;
  // 纯 ASCII 字母数字混排单 token（如「Mounbar423」）是 OSM 脏 name 标签的典型
  // 形态；带空格/连字符的正常店名（「Bar 423」「798艺术区」不受影响——后者含 CJK）
  if (/^[A-Za-z\d]+$/.test(n) && /[A-Za-z]/.test(n) && /\d/.test(n)) return false;
  return true;
}
