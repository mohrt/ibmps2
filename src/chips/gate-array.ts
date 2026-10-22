import type { Ps2Keyboard } from '../io/ps2-keyboard';
import type { Ps2Mouse } from '../io/ps2-mouse';

export interface GateArrayHost {
  /** Drives an interrupt controller input (IRQ 1 for the interfaces, 2-7 for the diagnostic test). */
  setIrq(line: number, high: boolean): void;
  /** ICW1 (index 0) or ICW2 (1) of the interrupt controller. */
  picIcw(index: 0 | 1): number;
  /** Port 61h's low bits changed: bit 0 gates timer 2, bit 1 drives the speaker. */
  portBChanged(value: number): void;
  timer2Output(): boolean;
  /** The diagnostic NMI (when the NMI mask lets it through). */
  nmi(): void;
}

/** How long a byte takes on an interface's serial line (11 bits at about 10 kHz), either way. */
const BYTE_SECONDS = 0.001;

/**
 * The system board gate array of the PS/2 Model 25 and 30 (the 8086 ones),
 * which has no 8042: two serial interfaces for the pointing device (67h) and
 * the keyboard (68h), with their control and status at 66h, 69h and 6Ah and
 * the interrupt source at A0h, whose bytes the BIOS copies into the software
 * latch at 60h. It also holds port 61h, the status at 62h, the enables for
 * the planar's devices at 65h, the RAM banks at 6Bh, and the NMI mask.
 */
export class GateArray {
  port60 = 0;
  port61 = 0;
  port63 = 0;
  port66 = 0;
  port69 = 0;
  /** The planar's devices: bit 1 parallel port, 2 MCGA, 3 floppy controller, 4 serial port. */
  port65 = 0x9f;
  /** Bit 0 maps the RAM from 0 (on a 512K Model 25), bits 1-6 switch off the 64K banks from 40000h. */
  ramControl = 0;
  /** Bit 0 masks the Model 30 clock's interrupt. */
  portA1 = 0;
  nmiMask = 0x80;
  /** A byte received on each interface (pointing device, keyboard) and not yet acknowledged; -1 for none. */
  readonly received = [-1, -1];
  readonly rxData = [0, 0];
  private readonly txReady = [false, false];
  private diagnosticIrqs = 0;
  private irqHigh = false;
  /** Each interface's time until its line is free for the device's next byte. */
  private readonly wait = [0, 0];

  constructor(
    private readonly keyboard: Ps2Keyboard,
    private readonly mouse: Ps2Mouse,
    private readonly host: GateArrayHost,
  ) {}

  reset(): void {
    this.port60 = this.port61 = this.port63 = this.port66 = this.port69 = 0;
    this.port65 = 0x9f;
    this.ramControl = this.portA1 = 0;
    this.nmiMask = 0x80;
    this.received.fill(-1);
    this.rxData.fill(0);
    this.wait.fill(0);
    this.txReady.fill(false);
    this.setDiagnosticIrqs(0);
    this.setIrq1(false);
    this.keyboard.reset();
    this.mouse.reset();
  }

  /** The devices on each interface: 0 is the pointing device, 1 the keyboard. */
  private device(port: number): Ps2Keyboard | Ps2Mouse {
    return port === 0 ? this.mouse : this.keyboard;
  }

  private setIrq1(high: boolean): void {
    if (high === this.irqHigh) return;
    this.irqHigh = high;
    this.host.setIrq(1, high);
  }

  private setDiagnosticIrqs(bits: number): void {
    for (let line = 2; line < 8; line++) {
      const bit = 1 << line;
      if ((bits ^ this.diagnosticIrqs) & bit) this.host.setIrq(line, (bits & bit) !== 0);
    }
    this.diagnosticIrqs = bits;
  }

  owns(port: number): boolean {
    return port === 0x60 || (port >= 0x61 && port <= 0x6b) || port === 0xa0 || port === 0xa1;
  }

