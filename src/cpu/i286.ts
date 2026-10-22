/** What the 80286 sees of the machine: 16 MB of memory on 24 address lines, and 64K I/O ports. */
export interface CpuBus {
  read8(address: number): number;
  write8(address: number, value: number): void;
  read16(address: number): number;
  write16(address: number, value: number): void;
  in8(port: number): number;
  in16(port: number): number;
  out8(port: number, value: number): void;
  out16(port: number, value: number): void;
}

/** A processor exception raised in the middle of an instruction; the instruction is restarted after it. */
export class CpuFault {
  constructor(
    readonly vector: number,
    /** The error code pushed in protected mode, or null for none. */
    readonly code: number | null = null,
  ) {}
}

export const enum Seg {
  ES = 0,
  CS = 1,
  SS = 2,
  DS = 3,
}

const enum Reg {
  AX = 0,
  CX = 1,
  DX = 2,
  BX = 3,
  SP = 4,
  BP = 5,
  SI = 6,
  DI = 7,
}

const enum Vec {
  Divide = 0,
  Debug = 1,
  Nmi = 2,
  Breakpoint = 3,
  Overflow = 4,
  Bound = 5,
  Invalid = 6,
  NoCoprocessor = 7,
  DoubleFault = 8,
  InvalidTss = 10,
  NotPresent = 11,
  Stack = 12,
  General = 13,
}

/** Access rights bits of a descriptor. */
const enum Acc {
  Accessed = 0x01,
  /** Writable data, or readable code. */
  ReadWrite = 0x02,
  /** Expand-down data, or conforming code. */
  Direction = 0x04,
  Code = 0x08,
  Segment = 0x10,
  Present = 0x80,
}

const enum Msw {
  PE = 1,
  MP = 2,
  EM = 4,
  TS = 8,
}

const PARITY = Uint8Array.from({ length: 256 }, (_, n) => {
  let bits = 0;
  for (let v = n; v; v >>= 1) bits ^= v & 1;
  return bits ? 0 : 1;
});

/** Real-mode access rights the 286 gives every segment at reset: present, writable data (code for CS). */
const DATA_RIGHTS = 0x93;
const CODE_RIGHTS = 0x9b;

/** A descriptor read from the GDT, LDT or IDT (gates keep their selector and word count in it too). */
interface Descriptor {
  address: number;
  base: number;
  limit: number;
  rights: number;
  /** For gates: the target selector. */
  selector: number;
  /** For call gates: the words of parameters to copy. */
  count: number;
}

const blankDescriptor = (): Descriptor => ({ address: 0, base: 0, limit: 0, rights: 0, selector: 0, count: 0 });

const gp = (code: number) => new CpuFault(Vec.General, code);

/**
 * An Intel 80286: real mode as on an 8086 plus the 286's additions (PUSHA,
 * ENTER, BOUND, IMUL by immediates, string I/O, shifts by immediates), and
 * protected mode with descriptor tables, privilege levels, call and
 * interrupt gates, task switches, and LOADALL. Faults restart the
 * instruction, as on the real chip. Timing is per instruction from Intel's
 * clock counts, not per bus cycle.
 */
export class I286 {
  /** AX, CX, DX, BX, SP, BP, SI, DI. */
  readonly regs = new Uint16Array(8);
  /** The selectors in ES, CS, SS and DS. */
  readonly sreg = new Uint16Array(4);
  /** The descriptor caches behind them. */
  readonly segBase = new Uint32Array(4);
  readonly segLimit = new Uint32Array(4);
  readonly segRights = new Uint8Array(4);
  ip = 0;

  cf = 0;
  pf = 0;
  af = 0;
  zf = 0;
  sf = 0;
  tf = 0;
  ifl = 0;
  df = 0;
  of = 0;
  iopl = 0;
  nt = 0;

  /** The machine status word: PE, MP, EM and TS. */
  msw = 0;
  cpl = 0;
  gdtBase = 0;
  gdtLimit = 0;
  idtBase = 0;
  idtLimit = 0x3ff;
  ldtSelector = 0;
  ldtBase = 0;
  ldtLimit = 0;
  ldtRights = 0;
  trSelector = 0;
  trBase = 0;
  trLimit = 0;
  trRights = 0;

  halted = false;
  /** Set by a triple fault: the CPU stops until it is reset (a PC resets it straight away). */
  shutdown = false;
  /** Clock cycles run since power on. */
  cycles = 0;
  /** Interrupts wait an instruction after STI, MOV SS and POP SS. */
  private inhibit = false;
  private startIp = 0;
  private startSp = 0;
  private segOverride = -1;
  /** PUSHA, POPA and ENTER put SP back if they fault. */
  private restoreSp = false;
  /** A string instruction's memory write is under way (a REP one that faults there has counted CX down again). */
  private stringWrite = false;
  /** 0 for none, 1 for REPNE, 2 for REP/REPE. */
  private rep = 0;
  private mod = 0;
  private regField = 0;
  private rm = 0;
  private eaSeg = 0;
  private eaOff = 0;
  private readonly desc = blankDescriptor();
  private readonly desc2 = blankDescriptor();
  /** Called on a triple fault. */
  onShutdown: () => void = () => {};

  constructor(private readonly bus: CpuBus) {
    this.reset();
  }

  get protectedMode(): boolean {
    return (this.msw & Msw.PE) !== 0;
  }

  /** Whether a hardware interrupt would be taken now. */
  get acceptsInterrupts(): boolean {
    return this.ifl === 1 && !this.inhibit;
  }

  /** The RESET line: real mode, CS:IP at F000:FFF0 with CS based at FF0000 (the top of the address space). */
  reset(): void {
    this.regs.fill(0);
    this.sreg.fill(0);
    this.segBase.fill(0);
    this.segLimit.fill(0xffff);
    this.segRights.fill(DATA_RIGHTS);
    this.sreg[Seg.CS] = 0xf000;
    this.segBase[Seg.CS] = 0xff0000;
    this.segRights[Seg.CS] = CODE_RIGHTS;
    this.ip = 0xfff0;
    this.setFlags(0);
    this.iopl = this.nt = 0;
    this.msw = 0;
    this.cpl = 0;
    this.gdtBase = this.gdtLimit = 0;
    this.idtBase = 0;
    this.idtLimit = 0x3ff;
    this.ldtSelector = this.ldtBase = this.ldtLimit = this.ldtRights = 0;
    this.trSelector = this.trBase = this.trLimit = this.trRights = 0;
    this.halted = this.shutdown = this.inhibit = false;
  }

  // --- Flags ---------------------------------------------------------------------------

  get flags(): number {
    return (
      this.cf |
      2 |
      (this.pf << 2) |
      (this.af << 4) |
      (this.zf << 6) |
      (this.sf << 7) |
      (this.tf << 8) |
      (this.ifl << 9) |
      (this.df << 10) |
      (this.of << 11) |
      (this.iopl << 12) |
      (this.nt << 14)
    );
  }

  /** Loads all of FLAGS (IOPL and NT only in protected mode: in real mode the 286 keeps them clear). */
  setFlags(value: number): void {
    this.cf = value & 1;
    this.pf = (value >> 2) & 1;
    this.af = (value >> 4) & 1;
    this.zf = (value >> 6) & 1;
    this.sf = (value >> 7) & 1;
    this.tf = (value >> 8) & 1;
    this.ifl = (value >> 9) & 1;
    this.df = (value >> 10) & 1;
    this.of = (value >> 11) & 1;
    if (this.protectedMode) {
      this.iopl = (value >> 12) & 3;
      this.nt = (value >> 14) & 1;
    }
  }

  /** POPF and IRET: IOPL only changes at CPL 0, IF only when CPL <= IOPL. */
  private popFlags(value: number): void {
    const iopl = this.iopl;
    const ifl = this.ifl;
    this.setFlags(value);
    if (this.protectedMode) {
      if (this.cpl > 0) this.iopl = iopl;
      if (this.cpl > iopl) this.ifl = ifl;
    }
  }

  private szp8(r: number): void {
    this.zf = r === 0 ? 1 : 0;
    this.sf = r >> 7;
    this.pf = PARITY[r];
  }

  private szp16(r: number): void {
    this.zf = r === 0 ? 1 : 0;
    this.sf = r >> 15;
    this.pf = PARITY[r & 0xff];
  }

  private condition(cc: number): boolean {
    switch (cc >> 1) {
      case 0:
        return (this.of === 1) !== ((cc & 1) === 1);
      case 1:
        return (this.cf === 1) !== ((cc & 1) === 1);
      case 2:
        return (this.zf === 1) !== ((cc & 1) === 1);
      case 3:
        return (this.cf === 1 || this.zf === 1) !== ((cc & 1) === 1);
      case 4:
        return (this.sf === 1) !== ((cc & 1) === 1);
      case 5:
        return (this.pf === 1) !== ((cc & 1) === 1);
      case 6:
        return (this.sf !== this.of) !== ((cc & 1) === 1);
      default:
        return (this.zf === 1 || this.sf !== this.of) !== ((cc & 1) === 1);
    }
  }

  // --- Registers -----------------------------------------------------------------------

  private getReg8(r: number): number {
    return r < 4 ? this.regs[r] & 0xff : this.regs[r - 4] >> 8;
  }

  private setReg8(r: number, v: number): void {
    if (r < 4) this.regs[r] = (this.regs[r] & 0xff00) | v;
    else this.regs[r - 4] = (this.regs[r - 4] & 0xff) | (v << 8);
  }

  // --- Memory through segments -------------------------------------------------------

  /** The linear address of `offset` in a segment, after the 286's limit and rights checks. */
  private linear(seg: number, offset: number, size: number, write: boolean): number {
    const limit = this.segLimit[seg];
    const last = offset + size - 1;
    if (this.msw & Msw.PE) {
      const rights = this.segRights[seg];
      const vector = seg === Seg.SS ? Vec.Stack : Vec.General;
      if (rights === 0) throw new CpuFault(vector, 0);
      if (write ? (rights & (Acc.Code | Acc.ReadWrite)) !== Acc.ReadWrite : (rights & (Acc.Code | Acc.ReadWrite)) === Acc.Code) {
        throw new CpuFault(vector, 0);
      }
      if ((rights & (Acc.Code | Acc.Direction)) === Acc.Direction) {
        if (offset <= limit || last > 0xffff) throw new CpuFault(vector, 0);
      } else if (last > limit) {
        throw new CpuFault(vector, 0);
      }
    } else if (last > limit) {
      // In real mode even the stack segment's limit raises #GP.
      throw gp(0);
    }
    return (this.segBase[seg] + offset) & 0xffffff;
  }

