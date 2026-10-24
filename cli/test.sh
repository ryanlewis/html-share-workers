#!/usr/bin/env bash
# Smoke test for cli/htmlshare against `wrangler dev --local` with a dummy
# token. Local only: storage goes to a temporary directory.
#
#   cli/test.sh            (PORT=8799 by default)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/cli/htmlshare"
PORT="${PORT:-8799}"
TMP="$(mktemp -d)"
LOG="$TMP/wrangler.log"
DEV_PID=""

cleanup() {
	if [ -n "$DEV_PID" ]; then
		kill -- "-$DEV_PID" 2>/dev/null || kill "$DEV_PID" 2>/dev/null || true
		wait "$DEV_PID" 2>/dev/null || true
	fi
	rm -rf "$TMP"
}
trap cleanup EXIT

# Own process group, so cleanup stops wrangler and workerd together.
set -m
(cd "$ROOT" && exec npx wrangler dev --local --ip 127.0.0.1 --port "$PORT" \
	--persist-to "$TMP/state" --show-interactive-dev-session=false \
	--var TOKEN_SMOKE:smoke-token --var COOKIE_SECRET:smoke-cookie \
	--var 'IP_GATES:{"acme":["192.0.2.0/24"],"example":["198.51.100.0/24"]}') >"$LOG" 2>&1 &
DEV_PID=$!
set +m

URL="http://127.0.0.1:$PORT"
for _ in $(seq 1 60); do
	code="$(curl -s -o /dev/null -w '%{http_code}' "$URL/api/artifacts" || true)"
	[ "$code" = 401 ] && break
	sleep 1
done
[ "$code" = 401 ] || { echo "wrangler dev did not come up:"; cat "$LOG"; exit 1; }

export HTMLSHARE_URL="$URL" HTMLSHARE_TOKEN=smoke-token HTMLSHARE_NO_CLIPBOARD=1 HOME="$TMP/home"
unset XDG_CONFIG_HOME
mkdir -p "$HOME"

PASS=0
FAIL=0
OUT=""

# check <description> <expected exit: ok|fail> <output pattern> <command...>
check() {
	local desc="$1" want="$2" pattern="$3" status=0
	shift 3
	OUT="$("$@" 2>&1)" || status=$?
	if { [ "$want" = ok ] && [ "$status" = 0 ]; } || { [ "$want" = fail ] && [ "$status" != 0 ]; }; then
		if printf '%s' "$OUT" | grep -qE -- "$pattern"; then
			PASS=$((PASS + 1))
			echo "ok   $desc"
			return 0
		fi
	fi
	FAIL=$((FAIL + 1))
	echo "FAIL $desc (exit $status)"
	printf '%s\n' "$OUT" | sed 's/^/     /'
}

# refute <description> <pattern> <text>: passes when text does not match.
refute() {
	if printf '%s' "$3" | grep -qE -- "$2"; then
		FAIL=$((FAIL + 1))
		echo "FAIL $1"
		printf '%s\n' "$3" | sed 's/^/     /'
	else
		PASS=$((PASS + 1))
		echo "ok   $1"
	fi
}

SITE="$TMP/site"
mkdir -p "$SITE/assets" "$SITE/.git"
echo '<!doctype html><p>site</p>' >"$SITE/index.html"
echo 'console.log(1)' >"$SITE/assets/app.js"
echo 'secret' >"$SITE/.git/config"
echo 'p{}' >"$TMP/linked.css"
ln -s "$TMP/linked.css" "$SITE/assets/style.css"
PAGE="$TMP/page.html"
echo '<!doctype html><p>page</p>' >"$PAGE"
mkdir -p "$TMP/noindex"
echo x >"$TMP/noindex/a.js"

