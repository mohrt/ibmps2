import { MAX_WIDTH } from '../video/vga';

/** The PS/2's monitor shows every mode across the same 4:3 tube. */
export const SCREEN_ASPECT = 4 / 3;

/** Turns finished VGA pictures into canvas pixels, at the mode's own resolution. */
export class Screen {
  private readonly context: CanvasRenderingContext2D;
  private image!: ImageData;
  private pixels!: Uint32Array;
  private width = 0;
  private height = 0;
  private hasNewFrame = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D context is not available');
    this.context = context;
    this.resize(720, 400);
  }

  private resize(width: number, height: number): void {
    if (this.image && width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this.image = this.context.createImageData(width, height);
    this.pixels = new Uint32Array(this.image.data.buffer);
  }

  /** Copies a finished picture (rows MAX_WIDTH pixels apart). */
  capture(framebuffer: Uint32Array, width: number, height: number): void {
    this.resize(width, height);
    for (let y = 0; y < height; y++) this.pixels.set(framebuffer.subarray(y * MAX_WIDTH, y * MAX_WIDTH + width), y * width);
    this.hasNewFrame = true;
  }

  /** A dark screen, shown while the PS/2 is off. */
  showIdle(): void {
    this.pixels.fill(0xff141414);
    this.hasNewFrame = true;
  }

  present(): void {
    if (!this.hasNewFrame) return;
    this.context.putImageData(this.image, 0, 0);
    this.hasNewFrame = false;
  }
}
