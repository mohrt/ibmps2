import { defaultAtCmos, defaultCmos } from './chips/cmos-defaults';
import type { DriveKind } from './chips/fdc';
import type { BlankFormat } from './drive/floppy-image';

/** The machines the emulator can be. */
export type ModelId = 'm30-286' | 'm25-286' | 'm30' | 'm25' | 'ps1-2011' | 'pc-at' | 'pc-xt' | 'pc';

/** The battery-backed clock: the PS/2's or AT's MC146818 CMOS, the Model 30's MM58167, or none. */
export type CmosKind = 'ps2' | 'at' | 'mm58167' | 'none';

export interface ModelSpec {
  id: ModelId;
  name: string;
  year: number;
  /** The CPU: an 80286, an 8086, or an 8088 (the 8086 with an 8-bit bus). */
  cpu: '286' | '8086' | '8088';
  /** The CPU's clock. */
  cpuHz: number;
  /** How much longer instructions take than the 286's counts (the 8088's slower bus and address arithmetic). */
  cycleScale: number;
  /** CPU cycles an I/O port access adds for the bus's wait states. */
  ioWait: number;
  /** Memory sizes offered, in KB (640K of base memory, the rest extended from 1 MB). */
  memoryChoices: number[];
  defaultMemory: number;
  /** How port 92h behaves: the PS/2's fast A20 gate and reset, the PS/1 2011's A20 gate alone. */
  port92: 'ps2' | 'a20' | 'none';
  cmos: CmosKind;
  /** The CMOS byte the BIOS loads into port 102h (the planar's serial and parallel ports). */
  setupByte: number | null;
  video: 'vga' | 'mcga' | 'cga';
  /** The 8042's firmware (IBM's PS/2 one with the mouse port, or the AT's), the PC's and XT's 8255, or the Model 25 and 30's gate array. */
  keyboard: 'ps2' | 'at' | 'xt' | 'pc' | 'gate-array';
  fdc: 'ps2' | 'at' | 'xt';
  /** The floppy drives: A:, and B: when fitted. */
  drives: [DriveKind, DriveKind];
  /** Extra ROMs the machine needs, by library name (the CGA's character ROM). */
  extraRoms: string[];
  /** Shown in Machine setup. */
  romHint: string;
}

const PS2_286: Omit<ModelSpec, 'id' | 'name' | 'year'> = {
  cpu: '286',
  cpuHz: 10_000_000,
  cycleScale: 1,
  ioWait: 0,
  memoryChoices: [1024, 2048, 4096],
  defaultMemory: 2048,
  port92: 'ps2',
  cmos: 'ps2',
  setupByte: 0x31,
  video: 'vga',
  keyboard: 'ps2',
  fdc: 'ps2',
  drives: ['3.5-hd', '3.5-hd'],
  extraRoms: [],
  romHint: 'The 128 KB ROM of the PS/2 Model 30 286 (which the Model 25 286 shares): 33f5381a.bin (revision 2) or 27F4092.BIN (revision 0).',
};

