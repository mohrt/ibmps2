import type { Ps2Keyboard } from '../io/ps2-keyboard';
import { SET2_TO_SET1 } from '../io/scancodes';

export interface PpiHost {
  /** IRQ 1: a scan code is waiting in port A. */
  setIrq(high: boolean): void;
  /** Port B's low bits changed: bit 0 gates timer 2, bit 1 drives the speaker. */
  portBChanged(value: number): void;
  /** Timer 2's output, which port C reports. */
  timer2Output(): boolean;
}

/** How long the keyboard takes to send a byte once the last has been taken. */
const BYTE_SECONDS = 0.001;

/**
 * The 8255 PPI of the PC and PC/XT at 60h-63h: port A latches the scan
 * codes the keyboard sends (or, on the PC, reads DIP switch block 1), port
 * B drives the speaker, timer 2's gate and the keyboard's clock and
 * acknowledge, and port C reads the DIP switches a nibble at a time and
 * timer 2's output. The 83-key keyboard sends scan code set 1 itself; it has
 * no E0 keys, so the PC's arrow keys are its numeric keypad.
 */
export class Ppi8255 {
  /** Port A: the scan code latched. */
  data = 0;
  full = false;
  portB = 0;
  /** DIP switch block 1 (and, on the PC, block 2's memory size in 32K steps), a set bit for a switch that is off. */
  switches = 0;
  memorySwitch = 0;
  private breakPrefix = false;
  private wait = 0;

  constructor(
    readonly keyboard: Ps2Keyboard,
    private readonly host: PpiHost,
    public pc: boolean,
  ) {}

  /** Sets the switches for the machine: one or two floppy drives, an 80-column colour card, and its memory. */
  configure(pc: boolean, drives: number, kilobytes: number): void {
    this.pc = pc;
    this.switches = (((drives - 1) << 6) | 0x01 | 0x20 | 0x0c) & 0xff;
    this.memorySwitch = Math.max(0, (kilobytes - 64) / 32) & 0xff;
  }

  reset(): void {
    this.data = 0;
    this.full = false;
    this.portB = 0;
    this.breakPrefix = false;
    this.keyboard.reset();
  }

  read(port: number): number {
    switch (port) {
      case 0x60:
        if (this.portB & 0x80) return this.pc ? this.switches & ~0x02 : 0xff;
        return this.data;
      case 0x61:
        return this.portB;
      case 0x62: {
        let value: number;
        if (this.pc) value = this.portB & 0x04 ? this.memorySwitch & 0x0f : this.memorySwitch >> 4;
        else value = this.portB & 0x08 ? this.switches >> 4 : this.switches & 0x0d;
        const timer = this.host.timer2Output();
        // With no cassette recorder, the PC's cassette input follows timer 2 (which the BIOS loops back to test it).
        return value | (timer ? 0x20 : 0) | (this.pc && timer ? 0x10 : 0);
      }
      default:
        return 0xff;
    }
  }

  write(port: number, value: number): void {
    if (port !== 0x61) return;
    const before = this.portB;
    this.portB = value;
    this.host.portBChanged(value);
    if (value & 0x80) {
      // Acknowledged: the shift register clears for the next code (the BIOS checks for a stuck key by reading 0).
      this.data = 0;
      this.full = false;
      this.host.setIrq(false);
    }
    // The BIOS resets the keyboard by holding its clock low; when it is let go, the keyboard tests itself
    // (its AA waits while the acknowledge bit is still set).
    if (!(before & 0x40) && value & 0x40) {
      this.keyboard.output.length = 0;
      this.keyboard.output.push(0xaa);
      this.wait = BYTE_SECONDS;
    }
  }

  /** Runs for `seconds`: the keyboard sends its next byte when the latch is free and its clock is running. */
  advance(seconds: number): void {
    this.keyboard.advance(seconds);
    this.wait -= seconds;
    if (this.wait > 0 || this.full || !(this.portB & 0x40) || this.portB & 0x80) return;
    const output = this.keyboard.output;
    while (output.length > 0) {
      const code = this.toSet1(output.shift()!);
      if (code < 0) continue;
      this.data = code;
      this.full = true;
      this.host.setIrq(true);
      this.wait = BYTE_SECONDS;
      return;
    }
  }

  /** The PC keyboard's code for a set 2 byte; -1 for prefixes it doesn't have. */
  private toSet1(byte: number): number {
    if (byte === 0xe0 || byte === 0xe1) return -1;
    if (byte === 0xf0) {
      this.breakPrefix = true;
      return -1;
    }
    // Replies to commands (which a PC keyboard doesn't take) pass as they are.
    if (byte === 0xaa || byte === 0xfa || byte === 0xfe) return byte;
    const code = SET2_TO_SET1[byte];
    const broken = this.breakPrefix;
    this.breakPrefix = false;
    if (code >= 0x59) return -1;
    return broken ? code | 0x80 : code;
  }
}
