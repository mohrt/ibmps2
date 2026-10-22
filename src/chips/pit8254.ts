/** The PIT's input clock: 14.31818 MHz / 12. */
export const PIT_HZ = 1193182;

/** One counter of the 8254. Counts are 1-65536 (a count of 0 means 65536). */
class Counter {
  mode = 0;
  /** 1 = LSB only, 2 = MSB only, 3 = LSB then MSB. */
  access = 3;
  bcd = false;
  reload = 0x10000;
  /** The count register as the chip holds it (0-65535; 0 after counting down past 1). */
  count = 0;
  output = true;
  gate = true;
  /** Counting is running (a count has been loaded and the gate allows it). */
  running = false;
  /** A count was written and loads on the next clock. */
  loadPending = false;
  /** A count was written but not yet loaded (the status byte's null count bit). */
  nullCount = true;
  /** Mode 0 and 4: the count has reached zero since it was loaded. */
  fired = false;
  /** Mode 3: clocks left in the current half of the square wave. */
  half = 0;
  /** Mode 1 and 5 have been triggered by the gate. */
  triggered = false;
  latched = -1;
  /** For LSB-then-MSB reads and writes: the next byte is the MSB. */
  readHigh = false;
  writeHigh = false;
  writtenLow = 0;
  status = -1;

  constructor(
    readonly index: number,
    private readonly onOutput: (index: number, high: boolean, tick: number) => void,
  ) {}

  private setOutput(high: boolean, tick: number): void {
    if (high === this.output) return;
    this.output = high;
    this.onOutput(this.index, high, tick);
  }

  control(mode: number, access: number, bcd: boolean, tick: number): void {
    this.mode = mode > 5 ? mode - 4 : mode;
    this.access = access;
    this.bcd = bcd;
    this.running = this.loadPending = this.fired = this.triggered = false;
    this.nullCount = true;
    this.writeHigh = this.readHigh = false;
    this.latched = -1;
    this.setOutput(this.mode !== 0, tick);
  }

  writeCount(value: number, tick: number): void {
    let full: number;
    if (this.access === 1) full = value;
    else if (this.access === 2) full = value << 8;
    else if (!this.writeHigh) {
      this.writtenLow = value;
      this.writeHigh = true;
      // Mode 0 stops counting when the first byte of a new count is written.
      if (this.mode === 0) this.running = false;
      return;
    } else {
      this.writeHigh = false;
      full = this.writtenLow | (value << 8);
    }
    this.reload = full === 0 ? 0x10000 : full;
    this.nullCount = true;
    switch (this.mode) {
      case 0:
        this.setOutput(false, tick);
        this.loadPending = true;
        this.fired = false;
        break;
      case 4:
        this.loadPending = true;
        this.fired = false;
        break;
      case 2:
      case 3:
        // A new count only takes effect at the end of the current period.
        if (!this.running && !this.loadPending) this.loadPending = true;
        break;
      default:
        break;
    }
  }

  setGate(high: boolean, tick: number): void {
    const rising = high && !this.gate;
    this.gate = high;
    switch (this.mode) {
      case 2:
      case 3:
        if (!high) {
          this.running = false;
          this.setOutput(true, tick);
        } else if (rising) {
          this.loadPending = true;
        }
        break;
      case 1:
      case 5:
        if (rising) {
          this.loadPending = true;
          this.triggered = true;
        }
        break;
      default:
        break;
    }
  }

  /** The count as a read sees it. */
  get current(): number {
    if (this.mode === 3 && this.running) {
      const odd = this.reload & 1;
      return Math.min(0xffff, this.half * 2 - (this.output ? 0 : odd)) & 0xffff;
    }
    return this.count & 0xffff;
  }

  latch(): void {
    if (this.latched < 0) this.latched = this.current;
  }

  read(): number {
    if (this.status >= 0) {
      const status = this.status;
      this.status = -1;
      return status;
    }
    const value = this.latched >= 0 ? this.latched : this.current;
    let byte: number;
    if (this.access === 1) byte = value & 0xff;
    else if (this.access === 2) byte = value >> 8;
    else {
      byte = this.readHigh ? value >> 8 : value & 0xff;
      this.readHigh = !this.readHigh;
      if (this.readHigh) return byte;
    }
    this.latched = -1;
    return byte;
  }

  latchStatus(): void {
    if (this.status >= 0) return;
    this.status = (this.output ? 0x80 : 0) | (this.nullCount ? 0x40 : 0) | (this.access << 4) | (this.mode << 1) | (this.bcd ? 1 : 0);
  }

