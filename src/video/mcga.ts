import { MAX_WIDTH } from './vga';

const VRAM_BYTES = 0x10000;
const FONT_BYTES = 0x2000;
const CRTC_REGISTERS = 0x15;
/** The formatter's dot clock, and the CGA's for its 15 kHz timing. */
const VGA_CLOCK = 25_175_000;
const CGA_CLOCK = 14_318_180;
/** The Technical Reference's total adds four lines to the CRTC's figure. */
const EXTRA_LINES = 4;

/** The colours the DAC starts with: CGA's 16. */
const DEFAULT_PALETTE = [
  [0x00, 0x00, 0x00], [0x00, 0x00, 0x2a], [0x00, 0x2a, 0x00], [0x00, 0x2a, 0x2a],
  [0x2a, 0x00, 0x00], [0x2a, 0x00, 0x2a], [0x2a, 0x15, 0x00], [0x2a, 0x2a, 0x2a],
  [0x15, 0x15, 0x15], [0x15, 0x15, 0x3f], [0x15, 0x3f, 0x15], [0x15, 0x3f, 0x3f],
  [0x3f, 0x15, 0x15], [0x3f, 0x15, 0x3f], [0x3f, 0x3f, 0x15], [0x3f, 0x3f, 0x3f],
];

const enum Mode {
  Text,
  Cga4,
  Cga6,
  Mode11,
  Mode13,
}

/** Mode control (3D8h) bits, as on the CGA. */
const enum Cga {
  Columns80 = 0x01,
  Graphics = 0x02,
  Mono = 0x04,
  Enable = 0x08,
  HiRes = 0x10,
  Blink = 0x20,
}

/**
 * The Multi-Color Graphics Array of the PS/2 Model 25 and 30 (the 8086
 * ones): 64 KB of video memory, the CGA's registers and modes drawn on a VGA
 * monitor (text in 8x16 characters from font RAM the BIOS loads, 200-line
 * graphics double scanned), 640x480 in two colours (mode 11h) and 320x200 in
 * 256 (mode 13h), with the VGA's DAC. It is drawn a line at a time as the
 * beam reaches it, and interrupts on IRQ 2 at vertical retrace when asked.
 */
export class Mcga {
  readonly vram = new Uint8Array(VRAM_BYTES);
  readonly font = new Uint8Array(FONT_BYTES);
  readonly crtc = new Uint8Array(CRTC_REGISTERS);
  crtcIndex = 0;
  cgaMode = 0;
  border = 0;
  extMode = 0;
  readonly dac = new Uint8Array(256 * 3);
  dacMask = 0xff;
  dacReadIndex = 0;
  dacWriteIndex = 0;
  dacReadStep = 0;
  dacWriteStep = 0;
  dacLastRead = false;
  readonly palette = new Uint32Array(256);
  /** The gate array's enable (port 65h bit 2). */
  enabled = true;
  readonly framebuffer = new Uint32Array(MAX_WIDTH * 480);
  width = 640;
  height = 400;
  frames = 0;
  onFrame: (framebuffer: Uint32Array, width: number, height: number) => void = () => {};
  onInterrupt: (high: boolean) => void = () => {};
  private line = 0;
  private lineTime = 0;
  private fontPending = false;
  private irqLatch = false;

  powerOn(): void {
    this.crtc.fill(0);
    this.crtc.set([0x30, 0x27, 0x2a, 0x26, 0x80, 0x00, 0x8f, 0x98, 0x00, 0x07, 0x06, 0x07]);
    this.crtc[0x10] = 0x18;
    this.crtc[0x11] = 0x30;
    this.crtc[0x12] = 0x46;
    this.crtc[0x14] = 0xff;
    this.crtcIndex = 0;
    this.cgaMode = 0x29;
    this.border = 0x30;
    this.extMode = 0;
    this.dacMask = 0xff;
    this.dacReadIndex = this.dacWriteIndex = this.dacReadStep = this.dacWriteStep = 0;
    this.dacLastRead = false;
    this.line = 0;
    this.lineTime = 0;
    this.fontPending = false;
    this.irqLatch = false;
    this.onInterrupt(false);
    this.vram.fill(0);
    this.font.fill(0);
    this.dac.fill(0);
    DEFAULT_PALETTE.forEach((rgb, i) => this.dac.set(rgb, i * 3));
    for (let i = 0; i < 256; i++) this.updateColor(i);
    this.enabled = true;
  }

  private updateColor(index: number): void {
    const scale = (v: number) => ((v & 0x3f) << 2) | ((v & 0x3f) >> 4);
    const [r, g, b] = [0, 1, 2].map((c) => scale(this.dac[index * 3 + c]));
    this.palette[index] = 0xff000000 | (b << 16) | (g << 8) | r;
  }

