import { isZip, readZip } from '../drive/zip';
import { MODELS, memoryLabel, modelSpec, type ModelId, type ModelSpec } from '../models';
import { ROM_SIZES, type AssembledRom, type RomLibrary } from '../roms/rom-library';

/** Files worth looking at in a zip: ROM-sized, or another zip. */
function interesting(name: string, size: number): boolean {
  const base = name.split('/').pop()!;
  if (base.startsWith('.') || name.startsWith('__MACOSX/')) return false;
  if (base.toLowerCase().endsWith('.zip')) return true;
  return ROM_SIZES.has(size);
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
  if (depth === 0 && files.length === 0) throw new Error(`${file.name} has no ROM in it.`);
  return files;
}

/** The first few problems, so a whole collection of unsuitable ROMs doesn't fill the panel. */
function summarise(errors: string[]): string {
  const shown = errors.slice(0, 3).join(' ');
  return errors.length > 3 ? `${shown} (and ${errors.length - 3} more files that aren't usable)` : shown;
}

/** How the machine is built; changing any of it means switching off and on. */
export interface MachineChoices {
  model: ModelId;
  /** In KB. */
  memory: number;
  secondDrive: boolean;
}

export const DEFAULT_CHOICES: MachineChoices = { model: 'm30-286', memory: 2048, secondDrive: false };

/** Choices as remembered, made sense of: earlier versions had only the Model 30 286, with its memory in MB. */
export function readChoices(stored: { model?: string; memory?: number; secondDrive?: boolean }): MachineChoices {
  const model = modelSpec(stored.model);
  let memory = Number(stored.memory) || 0;
  if (!stored.model && memory > 0 && memory <= 16) memory *= 1024;
  return {
    model: model.id,
    memory: model.memoryChoices.includes(memory) ? memory : model.defaultMemory,
    secondDrive: stored.secondDrive === true,
  };
}

/** A machine's ROM image and the extra ROMs it needs, ready to load. */
export interface MachineRoms {
  rom: AssembledRom;
  extras: Map<string, AssembledRom>;
}

/** The ROMs for a model, or null if any are missing. */
export async function romsFor(library: RomLibrary, model: ModelSpec): Promise<MachineRoms | null> {
  const rom = await library.assemble(model.id);
  if (!rom) return null;
  const extras = new Map<string, AssembledRom>();
  for (const name of model.extraRoms) {
    const extra = await library.assemble(name);
    if (!extra) return null;
    extras.set(name, extra);
  }
  return { rom, extras };
}

export interface MachineSetupOptions {
  /** Opened from a running machine: offers Back (resolves null) and restarts rather than starts. */
  whileRunning?: boolean;
  choices: MachineChoices;
}

export interface MachineSetup {
  choices: MachineChoices;
  roms: MachineRoms;
}

const EXTRA_NAMES: Record<string, string> = { 'cga-font': 'character ROM' };
const fileName = (path: string) => path.split('/').pop()!;

/**
 * Shows Machine setup in place of the screen: the model, its ROMs (asked for
 * on the first visit), the memory and the second floppy drive. Resolves when
 * the user starts or restarts the machine, or with null if they went back to
 * the running one instead (which changes nothing but the ROMs kept in the
 * browser).
 */
