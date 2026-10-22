import { deflateSync } from 'node:zlib';
import { Cga } from '../../src/video/cga';
import { MAX_WIDTH, type Vga } from '../../src/video/vga';
import { crc32 } from '../../src/util/crc32';

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Encodes the display adapter's last picture as an RGB PNG. */
export function framePng(video: Vga | Cga): Uint8Array {
  const { framebuffer, width, height } = video;
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    for (let x = 0; x < width; x++) {
      const pixel = framebuffer[y * MAX_WIDTH + x];
      raw[row + 1 + x * 3] = pixel & 0xff;
      raw[row + 2 + x * 3] = (pixel >> 8) & 0xff;
      raw[row + 3 + x * 3] = (pixel >> 16) & 0xff;
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

/** The text on a text screen (from the CRTC's start address: in the VGA's plane 0, or the CGA's memory). */
export function screenText(video: Vga | Cga): string {
  const cga = video instanceof Cga;
  const start = ((video.crtc[0x0c] << 8) | video.crtc[0x0d]) * 2;
  const columns = cga ? video.crtc[1] : video.crtc[1] + 1;
  const mask = cga ? 0x3fff : 0xffff;
  const rows = 25;
  const lines: string[] = [];
  for (let row = 0; row < rows; row++) {
    let line = '';
    for (let col = 0; col < columns; col++) {
      const code = video.vram[(start + (row * columns + col) * 2) & mask];
      line += code >= 0x20 && code < 0x7f ? String.fromCharCode(code) : ' ';
    }
    lines.push(line.trimEnd());
  }
  return lines.join('\n').trimEnd();
}
