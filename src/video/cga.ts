import { MAX_WIDTH } from './vga';

/** CGA's 16 colours (RGBI), as ABGR; colour 6 is brown, as IBM's monitor showed it. */
const RGBI = [
  0x000000, 0x0000aa, 0x00aa00, 0x00aaaa, 0xaa0000, 0xaa00aa, 0xaa5500, 0xaaaaaa, 0x555555, 0x5555ff, 0x55ff55, 0x55ffff,
  0xff5555, 0xff55ff, 0xffff55, 0xffffff,
].map((rgb) => 0xff000000 | ((rgb & 0xff) << 16) | (rgb & 0xff00) | (rgb >> 16));

const DOT_CLOCK = 14_318_180;
/** CGA's vertical sync lasts 16 lines. */
const VSYNC_LINES = 16;
const VRAM_BYTES = 0x4000;
/** The CGA font: the thick 8x8 set in the MDA/CGA character ROM. */
const FONT_OFFSET = 0x1800;

/**
 * IBM's Color/Graphics Adapter: a Motorola 6845 CRT controller, 16 KB of
 * video memory at B8000h, 40- and 80-column text, 320x200 in four colours
 * and 640x200 in two. It is drawn a line at a time as the beam reaches it,
 * each line twice so the picture keeps its shape, and reports retrace from
 * the 6845's timing. The character ROM is the user's.
 */
export class Cga {
  readonly vram = new Uint8Array(VRAM_BYTES);
  readonly crtc = new Uint8Array(18);
  crtcIndex = 0;
  mode = 0;
  colorSelect = 0;
  /** The character ROM's 8x8 font. */
  font = new Uint8Array(0x800);
  readonly framebuffer = new Uint32Array(MAX_WIDTH * 400);
  width = 640;
  height = 400;
  frames = 0;
  onFrame: (framebuffer: Uint32Array, width: number, height: number) => void = () => {};
  onInterrupt: (high: boolean) => void = () => {};
  private line = 0;
  private lineTime = 0;
  private rowStart = 0;
  private rowScan = 0;
  private row = 0;

  setFont(rom: Uint8Array): void {
    this.font = rom.slice(FONT_OFFSET, FONT_OFFSET + 0x800);
  }

  powerOn(): void {
    this.vram.fill(0);
    this.crtc.fill(0);
    this.mode = this.colorSelect = 0;
    this.line = 0;
  }

  // --- Timing -------------------------------------------------------------------------

  /** Dots a character clock lasts: 8 in 80-column text, 16 otherwise (a clock is two bytes of graphics). */
  private get charDots(): number {
    return this.mode & 0x01 ? 8 : 16;
  }

  private get lineSeconds(): number {
    const chars = this.crtc[0] + 1;
    return chars < 20 ? 1 / 15700 : (chars * this.charDots) / DOT_CLOCK;
  }

  private get scanLines(): number {
    return (this.crtc[9] & 0x1f) + 1;
  }

  private get totalLines(): number {
    const total = ((this.crtc[4] & 0x7f) + 1) * this.scanLines + (this.crtc[5] & 0x1f);
    return total < 100 ? 262 : total;
  }

  private get displayedLines(): number {
    return (this.crtc[6] & 0x7f) * this.scanLines;
  }

  private get syncLine(): number {
    return (this.crtc[7] & 0x7f) * this.scanLines;
  }

  /** The status register (3DAh): bit 0 outside the displayed area, bit 3 vertical sync. */
  private get status(): number {
    const position = this.lineTime / this.lineSeconds;
    const shown = this.crtc[1] / (this.crtc[0] + 1);
    const blank = this.line >= this.displayedLines || position >= shown;
    const sync = this.line >= this.syncLine && this.line < this.syncLine + VSYNC_LINES;
    return (blank ? 0x01 : 0) | (sync ? 0x08 : 0) | 0xf0;
  }

  advance(seconds: number): void {
    this.lineTime += seconds;
    let lineSeconds = this.lineSeconds;
    while (this.lineTime >= lineSeconds) {
      this.lineTime -= lineSeconds;
      this.endLine();
      lineSeconds = this.lineSeconds;
    }
  }

  private endLine(): void {
    if (this.line === 0) {
      this.rowStart = ((this.crtc[12] << 8) | this.crtc[13]) & 0x3fff;
      this.rowScan = 0;
      this.row = 0;
      const width = this.crtc[1] * 8 * (this.charDots / 8);
      if (width >= 160) this.width = Math.min(MAX_WIDTH, width);
      const height = this.displayedLines * 2;
      if (height >= 100) this.height = Math.min(400, height);
    }
    if (this.line < this.displayedLines && this.line * 2 + 1 < 400) this.drawLine(this.line);
    this.line++;
    if (this.line === this.syncLine) {
      this.frames++;
      this.onFrame(this.framebuffer, this.width, this.height);
    }
    if (this.line >= this.totalLines) this.line = 0;
  }

