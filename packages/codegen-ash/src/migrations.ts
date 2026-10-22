import type { MapContext, MigrationChange, ProjectFiles, Step } from '@appling/codegen';
import type { TypeData } from '@appling/model';
import { lastOf } from './elixir.js';
import { app, attributeType, fileOf, pascal, task } from './naming.js';

const COLUMNS: Record<string, string> = {
    string: ':text', integer: ':bigint', decimal: ':decimal', boolean: ':boolean', date: ':date',
    utc_datetime_usec: ':utc_datetime_usec', duration: ':interval', uuid: ':uuid'
};

/**
 * Carries one Appling migration step into the generated project: the resource changes, an Ecto
 * migration renames, retypes or removes the column, and the resource snapshots are brought up to date
 * so `mix ash.codegen` does not guess a rename as a drop and an add.
 */
export function migrationSteps(change: MigrationChange, context: MapContext, files: ProjectFiles): Step[] {
    const parent = change.parent ? context.node(change.parent) : undefined;
    const element = change.current ? context.node(change.current) : undefined;
    if (parent?.kind !== 'Entity' || (element && element.kind !== 'Field')) {
        return [task(`carry the ${change.kind} of ${change.target} into the resources and the database`)];
    }
    const resource = fileOf(parent, context);
    const table = /\n\s+table "(\w+)"/.exec(files.read(resource) ?? '')?.[1];
    if (!table) return [task(`carry the ${change.kind} of ${change.target} into ${resource}`)];
    const old = lastOf(change.target);
    const atom = new RegExp(`:${old}\\b`, 'g');
    let patch: (text: string) => string;
    let statement: string;
    if (change.kind === 'rename') {
        patch = text => text.replace(atom, `:${change.newName}`);
        statement = `rename table(:${table}), :${old}, to: :${change.newName}`;
    } else if (change.kind === 'retype') {
        const type = element!.data.type as TypeData;
        patch = text => text.replace(new RegExp(`(\\n\\s+attribute :${old}, )[^,\\n]+( do|,)`), `$1${elixirType(type, context)}$2`);
        statement = `alter table(:${table}) do\n      modify :${old}, ${column(type, context)}\n    end`;
    } else {
        patch = text => text
            .replace(new RegExp(`\\n\\s+attribute :${old}, [^\\n]* do\\n[\\s\\S]*?\\n\\s+end\\n`), '\n')
            .replace(new RegExp(`\\n\\s+attribute :${old}, [^\\n]*\\n`), '\n')
            .replace(new RegExp(`(, )?:${old}\\b(, )?`, 'g'), (_, before, after) => (before && after ? ', ' : ''));
        statement = `alter table(:${table}) do\n      remove :${old}\n    end`;
    }
    const migration = `priv/repo/migrations/${change.stamp}_appling_${change.block}.exs`;
    const module = `${pascal(app(context))}.Repo.Migrations.Appling${pascal(change.block)}`;
    return [
        { kind: 'template', file: resource, write: existing => patch(existing!) },
        {
            kind: 'template', file: migration, write: existing => (existing
                ?? `defmodule ${module} do\n  use Ecto.Migration\n\n  def change do\n  end\nend\n`).replace(/\n  end\nend\n$/, `\n    ${statement}\n  end\nend\n`)
        },
        { kind: 'command', run: ['mix', 'ash_postgres.generate_migrations', '--snapshots-only'], phase: 1 },
        task(`update the code that uses ${change.target} after the ${change.kind}${change.newName ? ` to ${change.newName}` : ''}; resources and migrations are done`)
    ];
}

function elixirType(type: TypeData, context: MapContext): string {
    const base = attributeType(type, context, true);
    return type.many ? `{:array, ${base}}` : base;
}

function column(type: TypeData, context: MapContext): string {
    const decl = type.decl ? context.node(type.decl) : undefined;
    const base = decl?.kind === 'ValueType' ? ':map' : decl ? ':text' : COLUMNS[attributeType(type, context)];
    return type.many ? `{:array, ${base}}` : base;
}
