import { useCallback, useState } from "react";

// First-run state for the guided walkthrough. It lives entirely in the browser:
// no backend flag, no migration. `done` ends the walkthrough for good; `begun`
// records that a fresh organizer has already started it, so a space they create
// mid-walkthrough does not read as a pre-existing space and cut them off.
const DONE = "atl:first-run-done";
const BEGUN = "atl:first-run-begun";

function read(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function write(key: string): void {
  try {
    localStorage.setItem(key, "1");
  } catch {
    // Private mode or storage disabled: the walkthrough simply stays skippable.
  }
}

export function isWalkthroughDone(): boolean {
  return read(DONE);
}

export function hasWalkthroughBegun(): boolean {
  return read(BEGUN);
}

export function beginWalkthrough(): void {
  write(BEGUN);
}

export function finishWalkthrough(): void {
  write(DONE);
}

/**
 * Reactive first-run state for one screen. `active` is true only for a signed-in
 * organizer who has not yet finished the walkthrough. `finish` marks first
 * success (or a skip) and hides it everywhere from then on.
 */
export function useFirstRun(organizer: boolean): {
  active: boolean;
  finish: () => void;
} {
  const [done, setDone] = useState(() => !organizer || isWalkthroughDone());
  const finish = useCallback(() => {
    finishWalkthrough();
    setDone(true);
  }, []);
  return { active: !done, finish };
}
