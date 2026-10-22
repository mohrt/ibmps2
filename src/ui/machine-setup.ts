import { isZip, readZip } from '../drive/zip';
import type { MemorySize } from '../ps2';
import { BIOS_BYTES, identifyBios, isHalfBios, joinSplitBios, rankBioses, type Bios, type SystemRomStore } from '../roms/system-roms';

/** Files worth looking at in a zip: BIOS-sized (whole, half or an overdump), or another zip. */
function interesting(name: string, size: number): boolean {
  const base = name.split('/').pop()!;
  if (base.startsWith('.') || name.startsWith('__MACOSX/')) return false;
  if (base.toLowerCase().endsWith('.zip')) return true;
  return size === BIOS_BYTES || size === BIOS_BYTES / 2 || size === BIOS_BYTES * 2;
}

/** ROM collections often hold a zip per machine, so zips are opened this many levels down. */
const MAX_ZIP_DEPTH = 3;

async function expand(file: File, depth = 0): Promise<File[]> {
  const data = new Uint8Array(await file.arrayBuffer());
  if (!isZip(data)) return [file];
  if (depth >= MAX_ZIP_DEPTH) return [];
  const entries = readZip(data).filter((entry) => interesting(entry.name, entry.size));
  const files: File[] = [];
  for (const entry of entries) {
    // Keep the folder in the name: a ROM collection's machines are told apart by it.
    files.push(...(await expand(new File([new Uint8Array(await entry.read())], entry.name), depth + 1)));
  }
  if (depth === 0 && files.length === 0) throw new Error(`${file.name} has no BIOS ROM in it.`);
  return files;
}

/** The first few problems, so a whole collection of unsuitable ROMs doesn't fill the panel. */
function summarise(errors: string[]): string {
  const shown = errors.slice(0, 3).join(' ');
  return errors.length > 3 ? `${shown} (and ${errors.length - 3} more files that aren't usable)` : shown;
}

/** How the machine is built; changing any of it means switching off and on. */
export interface MachineChoices {
  memory: MemorySize;
  secondDrive: boolean;
}

export const DEFAULT_CHOICES: MachineChoices = { memory: 2, secondDrive: false };

export interface MachineSetupOptions {
  /** Opened from a running machine: offers Back (resolves null) and restarts rather than starts. */
  whileRunning?: boolean;
  choices: MachineChoices;
}

export interface MachineSetup {
  bios: Bios;
  choices: MachineChoices;
}

/**
 * Shows Machine setup in place of the screen: the BIOS (asked for on the
 * first visit), the memory and the second floppy drive. Resolves when the
 * user starts or restarts the PS/2, or with null if they went back to the
 * running machine instead (which changes nothing but the ROM kept in the
 * browser).
 */
