// Reads the screenshots WebdriverIO takes, which are 8-bit, non-interlaced
// RGB or RGBA PNG images, so that tests can check what a frame shows even when
// they cannot reach into its document.

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
