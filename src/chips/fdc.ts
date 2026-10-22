import type { FloppyImage } from '../drive/floppy-image';
import { SECTOR_BYTES } from '../drive/floppy-image';
import type { Dma8237 } from './dma8237';

const DMA_CHANNEL = 2;
/** A disk turns at 300 rpm. */
const REVOLUTION_SECONDS = 0.2;
const INDEX_PULSE_SECONDS = 0.002;
/** How long reading or writing a sector takes (faster than a real drive, so programs load quickly). */
const SECTOR_SECONDS = 0.0015;
const STEP_SECONDS = 0.0005;
const SETTLE_SECONDS = 0.001;
const MAX_CYLINDER = 83;

/** The drives IBM fitted: 3.5" 1.44 MB and 720 KB, 5.25" 1.2 MB and 360 KB. */
export type DriveKind = '3.5-hd' | '3.5-dd' | '5.25-hd' | '5.25-dd';

/** A floppy drive, and the disk in it. */
export class FloppyDrive {
  kind: DriveKind = '3.5-hd';
  disk: FloppyImage | null = null;
  /** Where the head is. */
  cylinder = 0;
  /** The disk change line: set when a disk is taken out, cleared by stepping the head with a disk in. */
  changed = true;
  /** The sector the next READ ID finds. */
  nextSector = 1;
  /** The drive has been reading or writing recently (for the activity light). */
  activity = 0;

  constructor(public connected: boolean) {}

  insert(disk: FloppyImage | null): void {
    this.disk = disk;
    this.changed = true;
  }
}

const PARAMETERS: Record<number, number> = {
  0x02: 8,
  0x03: 2,
  0x04: 1,
  0x05: 8,
  0x06: 8,
  0x07: 1,
  0x08: 0,
  0x09: 8,
  0x0a: 1,
  0x0c: 8,
  0x0d: 5,
  0x0f: 2,
  0x11: 8,
  0x19: 8,
  0x1d: 8,
};

/**
 * A floppy controller: an NEC 765-compatible core at 3F0h-3F7h on IRQ 6 and
 * DMA channel 2. As the PS/2 Model 30 has it (`ps2`), behind the gate array's
 * registers: status registers A and B, the drive type register, and a disk
 * change line that reads 1 for "not changed". As the AT has it (`at`), with
 * the data rate select and a disk change line that reads 1 for "changed".
 * Data moves by DMA when a command completes.
 */
export class Fdc {
  readonly drives = [new FloppyDrive(true), new FloppyDrive(false)];
  /** The PC and PC/XT's adapter has neither the data rate select nor the disk change line: always 250 kbit/s. */
  mode: 'ps2' | 'at' | 'xt' = 'ps2';
  dor = 0;
  /** The data rate select: 0 for 500 kbit/s (high density), 2 for 250 kbit/s. */
  rate = 0;
  noPrecomp = false;
  irq = false;
  private command: number[] = [];
  private expected = 0;
  private results: number[] = [];
  private busy = false;
  /** Drives with a seek or recalibrate whose interrupt hasn't been sensed: [ST0, cylinder]. */
  private readonly seekStatus: ([number, number] | null)[] = [null, null, null, null];
  /** After a reset, four SENSE INTERRUPT STATUS commands report the drives. */
  private resetSenses = 0;
  private timer = 0;
  private timerAction: (() => void) | null = null;
  /** Emulated seconds, for the index pulse. */
  private time = 0;
  private headDirectionOut = false;
  /** Status register A's step latch: set by a seek that steps the head, cleared by reading the DIR. */
  private stepped = false;

  constructor(
    private readonly dma: Dma8237,
    private readonly setIrqLine: (high: boolean) => void,
  ) {}

  reset(): void {
    this.dor = 0;
    this.rate = this.mode === 'xt' ? 2 : 0;
    this.enterReset();
  }

  private enterReset(): void {
    this.command = [];
    this.results = [];
    this.expected = 0;
    this.busy = false;
    this.timerAction = null;
    this.seekStatus.fill(null);
    this.stepped = false;
    this.setIrq(false);
  }

  private setIrq(high: boolean): void {
    // The DMA and interrupt gate (DOR bit 3) must be on for the interrupt to reach the PIC.
    const line = high && (this.dor & 0x08) !== 0;
    this.irq = high;
    this.setIrqLine(line);
  }

