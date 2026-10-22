import { Speaker } from './audio/speaker';
import { Dma8237 } from './chips/dma8237';
import { Fdc } from './chips/fdc';
import { GateArray } from './chips/gate-array';
import { Kbc8042 } from './chips/kbc8042';
import { Mm58167 } from './chips/mm58167';
import { Pic8259 } from './chips/pic8259';
import { Ppi8255 } from './chips/ppi8255';
import { PIT_HZ, Pit8254 } from './chips/pit8254';
import { Rtc146818 } from './chips/rtc146818';
import { Uart16450 } from './chips/uart16450';
import { Wd1003 } from './chips/wd1003';
import { I286, type CpuBus } from './cpu/i286';
import { Timing } from './cpu/timing';
import { TIMING_286 } from './cpu/timing-286';
import { TIMING_8088 } from './cpu/timing-8088';
import type { FloppyImage } from './drive/floppy-image';
import { MODELS, type ModelSpec } from './models';
import { captureState, restoreState, type StateNode } from './state/snapshot';
import { Cga } from './video/cga';
import { Mcga } from './video/mcga';
import { Vga } from './video/vga';

const BASE_MEMORY = 0xa0000;
/** The chips' measured clocks: the 8088's for the 8086 machines too (their faster bus is in the model's scale). */
const CHIP_TIMING = { '286': new Timing(TIMING_286), '8086': new Timing(TIMING_8088), '8088': new Timing(TIMING_8088) };
/** The most of a ROM that shows below 1 MB, at E0000h-FFFFFh (all of it shows at the top of the 16 MB). */
const LOW_ROM_BYTES = 0x20000;
/** Devices are brought up to the CPU's time at least this often (100 µs). */
const SLICE_CYCLES = 200;
/** Port 61h's refresh bit toggles every 15 µs or so. */
const REFRESH_SECONDS = 15e-6;
/** The longest the power-on self test is taken to run (4 MB takes about 45 seconds to check, an XT's 640K nearly a minute). */
const MAX_START_SECONDS = 90;

/** Port 1 of the keyboard controller: the drive type and planar memory bits on the Model 30 286, by memory size in KB. */
function keyboardPort(model: ModelSpec, kilobytes: number): number {
  if (model.id === 'ps1-2011') return 0xb4;
  return (kilobytes >= 4096 ? 0x80 : kilobytes >= 2048 ? 0x90 : 0xa0) | 0x0c;
}

/**
 * IBM's PCs, built to the model's spec: the 286 PS/2s and PS/1 (VGA, the PS/2
 * keyboard controller, the CMOS clock), the 8086 PS/2s (MCGA and the gate
 * array), the PC/AT (CGA and the AT's 8042) and the 8088 PC and XT (CGA and
 * the 8255), with their interrupt controllers, timer, DMA, floppy drives, a
 * serial port and the speaker. The BIOS is IBM's ROM, which the user supplies.
 */
