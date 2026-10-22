const bcd = (n: number) => (Math.floor(n / 10) << 4) | n % 10;
const decimal = (b: number) => (b >> 4) * 10 + (b & 0x0f);

const enum Reg {
  Millis = 0,
  Hundredths = 1,
  Seconds = 2,
  Minutes = 3,
  Hours = 4,
  DayOfWeek = 5,
  Day = 6,
  Month = 7,
  /** The alarm registers, which the Model 30 BIOS uses as battery-backed RAM. */
  AlarmMillis = 8,
  /** The year (BCD), on the Model 30. */
  Year = 9,
  AlarmDayOfWeek = 13,
  /** Bit 0 set for the 1900s, on the Model 30; the high nibble holds part of the checksum. */
  Century = 14,
  Checksum = 15,
  InterruptStatus = 16,
  InterruptControl = 17,
  ResetCounters = 18,
  ResetRam = 19,
  Status = 20,
  Go = 21,
}

/** Interrupt control and status bits. */
const enum Int {
  Compare = 0x01,
  Tenth = 0x02,
  Second = 0x04,
  Minute = 0x08,
  Hour = 0x10,
  Day = 0x20,
  Week = 0x40,
  Month = 0x80,
}

const MILLISECOND = 0.001;
/** After each millisecond tick, reading a counter sets the status bit for this long (the chip's rollover). */
const ROLLOVER_SECONDS = 0.00015;
const WRITE_MASKS = [0xf0, 0xff, 0x7f, 0x7f, 0x3f, 0x07, 0x3f, 0x1f];

/**
 * The PS/2 Model 30's National Semiconductor MM58167 real-time clock: BCD
 * counters from milliseconds to months at E0h-E7h, the alarm registers at
 * E8h-EFh (where IBM keeps the year, the century and its configuration with a
 * checksum) and the control registers at B0h-BFh. Its status bit, which the
 * BIOS's short waits poll, is set by each millisecond tick and cleared by
 * reading it. Its interrupts share IRQ 1, which the gate array can mask.
 */
export class Mm58167 {
  readonly regs = new Uint8Array(32);
  private millis = 0;
  private fraction = 0;
  onInterrupt: () => void = () => {};

  owns(port: number): boolean {
    return (port >= 0xb0 && port <= 0xbf) || (port >= 0xe0 && port <= 0xef);
  }

  /** Switched on: the counters set from the date (the alarm registers, battery backed, are kept). */
  powerOn(date: Date): void {
    this.regs.fill(0, 0, 8);
    this.regs.fill(0, 16);
    this.millis = 0;
    this.fraction = 0;
    this.setTime(date);
  }

  /** Sets the counters, year and century as the Model 30 BIOS keeps them, and the checksum over its RAM. */
  private setTime(date: Date): void {
    const regs = this.regs;
    regs[Reg.Seconds] = bcd(date.getSeconds());
    regs[Reg.Minutes] = bcd(date.getMinutes());
    regs[Reg.Hours] = bcd(date.getHours());
    regs[Reg.DayOfWeek] = bcd(date.getDay() + 1);
    regs[Reg.Day] = bcd(date.getDate());
    regs[Reg.Month] = bcd(date.getMonth() + 1);
    const year = date.getFullYear();
    regs[Reg.Year] = bcd(year % 100);
    regs[Reg.Century] = (regs[Reg.Century] & ~0x01) | (year < 2000 ? 0x01 : 0);
    // The month the clock was last set, which the BIOS checks to roll the year over.
    const month = date.getMonth() + 1;
    regs[Reg.AlarmMillis] = (regs[Reg.AlarmMillis] & 0x0f) | 0xc0 | ((month & 0x0c) << 2);
    regs[Reg.AlarmDayOfWeek] = (regs[Reg.AlarmDayOfWeek] & 0x0f) | 0xc0 | (month & 0x03);
    let sum = (regs[Reg.AlarmMillis] >> 4) & 0x0f;
    for (let i = Reg.Year; i <= 12; i++) sum += (regs[i] & 0x0f) + (regs[i] >> 4);
    sum += (regs[Reg.AlarmDayOfWeek] & 0x0f) + (regs[Reg.Century] & 0x0f);
    sum = (sum ^ 0x15) & 0x3f;
    regs[Reg.Century] = (regs[Reg.Century] & 0x0f) | ((0x0c | ((sum >> 4) & 3)) << 4);
    regs[Reg.Checksum] = ((0x0c | ((sum >> 2) & 3)) << 4) | 0x0c | (sum & 3);
  }

  private register(port: number): number {
    return (port - 0xa0) & 0x1f;
  }

  read(port: number): number {
    const reg = this.register(port);
    const regs = this.regs;
    let value: number;
    switch (reg) {
      case Reg.Status:
        value = regs[reg] & 0x01;
        regs[reg] = 0;
        break;
      case Reg.InterruptStatus:
        value = regs[reg];
        regs[reg] = 0;
        break;
      case Reg.Millis:
      case Reg.AlarmMillis:
        value = regs[reg] & 0xf0;
        break;
      case Reg.AlarmDayOfWeek:
        value = regs[reg] & 0x0f;
        break;
      case Reg.DayOfWeek:
        value = regs[reg] & 0x07;
        break;
      default:
        value = regs[reg];
    }
    if (reg <= Reg.Month && this.fraction < ROLLOVER_SECONDS) regs[Reg.Status] = 0x01;
    return value;
  }