check "no token" fail "no token" env -u HTMLSHARE_TOKEN "$CLI" "$PAGE" smoke-page
mkdir -p "$HOME/.config/htmlshare"
echo wrong-token >"$HOME/.config/htmlshare/token"
check "wrong token from token file" fail "missing or invalid bearer token" env -u HTMLSHARE_TOKEN "$CLI" "$PAGE" smoke-page
echo smoke-token >"$HOME/.config/htmlshare/token"
check "right token from token file" ok "^URL: https://share.rlew.io/smoke-page/$" env -u HTMLSHARE_TOKEN "$CLI" "$PAGE" smoke-page
check "existing slug refused without --force" fail "already exists.*--force" "$CLI" "$PAGE" smoke-page
check "existing slug replaced with --force" ok "^URL: https://share.rlew.io/smoke-page/$" "$CLI" "$PAGE" smoke-page --force
check "random slug" ok "^URL: https://share.rlew.io/[0-9a-f]{8}/$" "$CLI" "$PAGE"
RANDOM_URL="$(printf '%s' "$OUT" | sed -n 's/^URL: //p')"

check "secured with generated password" ok "Password: [A-Za-z0-9_-]{24}$" "$CLI" "$PAGE" smoke-secret --secured
check "secured URL" ok "URL:      https://share.rlew.io/_/smoke-secret/" printf '%s' "$OUT"
check "secured with --pw" ok "Password: hunter 2\"x$" "$CLI" "$PAGE" smoke-pw --pw 'hunter 2"x'
GET_PW="$(curl -s -H 'Authorization: Bearer smoke-token' "$URL/api/artifacts/secured/smoke-pw")"
check "GET of a secured artifact" ok '"slug":"smoke-pw"' printf '%s' "$GET_PW"
refute "GET of a secured artifact has no pwhash or password" "pwhash|hunter" "$GET_PW"

# Replacing keeps the password, title and listed setting unless told otherwise.
check "secured with title and listed" ok "Password: [A-Za-z0-9_-]{24}$" "$CLI" "$PAGE" smoke-keep --secured --listed --title 'Keep me'
KEEP_PW="$(printf '%s' "$OUT" | sed -n 's/^Password: //p')"
check "secured replace without --force refused" fail "already exists.*--force" "$CLI" "$PAGE" smoke-keep --secured
check "secured --force replace keeps the password" ok "^Password: unchanged$" "$CLI" "$PAGE" smoke-keep --secured --force
refute "kept replace does not print the old password" "$KEEP_PW" "$OUT"
GET_KEEP="$(curl -s -H 'Authorization: Bearer smoke-token' "$URL/api/artifacts/secured/smoke-keep")"
check "replace kept title and listed" ok '"listed":true,"title":"Keep me"' printf '%s' "$GET_KEEP"
LOGIN="$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: share.rlew.io' --data-urlencode "password=$KEEP_PW" "$URL/_/smoke-keep/")"
check "old password still logs in after a kept replace" ok "^303$" printf '%s' "$LOGIN"
check "--pw sets a new password" ok "^Password: fresh-one$" "$CLI" "$PAGE" smoke-keep --pw fresh-one --force
check "--new-pw generates a new password" ok "^Password: [A-Za-z0-9_-]{24}$" "$CLI" "$PAGE" smoke-keep --new-pw --force
refute "--new-pw changed the password" "$KEEP_PW" "$OUT"
check "--unlisted and --title '' change them" ok "^Password: unchanged$" "$CLI" "$PAGE" smoke-keep --secured --unlisted --title '' --force
GET_KEEP="$(curl -s -H 'Authorization: Bearer smoke-token' "$URL/api/artifacts/secured/smoke-keep")"
check "unlisted and title cleared" ok '"listed":false,"uploadedBy"' printf '%s' "$GET_KEEP"
refute "title is gone" '"title"' "$GET_KEEP"
check "--pw with --new-pw rejected" fail "cannot be combined" "$CLI" "$PAGE" x --pw a --new-pw
check "capitals in a slug rejected whatever the locale" fail "slug must be lowercase" env LC_ALL=en_US.UTF-8 "$CLI" "$PAGE" ABC
check "rm kept secured" ok "Deleted" "$CLI" rm smoke-keep --secured

