import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FloppyImage, formattedDisk, geometryForSize } from '../src/drive/floppy-image';
import { BIOS_BYTES, identifyBios, joinSplitBios, rankBioses } from '../src/roms/system-roms';
import { changedSectors } from '../src/storage/disk-saves';
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

  it('find the sectors a program changed', () => {
    const original = formattedDisk();
    const current = original.slice();
    current[512 * 20 + 3] ^= 1;
    expect(Object.keys(changedSectors(original, current))).toEqual(['20']);
  });
});

/** A made-up 128K ROM that ends with the reset jump a PC BIOS has. */
function fakeBios(): Uint8Array {
  const rom = new Uint8Array(BIOS_BYTES).fill(0x90);
  rom.set([0xea, 0x5b, 0xe0, 0x00, 0xf0], BIOS_BYTES - 16);
  return rom;
}

describe('BIOS ROMs', () => {
  it('accept other PC BIOSes with a warning, and turn away other files', () => {
    const rom = identifyBios('other.bin', fakeBios());
    expect(rom.warning).toMatch(/may not start/);
    expect(() => identifyBios('small.bin', new Uint8Array(0x8000))).toThrow(/131,072-byte/);
    expect(() => identifyBios('data.bin', new Uint8Array(BIOS_BYTES))).toThrow(/doesn't end like a PC BIOS/);
  });

  it('put a ROM dumped from its two chips back together, and trim overdumps', () => {
    const rom = fakeBios();
    const even = rom.filter((_, i) => i % 2 === 0);
    const odd = rom.filter((_, i) => i % 2 === 1);
    expect(joinSplitBios(odd, even)).toEqual(rom);
    const doubled = new Uint8Array(BIOS_BYTES * 2);
    doubled.set(rom);
    doubled.set(rom, BIOS_BYTES);
    expect(identifyBios('over.bin', doubled).data.length).toBe(BIOS_BYTES);
  });

  it.skipIf(!hasRom(ROMS.rev2) || !hasRom(ROMS.rev0))("know IBM's two Model 30 286 BIOSes, newest first", () => {
    const roms = [ROMS.rev0, ROMS.rev2].map((path) => identifyBios(path, new Uint8Array(readFileSync(path))));
    expect(roms.every((rom) => rom.warning === null)).toBe(true);
    expect(rankBioses(roms)[0].title).toMatch(/revision 2/);
  });
});
