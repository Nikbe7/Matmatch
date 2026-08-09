import { describe, expect, it } from "vitest";
import {
  dinersParameter,
  everyone,
  rosterFingerprint,
  toggleDiner,
  type DinerLabel,
} from "./diners";

// The diner set's pure rules (#112). The picker's own rendering is covered in
// DinerPicker.test.tsx; what matters here is that the default is everyone, that the
// last diner cannot be deselected, and that an untouched session sends nothing.

describe("everyone", () => {
  it("selects every position", () => {
    expect(everyone(3)).toEqual(new Set([0, 1, 2]));
  });

  it("is empty only for an empty roster", () => {
    expect(everyone(0)).toEqual(new Set());
    expect(everyone(1)).toEqual(new Set([0]));
  });
});

describe("toggleDiner", () => {
  it("deselects a member who is currently eating", () => {
    expect(toggleDiner(new Set([0, 1, 2]), 1)).toEqual(new Set([0, 2]));
  });

  it("reselects a member who is not", () => {
    expect(toggleDiner(new Set([0, 2]), 1)).toEqual(new Set([0, 1, 2]));
  });

  it("refuses to deselect the last remaining diner", () => {
    const last = new Set([1]);

    // The same set back, not an empty one: "nobody is eating" is not a state this
    // control can reach. The server would read it as everyone anyway — this keeps the
    // screen from showing a selection that means something different from what the
    // request means.
    expect(toggleDiner(last, 1)).toBe(last);
  });

  it("still allows selecting a second member from a single-diner state", () => {
    expect(toggleDiner(new Set([1]), 0)).toEqual(new Set([0, 1]));
  });

  it("never produces an empty selection, over an exhaustive tap sequence", () => {
    let selection = everyone(4);

    // Every member deselected in turn, twice around, in every starting position.
    for (let round = 0; round < 2; round += 1) {
      for (let index = 0; index < 4; index += 1) {
        selection = toggleDiner(selection, index);
        expect(selection.size).toBeGreaterThan(0);
      }
    }
  });

  it("does not mutate the set it is given", () => {
    const before = new Set([0, 1]);
    toggleDiner(before, 0);

    expect(before).toEqual(new Set([0, 1]));
  });
});

describe("dinersParameter", () => {
  it("is undefined when everyone is eating, so an untouched session sends nothing", () => {
    // The default is expressed by absence, not by a client restatement of it: the
    // server's own fail-closed default is what answers.
    expect(dinersParameter(everyone(3), 3)).toBeUndefined();
  });

  it("is undefined for a roster the client does not know yet", () => {
    expect(dinersParameter(new Set(), 0)).toBeUndefined();
  });

  it("lists the selected positions, sorted", () => {
    expect(dinersParameter(new Set([2, 0]), 3)).toBe("0,2");
  });

  it("is stable regardless of the order members were tapped in", () => {
    expect(dinersParameter(new Set([2, 0]), 4)).toBe(dinersParameter(new Set([0, 2]), 4));
  });

  it("handles a single remaining diner", () => {
    expect(dinersParameter(new Set([1]), 2)).toBe("1");
  });
});

describe("rosterFingerprint", () => {
  const roster: DinerLabel[] = [{ label: "Niklas" }, { label: "Barn 1" }];

  it("is stable for the same roster", () => {
    expect(rosterFingerprint(roster)).toBe(rosterFingerprint([...roster]));
  });

  // Each of these is an edit that can silently change who index 1 refers to. A member
  // *is* its index (DECISION_LOG 2026-08-09), so all of them must invalidate a
  // selection rather than let it be reinterpreted against a different person.
  it.each([
    { name: "a member added", roster: [...roster, { label: "Vuxen 2" }] },
    { name: "a member removed", roster: [roster[0]!] },
    { name: "members reordered", roster: [roster[1]!, roster[0]!] },
    { name: "a member renamed", roster: [{ label: "Niklas" }, { label: "Elsa" }] },
  ])("changes when $name", ({ roster: changed }) => {
    expect(rosterFingerprint(changed)).not.toBe(rosterFingerprint(roster));
  });

  it("distinguishes an unknown roster from an empty one", () => {
    expect(rosterFingerprint(undefined)).not.toBe(rosterFingerprint([]));
  });
});
