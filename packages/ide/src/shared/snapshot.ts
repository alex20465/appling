import type { Dependency, Graph } from '@appling/model';

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

/** Everything the IDE shows, built from the files on disk. */
export interface Snapshot {
    root: string;
    files: SourceFile[];
    graph: Graph;
    dependencies: Dependency[];
    locations: Record<string, Location>;
    errors: string[];
}

export type Level = 'out' | 'medium' | 'in';

export interface Position {
    x: number;
    y: number;
}

/** View state, kept in `.appling/layout.json` outside the model. Positions are relative to the enclosing module. */
export interface Layout {
    positions?: Partial<Record<Level, Record<string, Position>>>;
    /** The layers the graph shows at the declaration and member levels. */
    layers?: string[];
}
