/** Single-flight model inventory refresh with invalidation generation. */
export class ModelRefresh<T> {
  private generation = 0;
  private inFlight: Promise<T> | undefined;

  /** Invalidate in-flight or cached data. Older responses are discarded by callers. */
  invalidate(): void {
    this.generation++;
    this.inFlight = undefined;
  }

  /** Return one shared refresh result, retrying automatically after it settles. */
  run(load: () => Promise<T>): Promise<{ data: T; generation: number }> {
    const generation = this.generation;
    const task = this.inFlight ?? load().finally(() => {
      if (this.inFlight === task) this.inFlight = undefined;
    });
    this.inFlight = task;
    return task.then((data) => ({ data, generation }));
  }

  /** Whether a returned generation is still current. */
  current(generation: number): boolean {
    return generation === this.generation;
  }
}
