import type { KeyValueStore } from '../storage/store';
import { crc32 } from '../util/crc32';

/** A ROM file the user gave. */
export interface StoredRom {
  name: string;
  data: Uint8Array;
}

/** How one ROM chip's dump goes into a machine's ROM image. */
interface Placement {
  crc: number;
  /** Byte offset in the image (or, interleaved, of the chip's first byte). */
  at: number;
  /** Interleaved with another chip: this one holds the even (0) or odd (1) bytes. */
  lane?: 0 | 1;
  /** Copies of the chip, one after another (the XT's BASIC chip fills its 32K four times). */
  repeat?: number;
}

/** One complete set of a machine's ROMs. */
interface RomSet {
  title: string;
  size: number;
  parts: Placement[];
}

/**
 * IBM's ROMs for each machine, by CRC-32 of the chip dumps, newest first.
 * Images are laid out to end at the top of the address space (FFFFFh, and FFFFFFh on a 286).
 */
const SETS: Record<string, RomSet[]> = {
  'm30-286': [
    { title: 'PS/2 Model 30 286 BIOS, revision 2 (33F5381A)', size: 0x20000, parts: [{ crc: 0xff57057d, at: 0 }] },
    {
      title: 'PS/2 Model 30 286 BIOS, revision 2 (33F5381A)',
      size: 0x20000,
      parts: [
        { crc: 0xcbab4a96, at: 0, lane: 0 },
        { crc: 0x07511635, at: 0, lane: 1 },
      ],
    },
    { title: 'PS/2 Model 30 286 BIOS, revision 0 (27F4092)', size: 0x20000, parts: [{ crc: 0x70d95a04, at: 0 }] },
    {
      title: 'PS/2 Model 30 286 BIOS, revision 0 (27F4092)',
      size: 0x20000,
      parts: [
        { crc: 0x9965a634, at: 0, lane: 0 },
        { crc: 0x1448d3cb, at: 0, lane: 1 },
      ],
    },
  ],
  'ps1-2011': [
    { title: 'PS/1 2011 ROM, US English (FC0000)', size: 0x40000, parts: [{ crc: 0x904648b4, at: 0 }] },
    {
      title: 'PS/1 2011 ROM, UK English',
      size: 0x80000,
      parts: [
        { crc: 0x64ecf2fe, at: 0 },
        { crc: 0xef7aa453, at: 0x40000 },
      ],
    },
  ],
  'pc-at': [
    {
      title: 'PC/AT BIOS of 15 November 1985',
      size: 0x10000,
      parts: [
        { crc: 0xe9cc3761, at: 0, lane: 0 },
        { crc: 0xb5978ccb, at: 0, lane: 1 },
      ],
    },
    {
      title: 'PC/AT BIOS of 10 January 1984',
      size: 0x10000,
      parts: [
        { crc: 0xf6573f2a, at: 0, lane: 0 },
        { crc: 0x7075fbb2, at: 0, lane: 1 },
      ],
    },
  ],
  'pc-xt': [
    {
      title: 'PC/XT BIOS of 8 November 1982',
      size: 0x10000,
      parts: [
        { crc: 0x80d3cf5d, at: 0, repeat: 4 },
        { crc: 0x79522c3d, at: 0x8000 },
      ],
    },
  ],
  pc: [
    {
      title: 'PC BIOS of 27 October 1982, with Cassette BASIC 1.10',
      size: 0x10000,
      parts: [
        { crc: 0xebacb791, at: 0x6000 },
        { crc: 0xe88792b3, at: 0xe000 },
      ],
    },
  ],
  m30: [
    {
      title: 'PS/2 Model 30 BIOS, revision 4 (33F4498/33F4499)',
      size: 0x10000,
      parts: [
        { crc: 0xf85c8482, at: 0, lane: 0 },
        { crc: 0x6e94043c, at: 0, lane: 1 },
      ],
    },
  ],
  m25: [
    {
      title: 'PS/2 Model 25 BIOS (00F2122/00F2123)',
      size: 0x10000,
      parts: [
        { crc: 0x021f7a96, at: 0, lane: 0 },
        { crc: 0x43db597f, at: 0, lane: 1 },
      ],
    },
  ],
  'cga-font': [{ title: 'MDA/CGA character ROM', size: 0x2000, parts: [{ crc: 0x0bf56d70, at: 0 }] }],
};
SETS['m25-286'] = SETS['m30-286'];

const KNOWN = new Map<number, number>();
for (const sets of Object.values(SETS)) for (const set of sets) for (const part of set.parts) KNOWN.set(part.crc, 0);

/** The sizes of file worth looking at in a ROM collection: every chip and image above. */
export const ROM_SIZES = new Set([0x2000, 0x8000, 0x10000, 0x20000, 0x40000, 0x80000]);

const baseName = (name: string) => name.split('/').pop()!;

/** A file holding a ROM twice over (an overdump from a bigger chip) is that ROM. */
function trimOverdump(data: Uint8Array): Uint8Array {
  const half = data.length / 2;
  if (!ROM_SIZES.has(half)) return data;
  for (let i = 0; i < half; i++) if (data[i] !== data[i + half]) return data;
  return data.slice(0, half);
}

