/**
 * The command hook of agents that only run commands as hooks (Gemini CLI): `node hook.cjs <url> <token file>` posts
 * the hook's JSON input from stdin to the session gateway with the session's bearer token, prints nothing and always
 * ends with 0, so the agent goes on as without the hook. CommonJS, with no dependencies, run by the user's `node`.
 */
import { readFileSync } from 'node:fs';

async function main(): Promise<void> {
    const [url, tokenFile] = process.argv.slice(2);
    if (!url || !tokenFile) return;
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const token = readFileSync(tokenFile, 'utf8').trim();
    await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: Buffer.concat(chunks).toString('utf8') || '{}',
        signal: AbortSignal.timeout(3000)
    });
}

main().catch(() => undefined).finally(() => process.exit(0));
