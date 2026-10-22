/** The two dot clocks the VGA can select. */
const DOT_CLOCKS = [25.175e6, 28.322e6];
export const MAX_WIDTH = 1024;
export const MAX_HEIGHT = 768;
const PLANE = 0x10000;

/** Font offsets in plane 2 for each character map. */
const FONT_BASES = [0x0000, 0x4000, 0x8000, 0xc000, 0x2000, 0x6000, 0xa000, 0xe000];

const expand6 = (v: number) => ((v << 2) | (v >> 4)) & 0xff;

/**
 * IBM's VGA, as built into the PS/2's planar: 256 KB of video memory in four
 * planes, the sequencer, graphics controller, attribute controller, CRT
 * controller and DAC, with every standard text and graphics mode and the
 * tweaked ones built from them (mode X, split screens, smooth scrolling).
 * The picture is drawn a scanline at a time as the beam reaches it, and the
 * status register reports retrace from the CRTC's timing.
 */
export class Vga {
  readonly vram = new Uint8Array(4 * PLANE);
  readonly latch = new Uint8Array(4);
  misc = 0;
  seqIndex = 0;
  readonly seq = new Uint8Array(8);
  gcIndex = 0;
  readonly gc = new Uint8Array(16);
  crtcIndex = 0;
  readonly crtc = new Uint8Array(32);
  attrIndex = 0;
  /** The attribute controller's index/data flip-flop: false when the next write is an index. */
  attrData = false;
  readonly attr = new Uint8Array(32);
  readonly dac = new Uint8Array(768);
  dacMask = 0xff;
  dacWrite = 0;
  dacRead = 0;
  dacComponent = 0;
  /** 3 after a write to the read index, 0 after one to the write index (what 3C7h reads). */
  dacState = 0;
  featureControl = 0;
  /** The vertical retrace interrupt is pending. */
  retraceInterrupt = false;

  /** The finished picture, `width` by `height` pixels (rows of MAX_WIDTH). */
  readonly framebuffer = new Uint32Array(MAX_WIDTH * MAX_HEIGHT);
  width = 640;
  height = 400;
  frames = 0;
  /** Called with each finished picture. */
  onFrame: (framebuffer: Uint32Array, width: number, height: number) => void = () => {};
  /** The vertical retrace interrupt (IRQ 2, which the AT routes to IRQ 9). */
  onInterrupt: (high: boolean) => void = () => {};

  // Beam position.
  private line = 0;
  private lineTime = 0;
  private rowStart = 0;
  private rowScan = 0;
  private panning = 0;
  private startAddress = 0;
  private splitDone = false;
  /** Colours for the 256 DAC entries and the 16 attribute palette entries, rebuilt when they change. */
  private readonly dacColors = new Uint32Array(256);
  private readonly paletteColors = new Uint32Array(16);
  /** The attribute controller's output (the DAC index) for each palette entry. */
  private readonly paletteIndex = new Uint8Array(16);
  private diagnosticToggle = 0;
  /** The attribute controller's output for each pixel of the picture, for the diagnostic bits of input status 1. */
  private readonly attributeOut = new Uint8Array(MAX_WIDTH * MAX_HEIGHT);
  private colorsDirty = true;
  private readonly lineBuffer = new Uint8Array(MAX_WIDTH + 64);

  powerOn(): void {
    this.vram.fill(0);
    this.misc = 0;
    this.seq.fill(0);
    this.gc.fill(0);
    this.crtc.fill(0);
    this.attr.fill(0);
    this.dac.fill(0);
    this.dacMask = 0xff;
    this.attrData = false;
    this.attrIndex = 0;
    this.retraceInterrupt = false;
    this.colorsDirty = true;
  }

  // --- Timing -------------------------------------------------------------------------

  private get charDots(): number {
    return this.seq[1] & 1 ? 8 : 9;
  }

  private get dotDivide(): number {
    return this.seq[1] & 8 ? 2 : 1;
  }

  private get verticalTotal(): number {
    const c = this.crtc;
    const total = (c[6] | ((c[7] & 1) << 8) | ((c[7] & 0x20) << 4)) + 2;
    return total < 100 ? 449 : total;
  }

