import { gunzipSync } from 'node:zlib';

/** The registers a MOO test gives, in the order of its register bitmask. */
export const MOO_REGISTERS = ['ax', 'bx', 'cx', 'dx', 'cs', 'ss', 'ds', 'es', 'sp', 'bp', 'si', 'di', 'ip', 'flags'] as const;
export type MooRegister = (typeof MOO_REGISTERS)[number];

export interface MooState {
  regs: Partial<Record<MooRegister, number>>;
  /** [address, byte] pairs. */
  ram: [number, number][];
}

export interface MooTest {
  index: number;
  name: string;
  initial: MooState;
  /** Only what changed. */
  final: MooState;
  exception: { vector: number; flagAddress: number } | null;
  hash: string;
  /** The clocks the instruction took on the chip, from an empty prefetch queue (0 if not recorded). */
  cycles: number;
}

function readState(view: DataView, start: number, end: number): MooState {
  const state: MooState = { regs: {}, ram: [] };
  let offset = start;
  while (offset < end) {
    const tag = String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + offset, 4));
    const length = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (tag === 'REGS') {
      const mask = view.getUint16(body, true);
      let at = body + 2;
      MOO_REGISTERS.forEach((name, i) => {
        if (!(mask & (1 << i))) return;
        state.regs[name] = view.getUint16(at, true);
        at += 2;
      });
    } else if (tag === 'RAM ') {
      const count = view.getUint32(body, true);
      for (let i = 0; i < count; i++) state.ram.push([view.getUint32(body + 4 + i * 5, true), view.getUint8(body + 8 + i * 5)]);
    }
    offset = body + length;
  }
  return state;
}

/** Reads a gzipped MOO file of Daniel Balsom's SingleStepTests (https://github.com/dbalsom/moo). */
export function readMoo(gzipped: Uint8Array): MooTest[] {
  const data = gunzipSync(gzipped);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tag = (at: number) => String.fromCharCode(data[at], data[at + 1], data[at + 2], data[at + 3]);
  if (tag(0) !== 'MOO ') throw new Error('Not a MOO file');
  let offset = 8 + view.getUint32(4, true);
  const tests: MooTest[] = [];
  while (offset < data.length) {
    const length = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (tag(offset) === 'TEST') {
      const test: MooTest = {
        index: view.getUint32(body, true),
        name: '',
        initial: { regs: {}, ram: [] },
        final: { regs: {}, ram: [] },
        exception: null,
        hash: '',
        cycles: 0,
      };
      let at = body + 4;
      while (at < body + length) {
        const sub = tag(at);
        const subLength = view.getUint32(at + 4, true);
        const start = at + 8;
        if (sub === 'NAME') {
          const nameLength = view.getUint32(start, true);
          test.name = new TextDecoder().decode(data.subarray(start + 4, start + 4 + nameLength));
        } else if (sub === 'INIT') {
          test.initial = readState(view, start, start + subLength);
        } else if (sub === 'FINA') {
          test.final = readState(view, start, start + subLength);
        } else if (sub === 'EXCP') {
          test.exception = { vector: data[start], flagAddress: view.getUint32(start + 1, true) };
        } else if (sub === 'CYCL') {
          test.cycles = view.getUint32(start, true);
        } else if (sub === 'HASH') {
          test.hash = Buffer.from(data.subarray(start, start + subLength)).toString('hex');
        }
        at = start + subLength;
      }
      tests.push(test);
    }
    offset = body + length;
  }
  return tests;
}
