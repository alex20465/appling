import type { MapContext, Step } from '@appling/codegen';
import type { GraphNode, TypeData } from '@appling/model';
import { lastOf } from './elixir.js';
import { app, children, moduleName, snake, task } from './naming.js';

/** The environment variable of an external's key: `<EXTERNAL>_<KEY>` in SCREAMING_SNAKE (`CLERK_SECRET_KEY`). */
export function envName(key: GraphNode): string {
    return `${snake(externalOf(key))}_${snake(lastOf(key.qn))}`.toUpperCase();
}

function externalOf(key: GraphNode): string {
    return lastOf(key.qn.slice(0, key.qn.lastIndexOf('.')));
}

/**
 * A setting or secret is read from the environment in `config/runtime.exs`, under the external's
 * module (`Application.get_env(:shop, Shop.Sales.Clerk)[:secret_key]`), and listed in `.env.example`.
 * A missing setting is `nil` (`false` for a `Bool`); a missing secret stops the app at startup (`System.fetch_env!`).
 */
export function externalKeySteps(key: GraphNode, context: MapContext): Step[] {
    const name = envName(key);
    const line = `config :${app(context)}, ${moduleName(key.module, context)}.${externalOf(key)}, ${lastOf(key.qn)}: ${elixirRead(name, key.data.type as TypeData, key.data.kind === 'secret')}`;
    return [
        {
            kind: 'template', phase: 2, file: 'config/runtime.exs', write: existing => {
                const text = existing ?? 'import Config\n';
                return text.includes(line) ? text : `${text.trimEnd()}\n\n${line}\n`;
            }
        },
        {
            kind: 'template', phase: 2, file: '.env.example', write: existing => {
                if (existing?.split('\n').includes(`${name}=`)) return existing;
                const head = existing ?? '# The settings and secrets of the vendors this app needs. Copy to .env and fill in; never commit values.\n';
                const about = `# ${key.data.kind} of ${externalOf(key)}${key.data.does ? `: ${String(key.data.does).replace(/\s+/g, ' ').trim()}` : ''}`;
                return `${head.trimEnd()}\n\n${about}\n${name}=\n`;
            }
        }
    ];
}

function elixirRead(name: string, type: TypeData, required: boolean): string {
    if (required) {
        const fetch = `System.fetch_env!(${JSON.stringify(name)})`;
        switch (type.primitive) {
            case 'Int': return `${fetch} |> String.to_integer()`;
            case 'Bool': return `${fetch} in ~w(1 true yes)`;
            default: return fetch;
        }
    }
    const get = `System.get_env(${JSON.stringify(name)})`;
    switch (type.primitive) {
        case 'Int': return `${get} |> then(&(&1 && String.to_integer(&1)))`;
        case 'Bool': return `${get} in ~w(1 true yes)`;
        default: return get;
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
