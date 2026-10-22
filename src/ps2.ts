import { Speaker } from './audio/speaker';
import { Dma8237 } from './chips/dma8237';
import { Fdc } from './chips/fdc';
import { Kbc8042 } from './chips/kbc8042';
import { Pic8259 } from './chips/pic8259';
import { PIT_HZ, Pit8254 } from './chips/pit8254';
import { Rtc146818 } from './chips/rtc146818';
import { Uart16450 } from './chips/uart16450';
import { I286, type CpuBus } from './cpu/i286';
import type { FloppyImage } from './drive/floppy-image';
import { captureState, restoreState, type StateNode } from './state/snapshot';
import { Vga } from './video/vga';

/** The Model 30 286's 80286 runs at 10 MHz. */
export const CPU_HZ = 10_000_000;
export const ROM_BYTES = 0x20000;
const BASE_MEMORY = 0xa0000;
/** Devices are brought up to the CPU's time at least this often (100 µs). */
const SLICE_CYCLES = 1000;
/** Port 61h's refresh bit toggles every 15 µs or so. */
const REFRESH_SECONDS = 15e-6;
/** The longest the power-on self test is taken to run (4 MB takes about 45 seconds to check). */
const MAX_START_SECONDS = 60;

export type MemorySize = 1 | 2 | 4;

/** Port 1 of the keyboard controller: the planar memory's presence detect bits, by size (drive A is 1.44 MB). */
function memoryDetect(megabytes: MemorySize): number {
  return (megabytes >= 4 ? 0x80 : megabytes >= 2 ? 0x90 : 0xa0) | 0x0c;
}

/**
 * An IBM PS/2 Model 30 286: a 10 MHz 80286, 1 to 4 MB of memory, the AT's
 * interrupt controllers, timer and DMA, the PS/2 keyboard controller with a
 * keyboard and mouse, the CMOS clock, VGA, a 1.44 MB floppy drive (and an
 * optional second one), a serial port and the speaker. The BIOS is IBM's
 * 128K ROM at E0000h, which the user supplies.
 */
export class Ps2 implements CpuBus {
  readonly rom = new Uint8Array(ROM_BYTES);
  ram = new Uint8Array(2 << 20);
  memoryMegabytes: MemorySize = 2;
  readonly cpu: I286;
  readonly picMaster: Pic8259;
  readonly picSlave = new Pic8259();
  readonly pit = new Pit8254();
  readonly dma = new Dma8237({
    readPhysical: (address) => this.readPhysical(address),
    writePhysical: (address, value) => this.writePhysical(address, value),
  });
  readonly rtc = new Rtc146818();
  readonly kbc: Kbc8042;
  readonly fdc: Fdc;
  readonly vga = new Vga();
  readonly uart = new Uart16450();
  readonly speaker = new Speaker();
  /** Port 61h's writable bits: 0 gates counter 2, 1 drives the speaker. */
  portB = 0;
  port92 = 0;
  /** The PS/2 setup registers at 91h, 94h, 102h-105h and 190h (where POST writes its checkpoints). */
  readonly setup = new Uint8Array(8);
  lptBase = 0x3bc;
  readonly lpt = new Uint8Array(3);
  private a20Kbc = false;
  private a20Mask = 0xefffff;
  private refreshTime = 0;
  /** The CPU cycle the devices have been run up to. */
  private deviceCycles = 0;
  private pitFraction = 0;
  private irqPending = false;
  /** The BIOS's power-on self test is running: from switching on (or a reset) until code runs from RAM. */
  starting = true;
  private startedAt = 0;

