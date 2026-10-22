import { FloppyImage, SECTOR_BYTES, formattedDisk } from '../drive/floppy-image';
import type { KeyValueStore } from './store';

/** Sectors a program wrote to a disk image, by sector number. */
export interface DiskSaveRecord {
  name: string;
  updated: number;
  sectors: Record<string, Uint8Array>;
}

/** A blank disk created in the emulator for saving games, stored whole. */
export interface SaveDiskRecord {
  name: string;
  created: number;
  updated: number;
  bytes: Uint8Array;
}

export interface SaveDiskInfo {
  id: string;
  name: string;
  updated: number;
}

export async function fingerprint(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The sectors of `current` that differ from `original`. */
export function changedSectors(original: Uint8Array, current: Uint8Array): Record<string, Uint8Array> {
  const changes: Record<string, Uint8Array> = {};
  for (let start = 0, sector = 0; start < current.length; start += SECTOR_BYTES, sector++) {
    for (let i = start; i < start + SECTOR_BYTES; i++) {
      if (original[i] !== current[i]) {
        changes[sector] = current.slice(start, start + SECTOR_BYTES);
        break;
      }
    }
  }
  return changes;
}

/** Where the changes to a drive's disk are kept. */
export type DiskOrigin =
  | { kind: 'image'; key: string; name: string; original: Uint8Array }
  | { kind: 'saveDisk'; id: string; name: string };

/**
 * Keeps what programs write to floppies in browser storage without ever
 * modifying the user's disk images: for a dropped image only the changed
 * sectors are stored, keyed by a fingerprint of the original, and put back
 * whenever that image is inserted again. Blank disks made in the emulator
 * are stored whole. Each drive has its own origin.
 */
export class DiskSaves {
  private readonly origins: (DiskOrigin | null)[] = [null, null];

  constructor(
    private readonly overlays: KeyValueStore<DiskSaveRecord>,
    private readonly saveDisks: KeyValueStore<SaveDiskRecord>,
  ) {}

  /** A disk for a dropped image, with its stored changes applied. */
  async openImage(drive: number, image: FloppyImage): Promise<{ disk: FloppyImage; hasSavedChanges: boolean }> {
    const original = image.bytes.slice();
    const key = await fingerprint(original);
    const record = await this.overlays.get(key);
    if (record) {
      for (const [sector, data] of Object.entries(record.sectors)) image.bytes.set(data, Number(sector) * SECTOR_BYTES);
    }
    this.origins[drive] = { kind: 'image', key, name: image.name, original };
    return { disk: image, hasSavedChanges: record !== undefined };
  }

  async createSaveDisk(drive: number): Promise<{ disk: FloppyImage; name: string }> {
    const count = (await this.saveDisks.entries()).length;
    const name = `Blank disk ${count + 1}`;
    const now = Date.now();
    const id = `save-${now}`;
    const disk = new FloppyImage(formattedDisk(), name);
    await this.saveDisks.put(id, { name, created: now, updated: now, bytes: disk.bytes.slice() });
    this.origins[drive] = { kind: 'saveDisk', id, name };
    return { disk, name };
  }

  async openSaveDisk(drive: number, id: string): Promise<{ disk: FloppyImage; name: string } | null> {
    const record = await this.saveDisks.get(id);
    if (!record) return null;
    this.origins[drive] = { kind: 'saveDisk', id, name: record.name };
    return { disk: new FloppyImage(record.bytes.slice(), record.name), name: record.name };
  }

  async listSaveDisks(): Promise<SaveDiskInfo[]> {
    const entries = await this.saveDisks.entries();
    return entries.map(([id, record]) => ({ id, name: record.name, updated: record.updated })).sort((a, b) => a.updated - b.updated);
  }

  async saveDiskBytes(id: string): Promise<Uint8Array | null> {
    return (await this.saveDisks.get(id))?.bytes ?? null;
  }

  async deleteSaveDisk(id: string): Promise<void> {
    await this.saveDisks.delete(id);
    this.origins.forEach((origin, drive) => {
      if (origin?.kind === 'saveDisk' && origin.id === id) this.origins[drive] = null;
    });
  }

  origin(drive: number): DiskOrigin | null {
    return this.origins[drive];
  }

  /** Stores what has been written to a drive's disk. */
  async persist(drive: number, disk: FloppyImage): Promise<void> {
    const origin = this.origins[drive];
    if (!origin) return;
    disk.dirty = false;
    if (origin.kind === 'saveDisk') {
      const record = await this.saveDisks.get(origin.id);
      if (record) await this.saveDisks.put(origin.id, { ...record, updated: Date.now(), bytes: disk.bytes.slice() });
      return;
    }
    const sectors = changedSectors(origin.original, disk.bytes);
    if (Object.keys(sectors).length === 0) await this.overlays.delete(origin.key);
    else await this.overlays.put(origin.key, { name: origin.name, updated: Date.now(), sectors });
  }

  /** Forgets the stored changes to a drive's image and returns a clean copy of it. */
  async revert(drive: number): Promise<FloppyImage | null> {
    const origin = this.origins[drive];
    if (origin?.kind !== 'image') return null;
    await this.overlays.delete(origin.key);
    return new FloppyImage(origin.original.slice(), origin.name);
  }

  eject(drive: number): void {
    this.origins[drive] = null;
  }

  /** Makes later saves go where a restored save state's disk came from. */
  adopt(drive: number, origin: DiskOrigin | null): void {
    this.origins[drive] = origin;
  }
}
