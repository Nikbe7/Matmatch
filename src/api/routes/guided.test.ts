import type { Express } from "express";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createTokenVerifier } from "../../auth/verifyToken.js";
import type { Sql } from "../../db/client.js";
import {
  LOCAL_ISSUER,
  LOCAL_JWKS_URL,
  appClient,
  bypassClient,
  createTestUser,
  isLocalStackAvailable,
} from "../../db/__fixtures__/localStack.js";
import { loadEngineData } from "../../engine/data.js";
import type { EngineData } from "../../engine/data.js";
import { makeEngineData, makeIngredient, makeTemplate } from "../../engine/__fixtures__/engineData.js";
import { createApp } from "../app.js";
import { MAIN_INGREDIENT_GRID_SIZE, PANTRY_GRID_SIZE } from "../guidedCatalog.js";

// GET /api/guided/options and GET /api/guided/directions (UX_FLOW §5), against the
// real local Supabase stack — real database, real auth, no mocks. Selection
// behaviour is covered exhaustively in src/engine/directions.test.ts; what these
// tests prove is the wiring: the request parameters reach the engine, the household
// on the row is the one that constrains the answer, the empty states come back as
// answers rather than errors, and the pantry input touches no storage at all.

const stackAvailable = await isLocalStackAvailable();
const engineData: EngineData = await loadEngineData();

let sql: Sql | undefined;
let admin: Sql | undefined;
let verifyToken: ReturnType<typeof createTokenVerifier> | undefined;

if (stackAvailable) {
  sql = appClient();
  admin = bypassClient();
  verifyToken = createTokenVerifier({
    jwksUrl: LOCAL_JWKS_URL,
    issuer: LOCAL_ISSUER,
    audience: "authenticated",
  });
}

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await admin?.end({ timeout: 5 });
});

function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

/** The real catalog, deliberately: this flow's failure modes are data-shaped. */
function buildApp(data: EngineData = engineData): Express {
  return createApp({ sql: sql!, engineData: data, verifyToken: verifyToken! });
}

const adultOnly = {
  members: [{ type: "adult", portion_factor: 1 }],
  allergies: [],
  dietary_flags: [],
};

async function userWithHousehold(app: Express, household: object = adultOnly) {
  const user = await createTestUser();
  const created = await request(app)
    .post("/api/households")
    .set(authHeader(user.accessToken))
    .send(household);
  expect(created.status).toBe(201);
  return user;
}

function directions(app: Express, token: string, query: Record<string, string>) {
  return request(app)
    .get("/api/guided/directions")
    .query(query)
    .set(authHeader(token));
}

