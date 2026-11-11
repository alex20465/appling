import type { MapContext, MigrationChange, Step } from '@appling/codegen';
import type { GraphNode, TypeData } from '@appling/model';
import { camel, pascal, type GoScope } from './golang.js';

/** The domain generator's helpers the storage generator builds on, passed in so the package exports stay as they are. */
export interface Helpers {
    fieldsOf(node: GraphNode, context: MapContext): GraphNode[];
    goFile(module: string, file: string, context: MapContext, imports: Set<string>, block: string): Step;
    goScope(node: GraphNode, context: MapContext, imports: Set<string>): GoScope;
    typeOf(type: TypeData, scope: GoScope): string;
    validRecord(entity: GraphNode, context: MapContext): { name: string, step: Step } | undefined;
}

export const PGX = 'github.com/jackc/pgx/v5';
export const PGX_VERSION = 'v5.12.0';
/** The last goose release whose go.mod asks for Go 1.25; 3.28 and later need 1.26. */
export const GOOSE = 'github.com/pressly/goose/v3';
export const GOOSE_VERSION = 'v3.27.3';

const INITIAL = '00001_appling_initial.sql';

/** The storage package's name and import path, `storage` unless a module already takes it. */
export function storageOf(context: MapContext): { pkg: string, path: string, test: string, testPath: string } {
    const pkg = context.graph.nodes.some(n => n.kind === 'Module' && pkgOf(n.qn) === 'storage') ? 'appstorage' : 'storage';
    return { pkg, path: `${context.name}/internal/${pkg}`, test: `${pkg}test`, testPath: `${context.name}/internal/${pkg}/${pkg}test` };
}

/** Whether the model has an entity, so the project gets the storage package and its dependencies. */
export function stores(context: MapContext): boolean {
    return context.graph.nodes.some(n => n.kind === 'Entity');
}

