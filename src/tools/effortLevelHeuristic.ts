import type { EffortLevel } from "../schema/recipeTemplate.js";
import type { IngredientSlotRole, RecipeTemplate } from "../schema/recipeTemplate.js";

// The structural cross-check for #151's curated `effort_level` — a SECOND,
// independent opinion computed from a template's own fields, never consulted while
// the blind curation pass was in progress and never edited afterward. See
// DECISION_LOG for the method: a written rubric, a blind pass against it, this
// heuristic computed separately, and only the rows where the two disagree going to
// manual review. A heuristic built (or tuned) to match the curated values after the
// fact would not be a cross-check, it would be an echo — so this file is exactly
// what it was the day the curation pass ran, edits included, and any future edit to
// DISH_FORM or the escalation rule needs its own review pass, not a patch to make a
// disagreement go away.
//
// The signal is the dish's FORM — what kind of dish it structurally is (a stew, a
// salad, a stuffed-and-baked dish) — not a count of `ingredient_slots` or a lookup
// against `prep_time_band`. Both of those were tried and rejected before writing
// this file: slot count barely varies across the whole library (141 of 170
// templates sit at 5–6 slots) so it cannot discriminate anything, and prep time
// actively lies — a stew that simmers unattended for 40 minutes is not more effort
// than a 20-minute plate with three separately-cooked components, and calibrating
// against time would make the "Enkelt" axis a second, redundant read of the "Tid"
// axis rather than a real one.

/** The dish forms this catalog's names sort into — see `DISH_FORM` below. */
export type DishForm =
  | "salad"
  | "sandwich"
  | "soup"
  | "stew"
  | "cold_raw"
  | "one_pan"
  | "mussel_pot"
  | "ribs_slow"
  | "pasta"
  | "wok"
  | "bowl"
  | "handheld"
  | "pancake_batch"
  | "fried_rice"
  | "pan_or_oven"
  | "formed"
  | "stuffed_baked"
  | "skewer"
  | "wrapped"
  | "battered_fried";

/**
 * Forms whose effort is fixed by what the form itself is — a salad is one vessel
 * (or none) regardless of what's in it, a stuffed-and-baked dish is a project
 * regardless of which vegetable is stuffed. No starch slot changes these.
 */
const FIXED_LEVEL: Partial<Record<DishForm, EffortLevel>> = {
  salad: "simple",
  sandwich: "simple",
  soup: "simple",
  cold_raw: "simple",
  one_pan: "simple",
  mussel_pot: "simple",
  ribs_slow: "simple",
  pasta: "moderate",
  wok: "moderate",
  bowl: "moderate",
  handheld: "moderate",
  pancake_batch: "moderate",
  fried_rice: "moderate",
  formed: "project",
  stuffed_baked: "project",
  skewer: "project",
  wrapped: "project",
  battered_fried: "project",
};

/**
 * Forms where the level depends on whether a genuinely separate pot or pan is
 * running alongside the main dish. `stew` covers soup-adjacent one-pot dishes that
 * are named as a stew/curry/chili rather than a soup; `pan_or_oven` covers a single
 * roasted or pan-cooked protein.
 */
const STARCH_DEPENDENT_FORMS = new Set<DishForm>(["stew", "pan_or_oven"]);

/**
 * Starch ingredients that are never plausibly cooked inside the main pot or roasted
 * on the same tray — rice, pasta, couscous, bulgur, quinoa and noodles are always a
 * second vessel when a stew or a roasted protein lists one. `potatis`/`nypotatis`
 * are deliberately excluded: a stew's potato slot may well be diced straight into
 * the pot rather than boiled and plated separately, and the schema cannot tell the
 * two apart. That is a real, acknowledged imprecision, not an oversight — see
 * DECISION_LOG for the disagreements it produces.
 *
 * Bread-form starches (`tortillabrod`, `formbrod`, `ragbrod`, `naanbrod`,
 * `knackebrod`, `tacoskal`) are excluded for a different reason: they are warmed or
 * used as-is, never their own cooking vessel. `potatismjol` is excluded because
 * every template that lists it uses it as a binder (raggmunk, köttfärslimpa), not a
 * side.
 */