  private get mode(): Mode {
    if (this.crtc[0x10] & 0x01 && this.extMode & 0x04) return Mode.Mode13;
    if (this.crtc[0x10] & 0x02) return Mode.Mode11;
    if (this.cgaMode & Cga.HiRes) return Mode.Cga6;
    if (this.cgaMode & Cga.Graphics) return Mode.Cga4;
    return Mode.Text;
  }

  /** 40-column text, 320-wide graphics and mode 13h show each dot twice. */
  private get doubleWidth(): boolean {
    const mode = this.mode;
    return !(mode === Mode.Cga6 || mode === Mode.Mode11 || (mode === Mode.Text && this.cgaMode & Cga.Columns80));
  }

  // --- Timing -------------------------------------------------------------------------

  private get lineSeconds(): number {
    return ((this.crtc[0] + 2) * 16) / (this.crtc[0x10] & 0x10 ? VGA_CLOCK : CGA_CLOCK);
  }

  /** The high bit of the vertical registers, which bit 6 of register 10h clears. */
  private get vertical9(): number {
    return this.crtc[0x10] & 0x40 ? 0 : 0x100;
  }

  private get displayedLines(): number {
    return (this.vertical9 | this.crtc[6]) + 1;
  }

  private get totalLines(): number {
    return (this.vertical9 | this.crtc[4]) + this.crtc[5] + EXTRA_LINES;
  }

  private get syncLine(): number {
    return (this.vertical9 | this.crtc[7]) + 1;
  }

  private get syncLines(): number {
    return (this.crtc[3] >> 4) & 0x0f || 16;
  }