  constructor() {
    this.cpu = new I286(this);
    this.picMaster = new Pic8259(this.picSlave);
    this.picMaster.onChange = this.picSlave.onChange = () => (this.irqPending = this.picMaster.output);
    this.kbc = new Kbc8042({
      setIrq: (line, high) => (line === 1 ? this.picMaster.setLine(1, high) : this.picSlave.setLine(4, high)),
      setA20: (enabled) => {
        this.a20Kbc = enabled;
        this.updateA20();
      },
      resetCpu: () => this.resetCpu(),
      inputPort: () => memoryDetect(this.memoryMegabytes),
    });
    this.fdc = new Fdc(this.dma, (high) => this.picMaster.setLine(6, high));
    this.pit.onOutput = (index, high, tick) => {
      if (index === 0) this.picMaster.setLine(0, high);
      else if (index === 2) this.speaker.set(high && (this.portB & 2) !== 0, tick);
    };
    this.rtc.onInterrupt = (high) => this.picSlave.setLine(0, high);
    this.uart.onInterrupt = (high) => this.picMaster.setLine(this.uart.base === 0x3f8 ? 4 : 3, high);
    this.vga.onInterrupt = (high) => this.picSlave.setLine(1, high);
    this.cpu.onShutdown = () => this.resetCpu();
  }

  // --- Setup -------------------------------------------------------------------------

  /** Loads the BIOS (128K); takes effect at the next power on. */
  setRom(rom: Uint8Array): void {
    this.rom.set(rom.subarray(0, ROM_BYTES));
  }

  setMemory(megabytes: MemorySize): void {
    this.memoryMegabytes = megabytes;
    if (this.ram.length !== megabytes << 20) this.ram = new Uint8Array(megabytes << 20);
  }

  setSampleRate(rate: number): void {
    this.speaker.setSampleRate(rate);
  }

  /** The CMOS RAM kept from last time (the clock registers come from the date at power on). */
  loadCmos(ram: Uint8Array): void {
    this.rtc.ram.set(ram.subarray(0x0e, 0x80), 0x0e);
  }

  insertDisk(drive: number, disk: FloppyImage | null): void {
    this.fdc.drives[drive].insert(disk);
  }

  // --- Power and reset ---------------------------------------------------------------

  /** Switches on: memory cleared, every chip reset, the CPU starting from the ROM. */
  powerOn(date = new Date()): void {
    this.ram.fill(0);
    this.picMaster.reset();
    this.picSlave.reset();
    this.pit.ticks = 0;
    this.pit.reset();
    this.dma.reset();
    this.rtc.powerOn(date);
    this.kbc.powerOn();
    this.fdc.reset();
    this.vga.powerOn();
    this.uart.reset();
    this.portB = 0;
    this.port92 = 0;
    this.setup.fill(0);
    this.updateA20();
    this.speaker.restart(0);
    this.cpu.reset();
    this.cpu.cycles = 0;
    this.deviceCycles = 0;
    this.pitFraction = 0;
    for (const drive of this.fdc.drives) drive.cylinder = 0;
    this.starting = true;
    this.startedAt = 0;
  }

  /** The CPU's reset line alone (the keyboard controller's and port 92h's resets): memory and chips keep their state. */
  resetCpu(): void {
    const cycles = this.cpu.cycles;
    this.cpu.reset();
    this.cpu.cycles = cycles;
    this.starting = true;
    this.startedAt = cycles;
  }

  private updateA20(): void {
    const on = this.a20Kbc || (this.port92 & 2) !== 0;
    this.a20Mask = on ? 0xffffff : 0xefffff;
  }

  // --- Memory -------------------------------------------------------------------------

  /** Physical memory, after the A20 gate: RAM below 640K and from 1 MB, the VGA, and the ROM at E0000h and at the top. */
  read8(address: number): number {
    const a = address & this.a20Mask;
    if (a < BASE_MEMORY) return this.ram[a];
    return this.readPhysical(a);
  }

  write8(address: number, value: number): void {
    const a = address & this.a20Mask;
    if (a < BASE_MEMORY) this.ram[a] = value;
    else this.writePhysical(a, value);
  }

  read16(address: number): number {
    return this.read8(address) | (this.read8(address + 1) << 8);
  }

  write16(address: number, value: number): void {
    this.write8(address, value & 0xff);
    this.write8(address + 1, value >> 8);
  }