  private get msr(): number {
    if (this.results.length > 0) return 0xd0;
    if (this.busy) return 0x10;
    let seeking = 0;
    this.seekStatus.forEach((status, i) => {
      if (status && this.timerAction) seeking |= 1 << i;
    });
    return (this.command.length > 0 ? 0x90 : 0x80) | seeking;
  }

  private selectedDrive(): FloppyDrive {
    return this.drives[this.dor & 1];
  }

  private motorOn(drive: number): boolean {
    return (this.dor & (0x10 << drive)) !== 0;
  }

  read(port: number): number {
    const ps2 = this.mode === 'ps2';
    switch (port & 7) {
      case 0: {
        if (!ps2) return 0xff;
        const drive = this.selectedDrive();
        let value = 0;
        if (this.headDirectionOut) value |= 0x01;
        if (drive.disk?.writeProtected) value |= 0x02;
        if (drive.disk && this.motorOn(this.dor & 1) && this.time % REVOLUTION_SECONDS < INDEX_PULSE_SECONDS) value |= 0x04;
        value |= 0x08;
        if (drive.cylinder === 0) value |= 0x10;
        if (this.stepped) value |= 0x20;
        if (this.irq) value |= 0x80;
        return value;
      }
      case 1: {
        if (!ps2) return 0xff;
        let value = this.drives[1].connected ? 0 : 0x80;
        value |= (this.dor & 1) === 0 ? 0x43 : 0x23;
        return value;
      }
      case 2:
        return this.dor;
      case 3:
        // 3.5" high density drives.
        return ps2 ? 0x00 : 0xff;
      case 4:
        return this.msr;
      case 5:
        return this.readData();
      case 7: {
        if (this.mode === 'xt') return 0xff;
        this.stepped = false;
        const drive = this.dor & 1;
        const d = this.drives[drive];
        const changed = d.changed || !d.disk;
        // On the AT the other bits are the fixed disk adapter's.
        if (!ps2) return (this.motorOn(drive) && changed ? 0x80 : 0) | 0x7f;
        if (!this.motorOn(drive)) return 0;
        return (changed ? 0x00 : 0x80) | (this.dor & 0x08) | (this.noPrecomp ? 4 : 0) | (this.rate & 3);
      }
      default:
        return 0xff;
    }
  }

  write(port: number, value: number): void {
    switch (port & 7) {
      case 2: {
        const wasReset = (this.dor & 0x04) === 0;
        this.dor = value;
        if (!(value & 0x04)) {
          this.enterReset();
        } else if (wasReset) {
          // Leaving reset: the controller interrupts, and each drive's status is sensed in turn.
          this.resetSenses = 4;
          this.schedule(0.0001, () => this.setIrq(true));
        }
        this.setIrqLine(this.irq && (value & 0x08) !== 0);
        break;
      }
      case 5:
        this.writeData(value);
        break;
      case 7:
        if (this.mode === 'xt') break;
        // The PS/2 gate array has only 500 and 250 kbit/s; the AT has 300 too.
        this.rate = this.mode === 'ps2' ? value & 2 : value & 3;
        this.noPrecomp = (value & 4) !== 0;
        break;
    }
  }

  private readData(): number {
    if (this.results.length === 0) return 0xff;
    const value = this.results.shift()!;
    this.setIrq(false);
    return value;
  }

  private writeData(value: number): void {
    if (this.results.length > 0 || this.busy || !(this.dor & 0x04)) return;
    if (this.command.length === 0) {
      const count = PARAMETERS[value & 0x1f];
      if (count === undefined) {
        // An invalid command (VERSION and the 82077's other additions included).
        this.results = [0x80];
        return;
      }
      this.expected = count;
      this.command = [value];
    } else {
      this.command.push(value);
    }
    if (this.command.length === this.expected + 1) {
      const command = this.command;
      this.command = [];
      this.execute(command);
    }
  }

  private schedule(seconds: number, action: () => void): void {
    this.timer = seconds;
    this.timerAction = action;
  }

  /** Runs for `seconds` of emulated time. */
  advance(seconds: number): void {
    this.time += seconds;
    for (const drive of this.drives) if (drive.activity > 0) drive.activity = Math.max(0, drive.activity - seconds);
    if (!this.timerAction) return;
    this.timer -= seconds;
    if (this.timer > 0) return;
    const action = this.timerAction;
    this.timerAction = null;
    action();
  }

