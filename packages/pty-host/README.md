# @appling/pty-host

The Appling pty host: a per user background process that owns the terminals of Appling Desktop, so they keep running when the app closes or crashes and come back with their scrollback when it reattaches. It works the way VS Code's pty host does: [`node-pty`](https://github.com/microsoft/node-pty) runs the shells, every terminal is mirrored into an [`@xterm/headless`](https://www.npmjs.com/package/@xterm/headless) terminal, and on attach the [serialize addon](https://www.npmjs.com/package/@xterm/addon-serialize) replays its screen and scrollback as escape sequences for xterm.js.

In development (issues #9 and #18); the package is private.

## Use it

```ts
import { connectPtyHost } from '@appling/pty-host';

const host = await connectPtyHost();              // connects, or starts the host when none runs
const info = await host.spawn({ cwd: '/work/shop', group: '/work/shop', cols: 120, rows: 30 });
const terminal = await host.attach(info.id);
xterm.write(terminal.scrollback);                 // the screen and scrollback so far
terminal.onData(data => xterm.write(data));       // then the live output
xterm.onData(data => terminal.write(data));
terminal.onExit(({ code }) => console.log('ended with', code));
host.close();                                     // detaches; the shell keeps running
```

`PtyHostClient` methods: `spawn(options)`, `spawnAttached(options)` (spawn and attach in one, with the output from the first byte as `data`, so nothing a program prints at once lands only in the scrollback), `list(group?)`, `attach(id, { cols, rows }?)`, `write(id, data)`, `resize(id, cols, rows)`, `kill(id, signal?)` (without a signal ends and removes the terminal, with one only sends it), `detach(id)`, `update(id, { meta, title })` (merges into the metadata, `null` removes a key), `subscribe()` (resolves with every terminal, then emits `terminal`, `status` and `removed` for all of them, attached or not), `unsubscribe()`, `shutdown()` (ends every terminal and the host) and `close()`. `spawn` takes `cwd`, `shell` (default `$SHELL`, `%COMSPEC%` on Windows), `args`, `env` (default the caller's environment; `TERM=xterm-256color` and `COLORTERM=truecolor` are set), `cols`, `rows`, `group` (a free label such as the repo folder, which `list` filters by), `title`, `scrollback` (lines, default 10000), `attach` (queue the output for the spawning client until its `attach`) and `meta` (free string metadata, such as an agent session's `preset` and `label`). A terminal whose process ended stays listed with its `exit` and its scrollback until it is killed.

`connectPtyHost({ dir, start, host: { node, main, env, idleTimeout, timeout, open, notify } })`: `start: false` only connects. `main` is the host's entry (default this package's `out/main.js`; the packaged Desktop passes its bundled copy). A host it starts runs detached in its own session with `node` (default the current executable, run as Node through `ELECTRON_RUN_AS_NODE`, so Electron can pass its own binary) and exits after `idleTimeout` milliseconds (default 60000, 0 never) without connected clients and without running terminals. `open` is the program a click on a notification runs, `{terminal}` standing for the terminal's id (Desktop passes `Appling --session {terminal}`); `notify: false` starts the host without notifications.

## Status and notifications

The host keeps a status per terminal from its output alone, so it is known while no app is attached: `{ state: 'running' }`, `{ state: 'needsInput', notification: { title?, body, source } }` after an OSC 9 (`ESC ] 9 ; body BEL`, without ConEmu's numbered subcommands such as `9;4` progress) or OSC 777 (`ESC ] 777 ; notify ; title ; body BEL`) notification until the next input, and `{ state: 'exited', code, signal? }`. Each carries `since` (milliseconds since the epoch). `list` and `subscribe` report it in `TerminalInfo.status`.

When a terminal needs input and no client is attached to it (also when the last one detaches later), the host raises one desktop notification per wait through its `Notifier`, titled with the notification's title, else `meta.label` or the terminal's title and the group's folder name. `meta.notify: 'off'` turns them off for a terminal. `systemNotifier()` is the operating system's:

| Platform | How | Open | Reply |
|---|---|---|---|
| Linux | `gdbus` over `org.freedesktop.Notifications` when the server offers `inline-reply`, else `notify-send` | yes (libnotify 0.7.9+) | where the server offers `inline-reply` |
| macOS | `osascript` dialog | yes | yes |
| Windows | PowerShell toast | yes | yes |

Open runs the `open` command; a reply is written to the pty followed by Enter. The status logic (`StatusTracker`, `NotificationScanner`) and the `Notifier` interface do not depend on the transport, so a remote host keeps the same status and reports it over its own connection, and runs with `--no-notify`.

## Command

```sh
appling-pty-host serve [--dir <folder>] [--idle-timeout <ms>] [--open <json argv>] [--no-notify]   # run a host in the foreground
appling-pty-host list [--group <name>] [--json] [--dir <folder>]  # id, status, pid, group, title, metadata, cwd per line
appling-pty-host kill <terminal> [--dir <folder>]
appling-pty-host stop [--dir <folder>]                           # end every terminal and the host
```

Exit codes: 0 done (also `list` without a running host, and `serve` when a host already runs), 1 no running host for `kill` or `stop`, or the request failed, 2 usage error.

## Security

The host's folder is `$APPLING_PTY_HOST_DIR`, else `$XDG_RUNTIME_DIR/appling-pty-host` on Linux, `<temp>/appling-pty-host-<uid>` on other Unix systems and `%LOCALAPPDATA%\appling\pty-host` on Windows. It must belong to the user with mode 0700, or the host and the client refuse it. It holds the socket (mode 0600; on Windows a named pipe derived from the user and the folder), the log `pty-host.log` and a `token` (mode 0600) that the host writes anew on every start. A client must send that token in its first message; anything else closes the connection.

## Protocol

Newline delimited JSON. Requests carry an `id` and get one `response` with it: `hello { token, protocol }`, `spawn { options }`, `list { group? }`, `update { terminal, meta?, title? }`, `subscribe`, `unsubscribe`, `attach { terminal, cols?, rows? }` (result `{ terminal, scrollback }`), `detach`, `resize`, `kill { terminal, signal? }`, `shutdown`. `input { terminal, data }` has no `id` and no response. The host sends `data { terminal, data }` and `exit { terminal, code, signal? }` for attached terminals, and `terminal { info }`, `status { terminal, status }` and `removed { terminal }` to subscribed clients. Protocol version 2. The snapshot of an `attach` is taken after the headless terminal parsed everything so far; output that arrives in between follows right after the response, so nothing is lost or doubled.

## Not yet

Flow control for fast output to a slow client and remote hosts (#17). Desktop does its own shell integration and ends the terminals with the app (`terminal.endWithApp`).

## License

MIT
