import type { Machine } from '../machine';

/** Mouse counts per pixel the pointer moves (the PS/2 mouse counts 4 a millimetre by default). */
const MOUSE_SCALE = 1;

/** True when a key press belongs to a form field rather than the PS/2. */
function typingInField(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  return !!target && (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName));
}

/**
 * The browser's keyboard and mouse, wired to the PS/2: keys type on its
 * keyboard (with the browser's key repeat as the typematic repeat), and
 * the mouse is captured by clicking the screen (Esc lets it go).
 */
export class BrowserInput {
  private mouseCaptured = false;
  /** Called when the mouse is captured or let go, so the page can say how to get it back. */
  onMouseCapture: (captured: boolean) => void = () => {};

  constructor(
    private readonly machine: Machine,
    private readonly canvas: HTMLCanvasElement,
  ) {}

  attach(target: Window): void {
    target.addEventListener('keydown', (event) => this.onKey(event, true));
    target.addEventListener('keyup', (event) => this.onKey(event, false));
    target.addEventListener('blur', () => this.releaseAll());

    this.canvas.addEventListener('mousedown', (event) => {
      if (!this.mouseCaptured) {
        // Only the PS/2s and PS/1 have a mouse port.
        if (this.machine.kbc.hasAux) void this.canvas.requestPointerLock?.();
        return;
      }
      this.setButton(event.button, true);
      event.preventDefault();
    });
    target.addEventListener('mouseup', (event) => {
      if (this.mouseCaptured) this.setButton(event.button, false);
    });
    this.canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    target.addEventListener('mousemove', (event) => {
      if (this.mouseCaptured) this.machine.kbc.mouse.move(event.movementX * MOUSE_SCALE, event.movementY * MOUSE_SCALE);
    });
    document.addEventListener('pointerlockchange', () => {
      this.mouseCaptured = document.pointerLockElement === this.canvas;
      if (!this.mouseCaptured) this.releaseMouse();
      this.onMouseCapture(this.mouseCaptured);
    });
  }

  private releaseMouse(): void {
    const mouse = this.machine.kbc.mouse;
    mouse.left = mouse.right = mouse.middle = false;
  }

  private setButton(button: number, down: boolean): void {
    const mouse = this.machine.kbc.mouse;
    if (button === 0) mouse.left = down;
    else if (button === 2) mouse.right = down;
    else if (button === 1) mouse.middle = down;
  }

  private releaseAll(): void {
    this.machine.kbc.keyboard.releaseAll();
    this.releaseMouse();
  }

  /** Presses Ctrl-Alt-Del (which browsers keep for themselves). */
  ctrlAltDel(): void {
    const keyboard = this.machine.kbc.keyboard;
    for (const code of ['ControlLeft', 'AltLeft', 'Delete']) keyboard.press(code);
    setTimeout(() => {
      for (const code of ['Delete', 'AltLeft', 'ControlLeft']) keyboard.release(code);
    }, 150);
  }

  private onKey(event: KeyboardEvent, down: boolean): void {
    if (typingInField(event)) return;
    if (event.metaKey && !['MetaLeft', 'MetaRight'].includes(event.code)) return;
    const keyboard = this.machine.kbc.keyboard;
    const handled = down ? keyboard.press(event.code) : keyboard.release(event.code);
    if (handled) event.preventDefault();
  }
}