  private finish(results: number[]): void {
    this.busy = false;
    this.results = results;
    this.setIrq(true);
  }

  private execute(command: number[]): void {
    const op = command[0] & 0x1f;
    const unit = command[1] & 3;
    const head = (command[1] >> 2) & 1;
    switch (op) {
      case 0x03:
        // SPECIFY's step rate and head times don't matter here; PCs always use DMA.
        return;
      case 0x04: {
        const drive = this.drives[unit & 1];
        const st3 =
          (drive.disk?.writeProtected ? 0x40 : 0) | 0x20 | (drive.cylinder === 0 ? 0x10 : 0) | 0x08 | (head << 2) | unit;
        this.results = [st3];
        return;
      }
      case 0x07:
        this.stepped = true;
        this.seek(unit, head, 0);
        return;
      case 0x0f:
        this.seek(unit, head, command[2]);
        return;
      case 0x08:
        this.senseInterrupt();
        return;
      case 0x0a:
        this.busy = true;
        this.schedule(SECTOR_SECONDS, () => this.readId(unit, head));
        return;
      case 0x0d:
        this.busy = true;
        this.schedule(SECTOR_SECONDS * command[3] + SETTLE_SECONDS, () => this.format(command));
        return;
      case 0x05:
      case 0x09:
      case 0x06:
      case 0x0c:
      case 0x02: {
        this.busy = true;
        const sectors = Math.max(1, command[6] - command[4] + 1);
        this.schedule(SETTLE_SECONDS + SECTOR_SECONDS * sectors, () => this.transfer(command));
        return;
      }
      default:
        // The scan commands aren't used on PCs.
        this.results = [0x80];
    }
  }

  private senseInterrupt(): void {
    if (this.resetSenses > 0) {
      const unit = 4 - this.resetSenses;
      this.resetSenses--;
      this.results = [0xc0 | unit, this.drives[unit & 1].cylinder];
      if (this.resetSenses === 0) this.setIrq(false);
      return;
    }
    const unit = this.seekStatus.findIndex((status) => status !== null);
    if (unit < 0) {
      this.results = [0x80];
      return;
    }
    const [st0, cylinder] = this.seekStatus[unit]!;
    this.seekStatus[unit] = null;
    this.results = [st0, cylinder];
    this.setIrq(false);
  }

  private seek(unit: number, head: number, target: number): void {
    const drive = unit < 2 ? this.drives[unit] : null;
    if (!drive?.connected) {
      this.seekStatus[unit] = [0x70 | (head << 2) | unit, 0];
      this.schedule(STEP_SECONDS, () => this.setIrq(true));
      return;
    }
    const cylinder = Math.min(target, MAX_CYLINDER);
    const steps = Math.abs(cylinder - drive.cylinder);
    this.headDirectionOut = cylinder < drive.cylinder;
    if (steps > 0) {
      this.stepped = true;
      if (drive.disk) drive.changed = false;
    }
    drive.cylinder = cylinder;
    this.seekStatus[unit] = [0x20 | (head << 2) | unit, cylinder];
    this.schedule(SETTLE_SECONDS + steps * STEP_SECONDS, () => this.setIrq(true));
  }

  /**
   * Whether the drive can read its disk at the selected data rate: high density at 500 kbit/s,
   * double density at 250 (or at 300 in a 1.2 MB drive), and nothing high density in a double density drive.
   */
  private readable(drive: FloppyDrive | undefined): drive is FloppyDrive & { disk: FloppyImage } {
    if (!drive?.connected || !drive.disk || !this.motorOn(this.drives.indexOf(drive))) return false;
    const highDensity = drive.disk.geometry.highDensity;
    if (drive.kind.endsWith('-dd')) return !highDensity && this.rate === 2;
    if (highDensity) return this.rate === 0;
    return this.rate === 2 || (drive.kind === '5.25-hd' && this.rate === 1);
  }

  /**
   * The disk's cylinder under the head. A 1.2 MB drive has 80 tracks, so a 40-track disk's
   * cylinders are every other track (the BIOS steps twice); -1 between them.
   */
  private diskCylinder(drive: FloppyDrive & { disk: FloppyImage }): number {
    if (drive.kind === '5.25-hd' && drive.disk.geometry.cylinders <= 42) return drive.cylinder & 1 ? -1 : drive.cylinder >> 1;
    return drive.cylinder;
  }