  readPhysical(a: number): number {
    if (a < BASE_MEMORY) return this.ram[a];
    if (a < 0xc0000) return this.vga.readMemory(a);
    if (a < 0xe0000) return 0xff;
    if (a < 0x100000) return this.rom[a - 0xe0000];
    if (a >= 0xfe0000) return this.rom[a - 0xfe0000];
    const extended = a - 0x100000 + BASE_MEMORY;
    return extended < this.ram.length ? this.ram[extended] : 0xff;
  }

  writePhysical(a: number, value: number): void {
    if (a < BASE_MEMORY) {
      this.ram[a] = value;
    } else if (a < 0xc0000) {
      this.vga.writeMemory(a, value);
    } else if (a >= 0x100000 && a < 0xfe0000) {
      const extended = a - 0x100000 + BASE_MEMORY;
      if (extended < this.ram.length) this.ram[extended] = value;
    }
  }

  // --- I/O ----------------------------------------------------------------------------

  in8(port: number): number {
    port &= 0xffff;
    if (port < 0x10 || (port >= 0xc0 && port < 0xe0) || (port >= 0x80 && port < 0x90)) return this.dma.read(port);
    switch (port) {
      case 0x20:
      case 0x21:
        return this.picMaster.read(port);
      case 0xa0:
      case 0xa1:
        return this.picSlave.read(port);
      case 0x40:
      case 0x41:
      case 0x42:
      case 0x43:
        this.syncDevices();
        return this.pit.read(port);
      case 0x60:
      case 0x64:
        this.syncDevices();
        return this.kbc.read(port);
      case 0x61:
        this.syncDevices();
        return this.portB | (this.refreshTime % (2 * REFRESH_SECONDS) >= REFRESH_SECONDS ? 0x10 : 0) | (this.pit.output(2) ? 0x20 : 0);
      case 0x70:
      case 0x71:
        this.syncDevices();
        return this.rtc.read(port);
      case 0x91: {
        const value = this.setup[0];
        this.setup[0] = 0;
        return value;
      }
      case 0x92:
        return this.port92;
      case 0x94:
        return this.setup[1];
      case 0x102:
        return this.setup[2] | 0x08;
      case 0x103:
      case 0x104:
      case 0x105:
        return this.setup[port - 0x100];
      case 0x190:
        return this.setup[6];
    }
    if (port >= 0x3f0 && port <= 0x3f7 && port !== 0x3f6) {
      this.syncDevices();
      return this.fdc.read(port);
    }
    if (port >= this.lptBase && port < this.lptBase + 3) {
      const reg = port - this.lptBase;
      // Status: not busy, no paper error, selected, no error.
      return reg === 1 ? 0xdf : this.lpt[reg];
    }
    if (port >= 0x3b0 && port <= 0x3df) {
      this.syncDevices();
      return this.vga.read(port);
    }
    if (this.uart.owns(port)) return this.uart.read(port);
    return 0xff;
  }

  out8(port: number, value: number): void {
    port &= 0xffff;
    if (port < 0x10 || (port >= 0xc0 && port < 0xe0) || (port >= 0x80 && port < 0x90)) {
      this.dma.write(port, value);
      return;
    }
    switch (port) {
      case 0x20:
      case 0x21:
        this.picMaster.write(port, value);
        return;
      case 0xa0:
      case 0xa1:
        this.picSlave.write(port, value);
        return;
      case 0x40:
      case 0x41:
      case 0x42:
      case 0x43:
        this.syncDevices();
        this.pit.write(port, value);
        return;
      case 0x60:
      case 0x64:
        this.syncDevices();
        this.kbc.write(port, value);
        return;
      case 0x61:
        this.syncDevices();
        this.portB = value & 0x0f;
        this.pit.setGate(2, (value & 1) !== 0);
        this.speaker.set((value & 2) !== 0 && this.pit.output(2), this.pit.ticks);
        return;
      case 0x70:
      case 0x71:
        this.syncDevices();
        this.rtc.write(port, value);
        return;
      case 0x92: {
        const reset = value & 1 && !(this.port92 & 1);
        this.port92 = value & 0x03;
        this.updateA20();
        if (reset) this.resetCpu();
        return;
      }
      case 0x94:
        this.setup[1] = value;
        return;
      case 0x102:
        if (this.setup[1] & 0x80) return;
        this.setup[2] = value;
        this.uart.enabled = (value & 0x04) !== 0;
        this.uart.base = value & 0x08 ? 0x3f8 : 0x2f8;
        this.lptBase = value & 0x10 ? [0x3bc, 0x378, 0x278, 0x3bc][(value >> 5) & 3] : -16;
        return;
      case 0x103:
      case 0x104:
      case 0x105:
        if (!(this.setup[1] & 0x80)) this.setup[port - 0x100] = value;
        return;
      case 0x190:
        this.setup[6] = value;
        return;
    }
    if (port >= 0x3f0 && port <= 0x3f7 && port !== 0x3f6) {
      this.syncDevices();
      this.fdc.write(port, value);
      return;
    }
    if (port >= this.lptBase && port < this.lptBase + 3) {
      this.lpt[port - this.lptBase] = value;
      return;
    }
    if (port >= 0x3b0 && port <= 0x3df) {
      this.syncDevices();
      this.vga.write(port, value);
      return;
    }
    if (this.uart.owns(port)) this.uart.write(port, value);
  }

