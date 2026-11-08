import { expect, test } from 'vitest';
import type { Model } from '@appling/lang';
import { plan } from '@appling/codegen';
import { buildGraph } from '@appling/model';
import { buildWorkspace } from '../../lang/test/workspace.js';
import django from '../src/index.js';

const VENDORS = `module shop {
    role Admin
    entity Account { name: String }
    action Sync on Account { set name = "x" }
    external Clerk {
        setting region: String does "The region of the Clerk instance"
        setting max_sessions: Int
        setting test_mode: Bool
        secret secret_key: String does "API keys page of the Clerk dashboard"
    }
    interface rest Api {
        auth bearer from Clerk
    }
    interface webhook ClerkEvents from Clerk {
        POST "/webhooks/clerk" -> Sync
    }
}`;

test('external keys are read from the environment and listed in .env.example, the vendor side setup becomes tasks', async () => {
    const { documents, services } = await buildWorkspace({ 'shop.appling': VENDORS });
    const result = plan(buildGraph(documents.map(d => d.parseResult.value as Model), services), django, 'shop');
    const files = new Map<string, string>([['config/settings.py', '"""Settings."""\n\nfrom pathlib import Path\n\nINSTALLED_APPS = [\n]\n']]);
    for (const { step } of result.steps) {
        if (step.kind === 'template' && (step.file === 'config/settings.py' || step.file === '.env.example')) files.set(step.file, step.write(files.get(step.file)));
    }
    const settings = files.get('config/settings.py')!;
    expect(settings).toContain('"""Settings."""\n\nimport os\nfrom pathlib import Path\n');
    expect(settings.match(/^import os$/gm)).toHaveLength(1);
    expect(settings).toContain('CLERK_REGION = os.environ.get("CLERK_REGION")');
    expect(settings).toContain('CLERK_MAX_SESSIONS = int(os.environ["CLERK_MAX_SESSIONS"]) if "CLERK_MAX_SESSIONS" in os.environ else None');
    expect(settings).toContain('CLERK_TEST_MODE = os.environ.get("CLERK_TEST_MODE", "").lower() in ("1", "true", "yes")');
    expect(settings).toContain('CLERK_SECRET_KEY = os.environ.get("CLERK_SECRET_KEY")');
    const env = files.get('.env.example')!;
    expect(env).toContain('# setting of Clerk: The region of the Clerk instance\nCLERK_REGION=\n');
    expect(env).toContain('# secret of Clerk: API keys page of the Clerk dashboard\nCLERK_SECRET_KEY=\n');
    expect(env.match(/=\n/g)).toHaveLength(4);
    const entries = Object.fromEntries(result.entries.map(e => [e.qn, e]));
    expect(entries['shop.Clerk.max_sessions'].status).toBe('generated');
    expect(entries['shop.ClerkEvents'].missing.map(m => m.what)).toEqual([
        'register POST /webhooks/clerk as a webhook at Clerk for the events Sync handles',
        'receive POST /webhooks/clerk from Clerk for ClerkEvents: verify the signature, then call Sync'
    ]);
    expect(entries['shop.Api'].missing.map(m => m.what)).toContain('set up Clerk to issue bearer tokens for Api with a role claim naming Admin');
});
