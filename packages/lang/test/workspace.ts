import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { URI, type LangiumDocument } from 'langium';
import { buildSources, errorsOf, type Workspace } from '../src/index.js';

/** Builds sources keyed by file name as one workspace, the way the CLI does. */
export async function build(sources: Record<string, string>): Promise<LangiumDocument[]> {
    return (await buildWorkspace(sources)).documents;
}

export async function buildWorkspace(sources: Record<string, string>): Promise<Workspace> {
    return buildSources(Object.fromEntries(Object.entries(sources).map(([name, text]) => [uriOf(name), text])));
}

export function uriOf(name: string): string {
    return URI.file(`/${name}`).toString();
}

export function errors(documents: LangiumDocument[]): string[] {
    return errorsOf({ documents } as Workspace);
}

export function examples(): Record<string, string> {
    const dir = join(import.meta.dirname, '../../../examples');
    return Object.fromEntries(readdirSync(dir).filter(f => f.endsWith('.appling') && !f.startsWith('.')).map(f => [f, readFileSync(join(dir, f), 'utf8')]));
}
