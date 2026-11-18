import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { Model } from '@appling/lang';
import { buildGraph } from '@appling/model';
import { buildWorkspace } from '../../lang/test/workspace.js';
import { plan, type CodegenExtension } from '../src/index.js';

const MODEL = `module shop {
  enum Status { open done }
  entity Item { status: Status }
}`;

function extension(templates: string): CodegenExtension {
    return {
        name: '@acme/codegen-fake',
        templates,
        steps(node, context) {
            switch (node.kind) {
                case 'Enum':
                case 'Entity': return [{ kind: 'template', file: 'out.txt', write: () => context.render(`${node.kind.toLowerCase()}.njk`, { name: node.qn }) }];
                default: return [];
            }
        }
    };
}

async function written(root: string, options: Record<string, unknown> = {}) {
    const { documents, services } = await buildWorkspace({ 'shop.appling': MODEL });
    const graph = buildGraph(documents.map(d => d.parseResult.value as Model), services);
    const own = mkdtempSync(join(tmpdir(), 'appling-templates-'));
    writeFileSync(join(own, 'base.njk'), '{% block head %}{{ kind }}{% endblock %} {{ name }}\n');
    writeFileSync(join(own, 'enum.njk'), '{% set kind = "enum" %}{% extends "base.njk" %}\n');
    writeFileSync(join(own, 'entity.njk'), '{% set kind = "entity" %}{% extends "base.njk" %}\n');
    return plan(graph, extension(own), 'shop', options, root).steps.map(s => s.step.kind === 'template' ? s.step.write(undefined) : '');
}

test('renders the extension templates without their final newline', async () => {
    expect(await written(mkdtempSync(join(tmpdir(), 'appling-root-')))).toEqual(['enum shop.Status', 'entity shop.Item']);
});

test('a template in the override folder replaces only that template, and may extend the original', async () => {
    const root = mkdtempSync(join(tmpdir(), 'appling-root-'));
    mkdirSync(join(root, '.appling/templates/fake'), { recursive: true });
    writeFileSync(join(root, '.appling/templates/fake/entity.njk'), '{% extends "original:entity.njk" %}{% block head %}model{% endblock %}\n');
    expect(await written(root)).toEqual(['enum shop.Status', 'model shop.Item']);
});

test('the target option templates names another override folder, relative to the project root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'appling-root-'));
    mkdirSync(join(root, 'custom'));
    writeFileSync(join(root, 'custom/enum.njk'), 'choices {{ name }}\n');
    expect(await written(root, { templates: 'custom' })).toEqual(['choices shop.Status', 'entity shop.Item']);
});
