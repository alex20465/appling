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

function settingsOf(source: string) {
    return buildWorkspace({ 'shop.appling': source }).then(({ documents, services }) => {
        const result = plan(buildGraph(documents.map(d => d.parseResult.value as Model), services), django, 'shop');
        let settings = '"""Settings."""\n\nfrom pathlib import Path\n';
        for (const { step } of result.steps) if (step.kind === 'template' && step.file === 'config/settings.py') settings = step.write(settings);
        return { settings, makemigrations: result.steps.map(s => s.step).find(s => s.kind === 'command' && s.run.includes('makemigrations')) };
    });
}

test('a secret of type Int or Bool is required too, and a model without secrets gets no helper', async () => {
    const typed = await settingsOf('module shop {\n    external Clerk {\n        setting region: String\n        secret instance: Int\n        secret live: Bool\n    }\n}');
    expect(typed.settings).toContain('CLERK_INSTANCE = int(required_env("CLERK_INSTANCE"))');
    expect(typed.settings).toContain('CLERK_LIVE = required_env("CLERK_LIVE").lower() in ("1", "true", "yes")');
    expect(typed.makemigrations).toMatchObject({ env: { CLERK_INSTANCE: '0', CLERK_LIVE: 'placeholder' } });

    const plain = await settingsOf('module shop {\n    external Clerk {\n        setting region: String\n    }\n}');
    expect(plain.settings).toContain('CLERK_REGION = os.environ.get("CLERK_REGION")');
    expect(plain.settings).not.toContain('required_env');
    expect(plain.settings).not.toContain('ImproperlyConfigured');
    expect(plain.makemigrations).not.toHaveProperty('env');
});

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
    expect(settings).toContain('CLERK_SECRET_KEY = required_env("CLERK_SECRET_KEY")');
    expect(settings).toContain('from pathlib import Path\n\nfrom django.core.exceptions import ImproperlyConfigured\n');
    expect(settings).toContain('def required_env(name):\n    try:\n        return os.environ[name]\n    except KeyError:\n        raise ImproperlyConfigured(f"Set the environment variable {name} (see .env.example)") from None\n');
    expect(settings.indexOf('def required_env(')).toBeLessThan(settings.indexOf('CLERK_SECRET_KEY = '));
    expect(settings.match(/^def required_env\(/gm)).toHaveLength(1);
    const makemigrations = result.steps.map(s => s.step).find(s => s.kind === 'command' && s.run.includes('makemigrations'));
    expect(makemigrations).toMatchObject({ env: { CLERK_SECRET_KEY: 'placeholder' } });
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
