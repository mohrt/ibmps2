import { Ps2Keyboard } from '../io/ps2-keyboard';
import { Ps2Mouse } from '../io/ps2-mouse';
import { SET2_TO_SET1 } from '../io/scancodes';

const enum Status {
  OutputFull = 0x01,
  System = 0x04,
  Command = 0x08,
  NotInhibited = 0x10,
  AuxData = 0x20,
}

const enum Ccb {
  KeyboardInterrupt = 0x01,
  AuxInterrupt = 0x02,
  System = 0x04,
  KeyboardDisabled = 0x10,
  AuxDisabled = 0x20,
  Translate = 0x40,
}

/** Time a byte takes to clock in from the keyboard or mouse (an 11-bit frame at about 12 kHz). */
const BYTE_SECONDS = 0.001;

export interface KbcHost {
  /** IRQ 1 (keyboard) or IRQ 12 (mouse) line. */
  setIrq(line: 1 | 12, high: boolean): void;
  /** The output port's A20 gate. */
  setA20(enabled: boolean): void;
  /** Pulses the CPU's reset line. */
  resetCpu(): void;
  /** Port 1 (the input port): memory size and drive type bits on the Model 30 286. */
  inputPort(): number;
}

/**
 * The 8042 keyboard controller at 60h and 64h, running IBM's PS/2 firmware:
 * the keyboard and the auxiliary (mouse) port, the command byte, translation
 * of scan code set 2 to set 1, and the output port's A20 gate and CPU reset.
 */
export class Kbc8042 {
  readonly keyboard = new Ps2Keyboard();
  readonly mouse = new Ps2Mouse();
  readonly ram = new Uint8Array(32);
  status = 0;
  outputBuffer = 0;
  /** The output port (P2): bit 0 is the CPU reset (active low), bit 1 the A20 gate. */
  outputPort = 0xcf;
  /** A controller command waiting for its data byte. */
  private pending = -1;
  /** Bytes the controller itself answers with, sent before the devices'. */
  private readonly replies: number[] = [];
  /** A set 2 break prefix (F0) seen while translating. */
  private breakPrefix = false;
  /** Seconds until the next device byte can arrive. */
  private wait = 0;
  private toggle = 0;

  constructor(private readonly host: KbcHost) {
    this.powerOn();
  }

  powerOn(): void {
    this.status = Status.NotInhibited;
    this.ram.fill(0);
    this.ram[0] = Ccb.KeyboardDisabled | Ccb.AuxDisabled;
    this.outputPort = 0xcf;
    this.pending = -1;
    this.replies.length = 0;
    this.breakPrefix = false;
    this.keyboard.reset();
    this.mouse.reset();
    // The output port comes up with A20 enabled, so the CPU's first fetch (at FFFFF0h) reaches the ROM.
    this.host.setA20(true);
  }

  get a20(): boolean {
    return (this.outputPort & 2) !== 0;
  }

  private writeOutputPort(value: number): void {
    this.outputPort = value | 0x01;
    this.host.setA20((value & 2) !== 0);
  }

  private fill(byte: number, aux: boolean): void {
    this.outputBuffer = byte;
    this.status = (this.status & ~Status.AuxData) | Status.OutputFull | (aux ? Status.AuxData : 0);
    const ccb = this.ram[0];
    if (aux) {
      if (ccb & Ccb.AuxInterrupt) this.host.setIrq(12, true);
    } else if (ccb & Ccb.KeyboardInterrupt) {
      this.host.setIrq(1, true);
    }
  }

  read(port: number): number {
    if (port === 0x64) return this.status;
    const value = this.outputBuffer;
    if (this.status & Status.OutputFull) {
      // The auxiliary data bit stays, saying where the byte just read came from.
      this.status &= ~Status.OutputFull;
      this.host.setIrq(1, false);
      this.host.setIrq(12, false);
      this.deliver();
    }
    return value;
  }

  write(port: number, value: number): void {
    if (port === 0x64) {
      this.status |= Status.Command;
      this.command(value);
      return;
    }
    this.status &= ~Status.Command;
    const pending = this.pending;
    this.pending = -1;
    if (pending < 0) {
      // To the keyboard (which also enables its interface).
      this.ram[0] &= ~Ccb.KeyboardDisabled;
      this.keyboard.receive(value);
      this.wait = BYTE_SECONDS;
      return;
    }
    if (pending >= 0x60 && pending <= 0x7f) {
      this.ram[pending & 0x1f] = value;
      if (pending === 0x60) this.status = (this.status & ~Status.System) | (value & Ccb.System);
      return;
    }
    switch (pending) {
      case 0xa5:
        // Loading a password: bytes until a zero.
        if (value !== 0) this.pending = 0xa5;
        break;
      case 0xd1:
        this.writeOutputPort(value);
        break;
      case 0xd2:
        this.reply(value, false);
        break;
      case 0xd3:
        this.reply(value, true);
        break;
      case 0xd4:
        this.ram[0] &= ~Ccb.AuxDisabled;
        this.mouse.receive(value);
        this.wait = BYTE_SECONDS;
        break;
    }
  }

