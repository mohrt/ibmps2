import { describe, expect, it } from 'vitest';
import { MAX_WIDTH, Vga } from '../src/video/vga';

/** Register values for the BIOS modes the tests use. */
const MODES = {
  // 80x25 text.
  3: {
    misc: 0x67,
    seq: [0x03, 0x00, 0x03, 0x00, 0x02],
    crtc: [
      0x5f, 0x4f, 0x50, 0x82, 0x55, 0x81, 0xbf, 0x1f, 0x00, 0x4f, 0x0d, 0x0e, 0x00, 0x00, 0x00, 0x00, 0x9c, 0x8e, 0x8f, 0x28,
      0x1f, 0x96, 0xb9, 0xa3, 0xff,
    ],
    gc: [0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x0e, 0x00, 0xff],
    attr: [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x14, 0x07, 0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f, 0x0c, 0x00, 0x0f, 0x08, 0x00],
  },
  // 320x200 in 256 colours.
  0x13: {
    misc: 0x63,
    seq: [0x03, 0x01, 0x0f, 0x00, 0x0e],
    crtc: [
      0x5f, 0x4f, 0x50, 0x82, 0x54, 0x80, 0xbf, 0x1f, 0x00, 0x41, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x9c, 0x8e, 0x8f, 0x28,
      0x40, 0x96, 0xb9, 0xa3, 0xff,
    ],
    gc: [0x00, 0x00, 0x00, 0x00, 0x00, 0x40, 0x05, 0x0f, 0xff],
    attr: [...Array.from({ length: 16 }, (_, i) => i), 0x41, 0x00, 0x0f, 0x00, 0x00],
  },
  // 640x480 in 16 colours.
  0x12: {
    misc: 0xe3,
    seq: [0x03, 0x01, 0x0f, 0x00, 0x06],
    crtc: [
      0x5f, 0x4f, 0x50, 0x82, 0x54, 0x80, 0x0b, 0x3e, 0x00, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xea, 0x8c, 0xdf, 0x28,
      0x00, 0xe7, 0x04, 0xe3, 0xff,
    ],
    gc: [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05, 0x0f, 0xff],
    attr: [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x14, 0x07, 0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f, 0x01, 0x00, 0x0f, 0x00, 0x00],
  },
};

function setMode(vga: Vga, mode: keyof typeof MODES): void {
  const m = MODES[mode];
  vga.write(0x3c2, m.misc);
  m.seq.forEach((value, i) => (vga.write(0x3c4, i), vga.write(0x3c5, value)));
  vga.write(0x3d4, 0x11);
  vga.write(0x3d5, 0x00);
  m.crtc.forEach((value, i) => (vga.write(0x3d4, i), vga.write(0x3d5, value)));
  m.gc.forEach((value, i) => (vga.write(0x3ce, i), vga.write(0x3cf, value)));
  vga.read(0x3da);
  m.attr.forEach((value, i) => (vga.write(0x3c0, i), vga.write(0x3c0, value)));
  vga.write(0x3c0, 0x20);
  // A grey ramp in the DAC, so colours can be told apart.
  vga.write(0x3c8, 0);
  for (let i = 0; i < 256; i++) for (let c = 0; c < 3; c++) vga.write(0x3c9, i & 0x3f);
}

/** Runs one whole frame. */
const frame = (vga: Vga) => {
  const before = vga.frames;
  while (vga.frames === before) vga.advance(0.001);
};

describe('VGA memory', () => {
  it('chains four planes in mode 13h, one pixel a byte', () => {
    const vga = new Vga();
    setMode(vga, 0x13);
    vga.writeMemory(0xa0000 + 5, 0x22);
    expect(vga.vram[1 * 0x10000 + 4]).toBe(0x22);
    expect(vga.readMemory(0xa0005)).toBe(0x22);
  });

  it('writes planes through set/reset and the bit mask, and compares colours', () => {
    const vga = new Vga();
    setMode(vga, 0x12);
    // Write mode 0 with set/reset to colour 9 on all bits of the first byte.
    vga.write(0x3ce, 0);
    vga.write(0x3cf, 0x09);
    vga.write(0x3ce, 1);
    vga.write(0x3cf, 0x0f);
    vga.writeMemory(0xa0000, 0x00);
    expect([0, 1, 2, 3].map((p) => vga.vram[p * 0x10000])).toEqual([0xff, 0x00, 0x00, 0xff]);
    // Bit mask: only the low nibble changes to colour 0 (latches keep the rest).
    vga.readMemory(0xa0000);
    vga.write(0x3cf, 0x0f);
    vga.write(0x3ce, 0);
    vga.write(0x3cf, 0x00);
    vga.write(0x3ce, 8);
    vga.write(0x3cf, 0x0f);
    vga.writeMemory(0xa0000, 0x00);
    expect(vga.vram[0]).toBe(0xf0);
    // Read mode 1: which pixels are colour 9.
    vga.write(0x3cf, 0xff);
    vga.write(0x3ce, 5);
    vga.write(0x3cf, 0x08);
    vga.write(0x3ce, 2);
    vga.write(0x3cf, 0x09);
    expect(vga.readMemory(0xa0000)).toBe(0xf0);
  });

  it('splits even and odd bytes between planes 0 and 1 in text mode', () => {
    const vga = new Vga();
    setMode(vga, 3);
    vga.writeMemory(0xb8000, 0x41);
    vga.writeMemory(0xb8001, 0x1e);
    expect(vga.vram[0]).toBe(0x41);
    expect(vga.vram[0x10000]).toBe(0x1e);
    expect(vga.readMemory(0xb8001)).toBe(0x1e);
  });
});

describe('VGA picture', () => {
  it('draws mode 13h pixels two dots wide through the DAC', () => {
    const vga = new Vga();
    setMode(vga, 0x13);
    vga.writeMemory(0xa0000 + 320 * 10 + 7, 0x3f);
    frame(vga);
    frame(vga);
    expect([vga.width, vga.height]).toEqual([640, 400]);
    const white = vga.framebuffer[20 * MAX_WIDTH + 14];
    expect(white).toBe(0xffffffff);
    expect(vga.framebuffer[20 * MAX_WIDTH + 15]).toBe(white);
    expect(vga.framebuffer[22 * MAX_WIDTH + 14]).not.toBe(white);
  });

  it('draws 9-dot text from the font in plane 2', () => {
    const vga = new Vga();
    setMode(vga, 3);
    // A solid character 1 in the font, written to plane 2 with the planes unchained.
    for (let row = 0; row < 16; row++) vga.vram[2 * 0x10000 + 1 * 32 + row] = 0xff;
    vga.writeMemory(0xb8000, 0x01);
    vga.writeMemory(0xb8001, 0x0f);
    frame(vga);
    frame(vga);
    expect([vga.width, vga.height]).toEqual([720, 400]);
    expect(vga.framebuffer[5 * MAX_WIDTH + 0]).toBe(vga.framebuffer[5 * MAX_WIDTH + 7]);
    expect(vga.framebuffer[5 * MAX_WIDTH + 0]).not.toBe(vga.framebuffer[5 * MAX_WIDTH + 12]);
  });

  it('runs text modes at 70 Hz and reports vertical retrace', () => {
    const vga = new Vga();
    setMode(vga, 3);
    let retraces = 0;
    let was = false;
    for (let t = 0; t < 1; t += 0.00002) {
      vga.advance(0.00002);
      const now = (vga.read(0x3da) & 8) !== 0;
      if (now && !was) retraces++;
      was = now;
    }
    expect(retraces).toBeGreaterThanOrEqual(69);
    expect(retraces).toBeLessThanOrEqual(71);
  });
});
