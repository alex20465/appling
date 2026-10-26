import type { Dependency, Graph, ResolvedReference } from '@appling/model';

export interface SourceFile {
    uri: string;
    path: string;
    text: string;
}

export interface Location {
    uri: string;
    start: number;
    end: number;
}

/** A code reference with the lines it points at now; empty for a broken one. */
export interface CodeLocation extends ResolvedReference {
    text: string;
}

/** Everything the IDE shows, built from the files on disk. */
export interface Snapshot {
    root: string;
    files: SourceFile[];
    graph: Graph;
    dependencies: Dependency[];
    locations: Record<string, Location>;
    /** Where elements are implemented, by qualified name. */
    code: Record<string, CodeLocation[]>;
    errors: string[];
}

export { DEFAULT_VIEW, type ViewSettings } from '@appling/viz/views';
