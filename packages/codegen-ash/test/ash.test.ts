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
        ['config/config.exs', 'import Config\n\nconfig :shop, Oban,\n  engine: Oban.Engines.Basic,\n  queues: [default: 10],\n  repo: Shop.Repo\n'],
        ['lib/shop_web/router.ex', 'defmodule ShopWeb.Router do\n  use ShopWeb, :router\n\n  scope "/", ShopWeb do\n    pipe_through :browser\n\n    get "/", PageController, :home\n  end\nend\n'],
        ['lib/shop_web/ash_json_api_router.ex', 'defmodule ShopWeb.AshJsonApiRouter do\n  use AshJsonApi.Router,\n    domains: [],\n    open_api: "/open_api"\nend\n'],
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

test('roles become policy checks on the actor resource, and policies that only name roles authorize with them', async () => {
    const result = await planFor({
        'ops.appling': `module ops {
            entity User {
                disabled: Bool default false
                active: Bool = !disabled
            }
            role Operator { actor.active }
            role Viewer
            actor human Employee is User roles Operator, Viewer
            entity Order {
                note: String?
                policy read { actor.is(Operator) || actor.is(Viewer) }
                policy update { actor.is(Operator) && note != "" }
            }
            action Cancel on Order {
                policy { actor.is(Operator) }
            }
        }`
    });
    const write = (file: string, text: string) => result.steps.reduce((current, { step }) => step.kind === 'template' && step.file === file ? step.write(current) : current, text);
    expect(write('lib/shop/ops/checks/operator.ex', '')).toBe([
        'defmodule Shop.Ops.Checks.Operator do', '  use Ash.Policy.SimpleCheck', '', '  @impl true', '  def describe(_opts), do: "actor is Operator"', '',
        '  @impl true', '  def match?(%Shop.Ops.User{} = actor, _context, _opts) do', '    actor = Ash.load!(actor, :operator?, authorize?: false)',
        '    :operator in (actor.roles || []) and actor.operator?', '  end', '', '  def match?(_actor, _context, _opts), do: false', 'end', ''
    ].join('\n'));
    expect(write('lib/shop/ops/checks/viewer.ex', '')).toContain('    :viewer in (actor.roles || [])\n  end');
    expect(result.steps.some(({ step }) => step.kind === 'command' && step.run.includes('Shop.Ops.User') && step.run.join(' ').includes('roles:atom:array'))).toBe(true);
    expect(write('lib/shop/ops/user.ex', 'defmodule Shop.Ops.User do\n  use Ash.Resource\nend\n')).toContain('    calculate :active, :boolean, expr(not disabled)\n    calculate :operator?, :boolean, expr(active)\n');
    const order = write('lib/shop/ops/order.ex', 'defmodule Shop.Ops.Order do\n  use Ash.Resource,\n    domain: Shop.Ops\nend\n');
    expect(order).toContain('  use Ash.Resource,\n    domain: Shop.Ops,\n    authorizers: [Ash.Policy.Authorizer]\n');
    expect(order).toContain('  policies do\n    policy action_type(:read) do\n      authorize_if Shop.Ops.Checks.Operator\n      authorize_if Shop.Ops.Checks.Viewer\n    end\n\n    policy action(:cancel) do\n      authorize_if Shop.Ops.Checks.Operator\n    end\n  end\n');
    const entries = Object.fromEntries(result.entries.map(e => [e.qn, e]));
    expect(entries['ops.Order.policy[update]'].missing[0].what).toBe('add an Ash policy to ops.Order for update: actor.is(Operator) && note != ""');
});

test('does texts become the moduledoc and attribute descriptions, and one registry task each', async () => {
    const result = await planFor({
        'shop.appling': `module shop {
            entity Item does "Something to sell, #{not} interpolated" { code: String does "Shelf code" }
            value Address does """
                Where it ships.
                Second line.
            """ { street: String }
        }`
    });
    const template = (file: string) => result.steps.find(s => s.step.kind === 'template' && s.step.file === file)!.step;
    const item = template('lib/shop/shop/item.ex');
    const generated = 'defmodule Shop.Shop.Item do\n  attributes do\n    attribute :code, :string do\n      allow_nil? false\n    end\n  end\nend\n';
    expect(item.kind === 'template' && item.write(generated)).toBe([
        'defmodule Shop.Shop.Item do',
        '  @moduledoc "Something to sell, \\#{not} interpolated"',
        '',
        '  attributes do',
        '    attribute :code, :string do',
        '      description "Shelf code"',
        '      allow_nil? false',
        '    end',
        '  end',
        'end',
        ''
    ].join('\n'));
    const address = template('lib/shop/shop/address.ex');
    expect(address.kind === 'template' && address.write(undefined)).toContain('defmodule Shop.Shop.Address do\n  @moduledoc """\n  Where it ships.\n  Second line.\n  """\n\n  use Ash.Resource');
    const entries = Object.fromEntries(result.entries.map(e => [e.qn, e]));
    expect(entries['shop.Item'].missing.map(m => m.what)).toEqual(['check that Item matches its description: Something to sell, #{not} interpolated']);
});
