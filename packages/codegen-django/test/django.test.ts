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
        ['config/settings.py', "INSTALLED_APPS = [\n    'django.contrib.admin',\n]\n"],
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
