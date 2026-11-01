/**
 * @atlas
 * @kind service
 * @partOf feature:viewer
 */
/**
 * A project's doc sections for Search: every markdown doc in its chorus regions (the corpus its
 * Wardens read, `readRegions` over the project's chorus layers), split at headings. Each section
 * carries its text and a † pointer (`<path> §<heading>`), the way a chime points into a doc.
 */
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { chorusLayers, readRegions } from '../agents/region-roster';
import type { ProjectSettingsConfig } from './config';
import { projectChorus } from './config-resolve';

export interface DocSection {
  region: string;
  doc: string;
  heading: string;
  level: number;
  /** The section's own text (to the next heading), clipped. */
  text: string;
  /** `† <repo-relative path> §<heading>`. */
  pointer: string;
}

const MAX_TEXT = 2000;
const HEADING = /^(#{1,4})\s+(.+?)\s*#*\s*$/;

/** A markdown file's sections, one per heading (text before the first heading is under the file). */
export function splitSections(
  markdown: string,
): { heading: string | null; level: number; text: string }[] {
  const sections: { heading: string | null; level: number; lines: string[] }[] = [
    { heading: null, level: 0, lines: [] },
  ];
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const match = fenced ? null : HEADING.exec(line);
    if (match) sections.push({ heading: match[2]!, level: match[1]!.length, lines: [] });
    else sections.at(-1)!.lines.push(line);
  }
  return sections
    .map((s) => ({ heading: s.heading, level: s.level, text: s.lines.join('\n').trim() }))
    .filter((s) => s.heading || s.text);
}

export function docSections(project: Pick<ProjectSettingsConfig, 'path' | 'chorus'>): DocSection[] {
  const { chorus } = projectChorus(project);
  const sections: DocSection[] = [];
  for (const layer of chorusLayers({ path: project.path, chorus }))
    for (const region of readRegions(layer.regionsDir))
      for (const [doc, { path }] of Object.entries(region.docs)) {
        let text: string;
        try {
          text = readFileSync(path, 'utf8');
        } catch {
          continue;
        }
        const where = relative(project.path, path);
        for (const section of splitSections(text)) {
          const heading = section.heading ?? doc;
          sections.push({
            region: region.id,
            doc,
            heading,
            level: section.level,
            text: section.text.slice(0, MAX_TEXT),
            pointer: `† ${where}${section.heading ? ` §${section.heading}` : ''}`,
          });
        }
      }
  return sections;
}
