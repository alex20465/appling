import { expect, test } from 'vitest';
import type { Model } from '@appling/lang';
import { plan } from '@appling/codegen';
import { buildGraph } from '@appling/model';
import { buildWorkspace, examples } from '../../lang/test/workspace.js';
import ash from '../src/index.js';

async function planFor(sources: Record<string, string>) {
    const { documents, services } = await buildWorkspace(sources);
    return plan(buildGraph(documents.map(d => d.parseResult.value as Model), services), ash, 'shop');
}

test('examples plan domains, enums, embedded resources, resources and relationships', async () => {
    const result = await planFor(examples());
    expect(result.steps.map(({ node, step }) => `${node}: ${step.kind === 'command' ? step.run.join(' ') : step.kind === 'template' ? step.file : ''}`)).toMatchSnapshot();
    const entries = Object.fromEntries(result.entries.map(e => [e.qn, e]));
    expect(entries['sales.Order.total'].missing[0].what).toBe('add the calculation total = sum(lines.map(l, l.amount))');
    expect(entries['sales.Order.customer'].status).toBe('generated');
});

test('resources get defaults, identities, calculations and validations', async () => {
    const result = await planFor({
        'shop.appling': `module shop {
            enum Status { open done }
            entity Item {
                code: String unique
                status: Status default open
                quantity: Int
                due: DateTime default now
                note: Text?
                big: Bool = quantity > 10 && status != done
                invariant "positive" { quantity > 0 && status in [open, done] }
                invariant "noted when done" { status != done || has(note) }
            }
        }`
    });
    const generated = 'defmodule Shop.Shop.Item do\n  attributes do\n    attribute :status, Shop.Shop.Status do\n      allow_nil? false\n    end\n\n    attribute :due, :utc_datetime_usec do\n      allow_nil? false\n    end\n  end\nend\n';
    const template = result.steps.find(s => s.step.kind === 'template' && s.step.file === 'lib/shop/shop/item.ex')!.step;
    expect(template.kind === 'template' && template.write(generated)).toBe([
        'defmodule Shop.Shop.Item do',
        '  attributes do',
        '    attribute :status, Shop.Shop.Status do',
        '      default :open',
        '      allow_nil? false',
        '    end',
        '',
        '    attribute :due, :utc_datetime_usec do',
        '      default &DateTime.utc_now/0',
        '      allow_nil? false',
        '    end',
        '  end',
        '',
        '  identities do',
        '    identity :unique_code, [:code]',
        '  end',
        '',
        '  calculations do',
        '    calculate :big, :boolean, expr((quantity > 10) and (status != :done))',
        '  end',
        '',
        '  validations do',
        '    validate all([compare(:quantity, greater_than: 0), attribute_in(:status, [:open, :done])]), message: "positive"',
        '    validate any([attribute_does_not_equal(:status, :done), present(:note)]), message: "noted when done"',
        '  end',
        'end',
        ''
    ].join('\n'));
});
