# ============================================================================
# csession — top-level make targets.
#
# Design rules:
#   1. Never `cd` — every command is anchored to $(REPO) via an absolute path
#      or a --flag that lets the tool operate on a directory. Targets stay
#      composable and safe to invoke from anywhere.
#   2. Every path is a variable defined below; nothing is hard-coded inline.
#   3. Targets that touch a real session store or another machine refuse to
#      run without their preconditions; dev targets are eager and idempotent.
#   4. `make` alone (no args) prints the full target surface.
# ============================================================================

REPO             := $(CURDIR)

# ----- Component paths -----------------------------------------------------
SRC_DIR          := $(REPO)/src
COMMANDS_DIR     := $(SRC_DIR)/commands
DIST_DIR         := $(REPO)/dist
NODE_MODULES     := $(REPO)/node_modules
PKG_JSON         := $(REPO)/package.json
TSCONFIG         := $(REPO)/tsconfig.json
CLI_ENTRY        := $(DIST_DIR)/cli.js
DOCS_DIR         := $(REPO)/docs/superpowers
SPEC             := $(DOCS_DIR)/specs/2026-08-31-csession-design.md
PLAN             := $(DOCS_DIR)/plans/2026-08-31-csession.md

# Test globs. node --test expands these itself when quoted, so an absolute
# glob works from any working directory — that is what keeps rule 1.
TEST_ALL         := $(DIST_DIR)/**/*.test.js
TEST_UNIT        := $(DIST_DIR)/*.test.js
TEST_COMMANDS    := $(DIST_DIR)/commands/*.test.js
TEST_E2E         := $(DIST_DIR)/e2e.test.js

# ----- Claude Code session store -------------------------------------------
# Where csession reads and writes transcripts. CLAUDE_CONFIG_DIR is honoured
# here even though the tool itself does not yet read it (see `make snags`),
# so these targets stay correct on a machine that sets it.
CLAUDE_DIR       ?= $(if $(CLAUDE_CONFIG_DIR),$(CLAUDE_CONFIG_DIR),$(HOME)/.claude)
SESSIONS_DIR     := $(CLAUDE_DIR)/projects

# ----- Scratch -------------------------------------------------------------
# Sandbox for `make demo`. Never inside $(REPO): a bundle written into a repo
# shows up as an untracked file and pollutes what the demo is demonstrating.
# $TMPDIR ends with a slash on macOS; strip it so paths do not come out as "T//x".
SANDBOX          := $(shell printf '%s' "$${TMPDIR:-/tmp}" | sed 's:/*$$::')/csession-demo

# ----- Tools ---------------------------------------------------------------
NODE             ?= node
NPM              ?= npm
GIT              ?= git
TSC              := $(NODE_MODULES)/.bin/tsc

# --prefix / --project / -C — the "no cd" flags for each tool.
NPM_FLAGS        := --prefix $(REPO)
TSC_FLAGS        := --project $(TSCONFIG)
GIT_FLAGS        := -C $(REPO)

# Minimum runtime. Enforced by `make doctor`, mirrors package.json engines.
NODE_MIN_MAJOR   := 20

# ----- CLI target arguments -------------------------------------------------
# Overridable on the command line, e.g. `make inspect BUNDLE=/tmp/x.ccsession`
SESSION          ?=
BUNDLE           ?=
OUT              ?=
ROOT             ?=
PROJECT          ?=
FILE             ?=
FLAGS            ?=

.PHONY: help \
        install install-clean link unlink \
        build watch typecheck \
        test test-unit test-commands test-e2e test-file check \
        verify-no-deps doctor \
        cli list export inspect import \
        demo demo-clean \
        status sessions snags spec plan \
        clean clean-dist clean-node clean-sandbox distclean

# ============================================================================
# Default — surface listing.
# ============================================================================

help:
	@echo "csession — move a Claude Code session between machines"
	@echo ""
	@echo "  Setup:"
	@echo "    make install                npm install (typescript + @types/node only)"
	@echo "    make install-clean          npm ci — reproducible, from the lockfile"
	@echo "    make link                   npm link, putting \`csession\` on your PATH"
	@echo "    make unlink                 undo make link"
	@echo ""
	@echo "  Build:"
	@echo "    make build                  tsc — compile src/ to dist/"
	@echo "    make watch                  tsc --watch"
	@echo "    make typecheck              tsc --noEmit, no artefacts written"
	@echo ""
	@echo "  Test:"
	@echo "    make test                   build, then every suite"
	@echo "    make test-unit              module tests only (src/*.test.ts)"
	@echo "    make test-commands          command tests only (src/commands/*.test.ts)"
	@echo "    make test-e2e               the export -> import round trip"
	@echo "    make test-file FILE=redact  one module, e.g. FILE=transcript"
	@echo "    make check                  typecheck + full suite + no-deps guard"
	@echo ""
	@echo "  Guards:"
	@echo "    make verify-no-deps         fail if any runtime dependency appears"
	@echo "    make doctor                 node >= $(NODE_MIN_MAJOR), git, tar, build state"
	@echo ""
	@echo "  Run the CLI (each builds first):"
	@echo "    make cli FLAGS='--help'     arbitrary invocation"
	@echo "    make list [PROJECT=path]    sessions for a project, newest first"
	@echo "    make export SESSION=id OUT=file [FLAGS='--dry-run']"
	@echo "    make inspect BUNDLE=file    manifest + reports, extracts nothing"
	@echo "    make import BUNDLE=file [ROOT=path] [FLAGS='--force']"
	@echo ""
	@echo "  Dev:"
	@echo "    make demo                   full round trip in a throwaway sandbox"
	@echo "    make demo-clean             remove the sandbox"
	@echo ""
	@echo "  Info:"
	@echo "    make status                 git, build state, test and dependency counts"
	@echo "    make sessions               projects with sessions in $(SESSIONS_DIR)"
	@echo "    make snags                  known gaps, from the spec and the reviews"
	@echo "    make spec / make plan       paths to the design docs"
	@echo ""
	@echo "  Cleanup:"
	@echo "    make clean                  dist/ and the demo sandbox"
	@echo "    make clean-node             node_modules/"
	@echo "    make distclean              everything reproducible from git"

# ============================================================================
# Setup
# ============================================================================

install:
	$(NPM) $(NPM_FLAGS) install

# Reproducible install from package-lock.json. Use in CI and after a pull.
install-clean:
	$(NPM) $(NPM_FLAGS) ci

link: build
	$(NPM) $(NPM_FLAGS) link
	@echo "==> \`csession\` is now on your PATH: $$(command -v csession || echo '(not found — check your npm prefix)')"

unlink:
	$(NPM) $(NPM_FLAGS) unlink -g csession || true

# ============================================================================
# Build
# ============================================================================

$(NODE_MODULES): $(PKG_JSON)
	$(NPM) $(NPM_FLAGS) install
	@touch $(NODE_MODULES)

build: $(NODE_MODULES)
	$(TSC) $(TSC_FLAGS)

watch: $(NODE_MODULES)
	$(TSC) $(TSC_FLAGS) --watch

typecheck: $(NODE_MODULES)
	$(TSC) $(TSC_FLAGS) --noEmit

# ============================================================================
# Test
#
# Every suite builds first. node --test takes an absolute quoted glob and
# expands it itself, so none of these depend on the working directory.
# ============================================================================

test: build
	$(NODE) --test "$(TEST_ALL)"

test-unit: build
	$(NODE) --test "$(TEST_UNIT)"

test-commands: build
	$(NODE) --test "$(TEST_COMMANDS)"

test-e2e: build
	$(NODE) --test "$(TEST_E2E)"

# One module: make test-file FILE=redact
test-file: build
	@test -n "$(FILE)" || { echo "error: FILE is required, e.g. make test-file FILE=redact"; exit 1; }
	@test -f "$(DIST_DIR)/$(FILE).test.js" -o -f "$(DIST_DIR)/commands/$(FILE).test.js" \
	  || { echo "error: no test file for '$(FILE)' in $(DIST_DIR) or $(DIST_DIR)/commands"; exit 1; }
	@if [ -f "$(DIST_DIR)/$(FILE).test.js" ]; then \
	   $(NODE) --test "$(DIST_DIR)/$(FILE).test.js" ; \
	 else \
	   $(NODE) --test "$(DIST_DIR)/commands/$(FILE).test.js" ; \
	 fi

check: typecheck verify-no-deps test

# ============================================================================
# Guards
# ============================================================================

# The zero-runtime-dependency rule is a design constraint, not a preference:
# this tool is handed between machines and must not drag a supply chain along.
# devDependencies are allowed to hold typescript and @types/node, nothing else.
verify-no-deps:
	@$(NODE) -e 'const p=require("$(PKG_JSON)"); \
	  const runtime=Object.keys(p.dependencies||{}); \
	  const dev=Object.keys(p.devDependencies||{}); \
	  const allowed=["typescript","@types/node"]; \
	  const strayDev=dev.filter(d=>!allowed.includes(d)); \
	  if(runtime.length){console.error("FAIL: runtime dependencies present: "+runtime.join(", "));process.exit(1);} \
	  if(strayDev.length){console.error("FAIL: unexpected devDependencies: "+strayDev.join(", "));process.exit(1);} \
	  console.log("ok: 0 runtime deps; devDeps = "+dev.join(", "));'

doctor:
	@echo "==> node"
	@$(NODE) -e 'const m=+process.versions.node.split(".")[0]; \
	  console.log("  "+process.version+(m>=$(NODE_MIN_MAJOR)?"  ok":"  TOO OLD, need >= $(NODE_MIN_MAJOR)")); \
	  if(m<$(NODE_MIN_MAJOR))process.exit(1);'
	@echo "==> external tools csession shells out to"
	@command -v git  >/dev/null && echo "  git   $$(git --version)"  || { echo "  git   MISSING"; exit 1; }
	@command -v tar  >/dev/null && echo "  tar   $$(tar --version 2>&1 | head -1)" || { echo "  tar   MISSING"; exit 1; }
	@echo "==> session store"
	@test -d "$(SESSIONS_DIR)" && echo "  $(SESSIONS_DIR)  ok" || echo "  $(SESSIONS_DIR)  absent (no sessions yet)"
	@echo "==> build"
	@test -f "$(CLI_ENTRY)" && echo "  $(CLI_ENTRY)  ok" || echo "  $(CLI_ENTRY)  not built — run make build"

# ============================================================================
# Run the CLI
#
# Each target builds first, so you never run a stale dist/. FLAGS passes
# anything through: make export SESSION=x OUT=/tmp/x.ccsession FLAGS='--dry-run'
# ============================================================================

cli: build
	@$(NODE) $(CLI_ENTRY) $(FLAGS)

list: build
	@$(NODE) $(CLI_ENTRY) list $(if $(PROJECT),--project $(PROJECT),) $(FLAGS)

export: build
	@test -n "$(SESSION)" || { echo "error: SESSION is required, e.g. make export SESSION=<uuid> OUT=/tmp/x.ccsession"; exit 1; }
	@test -n "$(OUT)" || { echo "error: OUT is required, e.g. make export SESSION=<uuid> OUT=/tmp/x.ccsession"; exit 1; }
	@$(NODE) $(CLI_ENTRY) export $(SESSION) -o $(OUT) $(FLAGS)

inspect: build
	@test -n "$(BUNDLE)" || { echo "error: BUNDLE is required, e.g. make inspect BUNDLE=/tmp/x.ccsession"; exit 1; }
	@$(NODE) $(CLI_ENTRY) inspect $(BUNDLE) $(FLAGS)

# No default for ROOT on purpose. import refuses to guess where a repo lives,
# and this target must not paper over that by silently supplying $(REPO).
import: build
	@test -n "$(BUNDLE)" || { echo "error: BUNDLE is required, e.g. make import BUNDLE=/tmp/x.ccsession"; exit 1; }
	@$(NODE) $(CLI_ENTRY) import $(BUNDLE) $(if $(ROOT),--root $(ROOT),) $(FLAGS)

# ============================================================================
# Demo — a real round trip you can watch
#
# Builds two throwaway git repos and a synthetic transcript in $(SANDBOX),
# exports from one, inspects the bundle, imports into the other, then removes
# the session folder it created under the real session store. Nothing is left
# behind except the sandbox, which `make demo-clean` removes.
# ============================================================================

demo: build
	@bash $(REPO)/scripts/demo.sh "$(SANDBOX)" "$(CLI_ENTRY)" "$(SESSIONS_DIR)"

demo-clean: clean-sandbox

# ============================================================================
# Info
# ============================================================================

status:
	@echo "==> git"
	@$(GIT) $(GIT_FLAGS) status --short --branch | head -20
	@echo ""
	@echo "==> build"
	@ls -lh $(CLI_ENTRY) 2>/dev/null | awk '{print "  " $$0}' || echo "  (not built — run make build)"
	@echo ""
	@echo "==> source"
	@printf "  %s modules, %s command modules, %s test files\n" \
	  "$$(ls $(SRC_DIR)/*.ts 2>/dev/null | grep -vc '\.test\.ts$$')" \
	  "$$(ls $(COMMANDS_DIR)/*.ts 2>/dev/null | grep -vc '\.test\.ts$$')" \
	  "$$(ls $(SRC_DIR)/*.test.ts $(COMMANDS_DIR)/*.test.ts 2>/dev/null | wc -l | tr -d ' ')"
	@echo ""
	@echo "==> dependencies"
	@$(NODE) -e 'const p=require("$(PKG_JSON)"); \
	  console.log("  runtime: "+(Object.keys(p.dependencies||{}).length||0)+"   dev: "+Object.keys(p.devDependencies||{}).join(", "));'

sessions:
	@test -d "$(SESSIONS_DIR)" || { echo "no session store at $(SESSIONS_DIR)"; exit 0; }
	@echo "==> projects with sessions in $(SESSIONS_DIR)"
	@for d in "$(SESSIONS_DIR)"/*/ ; do \
	   n=$$(ls "$$d"*.jsonl 2>/dev/null | wc -l | tr -d ' ') ; \
	   [ "$$n" -gt 0 ] && printf "  %4s  %s\n" "$$n" "$$(basename $$d)" ; \
	 done | sort -rn | head -25
	@echo "  (count, encoded project dir — newest sessions via: make list)"

