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
    // total has no calculation, so its field policy has nothing to name yet; the field's task carries the policy.
    expect(entries['sales.Order.total'].missing[0].what).toBe('add the calculation total = sum(lines.map(l, l.amount)), public?: true, and add it to the field policy of sales.Order.policy[read fields total]: actor.is(crm.Clerk) || (actor.is(Customer) && status != draft)');
    expect(entries['sales.Order.policy[read fields total]'].files).not.toContain('lib/shop/sales/order.ex');
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
        ['lib/shop/sales/shopper.ex', 'defmodule Shop.Sales.Shopper do\n  use Ash.Resource, otp_app: :shop, domain: Shop.Sales, data_layer: AshPostgres.DataLayer\n\n  attributes do\n    attribute :roles, {:array, :atom} do\n      public? false\n    end\n  end\nend\n'],
        ['lib/shop/crm/employee.ex', 'defmodule Shop.Crm.Employee do\n  use Ash.Resource, otp_app: :shop, domain: Shop.Crm, data_layer: AshPostgres.DataLayer\n\n  attributes do\n    attribute :roles, {:array, :atom} do\n      public? false\n    end\n  end\nend\n'],
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
        '  @impl true', '  def match?(%Shop.Ops.User{} = actor, context, _opts) do', '    actor = Ash.load!(actor, :operator?, authorize?: false, tenant: context.subject.tenant)',
        '    :operator in (actor.roles || []) and actor.operator?', '  end', '', '  def match?(_actor, _context, _opts), do: false', 'end', ''
    ].join('\n'));
    expect(write('lib/shop/ops/checks/viewer.ex', '')).toContain('    :viewer in (actor.roles || [])\n  end');
    expect(result.steps.some(({ step }) => step.kind === 'command' && step.run.includes('Shop.Ops.User') && step.run.join(' ').includes('roles:atom:array'))).toBe(true);
    expect(write('lib/shop/ops/user.ex', 'defmodule Shop.Ops.User do\n  use Ash.Resource\nend\n')).toContain('    calculate :active, :boolean, expr(not disabled)\n    calculate :operator?, :boolean, expr(active)\n');
    const order = write('lib/shop/ops/order.ex', 'defmodule Shop.Ops.Order do\n  use Ash.Resource,\n    domain: Shop.Ops\nend\n');
    expect(order).toContain('  use Ash.Resource,\n    domain: Shop.Ops,\n    authorizers: [Ash.Policy.Authorizer]\n');
    expect(order).toContain([
        '  policies do',
        '    policy action_type(:read) do', '      authorize_if Shop.Ops.Checks.Operator', '      authorize_if Shop.Ops.Checks.Viewer', '    end', '',
        '    policy action_type(:update) do', '      forbid_unless Shop.Ops.Checks.Operator', '      authorize_if expr(note != "")', '    end', '',
        '    policy action(:cancel) do', '      authorize_if Shop.Ops.Checks.Operator', '    end',
        '  end', ''
    ].join('\n'));
});

test('actors without is become resources or structs, and actor.is of an actor becomes a check', async () => {
    const result = await planFor({
        'desk.appling': `module desk {
            role Agent
            role Lead { actor.is(Agent) && actor.level > 2 }
            actor human Operator roles Agent, Lead {
                level: Int default 1
                team: Team
            }
            actor service Mailer roles Agent
            entity Team {
                name: String
                policy read { actor.is(Operator) || actor.is(Mailer) }
            }
        }`
    });
    const write = (file: string, text = '') => result.steps.reduce((current, { step }) => step.kind === 'template' && step.file === file ? step.write(current) : current, text);
    const commands = result.steps.flatMap(({ step }) => step.kind === 'command' ? [step.run.join(' ')] : []);
    expect(commands).toContain('mix ash.gen.resource Shop.Desk.Operator --domain Shop.Desk --default-actions read,create,update,destroy --uuid-primary-key id --attribute level:integer:required:public,roles:atom:array --extend postgres --timestamps --yes');
    expect(commands).toContain('mix ash.gen.resource Shop.Desk.Operator --relationship belongs_to:team:Shop.Desk.Team:required --yes');
    const operator = write('lib/shop/desk/operator.ex', 'defmodule Shop.Desk.Operator do\n  use Ash.Resource\n\n  attributes do\n    attribute :level, :integer do\n      allow_nil? false\n    end\n\n    attribute :roles, {:array, :atom} do\n      public? false\n    end\n  end\nend\n');
    expect(operator).toContain('    attribute :level, :integer do\n      default 1\n');
    expect(operator).toContain('    attribute :roles, {:array, :atom} do\n      default []\n      constraints items: [one_of: [:agent, :lead]]\n');
    expect(operator).toContain('    calculate :lead?, :boolean, expr(level > 2)\n');
    expect(write('lib/shop/desk/mailer.ex')).toBe('defmodule Shop.Desk.Mailer do\n  @moduledoc "The service actor Mailer. Pass %Shop.Desk.Mailer{} as the actor."\n  defstruct [roles: [:agent]]\nend\n');
    expect(write('lib/shop/desk/checks/lead.ex')).toContain([
        '  def match?(%Shop.Desk.Operator{} = actor, context, _opts) do',
        '    actor = Ash.load!(actor, :lead?, authorize?: false, tenant: context.subject.tenant)',
        '    :lead in (actor.roles || []) and Shop.Desk.Checks.Agent.match?(actor, context, []) and actor.lead?',
        '  end', '', '  def match?(_actor, _context, _opts), do: false'
    ].join('\n'));
    expect(write('lib/shop/desk/checks/agent.ex')).toContain('  def match?(%Shop.Desk.Mailer{} = actor, _context, _opts) do\n    :agent in (actor.roles || [])\n  end\n');
    expect(write('lib/shop/desk/checks/mailer.ex')).toContain('  def match?(%Shop.Desk.Mailer{}, _context, _opts), do: true\n');
    expect(write('lib/shop/desk/team.ex', 'defmodule Shop.Desk.Team do\n  use Ash.Resource\nend\n')).toContain('    policy action_type(:read) do\n      authorize_if Shop.Desk.Checks.Operator\n      authorize_if Shop.Desk.Checks.Mailer\n    end\n');
    const entries = Object.fromEntries(result.entries.map(e => [e.qn, e]));
    for (const qn of ['desk.Operator', 'desk.Mailer', 'desk.Operator.team', 'desk.Operator.level', 'desk.Lead', 'desk.Agent']) expect(entries[qn].status).toBe('generated');
});

