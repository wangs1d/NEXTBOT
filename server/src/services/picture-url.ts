/**
 * 图库资源 URL。分区后 `/picture/assets/:id/...` 要先认出归属 actor 才能落到对应目录，
 * 所以服务端发出的相对 URL 自带身份参数（路由按 query.userId 优先解析），客户端只需
 * 在前面拼 httpBase，不必各自记得补身份——漏补的表现是图片 404 而不是报错。
 */
export function pictureAssetUrl(path: string, actorId: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}userId=${encodeURIComponent(actorId)}`;
}
