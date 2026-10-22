import type { KeyValueStore } from '../storage/store';
import { crc32 } from '../util/crc32';

export const BIOS_BYTES = 0x20000;
const HALF = BIOS_BYTES / 2;

/** CRC-32s of IBM's BIOSes for the PS/2 Model 30 286. */
const KNOWN_BIOSES: Record<number, string> = {
  0x70d95a04: 'PS/2 Model 30 286 BIOS, revision 0 (27F4092)',
  0xff57057d: 'PS/2 Model 30 286 BIOS, revision 2 (33F5381A)',
};

/** The newest first, for picking one from a collection. */
const PREFERRED = [0xff57057d, 0x70d95a04];

export interface StoredRom {
  /** The file it came from, shown to the user. */
  name: string;
  data: Uint8Array;
}

export interface Bios extends StoredRom {
  title: string;
  /** Set when the ROM isn't one of IBM's Model 30 286 BIOSes. */
  warning: string | null;
}

/** A PC BIOS ends with a far jump at FFFF0h, the first instruction after reset. */
function hasResetJump(data: Uint8Array): boolean {
  return data.length === BIOS_BYTES && data[BIOS_BYTES - 16] === 0xea;
}

/** A 256K file holding the 128K ROM twice (an overdump) is the 128K ROM. */
function trimOverdump(data: Uint8Array): Uint8Array {
  if (data.length !== BIOS_BYTES * 2) return data;
  for (let i = 0; i < BIOS_BYTES; i++) if (data[i] !== data[i + BIOS_BYTES]) return data;
  return data.slice(0, BIOS_BYTES);
}

/** Works out whether a file is a BIOS the Model 30 286 can start; throws if it isn't one. */
export function identifyBios(name: string, file: Uint8Array): Bios {
  const data = trimOverdump(file);
  if (data.length !== BIOS_BYTES) {
    throw new Error(
      `${name} is ${data.length.toLocaleString('en')} bytes, which isn't a Model 30 286 BIOS. ` +
        `It is one 131,072-byte ROM (often named 33f5381a.bin or 27F4092.BIN), or two 65,536-byte halves.`,
    );
  }
  const crc = crc32(data);
  const known = KNOWN_BIOSES[crc];
  if (known) return { name, data, title: known, warning: null };
  if (!hasResetJump(data)) throw new Error(`${name} is the size of the BIOS but doesn't end like a PC BIOS. Check it is a ROM image.`);
  return { name, data, title: 'PC BIOS', warning: "not one of IBM's Model 30 286 BIOSes; it may not start" };
}

/** Whether a file is half of a BIOS dumped from its two chips (even and odd bytes). */
export function isHalfBios(data: Uint8Array): boolean {
  return data.length === HALF;
}

/** Two halves of the BIOS dumped from its chips, put back together; null if they don't make a BIOS either way round. */
export function joinSplitBios(first: Uint8Array, second: Uint8Array): Uint8Array | null {
  if (first.length !== HALF || second.length !== HALF) return null;
  for (const [even, odd] of [
    [first, second],
    [second, first],
  ]) {
    const joined = new Uint8Array(BIOS_BYTES);
    for (let i = 0; i < HALF; i++) {
      joined[i * 2] = even[i];
      joined[i * 2 + 1] = odd[i];
    }
    if (KNOWN_BIOSES[crc32(joined)] || hasResetJump(joined)) return joined;
  }
  return null;
}

/** Several BIOSes (a collection's) best first, each once: IBM's own Model 30 286 ones if there are any. */
export function rankBioses(roms: Bios[]): Bios[] {
  const unique = new Map<number, Bios>();
  for (const rom of roms) {
    const crc = crc32(rom.data);
    if (!unique.has(crc)) unique.set(crc, rom);
  }
  const rank = (rom: Bios) => {
    const at = PREFERRED.indexOf(crc32(rom.data));
    return at >= 0 ? at : PREFERRED.length;
  };
  const all = [...unique.values()];
  const originals = all.filter((rom) => rank(rom) < PREFERRED.length);
  return (originals.length ? originals : all).sort((a, b) => rank(a) - rank(b));
}

const BIOS_KEY = 'bios';
const CHOICE_PREFIX = 'choice-';

/**
 * The user's BIOS, kept in browser storage (IndexedDB) so it only has to be
 * given once. Saving asks the browser to make the storage persistent.
 */
export class SystemRomStore {
  constructor(private readonly store: KeyValueStore<StoredRom>) {}

  async load(): Promise<Bios | null> {
    const stored = await this.store.get(BIOS_KEY);
    if (!stored) return null;
    try {
      return identifyBios(stored.name, stored.data);
    } catch {
      return null;
    }
  }

  save(rom: Bios): Promise<void> {
    void globalThis.navigator?.storage?.persist?.().catch(() => false);
    return this.store.put(BIOS_KEY, { name: rom.name, data: rom.data });
  }

  /** The other BIOSes that came with it (from a collection), offered to switch to. */
  async loadChoices(): Promise<Bios[]> {
    const choices: Bios[] = [];
    for (const [key, stored] of await this.store.entries()) {
      if (!key.startsWith(CHOICE_PREFIX)) continue;
      try {
        choices.push(identifyBios(stored.name, stored.data));
      } catch {
        // A ROM that no longer identifies is left out.
      }
    }
    return rankBioses(choices);
  }

  async saveChoices(roms: Bios[]): Promise<void> {
    await this.forgetChoices();
    for (const rom of roms) await this.store.put(`${CHOICE_PREFIX}${crc32(rom.data).toString(16)}`, { name: rom.name, data: rom.data });
  }

  private async forgetChoices(): Promise<void> {
    for (const [key] of await this.store.entries()) if (key.startsWith(CHOICE_PREFIX)) await this.store.delete(key);
  }

  async forget(): Promise<void> {
    await this.store.delete(BIOS_KEY);
    await this.forgetChoices();
  }
}
