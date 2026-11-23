#!/bin/bash
# Conector falso para pruebas. El modo viene en settings.mode; settings.log (opcional)
# recibe una línea por operación que no sea list.
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
  garbage) echo "esto no es json" ;;
  fail) echo "se rompió todo" >&2; exit 1 ;;
  huge) head -c 9000000 /dev/zero | tr '\0' 'a' ;;
  err) echo '{"error":"sin permiso"}' ;;
  env) printf '{"tickets":[{"externalId":"E1","title":"%s","rawStatus":"open"}]}\n' "$WHOAS_PROFILE" ;;
  *)
    if [ "$op" = list ]; then
      echo '{"tickets":[{"externalId":"A-1","title":"Primero","rawStatus":"open","updatedAt":10},{"externalId":"A-2","title":"Segundo","rawStatus":"In Progress","assignee":"ana","updatedAt":20}]}'
    else
      [ -n "$log" ] && printf '%s\n' "$in" >> "$log"
      echo '{"ok":true}'
    fi ;;
esac
