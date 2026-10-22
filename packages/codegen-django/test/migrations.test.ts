import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { Model } from '@appling/lang';
import { pendingChanges, planMigrations, runMigrations, writeRegistry } from '@appling/codegen';
import { buildGraph } from '@appling/model';
import { buildWorkspace } from '../../lang/test/workspace.js';
import django from '../src/index.js';

test('migration steps become Django migrations and model changes', async () => {
    const { documents, services } = await buildWorkspace({
        'shop.appling': `module shop {
  enum Status { open done }
  entity Item {
    number: String
    price: Money
    status: Status default open
  }

  migration since_v1_0_0 {
    rename Item.code -> number
    retype Item.price: Decimal -> Money
    remove Item.legacy
  }
}`
    });
    const graph = buildGraph(documents.map(d => d.parseResult.value as Model), services);
    const out = mkdtempSync(join(tmpdir(), 'appling-django-'));
    mkdirSync(join(out, 'shop/migrations'), { recursive: true });
    writeFileSync(join(out, 'shop/migrations/0001_initial.py'), '');
    writeFileSync(join(out, 'shop/models.py'), 'from django.db import models\n\n\nclass Item(models.Model):\n    code = models.CharField(max_length=255)\n    price = models.DecimalField(max_digits=19, decimal_places=4)\n    legacy = models.TextField()\n');
    writeRegistry(out, { extension: 'django', entries: { 'shop.Item.number': { qn: 'shop.Item.number', kind: 'Field', layer: 'domain', status: 'generated', steps: [], files: [], missing: [] } } });
    const changes = pendingChanges(graph, [], '20261023000000');
    runMigrations(out, planMigrations(graph, django, 'shop', {}, out, changes), changes);
    expect(readFileSync(join(out, 'shop/migrations/0002_appling_since_v1_0_0.py'), 'utf8')).toBe([
        'from django.db import migrations, models',
        '',
        '',
        'class Migration(migrations.Migration):',
        '    dependencies = [("shop", "0001_initial")]',
        '',
        '    operations = [',
        '        migrations.RenameField(model_name="item", old_name="code", new_name="number"),',
        '        migrations.AlterField(model_name="item", name="price", field=models.DecimalField(max_digits=19, decimal_places=2)),',
        '        migrations.RemoveField(model_name="item", name="legacy"),',
        '    ]',
        ''
    ].join('\n'));
    expect(readFileSync(join(out, 'shop/models.py'), 'utf8')).toBe('from django.db import models\n\n\nclass Item(models.Model):\n    number = models.CharField(max_length=255)\n    price = models.DecimalField(max_digits=19, decimal_places=2)\n');
    const registry = JSON.parse(readFileSync(join(out, '.appling/tasks.json'), 'utf8'));
    expect(registry.entries['shop.Item.number'].status).toBe('partial');
    expect(JSON.parse(readFileSync(join(out, '.appling/migrations.json'), 'utf8'))).toEqual(changes.map(c => c.id));
});