test('tenants partition resources, and policies compare records by id, read the tenant and guard fields', async () => {
    const result = await planFor({
        'org.appling': `module org {
            role Member
            actor human Person roles Member {
                company: Company
            }
            entity Company {
                name: String
            }
            tenant Workspace on Company
            entity Project {
                company: Company
                owner: Company?
                budget: Money
                policy read fields budget { actor.is(Member) && company == actor.company }
            }
            entity Task {
                project: Project
                note: String?
                policy { actor.is(Member) && project.company == tenant }
                policy read fields note { actor.is(Member) && project.company == tenant }
            }
            query Mine from Task {
                where { project.company == actor.company }
                policy { actor.is(Member) }
            }
        }`
    });
    const write = (file: string, text: string) => result.steps.reduce((current, { step }) => step.kind === 'template' && step.file === file ? step.write(current) : current, text);
    const resource = (name: string) => `defmodule Shop.Org.${name} do\n  use Ash.Resource\nend\n`;
    expect(write('lib/shop/org/person.ex', resource('Person'))).toContain('  multitenancy do\n    strategy :attribute\n    attribute :company_id\n    global? true\n  end\n');
    const task = write('lib/shop/org/task.ex', resource('Task'));
    expect(task).not.toContain('multitenancy');
    expect(task).toContain('    policy always() do\n      forbid_unless Shop.Org.Checks.Member\n      authorize_if expr(project.company_id == ^tenant())\n    end\n');
    expect(task).toContain('    policy action(:mine) do\n      authorize_if Shop.Org.Checks.Member\n    end\n');
    expect(task).toContain('    read :mine do\n      filter expr(project.company_id == ^actor(:company_id))\n');
    expect(write('lib/shop/org/project.ex', resource('Project'))).toContain([
        '  field_policies do',
        '    field_policy :budget do', '      forbid_unless Shop.Org.Checks.Member', '      authorize_if expr(company_id == ^actor(:company_id))', '    end', '',
        '    field_policy :* do', '      authorize_if always()', '    end',
        '  end'
    ].join('\n'));
    const entries = Object.fromEntries(result.entries.map(e => [e.qn, e]));
    expect(entries['org.Workspace'].missing.map(m => m.what)).toEqual([
        'pick the tenant attribute of Project for Workspace',
        'partition Task by Workspace, which they reach only through relationships, for example with a tenant attribute set from the relationship'
    ]);
    // Field policies cannot follow relationships.
    expect(entries['org.Task.policy[read fields note]'].missing[0].what).toBe('add an Ash policy to org.Task for read: actor.is(Member) && project.company == tenant');
});

test('field policies name only fields on the resource, and calculations they name are public', async () => {
    const result = await planFor({
        'shop.appling': `module shop {
            role Manager
            actor human Staff roles Manager
            entity Order {
                discount: Int
                big: Bool = discount > 10
                total: Int = sum(lines.map(l, l.amount))
                lines: Line[]
                policy read fields discount, big, total { actor.is(Manager) }
            }
            value Line {
                amount: Int
            }
        }`
    });
    const write = (file: string, text: string) => result.steps.reduce((current, { step }) => step.kind === 'template' && step.file === file ? step.write(current) : current, text);
    const order = write('lib/shop/shop/order.ex', 'defmodule Shop.Shop.Order do\n  use Ash.Resource\nend\n');
    // Ash rejects a field policy that names a private calculation or a field the resource does not have.
    expect(order).toContain('    calculate :big, :boolean, expr(discount > 10), public?: true\n');
    expect(order).toContain('    field_policy [:discount, :big] do\n      authorize_if Shop.Shop.Checks.Manager\n    end\n');
    expect(order).not.toContain(':total');
    const entries = Object.fromEntries(result.entries.map(e => [e.qn, e]));
    expect(entries['shop.Order.total'].missing[0].what).toBe('add the calculation total = sum(lines.map(l, l.amount)), public?: true, and add it to the field policy of shop.Order.policy[read fields discount,big,total]: actor.is(Manager)');
    // Checks match the actor resources' structs, so they are written once every resource exists.
    expect(result.steps.find(({ step }) => step.kind === 'template' && step.file === 'lib/shop/shop/checks/manager.ex')?.step).toMatchObject({ phase: 2 });
});