export function askForMachine(root: HTMLElement, store: SystemRomStore, initial: Bios | null, options: MachineSetupOptions): Promise<MachineSetup | null> {
  const query = <T extends HTMLElement>(selector: string) => {
    const element = root.querySelector<T>(selector);
    if (!element) throw new Error(`Machine setup is missing ${selector}`);
    return element;
  };
  const fileInput = query<HTMLInputElement>('input[name="rom-files"]');
  const memorySelect = query<HTMLSelectElement>('select[name="memory"]');
  const secondDrive = query<HTMLInputElement>('input[name="second-drive"]');
  const startButton = query<HTMLButtonElement>('[data-action="start"]');
  const backButton = query<HTMLButtonElement>('[data-action="back"]');
  const forgetButton = query<HTMLButtonElement>('[data-action="forget-roms"]');
  const message = query<HTMLElement>('.rom-message');
  const heading = query<HTMLElement>('h1');
  const row = query<HTMLElement>('[data-rom="bios"]');
  const status = row.querySelector<HTMLElement>('.rom-status')!;
  const choiceRow = query<HTMLElement>('.rom-choice');
  const choiceSelect = query<HTMLSelectElement>('select[name="bios-choice"]');
  heading.textContent = options.whileRunning ? 'Machine setup' : 'First, load the PS/2 BIOS';
  startButton.textContent = options.whileRunning ? 'Restart the PS/2 with these settings' : 'Switch the PS/2 on';
  memorySelect.value = String(options.choices.memory);
  secondDrive.checked = options.choices.secondDrive;
  backButton.hidden = !options.whileRunning;
  message.textContent = '';
  let bios = initial;
  /** One half of a BIOS dumped from its two chips, waiting for the other. */
  let half: File | null = null;
  /** The BIOSes to switch between, when several came together (best first). */
  let choices: Bios[] = [];
  const listeners = new AbortController();

  const render = () => {
    row.dataset.state = bios ? (bios.warning ? 'warning' : 'loaded') : 'missing';
    status.textContent = bios
      ? `Loaded: ${bios.title}, from ${bios.name.split('/').pop()}${bios.warning ? ` (${bios.warning})` : ''}`
      : 'Not loaded yet';
    startButton.disabled = !bios;
    forgetButton.hidden = !bios;
    choiceRow.hidden = choices.length < 2;
    choiceSelect.replaceChildren(
      ...choices.map((choice, i) => {
        const option = document.createElement('option');
        option.value = String(i);
        option.textContent = choice.title;
        option.selected = !!bios && choice.title === bios.title && choice.data.length === bios.data.length;
        return option;
      }),
    );
  };

  const use = async (rom: Bios) => {
    bios = rom;
    await store.save(rom);
  };

  const addFiles = async (chosen: File[]) => {
    const errors: string[] = [];
    const files: File[] = [];
    for (const file of chosen) {
      try {
        files.push(...(await expand(file)));
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    const found: Bios[] = [];
    for (const file of files) {
      const data = new Uint8Array(await file.arrayBuffer());
      try {
        if (isHalfBios(data)) {
          if (!half) {
            half = file;
            errors.push(`${file.name} looks like half of a BIOS dumped from its two chips; add the other half too.`);
            continue;
          }
          const joined = joinSplitBios(new Uint8Array(await half.arrayBuffer()), data);
          if (!joined) throw new Error(`${half.name} and ${file.name} don't make a BIOS together.`);
          found.push(identifyBios(`${half.name} + ${file.name}`, joined));
          half = null;
          continue;
        }
        found.push(identifyBios(file.name, data));
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (found.length > 0) {
      // In a collection, the other machines' ROMs don't matter once one fits.
      choices = rankBioses(found);
      await store.saveChoices(choices.length > 1 ? choices : []);
      await use(choices[0]);
      half = null;
      errors.length = 0;
    }
    message.textContent = summarise(errors);
    render();
  };

  choiceSelect.addEventListener(
    'change',
    () => {
      const choice = choices[Number(choiceSelect.value)];
      if (choice) void use(choice).then(render);
    },
    { signal: listeners.signal },
  );
  void store.loadChoices().then((stored) => {
    choices = stored;
    render();
  });

  root.querySelectorAll<HTMLButtonElement>('[data-action="choose-roms"]').forEach((button) =>
    button.addEventListener('click', () => fileInput.click(), { signal: listeners.signal }),
  );
  fileInput.addEventListener(
    'change',
    () => {
      const files = [...(fileInput.files ?? [])];
      fileInput.value = '';
      void addFiles(files);
    },
    { signal: listeners.signal },
  );
  forgetButton.addEventListener(
    'click',
    () => {
      bios = null;
      half = null;
      choices = [];
      message.textContent = '';
      void store.forget().then(render);
    },
    { signal: listeners.signal },
  );

  // Captured and stopped so the disk panel's page-wide drop handling doesn't also see ROM files.
  const dragOptions = { signal: listeners.signal, capture: true };
  const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;
  let dragDepth = 0;
  window.addEventListener(
    'dragenter',
    (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      dragDepth++;
      root.classList.add('drag-over');
    },
    dragOptions,
  );
  window.addEventListener(
    'dragover',
    (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    },
    dragOptions,
  );
  window.addEventListener(
    'dragleave',
    (event) => {
      if (!hasFiles(event)) return;
      event.stopImmediatePropagation();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) root.classList.remove('drag-over');
    },
    dragOptions,
  );
  window.addEventListener(
    'drop',
    (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      dragDepth = 0;
      root.classList.remove('drag-over');
      void addFiles([...(event.dataTransfer?.files ?? [])]);
    },
    dragOptions,
  );

  document.body.classList.add('needs-roms');
  root.hidden = false;
  render();
  root.scrollIntoView({ block: 'start' });

  return new Promise((resolve) => {
    const close = (result: MachineSetup | null) => {
      listeners.abort();
      root.hidden = true;
      document.body.classList.remove('needs-roms');
      resolve(result);
    };
    const current = (): MachineChoices => ({
      memory: (Number(memorySelect.value) || 2) as MemorySize,
      secondDrive: secondDrive.checked,
    });
    startButton.addEventListener(
      'click',
      () => {
        if (bios) close({ bios, choices: current() });
      },
      { signal: listeners.signal },
    );
    backButton.addEventListener('click', () => close(null), { signal: listeners.signal });
  });
}