  read8(seg: number, offset: number): number {
    return this.bus.read8(this.linear(seg, offset, 1, false));
  }

  read16(seg: number, offset: number): number {
    return this.bus.read16(this.linear(seg, offset, 2, false));
  }

  write8(seg: number, offset: number, value: number): void {
    this.bus.write8(this.linear(seg, offset, 1, true), value);
  }

  write16(seg: number, offset: number, value: number): void {
    this.bus.write16(this.linear(seg, offset, 2, true), value);
  }

  private fetch8(): number {
    const ip = this.ip;
    if (((ip - this.startIp) & 0xffff) >= 10) throw gp(0);
    if (this.msw & Msw.PE && ip > this.segLimit[Seg.CS]) throw gp(0);
    this.ip = (ip + 1) & 0xffff;
    return this.bus.read8((this.segBase[Seg.CS] + ip) & 0xffffff);
  }

  private fetch16(): number {
    const low = this.fetch8();
    return low | (this.fetch8() << 8);
  }

  private fetchSigned8(): number {
    return (this.fetch8() << 24) >> 24;
  }

  private push16(value: number): void {
    const sp = (this.regs[Reg.SP] - 2) & 0xffff;
    this.write16(Seg.SS, sp, value);
    this.regs[Reg.SP] = sp;
  }

  private pop16(): number {
    const sp = this.regs[Reg.SP];
    const value = this.read16(Seg.SS, sp);
    this.regs[Reg.SP] = sp + 2;
    return value;
  }

  // --- ModRM ---------------------------------------------------------------------------

  private modrm(): void {
    const byte = this.fetch8();
    this.mod = byte >> 6;
    this.regField = (byte >> 3) & 7;
    this.rm = byte & 7;
    if (this.mod === 3) return;
    const r = this.regs;
    let offset = 0;
    let seg: number = Seg.DS;
    switch (this.rm) {
      case 0:
        offset = r[Reg.BX] + r[Reg.SI];
        break;
      case 1:
        offset = r[Reg.BX] + r[Reg.DI];
        break;
      case 2:
        offset = r[Reg.BP] + r[Reg.SI];
        seg = Seg.SS;
        break;
      case 3:
        offset = r[Reg.BP] + r[Reg.DI];
        seg = Seg.SS;
        break;
      case 4:
        offset = r[Reg.SI];
        break;
      case 5:
        offset = r[Reg.DI];
        break;
      case 6:
        if (this.mod === 0) {
          offset = this.fetch16();
        } else {
          offset = r[Reg.BP];
          seg = Seg.SS;
        }
        break;
      default:
        offset = r[Reg.BX];
    }
    if (this.mod === 1) offset += this.fetchSigned8();
    else if (this.mod === 2) offset += this.fetch16();
    this.eaOff = offset & 0xffff;
    this.eaSeg = this.segOverride >= 0 ? this.segOverride : seg;
    if (this.rm < 4 && this.mod !== 0) this.cycles++;
  }

  private readE8(): number {
    return this.mod === 3 ? this.getReg8(this.rm) : this.read8(this.eaSeg, this.eaOff);
  }

  private readE16(): number {
    return this.mod === 3 ? this.regs[this.rm] : this.read16(this.eaSeg, this.eaOff);
  }

  private writeE8(value: number): void {
    if (this.mod === 3) this.setReg8(this.rm, value);
    else this.write8(this.eaSeg, this.eaOff, value);
  }

  private writeE16(value: number): void {
    if (this.mod === 3) this.regs[this.rm] = value;
    else this.write16(this.eaSeg, this.eaOff, value);
  }

  /** The second word of a memory operand (for far pointers and BOUND). */
  private readE16At(delta: number): number {
    return this.read16(this.eaSeg, (this.eaOff + delta) & 0xffff);
  }

  private requireMemory(): void {
    if (this.mod === 3) throw new CpuFault(Vec.Invalid);
  }

  // --- Arithmetic ----------------------------------------------------------------------

  /** ADD, OR, ADC, SBB, AND, SUB, XOR or CMP on bytes. */
  private alu8(op: number, a: number, b: number): number {
    let r: number;
    switch (op) {
      case 0:
      case 2:
        r = a + b + (op === 2 ? this.cf : 0);
        this.cf = r >> 8;
        r &= 0xff;
        this.of = ((a ^ r) & (b ^ r) & 0x80) >> 7;
        this.af = ((a ^ b ^ r) >> 4) & 1;
        break;
      case 3:
      case 5:
      case 7:
        r = a - b - (op === 3 ? this.cf : 0);
        this.cf = r < 0 ? 1 : 0;
        r &= 0xff;
        this.of = ((a ^ b) & (a ^ r) & 0x80) >> 7;
        this.af = ((a ^ b ^ r) >> 4) & 1;
        break;
      default:
        r = op === 1 ? a | b : op === 4 ? a & b : a ^ b;
        this.cf = this.of = this.af = 0;
    }
    this.szp8(r);
    return r;
  }

  private alu16(op: number, a: number, b: number): number {
    let r: number;
    switch (op) {
      case 0:
      case 2:
        r = a + b + (op === 2 ? this.cf : 0);
        this.cf = r >> 16;
        r &= 0xffff;
        this.of = ((a ^ r) & (b ^ r) & 0x8000) >> 15;
        this.af = ((a ^ b ^ r) >> 4) & 1;
        break;
      case 3:
      case 5:
      case 7:
        r = a - b - (op === 3 ? this.cf : 0);
        this.cf = r < 0 ? 1 : 0;
        r &= 0xffff;
        this.of = ((a ^ b) & (a ^ r) & 0x8000) >> 15;
        this.af = ((a ^ b ^ r) >> 4) & 1;
        break;
      default:
        r = op === 1 ? a | b : op === 4 ? a & b : a ^ b;
        this.cf = this.of = this.af = 0;
    }
    this.szp16(r);
    return r;
  }

  private inc8(a: number): number {
    const r = (a + 1) & 0xff;
    this.of = r === 0x80 ? 1 : 0;
    this.af = (r & 0xf) === 0 ? 1 : 0;
    this.szp8(r);
    return r;
  }

  private dec8(a: number): number {
    const r = (a - 1) & 0xff;
    this.of = r === 0x7f ? 1 : 0;
    this.af = (r & 0xf) === 0xf ? 1 : 0;
    this.szp8(r);
    return r;
  }

  private inc16(a: number): number {
    const r = (a + 1) & 0xffff;
    this.of = r === 0x8000 ? 1 : 0;
    this.af = (r & 0xf) === 0 ? 1 : 0;
    this.szp16(r);
    return r;
  }

  private dec16(a: number): number {
    const r = (a - 1) & 0xffff;
    this.of = r === 0x7fff ? 1 : 0;
    this.af = (r & 0xf) === 0xf ? 1 : 0;
    this.szp16(r);
    return r;
  }

  /** ROL, ROR, RCL, RCR, SHL, SHR, SAL or SAR, one bit at a time as the chip does (the count is masked to 5 bits). */
  private shift(op: number, value: number, count: number, bits: number): number {
    count &= 0x1f;
    if (count === 0) return value;
    const sign = bits === 8 ? 0x80 : 0x8000;
    const mask = bits === 8 ? 0xff : 0xffff;
    let r = value;
    let cf = this.cf;
    for (let i = 0; i < count; i++) {
      switch (op) {
        case 0:
          cf = r & sign ? 1 : 0;
          r = ((r << 1) | cf) & mask;
          break;
        case 1:
          cf = r & 1;
          r = (r >> 1) | (cf ? sign : 0);
          break;
        case 2: {
          const out = r & sign ? 1 : 0;
          r = ((r << 1) | cf) & mask;
          cf = out;
          break;
        }
        case 3: {
          const out = r & 1;
          r = (r >> 1) | (cf ? sign : 0);
          cf = out;
          break;
        }
        case 4:
        case 6:
          cf = r & sign ? 1 : 0;
          r = (r << 1) & mask;
          break;
        case 5:
          cf = r & 1;
          r >>= 1;
          break;
        default:
          cf = r & 1;
          r = (r >> 1) | (r & sign);
      }
    }
    this.cf = cf;
    const msb = r & sign ? 1 : 0;
    const next = r & (sign >> 1) ? 1 : 0;
    switch (op) {
      case 0:
      case 2:
        this.of = msb ^ cf;
        break;
      case 1:
      case 3:
        this.of = msb ^ next;
        break;
      case 4:
      case 6:
        this.of = msb ^ cf;
        break;
      case 5:
        this.of = count === 1 ? (value & sign ? 1 : 0) : 0;
        break;
      default:
        this.of = 0;
    }
    if (op >= 4) {
      if (bits === 8) this.szp8(r);
      else this.szp16(r);
      // The 286's shifter leaves AF as bit 4 of a left shift's result, and set after a right shift.
      this.af = op === 4 || op === 6 ? (r >> 4) & 1 : 1;
    }
    this.cycles += count;
    return r;
  }

  /** The group 3 instructions: TEST, NOT, NEG, MUL, IMUL, DIV and IDIV on bytes. */
  private group3Byte(): void {
    const value = this.readE8();
    switch (this.regField) {
      case 0:
      case 1:
        this.alu8(4, value, this.fetch8());
        this.cycles += this.mod === 3 ? 3 : 6;
        break;
      case 2:
        this.writeE8(~value & 0xff);
        this.cycles += this.mod === 3 ? 2 : 7;
        break;
      case 3: {
        const r = (0 - value) & 0xff;
        this.writeE8(r);
        this.cf = value !== 0 ? 1 : 0;
        this.of = value === 0x80 ? 1 : 0;
        this.af = ((value ^ r) >> 4) & 1;
        this.szp8(r);
        this.cycles += this.mod === 3 ? 2 : 7;
        break;
      }
      case 4: {
        const r = (this.regs[Reg.AX] & 0xff) * value;
        this.regs[Reg.AX] = r;
        this.cf = this.of = r > 0xff ? 1 : 0;
        this.multiplyFlags8(r);
        this.cycles += 13;
        break;
      }
      case 5: {
        const r = ((this.regs[Reg.AX] << 24) >> 24) * ((value << 24) >> 24);
        this.regs[Reg.AX] = r;
        this.cf = this.of = r !== (r << 24) >> 24 ? 1 : 0;
        this.multiplyFlags8(r);
        this.cycles += 13;
        break;
      }
      case 6: {
        const dividend = this.regs[Reg.AX];
        if (value === 0) throw new CpuFault(Vec.Divide);
        const quotient = Math.floor(dividend / value);
        if (quotient > 0xff) throw new CpuFault(Vec.Divide);
        this.regs[Reg.AX] = ((dividend % value) << 8) | quotient;
        this.cycles += 14;
        break;
      }
      default: {
        const dividend = (this.regs[Reg.AX] << 16) >> 16;
        const divisor = (value << 24) >> 24;
        if (divisor === 0) throw new CpuFault(Vec.Divide);
        const quotient = Math.trunc(dividend / divisor);
        if (quotient > 0x7f || quotient < -0x80) throw new CpuFault(Vec.Divide);
        this.regs[Reg.AX] = (((dividend % divisor) & 0xff) << 8) | (quotient & 0xff);
        this.cycles += 17;
      }
    }
  }

