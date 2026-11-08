import type { MapContext, Step } from '@appling/codegen';
import type { GraphNode, TypeData } from '@appling/model';
import { children, task, template } from './files.js';
import { lastOf, snake } from './python.js';

/** The environment variable of an external's key: `<EXTERNAL>_<KEY>` in SCREAMING_SNAKE (`CLERK_SECRET_KEY`). */
export function envName(key: GraphNode): string {
    const external = lastOf(key.qn.slice(0, key.qn.lastIndexOf('.')));
    return `${snake(external)}_${snake(lastOf(key.qn))}`.toUpperCase();
}

const IMPROPERLY_CONFIGURED = 'from django.core.exceptions import ImproperlyConfigured';

/** Defined once in `config/settings.py` before the first secret: reads a variable or stops the app naming it. */
const REQUIRED_ENV = `def required_env(name):
    try:
        return os.environ[name]
    except KeyError:
        raise ImproperlyConfigured(f"Set the environment variable {name} (see .env.example)") from None`;

/**
 * A setting or secret is read from the environment in `config/settings.py` and listed in `.env.example`.
 * A missing setting is `None` (`False` for a `Bool`); a missing secret stops the app at startup.
 */
export function externalKeySteps(key: GraphNode): Step[] {
    const name = envName(key);
    const secret = key.data.kind === 'secret';
    return [
        template('config/settings.py', existing => {
            let text = existing!;
            if (text.includes(`\n${name} = `)) return text;
            if (!/^import os$/m.test(text)) text = /^from pathlib import Path$/m.test(text) ? text.replace(/^from pathlib import Path$/m, 'import os\nfrom pathlib import Path') : `import os\n${text}`;
            if (secret && !text.includes('\ndef required_env(')) {
                if (!text.includes(IMPROPERLY_CONFIGURED)) text = text.replace(/^from pathlib import Path\n/m, `from pathlib import Path\n\n${IMPROPERLY_CONFIGURED}\n`);
                if (!text.includes(IMPROPERLY_CONFIGURED)) text = `${IMPROPERLY_CONFIGURED}\n${text}`;
                text = `${text.trimEnd()}\n\n\n${REQUIRED_ENV}\n`;
            }
            const read = secret ? requiredRead(name, key.data.type as TypeData) : pythonRead(name, key.data.type as TypeData);
            return `${text.trimEnd()}\n\n${name} = ${read}\n`;
        }),
        envExample(key, name)
    ];
}

export function envExample(key: GraphNode, name: string): Step {
    return template('.env.example', existing => {
        if (existing?.split('\n').includes(`${name}=`)) return existing;
        const head = existing ?? '# The settings and secrets of the vendors this app needs. Copy to .env and fill in; never commit values.\n';
        const about = `# ${key.data.kind} of ${lastOf(key.qn.slice(0, key.qn.lastIndexOf('.')))}${key.data.does ? `: ${String(key.data.does).replace(/\s+/g, ' ').trim()}` : ''}`;
        return `${head.trimEnd()}\n\n${about}\n${name}=\n`;
    });
}

function requiredRead(name: string, type: TypeData): string {
    const read = `required_env(${JSON.stringify(name)})`;
    switch (type.primitive) {
        case 'Int': return `int(${read})`;
        case 'Bool': return `${read}.lower() in ("1", "true", "yes")`;
        default: return read;
    }
}

function pythonRead(name: string, type: TypeData): string {
    const quoted = JSON.stringify(name);
    switch (type.primitive) {
        case 'Int': return `int(os.environ[${quoted}]) if ${quoted} in os.environ else None`;
        case 'Bool': return `os.environ.get(${quoted}, "").lower() in ("1", "true", "yes")`;
        default: return `os.environ.get(${quoted})`;
    }
}

/**
 * Placeholder values for every secret, for the generator's own commands that load the settings
 * (which stop without them). Empty when the model has no secrets.
 */
export function secretPlaceholders(context: MapContext): { env?: Record<string, string> } {
    const secrets = context.graph.nodes.filter(n => n.kind === 'ExternalKey' && n.data.kind === 'secret');
    if (!secrets.length) return {};
    return { env: Object.fromEntries(secrets.map(key => [envName(key), (key.data.type as TypeData).primitive === 'Int' ? '0' : 'placeholder'])) };
}

/** The vendor side of an interface: the webhook endpoints to register, the tokens to issue for `auth ... from`. */
export function vendorTasks(api: GraphNode, context: MapContext): Step[] {
    const tasks: Step[] = [];
    const name = lastOf(api.qn);
    if (api.data.protocol === 'webhook') {
        const vendor = api.data.source ? lastOf(api.data.source as string) : 'the vendor';
        for (const endpoint of children(api, context, 'Endpoint')) {
            const target = lastOf(endpoint.data.target as string);
            tasks.push(task(`register ${endpoint.data.verb} ${endpoint.data.path} as a webhook at ${vendor} for the events ${target} handles`));
            tasks.push(task(`receive ${endpoint.data.verb} ${endpoint.data.path} from ${vendor} for ${name}: verify the signature, then call ${target}`));
        }
    }
    if (api.data.authBy) {
        const roles = context.graph.nodes.filter(n => n.kind === 'Role').map(r => lastOf(r.qn));
        tasks.push(task(`set up ${lastOf(api.data.authBy as string)} to issue ${api.data.auth} tokens for ${name}${roles.length ? ` with a role claim naming ${roles.join(', ')}` : ''}`));
    }
    return tasks;
}
