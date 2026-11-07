/**
 * Minimal external store for useSyncExternalStore. Studio-level players keep
 * their state here so playback outlives their panels, and only the panel that
 * shows the state re-renders on progress ticks (not the whole studio).
 */
export class StateStore<TState extends object> {
  private listeners = new Set<() => void>();

  constructor(protected state: TState) {}

  readonly getSnapshot = (): TState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  protected setState(patch: Partial<TState>): void {
    let changed = false;
    for (const key of Object.keys(patch) as Array<keyof TState>) {
      if (!Object.is(this.state[key], patch[key])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of Array.from(this.listeners)) listener();
  }
}
