import { PIT_HZ } from '../chips/pit8254';

/** How loud the speaker is at full swing. */
const AMPLITUDE = 0.3;
/** The high-pass filter's pole: takes out DC so a speaker left high is silent, as a real cone is. */
const HIGH_PASS = 0.998;

/**
 * The PC speaker: a square wave from PIT counter 2 gated by port 61h, or
 * port 61h's data bit toggled directly by a program. Level changes are
 * timed in PIT clocks and averaged over each output sample.
 */
export class Speaker {
  private level = 0;
  /** PIT clock (fractional) where the current output sample began. */
  private sampleStart = 0;
  /** Time the speaker was high during the current sample, in PIT clocks. */
  private highTime = 0;
  private position = 0;
  private ticksPerSample = PIT_HZ / 48000;
  private lastInput = 0;
  private lastOutput = 0;
  private buffer = new Float32Array(8192);
  private count = 0;

  setSampleRate(rate: number): void {
    this.ticksPerSample = PIT_HZ / rate;
  }

  /** The speaker's level changes at PIT clock `tick`. */
  set(high: boolean, tick: number): void {
    const level = high ? 1 : 0;
    if (level === this.level) return;
    this.advanceTo(tick);
    this.level = level;
  }

  /** Produces the samples up to PIT clock `tick`. */
  advanceTo(tick: number): void {
    while (tick > this.position) {
      const sampleEnd = this.sampleStart + this.ticksPerSample;
      const until = Math.min(tick, sampleEnd);
      if (this.level) this.highTime += until - this.position;
      this.position = until;
      if (until >= sampleEnd) {
        this.emit(this.highTime / this.ticksPerSample);
        this.sampleStart = sampleEnd;
        this.highTime = 0;
      }
    }
  }

  private emit(value: number): void {
    const output = value - this.lastInput + HIGH_PASS * this.lastOutput;
    this.lastInput = value;
    this.lastOutput = output;
    if (this.count + 2 > this.buffer.length) {
      const bigger = new Float32Array(this.buffer.length * 2);
      bigger.set(this.buffer);
      this.buffer = bigger;
    }
    const sample = output * AMPLITUDE;
    this.buffer[this.count++] = sample;
    this.buffer[this.count++] = sample;
  }

  /** The stereo samples (left, right interleaved) made since the last call. */
  takeSamples(): Float32Array {
    const samples = this.buffer.slice(0, this.count);
    this.count = 0;
    return samples;
  }

  /** Forgets timing (after a power cycle, when the PIT's clock count restarts). */
  restart(tick: number): void {
    this.position = this.sampleStart = tick;
    this.highTime = 0;
    this.count = 0;
  }
}