  private get displayedLines(): number {
    const c = this.crtc;
    return (c[0x12] | ((c[7] & 2) << 7) | ((c[7] & 0x40) << 3)) + 1;
  }

  private get retraceStart(): number {
    const c = this.crtc;
    return c[0x10] | ((c[7] & 4) << 6) | ((c[7] & 0x80) << 2);
  }

  private get lineCompare(): number {
    const c = this.crtc;
    return c[0x18] | ((c[7] & 0x10) << 4) | ((c[9] & 0x40) << 3);
  }

  private get lineSeconds(): number {
    const chars = this.crtc[0] + 5;
    const seconds = (chars * this.charDots * this.dotDivide) / DOT_CLOCKS[(this.misc >> 2) & 1];
    return chars < 20 ? 1 / 31469 : seconds;
  }

  private get inRetrace(): boolean {
    const start = this.retraceStart;
    const end = (this.crtc[0x11] & 0xf) - (start & 0xf);
    const length = end <= 0 ? end + 16 : end;
    return this.line >= start && this.line < start + length;
  }

  /**
   * Input status 1 (3BAh/3DAh): bit 0 the display is blanked, bit 3 vertical retrace, and bits 4
   * and 5 two of the attribute controller's outputs for the pixel being shown, picked by the
   * video status mux (bits 4-5 of the colour plane enable register).
   */
  private get inputStatus1(): number {
    const position = this.lineTime / this.lineSeconds;
    const shown = (this.crtc[1] + 1) / (this.crtc[0] + 5);
    const blank = this.line >= this.displayedLines || position >= shown;
    let diagnostic = 0;
    if (!blank && this.seq[1] & 0x20) {
      // With the screen off nothing reaches the attribute controller; its outputs read as changing.
      this.diagnosticToggle ^= 0x30;
      diagnostic = this.diagnosticToggle;
    } else if (!blank && this.line < MAX_HEIGHT) {
      const x = Math.min(this.width - 1, Math.floor((position / shown) * this.width));
      const out = this.attributeOut[this.line * MAX_WIDTH + x];
      const [low, high] = [
        [0, 2],
        [4, 5],
        [1, 3],
        [6, 7],
      ][(this.attr[0x12] >> 4) & 3];
      diagnostic = (((out >> low) & 1) << 4) | (((out >> high) & 1) << 5);
    }
    return (blank ? 0x01 : 0) | (this.inRetrace ? 0x08 : 0) | diagnostic;
  }

