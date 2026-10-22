import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { Model } from '@appling/lang';
import { buildGraph } from '@appling/model';
import { buildWorkspace } from '../../lang/test/workspace.js';
import { checkPrerequisites, plan, runPlan, type CodegenExtension } from '../src/index.js';

const MODEL = `module shop {
  enum Status { open done }
  entity Item {
    status: Status
    invariant "x" { true }
  }
  action Buy on Item { }
}`;

const fake: CodegenExtension = {
    name: 'fake',
    prerequisites: [{ name: 'node', command: ['node', '--version'], expect: /^v\d+/, hint: 'install node' }],
    steps(node, context) {
        switch (node.kind) {
            case 'Module': return [{ kind: 'command', run: ['node', '-e', `require('fs').writeFileSync('${context.name}.txt', 'project')`], creates: [`${context.name}.txt`] }];
            case 'Enum':
            case 'Entity': return [{ kind: 'template', file: 'models.txt', write: existing => `${existing ?? ''}${node.kind} ${node.qn}\n` }];
            case 'EnumLiteral':
            case 'Field': return [];
            case 'Invariant': return [{ kind: 'template', file: 'models.txt', write: e => e! }, { kind: 'task', what: 'translate the condition' }];
            case 'Action': return [{ kind: 'task', what: 'implement the action' }];
            default: return undefined;
        }
    }
};

async function graph() {
    const { documents, services } = await buildWorkspace({ 'shop.appling': MODEL });
    return buildGraph(documents.map(d => d.parseResult.value as Model), services);
}

test('plan orders steps by layer and records a registry entry per node', async () => {
    const result = plan(await graph(), fake, 'shop');
    expect(result.steps.map(s => s.node)).toEqual(['shop', 'shop.Status', 'shop.Item', 'shop.Item.invariant["x"]']);
    const status = Object.fromEntries(result.entries.map(e => [e.qn, e.status]));
    expect(status).toEqual({
        'shop': 'generated',
        'shop.Status': 'generated', 'shop.Status.open': 'generated', 'shop.Status.done': 'generated',
        'shop.Item': 'generated', 'shop.Item.status': 'generated', 'shop.Item.invariant["x"]': 'partial',
        'shop.Buy': 'todo'
    });
    const buy = result.entries.find(e => e.qn === 'shop.Buy')!;
    expect(buy.missing[0].what).toBe('implement the action');
    expect(buy.missing[0].context.related).toContainEqual({ qn: 'shop.Item', kind: 'Entity', edge: 'entity' });
});

test('setup runs first and later phases run after every earlier step', async () => {
    const phased: CodegenExtension = {
        name: 'phased',
        setup: () => [{ kind: 'command', run: ['setup'] }],
        steps: n => n.kind === 'Entity' ? [{ kind: 'command', run: ['late'], phase: 1 }] : n.kind === 'Enum' ? [{ kind: 'command', run: ['early'] }] : []
    };
    expect(plan(await graph(), phased, 'shop').steps.map(s => `${s.node} ${s.step.kind === 'command' && s.step.run[0]}`))
        .toEqual(['(project) setup', 'shop.Status early', 'shop.Item late']);
});

test('unmapped kinds become todo entries', async () => {
    const result = plan(await graph(), { name: 'empty', steps: () => undefined }, 'shop');
    expect(result.entries.every(e => e.status === 'todo' && e.missing[0].what === `empty does not generate ${e.kind} yet`)).toBe(true);
});

test('run executes commands and templates and writes the registry', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'appling-')), 'shop');
    runPlan(plan(await graph(), fake, 'shop'), out);
    expect(readFileSync(join(out, 'shop.txt'), 'utf8')).toBe('project');
    expect(readFileSync(join(out, 'models.txt'), 'utf8')).toBe('Enum shop.Status\nEntity shop.Item\n');
    const registry = JSON.parse(readFileSync(join(out, '.appling/tasks.json'), 'utf8'));
    expect(Object.keys(registry.entries)).toHaveLength(8);
});

test('a failing command stops the run', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'appling-')), 'shop');
    const failing: CodegenExtension = { name: 'failing', steps: n => n.kind === 'Module' ? [{ kind: 'command', run: ['node', '-e', 'process.exit(3)'] }] : [] };
    const steps = plan(await graph(), failing, 'shop');
    expect(() => runPlan(steps, out)).toThrow('node -e process.exit(3) failed');
    expect(existsSync(join(out, '.appling/tasks.json'))).toBe(false);
});

test('prerequisites report what is missing', () => {
    expect(checkPrerequisites(fake.prerequisites!)).toEqual([]);
    expect(checkPrerequisites([{ name: 'nothing', command: ['appling-no-such-tool'], hint: 'install it' }])).toEqual(['nothing: install it']);
});
