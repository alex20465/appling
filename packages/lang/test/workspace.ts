import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EmptyFileSystem, URI, type LangiumDocument } from 'langium';
import { createApplingServices, type ApplingServices } from '../src/index.js';

/** Builds all sources as one workspace with validation, the way the CLI does. Keys are file names. */
export async function build(sources: Record<string, string>): Promise<LangiumDocument[]> {
    return (await buildWorkspace(sources)).documents;
}

export async function buildWorkspace(sources: Record<string, string>): Promise<{ documents: LangiumDocument[], services: ApplingServices }> {
    const { shared, Appling } = createApplingServices(EmptyFileSystem);
    const documents = Object.entries(sources).map(([name, text]) => {
        const document = shared.workspace.LangiumDocumentFactory.fromString(text, URI.file(`/${name}`));
        shared.workspace.LangiumDocuments.addDocument(document);
        return document;
    });
    await shared.workspace.DocumentBuilder.build(documents, { validation: true });
    return { documents, services: Appling };
}

export function errors(documents: LangiumDocument[]): string[] {
    return documents.flatMap(doc => (doc.diagnostics ?? []).filter(d => d.severity === 1).map(d => d.message));
}

export function examples(): Record<string, string> {
    const dir = join(import.meta.dirname, '../../../examples');
    return Object.fromEntries(readdirSync(dir).filter(f => f.endsWith('.appling')).map(f => [f, readFileSync(join(dir, f), 'utf8')]));
}