  /** Runs the beam for `seconds`, drawing each line it passes. */
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
    const line = this.line;
    if (line === 0) this.startFrame();
    if (line < this.displayedLines) this.drawLine(line);
    this.line++;
    if (this.line === this.retraceStart) this.endFrame();
    if (this.line >= this.verticalTotal) this.line = 0;
  }

  private startFrame(): void {
    const c = this.crtc;
    this.startAddress = (c[0x0c] << 8) | c[0x0d];
    this.rowStart = this.startAddress;
    this.rowScan = c[8] & 0x1f;
    this.panning = this.attr[0x13] & 0xf;
    this.splitDone = false;
    const width = Math.min(MAX_WIDTH, (c[1] + 1) * this.charDots * this.dotDivide);
    const height = Math.min(MAX_HEIGHT, this.displayedLines);
    if (width >= 160) this.width = width;
    if (height >= 100) this.height = height;
  }

  private endFrame(): void {
    this.frames++;
    this.onFrame(this.framebuffer, this.width, this.height);
    // Bit 5 of the vertical retrace end register set disables the interrupt; bit 4 clear holds it clear.
    if (!(this.crtc[0x11] & 0x20) && this.crtc[0x11] & 0x10) {
      this.retraceInterrupt = true;
      this.onInterrupt(true);
    }
  }

  // --- Colours ------------------------------------------------------------------------

  private rebuildColors(): void {
    const dac = this.dac;
    for (let i = 0; i < 256; i++) {
      const at = (i & this.dacMask) * 3;
      this.dacColors[i] = 0xff000000 | (expand6(dac[at + 2]) << 16) | (expand6(dac[at + 1]) << 8) | expand6(dac[at]);
    }
    const a = this.attr;
    const colorSelect = a[0x14];
    for (let i = 0; i < 16; i++) {
      let index = a[i & a[0x12] & 0xf] & 0x3f;
      if (a[0x10] & 0x80) index = (index & 0x0f) | ((colorSelect & 3) << 4);
      index |= (colorSelect & 0x0c) << 4;
      this.paletteIndex[i] = index;
      this.paletteColors[i] = this.dacColors[index];
    }
    this.colorsDirty = false;
  }

  // --- Drawing ------------------------------------------------------------------------

  /** The plane address the CRTC generates for memory address `ma` on row scan line `scan`. */
  private crtcAddress(ma: number, scan: number): number {
    const c = this.crtc;
    let address: number;
    if (c[0x14] & 0x40) address = ma << 2;
    else if (c[0x17] & 0x40) address = ma;
    else address = (ma << 1) | ((c[0x17] & 0x20 ? ma >> 15 : ma >> 13) & 1);
    if (!(c[0x17] & 1)) address = (address & ~0x2000) | ((scan & 1) << 13);
    if (!(c[0x17] & 2)) address = (address & ~0x4000) | ((scan & 2) << 13);
    return address & 0xffff;
  }

  private drawLine(y: number): void {
    if (y >= MAX_HEIGHT) return;
    if (this.colorsDirty) this.rebuildColors();
    const c = this.crtc;
    if (y === this.lineCompare && !this.splitDone) {
      this.splitDone = true;
      this.rowStart = 0;
      this.rowScan = 0;
      if (this.attr[0x10] & 0x20) this.panning = 0;
    }
    const out = this.framebuffer;
    const row = y * MAX_WIDTH;
    const width = this.width;
    const blanked = this.seq[1] & 0x20 || !(this.attrIndex & 0x20);
    if (blanked) {
      out.fill(this.seq[1] & 0x20 ? 0xff000000 : this.dacColors[this.attr[0x11]], row, row + width);
      this.attributeOut.fill(this.seq[1] & 0x20 ? 0 : this.attr[0x11], row, row + width);
    } else if (this.gc[6] & 1) {
      this.drawGraphicsLine(row, width);
    } else {
      this.drawTextLine(row, width);
    }
    // Move on to the next scan line of the character row (lines are shown twice when double scanning).
    const doubleScan = (c[9] & 0x80) !== 0;
    if (doubleScan && (y & 1) === 0) return;
    const maxScan = c[9] & 0x1f;
    if (this.rowScan >= maxScan) {
      this.rowScan = 0;
      this.rowStart = (this.rowStart + c[0x13] * 2) & 0xffff;
    } else {
      this.rowScan++;
    }
  }

  /** How many character clocks share one memory address (CRTC count by 2 and count by 4). */
  private get addressStep(): number {
    const c = this.crtc;
    if (c[0x14] & 0x20) return 4;
    return c[0x17] & 0x08 ? 2 : 1;
  }

  private drawGraphicsLine(row: number, width: number): void {
    const vram = this.vram;
    const out = this.framebuffer;
    const buffer = this.lineBuffer;
    const chars = this.crtc[1] + 2;
    const step = this.addressStep;
    const mode256 = (this.attr[0x10] & 0x40) !== 0;
    const interleave = (this.gc[5] & 0x60) === 0x20;
    const scan = this.rowScan;
    let x = 0;
    for (let ch = 0; ch < chars && x < buffer.length - 8; ch++) {
      const address = this.crtcAddress(this.rowStart + Math.floor(ch / step), scan);
      const p0 = vram[address];
      const p1 = vram[PLANE + address];
      const p2 = vram[2 * PLANE + address];
      const p3 = vram[3 * PLANE + address];
      if (mode256) {
        // Four pixels a character clock, each two dots wide.
        buffer[x++] = p0;
        buffer[x++] = p1;
        buffer[x++] = p2;
        buffer[x++] = p3;
      } else if (interleave) {
        // CGA's 4-colour modes: two bits a pixel, the first byte from plane 0, the next from plane 1.
        for (let i = 0; i < 4; i++) buffer[x++] = ((p0 >> (6 - 2 * i)) & 3) | (((p2 >> (6 - 2 * i)) & 3) << 2);
        for (let i = 0; i < 4; i++) buffer[x++] = ((p1 >> (6 - 2 * i)) & 3) | (((p3 >> (6 - 2 * i)) & 3) << 2);
      } else {
        for (let bit = 7; bit >= 0; bit--) {
          buffer[x++] = ((p0 >> bit) & 1) | (((p1 >> bit) & 1) << 1) | (((p2 >> bit) & 1) << 2) | (((p3 >> bit) & 1) << 3);
        }
      }
    }
    const dots = this.dotDivide;
    const attributes = this.attributeOut;
    if (mode256) {
      const colors = this.dacColors;
      const pan = (this.panning >> 1) & 3;
      for (let i = 0, px = pan; i < width; i += 2, px++) {
        const index = buffer[px];
        const color = colors[index];
        out[row + i] = color;
        out[row + i + 1] = color;
        attributes[row + i] = attributes[row + i + 1] = index;
      }
      return;
    }
    const colors = this.paletteColors;
    const indexes = this.paletteIndex;
    const pan = this.panning & 7;
    if (dots === 2) {
      for (let i = 0, px = pan; i < width; i += 2, px++) {
        const pixel = buffer[px];
        const color = colors[pixel];
        out[row + i] = color;
        out[row + i + 1] = color;
        attributes[row + i] = attributes[row + i + 1] = indexes[pixel];
      }
    } else {
      for (let i = 0; i < width; i++) {
        const pixel = buffer[i + pan];
        out[row + i] = colors[pixel];
        attributes[row + i] = indexes[pixel];
      }
    }
  }

  private drawTextLine(row: number, width: number): void {
    const vram = this.vram;
    const out = this.framebuffer;
    const c = this.crtc;
    const a = this.attr;
    const colors = this.paletteColors;
    const nine = this.charDots === 9;
    const dots = this.dotDivide;
    const cellWidth = (nine ? 9 : 8) * dots;
    const scan = this.rowScan;
    const chars = c[1] + 1;
    const step = this.addressStep;
    const mapSelect = this.seq[3];
    const fontB = FONT_BASES[(mapSelect & 3) | ((mapSelect >> 2) & 4)];
    const fontA = FONT_BASES[((mapSelect >> 2) & 3) | ((mapSelect >> 3) & 4)];
    const blinkEnabled = (a[0x10] & 0x08) !== 0;
    const blinkOn = (this.frames & 32) !== 0;
    const lineGraphics = (a[0x10] & 0x04) !== 0;
    const cursorOn = !(c[0x0a] & 0x20) && (this.frames & 16) !== 0;
    const cursorStart = c[0x0a] & 0x1f;
    const cursorEnd = c[0x0b] & 0x1f;
    const cursorAt = (c[0x0e] << 8) | c[0x0f];
    // With 9-dot characters, panning values 8, 0, 1 ... 7 shift by 0 to 8 dots.
    const pan = (nine ? (this.panning >= 8 ? 0 : this.panning + 1) : this.panning & 7) * dots;
    let x = -pan;
    for (let ch = 0; ch <= chars && x < width; ch++) {
      const ma = this.rowStart + Math.floor(ch / step);
      const address = this.crtcAddress(ma, scan);
      const code = vram[address];
      const attribute = vram[PLANE + address];
      const font = attribute & 0x08 ? fontA : fontB;
      let bits = vram[2 * PLANE + ((font + code * 32 + scan) & 0xffff)];
      let fg = attribute & 0x0f;
      let bg = attribute >> 4;
      if (blinkEnabled) {
        bg &= 7;
        if (attribute & 0x80 && !blinkOn) fg = bg;
      }
      if (cursorOn && (ma & 0xffff) === cursorAt && scan >= cursorStart && scan <= cursorEnd) bits = 0xff;
      const ninth = nine && lineGraphics && code >= 0xc0 && code <= 0xdf ? bits & 1 : 0;
      const fgColor = colors[fg];
      const bgColor = colors[bg];
      const fgIndex = this.paletteIndex[fg];
      const bgIndex = this.paletteIndex[bg];
      for (let i = 0; i < cellWidth; i++, x++) {
        if (x < 0 || x >= width) continue;
        const dot = Math.floor(i / dots);
        const on = dot < 8 ? (bits >> (7 - dot)) & 1 : ninth;
        out[row + x] = on ? fgColor : bgColor;
        this.attributeOut[row + x] = on ? fgIndex : bgIndex;
      }
    }
  }

  // --- Memory -------------------------------------------------------------------------

  /** The offset into the CPU's window for an address in A0000h-BFFFFh, or -1 outside it. */
  private windowOffset(address: number): number {
    const offset = address - 0xa0000;
    switch ((this.gc[6] >> 2) & 3) {
      case 0:
        return offset;
      case 1:
        return offset < 0x10000 ? offset : -1;
      case 2:
        return offset >= 0x10000 && offset < 0x18000 ? offset - 0x10000 : -1;
      default:
        return offset >= 0x18000 ? offset - 0x18000 : -1;
    }
  }

  readMemory(address: number): number {
    const offset = this.windowOffset(address);
    if (offset < 0) return 0xff;
    const vram = this.vram;
    let planeOffset: number;
    let plane: number;
    if (this.seq[4] & 0x08) {
      plane = offset & 3;
      planeOffset = offset & 0xfffc;
    } else if (this.gc[5] & 0x10) {
      plane = (this.gc[4] & 2) | (offset & 1);
      planeOffset = offset & 0xfffe;
    } else {
      plane = this.gc[4] & 3;
      planeOffset = offset & 0xffff;
    }
    const latch = this.latch;
    for (let p = 0; p < 4; p++) latch[p] = vram[p * PLANE + planeOffset];
    if (!(this.gc[5] & 0x08)) return latch[plane];
    // Read mode 1: colour compare.
    const compare = this.gc[2];
    const care = this.gc[7];
    let result = 0xff;
    for (let p = 0; p < 4; p++) {
      if (!(care & (1 << p))) continue;
      result &= compare & (1 << p) ? latch[p] : ~latch[p];
    }
    return result & 0xff;
  }

  writeMemory(address: number, value: number): void {
    const offset = this.windowOffset(address);
    if (offset < 0) return;
    let planes = this.seq[2] & 0xf;
    let planeOffset: number;
    if (this.seq[4] & 0x08) {
      planes &= 1 << (offset & 3);
      planeOffset = offset & 0xfffc;
    } else if (!(this.seq[4] & 0x04)) {
      planes &= offset & 1 ? 0b1010 : 0b0101;
      planeOffset = offset & 0xfffe;
    } else {
      planeOffset = offset & 0xffff;
    }
    if (!planes) return;
    const gc = this.gc;
    const latch = this.latch;
    const mode = gc[5] & 3;
    const rotate = gc[3] & 7;
    const operation = (gc[3] >> 3) & 3;
    const mask = gc[8];
    const rotated = ((value >> rotate) | (value << (8 - rotate))) & 0xff;
    const vram = this.vram;
    for (let p = 0; p < 4; p++) {
      if (!(planes & (1 << p))) continue;
      let data: number;
      switch (mode) {
        case 1:
          vram[p * PLANE + planeOffset] = latch[p];
          continue;
        case 2:
          data = value & (1 << p) ? 0xff : 0;
          break;
        case 3:
          data = gc[0] & (1 << p) ? 0xff : 0;
          break;
        default:
          data = gc[1] & (1 << p) ? (gc[0] & (1 << p) ? 0xff : 0) : rotated;
      }
      let bitMask = mask;
      if (mode === 3) bitMask = mask & rotated;
      switch (operation) {
        case 1:
          data &= latch[p];
          break;
        case 2:
          data |= latch[p];
          break;
        case 3:
          data ^= latch[p];
          break;
      }
      vram[p * PLANE + planeOffset] = (data & bitMask) | (latch[p] & ~bitMask);
    }
  }

  // --- Registers ----------------------------------------------------------------------

  /** Whether a port in 3B0h-3DFh is live (the CRTC and status appear at 3Bxh or 3Dxh by the colour bit). */
  private portActive(port: number): boolean {
    if (port >= 0x3c0 && port <= 0x3cf) return true;
    const color = (this.misc & 1) !== 0;
    return color ? port >= 0x3d0 : port < 0x3c0;
  }

  read(port: number): number {
    if (!this.portActive(port)) return 0xff;
    switch (port) {
      case 0x3c0:
        return this.attrIndex;
      case 0x3c1:
        return this.attr[this.attrIndex & 0x1f];
      case 0x3c2: {
        const d = this.dac;
        const sense = d[0] + d[1] + d[2] >= 0x4e || d[0] >= 0x26 || d[1] >= 0x26 || d[2] >= 0x26 ? 0 : 0x10;
        return sense | (this.retraceInterrupt ? 0x80 : 0) | 0x60;
      }
      case 0x3c3:
        return 1;
      case 0x3c4:
        return this.seqIndex;
      case 0x3c5:
        // IBM's VGA has sequencer registers 0-4 and graphics registers 0-8; the others read back
        // nothing (so programs looking for a Super VGA's extended registers don't find them).
        return this.seqIndex <= 4 ? this.seq[this.seqIndex] : 0xff;
      case 0x3c6:
        return this.dacMask;
      case 0x3c7:
        return this.dacState;
      case 0x3c8:
        return this.dacWrite;
      case 0x3c9: {
        const value = this.dac[this.dacRead * 3 + this.dacComponent];
        if (++this.dacComponent === 3) {
          this.dacComponent = 0;
          this.dacRead = (this.dacRead + 1) & 0xff;
        }
        return value;
      }
      case 0x3ca:
        return this.featureControl;
      case 0x3cc:
        return this.misc;
      case 0x3ce:
        return this.gcIndex;
      case 0x3cf:
        return this.gcIndex <= 8 ? this.gc[this.gcIndex] : 0xff;
      case 0x3b4:
      case 0x3d4:
        return this.crtcIndex;
      case 0x3b5:
      case 0x3d5:
        return this.crtcIndex < 0x19 ? this.crtc[this.crtcIndex] : 0xff;
      case 0x3ba:
      case 0x3da:
        this.attrData = false;
        return this.inputStatus1;
      default:
        return 0xff;
    }
  }

  write(port: number, value: number): void {
    if (!this.portActive(port)) return;
    switch (port) {
      case 0x3c0:
        if (!this.attrData) {
          this.attrIndex = value & 0x3f;
        } else if ((this.attrIndex & 0x1f) < 0x15) {
          this.attr[this.attrIndex & 0x1f] = value;
          this.colorsDirty = true;
        }
        this.attrData = !this.attrData;
        break;
      case 0x3c2:
        this.misc = value;
        break;
      case 0x3c4:
        this.seqIndex = value & 7;
        break;
      case 0x3c5:
        if (this.seqIndex <= 4) this.seq[this.seqIndex] = value;
        break;
      case 0x3c6:
        this.dacMask = value;
        this.colorsDirty = true;
        break;
      case 0x3c7:
        this.dacRead = value;
        this.dacComponent = 0;
        this.dacState = 3;
        break;
      case 0x3c8:
        this.dacWrite = value;
        this.dacComponent = 0;
        this.dacState = 0;
        break;
      case 0x3c9:
        this.dac[this.dacWrite * 3 + this.dacComponent] = value & 0x3f;
        this.colorsDirty = true;
        if (++this.dacComponent === 3) {
          this.dacComponent = 0;
          this.dacWrite = (this.dacWrite + 1) & 0xff;
        }
        break;
      case 0x3ce:
        this.gcIndex = value & 0xf;
        break;
      case 0x3cf:
        if (this.gcIndex <= 8) this.gc[this.gcIndex] = value;
        break;
      case 0x3b4:
      case 0x3d4:
        this.crtcIndex = value & 0x1f;
        break;
      case 0x3b5:
      case 0x3d5: {
        const index = this.crtcIndex;
        if (index > 0x18) break;
        // The protect bit locks registers 0-7, except the line compare bit of the overflow register.
        if (this.crtc[0x11] & 0x80 && index <= 7) {
          if (index === 7) this.crtc[7] = (this.crtc[7] & ~0x10) | (value & 0x10);
          break;
        }
        this.crtc[index] = value;
        if (index === 0x11 && !(value & 0x10) && this.retraceInterrupt) {
          this.retraceInterrupt = false;
          this.onInterrupt(false);
        }
        break;
      }
      case 0x3ba:
      case 0x3da:
        this.featureControl = value;
        break;
    }
  }
}
