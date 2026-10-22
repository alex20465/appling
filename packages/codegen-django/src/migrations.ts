import type { MapContext, MigrationChange, ProjectFiles, Step } from '@appling/codegen';
import type { GraphNode, TypeData } from '@appling/model';
import { task, template } from './files.js';
import { djangoField } from './models.js';
import { appOf, constantOf, lastOf, parentOf } from './python.js';

/**
 * Carries one Appling migration step into the generated project: a Django migration with the
 * operation that keeps the data (rename instead of drop and add), and the same change in the model code.
 */
export function migrationSteps(change: MigrationChange, context: MapContext, files: ProjectFiles): Step[] {
    const element = change.current ? context.node(change.current) : undefined;
    const parent = change.parent ? context.node(change.parent) : undefined;
    const old = lastOf(change.target);
    const follow = task(`update the code that uses ${change.target} after the ${change.kind}${change.newName ? ` to ${change.newName}` : ''}; models and migrations are done`);

    if (parent?.kind === 'Entity' && (element?.kind === 'Field' || (change.kind === 'remove' && !element))) {
        const app = appOf(parent.module);
        const model = lastOf(parent.qn);
        const imports = new Set<string>();
        const models = `${app}/models.py`;
        if (change.kind === 'rename') {
            return [
                operation(app, change.block, files, `migrations.RenameField(model_name=${JSON.stringify(model.toLowerCase())}, old_name=${JSON.stringify(old)}, new_name=${JSON.stringify(change.newName)})`, imports),
                template(models, text => inClass(text!, model, body => body.replace(new RegExp(`\\n    ${old} = `), `\n    ${change.newName} = `))),
                follow
            ];
        }
        if (change.kind === 'retype') {
            const field = djangoField(element!, context, imports);
            return [
                operation(app, change.block, files, `migrations.AlterField(model_name=${JSON.stringify(model.toLowerCase())}, name=${JSON.stringify(old)}, field=${frozen(field, context)})`, frozenImports(imports)),
                template(models, text => withImports(inClass(text!, model, body => body.replace(new RegExp(`\\n    ${old} = [^\\n]*`), `\n    ${old} = ${field}`)), imports)),
                follow
            ];
        }
        return [
            operation(app, change.block, files, `migrations.RemoveField(model_name=${JSON.stringify(model.toLowerCase())}, name=${JSON.stringify(old)})`, imports),
            template(models, text => inClass(text!, model, body => body.replace(new RegExp(`\\n    ${old} = [^\\n]*`), ''))),
            follow
        ];
    }
    if (element?.kind === 'Entity' && change.kind === 'rename') {
        const app = appOf(element.module);
        return [
            operation(app, change.block, files, `migrations.RenameModel(old_name=${JSON.stringify(old)}, new_name=${JSON.stringify(change.newName)})`, new Set()),
            template(`${app}/models.py`, text => text!.replace(new RegExp(`\\nclass ${old}\\(models\\.Model\\):`), `\nclass ${change.newName}(models.Model):`)),
            follow
        ];
    }
    if (change.kind === 'remove' && !element && parent?.kind === 'Module') {
        const app = appOf(parent.qn);
        return [
            operation(app, change.block, files, `migrations.DeleteModel(name=${JSON.stringify(old)})`, new Set()),
            template(`${app}/models.py`, text => text!.replace(new RegExp(`\\n\\n\\nclass ${old}\\(models\\.Model\\):[\\s\\S]*?(?=\\n\\n\\n|\\n?$)`), '')),
            follow
        ];
    }
    if (element?.kind === 'EnumLiteral' && change.kind === 'rename') return enumRename(change, element, context, files, follow);
    return [task(`carry the ${change.kind} of ${change.target} into the database and the code`)];
}

