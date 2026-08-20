import { describe, expect, it } from "vitest";
import { EffortLevelSchema } from "../schema/recipeTemplate.js";
import { loadEngineData } from "../engine/data.js";
import { structuralCoverageIds, structuralEffortLevel } from "./effortLevelHeuristic.js";

// #151 — the structural cross-check, tested against the real catalog for the same
// reason src/engine/preferenceWeights.test.ts is: the claim being made ("this
// heuristic covers the library and roughly agrees with the curated values") is a
// claim about the real 170 templates, not a synthetic fixture.

const data = await loadEngineData();

describe("structuralEffortLevel", () => {
  it("has an opinion on every template currently in the catalog", () => {
    const coverage = new Set(structuralCoverageIds());
    const missing = data.templates.filter((t) => !coverage.has(t.id)).map((t) => t.id);
    expect(missing).toEqual([]);
  });

  it("never opines on a template the catalog doesn't have — the table only grows forward", () => {
    const templateIds = new Set(data.templates.map((t) => t.id));
    const stale = structuralCoverageIds().filter((id) => !templateIds.has(id));
    expect(stale).toEqual([]);
  });

  it("always returns one of the three curated levels, for every template", () => {
    for (const template of data.templates) {
      const level = structuralEffortLevel(template);
      expect(EffortLevelSchema.options).toContain(level);
    }
  });

  it("is a pure function of the template — the same input always gives the same answer", () => {
    for (const template of data.templates) {
      expect(structuralEffortLevel(template)).toBe(structuralEffortLevel(template));
    }
  });

  it("agrees with the curated value for at least 70% of the library", () => {
    // The DECISION_LOG method: disagreement is expected and useful (it is what the
    // manual-review list is built from), but a heuristic that disagreed with the
    // curated pass on most of the catalog would not be a cross-check worth keeping.
    // 12.9% disagreed at curation time (22 of 170, all reported in DECISION_LOG) —
    // this asserts the broad agreement, not the exact count, so a template added
    // later doesn't make this test brittle.
    const agreements = data.templates.filter(
      (t) => structuralEffortLevel(t) === t.effort_level,
    ).length;
    expect(agreements / data.templates.length).toBeGreaterThanOrEqual(0.7);
  });
});

describe("effort_level is not a second read of prep_time_band (#151)", () => {
  // The whole reason a naive heuristic keyed on time was rejected before this file
  // was written: a stew that simmers unattended for 40 minutes is not more effort
  // than a fast plate with three separately-cooked components, and calibrating
  // against time would make "Enkelt" redundant with "Tid" rather than a real axis
  // of its own. This is the check that a future edit hasn't quietly re-introduced
  // that coupling by re-deriving effort_level from time in some other pass.

  it("has a simple dish in the 40min+ band and a project dish under 20 minutes", () => {
    // If either direction were empty, "slow but simple" or "fast but a project"
    // would no longer be expressible, which is exactly the collapse this axis
    // exists to avoid.
    const slowButSimple = data.templates.some(
      (t) => t.prep_time_band === "40min+" && t.effort_level === "simple",
    );
    const fastButProject = data.templates.some(
      (t) => t.prep_time_band === "<20min" && t.effort_level === "project",
    );
    expect(slowButSimple).toBe(true);
    expect(fastButProject).toBe(true);
  });

  it("does not concentrate any one prep_time_band inside a single effort_level", () => {
    // A collapsed axis would show up here as one band owning nearly all of one
    // level. 90% is deliberately loose — this guards against a full collapse, not
    // against the real, expected correlation (a `project` dish typically does take
    // longer than a `simple` one; DECISION_LOG's cross-tab reports the actual
    // spread, this just keeps it from going to zero).
    for (const level of EffortLevelSchema.options) {
      const rows = data.templates.filter((t) => t.effort_level === level);
      const byBand = new Map<string, number>();
      for (const row of rows) byBand.set(row.prep_time_band, (byBand.get(row.prep_time_band) ?? 0) + 1);
      const dominant = Math.max(...byBand.values());
      expect(dominant / rows.length).toBeLessThan(0.9);
    }
  });
});

describe("RecipeTemplate.effort_level — coverage over the real catalog (#151)", () => {
  it("gives every template a curated value — the schema enforces this, this is belt-and-braces", () => {
    const missing = data.templates.filter((t) => !EffortLevelSchema.options.includes(t.effort_level));
    expect(missing).toEqual([]);
  });

  it("uses all three levels — no level is empty", () => {
    for (const level of EffortLevelSchema.options) {
      const count = data.templates.filter((t) => t.effort_level === level).length;
      expect(count).toBeGreaterThan(0);
    }
  });

  it("keeps every level under 70% of the library — no level has collapsed the axis", () => {
    // The stop-and-report threshold from the curation method (DECISION_LOG): a
    // slider whose curated data sits almost entirely in one band is not a real axis.
    for (const level of EffortLevelSchema.options) {
      const count = data.templates.filter((t) => t.effort_level === level).length;
      expect(count / data.templates.length).toBeLessThan(0.7);
    }
  });
});
