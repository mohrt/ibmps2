import { FloppyImage } from './floppy-image';
import { isZip, usableFilesInZip } from './zip';

export const STATE_EXTENSION = '.ps2state';
/** Disk image names PC emulators use for raw sector images. */
export const DISK_EXTENSIONS = ['.img', '.ima', '.vfd', '.flp', '.dsk', '.144', '.720'];

export type Media = { kind: 'disk'; disk: FloppyImage } | { kind: 'state'; bytes: Uint8Array };

const isGzip = (data: Uint8Array) => data[0] === 0x1f && data[1] === 0x8b;

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(data)]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The files a dropped file stands for: itself, or the usable files in a zip (best first). */
export async function filesFrom(file: File): Promise<File[]> {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (!isZip(head)) return [file];
  const files = await usableFilesInZip(new Uint8Array(await file.arrayBuffer()));
  if (files.length === 0) throw new Error(`${file.name} has no floppy disk images in it (.img, .ima or .vfd files).`);
  return files;
}

/** Works out what a file is: a floppy image (possibly gzipped) or a save state. */
export async function readMedia(file: File): Promise<Media> {
  const name = file.name.toLowerCase();
  let data: Uint8Array = new Uint8Array(await file.arrayBuffer());
  if (name.endsWith(STATE_EXTENSION)) return { kind: 'state', bytes: data };
  if (name.endsWith('.imd') || name.endsWith('.td0')) {
    throw new Error(`${file.name} is an ImageDisk or Teledisk archive; convert it to a raw .img first.`);
  }
  if (isGzip(data)) {
    data = await gunzip(data);
    // A save state (they are gzipped too) rather than a disk.
    if (data[0] === 0x7b) return { kind: 'state', bytes: new Uint8Array(await file.arrayBuffer()) };
  }
  return { kind: 'disk', disk: new FloppyImage(data, file.name) };
}

/** "Game (Disk 1 of 2).img" → "Game (Disk 1 of 2)". */
export function titleFromFileName(name: string): string {
  return name.replace(/\.(img|ima|vfd|flp|dsk|144|720|zip|gz)$/i, '').trim() || name;
}

/** The disk to put in first from several: the first by name ("Disk 1"). */
export function firstDisk(files: File[]): File {
  return files[0];
}
