# Shortcuts, read from the repo so new ones need no edit here:
#   make <script>                     a package.json script of the workspace root (make build, make test)
#   make packages/<package>/<script>  one of a package (make packages/vscode/host:link)
#   make scripts/<path>               a .mjs or .sh file under scripts/ (make scripts/ci/codegen-e2e ARGS=django)
#   make link/<package>               a package's commands into ~/.local/bin, or its host:link (make link/cli, make unlink/cli)
# ARGS goes to the script (make check ARGS=examples). `make` lists every target. Tab completion, colons included:
#   source scripts/make-completion.bash   (add it to ~/.bashrc)

SCRIPTS := $(shell node -e ' \
	const { readdirSync, readFileSync } = require("node:fs"); \
	for (const dir of [".", ...readdirSync("packages").map((name) => "packages/" + name)]) { \
		try { var scripts = JSON.parse(readFileSync(dir + "/package.json", "utf8")).scripts ?? {}; } catch { continue; } \
		for (const script of Object.keys(scripts)) console.log((dir === "." ? "" : dir + "/") + script.replaceAll(":", "\\:")); \
	}')
FILES := $(basename $(shell find scripts -name '*.mjs' -o -name '*.sh'))
LINKS := $(foreach package,$(notdir $(wildcard packages/*)),$(if $(shell grep -lsE '"(bin|host:link)"' packages/$(package)/package.json),link/$(package) unlink/$(package)))

.PHONY: targets $(SCRIPTS) $(FILES) $(LINKS)
targets:
	@printf '%s\n' $(subst \:,:,$(SCRIPTS)) $(sort $(FILES)) $(LINKS)

$(SCRIPTS):
	corepack pnpm --dir $(dir $@) run $(notdir $@) $(ARGS)

$(FILES):
	$(if $(wildcard $@.sh),bash $@.sh,node $@.mjs) $(ARGS)

$(filter link/%,$(LINKS)): link/%:
	node scripts/link.mjs $*

$(filter unlink/%,$(LINKS)): unlink/%:
	node scripts/link.mjs --remove $*
