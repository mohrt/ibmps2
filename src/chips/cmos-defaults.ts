const rol16 = (value: number, count: number) => ((value << count) | (value >>> (16 - count))) & 0xffff;
const ror16 = (value: number, count: number) => ((value >>> count) | (value << (16 - count))) & 0xffff;

/**
 * The CRC IBM's BIOS keeps over CMOS bytes 10h-33h, as its POST computes
 * it (AH carries over from byte to byte). A CMOS is valid when the CRC over
 * the whole range, the two CRC bytes at 32h-33h included, comes to zero.
 */
export function ps2CmosCrc(ram: Uint8Array): number {
  let dx = 0xffff;
  let ax = 0;
  for (let index = 0x10; index < 0x34; index++) {
    ax = (ax & 0xff00) | ram[index];
    dx ^= (ax & 0xff) << 8;
    ax = (ax & 0xff00) | (dx >> 8);
    ax = rol16(ax, 4);
    dx ^= ax;
    ax = rol16(ax, 1);
    dx = ((dx & 0xff) << 8) | (dx >> 8);
    dx ^= ax;
    ax = ror16(ax, 4);
    ax &= 0xffe0;
    dx ^= ax;
    ax = ror16(ax, 1);
    dx ^= (ax & 0xff) << 8;
  }
  return dx;
}

/** Stores the CRC bytes that make the CMOS valid. */
export function storeCrc(ram: Uint8Array): void {
  for (let value = 0; value < 0x10000; value++) {
    ram[0x32] = value >> 8;
    ram[0x33] = value & 0xff;
    if (ps2CmosCrc(ram) === 0) return;
  }
}

/**
 * The CMOS a configured Model 30 286 keeps: its 1.44 MB drives, no hard disk,
 * VGA, 640K of base memory and the rest as extended memory (what IBM's
 * Reference Diskette would set), so a first start doesn't stop at error 162.
 */
export function defaultCmos(megabytes: number, floppyDrives: 1 | 2): Uint8Array {
  const ram = new Uint8Array(128);
  const extended = megabytes * 1024 - 640;
  ram[0x10] = floppyDrives === 2 ? 0x44 : 0x40;
  // Equipment: the number of floppy drives less one, EGA/VGA display, floppies present.
  ram[0x14] = ((floppyDrives - 1) << 6) | 0x01;
  ram[0x15] = 640 & 0xff;
  ram[0x16] = 640 >> 8;
  ram[0x17] = extended & 0xff;
  ram[0x18] = extended >> 8;
  // The planar's setup for port 102h: the serial port on as COM1, the parallel port on at 3BCh.
  ram[0x31] = 0x1c;
  storeCrc(ram);
  return ram;
}
