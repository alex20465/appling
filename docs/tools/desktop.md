---
title: Desktop
description: Install Appling Desktop, the native app that opens many repos with the model canvas as the main area of each, and keep it up to date.
---

Appling Desktop is a native app for Linux, Windows and macOS. It groups repos into workspaces, runs the [IDE](ide.md) once per repo and shows the model canvas as the main area of each. It is in development: the builds come from the `desktop-v<version>` tags of the repository, and there is no release yet.

## Install

Download the file for your system from the [releases](https://github.com/alex20465/appling/releases) of the repository. Desktop releases are titled **Appling Desktop**.

| System | File | Install |
|---|---|---|
| Linux (x64) | `Appling-<version>-linux-x86_64.AppImage` | Make it executable (`chmod +x Appling-*.AppImage`) and run it. No installation needed |
| Windows (x64) | `Appling-Setup-<version>-x64.exe` | Run the installer. It installs for your user only, without admin rights |
| macOS (Apple silicon) | `Appling-<version>-mac-arm64.dmg` | Open the dmg and drag Appling into Applications |
| macOS (Intel) | `Appling-<version>-mac-x64.dmg` | Same as above |

The builds are not code signed yet, so each system warns once:

- **macOS** says the app cannot be opened because the developer cannot be verified. Right click Appling in Applications, choose **Open**, then **Open** again. Or remove the quarantine flag once: `xattr -dr com.apple.quarantine /Applications/Appling.app`.
- **Windows** SmartScreen says it protected your PC. Click **More info**, then **Run anyway**.
- **Linux** AppImages need FUSE 2 (`libfuse2` on Debian and Ubuntu). Without it, run the AppImage with `--appimage-extract-and-run`. If it stops with a message about the sandbox (Ubuntu 24.04 restricts unprivileged user namespaces), start it with `--no-sandbox`.

## Open repos

Start Appling from its launcher, or from a terminal with folders and `.code-workspace` files:

```sh
./Appling-0.1.0-linux-x86_64.AppImage ~/work/shop ~/work/crm
```

Each `.code-workspace` file opens as a workspace, and each folder joins the active workspace. A second start hands its paths to the running app and quits. `--version` prints the version and quits without opening a window.

From a clone of the repository, `node packages/desktop/out/bin.js [paths...]` does the same after `pnpm build`.

## Windows and monitors

Every window has the rail and the switcher. The first window is the main window: it holds every workspace no other window holds, and closing it quits the app.

| To | Do |
|---|---|
| Put a workspace or a repo in a window of its own | Drag it out of the rail and drop it outside every window, or right click it and choose **Move to New Window** |
| Move it into another window | Drop it on that window, or right click it and choose **Move to Window** |
| Move the code view or the terminal panel of a repo | Right click the repo, then **Move Code** or **Move Terminal** |
| Dock it back | Right click the moved pane and choose **Dock Back**, drag it back, or close its window |

A moved workspace takes its repos along. A moved repo takes its canvas: the new window shows it as a column, and its button in the old rail turns dashed. Closing a window gives everything in it back to the main window, so nothing closes with it.

Moving never reloads anything: the canvas, its selection, the code view and agent sessions stay as they were.

Appling saves which window holds what and where every window is, once per monitor setup, and restores it at the next start. A window whose monitor is gone opens on the primary display.

## Terminals

Every repo has its own terminals in a panel under its canvas. **Terminal › Toggle Terminal Panel** (`` Ctrl+` ``) opens and closes it, **New Terminal** (`` Ctrl+Shift+` ``) adds a tab and **Split Terminal** (`Ctrl+Shift+5`) puts a terminal next to the focused one. The terminal is the one VS Code uses (xterm.js): true colour, mouse, images, clipboard and hyperlinks work, and the shortcuts of the app menu stay out of its way, so `Ctrl+R` or `Ctrl+W` reach the shell, vim or tmux.

- New terminals start the shell of `$SHELL`, or another profile from the ▾ menu. Profiles are the shells of the system and those in VS Code's `terminal.integrated.profiles.*` settings.
- In bash, zsh and fish, Appling knows every command, its exit status and the folder it ran in: the tab shows the running command and a dot for how the last one ended, and `Ctrl+Up` and `Ctrl+Down` jump between commands.
- Ctrl+click (Cmd+click on macOS) opens a URL in the browser and a file path in the code view.
- Terminals keep running when the app closes or crashes. At the next start they come back in their tabs, with their screen and scrollback. To end them with the app instead, check **Terminal › End Terminals with the App**.

## Remote repos

A repo can live on another machine: on an SSH host, in a dev container or in WSL. Its IDE server, the pty host with its terminals and the code view then run there, next to the files, and Desktop shows them as it shows a local repo. A workspace can mix local and remote repos.

| Kind | Add it with | As a path |
|---|---|---|
| SSH host | **File › Add Remote Repository…**, which proposes the hosts of `~/.ssh/config` | `ssh://host/path`, `ssh://user@host:2222/~/src/shop` (`~` is the home folder there) |
| Dev container | **File › Open Folder in Dev Container…**, or **Reopen in Dev Container** in the menu of a repo with a `.devcontainer/devcontainer.json` | `devcontainer:///home/me/work/shop` (the folder on this machine) |
| WSL (Windows) | **File › Add Remote Repository…**, which proposes the installed distributions | `wsl://Ubuntu/home/me/shop` |

The paths work on the command line too:

```sh
./Appling-0.1.0-linux-x86_64.AppImage ssh://build/srv/shop ~/work/crm
```

- **SSH** logs in without asking: use a key, an ssh agent or a certificate, as for `ssh -o BatchMode=yes`. Everything in `~/.ssh/config` applies (aliases, `ProxyJump`, keys). An unknown host key is accepted on the first connection and checked afterwards. Everything goes through one ssh connection per repo.
- **Dev containers** start with the [devcontainer CLI](https://github.com/devcontainers/cli) when it is installed, so features and lifecycle commands run as in VS Code. Without it, Desktop runs the container itself with `docker`, from the `image` or `build.dockerfile` of devcontainer.json, mounts the folder at `workspaceFolder` (`/workspaces/<folder>` by default) and reuses the folder's container on the next start, also one that VS Code created. Docker Compose configurations need the CLI.
- **WSL** runs through `wsl.exe -d <distribution>`.

The first connection to a machine installs the Appling server into `~/.appling-server` there: the IDE server, the pty host and a Node binary for that machine, uploaded over the connection, so the machine needs no internet access. The code view adds Code OSS on first use; for remote repos it does not follow the canvas selection yet. Each Desktop build installs once per machine. The other machine must run Linux (glibc based, not Alpine) or macOS, on x64 or arm64. Terminals need node-pty for its platform; the Linux build of Desktop brings it for Linux x64.

The rail shows each remote repo's connection: a dashed amber border while it connects or reconnects, a dashed red one when it failed (the repo shows the reason with Retry), a small grey square when it is connected. The tooltip names the machine and, while reconnecting, the attempt. When the network drops, Desktop reconnects with growing pauses (1 s, doubling up to 30 s, ten attempts) and keeps the repo's view at the same address; the terminals keep running on the other machine and reattach. The branch and the changes in the rail come from `git status` on the other machine every 10 seconds.

In a `.code-workspace` file remote repos are written as VS Code writes them (`"uri": "vscode-remote://ssh-remote+build/srv/shop"`), so VS Code opens the same workspace.

## Updates

Desktop looks for a new version on GitHub Releases at every start, and on **File › Check for Updates…**.

| Build | Update |
|---|---|
| Linux AppImage | Downloads in the background, then asks to restart. It replaces the AppImage file you started |
| Windows | Downloads in the background, then asks to restart; otherwise it installs when you quit |
| macOS, unsigned | macOS installs only signed updates, so Desktop shows the new version and opens its release page to download it by hand |
| macOS, signed | Like Windows |

An AppImage that was extracted or moved into a package keeps running but cannot replace itself; it points to the release page like an unsigned Mac build. Set `APPLING_DISABLE_UPDATES=1` to never look for updates, for example on managed machines. A copy started from the repository never updates.

## Inside the package

The app bundles everything it runs. Each repo's IDE server, the pty host that keeps terminals running, the language server and the [MCP server](ai.md#mcp-server) are Node programs that Desktop starts with its own Electron binary as Node (`ELECTRON_RUN_AS_NODE`), so no separate Node installation is needed. The terminal library node-pty is the only native module; it uses Node's stable ABI, so the same build loads in Electron.

## Build it yourself

```sh
pnpm install
pnpm --filter @appling/desktop... build
pnpm --filter @appling/desktop package --linux   # or --win, --mac
```

The installers land in `packages/desktop/release/`. Each system builds its own package, because node-pty is native. Pushing a tag `desktop-v<version>` runs the Desktop Release workflow, which builds all three on GitHub's runners and publishes them with the update manifests to a release of that tag. Signing and notarization start once the optional secrets that the workflow lists exist.