describe.skipIf(!stackAvailable)("GET /api/guided/options", () => {
  it("returns 401 without a token", async () => {
    const response = await request(buildApp()).get("/api/guided/options");

    expect(response.status).toBe(401);
  });

  it("returns 404 when the user has no household — the grids are that household's", async () => {
    const app = buildApp();
    const user = await createTestUser();

    const response = await request(app).get("/api/guided/options").set(authHeader(user.accessToken));

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("household_not_found");
  });

  it("returns both tapable grids, resolved to Swedish names", async () => {
    const app = buildApp();
    const user = await userWithHousehold(app);

    const response = await request(app).get("/api/guided/options").set(authHeader(user.accessToken));

    expect(response.status).toBe(200);
    expect(response.body.mainIngredients).toHaveLength(MAIN_INGREDIENT_GRID_SIZE);
    expect(response.body.pantryIngredients).toHaveLength(PANTRY_GRID_SIZE);
    for (const option of [...response.body.mainIngredients, ...response.body.pantryIngredients]) {
      expect(typeof option.id).toBe("string");
      expect(typeof option.name).toBe("string");
      expect(Object.keys(option).sort()).toEqual(["id", "name"]);
    }
  });

  it("offers proteins as main ingredients and never repeats them in the pantry grid", async () => {
    const app = buildApp();
    const user = await userWithHousehold(app);

    const response = await request(app).get("/api/guided/options").set(authHeader(user.accessToken));

    const mainIds: string[] = response.body.mainIngredients.map((o: { id: string }) => o.id);
    const pantryIds: string[] = response.body.pantryIngredients.map((o: { id: string }) => o.id);

    for (const id of mainIds) {
      expect(engineData.ingredientsById.get(id)?.category).toBe("protein");
    }
    expect(mainIds.filter((id) => pantryIds.includes(id))).toEqual([]);
  });

  it("is identical on every request — the grid must never shuffle under the household", async () => {
    const app = buildApp();
    const user = await userWithHousehold(app);

    const first = await request(app).get("/api/guided/options").set(authHeader(user.accessToken));
    const second = await request(app).get("/api/guided/options").set(authHeader(user.accessToken));

    expect(second.body).toEqual(first.body);
  });

  it("never offers a tap target the household could not be served", async () => {
    // Not a safety mechanism — the engine would refuse the dish anyway — but a grid
    // whose taps can only ever produce the §9 empty state is a grid of traps.
    const app = buildApp();
    const user = await userWithHousehold(app, {
      ...adultOnly,
      allergies: ["fish", "shellfish"],
    });

    const response = await request(app).get("/api/guided/options").set(authHeader(user.accessToken));

    const offered: string[] = [
      ...response.body.mainIngredients,
      ...response.body.pantryIngredients,
    ].map((option: { id: string }) => option.id);

    for (const id of offered) {
      const row = engineData.allergenMappingByIngredientId.get(id);
      expect(row?.allergens.includes("fish")).toBe(false);
      expect(row?.allergens.includes("shellfish")).toBe(false);
    }
    expect(offered).not.toContain("lax");
  });

  it("names 'lax' as fish-excluded for step 2's filter, but never lets it into the selectable grid", async () => {
    // The real catalog's exhaustive-across-the-vocabulary coverage is a unit test
    // (guidedCatalog.test.ts) against fixture data — the real catalog has no
    // verified protein excluded by tree_nuts or peanuts to exercise. This proves
    // the wiring against real data for the one allergy it can: fish.
    const app = buildApp();
    const user = await userWithHousehold(app, { ...adultOnly, allergies: ["fish"] });

    const response = await request(app).get("/api/guided/options").set(authHeader(user.accessToken));

    expect(response.status).toBe(200);
    const excluded = response.body.excludedMainIngredients as {
      id: string;
      name: string;
      allergies: string[];
    }[];
    const lax = excluded.find((option) => option.id === "lax");
    // Raw catalog casing — sentence-start capitalization is a client display concern.
    expect(lax).toEqual({ id: "lax", name: "lax", allergies: ["fish"] });

    const mainIds: string[] = response.body.mainIngredients.map((o: { id: string }) => o.id);
    const excludedIds = excluded.map((option) => option.id);
    expect(mainIds.filter((id) => excludedIds.includes(id))).toEqual([]);
  });

  it("is empty for a household with no allergies", async () => {
    const app = buildApp();
    const user = await userWithHousehold(app);

    const response = await request(app).get("/api/guided/options").set(authHeader(user.accessToken));

    expect(response.body.excludedMainIngredients).toEqual([]);
  });

  it("narrows the grid to what a constrained household can actually cook", async () => {
    const app = buildApp();
    const omnivore = await userWithHousehold(app);
    const vegan = await userWithHousehold(app, { ...adultOnly, dietary_flags: ["vegan"] });

    const forOmnivore = await request(app)
      .get("/api/guided/options")
      .set(authHeader(omnivore.accessToken));
    const forVegan = await request(app)
      .get("/api/guided/options")
      .set(authHeader(vegan.accessToken));

    const ids = (response: { body: { mainIngredients: { id: string }[] } }) =>
      response.body.mainIngredients.map((option) => option.id);

    expect(ids(forVegan)).not.toEqual(ids(forOmnivore));
    expect(ids(forVegan)).not.toContain("kycklingfile");
  });
});

