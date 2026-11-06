import { expect, test } from 'vitest';
import type { Model } from '@appling/lang';
import { plan } from '@appling/codegen';
import { buildGraph } from '@appling/model';
import { buildWorkspace, examples } from '../../lang/test/workspace.js';
import django from '../src/index.js';

/** Applies the template steps to the files `startproject` and `startapp` would create, without running commands. */
async function generate(sources: Record<string, string>) {
    const { documents, services } = await buildWorkspace(sources);
    const result = plan(buildGraph(documents.map(d => d.parseResult.value as Model), services), django, 'shop');
    const files = new Map<string, string>([
        ['config/settings.py', "INSTALLED_APPS = [\n    'django.contrib.admin',\n]\n\nMIDDLEWARE = [\n    'django.contrib.auth.middleware.AuthenticationMiddleware',\n]\n"],
        ['config/urls.py', "from django.contrib import admin\nfrom django.urls import path\n\nurlpatterns = [\n    path('admin/', admin.site.urls),\n]\n"]
    ]);
    for (const { step } of result.steps) {
        if (step.kind === 'command' && step.run.includes('startapp')) {
            const app = step.run.at(-1)!;
            files.set(`${app}/models.py`, 'from django.db import models\n\n# Create your models here.\n');
            files.set(`${app}/apps.py`, `from django.apps import AppConfig\n\n\nclass ${app[0].toUpperCase()}${app.slice(1)}Config(AppConfig):\n    name = '${app}'\n`);
        }
        if (step.kind === 'template') files.set(step.file, step.write(files.get(step.file)));
    }
    return { files: Object.fromEntries(files), entries: Object.fromEntries(result.entries.map(e => [e.qn, e])) };
}

test('examples generate apps, enums, value types and models', async () => {
    const { files, entries } = await generate(examples());
    expect(files).toMatchSnapshot();
    expect(entries['sales.Order.invariant["total never negative"]'].missing[0].what).toBe('enforce the invariant "total never negative": total >= 0');
    expect(entries['sales.Order.total'].status).toBe('generated');
    expect(entries['sales.PlaceOrder'].status).toBe('partial');
    expect(entries['sales.PlaceOrder'].missing.map(m => m.what)).toEqual(['write the test bodies of PlaceOrderPreconditionsTest in sales/tests.py']);
    expect(entries['sales.Checkout'].missing.map(m => m.what)).toEqual(['continue Checkout when PaymentReceived happens, or after 24h with the timeout call; the steps from here on are not generated']);
    expect(entries['sales.ExpireDrafts'].missing.map(m => m.what)).toEqual(['schedule "python manage.py expire_drafts" with cron "0 3 * * *"']);
});

test('invariants over stored fields become check constraints, defaults and derived fields become Python', async () => {
    const { files, entries } = await generate({
        'shop.appling': `module shop {
            enum Status { open done }
            entity Item {
                code: String
                status: Status default open
                quantity: Int default 1
                due: DateTime default now
                tags: String[]
                note: Text?
                big: Bool = quantity > 10 && code.startsWith("B")
                labels: Int = tags.filter(t, t.size() > 2).size()
                invariant "positive" { quantity > 0 && status in [open, done] }
                invariant "noted when done" { status != done || has(note) }
                invariant "not derived" { big || quantity < 5 }
            }
        }`
    });
    expect(files['shop/models.py']).toContain([
        '    code = models.CharField(max_length=255)',
        '    status = models.CharField(max_length=32, choices=Status.choices, default=Status.OPEN)',
        '    quantity = models.IntegerField(default=1)',
        '    due = models.DateTimeField(default=timezone.now)',
        '    tags = models.JSONField(encoder=DjangoJSONEncoder, default=list)',
        '    note = models.TextField(null=True, blank=True)',
        '',
        '    @property',
        '    def big(self):',
        '        return (self.quantity > 10) and self.code.startswith("B")',
        '',
        '    @property',
        '    def labels(self):',
        '        return len([t for t in self.tags if len(t) > 2])',
        '',
        '    class Meta:',
        '        constraints = [',
        '            models.CheckConstraint(condition=(models.Q(quantity__gt=0)) & (models.Q(status__in=["open", "done"])), name="shop_item_positive"),',
        '            models.CheckConstraint(condition=(~models.Q(status="done")) | (models.Q(note__isnull=False)), name="shop_item_noted_when_done"),',
        '        ]'
    ].join('\n'));
    expect(entries['shop.Item.invariant["not derived"]'].missing.map(m => m.what)).toEqual([
        'enforce the invariant "not derived": big || quantity < 5',
        'write the test bodies of ItemNotDerivedTest in shop/tests.py'
    ]);
});