/** A machine's ROM image, put together from the user's files. */
export interface AssembledRom {
  title: string;
  image: Uint8Array;
  /** Set when the ROM isn't one IBM made for this machine. */
  warning: string | null;
  /** The files it came from. */
  sources: string[];
}

function build(set: RomSet, parts: Map<number, StoredRom>): AssembledRom | null {
  if (!set.parts.every((part) => parts.has(part.crc))) return null;
  const image = new Uint8Array(set.size).fill(0xff);
  for (const part of set.parts) {
    const data = parts.get(part.crc)!.data;
    if (part.lane !== undefined) {
      for (let i = 0; i < data.length; i++) image[part.at + i * 2 + part.lane] = data[i];
    } else {
      for (let copy = 0; copy < (part.repeat ?? 1); copy++) image.set(data, part.at + copy * data.length);
    }
  }
  return { title: set.title, image, warning: null, sources: set.parts.map((part) => parts.get(part.crc)!.name) };
}

/** A PC BIOS ends with a far jump at FFFF0h, the first instruction after reset. */
const hasResetJump = (data: Uint8Array) => data.length >= 16 && data[data.length - 16] === 0xea;

/** The ROM sizes a machine's own (not IBM's) BIOS can be. */
const CUSTOM_SIZES: Record<string, number[]> = {
  'm30-286': [0x20000],
  'm25-286': [0x20000],
  'ps1-2011': [0x40000, 0x80000],
  'pc-at': [0x10000],
  'pc-xt': [0x10000],
  pc: [0x10000],
  m30: [0x10000],
  m25: [0x10000],
};

const PART_PREFIX = 'part-';
const CUSTOM_PREFIX = 'custom-';

/**
 * The user's ROMs, kept in browser storage (IndexedDB) so they only have to
 * be given once: IBM's chips by CRC, from which each machine's image is put
 * together, and a BIOS of the user's own per machine.
 */
export class RomLibrary {
  constructor(private readonly store: KeyValueStore<StoredRom>) {}

  /**
   * Keeps the ROMs among `files`: every one of IBM's chips (for any machine),
   * and a file that is the right size and ends like a BIOS as `model`'s own.
   * Returns what wasn't usable.
   */
  async add(files: StoredRom[], model: string): Promise<string[]> {
    const problems: string[] = [];
    const bioses: StoredRom[] = [];
    void globalThis.navigator?.storage?.persist?.().catch(() => false);
    for (const given of files) {
      const data = trimOverdump(given.data);
      const file = data === given.data ? given : { name: given.name, data };
      const crc = crc32(data);
      if (KNOWN.has(crc)) await this.store.put(`${PART_PREFIX}${crc.toString(16)}`, file);
      else if (CUSTOM_SIZES[model]?.includes(file.data.length) && hasResetJump(file.data)) bioses.push(file);
      else problems.push(`${baseName(file.name)} isn't a ROM for this machine.`);
    }
    // A collection holds many machines' BIOSes: only one on its own can be meant for this machine.
    if (bioses.length === 1) await this.store.put(`${CUSTOM_PREFIX}${model}`, bioses[0]);
    else if (bioses.length > 1) problems.push(`${bioses.length} of the files could be this machine's BIOS; add just the one to use.`);
    return problems;
  }

  /** Earlier versions kept the Model 30 286 BIOS (and others from its collection) under other names. */
  async adoptEarlierRoms(): Promise<void> {
    for (const [key, rom] of await this.store.entries()) {
      if (key.startsWith(PART_PREFIX) || key.startsWith(CUSTOM_PREFIX)) continue;
      await this.store.delete(key);
      if (key === 'bios' || KNOWN.has(crc32(rom.data))) await this.add([rom], 'm30-286');
    }
  }

  private async parts(): Promise<Map<number, StoredRom>> {
    const parts = new Map<number, StoredRom>();
    for (const [key, rom] of await this.store.entries()) {
      if (key.startsWith(PART_PREFIX)) parts.set(parseInt(key.slice(PART_PREFIX.length), 16), rom);
    }
    return parts;
  }

  /** The ROM image for a machine (or a part like the CGA font), from IBM's chips first. */
  async assemble(model: string): Promise<AssembledRom | null> {
    const parts = await this.parts();
    for (const set of SETS[model] ?? []) {
      const rom = build(set, parts);
      if (rom) return rom;
    }
    const custom = await this.store.get(`${CUSTOM_PREFIX}${model}`);
    if (!custom) return null;
    return {
      title: 'BIOS',
      image: custom.data,
      warning: `${baseName(custom.name)} isn't one of IBM's ROMs for this machine; it may not start`,
      sources: [custom.name],
    };
  }

  /** The machines (and parts) whose ROMs are all here. */
  async available(): Promise<Set<string>> {
    const ready = new Set<string>();
    for (const model of Object.keys({ ...SETS, ...CUSTOM_SIZES })) if (await this.assemble(model)) ready.add(model);
    return ready;
  }

  /** Forgets every ROM. */
  async forget(): Promise<void> {
    for (const [key] of await this.store.entries()) await this.store.delete(key);
  }
}