  private group3Word(): void {
    const value = this.readE16();
    const r = this.regs;
    switch (this.regField) {
      case 0:
      case 1:
        this.alu16(4, value, this.fetch16());
        this.cycles += this.mod === 3 ? 3 : 6;
        break;
      case 2:
        this.writeE16(~value & 0xffff);
        this.cycles += this.mod === 3 ? 2 : 7;
        break;
      case 3: {
        const result = (0 - value) & 0xffff;
        this.writeE16(result);
        this.cf = value !== 0 ? 1 : 0;
        this.of = value === 0x8000 ? 1 : 0;
        this.af = ((value ^ result) >> 4) & 1;
        this.szp16(result);
        this.cycles += this.mod === 3 ? 2 : 7;
        break;
      }
      case 4: {
        const product = r[Reg.AX] * value;
        r[Reg.AX] = product;
        r[Reg.DX] = product / 0x10000;
        this.cf = this.of = r[Reg.DX] !== 0 ? 1 : 0;
        this.multiplyFlags16(r[Reg.DX]);
        this.cycles += 21;
        break;
      }
      case 5: {
        const product = ((r[Reg.AX] << 16) >> 16) * ((value << 16) >> 16);
        r[Reg.AX] = product;
        r[Reg.DX] = product >> 16;
        this.cf = this.of = product !== (product << 16) >> 16 ? 1 : 0;
        this.multiplyFlags16(r[Reg.DX]);
        this.cycles += 21;
        break;
      }
      case 6: {
        const dividend = r[Reg.DX] * 0x10000 + r[Reg.AX];
        if (value === 0) throw new CpuFault(Vec.Divide);
        const quotient = Math.floor(dividend / value);
        if (quotient > 0xffff) throw new CpuFault(Vec.Divide);
        r[Reg.DX] = dividend % value;
        r[Reg.AX] = quotient;
        this.cycles += 22;
        break;
      }
      default: {
        const dividend = (r[Reg.DX] << 16) | r[Reg.AX];
        const divisor = (value << 16) >> 16;
        if (divisor === 0) throw new CpuFault(Vec.Divide);
        const quotient = Math.trunc(dividend / divisor);
        if (quotient > 0x7fff || quotient < -0x8000) throw new CpuFault(Vec.Divide);
        r[Reg.DX] = dividend % divisor;
        r[Reg.AX] = quotient;
        this.cycles += 25;
      }
    }
  }

  /** IMUL reg, r/m, immediate (sizes are words). */
  private imul3(a: number, b: number): number {
    const product = ((a << 16) >> 16) * ((b << 16) >> 16);
    this.cf = this.of = product !== (product << 16) >> 16 ? 1 : 0;
    this.multiplyFlags16((product >> 16) & 0xffff);
    this.cycles += 21;
    return product & 0xffff;
  }

  /** The flags Intel leaves undefined after a multiply: the 286 sets SF, ZF and PF from the high half, and AF. */
  private multiplyFlags8(product: number): void {
    this.szp8((product >> 8) & 0xff);
    this.af = 1;
  }

  private multiplyFlags16(high: number): void {
    this.szp16(high);
    this.af = 1;
  }

  // --- Strings -------------------------------------------------------------------------

  /** Iterations of a REP string instruction run in one go before letting interrupts in. */
  private static readonly REP_BATCH = 128;

  /** Runs a string instruction, repeated when prefixed; `compare` ones also stop on ZF. */
  private string(body: () => void, compare: boolean, countsItself = false): void {
    if (this.rep === 0) {
      body();
      return;
    }
    const r = this.regs;
    for (let n = 0; ; n++) {
      if (r[Reg.CX] === 0) return;
      if (n === I286.REP_BATCH) {
        // Resume later from the prefixes, so pending interrupts are taken in between.
        this.ip = this.startIp;
        return;
      }
      // CX counts down before the element is touched (CMPS counts it between its two reads).
      if (!countsItself) r[Reg.CX]--;
      this.stringWrite = false;
      try {
        body();
      } catch (error) {
        if (this.stringWrite) r[Reg.CX]--;
        throw error;
      }
      if (compare && this.zf !== (this.rep === 2 ? 1 : 0)) return;
    }
  }

  /** CMPS's count down of CX, between its reads. */
  private countDown(): void {
    if (this.rep) this.regs[Reg.CX]--;
  }

  private get stringSeg(): number {
    return this.segOverride >= 0 ? this.segOverride : Seg.DS;
  }

  /**
   * Moves SI or DI on to the next element and returns where it pointed. The 286 does this before
   * the memory access, so a fault on the access leaves the registers already moved on.
   */
  private nextElement(reg: number, size: number): number {
    const address = this.regs[reg];
    this.regs[reg] = address + (this.df ? -size : size);
    return address;
  }

  // --- I/O -----------------------------------------------------------------------------

  private checkIo(): void {
    if (this.msw & Msw.PE && this.cpl > this.iopl) throw gp(0);
  }

  // --- Running -------------------------------------------------------------------------

  /** Runs one instruction (or takes the exception it raises). */
  step(): void {
    this.startIp = this.ip;
    this.startSp = this.regs[Reg.SP];
    const trap = this.tf;
    this.inhibit = false;
    try {
      this.execute();
    } catch (error) {
      if (!(error instanceof CpuFault)) throw error;
      this.ip = this.startIp;
      // Registers keep what the instruction did before the fault (as the chip's do), but a stack
      // fault restores SP so the pushes can be run again.
      if (this.restoreSp || error.vector === Vec.Stack) this.regs[Reg.SP] = this.startSp;
      this.exception(error);
      return;
    }
    if (trap && !this.inhibit) this.deliver(Vec.Debug, 'hardware', null);
  }

  /** Takes a hardware interrupt with this vector (from the interrupt controller's acknowledge). */
  interrupt(vector: number): void {
    this.halted = false;
    this.deliver(vector, 'hardware', null);
    this.cycles += 23;
  }

  /** The NMI line. */
  nmi(): void {
    this.halted = false;
    this.deliver(Vec.Nmi, 'hardware', null);
  }

  private exception(fault: CpuFault): void {
    this.deliver(fault.vector, 'fault', this.protectedMode ? fault.code : null);
  }

  /**
   * Delivers an interrupt or exception. A fault while delivering an INT
   * instruction's interrupt is that instruction's fault; one while
   * delivering an exception is a double fault, and one while delivering
   * that shuts the CPU down.
   */
  private deliver(vector: number, kind: 'software' | 'hardware' | 'fault', code: number | null): void {
    const sp = this.regs[Reg.SP];
    const ss = [this.sreg[Seg.SS], this.segBase[Seg.SS], this.segLimit[Seg.SS], this.segRights[Seg.SS], this.cpl];
    try {
      if (this.protectedMode) this.protectedInterrupt(vector, kind === 'software', code, kind !== 'software');
      else this.realInterrupt(vector, kind === 'software');
    } catch (error) {
      if (!(error instanceof CpuFault) || kind === 'software') throw error;
      this.regs[Reg.SP] = sp;
      [this.sreg[Seg.SS], this.segBase[Seg.SS], this.segLimit[Seg.SS], this.segRights[Seg.SS], this.cpl] = ss;
      if (vector === Vec.DoubleFault) {
        this.shutdown = true;
        this.halted = true;
        this.onShutdown();
        return;
      }
      const pm = this.protectedMode;
      if (kind === 'fault') this.deliver(Vec.DoubleFault, 'fault', pm ? 0 : null);
      else this.deliver(error.vector, 'fault', pm ? error.code : null);
    }
  }

  private realInterrupt(vector: number, software: boolean): void {
    const address = vector * 4;
    if (address + 3 > this.idtLimit) throw gp(vector * 8 + 2 + (software ? 0 : 1));
    const offset = this.bus.read16((this.idtBase + address) & 0xffffff);
    const selector = this.bus.read16((this.idtBase + address + 2) & 0xffffff);
    this.push16(this.flags);
    this.push16(this.sreg[Seg.CS]);
    this.push16(this.ip);
    this.ifl = this.tf = 0;
    this.loadRealSegment(Seg.CS, selector);
    this.ip = offset;
  }

  private softwareInterrupt(vector: number): void {
    this.deliver(vector, 'software', null);
  }

