/**
 * @atlas
 * @kind entrypoint
 * @partOf feature:viewer
 */
/**
 * The settings catalog: every Foundry setting's key path and description, read from the JSDoc on the
 * config interfaces in `packages/foundry/src/viewer/config.ts` (FoundryConfig for Foundry-wide keys,
 * ProjectSettingsConfig for a project's), following nested interfaces declared there. Search uses it.
 * `bun scripts/settings-catalog.ts` writes it; a test fails when the committed file is stale.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

export interface CatalogEntry {
  /** Dotted key path, e.g. `chorus.enabled`; a `*` stands for any key of a map. */
  path: string;
  scope: 'foundry' | 'project';
  description: string;
}

const ROOT = join(import.meta.dir, '..');
export const CONFIG_FILE = join(ROOT, 'packages/foundry/src/viewer/config.ts');
export const CATALOG_FILE = join(ROOT, 'packages/foundry/src/viewer/settings-catalog.json');

const doc = (node: ts.Node, source: ts.SourceFile) =>
  ts
    .getJSDocCommentsAndTags(node)
    .filter(ts.isJSDoc)
    .map((d) =>
      typeof d.comment === 'string' ? d.comment : (ts.getTextOfJSDocComment(d.comment) ?? ''),
    )
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim() || (void source, '');

export function buildSettingsCatalog(text = readFileSync(CONFIG_FILE, 'utf8')): CatalogEntry[] {
  const source = ts.createSourceFile('config.ts', text, ts.ScriptTarget.Latest, true);
  const declared = new Map<string, ts.TypeElement[]>();
  source.forEachChild((node) => {
    if (ts.isInterfaceDeclaration(node)) declared.set(node.name.text, [...node.members]);
    if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type))
      declared.set(node.name.text, [...node.type.members]);
  });

  const entries: CatalogEntry[] = [];
  const walk = (
    members: readonly ts.TypeElement[],
    prefix: string,
    scope: CatalogEntry['scope'],
    seen: Set<string>,
  ) => {
    for (const member of members) {
      if (!ts.isPropertySignature(member) || !member.name) continue;
      const name = member.name.getText(source).replace(/['"]/g, '');
      const path = prefix ? `${prefix}.${name}` : name;
      entries.push({ path, scope, description: doc(member, source) });
      const type = member.type;
      if (!type) continue;
      // A map (`Record<string, X>`) walks X under `*`; an inline object walks its members.
      const record =
        ts.isTypeReferenceNode(type) && type.typeName.getText(source) === 'Record'
          ? type.typeArguments?.[1]
          : undefined;
      const inner = record ?? type;
      const nextPrefix = record ? `${path}.*` : path;
      if (ts.isTypeLiteralNode(inner)) walk(inner.members, nextPrefix, scope, seen);
      else if (ts.isTypeReferenceNode(inner)) {
        const name = inner.typeName.getText(source);
        const nested = declared.get(name);
        if (nested && !seen.has(name)) walk(nested, nextPrefix, scope, new Set([...seen, name]));
      }
    }
  };
  // A project's settings are its own catalog, not FoundryConfig's `projects.*` subtree.
  const foundry = (declared.get('FoundryConfig') ?? []).filter(
    (m) => !(ts.isPropertySignature(m) && m.name.getText(source) === 'projects'),
  );
  walk(foundry, '', 'foundry', new Set(['FoundryConfig']));
  walk(
    declared.get('ProjectSettingsConfig') ?? [],
    '',
    'project',
    new Set(['ProjectSettingsConfig']),
  );
  return entries;
}

if (import.meta.main) {
  writeFileSync(CATALOG_FILE, `${JSON.stringify(buildSettingsCatalog(), null, 2)}\n`);
  console.log(`settings catalog: ${CATALOG_FILE}`);
}
