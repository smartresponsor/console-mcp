param(
    [Parameter(Mandatory = $true)][string]$TargetId,
    [string]$Name = 'console-mcp-ubuntu',
    [string]$Identifier = 'https://console-mcp-ubuntu.smartresponsor.com'
)

$ErrorActionPreference = 'Stop'

$js = @'
const [targetId, expectedName, expectedIdentifier] = process.argv.slice(1);
const list = await fetch('http://127.0.0.1:9223/json/list').then(r => r.json());
const target = list.find(x => x.id === targetId && x.type === 'page');
if (!target?.webSocketDebuggerUrl) throw new Error('target not found');

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('websocket timeout')), 10000);
  ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
  ws.addEventListener('error', (e) => { clearTimeout(t); reject(e.error || new Error('websocket error')); }, { once: true });
});

let seq = 0;
const pending = new Map();
ws.addEventListener('message', ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
  }
});
function cdp(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(method + ' timeout'));
    }, 10000);
  });
}

const expression = `(() => {
  const expectedName = ${JSON.stringify(expectedName)};
  const expectedIdentifier = ${JSON.stringify(expectedIdentifier)};
  if (location.origin !== 'https://manage.auth0.com' || !/\\/apis\\/new\\/?$/.test(location.pathname)) {
    return { ok: false, status: 'ROUTE_MISMATCH', href: location.href };
  }
  const setValue = (el, value) => {
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (!setter) throw new Error('native value setter unavailable');
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const fields = {
    name: document.querySelector('input[name="name"]'),
    identifier: document.querySelector('input[name="identifier"]'),
    tokenProfile: document.querySelector('select[name="tokenProfile"]'),
    signingAlgorithm: document.querySelector('select[name="signingAlgorithm"]'),
    userPolicy: document.querySelector('select[name="subject_type_authorization.user.policy"]'),
    clientPolicy: document.querySelector('select[name="subject_type_authorization.client.policy"]')
  };
  if (Object.values(fields).some(x => !x)) return { ok: false, status: 'FIELDS_NOT_FOUND' };
  setValue(fields.name, expectedName);
  setValue(fields.identifier, expectedIdentifier);
  setValue(fields.tokenProfile, 'access_token');
  setValue(fields.signingAlgorithm, 'RS256');
  setValue(fields.userPolicy, 'allow_all');
  setValue(fields.clientPolicy, 'deny_all');
  const state = {
    name: fields.name.value,
    identifier: fields.identifier.value,
    tokenProfile: fields.tokenProfile.value,
    signingAlgorithm: fields.signingAlgorithm.value,
    userPolicy: fields.userPolicy.value,
    clientPolicy: fields.clientPolicy.value
  };
  const ok = state.name === expectedName && state.identifier === expectedIdentifier && state.tokenProfile === 'access_token' && state.signingAlgorithm === 'RS256' && state.userPolicy === 'allow_all' && state.clientPolicy === 'deny_all';
  return { ok, status: ok ? 'AUTH0_API_FORM_FILLED' : 'POSTCONDITION_FAILED', state };
})()`;
'@

$output = & node --input-type=module -e $js $TargetId $Name $Identifier
if ($LASTEXITCODE -ne 0) { throw "Auth0 form fill failed with exit code $LASTEXITCODE" }
$output
'@

$output = & node --input-type=module -e $js $TargetId $Name $Identifier
if ($LASTEXITCODE -ne 0) {
    throw "Auth0 form fill failed with exit code $LASTEXITCODE"
}

$output