  private execute(): void {
    this.segOverride = -1;
    this.rep = 0;
    this.restoreSp = false;
    const r = this.regs;
    let op = this.fetch8();
    // Prefixes.
    for (;;) {
      if (op === 0x26 || op === 0x2e || op === 0x36 || op === 0x3e) this.segOverride = (op >> 3) & 3;
      else if (op === 0xf2) this.rep = 1;
      else if (op === 0xf3) this.rep = 2;
      else if (op !== 0xf0) break;
      this.cycles++;
      op = this.fetch8();
    }

    if (op < 0x40 && (op & 7) < 6) {
      const alu = op >> 3;
      switch (op & 7) {
        case 0: {
          this.modrm();
          const v = this.alu8(alu, this.readE8(), this.getReg8(this.regField));
          if (alu !== 7) this.writeE8(v);
          this.cycles += this.mod === 3 ? 2 : 7;
          return;
        }
        case 1: {
          this.modrm();
          const v = this.alu16(alu, this.readE16(), r[this.regField]);
          if (alu !== 7) this.writeE16(v);
          this.cycles += this.mod === 3 ? 2 : 7;
          return;
        }
        case 2: {
          this.modrm();
          const v = this.alu8(alu, this.getReg8(this.regField), this.readE8());
          if (alu !== 7) this.setReg8(this.regField, v);
          this.cycles += this.mod === 3 ? 2 : 7;
          return;
        }
        case 3: {
          this.modrm();
          const v = this.alu16(alu, r[this.regField], this.readE16());
          if (alu !== 7) r[this.regField] = v;
          this.cycles += this.mod === 3 ? 2 : 7;
          return;
        }
        case 4: {
          const v = this.alu8(alu, r[Reg.AX] & 0xff, this.fetch8());
          if (alu !== 7) this.setReg8(0, v);
          this.cycles += 3;
          return;
        }
        default: {
          const v = this.alu16(alu, r[Reg.AX], this.fetch16());
          if (alu !== 7) r[Reg.AX] = v;
          this.cycles += 3;
          return;
        }
      }
    }

    switch (op) {
      case 0x06:
      case 0x0e:
      case 0x16:
      case 0x1e:
        this.push16(this.sreg[op >> 3]);
        this.cycles += 3;
        return;
      case 0x07:
      case 0x17:
      case 0x1f: {
        const seg = op >> 3;
        const value = this.read16(Seg.SS, r[Reg.SP]);
        this.loadSegment(seg, value);
        r[Reg.SP] += 2;
        if (seg === Seg.SS) this.inhibit = true;
        this.cycles += this.protectedMode ? 20 : 5;
        return;
      }
      case 0x0f:
        this.extended();
        return;
      case 0x27:
        this.daa();
        return;
      case 0x2f:
        this.das();
        return;
      case 0x37:
        this.aaa();
        return;
      case 0x3f:
        this.aas();
        return;
    }

    if (op >= 0x40 && op < 0x60) {
      const reg = op & 7;
      switch (op >> 3) {
        case 8:
          r[reg] = this.inc16(r[reg]);
          break;
        case 9:
          r[reg] = this.dec16(r[reg]);
          break;
        case 10:
          // PUSH SP pushes SP as it was before the push.
          this.push16(r[reg]);
          break;
        default:
          r[reg] = this.pop16();
          this.cycles += 2;
      }
      this.cycles += 3;
      return;
    }

    if (op >= 0x70 && op < 0x80) {
      const displacement = this.fetchSigned8();
      if (this.condition(op & 0xf)) {
        this.ip = (this.ip + displacement) & 0xffff;
        this.cycles += 7;
      } else {
        this.cycles += 3;
      }
      return;
    }

    if (op >= 0x91 && op <= 0x97) {
      const reg = op & 7;
      const v = r[reg];
      r[reg] = r[Reg.AX];
      r[Reg.AX] = v;
      this.cycles += 3;
      return;
    }

    if (op >= 0xb0 && op <= 0xb7) {
      this.setReg8(op & 7, this.fetch8());
      this.cycles += 2;
      return;
    }

    if (op >= 0xb8 && op <= 0xbf) {
      r[op & 7] = this.fetch16();
      this.cycles += 2;
      return;
    }

    if (op >= 0xd8 && op <= 0xdf) {
      // Coprocessor escapes: with no 80287 fitted they only decode their operand.
      if (this.msw & (Msw.EM | Msw.TS)) throw new CpuFault(Vec.NoCoprocessor);
      this.modrm();
      // The 286 still reads a memory operand (and can fault on it).
      if (this.mod !== 3) this.read16(this.eaSeg, this.eaOff);
      this.cycles += 2;
      return;
    }

    switch (op) {
      case 0x60: {
        this.restoreSp = true;
        const sp = r[Reg.SP];
        for (const reg of [Reg.AX, Reg.CX, Reg.DX, Reg.BX]) this.push16(r[reg]);
        this.push16(sp);
        for (const reg of [Reg.BP, Reg.SI, Reg.DI]) this.push16(r[reg]);
        this.cycles += 17;
        return;
      }
      case 0x61: {
        this.restoreSp = true;
        const di = this.pop16();
        const si = this.pop16();
        const bp = this.pop16();
        r[Reg.SP] += 2;
        const bx = this.pop16();
        const dx = this.pop16();
        const cx = this.pop16();
        const ax = this.pop16();
        r[Reg.DI] = di;
        r[Reg.SI] = si;
        r[Reg.BP] = bp;
        r[Reg.BX] = bx;
        r[Reg.DX] = dx;
        r[Reg.CX] = cx;
        r[Reg.AX] = ax;
        this.cycles += 19;
        return;
      }
      case 0x62: {
        this.modrm();
        this.requireMemory();
        const index = (r[this.regField] << 16) >> 16;
        const lower = (this.readE16() << 16) >> 16;
        const upper = (this.readE16At(2) << 16) >> 16;
        this.cycles += 13;
        if (index < lower || index > upper) throw new CpuFault(Vec.Bound);
        return;
      }
      case 0x63: {
        if (!this.protectedMode) throw new CpuFault(Vec.Invalid);
        this.modrm();
        const dest = this.readE16();
        const source = r[this.regField];
        if ((dest & 3) < (source & 3)) {
          this.writeE16((dest & ~3) | (source & 3));
          this.zf = 1;
        } else {
          this.zf = 0;
        }
        this.cycles += 10;
        return;
      }
      case 0x68:
        this.push16(this.fetch16());
        this.cycles += 3;
        return;
      case 0x69: {
        this.modrm();
        const a = this.readE16();
        r[this.regField] = this.imul3(a, this.fetch16());
        return;
      }
      case 0x6a:
        this.push16(this.fetchSigned8() & 0xffff);
        this.cycles += 3;
        return;
      case 0x6b: {
        this.modrm();
        const a = this.readE16();
        r[this.regField] = this.imul3(a, this.fetchSigned8() & 0xffff);
        return;
      }
      case 0x6c:
        this.checkIo();
        this.string(() => {
          const di = this.nextElement(Reg.DI, 1);
          this.stringWrite = true;
          this.write8(Seg.ES, di, this.bus.in8(r[Reg.DX]));
          this.cycles += 5;
        }, false);
        return;
      case 0x6d:
        this.checkIo();
        this.string(() => {
          const di = this.nextElement(Reg.DI, 2);
          this.stringWrite = true;
          this.write16(Seg.ES, di, this.bus.in16(r[Reg.DX]));
          this.cycles += 5;
        }, false);
        return;
      case 0x6e:
        this.checkIo();
        this.string(() => {
          const si = this.nextElement(Reg.SI, 1);
          this.bus.out8(r[Reg.DX], this.read8(this.stringSeg, si));
          this.cycles += 5;
        }, false);
        return;
      case 0x6f:
        this.checkIo();
        this.string(() => {
          const si = this.nextElement(Reg.SI, 2);
          this.bus.out16(r[Reg.DX], this.read16(this.stringSeg, si));
          this.cycles += 5;
        }, false);
        return;
      case 0x80:
      case 0x82: {
        this.modrm();
        const a = this.readE8();
        const v = this.alu8(this.regField, a, this.fetch8());
        if (this.regField !== 7) this.writeE8(v);
        this.cycles += this.mod === 3 ? 3 : 7;
        return;
      }
      case 0x81: {
        this.modrm();
        const a = this.readE16();
        const v = this.alu16(this.regField, a, this.fetch16());
        if (this.regField !== 7) this.writeE16(v);
        this.cycles += this.mod === 3 ? 3 : 7;
        return;
      }
      case 0x83: {
        this.modrm();
        const a = this.readE16();
        const v = this.alu16(this.regField, a, this.fetchSigned8() & 0xffff);
        if (this.regField !== 7) this.writeE16(v);
        this.cycles += this.mod === 3 ? 3 : 7;
        return;
      }
      case 0x84:
        this.modrm();
        this.alu8(4, this.readE8(), this.getReg8(this.regField));
        this.cycles += this.mod === 3 ? 2 : 6;
        return;
      case 0x85:
        this.modrm();
        this.alu16(4, this.readE16(), r[this.regField]);
        this.cycles += this.mod === 3 ? 2 : 6;
        return;
      case 0x86: {
        this.modrm();
        const a = this.readE8();
        this.writeE8(this.getReg8(this.regField));
        this.setReg8(this.regField, a);
        this.cycles += this.mod === 3 ? 3 : 5;
        return;
      }
      case 0x87: {
        this.modrm();
        const a = this.readE16();
        this.writeE16(r[this.regField]);
        r[this.regField] = a;
        this.cycles += this.mod === 3 ? 3 : 5;
        return;
      }
      case 0x88:
        this.modrm();
        this.writeE8(this.getReg8(this.regField));
        this.cycles += this.mod === 3 ? 2 : 3;
        return;
      case 0x89:
        this.modrm();
        this.writeE16(r[this.regField]);
        this.cycles += this.mod === 3 ? 2 : 3;
        return;
      case 0x8a:
        this.modrm();
        this.setReg8(this.regField, this.readE8());
        this.cycles += this.mod === 3 ? 2 : 5;
        return;
      case 0x8b:
        this.modrm();
        r[this.regField] = this.readE16();
        this.cycles += this.mod === 3 ? 2 : 5;
        return;
      case 0x8c:
        this.modrm();
        if (this.regField > 3) throw new CpuFault(Vec.Invalid);
        this.writeE16(this.sreg[this.regField]);
        this.cycles += this.mod === 3 ? 2 : 3;
        return;
      case 0x8d:
        this.modrm();
        this.requireMemory();
        r[this.regField] = this.eaOff;
        this.cycles += 3;
        return;
      case 0x8e: {
        this.modrm();
        if (this.regField === Seg.CS || this.regField > 3) throw new CpuFault(Vec.Invalid);
        this.loadSegment(this.regField, this.readE16());
        if (this.regField === Seg.SS) this.inhibit = true;
        this.cycles += this.protectedMode ? 17 : this.mod === 3 ? 2 : 5;
        return;
      }
      case 0x8f: {
        this.modrm();
        if (this.regField !== 0) throw new CpuFault(Vec.Invalid);
        const value = this.read16(Seg.SS, r[Reg.SP]);
        r[Reg.SP] += 2;
        this.writeE16(value);
        this.cycles += 5;
        return;
      }
      case 0x90:
        this.cycles += 3;
        return;
      case 0x98:
        r[Reg.AX] = (r[Reg.AX] << 24) >> 24;
        this.cycles += 2;
        return;
      case 0x99:
        r[Reg.DX] = r[Reg.AX] & 0x8000 ? 0xffff : 0;
        this.cycles += 2;
        return;
      case 0x9a: {
        const offset = this.fetch16();
        const selector = this.fetch16();
        this.farJump(selector, offset, true);
        this.cycles += 13;
        return;
      }
      case 0x9b:
        if ((this.msw & (Msw.MP | Msw.TS)) === (Msw.MP | Msw.TS)) throw new CpuFault(Vec.NoCoprocessor);
        this.cycles += 3;
        return;
      case 0x9c:
        this.push16(this.protectedMode ? this.flags : this.flags & 0x0fff);
        this.cycles += 3;
        return;
      case 0x9d:
        this.popFlags(this.pop16());
        this.cycles += 5;
        return;
      case 0x9e: {
        const ah = r[Reg.AX] >> 8;
        this.cf = ah & 1;
        this.pf = (ah >> 2) & 1;
        this.af = (ah >> 4) & 1;
        this.zf = (ah >> 6) & 1;
        this.sf = (ah >> 7) & 1;
        this.cycles += 2;
        return;
      }
      case 0x9f:
        this.setReg8(4, this.flags & 0xff);
        this.cycles += 2;
        return;
      case 0xa0:
        this.setReg8(0, this.read8(this.stringSeg, this.fetch16()));
        this.cycles += 5;
        return;
      case 0xa1:
        r[Reg.AX] = this.read16(this.stringSeg, this.fetch16());
        this.cycles += 5;
        return;
      case 0xa2:
        this.write8(this.stringSeg, this.fetch16(), r[Reg.AX] & 0xff);
        this.cycles += 3;
        return;
      case 0xa3:
        this.write16(this.stringSeg, this.fetch16(), r[Reg.AX]);
        this.cycles += 3;
        return;
      case 0xa4:
        this.string(() => {
          const value = this.read8(this.stringSeg, this.nextElement(Reg.SI, 1));
          const di = this.nextElement(Reg.DI, 1);
          this.stringWrite = true;
          this.write8(Seg.ES, di, value);
          this.cycles += 4;
        }, false);
        this.cycles += 1;
        return;
      case 0xa5:
        this.string(() => {
          const value = this.read16(this.stringSeg, this.nextElement(Reg.SI, 2));
          const di = this.nextElement(Reg.DI, 2);
          this.stringWrite = true;
          this.write16(Seg.ES, di, value);
          this.cycles += 4;
        }, false);
        this.cycles += 1;
        return;
      case 0xa6:
        this.string(() => {
          // The 286 reads ES:DI first.
          const b = this.read8(Seg.ES, this.nextElement(Reg.DI, 1));
          this.countDown();
          const a = this.read8(this.stringSeg, this.nextElement(Reg.SI, 1));
          this.alu8(7, a, b);
          this.cycles += 9;
        }, true, true);
        return;
      case 0xa7:
        this.string(() => {
          const b = this.read16(Seg.ES, this.nextElement(Reg.DI, 2));
          this.countDown();
          const a = this.read16(this.stringSeg, this.nextElement(Reg.SI, 2));
          this.alu16(7, a, b);
          this.cycles += 9;
        }, true, true);
        return;
      case 0xa8:
        this.alu8(4, r[Reg.AX] & 0xff, this.fetch8());
        this.cycles += 3;
        return;
      case 0xa9:
        this.alu16(4, r[Reg.AX], this.fetch16());
        this.cycles += 3;
        return;
      case 0xaa:
        this.string(() => {
          this.stringWrite = true;
          this.write8(Seg.ES, this.nextElement(Reg.DI, 1), r[Reg.AX] & 0xff);
          this.cycles += 3;
        }, false);
        return;
      case 0xab:
        this.string(() => {
          this.stringWrite = true;
          this.write16(Seg.ES, this.nextElement(Reg.DI, 2), r[Reg.AX]);
          this.cycles += 3;
        }, false);
        return;
      case 0xac:
        this.string(() => {
          this.setReg8(0, this.read8(this.stringSeg, this.nextElement(Reg.SI, 1)));
          this.cycles += 5;
        }, false);
        return;
      case 0xad:
        this.string(() => {
          r[Reg.AX] = this.read16(this.stringSeg, this.nextElement(Reg.SI, 2));
          this.cycles += 5;
        }, false);
        return;
      case 0xae:
        this.string(() => {
          this.alu8(7, r[Reg.AX] & 0xff, this.read8(Seg.ES, this.nextElement(Reg.DI, 1)));
          this.cycles += 7;
        }, true);
        return;
      case 0xaf:
        this.string(() => {
          this.alu16(7, r[Reg.AX], this.read16(Seg.ES, this.nextElement(Reg.DI, 2)));
          this.cycles += 7;
        }, true);
        return;
      case 0xc0:
      case 0xd0:
      case 0xd2: {
        this.modrm();
        const value = this.readE8();
        const count = op === 0xc0 ? this.fetch8() : op === 0xd0 ? 1 : r[Reg.CX] & 0xff;
        this.writeE8(this.shift(this.regField, value, count, 8));
        this.cycles += this.mod === 3 ? 5 : 8;
        return;
      }
      case 0xc1:
      case 0xd1:
      case 0xd3: {
        this.modrm();
        const value = this.readE16();
        const count = op === 0xc1 ? this.fetch8() : op === 0xd1 ? 1 : r[Reg.CX] & 0xff;
        this.writeE16(this.shift(this.regField, value, count, 16));
        this.cycles += this.mod === 3 ? 5 : 8;
        return;
      }
      case 0xc2: {
        const release = this.fetch16();
        this.ip = this.pop16();
        r[Reg.SP] += release;
        this.cycles += 11;
        return;
      }
      case 0xc3:
        this.ip = this.pop16();
        this.cycles += 11;
        return;
      case 0xc4:
      case 0xc5: {
        this.modrm();
        this.requireMemory();
        const offset = this.readE16();
        const selector = this.readE16At(2);
        this.loadSegment(op === 0xc4 ? Seg.ES : Seg.DS, selector);
        r[this.regField] = offset;
        this.cycles += this.protectedMode ? 21 : 7;
        return;
      }
      case 0xc6:
        this.modrm();
        if (this.regField !== 0) throw new CpuFault(Vec.Invalid);
        this.writeE8(this.fetch8());
        this.cycles += 3;
        return;
      case 0xc7:
        this.modrm();
        if (this.regField !== 0) throw new CpuFault(Vec.Invalid);
        this.writeE16(this.fetch16());
        this.cycles += 3;
        return;
      case 0xc8:
        this.enter();
        return;
      case 0xc9: {
        const bp = r[Reg.BP];
        r[Reg.BP] = this.read16(Seg.SS, bp);
        r[Reg.SP] = bp + 2;
        this.cycles += 5;
        return;
      }
      case 0xca:
        this.farReturn(this.fetch16());
        this.cycles += 15;
        return;
      case 0xcb:
        this.farReturn(0);
        this.cycles += 15;
        return;
      case 0xcc:
        this.cycles += 23;
        this.softwareInterrupt(Vec.Breakpoint);
        return;
      case 0xcd: {
        const vector = this.fetch8();
        this.cycles += 23;
        this.softwareInterrupt(vector);
        return;
      }
      case 0xce:
        if (this.of) {
          this.cycles += 24;
          this.softwareInterrupt(Vec.Overflow);
        } else {
          this.cycles += 3;
        }
        return;
      case 0xcf:
        this.interruptReturn();
        this.cycles += 17;
        return;
      case 0xd4: {
        const base = this.fetch8();
        const al = r[Reg.AX] & 0xff;
        if (base === 0) {
          // The flags are already set from AL when the divide error is raised.
          this.zf = al === 0 ? 1 : 0;
          this.pf = PARITY[al];
          this.sf = this.cf = this.of = this.af = 0;
          throw new CpuFault(Vec.Divide);
        }
        r[Reg.AX] = (Math.floor(al / base) << 8) | al % base;
        this.szp8(r[Reg.AX] & 0xff);
        this.cf = this.of = this.af = 0;
        this.cycles += 16;
        return;
      }
      case 0xd5: {
        const base = this.fetch8();
        const ax = r[Reg.AX];
        const al = this.alu8(0, ax & 0xff, ((ax >> 8) * base) & 0xff);
        r[Reg.AX] = al;
        this.cycles += 14;
        return;
      }
      case 0xd6:
        this.setReg8(0, this.cf ? 0xff : 0);
        this.cycles += 3;
        return;
      case 0xd7:
        this.setReg8(0, this.read8(this.stringSeg, (r[Reg.BX] + (r[Reg.AX] & 0xff)) & 0xffff));
        this.cycles += 5;
        return;
      case 0xe0:
      case 0xe1:
      case 0xe2: {
        const displacement = this.fetchSigned8();
        r[Reg.CX]--;
        const go = r[Reg.CX] !== 0 && (op === 0xe2 || (op === 0xe1 ? this.zf === 1 : this.zf === 0));
        if (go) {
          this.ip = (this.ip + displacement) & 0xffff;
          this.cycles += 8;
        } else {
          this.cycles += 4;
        }
        return;
      }
      case 0xe3: {
        const displacement = this.fetchSigned8();
        if (r[Reg.CX] === 0) {
          this.ip = (this.ip + displacement) & 0xffff;
          this.cycles += 8;
        } else {
          this.cycles += 4;
        }
        return;
      }
      case 0xe4: {
        const port = this.fetch8();
        this.checkIo();
        this.setReg8(0, this.bus.in8(port));
        this.cycles += 5;
        return;
      }
      case 0xe5: {
        const port = this.fetch8();
        this.checkIo();
        r[Reg.AX] = this.bus.in16(port);
        this.cycles += 5;
        return;
      }
      case 0xe6: {
        const port = this.fetch8();
        this.checkIo();
        this.bus.out8(port, r[Reg.AX] & 0xff);
        this.cycles += 3;
        return;
      }
      case 0xe7: {
        const port = this.fetch8();
        this.checkIo();
        this.bus.out16(port, r[Reg.AX]);
        this.cycles += 3;
        return;
      }
      case 0xe8: {
        const displacement = this.fetch16();
        this.push16(this.ip);
        this.ip = (this.ip + displacement) & 0xffff;
        this.cycles += 7;
        return;
      }
      case 0xe9: {
        const displacement = this.fetch16();
        this.ip = (this.ip + displacement) & 0xffff;
        this.cycles += 7;
        return;
      }
      case 0xea: {
        const offset = this.fetch16();
        const selector = this.fetch16();
        this.farJump(selector, offset, false);
        this.cycles += 11;
        return;
      }
      case 0xeb: {
        const displacement = this.fetchSigned8();
        this.ip = (this.ip + displacement) & 0xffff;
        this.cycles += 7;
        return;
      }
      case 0xec:
        this.checkIo();
        this.setReg8(0, this.bus.in8(r[Reg.DX]));
        this.cycles += 5;
        return;
      case 0xed:
        this.checkIo();
        r[Reg.AX] = this.bus.in16(r[Reg.DX]);
        this.cycles += 5;
        return;
      case 0xee:
        this.checkIo();
        this.bus.out8(r[Reg.DX], r[Reg.AX] & 0xff);
        this.cycles += 3;
        return;
      case 0xef:
        this.checkIo();
        this.bus.out16(r[Reg.DX], r[Reg.AX]);
        this.cycles += 3;
        return;
      case 0xf4:
        if (this.protectedMode && this.cpl !== 0) throw gp(0);
        this.halted = true;
        this.cycles += 2;
        return;
      case 0xf5:
        this.cf ^= 1;
        this.cycles += 2;
        return;
      case 0xf6:
        this.modrm();
        this.group3Byte();
        return;
      case 0xf7:
        this.modrm();
        this.group3Word();
        return;
      case 0xf8:
      case 0xf9:
        this.cf = op & 1;
        this.cycles += 2;
        return;
      case 0xfa:
      case 0xfb:
        if (this.protectedMode && this.cpl > this.iopl) throw gp(0);
        this.ifl = op & 1;
        if (this.ifl) this.inhibit = true;
        this.cycles += 2;
        return;
      case 0xfc:
      case 0xfd:
        this.df = op & 1;
        this.cycles += 2;
        return;
      case 0xfe:
        this.modrm();
        if (this.regField > 1) throw new CpuFault(Vec.Invalid);
        this.writeE8(this.regField === 0 ? this.inc8(this.readE8()) : this.dec8(this.readE8()));
        this.cycles += this.mod === 3 ? 2 : 7;
        return;
      case 0xff:
        this.group5();
        return;
      default:
        throw new CpuFault(Vec.Invalid);
    }
  }

