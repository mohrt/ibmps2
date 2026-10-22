import { CPU_HZ, Ps2 } from './ps2';
import type { Screen } from './render/screen';

/** Longest gap we catch up on, so a backgrounded tab doesn't run a burst of frames. */
const MAX_CATCH_UP_MS = 100;
/** While warping, each animation frame emulates for this long. */
const WARP_BUDGET_MS = 14;
const WARP_STEP = CPU_HZ / 200;

/** Glues the PS/2 to the screen and the speaker, and runs it in step with real time. */
export class Emulator {
  readonly machine = new Ps2();
  /** Run flat out through the power-on self test. */
  fastStartup = true;
  private clockDebt = 0;
  private warping = false;

  constructor(screen: Screen) {
    this.machine.vga.onFrame = (framebuffer, width, height) => screen.capture(framebuffer, width, height);
  }

  get warped(): boolean {
    return this.warping;
  }

  /** Forgets time owed, e.g. after a pause, so the machine doesn't race to catch up. */
  resetTiming(): void {
    this.clockDebt = 0;
  }

  /** Runs the PS/2 for `elapsedMs` of real time, or as much as fits in a frame while starting up. */
  run(elapsedMs: number): void {
    const machine = this.machine;
    this.warping = this.fastStartup && machine.starting;
    if (this.warping) {
      const stopAt = performance.now() + WARP_BUDGET_MS;
      while (performance.now() < stopAt && machine.starting) machine.run(WARP_STEP);
      this.clockDebt = 0;
      return;
    }
    this.clockDebt += (Math.min(elapsedMs, MAX_CATCH_UP_MS) * CPU_HZ) / 1000;
    const start = machine.cpu.cycles;
    machine.run(Math.floor(this.clockDebt));
    this.clockDebt -= machine.cpu.cycles - start;
  }

  takeAudioSamples(): Float32Array {
    return this.machine.speaker.takeSamples();
  }
}