  in16(port: number): number {
    return this.in8(port) | (this.in8(port + 1) << 8);
  }

  out16(port: number, value: number): void {
    this.out8(port, value & 0xff);
    this.out8(port + 1, value >> 8);
  }

  // --- Running -----------------------------------------------------------------------

  /** Brings the chips up to the CPU's time. */
  syncDevices(): void {
    const elapsed = this.cpu.cycles - this.deviceCycles;
    if (elapsed <= 0) return;
    this.deviceCycles = this.cpu.cycles;
    const seconds = elapsed / CPU_HZ;
    this.pitFraction += (elapsed * PIT_HZ) / CPU_HZ;
    const ticks = Math.floor(this.pitFraction);
    this.pitFraction -= ticks;
    if (ticks > 0) this.pit.advance(ticks);
    this.speaker.advanceTo(this.pit.ticks);
    this.refreshTime = (this.refreshTime + seconds) % 1;
    this.vga.advance(seconds);
    this.rtc.advance(seconds);
    this.fdc.advance(seconds);
    this.kbc.advance(seconds);
  }

  /** Runs for `cycles` CPU clocks. */
  run(cycles: number): void {
    const cpu = this.cpu;
    const end = cpu.cycles + cycles;
    while (cpu.cycles < end) {
      const sliceEnd = Math.min(end, cpu.cycles + SLICE_CYCLES);
      while (cpu.cycles < sliceEnd) {
        if (this.irqPending && cpu.acceptsInterrupts) cpu.interrupt(this.picMaster.acknowledge());
        if (cpu.halted) {
          cpu.cycles = sliceEnd;
          break;
        }
        cpu.step();
      }
      this.syncDevices();
      if (this.starting) this.checkStarted();
    }
  }

  private checkStarted(): void {
    const cpu = this.cpu;
    const ranFromRam = !cpu.protectedMode && cpu.segBase[1] + cpu.ip < 0xa0000;
    if (ranFromRam || cpu.cycles - this.startedAt > MAX_START_SECONDS * CPU_HZ) this.starting = false;
  }

  /** Runs until the VGA finishes its next picture (or a tenth of a second passes with the display off). */
  runFrame(): void {
    const target = this.vga.frames + 1;
    const limit = this.cpu.cycles + CPU_HZ / 10;
    while (this.vga.frames < target && this.cpu.cycles < limit) this.run(SLICE_CYCLES * 4);
  }

  // --- Save states -------------------------------------------------------------------

  /** Everything in the machine except the ROM and the disks (which a session keeps itself). */
  saveState(): StateNode {
    this.syncDevices();
    return captureState(this);
  }

  /** Restores a saved state; the same ROM and disks must already be in. */
  loadState(state: StateNode): void {
    restoreState(this, state);
    this.updateA20();
    this.irqPending = this.picMaster.output;
  }
}