  write(port: number, value: number): void {
    const reg = this.register(port);
    const regs = this.regs;
    switch (reg) {
      case Reg.InterruptStatus:
      case Reg.Status:
        break;
      case Reg.InterruptControl:
        regs[Reg.InterruptStatus] = 0;
        regs[reg] = value;
        break;
      case Reg.ResetCounters:
        if (value === 0xff) {
          regs.fill(0, 0, 8);
          regs[Reg.DayOfWeek] = regs[Reg.Day] = regs[Reg.Month] = 1;
          regs[Reg.Status] = 0;
          this.millis = 0;
        }
        break;
      case Reg.ResetRam:
        if (value === 0xff) regs.fill(0, Reg.AlarmMillis, Reg.InterruptStatus);
        break;
      case Reg.Go:
        // Restarts the second, rounding to the nearest minute.
        if (decimal(regs[Reg.Seconds]) > 39) this.tick(0, true);
        regs[Reg.Seconds] = regs[Reg.Hundredths] = regs[Reg.Millis] = 0;
        this.millis = 0;
        break;
      case Reg.AlarmMillis:
        regs[reg] = value & 0xf0;
        break;
      case Reg.AlarmDayOfWeek:
        regs[reg] = value & 0x0f;
        break;
      case Reg.Millis:
      case Reg.Hundredths:
        regs[reg] = value & WRITE_MASKS[reg];
        this.millis = (regs[Reg.Millis] >> 4) + decimal(regs[Reg.Hundredths]) * 10;
        break;
      default:
        regs[reg] = reg < 8 ? value & WRITE_MASKS[reg] : value;
    }
  }

  advance(seconds: number): void {
    this.fraction += seconds;
    while (this.fraction >= MILLISECOND) {
      this.fraction -= MILLISECOND;
      this.tickMillisecond();
    }
  }

  private tickMillisecond(): void {
    const regs = this.regs;
    this.millis = (this.millis + 1) % 1000;
    regs[Reg.Millis] = (this.millis % 10) << 4;
    regs[Reg.Hundredths] = bcd(Math.floor(this.millis / 10));
    const tenth = this.millis % 100 === 0 && regs[Reg.InterruptControl] & Int.Tenth ? Int.Tenth : 0;
    if (this.millis === 0) this.tick(tenth, false);
    else if (regs[Reg.InterruptControl] & Int.Compare) this.interrupt(this.alarmMatches() ? Int.Compare : 0);
    else this.interrupt(tenth);
    regs[Reg.Status] = 0x01;
  }

  /** A second (or, from the Go command, a minute) passes, carrying into the higher counters. */
  private tick(flags: number, minute: boolean): void {
    const regs = this.regs;
    const control = regs[Reg.InterruptControl];
    let raised = flags;
    if (!minute) {
      regs[Reg.Seconds] = bcd(decimal(regs[Reg.Seconds]) + 1);
      if (control & Int.Second) raised = Int.Second;
    }
    if (minute || decimal(regs[Reg.Seconds]) >= 60) {
      regs[Reg.Seconds] = 0;
      regs[Reg.Minutes] = bcd(decimal(regs[Reg.Minutes]) + 1);
      if (!minute && control & Int.Minute) raised = Int.Minute;
      if (decimal(regs[Reg.Minutes]) >= 60) {
        regs[Reg.Minutes] = 0;
        regs[Reg.Hours] = bcd(decimal(regs[Reg.Hours]) + 1);
        if (!minute && control & Int.Hour) raised = Int.Hour;
        if (decimal(regs[Reg.Hours]) >= 24) {
          regs[Reg.Hours] = 0;
          regs[Reg.DayOfWeek] = bcd(decimal(regs[Reg.DayOfWeek]) + 1);
          if (!minute && control & Int.Day) raised = Int.Day;
          if (decimal(regs[Reg.DayOfWeek]) > 7) {
            regs[Reg.DayOfWeek] = 1;
            if (!minute && control & Int.Week) raised = Int.Week;
          }
          this.nextDay(minute ? 0 : control, (flag) => (raised = flag));
        }
      }
    }
    if (!minute) this.interrupt(control & Int.Compare ? (this.alarmMatches() ? Int.Compare : 0) : raised);
  }

  private nextDay(control: number, raise: (flag: number) => void): void {
    const regs = this.regs;
    const month = decimal(regs[Reg.Month]);
    const year = decimal(regs[Reg.Year]) + (regs[Reg.Century] & 0x01 ? 1900 : 2000);
    const days = new Date(year, month, 0).getDate();
    regs[Reg.Day] = bcd(decimal(regs[Reg.Day]) + 1);
    if (decimal(regs[Reg.Day]) <= days) return;
    regs[Reg.Day] = 1;
    regs[Reg.Month] = bcd(month + 1);
    if (control & Int.Month) raise(Int.Month);
    if (month + 1 > 12) {
      regs[Reg.Month] = 1;
      regs[Reg.Year] = bcd((year + 1) % 100);
      if (year + 1 >= 2000) regs[Reg.Century] &= ~0x01;
    }
  }

  /** Whether the counters match the alarm (a nibble of 0Ch-0Fh matches anything); the year register is left out. */
  private alarmMatches(): boolean {
    const regs = this.regs;
    for (let reg = Reg.AlarmMillis; reg <= Reg.Checksum; reg++) {
      if (reg === Reg.Year) continue;
      const alarm = regs[reg];
      const counter = regs[reg & 7];
      if (reg !== Reg.AlarmMillis && (alarm & 0x0c) !== 0x0c && (counter ^ alarm) & 0x0f) return false;
      if (reg !== Reg.AlarmDayOfWeek && (alarm & 0xc0) !== 0xc0 && (counter ^ alarm) & 0xf0) return false;
    }
    return true;
  }

  private interrupt(flags: number): void {
    if (!flags) return;
    this.regs[Reg.InterruptStatus] = flags;
    this.onInterrupt();
  }
}