  read(port: number): number {
    switch (port) {
      case 0x60:
        return this.port60;
      case 0x61:
        return this.port61;
      case 0x62:
        // Timer 2's output, no fixed disk, no maths coprocessor.
        return (this.host.timer2Output() ? 0x20 : 0) | 0x04 | 0x01;
      case 0x63:
        // Port 69h bit 6 picks which of the interrupt controller's set-up words shows here.
        return this.host.picIcw(this.port69 & 0x40 ? 0 : 1);
      case 0x65:
        return this.port65;
      case 0x66:
        // Bit 2: the keyboard isn't locked.
        return this.port66 | 0x04;
      case 0x67:
      case 0x68: {
        const index = port - 0x67;
        if (this.received[index] >= 0) this.rxData[index] = this.received[index];
        return this.rxData[index];
      }
      case 0x69:
        return this.port69;
      case 0x6a:
        return (this.received[0] >= 0 ? 0x20 : 0) | (this.received[1] >= 0 ? 0x04 : 0);
      case 0x6b:
        return this.ramControl;
      case 0xa0:
        return (this.received[0] >= 0 ? 0x04 : 0) | (this.received[1] >= 0 ? 0x08 : 0);
      case 0xa1:
        return this.portA1 | 0xfe;
      default:
        return 0xff;
    }
  }

  write(port: number, value: number): void {
    switch (port) {
      case 0x60:
        this.port60 = value;
        break;
      case 0x61:
        this.port61 = value & 0x33;
        this.host.portBChanged(value);
        break;
      case 0x63:
        // With port 69h bit 7 set, bits 2-7 drive IRQ 2-7 for the BIOS's interrupt test, and
        // (with bit 2 set too) a rising bit 0 the NMI.
        if (this.port69 & 0x80) {
          this.setDiagnosticIrqs(value & 0xfc);
          if (this.port69 & 0x04 && !(this.port63 & 0x01) && value & 0x01 && this.nmiMask & 0x80) this.host.nmi();
        }
        this.port63 = value;
        break;
      case 0x65:
        this.port65 = value & 0x9f;
        break;
      case 0x66:
        // A rising bit 4 acknowledges the pointing device's byte, bit 6 the keyboard's.
        if (!(this.port66 & 0x10) && value & 0x10) this.acknowledge(0);
        if (!(this.port66 & 0x40) && value & 0x40) this.acknowledge(1);
        this.port66 = value & ~0x04;
        break;
      case 0x67:
      case 0x68: {
        const index = port - 0x67;
        if (this.txReady[index]) {
          this.txReady[index] = false;
          this.device(index).receive(value);
          // The device's answer comes after the byte has gone down the line.
          this.wait[index] = 2 * BYTE_SECONDS;
        }
        break;
      }
      case 0x69:
        // A rising bit 3 or 4 readies an interface to send the next byte written to it.
        if (!(this.port69 & 0x08) && value & 0x08) this.txReady[0] = true;
        if (!(this.port69 & 0x10) && value & 0x10) this.txReady[1] = true;
        if (this.port69 & 0x80 && !(value & 0x80)) this.setDiagnosticIrqs(0);
        this.port69 = value;
        break;
      case 0x6b:
        this.ramControl = value & 0x7f;
        break;
      case 0xa0:
        this.nmiMask = value & 0x80;
        break;
      case 0xa1:
        this.portA1 = value & 0x01;
        break;
    }
  }

  private acknowledge(index: number): void {
    if (this.received[index] < 0) return;
    this.received[index] = -1;
    this.setIrq1(false);
  }

  /** Runs for `seconds`: each interface takes its device's next byte once the last is acknowledged. */
  advance(seconds: number): void {
    this.keyboard.advance(seconds);
    this.mouse.advance(seconds);
    for (let index = 0; index < 2; index++) {
      this.wait[index] -= seconds;
      const output = this.device(index).output;
      if (this.wait[index] <= 0 && this.received[index] < 0 && output.length > 0) {
        this.received[index] = output.shift()!;
        this.rxData[index] = this.received[index];
        this.wait[index] = BYTE_SECONDS;
      }
    }
    // Each byte waiting is a request on IRQ 1, made again after the other interface's acknowledgement.
    this.setIrq1(this.received[0] >= 0 || this.received[1] >= 0);
  }
}
