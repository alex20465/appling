import { expect, test } from 'vitest';
import type { Model } from '@appling/lang';
import { plan } from '@appling/codegen';
import { buildGraph } from '@appling/model';
import { buildWorkspace } from '../../lang/test/workspace.js';
import ash from '../src/index.js';

test('external keys are read from the environment in runtime.exs and listed in .env.example, the vendor side setup becomes tasks', async () => {
    const { documents, services } = await buildWorkspace({ 'shop.appling': `module shop {
        entity Account { name: String }
        action Sync on Account { set name = "x" }
        external Clerk {
            setting max_sessions: Int
            setting test_mode: Bool
            secret secret_key: String does "API keys page of the Clerk dashboard"
        }
        interface webhook ClerkEvents from Clerk {
            POST "/webhooks/clerk" -> Sync
        }
    }` });
    const result = plan(buildGraph(documents.map(d => d.parseResult.value as Model), services), ash, 'shop');
    const files = new Map<string, string>();
    for (const { step } of result.steps) {
        if (step.kind === 'template' && (step.file === 'config/runtime.exs' || step.file === '.env.example')) files.set(step.file, step.write(files.get(step.file)));
    }
    expect(files.get('config/runtime.exs')).toBe([
        'import Config', '',
        'config :shop, Shop.Shop.Clerk, max_sessions: System.get_env("CLERK_MAX_SESSIONS") |> then(&(&1 && String.to_integer(&1)))', '',
        'config :shop, Shop.Shop.Clerk, test_mode: System.get_env("CLERK_TEST_MODE") in ~w(1 true yes)', '',
        'config :shop, Shop.Shop.Clerk, secret_key: System.fetch_env!("CLERK_SECRET_KEY")', ''
    ].join('\n'));
    expect(result.steps.map(s => s.step).find(s => s.kind === 'command' && s.run.includes('ash.codegen'))).toMatchObject({ env: { CLERK_SECRET_KEY: 'placeholder' } });
    expect(files.get('.env.example')).toContain('# secret of Clerk: API keys page of the Clerk dashboard\nCLERK_SECRET_KEY=\n');
    const entries = Object.fromEntries(result.entries.map(e => [e.qn, e]));
    expect(entries['shop.Clerk.max_sessions'].status).toBe('generated');
    expect(entries['shop.ClerkEvents'].missing.map(m => m.what)).toEqual([
        'register POST /webhooks/clerk as a webhook at Clerk for the events Sync handles',
        'receive POST /webhooks/clerk from Clerk for ClerkEvents: verify the signature, then call Sync'
    ]);
});
