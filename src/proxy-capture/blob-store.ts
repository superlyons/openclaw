import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import type { CaptureBlobRecord } from "./types.js";

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

// lyc: 向blobDir目录下持久化请求体或响应体, data为请求体或响应体, contentType为请求体或响应体的MIME类型, 返回持久化后的记录ID
export function writeCaptureBlob(params: {
  blobDir: string;
  data: Buffer;
  contentType?: string;
}): CaptureBlobRecord {
  ensureDir(params.blobDir);
  // lyc: 对params.data进行签名; 即计算数据的SHA256哈希值, 并取前24位作为blobId
  const sha256 = createHash("sha256").update(params.data).digest("hex");
  const blobId = sha256.slice(0, 24);
  const outputPath = path.join(params.blobDir, `${blobId}.bin.gz`);
  if (!fs.existsSync(outputPath)) {
    // lyc: 如果文件不存在, 则写入压缩后的数据到文件
    fs.writeFileSync(outputPath, gzipSync(params.data));
  }
  // lyc: 返回blobId, path, encoding, sizeBytes, sha256, contentType(如果有)
  return {
    blobId,
    path: outputPath,
    encoding: "gzip",
    sizeBytes: params.data.byteLength,
    sha256,
    ...(params.contentType ? { contentType: params.contentType } : {}),
  };
}

export function readCaptureBlobText(blobPath: string): string {
  return gunzipSync(fs.readFileSync(blobPath)).toString("utf8");
}
