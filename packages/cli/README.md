# @appling/cli

Command line tool to check and format Appling models (`.appling` files).

Appling is a declarative language that describes a business or web application in five layers: domain, behavior, application, interfaces and experience. The language itself lives in [`@appling/lang`](https://www.npmjs.com/package/@appling/lang).

## Install

```sh
npm install --save-dev @appling/cli
```

Or run it without installing:

```sh
npx @appling/cli check models
```

## Usage

```sh
appling check [files or folders...]
appling fmt   [files or folders...]
```

Folders are searched recursively for `.appling` files. Hidden folders and `node_modules` are skipped. Without a path, the current folder is used.

All files are loaded as one workspace, so references between modules resolve across files.

### check

Parses, links and validates every file and prints one line per problem:

```
models/sales.appling:13:23 error A machine must govern an entity field marked "state" with an enum type.
2 file(s), 1 error(s)
```

### fmt

Rewrites every file into its canonical form:

- Normalizes whitespace, indentation and line breaks. Comments are kept.
- Running it twice changes nothing.

Files with syntax errors are left untouched and reported.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | No errors |
| 1 | `check` found errors, or `fmt` skipped a file with syntax errors |
| 2 | Unknown command |

## License

MIT
