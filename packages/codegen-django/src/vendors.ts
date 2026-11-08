import type { MapContext, Step } from '@appling/codegen';
import type { GraphNode, TypeData } from '@appling/model';
import { children, task, template } from './files.js';
import { lastOf, snake } from './python.js';

/** The environment variable of an external's key: `<EXTERNAL>_<KEY>` in SCREAMING_SNAKE (`CLERK_SECRET_KEY`). */
export function envName(key: GraphNode): string {
    const external = lastOf(key.qn.slice(0, key.qn.lastIndexOf('.')));
    return `${snake(external)}_${snake(lastOf(key.qn))}`.toUpperCase();
}

/** A setting or secret is read from the environment in `config/settings.py` and listed in `.env.example`. */
export function externalKeySteps(key: GraphNode): Step[] {
    const name = envName(key);
    return [
        template('config/settings.py', existing => {
            let text = existing!;
            if (text.includes(`\n${name} = `)) return text;
            if (!/^import os$/m.test(text)) text = /^from pathlib import Path$/m.test(text) ? text.replace(/^from pathlib import Path$/m, 'import os\nfrom pathlib import Path') : `import os\n${text}`;
            return `${text.trimEnd()}\n\n${name} = ${pythonRead(name, key.data.type as TypeData)}\n`;
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

function pythonRead(name: string, type: TypeData): string {
    const quoted = JSON.stringify(name);
    switch (type.primitive) {
        case 'Int': return `int(os.environ[${quoted}]) if ${quoted} in os.environ else None`;
        case 'Bool': return `os.environ.get(${quoted}, "").lower() in ("1", "true", "yes")`;
        default: return `os.environ.get(${quoted})`;
    }
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
