const enum R {
  Seconds = 0,
  SecondsAlarm = 1,
  Minutes = 2,
  MinutesAlarm = 3,
  Hours = 4,
  HoursAlarm = 5,
  Weekday = 6,
  Day = 7,
  Month = 8,
  Year = 9,
  A = 10,
  B = 11,
  C = 12,
  D = 13,
  /** The PS/2's century byte. */
  Century = 0x37,
}

const toBcd = (value: number) => ((Math.floor(value / 10) << 4) | value % 10) & 0xff;
const fromBcd = (value: number) => (value >> 4) * 10 + (value & 0xf);

/** The time of the update cycle, during which reads see UIP set (244 µs before the update). */
const UIP_SECONDS = 244e-6;

/**
 * A Motorola MC146818 real-time clock with 128 bytes of battery-backed CMOS
 * RAM, at ports 70h (index, bit 7 masks NMI) and 71h (data). It keeps the time
 * the guest sets, counting in emulated seconds, and raises IRQ 8 for its
 * periodic, alarm and update-ended interrupts.
 */
export class Rtc146818 {
  readonly ram = new Uint8Array(128);
  index = 0;
  nmiMasked = false;
  /** Emulated seconds into the current second. */
  private fraction = 0;
  /** Emulated seconds until the next periodic interrupt. */
  private periodicLeft = 0;
  /** Called when the IRQ 8 line changes. */
  onInterrupt: (high: boolean) => void = () => {};

  /** Sets the clock to a date (in local time, as a PC keeps it). */
  setTime(date: Date): void {
    const ram = this.ram;
    ram[R.Seconds] = date.getSeconds();
    ram[R.Minutes] = date.getMinutes();
    ram[R.Hours] = date.getHours();
    ram[R.Weekday] = date.getDay() + 1;
    ram[R.Day] = date.getDate();
    ram[R.Month] = date.getMonth() + 1;
    ram[R.Year] = date.getFullYear() % 100;
    ram[R.Century] = Math.floor(date.getFullYear() / 100);
    if (!this.binary) {
      for (const reg of [R.Seconds, R.Minutes, R.Weekday, R.Day, R.Month, R.Year, R.Century]) ram[reg] = toBcd(ram[reg]);
      ram[R.Hours] = this.encodeHours(date.getHours());
    } else {
      ram[R.Hours] = this.encodeHours(date.getHours());
    }
    this.fraction = 0;
  }

  /** At power on: the registers a fresh clock has, keeping the RAM. */
  powerOn(date: Date): void {
    this.ram[R.A] = 0x26;
    this.ram[R.B] = 0x02;
    this.ram[R.C] = 0;
    this.ram[R.D] = 0x80;
    this.setTime(date);
    this.periodicLeft = this.periodicSeconds;
  }

  private get binary(): boolean {
    return (this.ram[R.B] & 0x04) !== 0;
  }

  private get twentyFourHour(): boolean {
    return (this.ram[R.B] & 0x02) !== 0;
  }

  private encodeHours(hours: number): number {
    let value = hours;
    let pm = 0;
    if (!this.twentyFourHour) {
      pm = hours >= 12 ? 0x80 : 0;
      value = hours % 12 || 12;
    }
    return (this.binary ? value : toBcd(value)) | pm;
  }

  private decode(value: number): number {
    return this.binary ? value : fromBcd(value);
  }

  private encode(value: number): number {
    return this.binary ? value : toBcd(value);
  }

  write(port: number, value: number): void {
    if ((port & 1) === 0) {
      this.index = value & 0x7f;
      this.nmiMasked = (value & 0x80) !== 0;
      return;
    }
    switch (this.index) {
      case R.A:
        this.ram[R.A] = value & 0x7f;
        this.periodicLeft = this.periodicSeconds;
        break;
      case R.B:
        this.ram[R.B] = value;
        // Setting SET stops updates and clears the update-ended interrupt enable.
        if (value & 0x80) this.ram[R.B] &= ~0x10;
        this.updateInterrupt();
        break;
      case R.C:
      case R.D:
        break;
      default:
        this.ram[this.index] = value;
    }
  }

