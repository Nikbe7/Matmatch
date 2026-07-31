import { access, readFile } from "node:fs/promises";
import { glob } from "node:fs/promises";
import {
  DEFAULT_PATHS_BY_TYPE,
  RECORD_TYPES,
  validateFiles,
  type FileInput,
  type RecordType,
} from "./validation.js";

function isRecordType(value: string): value is RecordType {
  return (RECORD_TYPES as string[]).includes(value);
}

function isGlobPattern(pattern: string): boolean {
  return /[*?[\]{}]/.test(pattern);
}

async function expandPaths(pattern: string): Promise<string[]> {
  if (!isGlobPattern(pattern)) return [pattern];
  const matches: string[] = [];
  for await (const match of glob(pattern)) matches.push(match);
  return matches;
}

// Invoked with no --type groups at all: validate every registered type's
// default data file(s) (DEFAULT_PATHS_BY_TYPE, sourced from the type
// registry itself — see validation.ts). A plain default path that doesn't
// exist yet is skipped with a note rather than failing the run; a glob
// pattern matching zero files simply contributes nothing.
export async function resolveDefaultTargets(): Promise<{
  targets: { path: string; type: RecordType }[];
  notes: string[];
}> {
  const targets: { path: string; type: RecordType }[] = [];
  const notes: string[] = [];

  for (const type of RECORD_TYPES) {
    for (const pattern of DEFAULT_PATHS_BY_TYPE[type]) {
      if (isGlobPattern(pattern)) {
        for (const path of await expandPaths(pattern)) targets.push({ path, type });
        continue;
      }

      try {
        await access(pattern);
        targets.push({ path: pattern, type });
      } catch {
        notes.push(`default data file ${pattern} does not exist; skipping`);
      }
    }
  }

  return { targets, notes };
}

// Usage: npm run validate -- --type ingredient data/ingredients.json --type recipe-template data/recipe-templates.json
// A --type flag applies to every path that follows it, until the next --type.
export async function parseArgs(argv: string[]): Promise<{ path: string; type: RecordType }[]> {
  const targets: { path: string; type: RecordType }[] = [];
  let currentType: RecordType | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--type") {
      const value = argv[++i];
      if (!value || !isRecordType(value)) {
        throw new Error(
          `--type must be one of: ${RECORD_TYPES.join(", ")} (got ${value ?? "nothing"})`,
        );
      }
      currentType = value;
      continue;
    }

    if (!currentType) {
      throw new Error(`no --type specified before path "${arg}"`);
    }
    for (const path of await expandPaths(arg)) {
      targets.push({ path, type: currentType });
    }
  }

  return targets;
}

function formatIssue(issue: { file: string; index?: number; id?: string; path?: string; message: string }): string {
  const location = issue.index !== undefined ? `${issue.file}[${issue.index}]` : issue.file;
  const id = issue.id ? ` (id=${issue.id})` : "";
  const path = issue.path ? ` at ${issue.path}:` : ":";
  return `${location}${id}${path} ${issue.message}`;
}

export async function main(argv: string[]): Promise<number> {
  let targets: { path: string; type: RecordType }[];
  let preNotes: string[] = [];

  if (argv.length === 0) {
    console.log("no --type given: validating all registered data files by default\n");
    ({ targets, notes: preNotes } = await resolveDefaultTargets());
  } else {
    console.log("explicit --type invocation\n");
    try {
      targets = await parseArgs(argv);
    } catch (cause) {
      console.error((cause as Error).message);
      return 1;
    }
  }

  if (targets.length === 0) {
    console.error("no input files given. Usage: npm run validate -- --type <type> <paths...>");
    return 1;
  }

  const inputs: FileInput[] = [];
  for (const target of targets) {
    let content: string;
    try {
      content = await readFile(target.path, "utf-8");
    } catch (cause) {
      console.error(`could not read ${target.path}: ${(cause as Error).message}`);
      return 1;
    }
    inputs.push({ path: target.path, type: target.type, content });
  }

  const result = validateFiles(inputs);

  for (const note of preNotes) console.log(`NOTE ${note}`);
  for (const error of result.errors) console.error(`ERROR ${formatIssue(error)}`);
  for (const warning of result.warnings) console.warn(`WARNING ${formatIssue(warning)}`);
  for (const note of result.notes) console.log(`NOTE ${note}`);

  console.log(
    `\nfiles checked: ${result.filesChecked}, records checked: ${result.recordsChecked}, ` +
      `errors: ${result.errors.length}, warnings: ${result.warnings.length}`,
  );

  return result.errors.length > 0 ? 1 : 0;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