  private reply(byte: number, aux = false): void {
    if (!(this.status & Status.OutputFull) && this.replies.length === 0) this.fill(byte, aux);
    else this.replies.push(aux ? byte | 0x100 : byte);
  }

  private command(value: number): void {
    this.pending = -1;
    if (value >= 0x20 && value <= 0x3f) {
      this.reply(this.ram[value & 0x1f]);
      return;
    }
    if (value >= 0x60 && value <= 0x7f) {
      this.pending = value;
      return;
    }
    if (value >= 0xf0) {
      // Pulse output port lines low; bit 0 is the CPU reset.
      if (!(value & 1)) this.host.resetCpu();
      return;
    }
    switch (value) {
      case 0xa4:
        this.reply(0xf1);
        break;
      case 0xa5:
      case 0xd1:
      case 0xd2:
      case 0xd3:
      case 0xd4:
        this.pending = value;
        break;
      case 0xa7:
        this.ram[0] |= Ccb.AuxDisabled;
        break;
      case 0xa8:
        this.ram[0] &= ~Ccb.AuxDisabled;
        break;
      case 0xa9:
      case 0xab:
        this.reply(0x00);
        break;
      case 0xaa:
        this.replies.length = 0;
        this.status = (this.status & ~(Status.OutputFull | Status.AuxData)) | Status.System;
        this.ram[0] = Ccb.KeyboardDisabled | Ccb.AuxDisabled | Ccb.System;
        this.reply(0x55);
        break;
      case 0xad:
        this.ram[0] |= Ccb.KeyboardDisabled;
        break;
      case 0xae:
        this.ram[0] &= ~Ccb.KeyboardDisabled;
        break;
      case 0xc0: {
        this.reply(this.host.inputPort() | this.toggle);
        this.toggle = (this.toggle + 1) & 3;
        break;
      }
      case 0xc1:
        this.status = (this.status & 0x0f) | ((this.host.inputPort() << 4) & 0xf0);
        break;
      case 0xc2:
        this.status = (this.status & 0x0f) | (this.host.inputPort() & 0xf0);
        break;
      case 0xd0:
        this.reply(this.outputPort);
        break;
      case 0xe0:
        this.reply(0x00);
        break;
    }
  }

  /** Puts the next waiting byte in the output buffer, if it is empty. */
  private deliver(): void {
    if (this.status & Status.OutputFull) return;
    const reply = this.replies.shift();
    if (reply !== undefined) this.fill(reply & 0xff, reply > 0xff);
  }

  /** Runs for `seconds`: bytes from the keyboard and mouse arrive one at a time. */
  advance(seconds: number): void {
    this.mouse.advance(seconds);
    this.deliver();
    this.wait -= seconds;
    if (this.wait > 0 || this.status & Status.OutputFull) return;
    const ccb = this.ram[0];
    const keyboard = this.keyboard.output;
    if (!(ccb & Ccb.KeyboardDisabled) && keyboard.length > 0) {
      while (keyboard.length > 0) {
        const byte = keyboard.shift()!;
        const translated = this.translate(byte);
        if (translated < 0) continue;
        this.fill(translated, false);
        this.wait = BYTE_SECONDS;
        return;
      }
    }
    const mouse = this.mouse.output;
    if (!(ccb & Ccb.AuxDisabled) && mouse.length > 0) {
      this.fill(mouse.shift()!, true);
      this.wait = BYTE_SECONDS;
    }
  }

  /** Set 2 to set 1, when the command byte asks for it; -1 for a break prefix it folds into the next code. */
  private translate(byte: number): number {
    if (!(this.ram[0] & Ccb.Translate)) return byte;
    if (byte === 0xf0) {
      this.breakPrefix = true;
      return -1;
    }
    const code = SET2_TO_SET1[byte];
    if (this.breakPrefix) {
      this.breakPrefix = false;
      return code | 0x80;
    }
    return code;
  }
}
