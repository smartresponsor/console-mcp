import { crc32, deflateSync } from "node:zlib";

export function pngChunk(type, payload) {
  const chunk = Buffer.alloc(payload.length + 12);
  chunk.writeUInt32BE(payload.length, 0);
  chunk.write(type, 4, "ascii");
  payload.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}
export function makePng(width, height, filter = 0, colorType = 2) {
  const channels = colorType === 6 ? 4 : 3;
  const row = 1 + width * channels;
  const data = Buffer.alloc(row * height);
  for (let i = 0; i < height; i++) data[i * row] = filter;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = colorType;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),
    pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(data)),
    pngChunk("IEND", Buffer.alloc(0))]);
}