export class Machine implements CpuBus {
  model: ModelSpec = MODELS[0];
  rom = new Uint8Array(0x20000);
  ram = new Uint8Array(2 << 20);
  memoryKilobytes = 2048;
  readonly cpu: I286;
  readonly picMaster: Pic8259;
  readonly picSlave = new Pic8259();
  readonly pit = new Pit8254();
  readonly dma = new Dma8237({
    readPhysical: (address) => this.readPhysical(address),
    writePhysical: (address, value) => this.writePhysical(address, value),
  });
  readonly rtc = new Rtc146818();
  /** The Model 30's clock. */
  readonly clock = new Mm58167();
  readonly kbc: Kbc8042;
  /** The PC's and XT's keyboard interface and switches (sharing the keyboard with the 8042). */
  readonly ppi: Ppi8255;
  /** The Model 25 and 30's gate array (sharing the keyboard and mouse with the 8042). */
  readonly gateArray: GateArray;
  readonly fdc: Fdc;
  readonly vga = new Vga();
  readonly cga = new Cga();
  readonly mcga = new Mcga();
  readonly uart = new Uart16450();
  /** The AT adapter's fixed disk controller. */
  readonly hdc = new Wd1003();
  readonly speaker = new Speaker();
  /** Port 61h's writable bits: 0 gates counter 2, 1 drives the speaker. */
  portB = 0;
  port92 = 0;
  /** The PS/2 setup registers at 91h, 94h, 102h-105h and 190h (where POST writes its checkpoints). */
  readonly setup = new Uint8Array(8);
  lptBase = 0x3bc;
  readonly lpt = new Uint8Array(3);
  private a20Kbc = false;
  /** The PC's and XT's NMI mask register at A0h. */
  nmiMask = 0;
  private a20Mask = 0xefffff;
  /** Below this, an address is in RAM at the same offset (the Model 25 and 30's bank switching turns it off). */
  private directRamEnd = BASE_MEMORY;
  private refreshTime = 0;
  /** The CPU cycle the devices have been run up to. */
  private deviceCycles = 0;
  private pitFraction = 0;
  /** Timer clocks towards the next refresh request on the PC and XT. */
  private refreshTicks = 0;
  private irqPending = false;
  private nmiPending = false;
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
      inputPort: () => keyboardPort(this.model, this.memoryKilobytes),
    });
    this.fdc = new Fdc(this.dma, (high) => this.picMaster.setLine(6, high));
    this.ppi = new Ppi8255(
      this.kbc.keyboard,
      {
        setIrq: (high) => this.picMaster.setLine(1, high),
        portBChanged: (value) => this.setPortB(value),
        timer2Output: () => this.pit.output(2),
      },
      false,
    );
    this.gateArray = new GateArray(this.kbc.keyboard, this.kbc.mouse, {
      setIrq: (line, high) => this.picMaster.setLine(line, high),
      picIcw: (index) => this.picMaster.icw[index],
      portBChanged: (value) => this.setPortB(value),
      timer2Output: () => this.pit.output(2),
      nmi: () => (this.nmiPending = true),
    });
    this.mcga.onInterrupt = (high) => this.picMaster.setLine(2, high);
    this.clock.onInterrupt = () => {
      if (!(this.gateArray.portA1 & 0x01)) this.picMaster.pulse(1);
    };
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

  /** Which machine this is; takes effect at the next power on. */
  setModel(model: ModelSpec): void {
    this.model = model;
  }

  /** The machine's display adapter: the VGA or MCGA built into a PS/2, or the CGA card of the others. */
  get video(): Vga | Cga | Mcga {
    return this.model.video === 'cga' ? this.cga : this.model.video === 'mcga' ? this.mcga : this.vga;
  }

  /** Called with each finished picture, whichever adapter drew it. */
  set onFrame(handler: (framebuffer: Uint32Array, width: number, height: number) => void) {
    this.vga.onFrame = this.cga.onFrame = this.mcga.onFrame = handler;
  }

  /** The CGA's character ROM. */
  setCgaFont(rom: Uint8Array): void {
    this.cga.setFont(rom);
  }

  /** The 8088 and 8086 machines: 20 address lines and one interrupt controller. */
  private get is8086(): boolean {
    return this.model.cpu !== '286';
  }

  /** The PC and XT, with the 8255 in place of the 8042. */
  private get hasPpi(): boolean {
    return this.model.keyboard === 'xt' || this.model.keyboard === 'pc';
  }

  /** The Model 25 and 30, with the gate array in place of the 8042. */
  private get hasGateArray(): boolean {
    return this.model.keyboard === 'gate-array';
  }

  /** Port 61h's speaker bits: bit 0 gates timer 2, bit 1 drives the speaker. */
  private setPortB(value: number): void {
    this.portB = value & 0x0f;
    this.pit.setGate(2, (value & 1) !== 0);
    this.speaker.set((value & 2) !== 0 && this.pit.output(2), this.pit.ticks);
  }

  private get hasSetupRegisters(): boolean {
    return this.model.setupByte !== null;
  }

  get cpuHz(): number {
    return this.model.cpuHz;
  }

  /** Loads the ROM image, which ends at the top of the address space; takes effect at the next power on. */
  setRom(rom: Uint8Array): void {
    this.rom = rom.slice();
  }

  setMemory(kilobytes: number): void {
    this.memoryKilobytes = kilobytes;
    if (this.ram.length !== kilobytes * 1024) this.ram = new Uint8Array(kilobytes * 1024);
  }

  setSampleRate(rate: number): void {
    this.speaker.setSampleRate(rate);
  }

  /** The clock's battery-backed RAM, as kept between visits: the CMOS's 128 bytes, or the Model 30 clock's 32 registers. */
  get cmosRam(): Uint8Array {
    return this.model.cmos === 'mm58167' ? this.clock.regs : this.rtc.ram;
  }

  /** The CMOS RAM kept from last time (the clock registers come from the date at power on). */
  loadCmos(ram: Uint8Array): void {
    if (this.model.cmos === 'mm58167') this.clock.regs.set(ram.subarray(8, 16), 8);
    else this.rtc.ram.set(ram.subarray(0x0e, 0x80), 0x0e);
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
    this.clock.powerOn(date);
    this.kbc.powerOn();
    this.fdc.mode = this.model.fdc;
    this.fdc.reset();
    this.fdc.drives.forEach((drive, i) => (drive.kind = this.model.drives[i]));
    this.kbc.hasAux = this.model.keyboard === 'ps2';
    this.ppi.reset();
    this.ppi.configure(this.model.keyboard === 'pc', this.fdc.drives[1].connected ? 2 : 1, this.memoryKilobytes);
    this.nmiMask = 0;
    this.vga.powerOn();
    this.cga.powerOn();
    this.mcga.powerOn();
    this.gateArray.reset();
    this.picMaster.cascadeLines = this.is8086 ? 0 : 0x04;
    // The gate array sends the keyboard's and mouse's IRQ 1 to INT 71h, whose handler passes the keyboard's on to INT 9.
    this.picMaster.vectorOverride[1] = this.hasGateArray ? 0x71 : -1;
    this.updateRamMap();
    this.uart.reset();
    this.hdc.reset();
    this.portB = 0;
    this.port92 = 0;
    this.setup.fill(0);
    this.updateA20();
    this.speaker.restart(0);
    this.cpu.reset();
    this.cpu.is8086 = this.is8086;
    this.cpu.timing = CHIP_TIMING[this.model.cpu];
    this.cpu.cycleScale = this.model.cycleScale;
    this.cpu.cycles = 0;
    this.deviceCycles = 0;
    this.pitFraction = 0;
    this.refreshTicks = 0;
    for (const drive of this.fdc.drives) drive.cylinder = 0;
    this.starting = true;
    this.startedAt = 0;
  }

  /** The CPU's reset line alone (the keyboard controller's and port 92h's resets): memory and chips keep their state. */
  resetCpu(): void {
    const cycles = this.cpu.cycles;
    this.cpu.reset();
    this.cpu.is8086 = this.is8086;
    this.cpu.timing = CHIP_TIMING[this.model.cpu];
    this.cpu.cycleScale = this.model.cycleScale;
    this.cpu.cycles = cycles;
    this.starting = true;
    this.startedAt = cycles;
  }

  private updateA20(): void {
    const on = this.a20Kbc || (this.port92 & 2) !== 0;
    // The 8088 has 20 address lines.
    this.a20Mask = this.is8086 ? 0xfffff : on ? 0xffffff : 0xefffff;
  }

  // --- Memory -------------------------------------------------------------------------

  /** Physical memory, after the A20 gate: RAM below 640K and from 1 MB, the VGA, and the ROM at E0000h and at the top. */
  read8(address: number): number {
    const a = address & this.a20Mask;
    if (a < this.directRamEnd) return this.ram[a];
    return this.readPhysical(a);
  }

  write8(address: number, value: number): void {
    const a = address & this.a20Mask;
    if (a < this.directRamEnd) this.ram[a] = value;
    else this.writePhysical(a, value);
  }

  private updateRamMap(): void {
    const banked = this.hasGateArray && (this.gateArray.ramControl !== 0 || this.memoryKilobytes < 640);
    this.directRamEnd = banked ? 0 : Math.min(this.ram.length, BASE_MEMORY);
  }

  /**
   * Where the Model 25 and 30's gate array puts an address below A0000h in its RAM (-1 for none):
   * port 6Bh switches off 64K banks from 40000h, and bit 0 maps a 512K machine's RAM from 0
   * (it is at 20000h otherwise) or, with 640K, moves the first 512K up past the low 128K.
   */
  private bankedRam(a: number): number {
    const control = this.gateArray.ramControl;
    if (a >= 0x40000 && control & (1 << ((a >> 16) - 3))) return -1;
    let offset = a;
    if (control & 1) {
      if (a >= 0x80000) return -1;
      if (this.memoryKilobytes >= 640) offset += 0x20000;
    } else if (this.memoryKilobytes < 640) {
      if (a < 0x20000) return -1;
      offset -= 0x20000;
    }
    return offset < this.ram.length ? offset : -1;
  }

  read16(address: number): number {
    return this.read8(address) | (this.read8(address + 1) << 8);
  }

  write16(address: number, value: number): void {
    this.write8(address, value & 0xff);
    this.write8(address + 1, value >> 8);
  }

  readPhysical(a: number): number {
    if (a < BASE_MEMORY) {
      if (this.hasGateArray) {
        const offset = this.bankedRam(a);
        return offset >= 0 ? this.ram[offset] : 0xff;
      }
      return a < this.ram.length ? this.ram[a] : 0xff;
    }
    if (a < 0xc0000) return this.video.readMemory(a);
    const rom = this.rom;
    if (a < 0x100000) {
      const fromTop = 0x100000 - a;
      return fromTop <= Math.min(rom.length, LOW_ROM_BYTES) ? rom[rom.length - fromTop] : 0xff;
    }
    if (a >= 0x1000000 - rom.length) return rom[a - (0x1000000 - rom.length)];
    const extended = a - 0x100000 + BASE_MEMORY;
    return extended < this.ram.length ? this.ram[extended] : 0xff;
  }

  writePhysical(a: number, value: number): void {
    if (a < BASE_MEMORY) {
      const offset = this.hasGateArray ? this.bankedRam(a) : a < this.ram.length ? a : -1;
      if (offset >= 0) this.ram[offset] = value;
    } else if (a < 0xc0000) {
      this.video.writeMemory(a, value);
    } else if (a >= 0x100000 && a < 0x1000000 - this.rom.length) {
      const extended = a - 0x100000 + BASE_MEMORY;
      if (extended < this.ram.length) this.ram[extended] = value;
    }
  }

  // --- I/O ----------------------------------------------------------------------------

  in8(port: number): number {
    port &= 0xffff;
    this.cpu.cycles += this.model.ioWait;
    this.cpu.waitCycles += this.model.ioWait;
    if (port < 0x10 || (port >= 0xc0 && port < 0xe0) || (port >= 0x80 && port < 0x90)) return this.dma.read(port);
    if (this.hasPpi && port >= 0x60 && port <= 0x63) {
      this.syncDevices();
      return this.ppi.read(port);
    }
    if (this.hasGateArray && this.gateArray.owns(port)) {
      this.syncDevices();
      return this.gateArray.read(port);
    }
    if (this.model.cmos === 'mm58167' && this.clock.owns(port)) {
      this.syncDevices();
      return this.clock.read(port);
    }
    // No second interrupt controller at A0h, no 8042 at 64h and no CMOS clock at 70h.
    if (this.is8086 && (port === 0x64 || port === 0xa0 || port === 0xa1 || port === 0x70 || port === 0x71)) return 0xff;
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
        if (!this.hasSetupRegisters) return 0xff;
        const value = this.setup[0];
        this.setup[0] = 0;
        return value;
      }
      case 0x92:
        return this.model.port92 === 'none' ? 0xff : this.port92;
      case 0x94:
        return this.hasSetupRegisters ? this.setup[1] : 0xff;
      case 0x102:
        return this.hasSetupRegisters ? this.setup[2] | 0x08 : 0xff;
      case 0x103:
      case 0x104:
      case 0x105:
        return this.hasSetupRegisters ? this.setup[port - 0x100] : 0xff;
      case 0x190:
        return this.hasSetupRegisters ? this.setup[6] : 0xff;
    }
    if (port >= 0x3f0 && port <= 0x3f7 && port !== 0x3f6) {
      this.syncDevices();
      return this.fdc.read(port);
    }
    if (this.model.fdc === 'at' && this.hdc.owns(port)) return this.hdc.read(port);
    if (port >= this.lptBase && port < this.lptBase + 3) {
      const reg = port - this.lptBase;
      // Status: not busy, no paper error, selected, no error.
      return reg === 1 ? 0xdf : this.lpt[reg];
    }
    if (port >= 0x3b0 && port <= 0x3df) {
      this.syncDevices();
      if (this.model.video === 'cga') return this.cga.owns(port) ? this.cga.read(port) : 0xff;
      if (this.model.video === 'mcga') return this.mcga.owns(port) ? this.mcga.read(port) : 0xff;
      return this.vga.read(port);
    }
    if (this.uart.owns(port)) return this.uart.read(port);
    return 0xff;
  }

  out8(port: number, value: number): void {
    port &= 0xffff;
    this.cpu.cycles += this.model.ioWait;
    this.cpu.waitCycles += this.model.ioWait;
    if (port < 0x10 || (port >= 0xc0 && port < 0xe0) || (port >= 0x80 && port < 0x90)) {
      this.dma.write(port, value);
      return;
    }
    if (this.hasPpi && port >= 0x60 && port <= 0x63) {
      this.syncDevices();
      this.ppi.write(port, value);
      return;
    }
    if (this.hasGateArray && this.gateArray.owns(port)) {
      this.syncDevices();
      this.gateArray.write(port, value);
      if (port === 0x65) this.applyPlanarEnables();
      else if (port === 0x6b) this.updateRamMap();
      return;
    }
    if (this.model.cmos === 'mm58167' && this.clock.owns(port)) {
      this.syncDevices();
      this.clock.write(port, value);
      return;
    }
    if (this.is8086 && (port === 0x64 || port === 0xa0 || port === 0xa1 || port === 0x70 || port === 0x71)) {
      if (port === 0xa0) this.nmiMask = value;
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
        this.setPortB(value);
        return;
      case 0x70:
      case 0x71:
        this.syncDevices();
        this.rtc.write(port, value);
        return;
      case 0x92: {
        if (this.model.port92 === 'none') return;
        const reset = this.model.port92 === 'ps2' && value & 1 && !(this.port92 & 1);
        this.port92 = this.model.port92 === 'ps2' ? value & 0x03 : value;
        this.updateA20();
        if (reset) this.resetCpu();
        return;
      }
      case 0x94:
        if (this.hasSetupRegisters) this.setup[1] = value;
        return;
      case 0x102:
        if (!this.hasSetupRegisters || this.setup[1] & 0x80) return;
        this.setup[2] = value;
        this.uart.enabled = (value & 0x04) !== 0;
        this.uart.base = value & 0x08 ? 0x3f8 : 0x2f8;
        this.lptBase = value & 0x10 ? [0x3bc, 0x378, 0x278, 0x3bc][(value >> 5) & 3] : -16;
        return;
      case 0x103:
      case 0x104:
      case 0x105:
        if (this.hasSetupRegisters && !(this.setup[1] & 0x80)) this.setup[port - 0x100] = value;
        return;
      case 0x190:
        if (this.hasSetupRegisters) this.setup[6] = value;
        return;
    }
    if (port >= 0x3f0 && port <= 0x3f7 && port !== 0x3f6) {
      this.syncDevices();
      this.fdc.write(port, value);
      return;
    }
    if (this.model.fdc === 'at' && this.hdc.owns(port)) {
      this.hdc.write(port, value);
      return;
    }
    if (port >= this.lptBase && port < this.lptBase + 3) {
      this.lpt[port - this.lptBase] = value;
      return;
    }
    if (port >= 0x3b0 && port <= 0x3df) {
      this.syncDevices();
      if (this.model.video === 'cga') {
        if (this.cga.owns(port)) this.cga.write(port, value);
      } else if (this.model.video === 'mcga') {
        if (this.mcga.owns(port)) this.mcga.write(port, value);
      } else {
        this.vga.write(port, value);
      }
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
    const seconds = elapsed / this.cpuHz;
    this.pitFraction += (elapsed * PIT_HZ) / this.cpuHz;
    const ticks = Math.floor(this.pitFraction);
    this.pitFraction -= ticks;
    if (ticks > 0) this.pit.advance(ticks);
    if (this.hasPpi) this.refreshMemory(ticks);
    this.speaker.advanceTo(this.pit.ticks);
    this.refreshTime = (this.refreshTime + seconds) % 1;
    this.video.advance(seconds);
    if (this.model.cmos === 'mm58167') this.clock.advance(seconds);
    else this.rtc.advance(seconds);
    this.fdc.advance(seconds);
    if (this.hasPpi) this.ppi.advance(seconds);
    else if (this.hasGateArray) this.gateArray.advance(seconds);
    else this.kbc.advance(seconds);
  }

  /** The gate array's port 65h: MCGA and the serial port can be switched off. */
  private applyPlanarEnables(): void {
    const enables = this.gateArray.port65;
    this.mcga.enabled = (enables & 0x04) !== 0;
    this.uart.enabled = (enables & 0x10) !== 0;
    this.uart.base = 0x3f8;
    this.lptBase = enables & 0x02 ? 0x378 : -16;
  }

  /** On the PC and XT, each period of timer 1 asks DMA channel 0 for a refresh cycle. */
  private refreshMemory(ticks: number): void {
    const timer = this.pit.counters[1];
    if (!timer.running) {
      this.refreshTicks = 0;
      return;
    }
    this.refreshTicks += ticks;
    const transfers = Math.floor(this.refreshTicks / timer.reload);
    this.refreshTicks -= transfers * timer.reload;
    this.dma.refresh(transfers);
  }

  /** Runs for `cycles` CPU clocks. */
  run(cycles: number): void {
    const cpu = this.cpu;
    const end = cpu.cycles + cycles;
    while (cpu.cycles < end) {
      const sliceEnd = Math.min(end, cpu.cycles + SLICE_CYCLES);
      while (cpu.cycles < sliceEnd) {
        if (this.nmiPending) {
          this.nmiPending = false;
          cpu.nmi();
        }
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
    if (ranFromRam || cpu.cycles - this.startedAt > MAX_START_SECONDS * this.cpuHz) this.starting = false;
  }

  /** Runs until the VGA finishes its next picture (or a tenth of a second passes with the display off). */
  runFrame(): void {
    const video = this.video;
    const target = video.frames + 1;
    const limit = this.cpu.cycles + this.cpuHz / 10;
    while (video.frames < target && this.cpu.cycles < limit) this.run(SLICE_CYCLES * 4);
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
