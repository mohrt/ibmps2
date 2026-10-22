import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FloppyImage, formattedDisk, geometryForSize } from '../src/drive/floppy-image';
import { RomLibrary, type StoredRom } from '../src/roms/rom-library';
import { changedSectors } from '../src/storage/disk-saves';
import { MemoryStore } from '../src/storage/store';
import { ROMS, hasRom } from './helpers/machine';

describe('floppy images', () => {
  it('know the PC formats by size', () => {
    expect(geometryForSize(1474560)?.label).toBe('1.44 MB');
    expect(geometryForSize(737280)?.highDensity).toBe(false);
    expect(geometryForSize(368640)?.cylinders).toBe(40);
    expect(geometryForSize(1234)).toBeNull();
    expect(() => new FloppyImage(new Uint8Array(1000), 'odd.img')).toThrow(/isn't a PC floppy image/);
  });

  it('make blank disks DOS can use', () => {
    const disk = formattedDisk();
    const view = new DataView(disk.buffer);
    expect(view.getUint16(11, true)).toBe(512);
    expect(view.getUint16(19, true)).toBe(2880);
    expect(disk[21]).toBe(0xf0);
    expect([disk[510], disk[511]]).toEqual([0x55, 0xaa]);
    expect([...disk.subarray(512, 515)]).toEqual([0xf0, 0xff, 0xff]);
    expect(new FloppyImage(disk, 'blank').offset(79, 1, 18)).toBe(disk.length - 512);
  });

  it('make blank disks in the smaller sizes too', () => {
    const disk = formattedDisk('360 KB');
    const view = new DataView(disk.buffer);
    expect(new FloppyImage(disk, 'blank').geometry.label).toBe('360 KB');
    expect(view.getUint16(19, true)).toBe(720);
    expect(disk[21]).toBe(0xfd);
    // The second FAT follows the first's two sectors.
    expect([...disk.subarray(3 * 512, 3 * 512 + 3)]).toEqual([0xfd, 0xff, 0xff]);
  });

  it('find the sectors a program changed', () => {
    const original = formattedDisk();
    const current = original.slice();
    current[512 * 20 + 3] ^= 1;
    expect(Object.keys(changedSectors(original, current))).toEqual(['20']);
  });
});

/** A made-up ROM that ends with the reset jump a PC BIOS has. */
function fakeBios(size = 0x20000, fill = 0x90): Uint8Array {
  const rom = new Uint8Array(size).fill(fill);
  rom.set([0xea, 0x5b, 0xe0, 0x00, 0xf0], size - 16);
  return rom;
}

describe('the ROM library', () => {
  it('takes another BIOS of the right size with a warning, and turns away other files', async () => {
    const library = new RomLibrary(new MemoryStore());
    const problems = await library.add(
      [
        { name: 'other.bin', data: fakeBios() },
        { name: 'small.bin', data: new Uint8Array(0x8000) },
      ],
      'm30-286',
    );
    expect(problems).toEqual(["small.bin isn't a ROM for this machine."]);
    expect((await library.assemble('m30-286'))?.warning).toMatch(/may not start/);
    expect(await library.assemble('pc-at')).toBeNull();
  });

  it("doesn't guess which of a collection's BIOSes is meant", async () => {
    const library = new RomLibrary(new MemoryStore());
    const problems = await library.add(
      [
        { name: 'a/bios.bin', data: fakeBios(0x10000, 1) },
        { name: 'b/bios.bin', data: fakeBios(0x10000, 2) },
      ],
      'pc-xt',
    );
    expect(problems[0]).toMatch(/add just the one/);
    expect(await library.assemble('pc-xt')).toBeNull();
  });

  it('keeps the BIOS that earlier versions stored', async () => {
    const store = new MemoryStore<StoredRom>();
    await store.put('bios', { name: 'mine.bin', data: fakeBios() });
    const library = new RomLibrary(store);
    await library.adoptEarlierRoms();
    expect((await library.assemble('m30-286'))?.sources).toEqual(['mine.bin']);
    expect((await store.entries()).map(([key]) => key)).toEqual(['custom-m30-286']);
  });

  it.skipIf(!hasRom(ROMS.rev2) || !hasRom(ROMS.rev0))("prefers the newer of IBM's two Model 30 286 BIOSes", async () => {
    const library = new RomLibrary(new MemoryStore());
    await library.add(
      [ROMS.rev0, ROMS.rev2].map((path) => ({ name: path, data: new Uint8Array(readFileSync(path)) })),
      'm30-286',
    );
    const rom = await library.assemble('m30-286');
    expect(rom?.warning).toBeNull();
    expect(rom?.title).toMatch(/revision 2/);
    expect((await library.assemble('m25-286'))?.title).toMatch(/revision 2/);
  });

  it.skipIf(!hasRom(ROMS.rev2))('puts the BIOS back together from its two chips, and trims overdumps', async () => {
    const rom = new Uint8Array(readFileSync(ROMS.rev2));
    const halves = new RomLibrary(new MemoryStore());
    await halves.add(
      [
        { name: 'even.bin', data: rom.filter((_, i) => i % 2 === 0) },
        { name: 'odd.bin', data: rom.filter((_, i) => i % 2 === 1) },
      ],
      'm30-286',
    );
    expect((await halves.assemble('m30-286'))?.image).toEqual(rom);
    const doubled = new Uint8Array(rom.length * 2);
    doubled.set(rom);
    doubled.set(rom, rom.length);
    const over = new RomLibrary(new MemoryStore());
    expect(await over.add([{ name: 'over.bin', data: doubled }], 'm30-286')).toEqual([]);
    expect((await over.assemble('m30-286'))?.warning).toBeNull();
  });
});
