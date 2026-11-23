import "dart:math" as math;

/// WGS-84 ↔ GCJ-02（国测局「火星坐标」）转换。
///
/// 坐标基准约定（与服务端一致）：
///   - 手机 GPS、服务端载荷、卡片下发/回传 → 一律 **WGS-84**；
///   - 高德栅格瓦片（webrd*.autonavi.com）、滴滴滴图 → **GCJ-02**。
///
/// 把 WGS-84 直接画到高德底图上会整体偏移 300~700m（定位点飘到隔壁街），
/// 所以进出 FlutterMap 时各转一次：
///   - 交给地图渲染前：wgs84ToGcj02
///   - 用户选点回传服务端前：gcj02ToWgs84
///
/// 公式与 server/src/skills/travel-planning/coord-transform.ts 一致。
const double _a = 6378245.0;
const double _ee = 0.00669342162296594323;

bool _outOfChina(double lat, double lon) =>
    lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271;

double _transformLat(double x, double y) {
  double ret =
      -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * math.sqrt(x.abs());
  ret += (20 * math.sin(6 * x * math.pi) + 20 * math.sin(2 * x * math.pi)) * 2 / 3;
  ret += (20 * math.sin(y * math.pi) + 40 * math.sin(y / 3 * math.pi)) * 2 / 3;
  ret += (160 * math.sin(y / 12 * math.pi) + 320 * math.sin(y * math.pi / 30)) * 2 / 3;
  return ret;
}

double _transformLon(double x, double y) {
  double ret =
      300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * math.sqrt(x.abs());
  ret += (20 * math.sin(6 * x * math.pi) + 20 * math.sin(2 * x * math.pi)) * 2 / 3;
  ret += (20 * math.sin(x * math.pi) + 40 * math.sin(x / 3 * math.pi)) * 2 / 3;
  ret += (150 * math.sin(x / 12 * math.pi) + 300 * math.sin(x / 30 * math.pi)) * 2 / 3;
  return ret;
}

/// WGS-84 → GCJ-02（画到高德底图/调滴滴前）。
({double lat, double lng}) wgs84ToGcj02(double lat, double lon) {
  if (_outOfChina(lat, lon)) return (lat: lat, lng: lon);
  final double dLat = _transformLat(lon - 105, lat - 35);
  final double dLon = _transformLon(lon - 105, lat - 35);
  final double radLat = lat / 180 * math.pi;
  double magic = math.sin(radLat);
  magic = 1 - _ee * magic * magic;
  final double sqrtMagic = math.sqrt(magic);
  final double offsetLat =
      (dLat * 180) / ((_a * (1 - _ee)) / (magic * sqrtMagic) * math.pi);
  final double offsetLon =
      (dLon * 180) / (_a / sqrtMagic * math.cos(radLat) * math.pi);
  return (lat: lat + offsetLat, lng: lon + offsetLon);
}

/// GCJ-02 → WGS-84（高德/滴滴坐标回到服务端基准）。
///
/// GCJ 加密是非线性的，用迭代逼近（3 次收敛到亚米级）。
({double lat, double lng}) gcj02ToWgs84(double lat, double lon) {
  if (_outOfChina(lat, lon)) return (lat: lat, lng: lon);
  double wgsLat = lat;
  double wgsLon = lon;
  for (int i = 0; i < 3; i++) {
    final ({double lat, double lng}) g = wgs84ToGcj02(wgsLat, wgsLon);
    wgsLat -= g.lat - lat;
    wgsLon -= g.lng - lon;
  }
  return (lat: wgsLat, lng: wgsLon);
}
