import { SET2_MAKE, SET2_PAUSE, set2Break } from './scancodes';

/**
 * An IBM Model M on the PS/2 keyboard port: it answers the controller's
 * commands (reset, identify, LEDs, typematic rate, scan code set) and sends
 * scan code set 2 for key presses. Bytes for the controller wait in `output`.
 */
export class Ps2Keyboard {
  readonly output: number[] = [];
  enabled = true;
  scanSet = 2;
  leds = 0;
  /** A command waiting for its parameter byte. */
  private command = -1;
  private last = 0xaa;
  /** Keys held down, by KeyboardEvent.code. */
  private readonly held = new Set<string>();

  reset(): void {
    this.output.length = 0;
    this.enabled = true;
    this.scanSet = 2;
    this.leds = 0;
    this.command = -1;
    this.held.clear();
  }

  private send(...bytes: number[]): void {
    for (const byte of bytes) {
      this.output.push(byte);
      this.last = byte;
    }
  }

  /** A byte from the controller. */
  receive(byte: number): void {
    if (this.command >= 0) {
      const command = this.command;
      this.command = -1;
      switch (command) {
        case 0xed:
          this.leds = byte & 7;
          this.send(0xfa);
          return;
        case 0xf3:
          this.send(0xfa);
          return;
        case 0xf0:
          if (byte === 0) {
            this.send(0xfa, this.scanSet);
          } else {
            if (byte <= 3) this.scanSet = byte;
            this.send(0xfa);
          }
          return;
      }
    }
    switch (byte) {
      case 0xed:
      case 0xf3:
      case 0xf0:
        this.command = byte;
        this.send(0xfa);
        break;
      case 0xee:
        this.send(0xee);
        break;
      case 0xf2:
        this.send(0xfa, 0xab, 0x83);
        break;
      case 0xf4:
        this.output.length = 0;
        this.enabled = true;
        this.send(0xfa);
        break;
      case 0xf5:
        this.enabled = false;
        this.send(0xfa);
        break;
      case 0xf6:
        this.enabled = true;
        this.send(0xfa);
        break;
      case 0xfe:
        this.output.push(this.last);
        break;
      case 0xff:
        this.output.length = 0;
        this.enabled = true;
        this.scanSet = 2;
        // Acknowledge, then the self test passes.
        this.send(0xfa, 0xaa);
        break;
      default:
        if (byte >= 0xf7 && byte <= 0xfd) this.send(0xfa);
        else this.send(0xfe);
    }
  }

  /** A browser key went down (or repeated). Returns false for keys the PS/2 keyboard doesn't have. */
  press(code: string): boolean {
    if (code === 'Pause') {
      if (this.enabled) this.send(...SET2_PAUSE);
      return true;
    }
    const make = SET2_MAKE[code];
    if (!make) return false;
    this.held.add(code);
    if (this.enabled) this.send(...make);
    return true;
  }

  release(code: string): boolean {
    const make = SET2_MAKE[code];
    if (!make) return code === 'Pause';
    if (!this.held.delete(code)) return true;
    if (this.enabled) this.send(...set2Break(make));
    return true;
  }

  releaseAll(): void {
    for (const code of [...this.held]) this.release(code);
  }
}
