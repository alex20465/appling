import type { MapContext, Step } from '@appling/codegen';
import type { GraphNode } from '@appling/model';
import { lastOf } from './elixir.js';
import { app, snake, task, typeModule } from './naming.js';

/**
 * Skipped ExUnit tests for a rule in the test module of its resource, one per case. Bodies are registry
 * tasks; each test points at its entry.
 */
export function testSteps(node: GraphNode, resource: GraphNode, title: string, cases: string[], context: MapContext): Step[] {
    const module = `${typeModule(resource, context)}Test`;
    const file = ['test', app(context), ...resource.module.split('.').map(snake), `${snake(lastOf(resource.qn))}_test.exs`].join('/');
    const tests = cases.map(c => `  @tag skip: ${JSON.stringify(`registry task: ${node.qn}`)}\n  test ${JSON.stringify(`${title} ${c}`)}\n`).join('\n');
    return [
        {
            kind: 'template', file, write: existing => existing
                ? existing.replace(/end\n?$/, `\n${tests}end\n`)
                : `defmodule ${module} do\n  use ExUnit.Case, async: true\n\n${tests}end\n`
        },
        task(`write the tests "${title}" in ${file}`)
    ];
}
