// A stand-in for an agent CLI in the agent session tests: it reaches the Appling MCP server the way the preset wired
// it, reports its label and claims through MCP, and waits for the user the way its wiring tells (a Claude Code
// style HTTP hook from the --settings file, else an OSC 9 notification). Each answer it reads from the terminal is
// printed back; after the second one it exits.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const args = process.argv.slice(2);
const flag = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const claude = flag('--mcp-config');
const server = claude
    ? Object.values(JSON.parse(readFileSync(claude, 'utf8')).mcpServers)[0]
    : { url: process.env.APPLING_MCP_URL, headers: { Authorization: `Bearer ${process.env.APPLING_MCP_TOKEN}` } };

async function call(name, input) {
    const client = new Client({ name: 'fake-agent', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }));
    const result = await client.callTool({ name, arguments: input });
    await client.close();
    return JSON.parse(result.content[0].text);
}

async function hook(event, body) {
    // read again each time: Desktop rewrites the file when its gateway moved to another port
    const handler = JSON.parse(readFileSync(flag('--settings'), 'utf8')).hooks[event][0].hooks[0];
    await fetch(handler.url, { method: 'POST', headers: { 'content-type': 'application/json', ...handler.headers }, body: JSON.stringify(body) });
}

const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const read = async () => (await lines.next()).value;

await call('session_set_label', { label: 'Fake work' });
await call('session_claim', { elements: ['sales.Order'] });
if (claude) await hook('PermissionRequest', { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
else process.stdout.write('\x1b]9;Approval wanted\x07');
console.log(`answer:${JSON.stringify(await read())}`);
await call('session_set_status', { status: 'working', note: 'after the answer' });
if (claude) await hook('Stop', { hook_event_name: 'Stop', last_assistant_message: 'All done\nmore' });
console.log(`reply:${JSON.stringify(await read())}`);
process.exit(0);
