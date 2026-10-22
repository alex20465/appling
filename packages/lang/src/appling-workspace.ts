import { EmptyFileSystem, URI, type LangiumDocument } from 'langium';
import { createApplingServices, type ApplingServices } from './appling-module.js';

export interface Workspace {
    documents: LangiumDocument[];
    services: ApplingServices;
}

/** Builds in memory sources, keyed by URI, as one validated workspace. */
export async function buildSources(sources: Record<string, string>): Promise<Workspace> {
    const { shared, Appling } = createApplingServices(EmptyFileSystem);
    const documents = Object.entries(sources).map(([uri, text]) => {
        const document = shared.workspace.LangiumDocumentFactory.fromString(text, URI.parse(uri));
        shared.workspace.LangiumDocuments.addDocument(document);
        return document;
    });
    await shared.workspace.DocumentBuilder.build(documents, { validation: true });
    return { documents, services: Appling };
}

export function errorsOf(workspace: Workspace): string[] {
    return workspace.documents.flatMap(doc => (doc.diagnostics ?? []).filter(d => d.severity === 1).map(d => typeof d.message === 'string' ? d.message : d.message.value));
}
