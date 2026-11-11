import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import open from 'open';
import { startIdeProcess } from '@appling/ide/process';

/** Serves the IDE for a folder, opens it in the browser and runs until the server ends or Ctrl+C. */
export async function ide([folder = '.']: string[]): Promise<number> {
    const root = resolve(folder);
    if (!existsSync(root)) {
        console.error(`${root} does not exist`);
        return 1;
    }
    const server = await startIdeProcess(root).catch((error: Error) => error);
    if (server instanceof Error) {
        console.error(server.message);
        return 1;
    }
    console.log(`Appling IDE for ${root} at ${server.url}\nPress Ctrl+C to stop.`);
    await open(server.url).catch(() => undefined);
    process.once('SIGINT', () => server.close());
    return new Promise(done => server.child.once('exit', code => done(code ? 1 : 0)));
}
