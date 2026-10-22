export const SECTOR_BYTES = 512;

export interface FloppyGeometry {
  cylinders: number;
  heads: number;
  sectors: number;
  /** High density (read at 500 kbit/s), or double density (250 kbit/s). */
  highDensity: boolean;
  label: string;
}

/** The PC disk formats, by image size. */
const FORMATS: FloppyGeometry[] = [
  { cylinders: 80, heads: 2, sectors: 18, highDensity: true, label: '1.44 MB' },
  { cylinders: 80, heads: 2, sectors: 9, highDensity: false, label: '720 KB' },
  { cylinders: 80, heads: 2, sectors: 21, highDensity: true, label: '1.68 MB (DMF)' },
  { cylinders: 82, heads: 2, sectors: 21, highDensity: true, label: '1.72 MB' },
  { cylinders: 80, heads: 2, sectors: 15, highDensity: true, label: '1.2 MB' },
  { cylinders: 40, heads: 2, sectors: 9, highDensity: false, label: '360 KB' },
  { cylinders: 40, heads: 2, sectors: 8, highDensity: false, label: '320 KB' },
  { cylinders: 40, heads: 1, sectors: 9, highDensity: false, label: '180 KB' },
  { cylinders: 40, heads: 1, sectors: 8, highDensity: false, label: '160 KB' },
];

/** How DOS's FORMAT lays out each size of disk: sectors per cluster, root directory entries, media byte, sectors per FAT. */
const BLANK_LAYOUTS = {
  '1.44 MB': { sectors: 2880, perTrack: 18, cluster: 1, root: 224, media: 0xf0, fat: 9 },
  '1.2 MB': { sectors: 2400, perTrack: 15, cluster: 1, root: 224, media: 0xf9, fat: 7 },
  '720 KB': { sectors: 1440, perTrack: 9, cluster: 2, root: 112, media: 0xf9, fat: 3 },
  '360 KB': { sectors: 720, perTrack: 9, cluster: 2, root: 112, media: 0xfd, fat: 2 },
};

export type BlankFormat = keyof typeof BLANK_LAYOUTS;

/** Boot code for a disk without DOS on it: says so, waits for a key and tries the next disk (INT 19h). */
const NOT_BOOTABLE_CODE = [
  0xfa, 0x31, 0xc0, 0x8e, 0xd8, 0x8e, 0xd0, 0xbc, 0x00, 0x7c, 0xfb, 0xbe, 0x5d, 0x7c, 0xac, 0x08, 0xc0, 0x74, 0x06, 0xb4, 0x0e,
  0xcd, 0x10, 0xeb, 0xf5, 0x31, 0xc0, 0xcd, 0x16, 0xcd, 0x19,
];
const NOT_BOOTABLE_MESSAGE = 'Not a startup disk. Insert another disk and press a key.\r\n';

/** A disk with an empty FAT12 file system, as DOS's FORMAT A: leaves it (1.44 MB unless asked for another size). */
export function formattedDisk(format: BlankFormat = '1.44 MB'): Uint8Array {
  const layout = BLANK_LAYOUTS[format];
  const disk = new Uint8Array(layout.sectors * SECTOR_BYTES);
  const view = new DataView(disk.buffer);
  disk.set([0xeb, 0x3c, 0x90], 0);
  disk.set(new TextEncoder().encode('IBMPS2  '), 3);
  view.setUint16(11, SECTOR_BYTES, true);
  disk[13] = layout.cluster; // sectors per cluster
  view.setUint16(14, 1, true); // reserved sectors
  disk[16] = 2; // FATs
  view.setUint16(17, layout.root, true); // root directory entries
  view.setUint16(19, layout.sectors, true); // sectors
  disk[21] = layout.media; // media descriptor
  view.setUint16(22, layout.fat, true); // sectors per FAT
  view.setUint16(24, layout.perTrack, true); // sectors per track
  view.setUint16(26, 2, true); // heads
  disk[38] = 0x29;
  view.setUint32(39, (Date.now() & 0xffffffff) >>> 0, true);
  disk.set(new TextEncoder().encode('NO NAME    FAT12   '), 43);
  disk.set(NOT_BOOTABLE_CODE, 0x3e);
  disk.set(new TextEncoder().encode(`${NOT_BOOTABLE_MESSAGE}\0`), 0x3e + NOT_BOOTABLE_CODE.length);
  disk[510] = 0x55;
  disk[511] = 0xaa;
  for (const fat of [1, 1 + layout.fat]) disk.set([layout.media, 0xff, 0xff], fat * SECTOR_BYTES);
  return disk;
}

export function geometryForSize(bytes: number): FloppyGeometry | null {
  return FORMATS.find((format) => format.cylinders * format.heads * format.sectors * SECTOR_BYTES === bytes) ?? null;
}

/** A PC floppy disk image: the sectors in order, cylinder by cylinder and head by head. */
export class FloppyImage {
  readonly geometry: FloppyGeometry;
  /** Set when a program has written to the disk since it was last saved. */
  dirty = false;
  writeProtected = false;

  constructor(
    readonly bytes: Uint8Array,
    readonly name: string,
  ) {
    const geometry = geometryForSize(bytes.length);
    if (!geometry) {
      const sizes = FORMATS.map((format) => format.label).join(', ');
      throw new Error(`${name} is ${bytes.length.toLocaleString('en')} bytes, which isn't a PC floppy image (${sizes}).`);
    }
    this.geometry = geometry;
  }

  /** A disk formatted for DOS (FAT12, no system files on it). */
  static blank(name: string, format?: BlankFormat): FloppyImage {
    return new FloppyImage(formattedDisk(format), name);
  }

  /** The byte offset of a sector, or -1 if the disk has no such sector. */
  offset(cylinder: number, head: number, sector: number): number {
    const { cylinders, heads, sectors } = this.geometry;
    if (cylinder >= cylinders || head >= heads || sector < 1 || sector > sectors) return -1;
    return ((cylinder * heads + head) * sectors + sector - 1) * SECTOR_BYTES;
  }
}
