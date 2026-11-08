// A generation run in a worker thread: the extensions' commands run synchronously and may take minutes (`uv add`,
// `mix igniter.new`), which must not block the IDE server. Posts every `GenerationEvent`. It imports packages only,
// so Node runs it from `src/` too (type stripping), as the tests do.
import { parentPort, workerData } from 'node:worker_threads';
import { Project } from '@appling/ai';
import { generateElements, loadExtension, type CodegenExtension, type GenerationEvent, type GenerationSelection } from '@appling/codegen';

/** The stacks shipped with the app (literal imports, so the bundles carry them); a version the project installed wins. */
const BUNDLED: Record<string, () => Promise<{ default: CodegenExtension }>> = {
    '@appling/codegen-django': () => import('@appling/codegen-django'),
    '@appling/codegen-ash': () => import('@appling/codegen-ash'),
    '@appling/codegen-go': () => import('@appling/codegen-go'),
    '@appling/codegen-rust': () => import('@appling/codegen-rust')
};
const load = (name: string, root: string) => loadExtension(name, root).catch(async error => {
    const bundled = BUNDLED[name];
    if (!bundled) throw error;
    return (await bundled()).default;
});

const { root, selection } = workerData as { root: string, selection: GenerationSelection };
const post = (event: GenerationEvent) => parentPort!.postMessage(event);
const project = new Project(root);
const errors = await project.check();
if (errors.length) {
    post({ type: 'start', selection, targets: [] });
    post({ type: 'failed', message: `The model has ${errors.length} error(s); fix them before generating:\n${errors.slice(0, 10).join('\n')}` });
    post({ type: 'done', generated: 0, tasks: 0, failed: true });
} else {
    await generateElements({ root, graph: await project.graph(), selection, onEvent: post, load });
}