  private readId(unit: number, head: number): void {
    const drive = this.drives[unit & 1];
    if (unit > 1 || !this.readable(drive) || head >= drive.disk.geometry.heads || this.diskCylinder(drive) < 0) {
      this.finish([0x40 | (head << 2) | unit, 0x01, 0, drive.cylinder, head, 1, 2]);
      return;
    }
    const sector = drive.nextSector;
    drive.nextSector = (sector % drive.disk.geometry.sectors) + 1;
    this.finish([(head << 2) | unit, 0, 0, this.diskCylinder(drive), head, sector, 2]);
  }

  /** READ DATA, WRITE DATA (and their deleted-data forms) and READ TRACK, moving whole sectors by DMA. */
  private transfer(command: number[]): void {
    const op = command[0] & 0x1f;
    const multiTrack = (command[0] & 0x80) !== 0;
    const write = op === 0x05 || op === 0x09;
    const unit = command[1] & 3;
    let head = (command[1] >> 2) & 1;
    let cylinder = command[2];
    let sector = op === 0x02 ? 1 : command[4];
    const sizeCode = command[5];
    const endOfTrack = command[6];
    const drive = this.drives[unit & 1];
    const fail = (st1: number, st2 = 0) =>
      this.finish([0x40 | (head << 2) | unit, st1, st2, cylinder, head, sector, sizeCode]);
    if (unit > 1 || !this.readable(drive)) {
      fail(0x01);
      return;
    }
    const disk = drive.disk;
    if (write && disk.writeProtected) {
      fail(0x02);
      return;
    }
    const onDisk = this.diskCylinder(drive);
    if (onDisk < 0) {
      fail(0x01);
      return;
    }
    if (onDisk !== cylinder) {
      fail(0x04, 0x10);
      return;
    }
    if (sizeCode !== 2 || head >= disk.geometry.heads) {
      fail(0x04);
      return;
    }
    if (!this.dma.ready(DMA_CHANNEL)) {
      fail(0x10);
      return;
    }
    drive.activity = 0.05;
    for (;;) {
      const offset = disk.offset(onDisk, head, sector);
      if (offset < 0) {
        fail(0x04);
        return;
      }
      let terminal = false;
      for (let i = 0; i < SECTOR_BYTES && !terminal; i++) {
        if (write) {
          const [value, tc] = this.dma.readByte(DMA_CHANNEL);
          disk.bytes[offset + i] = value;
          terminal = tc;
        } else {
          terminal = this.dma.writeByte(DMA_CHANNEL, disk.bytes[offset + i]);
        }
      }
      if (write) disk.dirty = true;
      // The next sector, for the result (and for the transfer to go on to).
      const last = sector >= endOfTrack;
      if (last) {
        sector = 1;
        if (multiTrack && head === 0 && disk.geometry.heads > 1) {
          head = 1;
        } else {
          cylinder++;
          if (multiTrack) head = 0;
        }
      } else {
        sector++;
      }
      if (terminal) {
        this.finish([(head << 2) | unit, 0, 0, cylinder, head, sector, sizeCode]);
        return;
      }
      if (last && cylinder !== command[2]) {
        // Past the end of the cylinder without a terminal count.
        this.finish([0x40 | (head << 2) | unit, 0x80, 0, cylinder, head, sector, sizeCode]);
        return;
      }
    }
  }

  private format(command: number[]): void {
    const unit = command[1] & 3;
    const head = (command[1] >> 2) & 1;
    const count = command[3];
    const filler = command[5];
    const drive = this.drives[unit & 1];
    const done = (st0: number, st1: number) => this.finish([st0 | (head << 2) | unit, st1, 0, drive.cylinder, head, 1, command[2]]);
    if (unit > 1 || !this.readable(drive) || this.diskCylinder(drive) < 0) {
      done(0x40, 0x01);
      return;
    }
    const disk = drive.disk;
    if (disk.writeProtected) {
      done(0x40, 0x02);
      return;
    }
    drive.activity = 0.05;
    for (let i = 0; i < count; i++) {
      const id = [0, 0, 0, 0].map(() => this.dma.readByte(DMA_CHANNEL)[0]);
      const offset = disk.offset(this.diskCylinder(drive), head, id[2]);
      if (offset >= 0) disk.bytes.fill(filler, offset, offset + SECTOR_BYTES);
    }
    disk.dirty = true;
    done(0, 0);
  }
}
