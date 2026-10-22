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

test('behavior, queries and the JSON:API are patched into the generated modules', async () => {
    const result = await planFor(examples());
    const files = new Map<string, string>([
        ['lib/shop/sales/order.ex', 'defmodule Shop.Sales.Order do\n  use Ash.Resource, otp_app: :shop, domain: Shop.Sales, data_layer: AshPostgres.DataLayer\n\n  actions do\n    defaults [:read, :destroy]\n  end\n\n  attributes do\n    attribute :status, Shop.Sales.OrderStatus do\n      allow_nil? false\n    end\n  end\nend\n'],
        ['lib/shop/sales.ex', 'defmodule Shop.Sales do\n  use Ash.Domain,\n    otp_app: :shop\n\n  resources do\n    resource Shop.Sales.Order\n  end\nend\n'],
        ['lib/shop/crm/account.ex', 'defmodule Shop.Crm.Account do\n  use Ash.Resource, otp_app: :shop, domain: Shop.Crm\nend\n'],
        ['lib/shop/application.ex', 'defmodule Shop.Application do\n  def start(_type, _args) do\n    children = [\n      Shop.Repo\n    ]\n  end\nend\n']
    ]);
    for (const { step } of result.steps) {
        if (step.kind === 'template') files.set(step.file, step.write(files.get(step.file)));
    }
    expect(Object.fromEntries([...files].filter(([file]) => !file.endsWith('line.ex')))).toMatchSnapshot();
    const entries = Object.fromEntries(result.entries.map(e => [e.qn, e]));
    expect(entries['sales.PlaceOrder'].missing.map(m => m.what)).toEqual([
        'check the precondition requires { lines.size() > 0 } else EmptyOrder in PlaceOrder',
        'apply the effect effect[emit OrderPlaced] in PlaceOrder, for example with an Ash notifier or a change',
        'write the tests "action place_order precondition" in test/shop/sales/order_test.exs'
    ]);
});