test('roles become django-rules predicates, and the entity actors are bound to becomes the user model', async () => {
    const { files, entries } = await generate({
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
            }
            action Cancel on Order {
                requires { actor.is(Operator) }
            }
        }`
    });
    expect(files['ops/roles.py']).toBe([
        'import rules', '', '', '@rules.predicate', 'def is_operator(user):', '    return user is not None and user.groups.filter(name__in=["Operator", "Employee"]).exists() and user.active',
        '', '', '@rules.predicate', 'def is_viewer(user):', '    return user is not None and user.groups.filter(name__in=["Viewer", "Employee"]).exists()', ''
    ].join('\n'));
    expect(files['ops/models.py']).toContain('from django.contrib.auth.models import AbstractUser');
    expect(files['ops/models.py']).toContain('class User(AbstractUser):');
    expect(files['config/settings.py']).toContain('AUTH_USER_MODEL = "ops.User"');
    expect(files['ops/actions.py']).toContain('from ops.roles import is_operator');
    expect(files['ops/actions.py']).toContain('is_operator(actor)');
    expect(files['ops/groups.py']).toContain('GROUPS = [\n    "Operator",\n    "Viewer",\n    "Employee",\n]');
    expect(files['ops/apps.py']).toContain('    def ready(self):\n        from . import groups  # noqa: F401\n');
    expect(entries['ops.Operator'].status).toBe('generated');
    expect(entries['ops.Employee'].status).toBe('generated');
});

const ACCESS = `module shop {
    role Clerk
    role Customer
    actor human Shopper roles Customer {
        account: Account
        nickname: String
    }
    actor human Employee roles Clerk
    tenant Company on Account
    entity Account {
        name: String unique
        policy read { actor.is(Clerk) || (actor.is(Customer) && actor.account == this) }
    }
    enum Status { draft placed }
    entity Order {
        account: Account
        status: Status default draft
        total: Money
        policy read { actor.is(Clerk) || (actor.is(Customer) && account == actor.account) }
        policy create, update, delete { actor.is(Clerk) && account == tenant }
        policy read fields total { actor.is(Clerk) || (actor.is(Customer) && status != draft) }
    }
    entity Note {
        text: String
    }
    action Place on Order {
        policy { actor.is(Customer) && account == actor.account }
    }
    action Jot {
        input { text: String }
        effect { create Note { text = text } }
    }
    query Mine from Order {
        where { status == placed }
        policy { actor.is(Customer) && account == actor.account }
    }
    projection OrderView from Order {
        status
        total
    }
    usecase Close (order: Order) {
        step Place(order)
        policy { actor.is(Employee) }
    }
}`;

test('actors, tenants and policies are generated and enforced', async () => {
    const { files, entries } = await generate({ 'shop.appling': ACCESS });
    expect(files['shop/models.py']).toContain([
        'class User(AbstractUser):',
        '    account = models.ForeignKey("shop.Account", on_delete=models.PROTECT, null=True, blank=True)',
        '    nickname = models.CharField(max_length=255, null=True, blank=True)'
    ].join('\n'));
    expect(files['config/settings.py']).toContain('AUTH_USER_MODEL = "shop.User"');
    expect(files['shop/actors.py']).toContain('def is_shopper(user):\n    return user is not None and user.groups.filter(name="Shopper").exists()');
    expect(files['shop/roles.py']).toContain('user.groups.filter(name__in=["Customer", "Shopper"]).exists()');
    expect(files['shop/tenants.py']).toContain('token = _company.set(getattr(request.user, "account", None))');
    expect(files['config/settings.py']).toContain("MIDDLEWARE = [\n    'django.contrib.auth.middleware.AuthenticationMiddleware',\n    \"shop.tenants.CompanyMiddleware\",\n]");
    expect(files['shop/policies.py']).toContain([
        'def can_update_order(actor, order) -> bool:',
        '    if not getattr(actor, "is_authenticated", False):',
        '        return False',
        '    return is_clerk(actor) and (order.account == current_company())'
    ].join('\n'));
    expect(files['shop/policies.py']).toContain('def can_read_order_total(actor, order) -> bool:\n    return can_read_order(actor, order) and (is_clerk(actor) or (is_customer(actor) and (order.status != Status.DRAFT)))');
    expect(files['shop/policies.py']).toContain('return rows.filter(((models.Q(pk__isnull=False) if is_clerk(actor) else models.Q(pk__in=[]))) | (((models.Q(pk__isnull=False) if is_customer(actor) else models.Q(pk__in=[]))) & (models.Q(pk=getattr(actor.account, "pk", None)))))');
    expect(files['shop/policies.py']).toContain('def can_read_note(actor, note) -> bool:\n    return False  # no policy grants read');
    expect(files['shop/actions.py']).toContain([
        'def place(order: Order, *, actor=None) -> None:',
        '    if actor is not None and not (actor.is_authenticated and can_update_order(actor, order) and (is_customer(actor) and (order.account == actor.account))):',
        '        raise PermissionDenied("Place")'
    ].join('\n'));
    expect(files['shop/actions.py']).toContain([
        '    created = Note(text=text)',
        '    if actor is not None and not can_create_note(actor, created):',
        '        raise PermissionDenied("Jot")',
        '    created.save()'
    ].join('\n'));
    expect(files['shop/queries.py']).toContain([
        'def mine(actor=None):',
        '    rows = Order.objects.filter(models.Q(status="placed"))',
        '    if actor is None:',
        '        return rows',
        '    if not actor.is_authenticated:',
        '        return rows.none()',
        '    rows = readable_order_rows(actor, rows)',
        '    rows = rows.filter(((models.Q(pk__isnull=False) if is_customer(actor) else models.Q(pk__in=[]))) & (models.Q(account=actor.account)))',
        '    return rows'
    ].join('\n'));
    expect(files['shop/serializers.py']).toContain('        if "total" in data and not can_read_order_total(actor, instance):\n            data["total"] = None');
    expect(files['shop/usecases.py']).toContain('    if actor is not None and not (actor.is_authenticated and is_employee(actor)):\n        raise PermissionDenied("Close")\n    place(order, actor=actor)');
    for (const qn of ['shop.Shopper', 'shop.Shopper.account', 'shop.Employee', 'shop.Company', 'shop.Clerk']) expect(entries[qn].status, qn).toBe('generated');
    for (const policy of Object.values(entries).filter(e => e.kind === 'Policy')) {
        expect(policy.missing.map(m => m.what), policy.qn).toEqual([expect.stringMatching(/^write the test bodies of /)]);
    }
});

test('a model without policies keeps open queries and actions', async () => {
    const { files } = await generate({ 'shop.appling': 'module shop {\n role Clerk\n entity Order {\n note: String?\n }\n action Touch on Order {\n effect { set note = "seen" }\n }\n query All from Order {\n }\n}' });
    expect(files['shop/policies.py']).toBeUndefined();
    expect(files['shop/queries.py']).toContain('def all():\n    return Order.objects.all()');
    expect(files['shop/actions.py']).not.toContain('PermissionDenied');
});
