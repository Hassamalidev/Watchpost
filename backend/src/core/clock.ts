/* Injected time source (PRODUCT.md §7.11): services call clock.now(), never new Date(). */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/* A controllable clock for tests. */
export function createFakeClock(start: Date | string = "2026-01-01T00:00:00Z") {
  let current = new Date(start);
  return {
    now: () => new Date(current),
    set(value: Date | string) {
      current = new Date(value);
    },
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
}
