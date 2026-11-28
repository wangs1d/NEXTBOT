/**
 * 媒体保留期清理单测：只删本服务命名的旧文件，其余一律保留。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runMediaRetentionOnce } from "../src/services/media-retention-service.js";

const DAY = 24 * 60 * 60 * 1000;

function touch(path: string, ageDays: number): void {
  const t = (Date.now() - ageDays * DAY) / 1000;
  utimesSync(path, t, t);
}

test("媒体保留：删除 7 天前的原图与缩略图，保留新图与非本服务文件", async () => {
  const root = mkdtempSync(join(tmpdir(), "media-retention-"));
  const images = join(root, "images");
  const thumbs = join(root, "images-thumbs");
  mkdirSync(join(images, "actor-a"), { recursive: true });
  mkdirSync(join(thumbs, "actor-a"), { recursive: true });

  const oldImg = join(images, "actor-a", "1700000000000-aaaaaaaa.png");
  const newImg = join(images, "actor-a", "1790000000000-bbbbbbbb.webp");
  const userNote = join(images, "actor-a", "readme.txt");
  const oldThumb = join(thumbs, "actor-a", "1700000000000-aaaaaaaa@400.webp");
  const newThumb = join(thumbs, "actor-a", "1790000000000-bbbbbbbb@400.webp");
  for (const f of [oldImg, newImg, userNote, oldThumb, newThumb]) writeFileSync(f, "x");

  touch(oldImg, 8);
  touch(newImg, 1);
  touch(userNote, 30);
  touch(oldThumb, 8);
  touch(newThumb, 1);

  const stats = await runMediaRetentionOnce({ roots: [images, thumbs] });
  assert.equal(stats.deleted, 2, "应删除旧原图 + 旧缩略图");
  assert.equal(existsSync(oldImg), false);
  assert.equal(existsSync(oldThumb), false);
  assert.equal(existsSync(newImg), true);
  assert.equal(existsSync(newThumb), true);
  assert.equal(existsSync(userNote), true, "非本服务命名的文件不能删");
});

test("媒体保留：dryRun 只统计不删除", async () => {
  const root = mkdtempSync(join(tmpdir(), "media-retention-dry-"));
  const images = join(root, "images");
  mkdirSync(join(images, "actor-a"), { recursive: true });
  const oldImg = join(images, "actor-a", "1700000000000-cccccccc.png");
  writeFileSync(oldImg, "x");
  touch(oldImg, 9);

  const stats = await runMediaRetentionOnce({ roots: [images], dryRun: true });
  assert.equal(stats.deleted, 1);
  assert.equal(existsSync(oldImg), true);
});
