import { createHash } from "node:crypto";

/** Verify each original MediaRecorder chunk and hash the final file in one bounded stream pass. */
export async function verifyRecordingChunks(buffers, expectedChunks) {
  if (!expectedChunks.length) return null;
  const fileHash = createHash("sha256");
  let chunkHash = createHash("sha256");
  let chunkIndex = 0;
  let chunkBytes = 0;
  for await (const buffer of buffers) {
    fileHash.update(buffer);
    let offset = 0;
    while (offset < buffer.length) {
      const expected = expectedChunks[chunkIndex];
      if (!expected || !Number.isSafeInteger(expected.bytes) || expected.bytes < 1) return null;
      const length = Math.min(expected.bytes - chunkBytes, buffer.length - offset);
      chunkHash.update(buffer.subarray(offset, offset + length));
      chunkBytes += length;
      offset += length;
      if (chunkBytes === expected.bytes) {
        if (chunkHash.digest("hex") !== expected.sha256) return null;
        chunkIndex += 1;
        chunkBytes = 0;
        chunkHash = createHash("sha256");
      }
    }
  }
  return chunkIndex === expectedChunks.length ? fileHash.digest("hex") : null;
}
