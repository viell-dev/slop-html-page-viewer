// Reads the screenshots WebdriverIO takes, which are 8-bit, non-interlaced
// RGB or RGBA PNG images, so that tests can check what a frame shows even when
// they cannot reach into its document, and writes solid-colour fixtures.

import zlib from "node:zlib";

export type Color = readonly [red: number, green: number, blue: number];

export interface Pixels {
  readonly width: number;
  readonly height: number;
  /** How many pixels are within `tolerance` of `color` in every channel. */
  count(color: Color, tolerance?: number): number;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function chunk(type: string, body: Buffer): Buffer {
  const typed = Buffer.concat([Buffer.from(type, "latin1"), body]);
  let crc = 0xffffffff;
  for (const byte of typed) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const check = Buffer.alloc(4);
  check.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, typed, check]);
}

/** A square PNG of one colour, for fixtures that tests write at run time. */
export function solidPng(size: number, color: Color): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => color).flat())]);
  const data = zlib.deflateSync(Buffer.concat(Array.from({ length: size }, () => row)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", data),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function decodePng(png: Buffer): Pixels {
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const data: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("latin1", offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [bitDepth, colorType, , , interlace] = body.subarray(8, 13);
      if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
        throw new Error(`Unsupported PNG: depth ${bitDepth}, colour type ${colorType}`);
      }
      channels = colorType === 6 ? 4 : 3;
    } else if (type === "IDAT") {
      data.push(body);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  const raw = zlib.inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? pixels[y * stride + x - channels] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
      const predictor = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter] ?? 0;
      pixels[y * stride + x] = (raw[line + x] + predictor) & 0xff;
    }
  }

  return {
    width,
    height,
    count(color, tolerance = 6) {
      let matches = 0;
      for (let index = 0; index < pixels.length; index += channels) {
        if (
          Math.abs(pixels[index] - color[0]) <= tolerance &&
          Math.abs(pixels[index + 1] - color[1]) <= tolerance &&
          Math.abs(pixels[index + 2] - color[2]) <= tolerance
        ) {
          matches += 1;
        }
      }
      return matches;
    },
  };
}