  read(port: number): number {
    if ((port & 1) === 0) return 0xff;
    switch (this.index) {
      case R.A:
        return this.ram[R.A] | (this.fraction >= 1 - UIP_SECONDS && !(this.ram[R.B] & 0x80) ? 0x80 : 0);
      case R.C: {
        const value = this.ram[R.C];
        this.ram[R.C] = 0;
        this.updateInterrupt();
        return value;
      }
      case R.D:
        return 0x80;
      default:
        return this.ram[this.index];
    }
  }

  /** The periodic interrupt's period from register A's rate (0 when off). */
  private get periodicSeconds(): number {
    const rate = this.ram[R.A] & 0xf;
    if (rate === 0) return 0;
    const hz = rate <= 2 ? 32768 >> (rate + 6) : 32768 >> (rate - 1);
    return 1 / hz;
  }

  private updateInterrupt(): void {
    const c = this.ram[R.C] & 0x70;
    const enabled = this.ram[R.B] & 0x70;
    const pending = (c & enabled) !== 0;
    this.ram[R.C] = (this.ram[R.C] & 0x70) | (pending ? 0x80 : 0);
    this.onInterrupt(pending);
  }

  /** Runs the clock for `seconds` of emulated time. */
  advance(seconds: number): void {
    const period = this.periodicSeconds;
    if (period > 0) {
      this.periodicLeft -= seconds;
      if (this.periodicLeft <= 0) {
        this.periodicLeft += period * Math.ceil(-this.periodicLeft / period + 1e-9);
        if (this.periodicLeft <= 0) this.periodicLeft = period;
        this.ram[R.C] |= 0x40;
        this.updateInterrupt();
      }
    }
    this.fraction += seconds;
    while (this.fraction >= 1) {
      this.fraction -= 1;
      if (this.ram[R.B] & 0x80) continue;
      this.tickSecond();
    }
  }

  private tickSecond(): void {
    const ram = this.ram;
    let seconds = this.decode(ram[R.Seconds]) + 1;
    let minutes = this.decode(ram[R.Minutes]);
    const pm = !this.twentyFourHour && ram[R.Hours] & 0x80;
    let hours = this.decode(ram[R.Hours] & 0x7f);
    if (!this.twentyFourHour) hours = (hours % 12) + (pm ? 12 : 0);
    let day = this.decode(ram[R.Day]);
    let month = this.decode(ram[R.Month]);
    let year = this.decode(ram[R.Year]);
    let weekday = this.decode(ram[R.Weekday]);
    if (seconds >= 60) {
      seconds = 0;
      minutes++;
    }
    if (minutes >= 60) {
      minutes = 0;
      hours++;
    }
    if (hours >= 24) {
      hours = 0;
      day++;
      weekday = (weekday % 7) + 1;
      const century = fromBcd(ram[R.Century]) || 19;
      const daysInMonth = new Date(century * 100 + year, month, 0).getDate();
      if (day > daysInMonth) {
        day = 1;
        month++;
        if (month > 12) {
          month = 1;
          year++;
          if (year > 99) {
            year = 0;
            ram[R.Century] = toBcd((century + 1) % 100);
          }
        }
      }
    }
    ram[R.Seconds] = this.encode(seconds);
    ram[R.Minutes] = this.encode(minutes);
    ram[R.Hours] = this.encodeHours(hours);
    ram[R.Day] = this.encode(day);
    ram[R.Month] = this.encode(month);
    ram[R.Year] = this.encode(year);
    ram[R.Weekday] = this.encode(weekday);
    let flags = 0x10;
    const alarm = (reg: number, value: number) => (ram[reg] & 0xc0) === 0xc0 || ram[reg] === value;
    if (alarm(R.SecondsAlarm, ram[R.Seconds]) && alarm(R.MinutesAlarm, ram[R.Minutes]) && alarm(R.HoursAlarm, ram[R.Hours])) flags |= 0x20;
    ram[R.C] |= flags;
    this.updateInterrupt();
  }
}