describe.skipIf(!stackAvailable)("GET /api/guided/directions — request validation", () => {
  it("returns 401 without a token", async () => {
    const response = await request(buildApp())
      .get("/api/guided/directions")
      .query({ intent: "dinner_idea", main: "any" });

    expect(response.status).toBe(401);
  });

  it("returns 404 with a machine-readable code when the user has no household", async () => {
    const app = buildApp();
    const user = await createTestUser();

    const response = await directions(app, user.accessToken, { intent: "dinner_idea", main: "any" });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("household_not_found");
  });

  it("rejects an unknown intent rather than falling back to a default", async () => {
    const app = buildApp();
    const user = await userWithHousehold(app);

    const response = await directions(app, user.accessToken, { intent: "matlador", main: "any" });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("invalid_intent");
  });

  it("rejects a missing intent", async () => {
    const app = buildApp();
    const user = await userWithHousehold(app);

    const response = await directions(app, user.accessToken, { main: "any" });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("invalid_intent");
  });

  it("rejects a missing main parameter — it has no default meaning", async () => {
    const app = buildApp();
    const user = await userWithHousehold(app);

    const response = await directions(app, user.accessToken, { intent: "dinner_idea" });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("invalid_main");
  });

  it("rejects an unknown main ingredient id", async () => {
    const app = buildApp();
    const user = await userWithHousehold(app);

    const response = await directions(app, user.accessToken, {
      intent: "dinner_idea",
      main: "enhorningsfile",
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("invalid_main");
  });

  it("rejects an unknown pantry ingredient id — the catalog is closed, drift must be loud", async () => {
    const app = buildApp();
    const user = await userWithHousehold(app);

    const response = await directions(app, user.accessToken, {
      intent: "use_what_i_have",
      main: "any",
      pantry: "ris,manna-fran-himlen",
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("invalid_pantry");
  });

  it("accepts an empty pantry — skipping step 3 is allowed, not an error", async () => {
    const app = buildApp();
    const user = await userWithHousehold(app);

    const response = await directions(app, user.accessToken, {
      intent: "dinner_idea",
      main: "any",
      pantry: "",
    });

    expect(response.status).toBe(200);
    expect(response.body.directions.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!stackAvailable)("GET /api/guided/directions — the direction set", () => {
  it("returns exactly three cards with the shape the flow renders", async () => {
    const app = buildApp();
    const user = await userWithHousehold(app);

    const response = await directions(app, user.accessToken, {
      intent: "dinner_idea",
      main: "kycklingfile",
    });

    expect(response.status).toBe(200);
    expect(response.body.directions).toHaveLength(3);
    expect(response.body.mainIngredientId).toBe("kycklingfile");
    expect(response.body.portions).toBe(1);

    for (const direction of response.body.directions) {
      expect(typeof direction.template.id).toBe("string");
      expect(typeof direction.template.name).toBe("string");
      // The cost tier travels as the curated enum and is rendered as a dot meter by
      // the client — never a number, never a kronor figure, on either side.
      expect(["budget", "mid", "premium"]).toContain(direction.template.cost_tier);
      expect(typeof direction.summary).toBe("string");
      expect(direction.summary.length).toBeGreaterThan(0);
      expect(direction.ingredients.length).toBeGreaterThan(0);
      for (const ingredient of direction.ingredients) {
        expect(typeof ingredient.name).toBe("string");
        expect(typeof ingredient.inPantry).toBe("boolean");
      }
    }
  });

  it("never invents a price: no response field carries a currency figure", async () => {
    const app = buildApp();
    const user = await userWithHousehold(app);

    const response = await directions(app, user.accessToken, {
      intent: "cheap",
      main: "any",
    });

    expect(JSON.stringify(response.body)).not.toMatch(/kr\b|\bSEK\b/i);
  });

  it("only ever returns dishes containing the chosen main ingredient", async () => {
    const app = buildApp();
    const user = await userWithHousehold(app);

    const response = await directions(app, user.accessToken, {
      intent: "dinner_idea",
      main: "kycklingfile",
    });

    for (const direction of response.body.directions) {
      const ids = direction.template.ingredient_slots.map(
        (slot: { ingredient_id: string }) => slot.ingredient_id,
      );
      expect(ids).toContain("kycklingfile");
    }
  });

  it("lets the engine pick the main ingredient on 'auto' and says which it picked", async () => {
    const app = buildApp();
    const user = await userWithHousehold(app);

    const response = await directions(app, user.accessToken, {
      intent: "surprise_me",
      main: "auto",
    });

    expect(response.status).toBe(200);
    expect(engineData.ingredientsById.has(response.body.mainIngredientId)).toBe(true);
    expect(response.body.directions.length).toBeGreaterThan(0);
  });

  it("reports no main ingredient under 'any', the loosen path", async () => {
    const app = buildApp();
    const user = await userWithHousehold(app);

    const response = await directions(app, user.accessToken, { intent: "dinner_idea", main: "any" });

    expect(response.status).toBe(200);
    expect(response.body.mainIngredientId).toBeNull();
    expect(response.body.directions).toHaveLength(3);
  });

  it("marks the pantry ingredients a dish covers, for the shopping list's 'Har hemma' split", async () => {
    const app = buildApp();
    const user = await userWithHousehold(app);

    const response = await directions(app, user.accessToken, {
      intent: "use_what_i_have",
      main: "any",
      pantry: "ris,gul-lok,vitlok",
    });

    const marked = response.body.directions.flatMap((direction: { ingredients: { name: string; inPantry: boolean }[] }) =>
      direction.ingredients.filter((ingredient) => ingredient.inPantry),
    );
    expect(marked.length).toBeGreaterThan(0);
  });

  it("changes which directions surface when the household says what it has", async () => {
    const app = buildApp();
    const user = await userWithHousehold(app);

    const without = await directions(app, user.accessToken, { intent: "dinner_idea", main: "any" });
    const withPantry = await directions(app, user.accessToken, {
      intent: "use_what_i_have",
      main: "any",
      pantry: "risnudlar,sojagroddar,jordnotter",
    });

    const ids = (response: { body: { directions: { template: { id: string } }[] } }) =>
      response.body.directions.map((direction) => direction.template.id);

    expect(ids(withPantry)).not.toEqual(ids(without));
    // Every card in the pantry-aware set uses something the household already has.
    for (const direction of withPantry.body.directions) {
      expect(
        direction.ingredients.some((ingredient: { inPantry: boolean }) => ingredient.inPantry),
      ).toBe(true);
    }
  });

  it("makes 'Billigt' produce a cheaper set than 'Middagsidé' for the same household", async () => {
    const app = buildApp();
    const user = await userWithHousehold(app);

    const neutral = await directions(app, user.accessToken, { intent: "dinner_idea", main: "any" });
    const cheap = await directions(app, user.accessToken, { intent: "cheap", main: "any" });

    const rank = { budget: 0, mid: 1, premium: 2 } as const;
    const worst = (response: { body: { directions: { template: { cost_tier: keyof typeof rank } }[] } }) =>
      Math.max(...response.body.directions.map((d) => rank[d.template.cost_tier]));

    expect(worst(cheap)).toBeLessThan(worst(neutral));
  });

  it("makes 'Proteinrikt' prefer high-protein dishes without filtering the set down", async () => {
    const app = buildApp();
    const user = await userWithHousehold(app);

    const response = await directions(app, user.accessToken, {
      intent: "high_protein",
      main: "any",
    });

    expect(response.body.directions).toHaveLength(3);
    expect(response.body.directions[0].template.dietary_tags).toContain("high_protein_preference");
  });

  it("is deterministic: the same request twice gives the same three dishes", async () => {
    const app = buildApp();
    const user = await userWithHousehold(app);

    const query = { intent: "dinner_idea", main: "kycklingfile", pantry: "ris,gul-lok" };
    const first = await directions(app, user.accessToken, query);
    const second = await directions(app, user.accessToken, query);

    expect(second.body).toEqual(first.body);
  });
});

describe.skipIf(!stackAvailable)("GET /api/guided/directions — safety and household scoping", () => {
  it("never returns a dish an allergic household cannot eat", async () => {
    const app = buildApp();
    const user = await userWithHousehold(app, {
      ...adultOnly,
      allergies: ["gluten", "dairy_lactose", "shellfish", "fish", "egg", "soy", "peanuts", "tree_nuts"],
    });

    const response = await directions(app, user.accessToken, { intent: "dinner_idea", main: "any" });

    expect(response.status).toBe(200);
    for (const direction of response.body.directions) {
      for (const ingredient of direction.template.ingredient_slots) {
        const row = engineData.allergenMappingByIngredientId.get(ingredient.ingredient_id);
        const substituted = direction.substitutions.some(
          (substitution: { slot_index: number }) =>
            direction.template.ingredient_slots.indexOf(ingredient) === substitution.slot_index,
        );
        if (!substituted) expect(row?.allergens).toEqual([]);
      }
    }
  });

  it("never returns a non-vegan dish to a vegan household, whatever the intent", async () => {
    const app = buildApp();
    const user = await userWithHousehold(app, { ...adultOnly, dietary_flags: ["vegan"] });

    for (const intent of ["dinner_idea", "cheap", "use_what_i_have", "high_protein", "surprise_me"]) {
      const response = await directions(app, user.accessToken, { intent, main: "auto" });

      expect(response.status).toBe(200);
      for (const direction of response.body.directions) {
        expect(direction.template.dietary_tags).toContain("vegan");
      }
    }
  });

  it("answers from the caller's own household, not another user's", async () => {
    const app = buildApp();
    const omnivore = await userWithHousehold(app);
    const vegan = await userWithHousehold(app, { ...adultOnly, dietary_flags: ["vegan"] });

    const omnivoreResponse = await directions(app, omnivore.accessToken, {
      intent: "dinner_idea",
      main: "any",
    });
    const veganResponse = await directions(app, vegan.accessToken, {
      intent: "dinner_idea",
      main: "any",
    });

    for (const direction of veganResponse.body.directions) {
      expect(direction.template.dietary_tags).toContain("vegan");
    }
    expect(
      omnivoreResponse.body.directions.map((d: { template: { id: string } }) => d.template.id),
    ).not.toEqual(veganResponse.body.directions.map((d: { template: { id: string } }) => d.template.id));
  });

  it("scales portions from the caller's household composition", async () => {
    const app = buildApp();
    const user = await userWithHousehold(app, {
      ...adultOnly,
      members: [
        { type: "adult", portion_factor: 1 },
        { type: "adult", portion_factor: 1 },
        { type: "child", portion_factor: 0.5 },
      ],
    });

    const response = await directions(app, user.accessToken, { intent: "dinner_idea", main: "any" });

    expect(response.body.portions).toBe(2.5);
  });
});

describe.skipIf(!stackAvailable)("GET /api/guided/directions — empty states (UX_FLOW §9)", () => {
  it("answers 200 with 'no_directions' when a main ingredient leaves nothing, never an error", async () => {
    const app = buildApp();
    const user = await userWithHousehold(app, { ...adultOnly, dietary_flags: ["vegan"] });

    // A real combination a household can reach by tapping: vegan, plus a protein
    // from the grid that no vegan template uses.
    const response = await directions(app, user.accessToken, {
      intent: "dinner_idea",
      main: "kycklingfile",
    });

    expect(response.status).toBe(200);
    expect(response.body.directions).toEqual([]);
    expect(response.body.reason).toBe("no_directions");
    // Still carries portions, so the client never has to re-request to render the
    // loosen screen.
    expect(response.body.portions).toBe(1);
  });

  it("recovers from that empty state when the main-ingredient constraint is dropped", async () => {
    const app = buildApp();
    const user = await userWithHousehold(app, { ...adultOnly, dietary_flags: ["vegan"] });

    const stuck = await directions(app, user.accessToken, {
      intent: "dinner_idea",
      main: "kycklingfile",
    });
    const loosened = await directions(app, user.accessToken, { intent: "dinner_idea", main: "any" });

    expect(stuck.body.reason).toBe("no_directions");
    expect(loosened.body.directions.length).toBeGreaterThan(0);
  });

  it("distinguishes 'no_safe_templates' from 'no_directions' — they need different ways out", async () => {
    // Deliberately a fixture catalog, not the real one: today's 170 templates leave
    // even an all-eight-allergies vegan household 14 safe options, so the real data
    // cannot reach this branch. It stays reachable — one more allergy, one narrower
    // batch — and the client needs it to mean "loosen your household", not "loosen
    // your main ingredient", so the wiring is proven here rather than assumed.
    const meatOnly = makeEngineData({
      ingredients: [makeIngredient("notfars", { category: "protein" })],
      templates: [
        makeTemplate("kottfars", {
          ingredient_slots: [{ role: "protein", ingredient_id: "notfars", substitutable: false }],
        }),
      ],
    });
    const app = buildApp(meatOnly);
    const user = await userWithHousehold(app, { ...adultOnly, dietary_flags: ["vegan"] });

    const response = await directions(app, user.accessToken, { intent: "dinner_idea", main: "any" });

    expect(response.status).toBe(200);
    expect(response.body.directions).toEqual([]);
    expect(response.body.reason).toBe("no_safe_templates");
    expect(response.body.mainIngredientId).toBeNull();
  });

  it("reports 'no_directions', not 'no_safe_templates', when only the main ingredient is the problem", async () => {
    const app = buildApp();
    const user = await userWithHousehold(app, { ...adultOnly, dietary_flags: ["vegan"] });

    const response = await directions(app, user.accessToken, {
      intent: "dinner_idea",
      main: "entrecote",
    });

    expect(response.body.reason).toBe("no_directions");
  });

  it("never returns more cards than the household safely has", async () => {
    const app = buildApp();
    const user = await userWithHousehold(app, {
      ...adultOnly,
      allergies: ["gluten", "dairy_lactose", "egg", "soy"],
      dietary_flags: ["vegan"],
    });

    const response = await directions(app, user.accessToken, { intent: "dinner_idea", main: "any" });

    expect(response.status).toBe(200);
    expect(response.body.directions.length).toBeGreaterThan(0);
    expect(response.body.directions.length).toBeLessThanOrEqual(3);
  });
});

describe.skipIf(!stackAvailable)("pantry input is never persisted (CLAUDE.md non-negotiable)", () => {
  // Pantry input is session-scoped and ephemeral by decision, not by omission
  // (ARCHITECTURE §5's SessionPantryInput note). These tests exist so that adding
  // persistence has to break a test that says out loud why it must not be deleted:
  // a standing inventory goes stale, and nothing in MVP is allowed to keep one.

  it("writes no row to any table when the household submits a pantry", async () => {
    const app = buildApp();
    const user = await userWithHousehold(app);

    const countRows = async () => {
      const rows = await admin!<{ table_name: string; n: string }[]>`
        select relname as table_name, n_live_tup::text as n
        from pg_stat_user_tables
        where schemaname = 'public'
        order by relname
      `;
      // n_live_tup is an estimate, so the assertion below uses exact counts instead.
      return rows.map((row) => row.table_name);
    };

    const tables = await countRows();
    const before = new Map<string, string>();
    for (const table of tables) {
      const [row] = await admin!<{ n: string }[]>`select count(*)::text as n from ${admin!(table)}`;
      before.set(table, row!.n);
    }

    const response = await directions(app, user.accessToken, {
      intent: "use_what_i_have",
      main: "any",
      pantry: "ris,gul-lok,vitlok,matlagningsgradde,potatis",
    });
    expect(response.status).toBe(200);

    for (const table of tables) {
      const [row] = await admin!<{ n: string }[]>`select count(*)::text as n from ${admin!(table)}`;
      expect(`${table}=${row!.n}`).toBe(`${table}=${before.get(table)}`);
    }
  });

  it("stores no pantry ingredient id anywhere in the database, in any column", async () => {
    const app = buildApp();
    const user = await userWithHousehold(app);
    const pantry = ["ris", "gul-lok", "vitlok", "matlagningsgradde", "potatis"];

    await directions(app, user.accessToken, {
      intent: "use_what_i_have",
      main: "any",
      pantry: pantry.join(","),
    });

    // A blunt instrument on purpose: dump every row of every public table as text
    // and assert none of it mentions what the household said it had. This survives a
    // future schema change that a per-table assertion would quietly miss.
    const tables = await admin!<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
      order by table_name
    `;

    for (const { table_name } of tables) {
      const rows = await admin!<Record<string, unknown>[]>`select * from ${admin!(table_name)}`;
      const dumped = JSON.stringify(rows);
      for (const ingredientId of pantry) {
        expect(`${table_name}:${dumped.includes(`"${ingredientId}"`)}`).toBe(`${table_name}:false`);
      }
    }
  });

  it("does not create a pantry table at all", async () => {
    const tables = await admin!<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
    `;

    expect(tables.map((t) => t.table_name).filter((name) => /pantry|inventory/i.test(name))).toEqual(
      [],
    );
  });
});