  private group5(): void {
    this.modrm();
    const r = this.regs;
    switch (this.regField) {
      case 0:
        this.writeE16(this.inc16(this.readE16()));
        this.cycles += this.mod === 3 ? 2 : 7;
        return;
      case 1:
        this.writeE16(this.dec16(this.readE16()));
        this.cycles += this.mod === 3 ? 2 : 7;
        return;
      case 2: {
        const target = this.readE16();
        this.push16(this.ip);
        this.ip = target;
        this.cycles += 7;
        return;
      }
      case 3: {
        this.requireMemory();
        const offset = this.readE16();
        const selector = this.readE16At(2);
        this.farJump(selector, offset, true);
        this.cycles += 16;
        return;
      }
      case 4:
        this.ip = this.readE16();
        this.cycles += 7;
        return;
      case 5: {
        this.requireMemory();
        const offset = this.readE16();
        const selector = this.readE16At(2);
        this.farJump(selector, offset, false);
        this.cycles += 15;
        return;
      }
      case 6:
        // PUSH SP pushes the value from before the push.
        this.push16(this.mod === 3 ? r[this.rm] : this.readE16());
        this.cycles += 5;
        return;
      default:
        throw new CpuFault(Vec.Invalid);
    }
  }

  private enter(): void {
    this.restoreSp = true;
    const r = this.regs;
    const size = this.fetch16();
    const level = this.fetch8() & 0x1f;
    this.push16(r[Reg.BP]);
    const frame = r[Reg.SP];
    if (level > 0) {
      let bp = r[Reg.BP];
      for (let i = 1; i < level; i++) {
        bp = (bp - 2) & 0xffff;
        this.push16(this.read16(Seg.SS, bp));
      }
      this.push16(frame);
    }
    r[Reg.BP] = frame;
    r[Reg.SP] -= size;
    this.cycles += 11 + 4 * level;
  }

