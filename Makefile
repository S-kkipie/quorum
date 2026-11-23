export PATH := $(PATH):$(HOME)/.local/go/bin
CGO_ENABLED ?= 0
export CGO_ENABLED
TYGO := go run github.com/gzuidhof/tygo@v0.2.20
PLATFORMS := linux/amd64 linux/arm64 windows/amd64 darwin/arm64

.PHONY: proto test typecheck app build cross

proto:
	cd internal/proto && $(TYGO) generate --config tygo.yaml
	mkdir -p app/src
	cp mod/src/proto.gen.ts app/src/proto.gen.ts

# Claude Code generates the mod types when it loads the mod in an interactive session
# (claude --plugin-dir ./mod); without them the typecheck is skipped.
typecheck:
	@if [ -f mod/.claude-plugin/types/tsconfig.json ]; then npx -y -p typescript tsc -p mod --noEmit; else echo "skip typecheck (load the mod once: claude --plugin-dir ./mod)"; fi

test: typecheck
	go test ./...
	@if command -v claude >/dev/null 2>&1; then claude plugin test mod; else echo "skip mod (claude is not in PATH)"; fi
	@if [ -f app/package.json ]; then cd app && npx vitest run; else echo "skip app (no package.json)"; fi

app:
	cd app && npm run build

build: app
	mkdir -p bin
	go build -o bin/ ./cmd/...

cross:
	@for p in $(PLATFORMS); do \
		os=$${p%/*}; arch=$${p#*/}; ext=""; [ $$os = windows ] && ext=".exe"; \
		mkdir -p bin/$$os-$$arch; \
		GOOS=$$os GOARCH=$$arch go build -o bin/$$os-$$arch/ ./cmd/... || exit 1; \
	done
