/**
 * In-memory File System Access API directory for tests (not a test file
 * itself: only `*.test.ts` files are run).
 */

function namedError(name: string, message = name) {
  return Object.assign(new Error(message), { name });
}

export interface MemoryFsOptions {
  /** Fail writes to files whose name matches. */
  failWrite?: (name: string) => boolean;
  permission?: PermissionState;
  requestedPermission?: PermissionState;
}

export class MemoryFileHandle {
  readonly kind = 'file';
  data = new Blob([]);
  constructor(readonly name: string, private readonly options: MemoryFsOptions, readonly events: string[]) {}

  async createWritable(options: { keepExistingData?: boolean } = {}) {
    let next: Blob = options.keepExistingData ? this.data : new Blob([]);
    let closed = false;
    return {
      write: async (data: Blob | Uint8Array | { type: 'write'; position: number; data: Blob | Uint8Array }) => {
        if (this.options.failWrite?.(this.name)) throw namedError('QuotaExceededError', `Disk full writing ${this.name}`);
        if (data && typeof data === 'object' && 'type' in data && (data as { type: string }).type === 'write' && 'position' in data) {
          const chunk = data.data instanceof Blob ? data.data : new Blob([data.data as Uint8Array<ArrayBuffer>]);
          const position = data.position;
          next = new Blob([next.slice(0, position), chunk, next.slice(position + chunk.size)]);
          return;
        }
        const chunk = data instanceof Blob ? data : new Blob([data as Uint8Array<ArrayBuffer>]);
        next = new Blob([next, chunk]);
      },
      close: async () => {
        if (closed) return;
        closed = true;
        this.data = next;
        this.events.push(`close:${this.name}`);
      },
      abort: async () => { closed = true; },
    };
  }

  async getFile() {
    return new File([this.data], this.name, { type: '' });
  }
}

export class MemoryDirectoryHandle {
  readonly kind = 'directory';
  readonly directories = new Map<string, MemoryDirectoryHandle>();
  readonly files = new Map<string, MemoryFileHandle>();
  constructor(readonly name: string, readonly options: MemoryFsOptions = {}, readonly events: string[] = []) {}

  async getDirectoryHandle(name: string, options: { create?: boolean } = {}): Promise<MemoryDirectoryHandle> {
    if (this.files.has(name)) throw namedError('TypeMismatchError');
    let directory = this.directories.get(name);
    if (!directory) {
      if (!options.create) throw namedError('NotFoundError');
      directory = new MemoryDirectoryHandle(name, this.options, this.events);
      this.directories.set(name, directory);
    }
    return directory;
  }

  async getFileHandle(name: string, options: { create?: boolean } = {}): Promise<MemoryFileHandle> {
    if (this.directories.has(name)) throw namedError('TypeMismatchError');
    let file = this.files.get(name);
    if (!file) {
      if (!options.create) throw namedError('NotFoundError');
      file = new MemoryFileHandle(name, this.options, this.events);
      this.files.set(name, file);
    }
    return file;
  }

  async removeEntry(name: string) {
    if (!this.directories.delete(name) && !this.files.delete(name)) throw namedError('NotFoundError');
  }

  async *keys(): AsyncIterableIterator<string> {
    for (const name of this.directories.keys()) yield name;
    for (const name of this.files.keys()) yield name;
  }

  async queryPermission(): Promise<PermissionState> {
    return this.options.permission ?? 'granted';
  }

  async requestPermission(): Promise<PermissionState> {
    const next = this.options.requestedPermission ?? 'granted';
    this.options.permission = next;
    return next;
  }

  /** Walk a "a/b/c" path. */
  async readFile(path: string): Promise<Blob> {
    const parts = path.split('/');
    let directory: MemoryDirectoryHandle = this;
    for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part);
    return (await directory.getFileHandle(parts[parts.length - 1])).data;
  }

  list(): string[] {
    const out: string[] = [];
    const walk = (directory: MemoryDirectoryHandle, prefix: string) => {
      for (const [name, child] of directory.directories) walk(child, `${prefix}${name}/`);
      for (const name of directory.files.keys()) out.push(`${prefix}${name}`);
    };
    walk(this, '');
    return out.sort();
  }
}

export async function blobText(blob: Blob): Promise<string> {
  return new TextDecoder().decode(await blob.arrayBuffer());
}