  // --- BCD adjustments -----------------------------------------------------------------

  private daa(): void {
    const al = this.regs[Reg.AX] & 0xff;
    const cf = this.cf;
    let result = al;
    if ((al & 0xf) > 9 || this.af) {
      result += 6;
      this.af = 1;
    } else {
      this.af = 0;
    }
    if (al > 0x99 || cf) {
      result += 0x60;
      this.cf = 1;
    } else {
      this.cf = 0;
    }
    result &= 0xff;
    this.of = (~al & result & 0x80) >> 7;
    this.setReg8(0, result);
    this.szp8(result);
    this.cycles += 3;
  }

  private das(): void {
    const al = this.regs[Reg.AX] & 0xff;
    const cf = this.cf;
    let result = al;
    this.cf = 0;
    if ((al & 0xf) > 9 || this.af) {
      result -= 6;
      this.cf = cf | (result < 0 ? 1 : 0);
      this.af = 1;
    } else {
      this.af = 0;
    }
    if (al > 0x99 || cf) {
      result -= 0x60;
      this.cf = 1;
    }
    result &= 0xff;
    this.of = (al & ~result & 0x80) >> 7;
    this.setReg8(0, result);
    this.szp8(result);
    this.cycles += 3;
  }

  /** AAA and AAS: SF, ZF and PF come from AL after the adjustment, before its high nibble is cleared. */
  private aaa(): void {
    const r = this.regs;
    const al = r[Reg.AX] & 0xff;
    if ((al & 0xf) > 9 || this.af) {
      r[Reg.AX] += 0x106;
      this.af = this.cf = 1;
      this.of = (~al & (al + 6) & 0x80) >> 7;
    } else {
      this.af = this.cf = this.of = 0;
    }
    this.szp8(r[Reg.AX] & 0xff);
    r[Reg.AX] &= 0xff0f;
    this.cycles += 3;
  }

  private aas(): void {
    const r = this.regs;
    const al = r[Reg.AX] & 0xff;
    if ((al & 0xf) > 9 || this.af) {
      r[Reg.AX] -= 6;
      r[Reg.AX] -= 0x100;
      this.af = this.cf = 1;
      this.of = (al & ~(al - 6) & 0x80) >> 7;
    } else {
      this.af = this.cf = this.of = 0;
    }
    this.szp8(r[Reg.AX] & 0xff);
    r[Reg.AX] &= 0xff0f;
    this.cycles += 3;
  }

  // --- The 0F instructions -------------------------------------------------------------

  private extended(): void {
    const op = this.fetch8();
    const r = this.regs;
    switch (op) {
      case 0x00: {
        if (!this.protectedMode) throw new CpuFault(Vec.Invalid);
        this.modrm();
        switch (this.regField) {
          case 0:
            this.writeE16(this.ldtSelector);
            break;
          case 1:
            this.writeE16(this.trSelector);
            break;
          case 2:
            if (this.cpl !== 0) throw gp(0);
            this.loadLdt(this.readE16());
            break;
          case 3:
            if (this.cpl !== 0) throw gp(0);
            this.loadTr(this.readE16());
            break;
          case 4:
          case 5:
            this.zf = this.verify(this.readE16(), this.regField === 5) ? 1 : 0;
            break;
          default:
            throw new CpuFault(Vec.Invalid);
        }
        this.cycles += 17;
        return;
      }
      case 0x01: {
        this.modrm();
        switch (this.regField) {
          case 0:
          case 1: {
            this.requireMemory();
            const limit = this.regField === 0 ? this.gdtLimit : this.idtLimit;
            const base = this.regField === 0 ? this.gdtBase : this.idtBase;
            this.write16(this.eaSeg, this.eaOff, limit);
            this.write16(this.eaSeg, (this.eaOff + 2) & 0xffff, base & 0xffff);
            // The 286 stores FFh in the byte above its 24-bit base.
            this.write16(this.eaSeg, (this.eaOff + 4) & 0xffff, 0xff00 | (base >> 16));
            break;
          }
          case 2:
          case 3: {
            this.requireMemory();
            if (this.protectedMode && this.cpl !== 0) throw gp(0);
            const limit = this.readE16();
            const base = this.readE16At(2) | ((this.readE16At(4) & 0xff) << 16);
            if (this.regField === 2) {
              this.gdtLimit = limit;
              this.gdtBase = base;
            } else {
              this.idtLimit = limit;
              this.idtBase = base;
            }
            break;
          }
          case 4:
            this.writeE16(0xfff0 | this.msw);
            break;
          case 6: {
            if (this.protectedMode && this.cpl !== 0) throw gp(0);
            const value = this.readE16() & 0xf;
            // LMSW can switch protected mode on but not off.
            this.msw = value | (this.msw & Msw.PE);
            break;
          }
          default:
            throw new CpuFault(Vec.Invalid);
        }
        this.cycles += 11;
        return;
      }
      case 0x02:
      case 0x03: {
        if (!this.protectedMode) throw new CpuFault(Vec.Invalid);
        this.modrm();
        const selector = this.readE16();
        const result = this.loadAccessRights(selector, op === 0x03);
        if (result === null) {
          this.zf = 0;
        } else {
          r[this.regField] = result;
          this.zf = 1;
        }
        this.cycles += 14;
        return;
      }
      case 0x05:
        if (this.protectedMode && this.cpl !== 0) throw gp(0);
        this.loadAll();
        this.cycles += 195;
        return;
      case 0x06:
        if (this.protectedMode && this.cpl !== 0) throw gp(0);
        this.msw &= ~Msw.TS;
        this.cycles += 2;
        return;
      default:
        throw new CpuFault(Vec.Invalid);
    }
  }

  /** LOADALL: every register and descriptor cache from the table at physical 800h. */
  private loadAll(): void {
    const bus = this.bus;
    const w = (offset: number) => bus.read16(0x800 + offset);
    this.msw = (this.msw & Msw.PE) | (w(0x06) & 0xf);
    this.trSelector = w(0x16);
    // Set the mode first, so FLAGS loads IOPL and NT when it is protected.
    this.setFlags(w(0x18));
    this.iopl = (w(0x18) >> 12) & 3;
    this.nt = (w(0x18) >> 14) & 1;
    this.ip = w(0x1a);
    this.ldtSelector = w(0x1c);
    this.sreg[Seg.DS] = w(0x1e);
    this.sreg[Seg.SS] = w(0x20);
    this.sreg[Seg.CS] = w(0x22);
    this.sreg[Seg.ES] = w(0x24);
    const order = [Reg.DI, Reg.SI, Reg.BP, Reg.SP, Reg.BX, Reg.DX, Reg.CX, Reg.AX];
    order.forEach((reg, i) => (this.regs[reg] = w(0x26 + i * 2)));
    const cache = (offset: number) => ({
      base: w(offset) | ((w(offset + 2) & 0xff) << 16),
      rights: w(offset + 2) >> 8,
      limit: w(offset + 4),
    });
    [Seg.ES, Seg.CS, Seg.SS, Seg.DS].forEach((seg, i) => {
      const entry = cache(0x36 + i * 6);
      this.segBase[seg] = entry.base;
      this.segRights[seg] = entry.rights;
      this.segLimit[seg] = entry.limit;
    });
    const gdt = cache(0x4e);
    this.gdtBase = gdt.base;
    this.gdtLimit = gdt.limit;
    const ldt = cache(0x54);
    this.ldtBase = ldt.base;
    this.ldtRights = ldt.rights;
    this.ldtLimit = ldt.limit;
    const idt = cache(0x5a);
    this.idtBase = idt.base;
    this.idtLimit = idt.limit;
    const tss = cache(0x60);
    this.trBase = tss.base;
    this.trRights = tss.rights;
    this.trLimit = tss.limit;
    this.cpl = this.protectedMode ? (this.segRights[Seg.CS] >> 5) & 3 : 0;
  }

