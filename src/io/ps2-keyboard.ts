import { SET2_MAKE, SET2_PAUSE, SET2_TO_SET1, set2Break } from './scancodes';

/** Pause in scan code set 1. */
const SET1_PAUSE = [0xe1, 0x1d, 0x45, 0xe1, 0x9d, 0xc5];

/** A set 2 make or break sequence in set 1, for keyboards told to send it (with no 8042 to translate). */
function toSet1(set2: number[]): number[] {
  const out: number[] = [];
  let broken = false;
  for (const byte of set2) {
    if (byte === 0xe0) out.push(byte);
    else if (byte === 0xf0) broken = true;
    else {
      out.push(SET2_TO_SET1[byte] | (broken ? 0x80 : 0));
      broken = false;
    }
  }
  return out;
}

/** How long the keyboard's power-on self test takes after a reset command. */
const SELF_TEST_SECONDS = 0.3;

/**
 * An IBM Model M on the PS/2 keyboard port: it answers the controller's
 * commands (reset, identify, LEDs, typematic rate, scan code set) and sends
 * scan code set 2 for key presses (set 1 when told to, as the Model 25 and 30
 * BIOS does). Bytes for the controller wait in `output`.
 */
export class Ps2Keyboard {
  readonly output: number[] = [];
  enabled = true;
  scanSet = 2;
  leds = 0;
  /** A command waiting for its parameter byte. */
  private command = -1;
  private last = 0xaa;
  /** Seconds until the self test after a reset finishes and AA is sent (0 when none is running). */
  private selfTest = 0;
  /** Keys held down, by KeyboardEvent.code. */
  private readonly held = new Set<string>();

  reset(): void {
    this.output.length = 0;
    this.enabled = true;
    this.scanSet = 2;
    this.leds = 0;
    this.command = -1;
    this.selfTest = 0;
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
        // Acknowledge, then pass the self test a moment later (BIOSes time the wait for it).
        this.send(0xfa);
        this.selfTest = SELF_TEST_SECONDS;
        break;
      default:
        if (byte >= 0xf7 && byte <= 0xfd) this.send(0xfa);
        else this.send(0xfe);
    }
  }

  /** Runs for `seconds`: the self test after a reset. */
  advance(seconds: number): void {
    if (this.selfTest <= 0) return;
    this.selfTest -= seconds;
    if (this.selfTest <= 0) this.send(0xaa);
  }

  /** Sends a key's set 2 codes, or their set 1 equivalent. */
  private sendKey(set2: number[]): void {
    if (this.enabled) this.send(...(this.scanSet === 1 ? toSet1(set2) : set2));
  }

  /** A browser key went down (or repeated). Returns false for keys the PS/2 keyboard doesn't have. */
  press(code: string): boolean {
    if (code === 'Pause') {
      if (this.enabled) this.send(...(this.scanSet === 1 ? SET1_PAUSE : SET2_PAUSE));
      return true;
    }
    const make = SET2_MAKE[code];
    if (!make) return false;
    this.held.add(code);
    this.sendKey(make);
    return true;
  }

  release(code: string): boolean {
    const make = SET2_MAKE[code];
    if (!make) return code === 'Pause';
    if (!this.held.delete(code)) return true;
    this.sendKey(set2Break(make));
    return true;
  }

  releaseAll(): void {
    for (const code of [...this.held]) this.release(code);
  }
}
