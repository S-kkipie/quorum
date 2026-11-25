package main

import (
	"html"
	"strings"
)

// The two local pages: the first run (asks for the hub) and the fallback (the hub can't be reached). Both use
// the Terminal green tokens of the web app and the Seats mark, light and dark, and call back into Go through bound functions.
const pageStyle = `<style>
:root{--bg:#F7F8F7;--surface:#FFFFFF;--ink:#111814;--muted:#5D6861;--line:#E0E6E2;--accent:#0C7548;--on:#FFFFFF;--danger:#B3261E}
@media (prefers-color-scheme:dark){:root{--bg:#0E1311;--surface:#161C19;--ink:#E3ECE7;--muted:#8FA198;--line:#24302A;--accent:#3DDC97;--on:#06140D;--danger:#F08A80}}
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{background:var(--bg);color:var(--ink);font:14px/1.5 "Segoe UI Variable","Segoe UI",system-ui,sans-serif;display:grid;place-items:center;padding:16px}
main{width:100%;max-width:420px;background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:24px}
.mark{display:block;color:var(--accent);margin:0 0 12px}
h1{font-size:20px;font-weight:600;margin:0 0 6px}p{color:var(--muted);margin:0 0 16px}
input{width:100%;font:inherit;font-size:16px;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px 12px;outline:none}
input:focus{border-color:var(--accent)}
.row{display:flex;gap:8px;margin-top:12px}
button{flex:1;min-height:44px;font:inherit;font-weight:600;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--ink);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--on)}
button:active{transform:scale(.97)}
.err{color:var(--danger);min-height:1.5em;margin:8px 0 0}
</style>`

// seatsMark is the inline Seats logo, painted with the accent.
const seatsMark = `<svg class="mark" width="40" height="40" viewBox="0 0 48 48" fill="currentColor" aria-hidden="true"><circle cx="24" cy="9" r="4.3"/><circle cx="34.6" cy="13.4" r="4.3"/><circle cx="39" cy="24" r="4.3"/><circle cx="24" cy="39" r="4.3"/><circle cx="13.4" cy="34.6" r="4.3"/><circle cx="9" cy="24" r="4.3"/><circle cx="13.4" cy="13.4" r="4.3"/><rect x="29" y="31" width="15" height="5.4" rx="2.7" transform="rotate(45 36.5 33.7)"/></svg>`

const firstRunPage = `<!doctype html><html><head><meta charset="utf-8"><title>Quorum</title>` + pageStyle + `</head><body><main>` + seatsMark + `
<h1>Connect to your hub</h1>
<p>The address of your Quorum hub, for example http://vps-1:7420. You pair this computer on the next screen.</p>
<form id="f"><input id="hub" value="{{HUB}}" placeholder="http://vps-1:7420" autocomplete="off" spellcheck="false" autofocus>
<div class="err" id="err"></div><div class="row"><button class="primary" type="submit">Connect</button></div></form>
<script>
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault()
  const err = document.getElementById('err')
  err.textContent = ''
  const msg = await window.quorumSetHub(document.getElementById('hub').value)
  if (msg) err.textContent = msg
})
</script></main></body></html>`

const offlinePage = `<!doctype html><html><head><meta charset="utf-8"><title>Quorum</title>` + pageStyle + `</head><body><main>` + seatsMark + `
<h1>Can't reach the hub</h1>
<p>Can't reach the hub. Is Tailscale connected?</p>
<p>{{HUB}}</p>
<div class="row"><button class="primary" onclick="window.quorumRetry()">Retry</button><button onclick="window.quorumChangeHub()">Change hub</button></div>
</main></body></html>`

func page(tpl, hub string) string { return strings.ReplaceAll(tpl, "{{HUB}}", html.EscapeString(hub)) }
