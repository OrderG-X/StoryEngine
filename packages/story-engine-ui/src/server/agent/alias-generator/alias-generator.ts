/**
 * 角色别名表生成器。
 *
 * 规则层只做保守抽取：只读 character-bible 既有字段，不扫正文、不做题材专属规则。
 * 可选 LLM 层只能基于角色名/身份/定位提议中文代称，并经过服务端校验后才入表。
 * 生成结果写入 .story-engine-ui/alias-tables.json，
 * 供后续「本章相关角色」检测使用。
 */
import { mkdir, readFile } from "node:fs/promises";
import { writeFileAtomic } from "../../lib/project-io.js";
import { dirname, join } from "node:path";
import { readCharacterBible, type CharacterBibleEntry } from "@actalk/story-engine";

export const ALIAS_TABLE_RELATIVE_PATH = ".story-engine-ui/alias-tables.json";

export interface AliasEntry {
  readonly canonicalName: string;
  readonly primary: string;
  readonly aliases: readonly string[];
  readonly generated: readonly string[];
  readonly type: "character";
}

export interface AliasConflict {
  readonly surname: string;
  readonly entityIds: readonly string[];
  readonly note: string;
}

export interface AliasTable {
  readonly version: "v0";
  readonly byEntity: Record<string, AliasEntry>;
  readonly conflicts: readonly AliasConflict[];
}

export interface AliasMergeReport {
  readonly preservedUserAdditions: number;
  readonly preservedUserRemovals: number;
  readonly generatedAdded: number;
  readonly generatedRemoved: number;
  readonly removedEntities: readonly string[];
}

export interface AliasGenerationResult {
  readonly table: AliasTable;
  readonly mergeReport: AliasMergeReport;
}

export interface AliasLlmReport {
  readonly proposedByEntity: Record<string, readonly string[]>;
}

export interface AliasGenerationWithLlmResult extends AliasGenerationResult {
  readonly llmReport: AliasLlmReport;
  readonly warnings: readonly string[];
}

export interface GenerateAndWriteAliasTableResult extends AliasGenerationWithLlmResult {
  readonly ok: boolean;
  readonly summary: string;
}

export type CharacterAliasInput = Pick<CharacterBibleEntry, "id" | "name" | "role" | "identity">;

export type AliasProposalFn = (character: CharacterAliasInput) => Promise<readonly string[]>;

const EMPTY_TABLE: AliasTable = { version: "v0", byEntity: {}, conflicts: [] };

const ROLE_TITLE_RULES: readonly { readonly pattern: RegExp; readonly suffix: string }[] = [
  { pattern: /总裁|董事长|董事|老板/u, suffix: "总" },
  { pattern: /教授/u, suffix: "教授" },
  { pattern: /医生|大夫/u, suffix: "医生" },
  { pattern: /老师/u, suffix: "老师" },
  { pattern: /队长/u, suffix: "队" },
];