test('a query filter that does not translate reads nothing, so its JSON:API route compiles', async () => {
    const result = await planFor({
        'shop.appling': `module shop {
            entity Order {
                reference: String
            }
            query Odd from Order {
                where { ["x", "y"] [0] != reference }
            }
            projection OddView from Order {
                reference
            }
            interface rest Api {
                GET "/odd" -> Odd as OddView { reference }
            }
        }`
    });
    const write = (file: string, text: string) => result.steps.reduce((current, { step }) => step.kind === 'template' && step.file === file ? step.write(current) : current, text);
    expect(write('lib/shop/shop/order.ex', 'defmodule Shop.Shop.Order do\n  use Ash.Resource\nend\n')).toContain('    read :odd do\n      filter expr(false)\n    end\n');
    expect(write('lib/shop/shop.ex', 'defmodule Shop.Shop do\n  use Ash.Domain\nend\n')).toContain('index :odd, route: "/odd"');
    const entries = Object.fromEntries(result.entries.map(e => [e.qn, e]));
    expect(entries['shop.Odd'].missing.map(m => m.what)).toEqual(['filter the read action odd by ["x", "y"] [0] != reference; it reads nothing until then']);
    // Without policies the project needs no SAT solver (the examples, with policies, install simple_sat).
    expect(result.steps[0].step.kind === 'command' && result.steps[0].step.run.join(' ')).not.toContain('simple_sat');
});

test('once the model has a policy, every resource denies what no policy covers, and jobs bypass the policies', async () => {
    const source = (policies: boolean) => ({
        'ops.appling': `module ops {
            role Clerk
            enum Status { open done }
            entity Tag { name: String }
            entity Ticket {
                status: Status default open
                note: String?
                ${policies ? `policy read { actor.is(Clerk) }
                policy update { actor.is(Clerk) && note.size() > 1 }
                policy read, update fields note { actor.is(Clerk) }` : ''}
            }
            action Close on Ticket { effect { set status = done } }
            job Sweep every "0 * * * *" run Close where { status == open }
            actor human Agent roles Clerk { level: Int }
        }`
    });
    const resource = (name: string) => `defmodule Shop.Ops.${name} do\n  use Ash.Resource,\n    domain: Shop.Ops\nend\n`;
    const run = async (policies: boolean) => {
        const result = await planFor(source(policies));
        const write = (name: string) => result.steps.reduce((current, { step }) => step.kind === 'template' && step.file === `lib/shop/ops/${snake(name)}.ex` ? step.write(current) : current, resource(name));
        return { write, entries: Object.fromEntries(result.entries.map(e => [e.qn, e])) };
    };
    const snake = (name: string) => name.toLowerCase();
    const deny = '  policies do\n    policy always() do\n      forbid_if always()\n    end\n  end\n';

    const open = await run(false);
    for (const name of ['Tag', 'Ticket', 'Agent']) expect(open.write(name)).not.toContain('Ash.Policy.Authorizer');

    const { write, entries } = await run(true);
    // A resource that no policy covers keeps its default actions, all forbidden; so does an actor's own resource.
    for (const name of ['Tag', 'Agent']) {
        expect(write(name)).toContain('    domain: Shop.Ops,\n    authorizers: [Ash.Policy.Authorizer]\n');
        expect(write(name)).toContain(deny);
    }
    const ticket = write('Ticket');
    expect(ticket).toContain('authorizers: [Ash.Policy.Authorizer]');
    expect(ticket).not.toContain('policy always() do');
    // The bypass comes first, so the AshOban scheduler and worker run as the system.
    expect(ticket).toContain('  policies do\n    bypass AshOban.Checks.AshObanInteraction do\n      authorize_if always()\n    end\n\n    policy action_type(:read) do\n');
    // A condition that does not translate forbids until the task is done.
    expect(ticket).toContain('    policy action_type(:update) do\n      forbid_if always()\n    end\n');
    expect(entries['ops.Ticket.policy[update]'].missing.map(m => m.what)).toContain('add an Ash policy to ops.Ticket for update: actor.is(Clerk) && note.size() > 1');
    // Field policies guard reads; their writes are a task.
    expect(ticket).toContain('    field_policy :note do\n      authorize_if Shop.Ops.Checks.Clerk\n    end\n');
    expect(Object.values(entries).find(e => e.qn.startsWith('ops.Ticket.policy[') && e.qn.includes('fields'))!.missing.map(m => m.what)).toContain('guard writes of note on ops.Ticket for update, which Ash field policies do not cover: actor.is(Clerk)');
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
