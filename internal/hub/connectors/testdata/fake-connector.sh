#!/bin/bash
# Fake connector for tests. The mode comes from settings.mode; settings.log (optional)
# receives one line per operation other than list.
in=$(cat)
field() { printf '%s' "$in" | sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" | head -n1; }
mode=$(field mode)
op=$(field op)
log=$(field log)
pidfile=$(field pidfile)
case "$mode" in
  sleep) sleep 60 ;;
  leak) printf '%s\n' "$in" >&2; exit 1 ;;
  orphan) sleep 60 & echo $! > "$pidfile"; wait ;;
  garbage) echo "this is not json" ;;
  fail) echo "everything broke" >&2; exit 1 ;;
  huge) head -c 9000000 /dev/zero | tr '\0' 'a' ;;
  err) echo '{"error":"no permission"}' ;;
  env) printf '{"tickets":[{"externalId":"E1","title":"%s","rawStatus":"open"}]}\n' "$WHOAS_PROFILE" ;;
  *)
    if [ "$op" = list ]; then
      echo '{"tickets":[{"externalId":"A-1","title":"First","rawStatus":"open","updatedAt":10},{"externalId":"A-2","title":"Second","rawStatus":"In Progress","assignee":"ana","updatedAt":20}]}'
    else
      [ -n "$log" ] && printf '%s\n' "$in" >> "$log"
      echo '{"ok":true}'
    fi ;;
esac
