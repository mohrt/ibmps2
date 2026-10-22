/** What an instruction just run looks like, for its timing. */
export interface InstructionShape {
  /** The opcode, after any prefixes. */
  op: number;
  /** The ModRM byte's reg field (it names the operation of opcodes like F6h). */
  reg: number;
  /** A memory operand (ModRM mod 0-2). */
  memory: boolean;
  /** The instruction jumped (somewhere other than the next instruction). */
  branched: boolean;
  /** A REP prefix was given. */
  repeated: boolean;
  /** Elements a REP string instruction moved, or a shift's count. */
  count: number;
}

/**
 * Clocks measured from a real chip (the SingleStepTests' cycle counts, from an empty
 * prefetch queue), by instruction form: "F6.4" for an opcode whose reg field names it.
 */
export interface TimingTable {
  /** The opcodes whose reg field names the form. */
  groups: number[];
  /** Median clocks: [register, memory, register when it branches, memory when it branches]; -1 where none were seen. */
  forms: Record<string, number[]>;
  /** Clocks before and per element or count: REP string instructions ("A4r"), shifts by a count ("D2.4"). */
  counted: Record<string, [number, number]>;
}

const hex = (op: number) => op.toString(16).toUpperCase().padStart(2, '0');

/** The table's key for an instruction. */
export function formKey(table: TimingTable, op: number, reg: number): string {
  return table.groups.includes(op) ? `${hex(op)}.${reg}` : hex(op);
}

/** A timing table laid out for looking up an instruction each time one runs. */
export class Timing {
  /** Four clocks a form (see TimingTable.forms) by opcode * 8 + reg field; -1 for none. */
  private readonly forms = new Int16Array(256 * 8 * 4).fill(-1);
  /** Base and per-count clocks, plain and REP-prefixed, by opcode * 8 + reg field; NaN for none. */
  private readonly counted = new Float64Array(256 * 8 * 4).fill(NaN);

  constructor(table: TimingTable) {
    for (let op = 0; op < 256; op++) {
      for (let reg = 0; reg < 8; reg++) {
        const index = op * 8 + reg;
        const key = formKey(table, op, reg);
        table.forms[key]?.forEach((value, i) => (this.forms[index * 4 + i] = value));
        const plain = table.counted[key];
        const repeated = table.counted[`${key}r`];
        if (plain) this.counted.set(plain, index * 4);
        if (repeated) this.counted.set(repeated, index * 4 + 2);
      }
    }
  }

  /** The clocks an instruction takes, or -1 if the table has no measure of it. */
  clocks(op: number, reg: number, memory: boolean, branched: boolean, repeated: boolean, count: number): number {
    const index = op * 8 + reg;
    const at = index * 4 + (repeated ? 2 : 0);
    if (!Number.isNaN(this.counted[at])) return this.counted[at] + this.counted[at + 1] * count;
    const kind = (memory ? 1 : 0) + (branched ? 2 : 0);
    // Fall back to the not-branching measure, then to whichever operand kind was seen.
    const forms = this.forms;
    const base = index * 4;
    if (forms[base + kind] >= 0) return forms[base + kind];
    if (forms[base + (kind & 1)] >= 0) return forms[base + (kind & 1)];
    if (forms[base + ((kind & 1) ^ 1)] >= 0) return forms[base + ((kind & 1) ^ 1)];
    return -1;
  }
}
