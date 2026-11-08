import type { MapContext, Step } from '@appling/codegen';
import type { GraphNode } from '@appling/model';
import { lastOf } from './elixir.js';
import { app, snake, task, typeModule } from './naming.js';

/** A test case: its name, and its body when the model says enough to write it. */
export interface TestCase {
    name: string;
    /** The body lines, unindented; undefined leaves the test skipped as a registry task. */
    body?: string[];
}

/**
 * ExUnit tests for a rule in the test module of its resource, one per case. A case with a body runs; one
 * without is skipped with a pointer to its registry entry, which gets a task to write the missing bodies.
 */
export function testSteps(node: GraphNode, resource: GraphNode, title: string, cases: (string | TestCase)[], context: MapContext): Step[] {
    const module = `${typeModule(resource, context)}Test`;
    const file = ['test', app(context), ...resource.module.split('.').map(snake), `${snake(lastOf(resource.qn))}_test.exs`].join('/');
    const all = cases.map(c => typeof c === 'string' ? { name: c } : c);
    const tests = all.map(c => c.body
        ? `  test ${JSON.stringify(`${title} ${c.name}`)} do\n${c.body.map(l => `    ${l}\n`).join('')}  end\n`
        : `  @tag skip: ${JSON.stringify(`registry task: ${node.qn}`)}\n  test ${JSON.stringify(`${title} ${c.name}`)}\n`).join('\n');
    const missing = all.filter(c => !c.body);
    return [
        {
            kind: 'template', file, write: existing => existing
                ? existing.replace(/end\n?$/, `\n${tests}end\n`)
                : `defmodule ${module} do\n  use ExUnit.Case, async: true\n\n${tests}end\n`
        },
        ...(missing.length ? [task(`write the tests "${title}" in ${file}${missing.length < all.length ? ` (${missing.map(c => `"${title} ${c.name}"`).join(', ')})` : ''}`)] : [])
    ];
}