  // --- Descriptors ---------------------------------------------------------------------

  /** Reads the descriptor a selector points to, or raises #GP(selector) if it is outside its table. */
  private fetchDescriptor(selector: number, into: Descriptor = this.desc): Descriptor {
    const index = selector & 0xfff8;
    let base: number;
    if (selector & 4) {
      if (this.ldtRights === 0 || index + 7 > this.ldtLimit) throw gp(selector & 0xfffc);
      base = this.ldtBase;
    } else {
      if (index + 7 > this.gdtLimit) throw gp(selector & 0xfffc);
      base = this.gdtBase;
    }
    const address = (base + index) & 0xffffff;
    this.readDescriptorAt(address, into);
    return into;
  }

  private readDescriptorAt(address: number, into: Descriptor): void {
    const bus = this.bus;
    const w0 = bus.read16(address);
    const w1 = bus.read16(address + 2);
    const w2 = bus.read16(address + 4);
    into.address = address;
    into.limit = w0;
    into.base = w1 | ((w2 & 0xff) << 16);
    into.rights = w2 >> 8;
    into.selector = w1;
    into.count = w2 & 0x1f;
  }

  private setAccessed(d: Descriptor): void {
    if (!(d.rights & Acc.Accessed)) {
      d.rights |= Acc.Accessed;
      this.bus.write8(d.address + 5, d.rights);
    }
  }

  private loadRealSegment(seg: number, selector: number): void {
    this.sreg[seg] = selector;
    this.segBase[seg] = selector << 4;
  }

  /** MOV, POP, LDS and LES into a segment register, with the protected mode checks. */
  loadSegment(seg: number, selector: number): void {
    if (!this.protectedMode) {
      this.loadRealSegment(seg, selector);
      return;
    }
    if ((selector & 0xfffc) === 0) {
      if (seg === Seg.SS) throw gp(0);
      this.sreg[seg] = selector;
      this.segBase[seg] = 0;
      this.segLimit[seg] = 0;
      this.segRights[seg] = 0;
      return;
    }
    const d = this.fetchDescriptor(selector);
    const rights = d.rights;
    const dpl = (rights >> 5) & 3;
    const rpl = selector & 3;
    const code = selector & 0xfffc;
    if (seg === Seg.SS) {
      if ((rights & (Acc.Segment | Acc.Code | Acc.ReadWrite)) !== (Acc.Segment | Acc.ReadWrite) || rpl !== this.cpl || dpl !== this.cpl) {
        throw gp(code);
      }
      if (!(rights & Acc.Present)) throw new CpuFault(Vec.Stack, code);
    } else {
      if (!(rights & Acc.Segment) || (rights & (Acc.Code | Acc.ReadWrite)) === Acc.Code) throw gp(code);
      const conformingCode = (rights & (Acc.Code | Acc.Direction)) === (Acc.Code | Acc.Direction);
      if (!conformingCode && (dpl < this.cpl || dpl < rpl)) throw gp(code);
      if (!(rights & Acc.Present)) throw new CpuFault(Vec.NotPresent, code);
    }
    this.setAccessed(d);
    this.sreg[seg] = selector;
    this.segBase[seg] = d.base;
    this.segLimit[seg] = d.limit;
    this.segRights[seg] = d.rights;
  }

  private loadCs(selector: number, d: Descriptor, cpl: number): void {
    this.setAccessed(d);
    this.sreg[Seg.CS] = (selector & 0xfffc) | cpl;
    this.segBase[Seg.CS] = d.base;
    this.segLimit[Seg.CS] = d.limit;
    this.segRights[Seg.CS] = d.rights;
    this.cpl = cpl;
  }

  /** Checks a code segment descriptor for a far transfer to it at privilege `cpl` or inward. */
  private checkCodeSegment(selector: number, d: Descriptor): void {
    if ((d.rights & (Acc.Segment | Acc.Code)) !== (Acc.Segment | Acc.Code)) throw gp(selector & 0xfffc);
  }

  /** A stack for privilege level `level` from the current TSS, checked; loads it and returns the old SS:SP. */
  private switchStack(level: number): [number, number] {
    const at = this.trBase + 2 + level * 4;
    const sp = this.bus.read16(at);
    const ss = this.bus.read16(at + 2);
    if ((ss & 0xfffc) === 0) throw new CpuFault(Vec.InvalidTss, 0);
    const d = this.fetchDescriptor(ss, this.desc2);
    const rights = d.rights;
    if (
      (ss & 3) !== level ||
      ((rights >> 5) & 3) !== level ||
      (rights & (Acc.Segment | Acc.Code | Acc.ReadWrite)) !== (Acc.Segment | Acc.ReadWrite)
    ) {
      throw new CpuFault(Vec.InvalidTss, ss & 0xfffc);
    }
    if (!(rights & Acc.Present)) throw new CpuFault(Vec.Stack, ss & 0xfffc);
    const old: [number, number] = [this.sreg[Seg.SS], this.regs[Reg.SP]];
    this.setAccessed(d);
    this.sreg[Seg.SS] = ss;
    this.segBase[Seg.SS] = d.base;
    this.segLimit[Seg.SS] = d.limit;
    this.segRights[Seg.SS] = d.rights;
    this.regs[Reg.SP] = sp;
    return old;
  }

  /** JMP and CALL far: to a code segment, through a call gate, or to another task. */
  private farJump(selector: number, offset: number, call: boolean): void {
    if (!this.protectedMode) {
      if (call) {
        this.push16(this.sreg[Seg.CS]);
        this.push16(this.ip);
      }
      this.loadRealSegment(Seg.CS, selector);
      this.ip = offset;
      return;
    }
    if ((selector & 0xfffc) === 0) throw gp(0);
    const d = this.fetchDescriptor(selector);
    const rights = d.rights;
    const dpl = (rights >> 5) & 3;
    const rpl = selector & 3;
    const code = selector & 0xfffc;
    if (rights & Acc.Segment) {
      this.checkCodeSegment(selector, d);
      if (rights & Acc.Direction) {
        if (dpl > this.cpl) throw gp(code);
      } else if (rpl > this.cpl || dpl !== this.cpl) {
        throw gp(code);
      }
      if (!(rights & Acc.Present)) throw new CpuFault(Vec.NotPresent, code);
      if (offset > d.limit) throw gp(0);
      if (call) {
        this.push16(this.sreg[Seg.CS]);
        this.push16(this.ip);
      }
      this.loadCs(selector, d, this.cpl);
      this.ip = offset;
      return;
    }
    switch (rights & 0x1f) {
      case 4: {
        if (dpl < this.cpl || dpl < rpl) throw gp(code);
        if (!(rights & Acc.Present)) throw new CpuFault(Vec.NotPresent, code);
        const target = d.selector;
        const targetOffset = d.limit;
        const count = d.count;
        if ((target & 0xfffc) === 0) throw gp(0);
        const t = this.fetchDescriptor(target, this.desc);
        this.checkCodeSegment(target, t);
        const tdpl = (t.rights >> 5) & 3;
        if (tdpl > this.cpl) throw gp(target & 0xfffc);
        if (!(t.rights & Acc.Present)) throw new CpuFault(Vec.NotPresent, target & 0xfffc);
        if (targetOffset > t.limit) throw gp(0);
        const conforming = (t.rights & Acc.Direction) !== 0;
        if (call && !conforming && tdpl < this.cpl) {
          const target2 = { ...t };
          const oldSs = this.sreg[Seg.SS];
          const oldSpOffset = this.regs[Reg.SP];
          const params: number[] = [];
          for (let i = 0; i < count; i++) params.push(this.read16(Seg.SS, (oldSpOffset + i * 2) & 0xffff));
          this.cpl = tdpl;
          const [ss, sp] = this.switchStack(tdpl);
          this.push16(ss);
          this.push16(sp);
          for (let i = count - 1; i >= 0; i--) this.push16(params[i]);
          void oldSs;
          this.push16(this.sreg[Seg.CS]);
          this.push16(this.ip);
          this.loadCs(target, target2, tdpl);
          this.ip = targetOffset;
          this.cycles += 41 + 4 * count;
          return;
        }
        if (!call && !conforming && tdpl !== this.cpl) throw gp(target & 0xfffc);
        if (call) {
          this.push16(this.sreg[Seg.CS]);
          this.push16(this.ip);
        }
        this.loadCs(target, t, this.cpl);
        this.ip = targetOffset;
        return;
      }
      case 1:
        if (dpl < this.cpl || dpl < rpl) throw gp(code);
        this.switchTask(selector, call ? 'call' : 'jmp');
        return;
      case 5: {
        if (dpl < this.cpl || dpl < rpl) throw gp(code);
        if (!(rights & Acc.Present)) throw new CpuFault(Vec.NotPresent, code);
        this.switchTask(d.selector, call ? 'call' : 'jmp');
        return;
      }
      default:
        throw gp(code);
    }
  }

  /** RET far (releasing `release` bytes of parameters), possibly to an outer privilege level. */
  private farReturn(release: number): void {
    const r = this.regs;
    if (!this.protectedMode) {
      const ip = this.pop16();
      const cs = this.pop16();
      this.loadRealSegment(Seg.CS, cs);
      this.ip = ip;
      r[Reg.SP] += release;
      return;
    }
    const sp = r[Reg.SP];
    const offset = this.read16(Seg.SS, sp);
    const selector = this.read16(Seg.SS, (sp + 2) & 0xffff);
    this.returnTo(selector, offset, (sp + 4 + release) & 0xffff, release);
  }