check "gated directory upload skips dotfiles" ok "^Uploading 3 files" "$CLI" "$SITE/" pr/smoke --gate acme --listed --title 'Q1 déck & more'
check "gated directory URL" ok "^URL: https://share.rlew.io/acme/pr/smoke/$" printf '%s' "$OUT"
GET_GATED="$(curl -s -H 'Authorization: Bearer smoke-token' "$URL/api/artifacts/acme/pr/smoke")"
check "gate, title and listed stored" ok '"visibility":"gated","gate":"acme",.*"listed":true,"title":"Q1 déck & more","uploadedBy":"smoke"' printf '%s' "$GET_GATED"
check "gated nesting refused" fail "would sit inside" "$CLI" "$PAGE" pr/smoke/inner --gate acme
check "same slug under another gate" ok "^URL: https://share.rlew.io/example/pr/smoke/$" "$CLI" "$PAGE" pr/smoke --gate example
check "unconfigured gate rejected by the server" fail "configured gate name" "$CLI" "$PAGE" x --gate other
check "public slug equal to a gate rejected" fail 'public slug "acme" is reserved' "$CLI" "$PAGE" acme
check "bad gate name rejected locally" fail "gate name must be" "$CLI" "$PAGE" x --gate Acme
check "--gate secured rejected locally" fail "not a gate name" "$CLI" "$PAGE" x --gate secured
check "directory without index.html" fail "has no index.html" "$CLI" "$TMP/noindex" smoke-noindex
check "bad slug rejected locally" fail "slug must be lowercase" "$CLI" "$PAGE" Bad_Slug
check "reserved slug rejected by the server" fail 'public slug "api" is reserved' "$CLI" "$PAGE" api
check "line break in --pw" fail "line break" "$CLI" "$PAGE" x --pw $'a\noutput = x'
check "line break in token" fail "line break" env HTMLSHARE_TOKEN=$'smoke-token\nx' "$CLI" ls
check "--secured with --gate" fail "cannot be combined" "$CLI" "$PAGE" x --secured --gate acme

check "ls lists everything" ok "smoke-page/.*_/smoke-secret/|acme/pr/smoke/" "$CLI" ls
check "ls includes the gated title" ok "acme/pr/smoke/.*listed.*Q1 déck & more" printf '%s' "$OUT"
check "ls --secured" ok "^https://share.rlew.io/_/smoke-pw/" "$CLI" ls --secured
refute "ls --secured shows only secured" "rlew.io/(smoke-page|acme/|example/)" "$OUT"
check "ls --gate acme" ok "^https://share.rlew.io/acme/pr/smoke/" "$CLI" ls --gate acme
refute "ls --gate acme shows only that gate" "rlew.io/(smoke-page|_/|example/)" "$OUT"

check "rm public" ok "^Deleted: https://share.rlew.io/smoke-page/$" "$CLI" rm smoke-page
check "rm again is not found" fail "artifact not found" "$CLI" rm smoke-page
check "rm gated" ok "^Deleted: https://share.rlew.io/acme/pr/smoke/$" "$CLI" rm pr/smoke --gate acme
check "rm gated leaves the other gate" ok "^https://share.rlew.io/example/pr/smoke/" "$CLI" ls --gate example
check "rm the other gate" ok "^Deleted: https://share.rlew.io/example/pr/smoke/$" "$CLI" rm pr/smoke --gate example
check "rm secured" ok "Deleted" "$CLI" rm smoke-secret --secured
check "rm random slug" ok "Deleted" "$CLI" rm "$(basename "$RANDOM_URL")"
check "ls after rm" ok "^https://share.rlew.io/_/smoke-pw/" "$CLI" ls

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