  /** Runs the counter for `ticks` clocks, starting at clock `tick`. */
  advance(ticks: number, tick: number): void {
    while (ticks > 0) {
      if (this.loadPending) {
        // The count loads on the clock after it is written (or after the gate triggers).
        this.loadPending = false;
        this.nullCount = false;
        this.count = this.reload & 0xffff;
        tick++;
        ticks--;
        switch (this.mode) {
          case 3:
            this.running = this.gate;
            this.half = (this.reload + 1) >> 1;
            break;
          case 2:
            this.running = this.gate;
            break;
          case 1:
            this.running = true;
            this.fired = false;
            this.setOutput(false, tick);
            break;
          case 5:
            this.running = true;
            this.fired = false;
            break;
          default:
            this.running = true;
        }
        continue;
      }
      if (!this.running) return;
      switch (this.mode) {
        case 0:
        case 4: {
          if (!this.gate) return;
          const left = this.count === 0 ? 0x10000 : this.count;
          if (!this.fired && ticks >= left) {
            this.count = 0;
            this.fired = true;
            if (this.mode === 0) this.setOutput(true, tick + left);
            else {
              this.setOutput(false, tick + left);
              this.setOutput(true, tick + left + 1);
            }
            tick += left;
            ticks -= left;
          } else {
            this.count = (this.count - ticks + 0x10000) & 0xffff;
            return;
          }
          break;
        }
        case 1:
        case 5: {
          const left = this.count === 0 ? 0x10000 : this.count;
          if (!this.fired && ticks >= left) {
            this.count = 0;
            this.fired = true;
            if (this.mode === 1) this.setOutput(true, tick + left);
            else {
              this.setOutput(false, tick + left);
              this.setOutput(true, tick + left + 1);
            }
            tick += left;
            ticks -= left;
          } else {
            this.count = (this.count - ticks + 0x10000) & 0xffff;
            return;
          }
          break;
        }
        case 2: {
          // Counts down to 1, where the output is low for one clock and the count reloads.
          const left = (this.count === 0 ? 0x10000 : this.count) - 1;
          if (ticks > left) {
            this.setOutput(false, tick + left);
            this.setOutput(true, tick + left + 1);
            this.count = this.reload & 0xffff;
            tick += left + 1;
            ticks -= left + 1;
          } else {
            // A count of 0 is 65536.
            this.count = (this.count - ticks + 0x10000) & 0xffff;
            return;
          }
          break;
        }
        default: {
          if (ticks >= this.half) {
            tick += this.half;
            ticks -= this.half;
            const high = !this.output;
            this.setOutput(high, tick);
            // An odd count is high for one clock longer than it is low.
            this.half = high ? (this.reload + 1) >> 1 : this.reload >> 1;
            if (this.half === 0) this.half = 1;
          } else {
            this.half -= ticks;
            return;
          }
        }
      }
    }
  }
}

/**
 * An Intel 8254 programmable interval timer at 40h-43h: counter 0 drives
 * IRQ 0 (the 18.2 Hz clock tick), counter 1 is the DRAM refresh request and
 * counter 2 the speaker tone, gated by port 61h. Time is kept in PIT clocks.
 */
export class Pit8254 {
  /** PIT clocks since power on. */
  ticks = 0;
  readonly counters: Counter[];
  /** Called when a counter's output changes, with the clock it changed at. */
  onOutput: (index: number, high: boolean, tick: number) => void = () => {};

  constructor() {
    const forward = (index: number, high: boolean, tick: number) => this.onOutput(index, high, tick);
    this.counters = [0, 1, 2].map((i) => new Counter(i, forward));
  }

  reset(): void {
    for (const counter of this.counters) {
      counter.control(0, 3, false, this.ticks);
      counter.running = false;
    }
  }

  advance(ticks: number): void {
    for (const counter of this.counters) counter.advance(ticks, this.ticks);
    this.ticks += ticks;
  }

  write(port: number, value: number): void {
    const index = port & 3;
    if (index < 3) {
      this.counters[index].writeCount(value, this.ticks);
      return;
    }
    const select = value >> 6;
    if (select === 3) {
      // Read-back: bit 5 clear latches counts, bit 4 clear latches status.
      for (let i = 0; i < 3; i++) {
        if (!(value & (2 << i))) continue;
        if (!(value & 0x20)) this.counters[i].latch();
        if (!(value & 0x10)) this.counters[i].latchStatus();
      }
      return;
    }
    const access = (value >> 4) & 3;
    if (access === 0) this.counters[select].latch();
    else this.counters[select].control((value >> 1) & 7, access, (value & 1) !== 0, this.ticks);
  }

  read(port: number): number {
    const index = port & 3;
    return index < 3 ? this.counters[index].read() : 0xff;
  }

  setGate(index: number, high: boolean): void {
    this.counters[index].setGate(high, this.ticks);
  }

  output(index: number): boolean {
    return this.counters[index].output;
  }
}