  /** The checks and loads shared by RET far and IRET in protected mode. */
  private returnTo(selector: number, offset: number, spAfter: number, release: number): void {
    const r = this.regs;
    if ((selector & 0xfffc) === 0) throw gp(0);
    const d = this.fetchDescriptor(selector);
    this.checkCodeSegment(selector, d);
    const rpl = selector & 3;
    const dpl = (d.rights >> 5) & 3;
    const code = selector & 0xfffc;
    if (rpl < this.cpl) throw gp(code);
    if (d.rights & Acc.Direction ? dpl > rpl : dpl !== rpl) throw gp(code);
    if (!(d.rights & Acc.Present)) throw new CpuFault(Vec.NotPresent, code);
    if (offset > d.limit) throw gp(0);
    if (rpl === this.cpl) {
      r[Reg.SP] = spAfter;
      this.loadCs(selector, d, rpl);
      this.ip = offset;
      return;
    }
    // To an outer level: its SS:SP follow on the stack.
    const newSp = this.read16(Seg.SS, spAfter);
    const newSs = this.read16(Seg.SS, (spAfter + 2) & 0xffff);
    const cs = { ...d };
    this.cpl = rpl;
    this.loadSegment(Seg.SS, newSs);
    r[Reg.SP] = newSp + release;
    this.loadCs(selector, cs, rpl);
    this.ip = offset;
    for (const seg of [Seg.ES, Seg.DS]) {
      const rights = this.segRights[seg];
      const conformingCode = (rights & (Acc.Code | Acc.Direction)) === (Acc.Code | Acc.Direction);
      if (rights !== 0 && !conformingCode && ((rights >> 5) & 3) < rpl) {
        this.sreg[seg] = 0;
        this.segRights[seg] = 0;
      }
    }
  }

  private interruptReturn(): void {
    const r = this.regs;
    if (!this.protectedMode) {
      const ip = this.pop16();
      const cs = this.pop16();
      const flags = this.pop16();
      this.loadRealSegment(Seg.CS, cs);
      this.ip = ip;
      this.setFlags(flags);
      return;
    }
    if (this.nt) {
      const back = this.bus.read16(this.trBase);
      this.switchTask(back, 'iret');
      return;
    }
    const sp = r[Reg.SP];
    const offset = this.read16(Seg.SS, sp);
    const selector = this.read16(Seg.SS, (sp + 2) & 0xffff);
    const flags = this.read16(Seg.SS, (sp + 4) & 0xffff);
    const cpl = this.cpl;
    this.returnTo(selector, offset, (sp + 6) & 0xffff, 0);
    // FLAGS are checked against the privilege the IRET ran at.
    const level = this.cpl;
    this.cpl = cpl;
    this.popFlags(flags);
    this.cpl = level;
  }

  private protectedInterrupt(vector: number, software: boolean, code: number | null, external: boolean): void {
    const ext = external && !software ? 1 : 0;
    const gateCode = vector * 8 + 2 + ext;
    if (vector * 8 + 7 > this.idtLimit) throw gp(gateCode);
    const gate = this.desc;
    this.readDescriptorAt((this.idtBase + vector * 8) & 0xffffff, gate);
    const type = gate.rights & 0x1f;
    const dpl = (gate.rights >> 5) & 3;
    if (type !== 5 && type !== 6 && type !== 7) throw gp(gateCode);
    if (software && dpl < this.cpl) throw gp(gateCode);
    if (!(gate.rights & Acc.Present)) throw new CpuFault(Vec.NotPresent, gateCode);
    if (type === 5) {
      this.switchTask(gate.selector, 'int');
      if (code !== null) this.push16(code);
      return;
    }
    const target = gate.selector;
    const targetOffset = gate.limit;
    const interruptGate = type === 6;
    if ((target & 0xfffc) === 0) throw gp(ext);
    const t = this.fetchDescriptor(target, this.desc2);
    const targetCode = (target & 0xfffc) | ext;
    if ((t.rights & (Acc.Segment | Acc.Code)) !== (Acc.Segment | Acc.Code)) throw gp(targetCode);
    const tdpl = (t.rights >> 5) & 3;
    if (tdpl > this.cpl) throw gp(targetCode);
    if (!(t.rights & Acc.Present)) throw new CpuFault(Vec.NotPresent, targetCode);
    const cs = { ...t };
    const flags = this.flags;
    if (!(t.rights & Acc.Direction) && tdpl < this.cpl) {
      this.cpl = tdpl;
      const [ss, sp] = this.switchStack(tdpl);
      this.push16(ss);
      this.push16(sp);
    }
    this.push16(flags);
    this.push16(this.sreg[Seg.CS]);
    this.push16(this.ip);
    if (code !== null) this.push16(code);
    const level = t.rights & Acc.Direction ? this.cpl : tdpl;
    this.loadCs(target, cs, level);
    this.ip = targetOffset;
    this.tf = this.nt = 0;
    if (interruptGate) this.ifl = 0;
  }

  /** A task switch to the TSS `selector` (by JMP, CALL, INT or IRET), saving this task's state in its own TSS. */
  private switchTask(selector: number, reason: 'jmp' | 'call' | 'int' | 'iret'): void {
    if (selector & 4) throw gp(selector & 0xfffc);
    const d = this.fetchDescriptor(selector, this.desc2);
    const type = d.rights & 0x1f;
    const code = selector & 0xfffc;
    if (reason === 'iret' ? type !== 3 : type !== 1) throw gp(code);
    if (!(d.rights & Acc.Present)) throw new CpuFault(Vec.NotPresent, code);
    if (d.limit < 43) throw new CpuFault(Vec.InvalidTss, code);
    const bus = this.bus;
    const r = this.regs;
    // Save this task.
    const old = this.trBase;
    let oldFlags = this.flags;
    if (reason === 'iret') oldFlags &= ~0x4000;
    bus.write16(old + 14, this.ip);
    bus.write16(old + 16, oldFlags);
    for (let i = 0; i < 8; i++) bus.write16(old + 18 + i * 2, r[i]);
    for (let i = 0; i < 4; i++) bus.write16(old + 34 + i * 2, this.sreg[i]);
    if (reason === 'jmp' || reason === 'iret') this.setBusy(this.trSelector, false);
    const base = d.base;
    if (reason === 'call' || reason === 'int') bus.write16(base, this.trSelector);
    if (reason !== 'iret') this.setBusy(selector, true);
    this.trSelector = selector;
    this.trBase = base;
    this.trLimit = d.limit;
    this.trRights = (d.rights & ~0x1f) | 3;
    this.msw |= Msw.TS;
    // Load the new one.
    this.ip = bus.read16(base + 14);
    const flags = bus.read16(base + 16);
    this.setFlags(flags);
    if (reason === 'call' || reason === 'int') this.nt = 1;
    for (let i = 0; i < 8; i++) r[i] = bus.read16(base + 18 + i * 2);
    const selectors = [0, 1, 2, 3].map((i) => bus.read16(base + 34 + i * 2));
    this.loadLdt(bus.read16(base + 42));
    const cs = selectors[Seg.CS];
    const csd = this.fetchDescriptor(cs, this.desc);
    this.checkCodeSegment(cs, csd);
    if (!(csd.rights & Acc.Present)) throw new CpuFault(Vec.NotPresent, cs & 0xfffc);
    this.loadCs(cs, csd, cs & 3);
    this.loadSegment(Seg.SS, selectors[Seg.SS]);
    this.loadSegment(Seg.DS, selectors[Seg.DS]);
    this.loadSegment(Seg.ES, selectors[Seg.ES]);
    this.cycles += 180;
  }

  private setBusy(selector: number, busy: boolean): void {
    const address = (this.gdtBase + (selector & 0xfff8) + 5) & 0xffffff;
    const rights = this.bus.read8(address);
    this.bus.write8(address, busy ? rights | 2 : rights & ~2);
  }

  private loadLdt(selector: number): void {
    if ((selector & 0xfffc) === 0) {
      this.ldtSelector = selector;
      this.ldtRights = 0;
      this.ldtBase = this.ldtLimit = 0;
      return;
    }
    if (selector & 4) throw gp(selector & 0xfffc);
    const d = this.fetchDescriptor(selector, this.desc2);
    if ((d.rights & 0x1f) !== 2) throw gp(selector & 0xfffc);
    if (!(d.rights & Acc.Present)) throw new CpuFault(Vec.NotPresent, selector & 0xfffc);
    this.ldtSelector = selector;
    this.ldtBase = d.base;
    this.ldtLimit = d.limit;
    this.ldtRights = d.rights;
  }

  private loadTr(selector: number): void {
    if ((selector & 0xfffc) === 0 || selector & 4) throw gp(selector & 0xfffc);
    const d = this.fetchDescriptor(selector, this.desc2);
    if ((d.rights & 0x1f) !== 1) throw gp(selector & 0xfffc);
    if (!(d.rights & Acc.Present)) throw new CpuFault(Vec.NotPresent, selector & 0xfffc);
    this.setBusy(selector, true);
    this.trSelector = selector;
    this.trBase = d.base;
    this.trLimit = d.limit;
    this.trRights = d.rights | 2;
  }

  /** Whether a descriptor can be seen at this privilege (for VERR, VERW, LAR and LSL); null when it can't. */
  private visibleDescriptor(selector: number): Descriptor | null {
    if ((selector & 0xfffc) === 0) return null;
    const index = selector & 0xfff8;
    const limit = selector & 4 ? (this.ldtRights ? this.ldtLimit : -1) : this.gdtLimit;
    if (index + 7 > limit) return null;
    const d = this.fetchDescriptor(selector, this.desc2);
    const dpl = (d.rights >> 5) & 3;
    const conformingCode = (d.rights & (Acc.Segment | Acc.Code | Acc.Direction)) === (Acc.Segment | Acc.Code | Acc.Direction);
    if (!conformingCode && (dpl < this.cpl || dpl < (selector & 3))) return null;
    return d;
  }

  private verify(selector: number, write: boolean): boolean {
    const d = this.visibleDescriptor(selector);
    if (!d || !(d.rights & Acc.Segment)) return false;
    if (write) return (d.rights & (Acc.Code | Acc.ReadWrite)) === Acc.ReadWrite;
    return (d.rights & (Acc.Code | Acc.ReadWrite)) !== Acc.Code;
  }

  /** LAR (rights in the high byte) and LSL (the limit). */
  private loadAccessRights(selector: number, limit: boolean): number | null {
    const d = this.visibleDescriptor(selector);
    if (!d) return null;
    if (!(d.rights & Acc.Segment)) {
      const type = d.rights & 0xf;
      const valid = limit ? type === 1 || type === 2 || type === 3 : type >= 1 && type <= 7;
      if (!valid) return null;
    }
    return limit ? d.limit : d.rights << 8;
  }
}
