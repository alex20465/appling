import { AstUtils } from 'langium';
import { buildSources, errorsOf, type Model } from '@appling/lang';
import { buildGraph, dependencies, qualifiedNames } from '@appling/model/graph';
import { subAnchors } from '@appling/model/anchors';
import type { Location, Snapshot, SourceFile } from './snapshot.js';

/** The snapshot of these file texts, without code references; the server and the browser demo share it. */
export async function buildSnapshot(root: string, files: SourceFile[]): Promise<Snapshot> {
    const workspace = await buildSources(Object.fromEntries(files.map(f => [f.uri, f.text])));
    const models = workspace.documents.map(d => d.parseResult.value as Model);
    const graph = buildGraph(models, workspace.services);
    const locations: Record<string, Location> = {};
    const qns = qualifiedNames(models);
    for (const [node, qn] of qns) {
        locations[qn] = { uri: AstUtils.getDocument(node).uri.toString(), start: node.$cstNode!.offset, end: node.$cstNode!.end };
    }
    // the declaring lines that are not elements, by sub-anchor address: their marks, references and jumps (#20)
    for (const { address, node } of subAnchors(qns)) {
        if (node.$cstNode) locations[address] = { uri: AstUtils.getDocument(node).uri.toString(), start: node.$cstNode.offset, end: node.$cstNode.end };
    }
    return { root, files, graph, dependencies: dependencies(graph), locations, code: {}, implementation: {}, anchors: {}, targets: [], tasks: [], requests: [], errors: errorsOf(workspace) };
}
