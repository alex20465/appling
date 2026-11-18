import type { MapContext, Step } from '@appling/codegen';
import type { GraphNode, TypeData } from '@appling/model';
import { children, leftToCode, template } from './files.js';
import { lastOf, snake } from './python.js';

/** The environment variable of an external's key: `<EXTERNAL>_<KEY>` in SCREAMING_SNAKE (`CLERK_SECRET_KEY`). */
export function envName(key: GraphNode): string {
    const external = lastOf(key.qn.slice(0, key.qn.lastIndexOf('.')));
    return `${snake(external)}_${snake(lastOf(key.qn))}`.toUpperCase();
}

const IMPROPERLY_CONFIGURED = 'from django.core.exceptions import ImproperlyConfigured';

/**
 * A setting or secret is read from the environment in `config/settings.py` and listed in `.env.example`.
 * A missing setting is `None` (`False` for a `Bool`); a missing secret stops the app at startup.
 */
export function externalKeySteps(key: GraphNode, context: MapContext): Step[] {
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
                text = `${text.trimEnd()}\n\n\n${context.render('vendors/required-env.py.njk', {})}\n`;
            }
            const line = context.render('vendors/setting.py.njk', { name, secret, primitive: (key.data.type as TypeData).primitive ?? '' });
            return `${text.trimEnd()}\n\n${line}\n`;
        }),
        envExample(key, name, context)
    ];
}

export function envExample(key: GraphNode, name: string, context: MapContext): Step {
    return template('.env.example', existing => {
        if (existing?.split('\n').includes(`${name}=`)) return existing;
        const head = existing ?? context.render('vendors/env-example.njk', {});
        const describe = key.data.describe ? String(key.data.describe).replace(/\s+/g, ' ').trim() : '';
        const entry = context.render('vendors/env-entry.njk', { kind: key.data.kind, external: lastOf(key.qn.slice(0, key.qn.lastIndexOf('.'))), describe, name });
        return `${head.trimEnd()}\n\n${entry}\n`;
    });
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
            tasks.push(leftToCode(`register ${endpoint.data.verb} ${endpoint.data.path} as a webhook at ${vendor} for the events ${target} handles`));
            tasks.push(leftToCode(`receive ${endpoint.data.verb} ${endpoint.data.path} from ${vendor} for ${name}: verify the signature, then call ${target}`));
        }
    }
    if (api.data.authBy) {
        const roles = context.graph.nodes.filter(n => n.kind === 'Role').map(r => lastOf(r.qn));
        tasks.push(leftToCode(`set up ${lastOf(api.data.authBy as string)} to issue ${api.data.auth} tokens for ${name}${roles.length ? ` with a role claim naming ${roles.join(', ')}` : ''}`));
    }
    return tasks;
}
