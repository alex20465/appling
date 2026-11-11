import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { Model } from '@appling/lang';
import { pendingChanges, plan, planMigrations, runMigrations, writeRegistry } from '@appling/codegen';
import { buildGraph } from '@appling/model';
import { buildWorkspace } from '../../lang/test/workspace.js';
import go from '../src/index.js';

const STORAGE = `module st {
  enum Kind {
    small
    large
  }
  value Address {
    city: String
  }
  entity Shelf {
    label: String unique
  }
  entity Box {
    kind: Kind default small
    shelf: Shelf owned
    spare: Shelf?
    tags: Shelf[]
    notes: String[]
    address: Address?
    code: Uuid
    weight: Decimal
    keep: Duration
  }
  migration since_v1 {
    rename Crate.size -> kind
    rename Crate.home -> shelf
    rename Crate.labels -> tags
    retype Crate.weight: Int -> Decimal
    remove Crate.legacy
    rename Kind.medium -> large
    rename Crate -> Box
  }
}`;

async function generated() {
    const { documents, services } = await buildWorkspace({ 'st.appling': STORAGE });
    expect(documents.flatMap(d => d.diagnostics ?? []).filter(d => d.severity === 1)).toEqual([]);
    return buildGraph(documents.map(d => d.parseResult.value as Model), services);
}

test('entities get a table in the initial goose migration and store functions over storage.Querier', async () => {
    const result = plan(await generated(), go, 'app');
    const files = new Map<string, string>();
    for (const { step } of result.steps) if (step.kind === 'template') files.set(step.file, step.write(files.get(step.file)));
    const schema = files.get('internal/storage/migrations/00001_appling_initial.sql')!;
    expect(schema).toContain([
        'CREATE TABLE "st_box" (',
        '\t"id" bigserial PRIMARY KEY,',
        '\t"kind" text NOT NULL,',
        '\t"shelf_id" bigint NOT NULL,',
        '\t"spare_id" bigint,',
        '\t"notes" jsonb,',
        '\t"address" jsonb,',
        '\t"code" uuid NOT NULL,',
        '\t"weight" numeric NOT NULL,',
        '\t"keep" interval NOT NULL',
        ');'
    ].join('\n'));
    expect(schema).toContain('"label" text NOT NULL UNIQUE');
    expect(schema).toContain('CREATE TABLE "st_box_tags" (');
    expect(schema).toContain('ALTER TABLE "st_box" ADD FOREIGN KEY ("shelf_id") REFERENCES "st_shelf" ("id") ON DELETE CASCADE;');
    expect(schema).toContain('ALTER TABLE "st_box" ADD FOREIGN KEY ("spare_id") REFERENCES "st_shelf" ("id") ON DELETE RESTRICT;');
    // Foreign keys come after every table, so the order of the entities does not matter.
    expect(schema.indexOf('ADD FOREIGN KEY')).toBeGreaterThan(schema.lastIndexOf('CREATE TABLE'));
    expect(schema.split('-- +goose Down')[1]).toContain('DROP TABLE IF EXISTS "st_box_tags" CASCADE;');
    const store = files.get('internal/st/store.go')!;
    expect(store).toContain('func InsertBox(ctx context.Context, db storage.Querier, x *Box) error {');
    expect(store).toContain('\t\tx.Shelf = &Shelf{ID: *shelfID}');
    expect(store).toContain('\tif err := saveBoxTags(ctx, db, x); err != nil {');
    expect(store).toContain('\t\tx.Tags[i] = &Shelf{ID: id}');
    for (const fn of ['GetBox', 'ListBox', 'UpdateBox', 'DeleteBox']) expect(store).toContain(`func ${fn}(`);
    expect(files.get('internal/storage/storage.go')).toContain('goose.NewProvider(goose.DialectPostgres, db, dir)');
    expect(files.get('internal/storage/storagetest/storagetest.go')).toContain('config.ConnConfig.RuntimeParams["search_path"] = schema');
    // The store test stores the required shelf of the box first.
    const tests = files.get('internal/st/st_test.go')!;
    expect(tests).toContain('\tshelf := validShelf()\n\tif err := InsertShelf(ctx, db, shelf); err != nil {');
    expect(tests).toContain('\tx := validBox()\n\tx.Shelf = shelf\n');
    expect(tests).toContain('func TestStoreShelf(t *testing.T) {');
    expect(result.entries.find(e => e.qn === 'st.Box')?.status).toBe('generated');
});

test('migration steps become a goose migration of the block that keeps the data', async () => {
    const graph = await generated();
    const out = mkdtempSync(join(tmpdir(), 'appling-go-'));
    writeRegistry(out, { extension: 'go', entries: {} });
    const changes = pendingChanges(graph, [], '20261111000000');
    runMigrations(out, planMigrations(graph, go, 'app', {}, out, changes), changes);
    expect(readFileSync(join(out, 'internal/storage/migrations/20261111000000_appling_since_v1.sql'), 'utf8')).toBe([
        '-- +goose Up',
        'ALTER TABLE "st_crate" RENAME COLUMN "size" TO "kind";',
        'ALTER TABLE "st_crate" RENAME COLUMN "home_id" TO "shelf_id";',
        'ALTER TABLE "st_crate_labels" RENAME TO "st_crate_tags";',
        'ALTER TABLE "st_crate" ALTER COLUMN "weight" TYPE numeric USING "weight"::numeric, ALTER COLUMN "weight" SET NOT NULL;',
        'ALTER TABLE "st_crate" DROP COLUMN IF EXISTS "legacy", DROP COLUMN IF EXISTS "legacy_id";',
        'DROP TABLE IF EXISTS "st_crate_legacy";',
        // The table still has its old name here; the rename of Crate comes after.
        'UPDATE "st_crate" SET "kind" = \'large\' WHERE "kind" = \'medium\';',
        'ALTER TABLE "st_crate" RENAME TO "st_box";',
        'ALTER TABLE "st_crate_tags" RENAME TO "st_box_tags";',
        ''
    ].join('\n'));
});