function normalizeAlias(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function unique(values: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeAlias(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function chineseChars(value: string): readonly string[] | undefined {
  if (!/^\p{Script=Han}+$/u.test(value)) return undefined;
  return Array.from(value);
}

function givenNameAlias(name: string): string | undefined {
  const chars = chineseChars(name);
  if (!chars) return undefined;
  if (chars.length === 2) return chars[1];
  if (chars.length === 3) return chars.slice(1).join("");
  return undefined;
}

function surnameAlias(name: string): string | undefined {
  const chars = chineseChars(name);
  return chars?.[0];
}

function titleAlias(surname: string | undefined, character: CharacterAliasInput): string | undefined {
  const roleText = [character.identity, character.role].filter(Boolean).join(" ");
  if (!surname || !roleText.trim()) return undefined;
  for (const rule of ROLE_TITLE_RULES) {
    if (rule.pattern.test(roleText)) return `${surname}${rule.suffix}`;
  }
  return undefined;
}

function buildSurnameConflicts(characters: readonly CharacterAliasInput[]): {
  readonly conflictedSurnames: ReadonlySet<string>;
  readonly conflicts: readonly AliasConflict[];
} {
  const bySurname = new Map<string, string[]>();
  for (const character of characters) {
    const surname = surnameAlias(character.name);
    if (!surname) continue;
    bySurname.set(surname, [...(bySurname.get(surname) ?? []), character.id]);
  }

  const conflicts: AliasConflict[] = [];
  const conflictedSurnames = new Set<string>();
  for (const [surname, entityIds] of bySurname.entries()) {
    if (entityIds.length <= 1) continue;
    conflictedSurnames.add(surname);
    conflicts.push({
      surname,
      entityIds,
      note: "同姓，姓不作唯一别名",
    });
  }
  return { conflictedSurnames, conflicts };
}

function generatedAliasesFor(
  character: CharacterAliasInput,
  conflictedSurnames: ReadonlySet<string>,
  extraGenerated: readonly string[] = [],
): readonly string[] {
  const surname = surnameAlias(character.name);
  return unique([
    givenNameAlias(character.name),
    surname && !conflictedSurnames.has(surname) ? surname : undefined,
    titleAlias(surname, character),
    ...extraGenerated,
  ]).filter((alias) => alias !== character.name);
}

function readPreviousEntry(value: unknown): AliasEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const canonicalName = normalizeAlias(raw.canonicalName);
  const primary = normalizeAlias(raw.primary);
  const aliases = Array.isArray(raw.aliases) ? unique(raw.aliases as readonly unknown[] as readonly string[]) : [];
  const generated = Array.isArray(raw.generated) ? unique(raw.generated as readonly unknown[] as readonly string[]) : [];
  if (!canonicalName || !primary) return undefined;
  return {
    canonicalName,
    primary,
    aliases,
    generated,
    type: "character",
  };
}

function normalizePreviousTable(previous: AliasTable | undefined): AliasTable | undefined {
  if (!previous || previous.version !== "v0" || typeof previous.byEntity !== "object") return undefined;
  const byEntity: Record<string, AliasEntry> = {};
  for (const [id, value] of Object.entries(previous.byEntity)) {
    const entry = readPreviousEntry(value);
    if (entry) byEntity[id] = entry;
  }
  return {
    version: "v0",
    byEntity,
    conflicts: Array.isArray(previous.conflicts) ? previous.conflicts : [],
  };
}

export function buildAliasTableFromCharacters(
  characters: readonly CharacterAliasInput[],
  previous?: AliasTable,
): AliasGenerationResult {
  return buildAliasTableFromCharactersAndExtraAliases(characters, {}, previous);
}

function buildAliasTableFromCharactersAndExtraAliases(
  characters: readonly CharacterAliasInput[],
  extraAliasesByEntity: Readonly<Record<string, readonly string[]>>,
  previous?: AliasTable,
): AliasGenerationResult {
  const normalizedPrevious = normalizePreviousTable(previous);
  const { conflictedSurnames, conflicts } = buildSurnameConflicts(characters);
  const byEntity: Record<string, AliasEntry> = {};
  const seenIds = new Set<string>();

  let preservedUserAdditions = 0;
  let preservedUserRemovals = 0;
  let generatedAdded = 0;
  let generatedRemoved = 0;

  for (const character of characters) {
    seenIds.add(character.id);
    const generated = generatedAliasesFor(character, conflictedSurnames, extraAliasesByEntity[character.id] ?? []);
    const old = normalizedPrevious?.byEntity[character.id];
    const oldGenerated = new Set(old?.generated ?? []);
    const oldAliases = new Set(old?.aliases ?? []);
    const userAdded = [...oldAliases].filter((alias) => !oldGenerated.has(alias));
    const userRemoved = [...oldGenerated].filter((alias) => !oldAliases.has(alias));

    preservedUserAdditions += userAdded.length;
    preservedUserRemovals += userRemoved.length;
    generatedAdded += generated.filter((alias) => !oldGenerated.has(alias)).length;
    generatedRemoved += [...oldGenerated].filter((alias) => !generated.includes(alias)).length;

    const removed = new Set(userRemoved);
    byEntity[character.id] = {
      canonicalName: character.name,
      primary: character.name,
      aliases: unique([...generated, ...userAdded]).filter((alias) => !removed.has(alias)),
      generated,
      type: "character",
    };
  }

  const removedEntities = Object.keys(normalizedPrevious?.byEntity ?? {}).filter((id) => !seenIds.has(id));
  return {
    table: { version: "v0", byEntity, conflicts },
    mergeReport: {
      preservedUserAdditions,
      preservedUserRemovals,
      generatedAdded,
      generatedRemoved,
      removedEntities,
    },
  };
}

function isChineseShortAlias(alias: string): boolean {
  const chars = Array.from(alias);
  return chars.length > 1 && chars.length <= 5 && /^\p{Script=Han}+$/u.test(alias);
}

function isNameRelatedAlias(alias: string, name: string): boolean {
  const nameChars = chineseChars(name);
  if (!nameChars) return false;
  const surname = nameChars[0];
  if (surname && alias.includes(surname)) return true;
  return nameChars.slice(1).some((char) => alias.includes(char));
}

function validateLlmAlias(input: {
  readonly alias: string;
  readonly character: CharacterAliasInput;
  readonly allCharacters: readonly CharacterAliasInput[];
  readonly conflictedSurnames: ReadonlySet<string>;
}): string | undefined {
  const alias = normalizeAlias(input.alias);
  if (!alias || !isChineseShortAlias(alias)) return undefined;
  if (alias === input.character.name) return undefined;
  if (!isNameRelatedAlias(alias, input.character.name)) return undefined;
  if (input.allCharacters.some((character) => character.id !== input.character.id && character.name === alias)) {
    return undefined;
  }
  const surname = surnameAlias(input.character.name);
  if (surname && input.conflictedSurnames.has(surname) && alias === surname) return undefined;
  return alias;
}

export async function buildAliasTableWithLlm(
  characters: readonly CharacterAliasInput[],
  opts: {
    readonly previous?: AliasTable;
    readonly proposeAliases: AliasProposalFn;
  },
): Promise<AliasGenerationWithLlmResult> {
  const { conflictedSurnames } = buildSurnameConflicts(characters);
  const proposedByEntity: Record<string, readonly string[]> = {};
  const extraAliasesByEntity: Record<string, readonly string[]> = {};
  const warnings: string[] = [];

  try {
    for (const character of characters) {
      const proposed = await opts.proposeAliases(character);
      const valid = unique(
        proposed.map((alias) => validateLlmAlias({ alias, character, allCharacters: characters, conflictedSurnames })),
      );
      if (valid.length > 0) {
        proposedByEntity[character.id] = valid;
        extraAliasesByEntity[character.id] = valid;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`LLM 不可用，仅规则生成：${message}`);
  }

  return {
    ...buildAliasTableFromCharactersAndExtraAliases(characters, extraAliasesByEntity, opts.previous),
    llmReport: { proposedByEntity },
    warnings,
  };
}

export async function readAliasTable(projectDir: string): Promise<AliasTable> {
  try {
    const parsed = JSON.parse(await readFile(join(projectDir, ALIAS_TABLE_RELATIVE_PATH), "utf-8")) as AliasTable;
    return normalizePreviousTable(parsed) ?? EMPTY_TABLE;
  } catch {
    return EMPTY_TABLE;
  }
}

async function readAliasTableForMerge(projectDir: string): Promise<{
  readonly table: AliasTable | undefined;
  readonly warnings: readonly string[];
}> {
  try {
    const parsed = JSON.parse(await readFile(join(projectDir, ALIAS_TABLE_RELATIVE_PATH), "utf-8")) as AliasTable;
    const table = normalizePreviousTable(parsed);
    return table
      ? { table, warnings: [] }
      : { table: undefined, warnings: ["alias-tables.json 格式不合法，已按空表重新生成。"] };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? { table: undefined, warnings: [] }
      : { table: undefined, warnings: ["alias-tables.json 读取失败，已按空表重新生成。"] };
  }
}

async function writeAliasTable(projectDir: string, table: AliasTable): Promise<void> {
  const path = join(projectDir, ALIAS_TABLE_RELATIVE_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, JSON.stringify(table, null, 2));
}

function buildSummary(input: {
  readonly characterCount: number;
  readonly result: AliasGenerationWithLlmResult;
}): string {
  const conflictCount = input.result.table.conflicts.length;
  const lines = [
    `生成/合并 ${input.characterCount} 个角色别名，${conflictCount} 处同姓冲突需确认；` +
      `保留用户改 ${input.result.mergeReport.preservedUserAdditions + input.result.mergeReport.preservedUserRemovals} 项，` +
      `新增 ${input.result.mergeReport.generatedAdded} 项，移除 ${input.result.mergeReport.generatedRemoved + input.result.mergeReport.removedEntities.length} 项。`,
  ];
  for (const [entityId, aliases] of Object.entries(input.result.llmReport.proposedByEntity)) {
    const entry = input.result.table.byEntity[entityId];
    if (!entry || aliases.length === 0) continue;
    lines.push(`给${entry.canonicalName}提议：${aliases.join("、")}——已入表，不合适可直接说改/删或编辑 JSON。`);
  }
  if (input.result.warnings.some((warning) => warning.startsWith("LLM 不可用"))) {
    lines.push("LLM 不可用，仅规则生成。");
  }
  return lines.join(" ");
}

export async function generateAndWriteAliasTable(
  projectDir: string,
  opts: { readonly proposeAliases?: AliasProposalFn } = {},
): Promise<GenerateAndWriteAliasTableResult> {
  const previous = await readAliasTableForMerge(projectDir);
  const warnings = [...previous.warnings];
  let characters: readonly CharacterAliasInput[] = [];
  try {
    characters = (await readCharacterBible(projectDir))?.characters ?? [];
  } catch {
    warnings.push("character-bible.json 读取失败，已按空角色册生成空别名表。");
  }

  const result = opts.proposeAliases
    ? await buildAliasTableWithLlm(characters, { previous: previous.table, proposeAliases: opts.proposeAliases })
    : { ...buildAliasTableFromCharacters(characters, previous.table), llmReport: { proposedByEntity: {} }, warnings: [] };
  warnings.push(...result.warnings);
  await writeAliasTable(projectDir, result.table);

  return {
    ok: true,
    summary: buildSummary({ characterCount: characters.length, result: { ...result, warnings } }),
    table: result.table,
    mergeReport: result.mergeReport,
    llmReport: result.llmReport,
    warnings,
  };
}