const SEPARATE_VESSEL_STARCH = new Set([
  "ris",
  "jasminris",
  "basmatiris",
  "spagetti",
  "makaroner",
  "fullkornspasta",
  "risnudlar",
  "aggnudlar",
  "glasnudlar",
  "bulgur",
  "couscous",
  "quinoa",
  "havregryn",
  "mannagryn",
]);

const STARCH_ROLE: IngredientSlotRole = "starch";

/**
 * Every template's dish form, by id — the one place this file makes a judgment
 * call, and the one place it was frozen before grading began. Built by reading
 * each dish's actual name and ingredients, the same way a person deciding "what
 * kind of dish is this" would, not derived from any other field.
 *
 * A handful of entries fold two real components into one tag rather than inventing
 * a form used nowhere else: `amerikansk-grillad-ostmacka-med-tomatsoppa` (a
 * sandwich AND a soup) and `bbq-kyckling-med-majs-och-vitkalssallad` (a protein
 * plus a genuinely prepared side salad) are tagged `handheld` for its fixed
 * "moderate" level, which is the right answer for "two real components" even
 * though neither is literally a handheld dish.
 */
const DISH_FORM: Readonly<Record<string, DishForm>> = {
  "aggcurry-med-kokosmjolk-och-spenat": "stew",
  "aggmacka-med-majonnas-och-dill": "sandwich",
  "aggrora-med-graddfil-pa-ragbrod": "one_pan",
  "amerikansk-cheeseburgare-med-bacon": "handheld",
  "amerikansk-grillad-ostmacka-med-tomatsoppa": "handheld",
  "artsoppa-med-senap": "soup",
  "asiatisk-nudelsallad-med-kikartor-och-koriander": "salad",
  "bbq-kyckling-med-majs-och-vitkalssallad": "handheld",
  "biff-i-oystersas-med-broccoli": "wok",
  "biff-med-lok-och-potatis": "pan_or_oven",
  "bruschetta-med-tofu-tomat-och-basilika": "cold_raw",
  "burritobowl-med-quinoa-linser-och-majs": "bowl",
  "caprese-sallad-med-mozzarella-och-basilika": "salad",
  "carne-asada-med-lime-och-koriander": "pan_or_oven",
  "chili-sin-carne-med-svarta-bonor-och-majs": "stew",
  "citron-och-rosmarinkyckling-i-ugn": "pan_or_oven",
  "currygryta-med-flaskkarre-och-kokosmjolk": "stew",
  "dillstuvad-kyckling-med-potatis": "stew",
  "enchiladas-med-kikartor-och-ost": "stuffed_baked",
  "falafel-med-couscous-och-citronsas": "formed",
  "fish-and-chips-med-torsk-och-remouladsas": "battered_fried",
  "fiskgratang-med-rakor-och-dill": "stuffed_baked",
  "fiskpinnar-med-currysas-och-ris": "stew",
  "fisksoppa-pa-medelhavsvis-med-torsk-och-tomat": "soup",
  "fisktacos-med-torsk-avokado-och-lime": "handheld",
  "flaskfarsbollar-i-tomatsas-med-basilika": "formed",
  "flaskfile-al-pastor-med-ananas": "pan_or_oven",
  "flaskfile-i-skinklindning-med-timjan": "wrapped",
  "flaskfile-i-wok-med-cashewnotter-och-paprika": "wok",
  "flaskkarre-med-sotsur-sas-och-ananas": "pan_or_oven",
  "flaskkotlett-med-stekt-potatis-och-graddsas": "pan_or_oven",
  "flaskkotlett-milanese-med-citron": "battered_fried",
  "friterad-tofu-i-sotsur-sas-med-ananas": "pan_or_oven",
  "friterat-ris-med-halloumi-och-gronsaker": "fried_rice",
  "friterat-ris-med-prastost-och-gronsaker": "fried_rice",
  "frittata-med-spenat-och-graddfil": "one_pan",
  "fylld-aubergine-med-bulgur-och-pinjenotter": "stuffed_baked",
  "fyllda-paprikor-med-quinoa-och-svarta-bonor": "stuffed_baked",
  "fyllt-naanbrod-med-halloumi-och-yoghurtsas": "handheld",
  "fyllt-naanbrod-med-kyckling-och-yoghurtsas": "handheld",
  "gravad-lax-med-senapssas-och-ragbrod": "cold_raw",
  "grillad-entrecote-med-rosmarin-och-parmesan": "pan_or_oven",
  "grillad-entrecote-med-stekt-lok-och-bearnaisesas": "pan_or_oven",
  "grillade-flaskspjut-med-chimichurri-inspirerad-sas": "skewer",
  "gron-curry-med-kyckling-och-basmatiris": "stew",
  "gronsaksbowl-med-svarta-bonor-jasminris-och-sojagroddar": "bowl",
  "gronsakspaj-med-fetaost": "stuffed_baked",
  "halloumi-i-wok-med-teriyakisas-och-sesam": "wok",
  "halloumispett-med-couscous-och-oregano": "skewer",
  "halloumistekar-med-rostad-rotfrukt": "pan_or_oven",
  "huevos-rancheros-med-svarta-bonor": "handheld",
  "kaldolmar-med-kottfars": "stuffed_baked",
  "kalkonfile-i-wok-med-paprika-och-ingefara": "wok",
  "kall-yoghurtsoppa-med-gurka-och-dill": "soup",
  "kalops-med-rotfrukter": "stew",
  "kikartsbiffar-med-graddfilssas": "formed",
  "kikartscurry-med-kokosmjolk": "stew",
  "kikartstacos-med-avokado-och-koriander": "handheld",
  "kokt-torsk-med-loksas": "pan_or_oven",
  "korv-stroganoff-med-ris": "stew",
  "korvgryta-med-potatis-och-gron-paprika": "stew",
  "kottbullar-med-graddsas-och-rodbetssallad": "formed",
  "kottfarsbiffar-med-bulgur-och-gurkmeja": "formed",
  "kottfarslimpa-med-potatismos": "formed",
  "kramig-polenta-med-keso-och-spenat": "one_pan",
  "krispig-ugnsbakad-kyckling-med-potatismos": "pan_or_oven",
  "kryddig-bongryta-med-kanel-och-gurkmeja": "stew",
  "kryddig-grytstek-med-kanel-och-gurkmeja": "stew",
  "kryddig-linssoppa-med-citron-och-koriander": "soup",
  "kycklingbowl-med-bulgur-fetaost-och-mandel": "bowl",
  "kycklingbowl-med-jasminris-och-sojagroddar": "bowl",
  "kycklingbowl-med-svarta-bonor-majs-och-avokado": "bowl",
  "kycklingbullar-i-graddsas": "formed",
  "kycklingchili-med-svarta-bonor": "stew",
  "kycklingenchiladas-med-svarta-bonor-och-majs": "stuffed_baked",
  "kycklingfajitas-med-paprika-och-lok": "handheld",
  "kycklingfile-med-citron-och-vitlok": "pan_or_oven",
  "kycklinggratang-med-mozzarella-och-tomat": "stuffed_baked",
  "kycklinggryta-med-kikartor-och-gurkmeja": "stew",
  "kycklinggryta-med-rotfrukter": "stew",
  "kycklinggryta-pa-medelhavsvis-med-aubergine": "stew",
  "kycklinglarfile-med-ugnsrostade-rotfrukter": "pan_or_oven",
  "kycklingnudlar-med-gronsaker": "wok",
  "kycklingpaj-med-majs-och-bacon": "stuffed_baked",
  "kycklingpaj-med-purjolok": "stuffed_baked",
  "kycklingpasta-med-tomatsas-och-basilika": "pasta",
  "kycklingquesadilla-med-hushallsost": "handheld",
  "kycklingsoppa-med-glasnudlar-och-ingefara": "soup",
  "kycklingsoppa-med-rotfrukter": "soup",
  "kycklingspett-med-couscous-och-yoghurtsas": "skewer",
  "kycklingtacos-med-avokado-och-koriander": "handheld",
  "kycklingvingar-med-sesam-och-sweet-chilisas": "pan_or_oven",
  "kycklingwok-med-broccoli-och-cashewnotter": "wok",
  "langkokt-pulled-pork-med-coleslaw": "handheld",
  "laxpudding-med-dill": "stuffed_baked",
  "laxwok-med-broccoli-och-ingefara": "wok",
  "linsbowl-med-rostade-gronsaker-och-bulgur": "bowl",
  "linsgryta-med-tomat-och-timjan": "stew",
  "linssoppa-med-rotfrukter": "soup",
  "mac-and-cheese-med-hushallsost": "pasta",
  "makaronipanna-med-falukorv": "pasta",
  "massamangryta-med-kycklinglarfile": "stew",
  "medelhavssallad-med-kyckling-och-fetaost": "salad",
  "melanzane-alla-parmigiana": "stuffed_baked",
  "migas-med-tortilla-och-ost": "one_pan",
  "minestrone-med-kikartor-och-pasta": "soup",
  "musselgryta-med-vitlok-och-purjolok": "mussel_pot",
  "musslor-i-vitvinssas-med-vitlok-och-persilja": "mussel_pot",
  "musslor-i-wok-med-chili-och-vitlok": "wok",
  "nachos-med-flaskfars-ost-och-guacamole": "one_pan",
  "nachos-med-svarta-bonor-guacamole-och-ost": "one_pan",
  "notfars-pad-thai-stil-med-risnudlar": "wok",
  "notfarsburrito-med-svarta-bonor-och-ris": "handheld",
  "notkottsspett-med-bulgur-och-yoghurtsas": "skewer",
  "nudelsoppa-med-tofu-sojagroddar-och-ingefara": "soup",
  "ostpaj-med-purjolok": "stuffed_baked",
  "ostsoppa-med-brod-och-vitlok": "soup",
  "pad-thai-med-tofu-och-jordnotter": "wok",
  "pannkakor-med-vaniljsocker": "pancake_batch",
  "panzanella-med-hushallsost-tomat-och-basilika": "salad",
  "pasta-aglio-e-olio-med-prastost": "pasta",
  "pasta-bolognese-med-notfars": "pasta",
  "pasta-carbonara-med-bacon": "pasta",
  "pasta-med-kikartor-tomat-och-basilika": "pasta",
  "pasta-med-tonfisk-tomat-och-vitlok": "pasta",
  "pestokyckling-med-sparris": "pan_or_oven",
  "philly-cheesesteak-med-entrecote": "handheld",
  "potatisgratang-med-vasterbottensost": "stuffed_baked",
  "purjolokssoppa-med-creme-fraiche": "soup",
  "pyttipanna-med-biff-och-stekt-agg": "handheld",
  "quesadilla-med-svarta-bonor-och-ost": "handheld",
  "queso-fundido-med-tortilla": "one_pan",
  "raggmunk-med-graddfil": "pancake_batch",
  "rakceviche-med-lime-och-koriander": "cold_raw",
  "rakor-i-currysas-med-kokosmjolk": "stew",
  "rakpasta-med-vitlok-och-chili": "pasta",
  "raksmorgas-med-agg-och-majonnas": "sandwich",
  "rakspett-med-couscous-och-yoghurtsas": "skewer",
  "risotto-med-svamp-och-prastost": "stew",
  "shakshuka-med-tomatpure-och-gron-paprika": "one_pan",
  "skaldjursmix-i-wok-med-sojagroddar-och-paprika": "wok",
  "skinksmorgas-med-agg-och-senap": "sandwich",
  "skinkstek-med-potatismos-och-senap": "pan_or_oven",
  "snabbstekt-kycklingfile-med-sockerartor": "pan_or_oven",
  "snabbstekt-kycklingfile-med-zucchini-och-parmesan": "pan_or_oven",
  "sotsur-kyckling-med-ananas": "pan_or_oven",
  "stekt-flaskkarre-med-rotmos": "pan_or_oven",
  "stekt-torsk-med-aggsas-och-potatis": "pan_or_oven",
  "svampgryta-med-kantareller-och-graddfil": "stew",
  "svampsoppa-med-soja-och-vitlok": "soup",
  "svampspett-med-jordnotssas": "skewer",
  "svartbonsgryta-med-majs-och-paprika": "stew",
  "svartbonssallad-med-citron-och-persilja": "salad",
  "tabbouleh-sallad-med-bulgur-persilja-och-linser": "salad",
  "teriyakikyckling-med-jasminris": "pan_or_oven",
  "texas-chili-med-hogrev": "stew",
  "tofuwok-med-broccoli-och-cashewnotter": "wok",
  "tonfisk-poke-bowl-med-jasminris-och-avokado": "bowl",
  "tonfisksallad-med-fetaost-och-ruccola": "salad",
  "torsk-i-currysas-med-basmatiris": "stew",
  "toskansk-gryta-med-rotfrukter": "stew",
  "ugnsbakad-kyckling-med-citron-och-paprikapulver": "pan_or_oven",
  "ugnsbakad-kyckling-med-rotmos": "pan_or_oven",
  "ugnsbakad-lax-med-citron-och-sparris": "pan_or_oven",
  "ugnsbakad-torsk-med-gurkmeja-och-citron": "pan_or_oven",
  "ugnsbakade-revbensspjall-med-bbq-sas": "ribs_slow",
  "ugnsrostad-potatis-med-tofu-majs-och-avokado": "pan_or_oven",
  "vafflor-med-apple": "pancake_batch",
  "veggieburgare-med-svarta-bonor-och-avokado": "formed",
  "zucchinipaj-med-fetaost-och-pinjenotter": "stuffed_baked",
};

