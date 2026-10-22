/**
 * An Intel 8259A programmable interrupt controller. The PS/2 has two, as on
 * the AT: the master at 20h for IRQ 0-7 and the slave at A0h for IRQ 8-15,
 * cascaded on the master's IRQ 2. Inputs are edge-triggered: a request is
 * latched on a rising edge and held until the CPU acknowledges it.
 */
export class Pic8259 {
  /** Interrupt request register: inputs latched and waiting. */
  irr = 0;
  /** In-service register: interrupts being handled, awaiting their EOI. */
  isr = 0;
  /** Interrupt mask register. */
  imr = 0xff;
  /** The input lines as last driven (for edge detection). */
  lines = 0;
  vectorBase = 8;
  autoEoi = false;
  /** Rotate on automatic EOI. */
  rotateOnAutoEoi = false;
  /** The lowest-priority line (priority starts after it). */
  lowestPriority = 7;
  /** OCW3: reads of the command port return the ISR rather than the IRR. */
  readIsr = false;
  specialMask = false;
  /** OCW3 poll command: the next read returns the poll byte. */
  poll = false;
  /** Lines that are slave controllers (on the master: IRQ 2). */
  cascadeLines = 0;
  /** 0 when ready for OCWs; otherwise the ICW expected next (2, 3 or 4). */
  private initStep = 0;
  private needIcw4 = false;
  private single = false;
  /** Called when the INT output may have changed. */
  onChange: () => void = () => {};

  constructor(private readonly slave: Pic8259 | null = null) {
    if (slave) this.cascadeLines = 0x04;
  }

  reset(): void {
    this.irr = this.isr = this.lines = 0;
    this.imr = 0xff;
    this.autoEoi = this.rotateOnAutoEoi = this.readIsr = this.specialMask = this.poll = false;
    this.lowestPriority = 7;
    this.initStep = 0;
  }

  /** Drives an input line (0-7). A rising edge latches a request. */
  setLine(line: number, high: boolean): void {
    const bit = 1 << line;
    if (high) {
      if (!(this.lines & bit)) this.irr |= bit;
      this.lines |= bit;
    } else {
      this.lines &= ~bit;
      // A request that goes away before the CPU takes it is lost, as on the chip.
      this.irr &= ~bit;
    }
    this.onChange();
  }

  /** A rising and falling edge: requests the line once. */
  pulse(line: number): void {
    this.irr |= 1 << line;
    this.onChange();
  }

  /** The line that would interrupt the CPU now, or -1. */
  private pendingLine(): number {
    let requests = this.irr & ~this.imr;
    if (this.slave && this.slave.output) requests |= this.cascadeLines;
    if (!requests) return -1;
    for (let i = 1; i <= 8; i++) {
      const line = (this.lowestPriority + i) & 7;
      const bit = 1 << line;
      // A line in service blocks itself and everything below it (unless special mask mode).
      if (this.isr & bit && !this.specialMask) return -1;
      if (requests & bit) return line;
    }
    return -1;
  }

  /** The INT output. */
  get output(): boolean {
    return this.pendingLine() >= 0;
  }

  /** The CPU's interrupt acknowledge: returns the vector, and marks the interrupt in service. */
  acknowledge(): number {
    const line = this.pendingLine();
    if (line < 0) return this.vectorBase + 7; // A spurious interrupt.
    const bit = 1 << line;
    if (this.slave && this.cascadeLines & bit) {
      if (!this.autoEoi) this.isr |= bit;
      this.irr &= ~bit;
      const vector = this.slave.acknowledge();
      this.onChange();
      return vector;
    }
    this.irr &= ~bit;
    if (this.autoEoi) {
      if (this.rotateOnAutoEoi) this.lowestPriority = line;
    } else {
      this.isr |= bit;
    }
    this.onChange();
    return this.vectorBase + line;
  }

  private nonSpecificEoi(rotate: boolean): void {
    for (let i = 1; i <= 8; i++) {
      const line = (this.lowestPriority + i) & 7;
      if (this.isr & (1 << line)) {
        this.isr &= ~(1 << line);
        if (rotate) this.lowestPriority = line;
        return;
      }
    }
  }

  write(port: number, value: number): void {
    if ((port & 1) === 0) {
      if (value & 0x10) {
        // ICW1.
        this.initStep = 2;
        this.needIcw4 = (value & 1) !== 0;
        this.single = (value & 2) !== 0;
        this.imr = 0;
        this.isr = 0;
        this.irr = 0;
        this.lowestPriority = 7;
        this.specialMask = this.readIsr = false;
        this.autoEoi = false;
      } else if (value & 0x08) {
        // OCW3.
        if (value & 0x04) this.poll = true;
        if (value & 0x02) this.readIsr = (value & 1) !== 0;
        if (value & 0x40) this.specialMask = (value & 0x20) !== 0;
      } else {
        // OCW2.
        const line = value & 7;
        switch (value >> 5) {
          case 1:
            this.nonSpecificEoi(false);
            break;
          case 3:
            this.isr &= ~(1 << line);
            break;
          case 5:
            this.nonSpecificEoi(true);
            break;
          case 4:
            this.rotateOnAutoEoi = true;
            break;
          case 0:
            this.rotateOnAutoEoi = false;
            break;
          case 6:
            this.lowestPriority = line;
            break;
          case 7:
            this.isr &= ~(1 << line);
            this.lowestPriority = line;
            break;
        }
      }
    } else {
      switch (this.initStep) {
        case 2:
          this.vectorBase = value & 0xf8;
          this.initStep = this.single ? (this.needIcw4 ? 4 : 0) : 3;
          break;
        case 3:
          this.initStep = this.needIcw4 ? 4 : 0;
          break;
        case 4:
          this.autoEoi = (value & 2) !== 0;
          this.initStep = 0;
          break;
        default:
          this.imr = value;
      }
    }
    this.onChange();
  }

  read(port: number): number {
    if (this.poll) {
      this.poll = false;
      const line = this.pendingLine();
      if (line < 0) return 0;
      this.acknowledge();
      return 0x80 | line;
    }
    if (port & 1) return this.imr;
    return this.readIsr ? this.isr : this.irr;
  }
}