  /** The status register (3DAh): bit 0 while the beam isn't drawing, bit 3 in vertical retrace. */
  private get status(): number {
    const shown = (this.crtc[1] + 1) / (this.crtc[0] + 2);
    const blank = this.line >= this.displayedLines || this.lineTime / this.lineSeconds >= shown;
    const sync = this.line >= this.syncLine && this.line < this.syncLine + this.syncLines;
    return (blank ? 0x01 : 0) | (sync ? 0x08 : 0);
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
      this.width = Math.min(MAX_WIDTH, (this.crtc[1] + 1) * 16);
      this.height = Math.min(480, this.displayedLines);
    }
    if (this.enabled && this.line < this.height) this.drawLine(this.line);
    this.line++;
    if (this.line === this.syncLine) {
      if (this.fontPending) this.loadFont();
      if (this.crtc[0x11] & 0x10) {
        this.irqLatch = true;
        if (!(this.crtc[0x11] & 0x20)) this.onInterrupt(true);
      } else {
        this.irqLatch = false;
      }
      this.frames++;
      if (this.enabled) this.onFrame(this.framebuffer, this.width, this.height);
    }
    if (this.line >= this.totalLines) this.line = 0;
  }

  /** Copies a font block from video memory into the character generator: entries of a code, then its 16 lines 512 bytes apart. */
  private loadFont(): void {
    const block = ((this.crtc[0x13] >> 4) & 3) * 0x2000;
    const page = ((this.crtc[0x12] >> 5) & 1) * 0x1000;
    const count = this.crtc[0x14] + 1;
    for (let entry = 0; entry < count; entry++) {
      const source = block + entry * 2;
      const code = this.vram[source];
      for (let line = 0; line < 16; line++) this.font[page + code * 16 + line] = this.vram[(source + line * 0x200 + 1) & 0xffff];
    }
    this.crtc[0x12] &= ~0x80;
    this.fontPending = false;
  }

  // --- Drawing ------------------------------------------------------------------------

  private get startAddress(): number {
    return (this.crtc[0x0c] << 8) | this.crtc[0x0d];
  }

  private drawLine(y: number): void {
    const out = this.framebuffer;
    const row = y * MAX_WIDTH;
    if (!(this.cgaMode & Cga.Enable)) {
      out.fill(this.palette[0], row, row + this.width);
      return;
    }
    switch (this.mode) {
      case Mode.Text:
        this.drawText(y, row);
        break;
      case Mode.Cga4:
        this.drawCga4(y, row);
        break;
      case Mode.Cga6:
        this.drawTwoColour(0x8000, this.cgaRow(y), 0x7fff, row);
        break;
      case Mode.Mode11:
        this.drawTwoColour(0, (this.startAddress << 1) + y * 80, 0xffff, row);
        break;
      case Mode.Mode13: {
        const start = (this.startAddress << 1) + (y >> 1) * 320;
        for (let x = 0; x < 320; x++) out[row + x * 2] = out[row + x * 2 + 1] = this.palette[this.vram[(start + x) & 0xffff]];
        break;
      }
    }
  }

  /** Where a 200-line CGA mode's line starts: even lines in the first 8K, odd in the second. */
  private cgaRow(y: number): number {
    const source = y >> 1;
    return (this.startAddress << 1) + (source & 1) * 0x2000 + (source >> 1) * 80;
  }

  private drawText(y: number, row: number): void {
    const out = this.framebuffer;
    const wide = this.doubleWidth;
    const columns = this.width / (wide ? 16 : 8);
    const height = ((this.crtc[9] & 0x0f) + 1) * 2;
    const glyphLine = y % height;
    const textRow = Math.floor(y / height);
    const start = this.startAddress & 0x3fff;
    const cursor = ((this.crtc[0x0e] << 8) | this.crtc[0x0f]) & 0x3fff;
    const blinkOn = (this.frames & 0x10) !== 0;
    const cursorShown = !(this.crtc[0x0a] & 0x20) && (this.frames & 0x08) !== 0;
    const cursorLine = glyphLine >> 1;
    const twoFonts = (this.crtc[0x12] & 0x10) !== 0;
    const fixedPage = (this.crtc[0x12] >> 5) & 1;
    const blink = (this.cgaMode & Cga.Blink) !== 0;
    let x = row;
    for (let column = 0; column < columns; column++) {
      const cell = (start + textRow * columns + column) & 0x3fff;
      const code = this.vram[0x8000 + ((cell << 1) & 0x7fff)];
      const attribute = this.vram[0x8000 + (((cell << 1) + 1) & 0x7fff)];
      const page = twoFonts ? (attribute >> 3) & 1 : fixedPage;
      let fg = twoFonts ? attribute & 0x07 : attribute & 0x0f;
      const bg = blink ? (attribute >> 4) & 0x07 : attribute >> 4;
      let bits = this.font[page * 0x1000 + code * 16 + glyphLine];
      if (blink && attribute & 0x80 && blinkOn) fg = bg;
      if (cursorShown && cell === cursor && cursorLine >= (this.crtc[0x0a] & 0x0f) && cursorLine <= (this.crtc[0x0b] & 0x0f)) bits = 0xff;
      const fgColor = this.palette[fg];
      const bgColor = this.palette[bg];
      for (let bit = 7; bit >= 0; bit--) {
        const color = (bits >> bit) & 1 ? fgColor : bgColor;
        out[x++] = color;
        if (wide) out[x++] = color;
      }
    }
  }

  private drawCga4(y: number, row: number): void {
    const out = this.framebuffer;
    const start = this.cgaRow(y);
    const colors = [0, 1, 2, 3].map((pixel) => {
      if (!pixel) return this.palette[this.border & 0x0f];
      return this.palette[(pixel << 1) + (this.border & 0x20 ? 1 : 0) + (this.border & 0x10 ? 8 : 0)];
    });
    let x = row;
    for (let byte = 0; byte < 80; byte++) {
      const data = this.vram[0x8000 + ((start + byte) & 0x7fff)];
      for (let shift = 6; shift >= 0; shift -= 2) {
        const color = colors[(data >> shift) & 3];
        out[x++] = color;
        out[x++] = color;
      }
    }
  }

  /** 640-wide two-colour graphics from `base` in video memory: the foreground is the border register's colour (white in black and white). */
  private drawTwoColour(base: number, start: number, mask: number, row: number): void {
    const out = this.framebuffer;
    const fg = this.palette[this.cgaMode & Cga.Mono ? 0x07 : this.border & 0x0f];
    const bg = this.palette[0];
    let x = row;
    for (let byte = 0; byte < 80; byte++) {
      const data = this.vram[base + ((start + byte) & mask)];
      for (let bit = 7; bit >= 0; bit--) out[x++] = (data >> bit) & 1 ? fg : bg;
    }
  }

  // --- Memory and registers -----------------------------------------------------------

  /** Where an address falls in video memory: B8000h's 32K for text and CGA graphics, A0000h's 64K for the rest (and fonts); -1 for none. */
  private offset(address: number): number {
    if (!this.enabled) return -1;
    const mode = this.mode;
    if (address >= 0xb8000 && (mode === Mode.Text || mode === Mode.Cga4 || mode === Mode.Cga6)) return 0x8000 + (address - 0xb8000);
    if (address < 0xb0000 && (mode === Mode.Text || mode === Mode.Mode11 || mode === Mode.Mode13)) return address - 0xa0000;
    return -1;
  }

  readMemory(address: number): number {
    const offset = this.offset(address);
    return offset >= 0 ? this.vram[offset] : 0xff;
  }

  writeMemory(address: number, value: number): void {
    const offset = this.offset(address);
    if (offset >= 0) this.vram[offset] = value;
  }

  owns(port: number): boolean {
    return this.enabled && ((port >= 0x3c6 && port <= 0x3c9) || (port >= 0x3d0 && port <= 0x3df));
  }

  /** Register 10h as read: what the formatter is doing. */
  private get modeControl(): number {
    const mode = this.mode;
    let value = 0x10;
    if (this.cgaMode & Cga.Columns80) value |= 0x80;
    if (!this.doubleWidth) value |= 0x20;
    if (mode === Mode.Text) value |= 0x08;
    if (mode === Mode.Cga4 || mode === Mode.Cga6 || mode === Mode.Mode13) value |= 0x04;
    if (mode === Mode.Mode11) value |= 0x02;
    if (mode === Mode.Mode13) value |= 0x01;
    return value;
  }

  read(port: number): number {
    switch (port) {
      case 0x3c6:
        return this.dacMask;
      case 0x3c7:
        return this.dacLastRead ? 0x03 : 0x00;
      case 0x3c8:
        return this.dacWriteIndex;
      case 0x3c9: {
        const value = this.dac[this.dacReadIndex * 3 + this.dacReadStep] & 0x3f;
        if (++this.dacReadStep === 3) {
          this.dacReadStep = 0;
          this.dacReadIndex = (this.dacReadIndex + 1) & 0xff;
        }
        return value;
      }
      case 0x3d4:
        return this.crtcIndex;
      case 0x3d5: {
        const index = this.crtcIndex;
        if (index === 0x10) return this.modeControl;
        if (index === 0x11) return (this.crtc[0x11] & 0xbf) | (this.irqLatch ? 0x40 : 0);
        // An analogue colour display is attached.
        if (index === 0x12 && this.crtc[0x11] & 0x80) return 0x02;
        return index < CRTC_REGISTERS ? this.crtc[index] : 0xff;
      }
      case 0x3d8:
        return this.cgaMode;
      case 0x3d9:
        return this.border;
      case 0x3da:
        return this.status;
      case 0x3dd:
        return this.extMode & 0x84;
      default:
        return 0xff;
    }
  }

  write(port: number, value: number): void {
    switch (port) {
      case 0x3c6:
        // Latched, but IBM doesn't support masking the pels with it.
        this.dacMask = value;
        break;
      case 0x3c7:
        this.dacReadIndex = value;
        this.dacReadStep = 0;
        this.dacLastRead = true;
        break;
      case 0x3c8:
        this.dacWriteIndex = value;
        this.dacWriteStep = 0;
        this.dacLastRead = false;
        break;
      case 0x3c9:
        this.dac[this.dacWriteIndex * 3 + this.dacWriteStep] = value & 0x3f;
        if (++this.dacWriteStep === 3) {
          this.updateColor(this.dacWriteIndex);
          this.dacWriteStep = 0;
          this.dacWriteIndex = (this.dacWriteIndex + 1) & 0xff;
        }
        break;
      case 0x3d4:
        this.crtcIndex = value & 0x3f;
        break;
      case 0x3d5:
        this.writeCrtc(this.crtcIndex, value);
        break;
      case 0x3d8:
        this.cgaMode = value & 0x3f;
        break;
      case 0x3d9:
        this.border = value & 0x3f;
        break;
      case 0x3dd:
        this.extMode = value & 0x84;
        break;
    }
  }

  private writeCrtc(index: number, value: number): void {
    if (index >= CRTC_REGISTERS) return;
    // Register 10h bit 7 protects the timing registers.
    if (index <= 0x09 && this.crtc[0x10] & 0x80) return;
    switch (index) {
      case 0x09:
      case 0x0b:
      case 0x0e:
        this.crtc[index] = value & 0x0f;
        break;
      case 0x0a:
        this.crtc[index] = value & 0x2f;
        break;
      case 0x10:
        this.crtc[index] = value & 0x9b;
        break;
      case 0x11:
        this.crtc[index] = value & 0xb0;
        if (!(value & 0x10)) {
          this.irqLatch = false;
          this.onInterrupt(false);
        } else if (value & 0x20) {
          this.onInterrupt(false);
        } else if (this.irqLatch) {
          this.onInterrupt(true);
        }
        break;
      case 0x12: {
        const was = this.crtc[0x12];
        this.crtc[0x12] = value & 0xf7;
        // Bit 7 loads a font: at once with bit 6, otherwise at the next vertical retrace.
        if (!(value & 0x80)) this.fontPending = false;
        else if (!(was & 0x80)) {
          if (value & 0x40) this.loadFont();
          else this.fontPending = true;
        }
        break;
      }
      default:
        this.crtc[index] = value;
    }
  }
}