/**
 * The structural cross-check's opinion on one template, or `undefined` if the
 * catalog grows a template this file's `DISH_FORM` table has no entry for —
 * `undefined` is a missing cross-check, never a silent guess. `RecipeTemplateSchema`
 * still requires a curated `effort_level` regardless; this file exists to check
 * that value, not to supply it.
 */
export function structuralEffortLevel(template: RecipeTemplate): EffortLevel | undefined {
  const form = DISH_FORM[template.id];
  if (!form) return undefined;

  const fixed = FIXED_LEVEL[form];
  if (fixed) return fixed;

  if (STARCH_DEPENDENT_FORMS.has(form)) {
    const hasSeparateVesselStarch = template.ingredient_slots.some(
      (slot) => slot.role === STARCH_ROLE && SEPARATE_VESSEL_STARCH.has(slot.ingredient_id),
    );
    return hasSeparateVesselStarch ? "moderate" : "simple";
  }

  // Unreachable given the two tables above are exhaustive over DishForm — kept as
  // an explicit failure rather than a silent `undefined` so a form added to one
  // table and not the other is a thrown error, not a quietly wrong answer.
  throw new Error(`dish form "${form}" is in neither FIXED_LEVEL nor STARCH_DEPENDENT_FORMS`);
}

/** Every id `DISH_FORM` has an opinion on — for coverage assertions in tests. */
export function structuralCoverageIds(): readonly string[] {
  return Object.keys(DISH_FORM);
}