export const MODELS: ModelSpec[] = [
  { id: 'm30-286', name: 'IBM PS/2 Model 30 286', year: 1988, ...PS2_286 },
  { id: 'm25-286', name: 'IBM PS/2 Model 25 286', year: 1990, ...PS2_286 },
  {
    id: 'm30',
    name: 'IBM PS/2 Model 30',
    year: 1987,
    ...ps2_8086(),
    cmos: 'mm58167',
    memoryChoices: [640],
    romHint: 'The Model 30\u2019s two 32 KB BIOS chips of January 1989 (revision 4): 33F4498 and 33F4499.',
  },
  {
    id: 'm25',
    name: 'IBM PS/2 Model 25',
    year: 1987,
    ...ps2_8086(),
    memoryChoices: [512, 640],
    romHint: 'The Model 25\u2019s two 32 KB BIOS chips: 00F2122 and 00F2123.',
  },
  {
    id: 'ps1-2011',
    name: 'IBM PS/1 (Model 2011)',
    year: 1990,
    cpu: '286',
    cpuHz: 10_000_000,
    cycleScale: 1,
    ioWait: 0,
    memoryChoices: [512, 1024, 2560],
    defaultMemory: 1024,
    port92: 'a20',
    cmos: 'ps2',
    setupByte: 0x31,
    video: 'vga',
    keyboard: 'ps2',
    fdc: 'ps2',
    drives: ['3.5-hd', '3.5-hd'],
    extraRoms: [],
    romHint:
      'The PS/1 2011\u2019s ROM, which holds DOS 4.01 and its menu as well as the BIOS: FC0000_US.BIN (256 KB, US English), or a language\u2019s F80000 and FC0000 halves, or one 512 KB file.',
  },
  {
    id: 'pc-at',
    name: 'IBM PC/AT (5170)',
    year: 1984,
    cpu: '286',
    cpuHz: 8_000_000,
    cycleScale: 1,
    // The 8 MHz ISA bus with its wait states (the BIOS times its refresh test by it).
    ioWait: 12,
    memoryChoices: [640, 1024, 2048, 4096],
    defaultMemory: 640,
    port92: 'none',
    cmos: 'at',
    setupByte: null,
    video: 'cga',
    keyboard: 'at',
    fdc: 'at',
    drives: ['5.25-hd', '5.25-dd'],
    extraRoms: ['cga-font'],
    romHint:
      'The AT\u2019s two BIOS chips (U27 and U47, 32 KB each), from November 1985 or January 1984, and the 8 KB MDA/CGA character ROM (mda.rom) for its colour card.',
  },
  {
    id: 'pc-xt',
    name: 'IBM PC/XT (5160)',
    year: 1983,
    ...pc8088(),
    keyboard: 'xt',
    romHint:
      'The XT\u2019s two ROM chips from November 1982: the 32 KB BIOS and BASIC (U18, 1501512) and the 8 KB rest of BASIC (U19, 5000027), and the 8 KB MDA/CGA character ROM (mda.rom) for its colour card.',
  },
  {
    id: 'pc',
    name: 'IBM PC (5150)',
    year: 1981,
    ...pc8088(),
    keyboard: 'pc',
    romHint:
      'The PC\u2019s 8 KB BIOS of October 1982 (U33) and its 32 KB Cassette BASIC 1.10 (ibm-basic-1.10.rom), and the 8 KB MDA/CGA character ROM (mda.rom) for its colour card.',
  },
];

/** What the 8086 Model 25 and 30 share: MCGA, the gate array and 720 KB drives. */
function ps2_8086(): Omit<ModelSpec, 'id' | 'name' | 'year' | 'memoryChoices' | 'romHint'> {
  return {
    cpu: '8086',
    cpuHz: 8_000_000,
    cycleScale: 1.5,
    ioWait: 2,
    defaultMemory: 640,
    port92: 'none',
    cmos: 'none',
    setupByte: null,
    video: 'mcga',
    keyboard: 'gate-array',
    fdc: 'ps2',
    drives: ['3.5-dd', '3.5-dd'],
    extraRoms: [],
  };
}

/** What the PC and PC/XT share: a 4.77 MHz 8088, up to 640K, CGA and 360 KB drives. */
function pc8088(): Omit<ModelSpec, 'id' | 'name' | 'year' | 'keyboard' | 'romHint'> {
  return {
    cpu: '8088',
    cpuHz: 4_772_727,
    cycleScale: 2,
    ioWait: 4,
    memoryChoices: [256, 512, 640],
    defaultMemory: 640,
    port92: 'none',
    cmos: 'none',
    setupByte: null,
    video: 'cga',
    fdc: 'xt',
    drives: ['5.25-dd', '5.25-dd'],
    extraRoms: ['cga-font'],
  };
}

export function modelSpec(id: string | undefined): ModelSpec {
  return MODELS.find((model) => model.id === id) ?? MODELS[0];
}

/** Whether the machine has a PS/2 mouse port (on its 8042, or the Model 25 and 30's gate array). */
export function hasMousePort(model: ModelSpec): boolean {
  return model.keyboard === 'ps2' || model.keyboard === 'gate-array';
}

/** The size of blank disk a drive formats: its own capacity. */
export function blankFormatFor(drive: DriveKind): BlankFormat {
  return ({ '3.5-hd': '1.44 MB', '3.5-dd': '720 KB', '5.25-hd': '1.2 MB', '5.25-dd': '360 KB' } as const)[drive];
}

/** Memory as the setup shows it: 640 KB, 1 MB, 2.5 MB. */
export function memoryLabel(kilobytes: number): string {
  return kilobytes < 1024 ? `${kilobytes} KB` : `${kilobytes / 1024} MB`;
}

/** A newly set up CMOS for the machine (null for those without one, or that set their own up, like the Model 30). */
export function freshCmos(model: ModelSpec, kilobytes: number, secondDrive: boolean): Uint8Array | null {
  const drives = secondDrive ? model.drives : [model.drives[0]];
  if (model.cmos === 'at') return defaultAtCmos(kilobytes, drives);
  if (model.cmos === 'ps2') return defaultCmos(kilobytes, secondDrive ? 2 : 1);
  return null;
}