  // --- Drawing ------------------------------------------------------------------------

  private drawLine(y: number): void {
    const out = this.framebuffer;
    const row = y * 2 * MAX_WIDTH;
    const width = this.width;
    const vram = this.vram;
    const chars = this.crtc[1];
    if (!(this.mode & 0x08)) {
      out.fill(RGBI[0], row, row + width);
    } else if (this.mode & 0x02) {
      let x = 0;
      for (let ch = 0; ch < chars; ch++) {
        const base = (((this.rowStart + ch) * 2) & 0x1fff) | ((this.rowScan & 1) << 13);
        for (const byte of [vram[base], vram[(base + 1) & 0x3fff]]) {
          if (this.mode & 0x10) {
            const fg = RGBI[this.colorSelect & 0xf];
            for (let bit = 7; bit >= 0; bit--) out[row + x++] = (byte >> bit) & 1 ? fg : RGBI[0];
          } else {
            const palette = this.palette();
            for (let pixel = 3; pixel >= 0; pixel--) {
              const color = palette[(byte >> (pixel * 2)) & 3];
              out[row + x++] = color;
              out[row + x++] = color;
            }
          }
        }
      }
    } else {
      const blink = (this.mode & 0x20) !== 0;
      const blinkOn = (this.frames & 16) !== 0;
      const cursorMode = (this.crtc[10] >> 5) & 3;
      const cursorOn = cursorMode !== 1 && (this.frames & 8) !== 0;
      const cursorStart = this.crtc[10] & 0x1f;
      const cursorEnd = this.crtc[11] & 0x1f;
      const cursorAt = ((this.crtc[14] << 8) | this.crtc[15]) & 0x3fff;
      const repeat = this.charDots / 8;
      let x = 0;
      for (let ch = 0; ch < chars; ch++) {
        const ma = (this.rowStart + ch) & 0x3fff;
        const code = vram[(ma * 2) & 0x3fff];
        const attribute = vram[(ma * 2 + 1) & 0x3fff];
        let bits = this.rowScan < 8 ? this.font[code * 8 + this.rowScan] : 0;
        let fg = attribute & 0xf;
        let bg = attribute >> 4;
        if (blink) {
          bg &= 7;
          if (attribute & 0x80 && !blinkOn) fg = bg;
        }
        if (cursorOn && ma === cursorAt && this.rowScan >= cursorStart && this.rowScan <= cursorEnd) bits = 0xff;
        for (let bit = 7; bit >= 0; bit--) {
          const color = RGBI[(bits >> bit) & 1 ? fg : bg];
          for (let r = 0; r < repeat; r++) out[row + x++] = color;
        }
      }
    }
    // Each line twice.
    out.copyWithin(row + MAX_WIDTH, row, row + width);
    if (this.rowScan >= this.scanLines - 1) {
      this.rowScan = 0;
      this.row++;
      this.rowStart = (this.rowStart + chars) & 0x3fff;
    } else {
      this.rowScan++;
    }
  }

  /** The four colours of 320x200: the background, then palette 0 (green, red, brown) or 1 (cyan, magenta, white). */
  private palette(): number[] {
    const intensity = this.colorSelect & 0x10 ? 8 : 0;
    const background = RGBI[this.colorSelect & 0xf];
    // With colour burst off, the third palette (cyan, red, white).
    const colors = this.mode & 0x04 ? [3, 4, 7] : this.colorSelect & 0x20 ? [3, 5, 7] : [2, 4, 6];
    return [background, ...colors.map((c) => RGBI[c + intensity])];
  }

  // --- Memory and registers -----------------------------------------------------------

  readMemory(address: number): number {
    return address >= 0xb8000 ? this.vram[(address - 0xb8000) & 0x3fff] : 0xff;
  }

  writeMemory(address: number, value: number): void {
    if (address >= 0xb8000) this.vram[(address - 0xb8000) & 0x3fff] = value;
  }

  owns(port: number): boolean {
    return port >= 0x3d0 && port <= 0x3df;
  }

  read(port: number): number {
    switch (port) {
      case 0x3d1:
      case 0x3d3:
      case 0x3d5:
      case 0x3d7:
        // Only the cursor and light pen registers read back.
        return this.crtcIndex >= 14 && this.crtcIndex <= 17 ? this.crtc[this.crtcIndex] : 0xff;
      case 0x3da:
        return this.status;
      default:
        return 0xff;
    }
  }

  write(port: number, value: number): void {
    switch (port) {
      case 0x3d0:
      case 0x3d2:
      case 0x3d4:
      case 0x3d6:
        this.crtcIndex = value & 0x1f;
        break;
      case 0x3d1:
      case 0x3d3:
      case 0x3d5:
      case 0x3d7:
        if (this.crtcIndex < 16) this.crtc[this.crtcIndex] = value;
        break;
      case 0x3d8:
        this.mode = value;
        break;
      case 0x3d9:
        this.colorSelect = value;
        break;
    }
  }
}
