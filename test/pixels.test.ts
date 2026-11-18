import assert from "node:assert/strict";
import { describe, it } from "node:test";
import zlib from "node:zlib";
import { type Color, decodePng, solidPng } from "./e2e/support/pixels.ts";

// The end-to-end tests read WebdriverIO's screenshots with decodePng. Chromium's encoder chooses
// a filter for each row, so these images use every filter that PNG defines.

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function chunk(type: string, body: Buffer): Buffer {
  const typed = Buffer.concat([Buffer.from(type, "latin1"), body]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const check = Buffer.alloc(4);
  check.writeUInt32BE(zlib.crc32(typed));
  return Buffer.concat([length, typed, check]);
}

/** A PNG of `pixels`, RGB or RGBA, with the filter that `filterOf` gives each row. */
function encodePng(
  width: number,
  height: number,
  channels: 3 | 4,
  pixels: Buffer,
  filterOf: (row: number) => number,
): Buffer {
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    const filter = filterOf(y);
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? pixels[y * stride + x - channels] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
      const predictor = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter] ?? 0;
      raw[y * (stride + 1) + 1 + x] = (pixels[y * stride + x] - predictor) & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Bytes that make every filter's sums wrap past 255, the same on every run. */
function noise(length: number): Buffer {
  const bytes = Buffer.alloc(length);
  let state = 12345;
  for (let index = 0; index < length; index += 1) {
    state = (state * 1103515245 + 12345) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

function rgbOf(pixels: Buffer, channels: number): Buffer {
  return Buffer.from(pixels.filter((_, index) => index % channels < 3));
}

describe("decoding screenshots", () => {
  for (const channels of [3, 4] as const) {
    it(`decodes ${channels === 3 ? "RGB" : "RGBA"} rows with each filter`, () => {
      const [width, height] = [13, 10];
      const pixels = noise(width * height * channels);
      const filters: ((row: number) => number)[] = [0, 1, 2, 3, 4].map((filter) => () => filter);
      for (const filterOf of [...filters, (row: number) => row % 5]) {
        const decoded = decodePng(encodePng(width, height, channels, pixels, filterOf));
        assert.deepEqual([decoded.width, decoded.height], [width, height]);
        assert.ok(decoded.rgb.equals(rgbOf(pixels, channels)), `filter of row 1: ${filterOf(1)}`);
      }
    });
  }

  it("counts the pixels of a color", () => {
    const color: Color = [255, 150, 50];
    const decoded = decodePng(solidPng(4, color));
    assert.equal(decoded.count(color), 16);
    assert.equal(decoded.count([255, 150, 57]), 0);
    assert.equal(decoded.count([255, 150, 56]), 16);
  });

  it("refuses a row filter that PNG does not define", () => {
    const png = encodePng(2, 2, 3, noise(12), (y) => (y === 1 ? 5 : 0));
    assert.throws(() => decodePng(png), /filter 5 in row 1/);
  });
});