# Known gaps, kept here so they are one command away instead of buried in a
# review transcript. Each was found during implementation and deliberately
# deferred; none blocks normal use.
snags:
	@echo "csession — known gaps"
	@echo ""
	@echo "  1. inspect exits 0 on a sha256 MISMATCH."
	@echo "     So \`csession inspect x && scp x peer:\` proceeds on a corrupt bundle."
	@echo "     Print-only today; the exit-code table says 3."
	@echo ""
	@echo "  2. uncommitted.patch is never redacted."
	@echo "     With --include-untracked, .gitignore is the only thing between a"
	@echo "     stray key file and the wire. Redaction covers the transcript only."
	@echo ""
	@echo "  3. claudeProjectsDir() ignores CLAUDE_CONFIG_DIR."
	@echo "     On a machine that sets it, every command looks in the wrong place."
	@echo "     Same missing seam is why tests write into the real ~/.claude."
	@echo ""
	@echo "  4. rewritePrefix throws a plain Error carrying the raw manifest path,"
	@echo "     which the CLI now prints. Control characters survive that one line."
	@echo ""
	@echo "  5. Phase 2, not started: csession send <host>, a2a drop-board"
	@echo "     publishing, and interactive session selection on export."
	@echo ""
	@echo "  Full reasoning: $(SPEC)"

spec:
	@echo "$(SPEC)"

plan:
	@echo "$(PLAN)"

# ============================================================================
# Cleanup
# ============================================================================

clean: clean-dist clean-sandbox

clean-dist:
	rm -rf $(DIST_DIR)

clean-node:
	rm -rf $(NODE_MODULES)

clean-sandbox:
	rm -rf $(SANDBOX)

# Everything that git can reproduce.
distclean: clean clean-node
	@echo "==> removed dist/, node_modules/ and the demo sandbox"