export function snake(name: string): string {
    return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** The table of an entity by qualified name: the module path and the entity in snake case, such as `sales_order_line`. */
export function tableOf(qn: string): string {
    return `${parentOf(qn).replaceAll('.', '_')}_${snake(last(qn))}`;
}

function last(qn: string): string {
    return qn.slice(qn.lastIndexOf('.') + 1);
}

function parentOf(qn: string): string {
    return qn.slice(0, qn.lastIndexOf('.'));
}

function pkgOf(module: string): string {
    return module.split('.').pop()!;
}

function task(what: string): Step {
    return { kind: 'task', what };
}

function quote(name: string): string {
    return `"${name.replaceAll('"', '""')}"`;
}

/** How a field of an entity is stored: a column, a reference column `<field>_id`, or a link table for a list of records. */
type Stored =
    | { kind: 'column', field: GraphNode, column: string, sql: string }
    | { kind: 'reference', field: GraphNode, column: string, target: GraphNode }
    | { kind: 'link', field: GraphNode, table: string, target: GraphNode };

function storedOf(field: GraphNode, context: MapContext): Stored {
    const type = field.data.type as TypeData;
    const decl = type.decl ? context.node(type.decl) : undefined;
    const name = snake(last(field.qn));
    if (decl?.kind === 'Entity') {
        return type.many
            ? { kind: 'link', field, table: `${tableOf(parentOf(field.qn))}_${name}`, target: decl }
            : { kind: 'reference', field, column: `${name}_id`, target: decl };
    }
    return { kind: 'column', field, column: name, sql: sqlType(type, context) };
}

/** The Postgres type of a stored value: enums as text, value types and lists as jsonb, durations as interval (pgx maps time.Duration to it). */
export function sqlType(type: TypeData, context: MapContext): string {
    if (type.many) return 'jsonb';
    const decl = type.decl ? context.node(type.decl) : undefined;
    if (decl?.kind === 'ValueType') return 'jsonb';
    if (decl) return 'text';
    return ({
        String: 'text', Text: 'text', File: 'text', Uuid: 'uuid', Int: 'bigint', Bool: 'boolean', Decimal: 'numeric', Money: 'numeric',
        Date: 'date', DateTime: 'timestamptz', Duration: 'interval'
    } as { [name: string]: string })[type.primitive!] ?? 'text';
}

function storedFields(entity: GraphNode, context: MapContext): Stored[] {
    return context.children(entity.qn).filter(c => c.kind === 'Field').filter(f => !f.data.derived).map(f => storedOf(f, context));
}

/**
 * An entity's table in the initial migration, its foreign keys after every table exists, and its store functions:
 * `Insert<Entity>`, `Get<Entity>`, `List<Entity>`, `Update<Entity>` and `Delete<Entity>` over a `storage.Querier`
 * (a pool, a connection or a transaction). Referenced records load as their ID only; lists of records live in
 * link tables. With a test database (`DATABASE_URL`) the store test runs them on a fresh schema.
 */
export function storageSteps(entity: GraphNode, context: MapContext, helpers: Helpers): Step[] {
    return [
        ...packageSteps(context),
        schemaStep(entity, context),
        storeStep(entity, context, helpers),
        ...storeTestSteps(entity, context, helpers)
    ];
}

function packageSteps(context: MapContext): Step[] {
    const storage = storageOf(context);
    const main: Step = { kind: 'template', file: `internal/${storage.pkg}/${storage.pkg}.go`, write: () => storageCode(storage.pkg) };
    const test: Step = { kind: 'template', file: `internal/${storage.pkg}/${storage.test}/${storage.test}.go`, write: () => storageTestCode(storage) };
    return [main, test];
}

function storageCode(pkg: string): string {
    return `// Package ${pkg} opens the Postgres database and migrates it with the goose migrations of the migrations folder.
package ${pkg}

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"io/fs"

	"${PGX}"
	"${PGX}/pgconn"
	"${PGX}/pgxpool"
	"${PGX}/stdlib"
	"${GOOSE}"
)

//go:embed migrations/*.sql
var migrations embed.FS

// ErrNotFound is returned when no record has the ID.
var ErrNotFound = errors.New("not found")

// Querier runs SQL: a *pgxpool.Pool, a *pgx.Conn or a pgx.Tx.
type Querier interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// Open connects a pool to the database at url, such as postgres://user:password@localhost:5432/app.
func Open(ctx context.Context, url string) (*pgxpool.Pool, error) {
	return pgxpool.New(ctx, url)
}

// Migrate applies the migrations the database has not applied yet.
func Migrate(ctx context.Context, config *pgx.ConnConfig) error {
	db := stdlib.OpenDB(*config)
	defer db.Close()
	dir, err := fs.Sub(migrations, "migrations")
	if err != nil {
		return err
	}
	provider, err := goose.NewProvider(goose.DialectPostgres, db, dir)
	if err != nil {
		return fmt.Errorf("migrations: %w", err)
	}
	if _, err := provider.Up(ctx); err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	return nil
}
`;
}

function storageTestCode(storage: ReturnType<typeof storageOf>): string {
	return `// Package ${storage.test} gives each test a fresh, migrated schema of the test database named by DATABASE_URL.
package ${storage.test}

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"${storage.path}"
	"${PGX}"
	"${PGX}/pgxpool"
)

// Open returns a pool on a new schema of the database at DATABASE_URL with every migration applied, dropped
// when the test ends. Without DATABASE_URL the test is skipped.
func Open(t testing.TB) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL is not set")
	}
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { _ = admin.Close(ctx) })
	schema := fmt.Sprintf("test_%d_%d", os.Getpid(), time.Now().UnixNano())
	if _, err := admin.Exec(ctx, \`CREATE SCHEMA "\`+schema+\`"\`); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	t.Cleanup(func() { _, _ = admin.Exec(ctx, \`DROP SCHEMA "\`+schema+\`" CASCADE\`) })
	config, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatalf("parse DATABASE_URL: %v", err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	if err := ${storage.pkg}.Migrate(ctx, config.ConnConfig); err != nil {
		t.Fatalf("%v", err)
	}
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}
`;
}

/** The parts of the initial migration: tables, then foreign keys once every table exists, then the down migration. */
interface Schema { tables: string[], keys: string[], down: string[] }

const KEYS = '-- appling: foreign keys, once every table exists';

function parseSchema(text: string | undefined): Schema {
    if (!text) return { tables: [], keys: [], down: [] };
    const [up, down = ''] = text.split('-- +goose Down');
    const [tables, keys = ''] = up.replace('-- +goose Up', '').split(KEYS);
    const statements = (part: string) => part.split(/;\n/).map(s => s.trim()).filter(Boolean).map(s => `${s.replace(/;$/, '')};`);
    return { tables: statements(tables), keys: statements(keys), down: statements(down) };
}

function printSchema(schema: Schema): string {
    return [
        '-- +goose Up',
        schema.tables.join('\n\n'),
        ...(schema.keys.length ? ['', KEYS, schema.keys.join('\n')] : []),
        '',
        '-- +goose Down',
        schema.down.join('\n'),
        ''
    ].join('\n');
}

function schemaStep(entity: GraphNode, context: MapContext): Step {
    const storage = storageOf(context);
    const table = tableOf(entity.qn);
    const stored = storedFields(entity, context);
    const columns = ['"id" bigserial PRIMARY KEY'];
    const tables: string[] = [];
    const keys: string[] = [];
    const down: string[] = [];
    for (const s of stored) {
        const type = s.field.data.type as TypeData;
        const unique = ((s.field.data.modifiers ?? []) as string[]).includes('unique') ? ' UNIQUE' : '';
        const nullable = type.optional ? '' : ' NOT NULL';
        // pgx writes a nil slice as NULL, so a list column takes NULL for the empty list.
        if (s.kind === 'column') columns.push(`${quote(s.column)} ${s.sql}${type.many ? '' : nullable}${unique}`);
        else if (s.kind === 'reference') {
            columns.push(`${quote(s.column)} bigint${nullable}${unique}`);
            const owned = ((s.field.data.modifiers ?? []) as string[]).includes('owned');
            keys.push(`ALTER TABLE ${quote(table)} ADD FOREIGN KEY (${quote(s.column)}) REFERENCES ${quote(tableOf(s.target.qn))} ("id") ON DELETE ${owned ? 'CASCADE' : 'RESTRICT'};`);
        } else {
            tables.push(`CREATE TABLE ${quote(s.table)} (\n\t"owner_id" bigint NOT NULL,\n\t"item_id" bigint NOT NULL,\n\tPRIMARY KEY ("owner_id", "item_id")\n);`);
            keys.push(
                `ALTER TABLE ${quote(s.table)} ADD FOREIGN KEY ("owner_id") REFERENCES ${quote(table)} ("id") ON DELETE CASCADE;`,
                `ALTER TABLE ${quote(s.table)} ADD FOREIGN KEY ("item_id") REFERENCES ${quote(tableOf(s.target.qn))} ("id") ON DELETE CASCADE;`
            );
            down.push(`DROP TABLE IF EXISTS ${quote(s.table)} CASCADE;`);
        }
    }
    tables.unshift(`-- ${entity.qn}\nCREATE TABLE ${quote(table)} (\n${columns.map(c => `\t${c}`).join(',\n')}\n);`);
    down.push(`DROP TABLE IF EXISTS ${quote(table)} CASCADE;`);
    return {
        kind: 'template', file: `internal/${storage.pkg}/migrations/${INITIAL}`, write: existing => {
            const schema = parseSchema(existing);
            return printSchema({ tables: [...schema.tables, ...tables], keys: [...schema.keys, ...keys], down: [...down, ...schema.down] });
        }
    };
}

function storeStep(entity: GraphNode, context: MapContext, { goFile, goScope, typeOf }: Helpers): Step {
    const storage = storageOf(context);
    const imports = new Set(['context', 'errors', 'fmt', PGX, storage.path]);
    const scope = goScope(entity, context, imports);
    const name = last(entity.qn);
    const table = quote(tableOf(entity.qn));
    const stored = storedFields(entity, context);
    const columns = stored.filter(s => s.kind !== 'link') as Exclude<Stored, { kind: 'link' }>[];
    const links = stored.filter(s => s.kind === 'link') as Extract<Stored, { kind: 'link' }>[];
    const db = `db ${storage.pkg}.Querier`;
    const fieldOf = (s: Stored) => `x.${pascal(last(s.field.qn))}`;
    const variable = (s: Stored) => `${camel(last(s.field.qn))}ID`;
    // A reference is written as the record's ID, nil when there is no record.
    const refs = columns.filter(s => s.kind === 'reference').flatMap(s => [`\tvar ${variable(s)} *int64`, `\tif ${fieldOf(s)} != nil {`, `\t\t${variable(s)} = &${fieldOf(s)}.ID`, '\t}']);
    const values = columns.map(s => s.kind === 'reference' ? variable(s) : fieldOf(s));
    const selected = ['"id"', ...columns.map(s => quote(s.column))].join(', ');
    const stub = (target: GraphNode) => typeOf({ $type: 'TypeRef', decl: target.qn } as TypeData, scope).replace(/^\*/, '&');
    const saveLinks = links.flatMap(l => [`\tif err := save${name}${pascal(last(l.field.qn))}(ctx, db, x); err != nil {`, '\t\treturn err', '\t}']);
    const loadLinks = (indent: string, record: string) => links.flatMap(l => [`${indent}if err := load${name}${pascal(last(l.field.qn))}(ctx, db, ${record}); err != nil {`, `${indent}\treturn nil, err`, `${indent}}`]);
    const blocks: string[] = [];

    const insert = columns.length
        ? `INSERT INTO ${table} (${columns.map(s => quote(s.column)).join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING "id"`
        : `INSERT INTO ${table} DEFAULT VALUES RETURNING "id"`;
    blocks.push([
        `// Insert${name} stores a new ${name} and sets its ID.`,
        `func Insert${name}(ctx context.Context, ${db}, x *${name}) error {`,
        ...refs,
        `\tif err := db.QueryRow(ctx, \`${insert}\`${values.map(v => `, ${v}`).join('')}).Scan(&x.ID); err != nil {`,
        `\t\treturn fmt.Errorf("insert ${name}: %w", err)`,
        '\t}',
        ...saveLinks,
        '\treturn nil',
        '}'
    ].join('\n'));

    const scans = columns.map(s => s.kind === 'reference' ? `&${variable(s)}` : `&${fieldOf(s)}`);
    blocks.push([
        `// scan${name} reads a row of ${selected}; referenced records get their ID only.`,
        `func scan${name}(row pgx.Row) (*${name}, error) {`,
        `\tx := &${name}{}`,
        ...columns.filter(s => s.kind === 'reference').map(s => `\tvar ${variable(s)} *int64`),
        `\tif err := row.Scan(${['&x.ID', ...scans].join(', ')}); err != nil {`,
        '\t\treturn nil, err',
        '\t}',
        ...columns.filter(s => s.kind === 'reference').flatMap(s => [`\tif ${variable(s)} != nil {`, `\t\t${fieldOf(s)} = ${stub((s as Extract<Stored, { kind: 'reference' }>).target)}{ID: *${variable(s)}}`, '\t}']),
        '\treturn x, nil',
        '}'
    ].join('\n'));

    blocks.push([
        `// Get${name} loads the ${name} with the ID, or returns ${storage.pkg}.ErrNotFound.`,
        `func Get${name}(ctx context.Context, ${db}, id int64) (*${name}, error) {`,
        `\tx, err := scan${name}(db.QueryRow(ctx, \`SELECT ${selected} FROM ${table} WHERE "id" = $1\`, id))`,
        '\tif errors.Is(err, pgx.ErrNoRows) {',
        `\t\treturn nil, fmt.Errorf("${name} %d: %w", id, ${storage.pkg}.ErrNotFound)`,
        '\t}',
        '\tif err != nil {',
        `\t\treturn nil, fmt.Errorf("get ${name} %d: %w", id, err)`,
        '\t}',
        ...loadLinks('\t', 'x'),
        '\treturn x, nil',
        '}'
    ].join('\n'));

    blocks.push([
        `// List${name} loads every ${name} in the order of their IDs.`,
        `func List${name}(ctx context.Context, ${db}) ([]*${name}, error) {`,
        `\trows, err := db.Query(ctx, \`SELECT ${selected} FROM ${table} ORDER BY "id"\`)`,
        '\tif err != nil {',
        `\t\treturn nil, fmt.Errorf("list ${name}: %w", err)`,
        '\t}',
        `\tfound, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (*${name}, error) { return scan${name}(row) })`,
        '\tif err != nil {',
        `\t\treturn nil, fmt.Errorf("list ${name}: %w", err)`,
        '\t}',
        ...(links.length ? ['\tfor _, x := range found {', ...loadLinks('\t\t', 'x'), '\t}'] : []),
        '\treturn found, nil',
        '}'
    ].join('\n'));

    const update = columns.length
        ? `UPDATE ${table} SET ${columns.map((s, i) => `${quote(s.column)} = $${i + 2}`).join(', ')} WHERE "id" = $1`
        : `UPDATE ${table} SET "id" = "id" WHERE "id" = $1`;
    blocks.push([
        `// Update${name} writes the fields of a stored ${name}, or returns ${storage.pkg}.ErrNotFound.`,
        `func Update${name}(ctx context.Context, ${db}, x *${name}) error {`,
        ...refs,
        `\ttag, err := db.Exec(ctx, \`${update}\`, ${['x.ID', ...values].join(', ')})`,
        '\tif err != nil {',
        `\t\treturn fmt.Errorf("update ${name} %d: %w", x.ID, err)`,
        '\t}',
        '\tif tag.RowsAffected() == 0 {',
        `\t\treturn fmt.Errorf("${name} %d: %w", x.ID, ${storage.pkg}.ErrNotFound)`,
        '\t}',
        ...saveLinks,
        '\treturn nil',
        '}'
    ].join('\n'));

    blocks.push([
        `// Delete${name} removes a stored ${name}, or returns ${storage.pkg}.ErrNotFound.`,
        `func Delete${name}(ctx context.Context, ${db}, x *${name}) error {`,
        `\ttag, err := db.Exec(ctx, \`DELETE FROM ${table} WHERE "id" = $1\`, x.ID)`,
        '\tif err != nil {',
        `\t\treturn fmt.Errorf("delete ${name} %d: %w", x.ID, err)`,
        '\t}',
        '\tif tag.RowsAffected() == 0 {',
        `\t\treturn fmt.Errorf("${name} %d: %w", x.ID, ${storage.pkg}.ErrNotFound)`,
        '\t}',
        '\treturn nil',
        '}'
    ].join('\n'));

    for (const link of links) {
        const field = pascal(last(link.field.qn));
        const linkTable = quote(link.table);
        blocks.push([
            `// save${name}${field} replaces the link rows of ${name}.${last(link.field.qn)}.`,
            `func save${name}${field}(ctx context.Context, ${db}, x *${name}) error {`,
            `\tif _, err := db.Exec(ctx, \`DELETE FROM ${linkTable} WHERE "owner_id" = $1\`, x.ID); err != nil {`,
            `\t\treturn fmt.Errorf("save ${name}.${last(link.field.qn)}: %w", err)`,
            '\t}',
            `\tfor _, item := range x.${field} {`,
            `\t\tif _, err := db.Exec(ctx, \`INSERT INTO ${linkTable} ("owner_id", "item_id") VALUES ($1, $2)\`, x.ID, item.ID); err != nil {`,
            `\t\t\treturn fmt.Errorf("save ${name}.${last(link.field.qn)}: %w", err)`,
            '\t\t}',
            '\t}',
            '\treturn nil',
            '}'
        ].join('\n'));
        blocks.push([
            `// load${name}${field} reads the linked records of ${name}.${last(link.field.qn)}, by ID only.`,
            `func load${name}${field}(ctx context.Context, ${db}, x *${name}) error {`,
            `\trows, err := db.Query(ctx, \`SELECT "item_id" FROM ${linkTable} WHERE "owner_id" = $1 ORDER BY "item_id"\`, x.ID)`,
            '\tif err != nil {',
            `\t\treturn fmt.Errorf("load ${name}.${last(link.field.qn)}: %w", err)`,
            '\t}',
            '\tids, err := pgx.CollectRows(rows, pgx.RowTo[int64])',
            '\tif err != nil {',
            `\t\treturn fmt.Errorf("load ${name}.${last(link.field.qn)}: %w", err)`,
            '\t}',
            `\tx.${field} = make(${typeOf(link.field.data.type as TypeData, scope)}, len(ids))`,
            '\tfor i, id := range ids {',
            `\t\tx.${field}[i] = ${stub(link.target)}{ID: id}`,
            '\t}',
            '\treturn nil',
            '}'
        ].join('\n'));
    }
    return goFile(entity.module, 'store.go', context, imports, blocks.join('\n\n'));
}

/**
 * `TestStore<Entity>` in the module's test file: the valid record, with a stored valid record of the same module for
 * every required reference, goes through Insert, Get, List, Update and Delete on a fresh schema. Nothing when a
 * required reference leads to another module, back to itself, or to an entity without a valid record.
 */
function storeTestSteps(entity: GraphNode, context: MapContext, { goFile, validRecord }: Helpers): Step[] {
    const storage = storageOf(context);
    const setup: string[] = [];
    const steps: Step[] = [];
    const made = new Map<string, string>();
    const build = (current: GraphNode, path: Set<string>): string | undefined => {
        const valid = validRecord(current, context);
        if (!valid) return undefined;
        const variable = current.qn === entity.qn ? 'x' : camel(last(current.qn));
        const assignments: string[] = [];
        for (const s of storedFields(current, context)) {
            const type = s.field.data.type as TypeData;
            if (s.kind !== 'reference' || type.optional) continue;
            if (s.target.module !== entity.module || path.has(s.target.qn)) return undefined;
            const found = made.get(s.target.qn) ?? build(s.target, new Set([...path, s.target.qn]));
            if (!found) return undefined;
            assignments.push(`\t${variable}.${pascal(last(s.field.qn))} = ${found}`);
        }
        steps.push(valid.step);
        setup.push(`\t${variable} := ${valid.name}()`, ...assignments);
        if (current.qn !== entity.qn) {
            setup.push(`\tif err := Insert${last(current.qn)}(ctx, db, ${variable}); err != nil {`, `\t\tt.Fatalf("Insert${last(current.qn)}: %v", err)`, '\t}');
            made.set(current.qn, variable);
        }
        return variable;
    };
    if (!build(entity, new Set([entity.qn]))) return [];
    const name = last(entity.qn);
    const code = [
        `func TestStore${name}(t *testing.T) {`,
        `\tdb := ${storage.test}.Open(t)`,
        '\tctx := context.Background()',
        ...setup,
        `\tif err := Insert${name}(ctx, db, x); err != nil {`,
        `\t\tt.Fatalf("Insert${name}: %v", err)`,
        '\t}',
        `\tgot, err := Get${name}(ctx, db, x.ID)`,
        '\tif err != nil {',
        `\t\tt.Fatalf("Get${name}: %v", err)`,
        '\t}',
        '\tif got.ID != x.ID {',
        `\t\tt.Fatalf("Get${name}: want ID %d, got %d", x.ID, got.ID)`,
        '\t}',
        `\tif err := Update${name}(ctx, db, got); err != nil {`,
        `\t\tt.Fatalf("Update${name}: %v", err)`,
        '\t}',
        `\tif all, err := List${name}(ctx, db); err != nil || len(all) != 1 {`,
        `\t\tt.Fatalf("List${name}: want 1 record, got %d (%v)", len(all), err)`,
        '\t}',
        `\tif err := Delete${name}(ctx, db, got); err != nil {`,
        `\t\tt.Fatalf("Delete${name}: %v", err)`,
        '\t}',
        `\tif _, err := Get${name}(ctx, db, x.ID); !errors.Is(err, ${storage.pkg}.ErrNotFound) {`,
        `\t\tt.Fatalf("Get${name} after Delete${name}: want ${storage.pkg}.ErrNotFound, got %v", err)`,
        '\t}',
        '}'
    ].join('\n');
    const imports = new Set(['context', 'errors', 'testing', storage.path, storage.testPath]);
    return [...steps, goFile(entity.module, `${pkgOf(entity.module)}_test.go`, context, imports, code)];
}

/**
 * A model migration step as SQL in this run's goose migration of the block, `<stamp>_appling_<block>.sql`: renames
 * keep the data (columns, reference columns, link tables, tables, stored enum values), a retype alters the column
 * type, a remove drops the column or the table. The Go code that names the element is the follow up task.
 */
export function migrationSteps(change: MigrationChange, context: MapContext): Step[] {
    const storage = storageOf(context);
    const element = change.current ? context.node(change.current) : undefined;
    const parent = change.parent ? context.node(change.parent) : undefined;
    const old = last(change.target);
    const follow = task(`carry the ${change.kind} of ${change.target}${change.newName ? ` to ${change.newName}` : ''} into the Go code that names it; the schema migration is written`);
    const file = `internal/${storage.pkg}/migrations/${change.stamp}_appling_${change.block}.sql`;
    const sql = (statements: string[]): Step => ({
        kind: 'template', file, write: existing => `${(existing ?? '-- +goose Up\n').replace(/\n*$/, '\n')}${statements.join('\n')}\n`
    });

    if (parent?.kind === 'Entity' && (element?.kind === 'Field' || (change.kind === 'remove' && !element))) {
        const ownTable = tableOf(parentOf(change.target));
        if (change.kind === 'remove') {
            return [sql([
                `ALTER TABLE ${quote(ownTable)} DROP COLUMN IF EXISTS ${quote(snake(old))}, DROP COLUMN IF EXISTS ${quote(`${snake(old)}_id`)};`,
                `DROP TABLE IF EXISTS ${quote(`${ownTable}_${snake(old)}`)};`
            ]), follow];
        }
        const stored = storedOf(element!, context);
        if (change.kind === 'rename') {
            const newName = snake(change.newName!);
            if (stored.kind === 'link') return [sql([`ALTER TABLE ${quote(`${ownTable}_${snake(old)}`)} RENAME TO ${quote(`${ownTable}_${newName}`)};`]), follow];
            const suffix = stored.kind === 'reference' ? '_id' : '';
            return [sql([`ALTER TABLE ${quote(ownTable)} RENAME COLUMN ${quote(snake(old) + suffix)} TO ${quote(newName + suffix)};`]), follow];
        }
        const oldEntity = change.oldType?.decl && context.node(change.oldType.decl)?.kind === 'Entity';
        if (stored.kind !== 'column' || oldEntity) return [task(`carry the retype of ${change.target} between records and values into the database and the code`)];
        const type = element!.data.type as TypeData;
        const using = stored.sql === 'jsonb' ? `to_jsonb(${quote(stored.column)})` : `${quote(stored.column)}::${stored.sql}`;
        return [sql([
            `ALTER TABLE ${quote(ownTable)} ALTER COLUMN ${quote(stored.column)} TYPE ${stored.sql} USING ${using}, ALTER COLUMN ${quote(stored.column)} ${type.optional ? 'DROP' : 'SET'} NOT NULL;`
        ]), follow];
    }
    if (element?.kind === 'Entity' && change.kind === 'rename') {
        const from = tableOf(change.target);
        const to = tableOf(`${parentOf(change.target)}.${change.newName}`);
        const links = storedFields(element, context).filter(s => s.kind === 'link').map(s => snake(last(s.field.qn)));
        return [sql([
            `ALTER TABLE ${quote(from)} RENAME TO ${quote(to)};`,
            ...links.map(l => `ALTER TABLE ${quote(`${from}_${l}`)} RENAME TO ${quote(`${to}_${l}`)};`)
        ]), follow];
    }
    if (change.kind === 'remove' && !element && parent?.kind === 'Module') {
        return [sql([`DROP TABLE IF EXISTS ${quote(tableOf(change.target))} CASCADE;`]), follow];
    }
    if (element?.kind === 'EnumLiteral' && change.kind === 'rename') {
        const enumQn = parentOf(element.qn);
        const uses = context.graph.nodes.filter(n => n.kind === 'Field' && (n.data.type as TypeData | undefined)?.decl === enumQn && !(n.data.type as TypeData).many && !n.data.derived && context.node(parentOf(n.qn))?.kind === 'Entity');
        return [sql(uses.map(f => {
            // The field as it is named when this step runs, before the later steps of the module rename it.
            const then = pathAt(change, f.qn, context);
            const column = quote(snake(last(then)));
            return `UPDATE ${quote(tableOf(parentOf(then)))} SET ${column} = '${change.newName}' WHERE ${column} = '${old}';`;
        })), follow];
    }
    return [task(`carry the ${change.kind} of ${change.target} into the database and the code`)];
}

/** The qualified name an element of the change's module had right after the change, undoing the renames of the module's later steps. */
function pathAt(change: MigrationChange, qn: string, context: MapContext): string {
    if (!qn.startsWith(`${change.module}.`)) return qn;
    const steps = context.graph.nodes.filter(n => n.kind === 'Migration' && n.module === change.module)
        .flatMap(m => ((m.data.steps ?? []) as { $type: string, target: string, newName?: string }[]).map((step, index) => ({ step, id: `${m.qn}#${index}` })));
    const later = steps.slice(steps.findIndex(s => s.id === change.id) + 1).filter(s => s.step.$type === 'RenameStep');
    let path = qn.slice(change.module.length + 1);
    for (const { step } of later.reverse()) {
        const renamed = step.target.includes('.') ? `${parentOf(step.target)}.${step.newName}` : step.newName!;
        if (path === renamed || path.startsWith(`${renamed}.`)) path = step.target + path.slice(renamed.length);
    }
    return `${change.module}.${path}`;
}
