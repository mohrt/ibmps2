/**
 * The PS/2's serial port, a National 16450 UART. Nothing is plugged into it:
 * the registers, interrupts and loopback mode work (the BIOS tests them), the
 * transmitter empties at once, and outside loopback nothing is received.
 */
export class Uart16450 {
  base = 0x3f8;
  enabled = true;
  divisor = 12;
  ier = 0;
  lcr = 0;
  mcr = 0;
  scratch = 0;
  received = 0;
  /** Line status: data ready (bit 0), transmitter empty (bits 5 and 6). */
  lsr = 0x60;
  /** The transmitter-empty interrupt is waiting (it clears when IIR reports it or THR is written). */
  private thrInterrupt = false;
  private msrDelta = 0;
  /** Drives the port's IRQ line. */
  onInterrupt: (high: boolean) => void = () => {};

  owns(port: number): boolean {
    return this.enabled && port >= this.base && port < this.base + 8;
  }

  reset(): void {
    this.ier = this.lcr = this.mcr = this.scratch = this.received = this.msrDelta = 0;
    this.divisor = 12;
    this.lsr = 0x60;
    this.thrInterrupt = false;
    this.update();
  }

  private get loopback(): boolean {
    return (this.mcr & 0x10) !== 0;
  }

  /** Modem status inputs: in loopback, the modem control outputs. */
  private get modemInputs(): number {
    if (!this.loopback) return 0;
    const m = this.mcr;
    return ((m & 2) << 3) | ((m & 1) << 5) | ((m & 4) << 4) | ((m & 8) << 4);
  }

  /** The interrupt identification: highest priority source, or 1 for none. */
  private get iir(): number {
    if (this.ier & 4 && this.lsr & 0x1e) return 0x06;
    if (this.ier & 1 && this.lsr & 1) return 0x04;
    if (this.ier & 2 && this.thrInterrupt) return 0x02;
    if (this.ier & 8 && this.msrDelta) return 0x00;
    return 0x01;
  }

  private update(): void {
    // OUT2 gates the interrupt onto the bus.
    this.onInterrupt(this.iir !== 0x01 && (this.mcr & 8) !== 0);
  }

  read(port: number): number {
    const reg = port - this.base;
    const dlab = (this.lcr & 0x80) !== 0;
    let value: number;
    switch (reg) {
      case 0:
        if (dlab) return this.divisor & 0xff;
        value = this.received;
        this.lsr &= ~1;
        break;
      case 1:
        return dlab ? this.divisor >> 8 : this.ier;
      case 2:
        value = this.iir;
        if (value === 0x02) this.thrInterrupt = false;
        break;
      case 3:
        return this.lcr;
      case 4:
        return this.mcr;
      case 5:
        value = this.lsr;
        this.lsr &= ~0x1e;
        break;
      case 6:
        value = this.modemInputs | this.msrDelta;
        this.msrDelta = 0;
        break;
      default:
        return this.scratch;
    }
    this.update();
    return value;
  }

  write(port: number, value: number): void {
    const reg = port - this.base;
    const dlab = (this.lcr & 0x80) !== 0;
    switch (reg) {
      case 0:
        if (dlab) {
          this.divisor = (this.divisor & 0xff00) | value;
          return;
        }
        if (this.loopback) {
          if (this.lsr & 1) this.lsr |= 0x02;
          this.received = value;
          this.lsr |= 1;
        }
        // The byte goes straight out, so the transmitter is empty again.
        this.thrInterrupt = true;
        break;
      case 1:
        if (dlab) {
          this.divisor = (this.divisor & 0xff) | (value << 8);
          return;
        }
        if (value & 2 && !(this.ier & 2)) this.thrInterrupt = true;
        this.ier = value & 0x0f;
        break;
      case 3:
        this.lcr = value;
        return;
      case 4: {
        const before = this.modemInputs;
        this.mcr = value & 0x1f;
        const changed = (before ^ this.modemInputs) & 0xb0;
        // Delta bits: CTS, DSR and DCD changes, and RI's trailing edge.
        this.msrDelta |= (changed >> 4) & 0x0b;
        if (before & 0x40 && !(this.modemInputs & 0x40)) this.msrDelta |= 0x04;
        break;
      }
      case 7:
        this.scratch = value;
        return;
      default:
        return;
    }
    this.update();
  }
}
