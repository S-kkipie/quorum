export PATH := $(PATH):$(HOME)/.local/go/bin
CGO_ENABLED ?= 0
export CGO_ENABLED
TYGO := go run github.com/gzuidhof/tygo@v0.2.20
PLATFORMS := linux/amd64 linux/arm64 windows/amd64 darwin/arm64

.PHONY: proto test typecheck app build cross quorum quorum-service apk

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

# Builds the device client and installs it to ~/.local/bin.
quorum:
	mkdir -p $(HOME)/.local/bin
	go build -o $(HOME)/.local/bin/quorum ./cmd/quorum

# Installs quorum and the `quorum watch` user service, then enables and starts it (pair first).
quorum-service: quorum
	mkdir -p $(HOME)/.config/systemd/user
	cp scripts/quorum-watch.service $(HOME)/.config/systemd/user/quorum-watch.service
	systemctl --user daemon-reload
	systemctl --user enable --now quorum-watch

# Builds the signed Android release APK into android-app/quorum.apk (see docs/android.md).
# The secrets stay outside the repo; QUORUM_ANDROID_SECRETS points at another folder (e.g. throwaway test secrets).
QUORUM_ANDROID_SECRETS ?= $(HOME)/.config/quorum/android
ANDROID_HOME ?= $(HOME)/Android/sdk
# Capacitor 8 compiles with Java 21 (sourceCompatibility and jvmToolchain 21).
APK_JAVA_HOME ?= $(or $(wildcard $(HOME)/.jdk21),$(JAVA_HOME))
APK_SECRETS := release.keystore keystore.properties google-services.json

apk:
	@for f in $(APK_SECRETS); do \
		if [ ! -f "$(QUORUM_ANDROID_SECRETS)/$$f" ]; then \
			echo "make apk: missing $(QUORUM_ANDROID_SECRETS)/$$f. See docs/android.md." >&2; exit 1; \
		fi; \
	done
	@if [ ! -d "$(ANDROID_HOME)" ]; then echo "make apk: no Android SDK at $(ANDROID_HOME). See docs/android.md." >&2; exit 1; fi
	@if [ -z "$(APK_JAVA_HOME)" ]; then echo "make apk: set JAVA_HOME to a JDK 21. See docs/android.md." >&2; exit 1; fi
	cd android-app && npm ci --no-audit --no-fund && npx cap sync android
	@# google-services.json is copied in for the build only and removed afterwards, even when the build fails.
	@cp "$(QUORUM_ANDROID_SECRETS)/google-services.json" android-app/android/app/google-services.json; \
	cd android-app/android && JAVA_HOME="$(APK_JAVA_HOME)" ANDROID_HOME="$(ANDROID_HOME)" ./gradlew --no-daemon -q assembleRelease \
		-PquorumKeystore="$(QUORUM_ANDROID_SECRETS)/release.keystore" \
		-PquorumKeystoreProperties="$(QUORUM_ANDROID_SECRETS)/keystore.properties"; \
	status=$$?; rm -f app/google-services.json; exit $$status
	cp android-app/android/app/build/outputs/apk/release/app-release.apk android-app/quorum.apk
	@echo "built android-app/quorum.apk"
