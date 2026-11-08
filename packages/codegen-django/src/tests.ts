import type { MapContext, Step } from '@appling/codegen';
import type { GraphNode } from '@appling/model';
import { pythonFile, task, template } from './files.js';
import { appOf, lastOf, parentOf } from './python.js';

/** A test method: a name, and its body when the model says enough to write it. */
export interface TestCase {
    name: string;
    /** The body lines, indented for the method; undefined leaves the method skipped as a registry task. */
    body?: string[];
}

/**
 * A test class per rule in `<app>/tests.py`, one method per case. A case with a body runs; one without
 * skips with a pointer to its registry entry, which gets a task to write the missing bodies.
 */
export function testSteps(node: GraphNode, rule: string, cases: (string | TestCase)[], context: MapContext, imports: Iterable<string> = [], steps: Step[] = []): Step[] {
    const name = `${words(node, context)}Test`;
    const all = cases.map(c => typeof c === 'string' ? { name: c } : c);
    const code = [
        `class ${name}(TestCase):`,
        `    """${node.qn}: ${rule.replaceAll('"', '\\"')}"""`,
        ...all.flatMap(c => ['', `    def test_${c.name}(self):`, ...(c.body ?? [`self.skipTest(${JSON.stringify(`registry task: ${node.qn}`)})`]).map(l => `        ${l}`)])
    ].join('\n');
    const missing = all.filter(c => !c.body);
    return [
        ...steps,
        template(`${appOf(node.module)}/tests.py`, existing => pythonFile(existing, ['from django.test import TestCase', ...imports], code)),
        ...(missing.length ? [task(`write the test bodies of ${name} in ${appOf(node.module)}/tests.py${missing.length < all.length ? ` (${missing.map(c => `test_${c.name}`).join(', ')})` : ''}`)] : [])
    ];
}

/** A readable class name, such as `OrderTotalNeverNegative` for an invariant or `OrderFlowDraftToPlaced` for a transition. */
function words(node: GraphNode, context: MapContext): string {
    const owner = lastOf(parentOf(node.qn));
    const pascal = (text: string) => text.split(/[^A-Za-z0-9]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join('');
    if (node.kind === 'Invariant') return owner + pascal(String(node.data.label));
    if (node.kind === 'Policy') return `${owner}${pascal(((node.data.operations ?? ['any']) as string[]).join(' '))}Policy${duplicate(node, context)}`;
    if (node.kind === 'Transition') return `${owner}${pascal((node.data.from as string[]).join(' '))}To${pascal(node.data.to as string)}`;
    return `${lastOf(node.qn)}Preconditions`;
}

function duplicate(node: GraphNode, context: MapContext): string {
    const siblings = context.children(parentOf(node.qn)).filter(n => n.kind === node.kind && JSON.stringify(n.data.operations) === JSON.stringify(node.data.operations));
    const index = siblings.indexOf(node);
    return index > 0 ? String(index + 1) : '';
}