export function askForMachine(root: HTMLElement, library: RomLibrary, options: MachineSetupOptions): Promise<MachineSetup | null> {
  const query = <T extends HTMLElement>(selector: string) => {
    const element = root.querySelector<T>(selector);
    if (!element) throw new Error(`Machine setup is missing ${selector}`);
    return element;
  };
  const fileInput = query<HTMLInputElement>('input[name="rom-files"]');
  const modelSelect = query<HTMLSelectElement>('select[name="model"]');
  const memorySelect = query<HTMLSelectElement>('select[name="memory"]');
  const secondDrive = query<HTMLInputElement>('input[name="second-drive"]');
  const startButton = query<HTMLButtonElement>('[data-action="start"]');
  const backButton = query<HTMLButtonElement>('[data-action="back"]');
  const forgetButton = query<HTMLButtonElement>('[data-action="forget-roms"]');
  const message = query<HTMLElement>('.rom-message');
  const heading = query<HTMLElement>('h1');
  const row = query<HTMLElement>('[data-rom="bios"]');
  const romTitle = row.querySelector<HTMLElement>('.rom-title')!;
  const romDetail = row.querySelector<HTMLElement>('.rom-detail')!;
  const status = row.querySelector<HTMLElement>('.rom-status')!;
  heading.textContent = options.whileRunning ? 'Machine setup' : 'First, load the ROMs';
  backButton.hidden = !options.whileRunning;
  secondDrive.checked = options.choices.secondDrive;
  message.textContent = '';
  let model = modelSpec(options.choices.model);
  let memory = options.choices.memory;
  let roms: MachineRoms | null = null;
  /** The models whose ROMs are all here. */
  let ready = new Set<string>();
  const listeners = new AbortController();

  const fillMemory = () => {
    if (!model.memoryChoices.includes(memory)) memory = model.defaultMemory;
    memorySelect.replaceChildren(
      ...model.memoryChoices.map((kilobytes) => {
        const option = document.createElement('option');
        option.value = String(kilobytes);
        option.textContent = memoryLabel(kilobytes);
        option.selected = kilobytes === memory;
        return option;
      }),
    );
  };

  const render = () => {
    modelSelect.replaceChildren(
      ...MODELS.map((spec) => {
        const option = document.createElement('option');
        option.value = spec.id;
        option.textContent = `${spec.name}, ${spec.year}${ready.has(spec.id) ? '' : ' (ROMs needed)'}`;
        option.selected = spec.id === model.id;
        return option;
      }),
    );
    romTitle.textContent = `${model.name} ROMs`;
    romDetail.textContent = model.romHint;
    row.dataset.state = roms ? (roms.rom.warning ? 'warning' : 'loaded') : 'missing';
    if (roms) {
      const extras = [...roms.extras.entries()].map(([name, extra]) => `the ${EXTRA_NAMES[name] ?? name} from ${fileName(extra.sources[0])}`);
      const from = [roms.rom.sources.map(fileName).join(' and '), ...extras].join(', ');
      status.textContent = `Loaded: ${roms.rom.title}, from ${from}${roms.rom.warning ? ` (${roms.rom.warning})` : ''}`;
    } else {
      status.textContent = 'Not loaded yet';
    }
    const machine = model.name.replace(/^IBM /, '');
    startButton.textContent = options.whileRunning ? `Restart as the ${machine}` : `Switch the ${machine} on`;
    startButton.disabled = !roms;
    forgetButton.hidden = ready.size === 0;
  };

  const refresh = async () => {
    const available = await library.available();
    ready = new Set(MODELS.filter((spec) => available.has(spec.id) && spec.extraRoms.every((name) => available.has(name))).map((spec) => spec.id));
    roms = await romsFor(library, model);
    render();
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
    const given = await Promise.all(files.map(async (file) => ({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) })));
    errors.push(...(await library.add(given, model.id)));
    await refresh();
    // In a collection, the files for other machines don't matter once this one's are here.
    message.textContent = given.length > 0 && ready.has(model.id) ? '' : summarise(errors);
  };

  modelSelect.addEventListener(
    'change',
    () => {
      model = modelSpec(modelSelect.value);
      fillMemory();
      message.textContent = '';
      void refresh();
    },
    { signal: listeners.signal },
  );
  memorySelect.addEventListener('change', () => (memory = Number(memorySelect.value)), { signal: listeners.signal });

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
      message.textContent = '';
      void library.forget().then(refresh);
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
  fillMemory();
  render();
  void refresh();
  root.scrollIntoView({ block: 'start' });

  return new Promise((resolve) => {
    const close = (result: MachineSetup | null) => {
      listeners.abort();
      root.hidden = true;
      document.body.classList.remove('needs-roms');
      resolve(result);
    };
    startButton.addEventListener(
      'click',
      () => {
        if (roms) close({ choices: { model: model.id, memory, secondDrive: secondDrive.checked }, roms });
      },
      { signal: listeners.signal },
    );
    backButton.addEventListener('click', () => close(null), { signal: listeners.signal });
  });
}