/** A renamed enum value: the stored values change in a data migration, the choices and the enum class follow. */
function enumRename(change: MigrationChange, literal: GraphNode, context: MapContext, files: ProjectFiles, follow: Step): Step[] {
    const enumNode = context.node(parentOf(literal.qn))!;
    const old = lastOf(change.target);
    const uses = context.graph.nodes.filter(n => n.kind === 'Field' && (n.data.type as TypeData | undefined)?.decl === enumNode.qn && context.node(parentOf(n.qn))?.kind === 'Entity');
    const steps: Step[] = uses.flatMap(field => {
        const entity = context.node(parentOf(field.qn))!;
        const app = appOf(entity.module);
        const imports = new Set<string>();
        const code = frozen(djangoField(field, context, imports), context);
        const name = lastOf(field.qn);
        const update = `apps.get_model(${JSON.stringify(app)}, ${JSON.stringify(lastOf(entity.qn))}).objects.filter(${name}=${JSON.stringify(old)}).update(${name}=${JSON.stringify(change.newName)})`;
        return [
            operation(app, change.block, files, `migrations.AlterField(model_name=${JSON.stringify(lastOf(entity.qn).toLowerCase())}, name=${JSON.stringify(name)}, field=${code})`, frozenImports(imports)),
            operation(app, change.block, files, `migrations.RunPython(lambda apps, schema_editor: ${update}, migrations.RunPython.noop)`, new Set())
        ];
    });
    const [from, to] = [`${lastOf(enumNode.qn)}.${constantOf(old)}`, `${lastOf(enumNode.qn)}.${constantOf(change.newName!)}`];
    const apps = context.graph.nodes.filter(n => n.kind === 'Module').map(m => appOf(m.qn));
    const references = apps.flatMap(app => files.list(app).filter(f => f.endsWith('.py')).map(f => `${app}/${f}`)).filter(f => files.read(f)?.includes(from));
    return [
        ...steps,
        template(`${appOf(enumNode.module)}/enums.py`, text => text!.replace(`    ${constantOf(old)} = ${JSON.stringify(old)}`, `    ${constantOf(change.newName!)} = ${JSON.stringify(change.newName)}`)),
        ...references.map(file => template(file, text => text!.replaceAll(from, to))),
        follow
    ];
}

/** Adds an operation to the app's migration for this block, creating it after the app's latest migration. */
function operation(app: string, block: string, files: ProjectFiles, code: string, imports: Set<string>): Step {
    const existing = files.list(`${app}/migrations`).filter(f => /^\d{4}_.*\.py$/.test(f));
    const own = existing.find(f => f.endsWith(`_appling_${block}.py`));
    const previous = existing.filter(f => f !== own).at(-1);
    const file = own ?? `${String(existing.length ? Number(existing.at(-1)!.slice(0, 4)) + 1 : 1).padStart(4, '0')}_appling_${block}.py`;
    return template(`${app}/migrations/${file}`, text => {
        const start = text ?? [
            'from django.db import migrations, models',
            '',
            '',
            'class Migration(migrations.Migration):',
            `    dependencies = [${previous ? `(${JSON.stringify(app)}, ${JSON.stringify(previous.replace(/\.py$/, ''))})` : ''}]`,
            '',
            '    operations = [',
            '    ]',
            ''
        ].join('\n');
        return withImports(start.replace(/\n    \]\n$/, `\n        ${code},\n    ]\n`), imports);
    });
}

/** Field code for a migration: enum choices and values written out, as Django does, so history does not follow later code. */
function frozen(code: string, context: MapContext): string {
    for (const enumNode of context.graph.nodes.filter(n => n.kind === 'Enum')) {
        const name = lastOf(enumNode.qn);
        const values = context.children(enumNode.qn).map(l => lastOf(l.qn));
        code = code.replaceAll(`${name}.choices`, `[${values.map(v => `(${JSON.stringify(v)}, ${JSON.stringify(label(v))})`).join(', ')}]`);
        for (const value of values) code = code.replaceAll(`${name}.${constantOf(value)}`, JSON.stringify(value));
    }
    return code;
}

/** The label Django's TextChoices derives from a member name. */
function label(value: string): string {
    return value.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).replace(/ (\w)/g, m => m.toLowerCase()).replace(/^./, c => c.toUpperCase());
}

function frozenImports(imports: Set<string>): Set<string> {
    return new Set([...imports].filter(line => !line.includes('.enums import')));
}

function inClass(text: string, model: string, change: (body: string) => string): string {
    return text.replace(new RegExp(`(\\nclass ${model}\\(models\\.Model\\):)([\\s\\S]*?)(?=\\n\\n\\nclass |\\n?$)`), (_, head, body) => head + change(body));
}

function withImports(text: string, imports: Set<string>): string {
    const missing = [...imports].filter(line => !text.includes(line));
    return missing.length ? `${missing.sort().join('\n')}\n${text}` : text;
}
