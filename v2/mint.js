/* ChainPainter v2 — mint from the page with ABX (Art Blocks) and a browser wallet.
 *
 * No dependencies. This mirrors what `abx deploy --onchain-uri` does for a small SVG 1/1:
 * one transaction to the canonical OneOfOneImageFactory, `deployDeterministic(params, salt)`, with
 * the SVG and description stored inline as on-chain metadata fields and the canonical metadata
 * renderer answering tokenURI. Addresses are the ABX canonical CREATE2 set (same on every chain).
 *
 * Wallets: any injected EIP-1193 provider (MetaMask, Rabby, Coinbase Wallet, Brave, in-app browsers),
 * discovered with EIP-6963. The JSON-RPC reads go through the wallet's own provider.
 */
(() => {
'use strict';

// ───────────────────────── constants (from @artblocks/abx-sdk deployments.ts) ─────────────────────────
const FACTORY = '0x2ff8828a9150401225bB217CAA8b9b5e666a1c97';   // OneOfOneImageFactory
const RENDERER = '0xBfa4181cd005b2CA64f8F124456c9fb6111a3A27';  // AbxMetadataRenderer (spec v12)
const ZERO = '0x0000000000000000000000000000000000000000';
const CHAINS = {
  ethereum:      { id: 1,        name: 'Ethereum',     explorer: 'https://etherscan.io',          rpc: ['https://eth.llamarpc.com', 'https://cloudflare-eth.com'], sym: 'ETH', opensea: 'ethereum' },
  base:          { id: 8453,     name: 'Base',         explorer: 'https://basescan.org',          rpc: ['https://mainnet.base.org'],  sym: 'ETH', opensea: 'base' },
  arbitrum:      { id: 42161,    name: 'Arbitrum One', explorer: 'https://arbiscan.io',           rpc: ['https://arb1.arbitrum.io/rpc'], sym: 'ETH', opensea: 'arbitrum' },
  sepolia:       { id: 11155111, name: 'Sepolia',      explorer: 'https://sepolia.etherscan.io',  rpc: ['https://rpc.sepolia.org'],   sym: 'ETH', testnet: true },
  'base-sepolia':{ id: 84532,    name: 'Base Sepolia', explorer: 'https://sepolia.basescan.org',  rpc: ['https://sepolia.base.org'],  sym: 'ETH', testnet: true },
};
const ROYALTY_BPS = 500, MAX_ROYALTY_BPS = 1000; // ABX CLI defaults: 5% royalty, 10% cap

// ───────────────────────── hex / bytes ─────────────────────────
const utf8 = s => new TextEncoder().encode(s);
const hexOf = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const bytesOf = hex => { hex = hex.replace(/^0x/, ''); const out = new Uint8Array(hex.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16); return out; };
const padRight = (hex, words = Math.ceil(hex.length / 64)) => hex.padEnd(words * 64, '0');
const word = n => BigInt(n).toString(16).padStart(64, '0');
const isAddress = a => /^0x[0-9a-fA-F]{40}$/.test(a || '');

// ───────────────────────── keccak-256 (FIPS-202 permutation, pad 0x01) ─────────────────────────
const RC = ['0x1', '0x8082', '0x800000000000808a', '0x8000000080008000', '0x808b', '0x80000001', '0x8000000080008081', '0x8000000000008009', '0x8a', '0x88', '0x80008009', '0x8000000a', '0x8000808b', '0x800000000000008b', '0x8000000000008089', '0x8000000000008003', '0x8000000000008002', '0x8000000000000080', '0x800a', '0x800000008000000a', '0x8000000080008081', '0x8000000000008080', '0x80000001', '0x8000000080008008'].map(BigInt);
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const M64 = (1n << 64n) - 1n;
const rotl = (x, n) => n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64;
function keccakF(s){
  for (let r = 0; r < 24; r++){
    const C = [0, 1, 2, 3, 4].map(x => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
    for (let x = 0; x < 5; x++){ const d = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1); for (let y = 0; y < 25; y += 5) s[x + y] ^= d; }
    const B = new Array(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x + 5 * y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) s[x + 5 * y] = B[x + 5 * y] ^ ((~B[(x + 1) % 5 + 5 * y]) & M64 & B[(x + 2) % 5 + 5 * y]);
    s[0] ^= RC[r];
  }
}
function keccak256(bytes){
  const rate = 136, s = new Array(25).fill(0n);
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
  padded.set(bytes); padded[bytes.length] ^= 0x01; padded[padded.length - 1] ^= 0x80;
  for (let off = 0; off < padded.length; off += rate){
    for (let i = 0; i < rate / 8; i++){ let v = 0n; for (let b = 7; b >= 0; b--) v = (v << 8n) | BigInt(padded[off + i * 8 + b]); s[i] ^= v; }
    keccakF(s);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++){ let v = s[i]; for (let b = 0; b < 8; b++){ out[i * 8 + b] = Number(v & 0xffn); v >>= 8n; } }
  return out;
}
const keccakHex = bytes => '0x' + hexOf(keccak256(bytes));
function checksum(addr){
  const low = addr.toLowerCase().replace(/^0x/, ''), h = hexOf(keccak256(utf8(low)));
  return '0x' + Array.from(low, (c, i) => parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c).join('');
}

// ───────────────────────── ABI encoder (address, uintN, bool, bytes32, string, bytes, tuple, T[]) ─────────────────────────
const isDyn = t => t.type === 'string' || t.type === 'bytes' || t.type.endsWith('[]') || (t.type === 'tuple' && t.components.some(isDyn));
const staticSize = t => t.type === 'tuple' ? t.components.reduce((n, c) => n + staticSize(c), 0) : 32;
function encSeq(types, values){
  let headLen = types.reduce((n, t) => n + (isDyn(t) ? 32 : staticSize(t)), 0), heads = '', tails = '';
  types.forEach((t, i) => {
    if (isDyn(t)){ heads += word(headLen + tails.length / 2); tails += enc(t, values[i]); }
    else heads += enc(t, values[i]);
  });
  return heads + tails;
}
function enc(t, v){
  if (t.type.endsWith('[]')){ const inner = { ...t, type: t.type.slice(0, -2) }; return word(v.length) + encSeq(v.map(() => inner), v); }
  if (t.type === 'tuple') return encSeq(t.components, t.components.map(c => v[c.name]));
  if (t.type === 'string'){ const b = utf8(v); return word(b.length) + (b.length ? padRight(hexOf(b)) : ''); }
  if (t.type === 'bytes'){ const h = v.replace(/^0x/, ''); return word(h.length / 2) + (h.length ? padRight(h) : ''); }
  if (t.type === 'bytes32') return v.replace(/^0x/, '').padEnd(64, '0');
  if (t.type === 'address') return v.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  if (t.type === 'bool') return word(v ? 1 : 0);
  if (/^uint\d*$/.test(t.type)) return word(v);
  throw new Error('unsupported ABI type ' + t.type);
}
const canon = t => t.type === 'tuple' ? '(' + t.components.map(canon).join(',') + ')' : t.type.endsWith('[]') ? canon({ ...t, type: t.type.slice(0, -2) }) + '[]' : t.type;
function selector(name, types){ return keccakHex(utf8(name + '(' + types.map(canon).join(',') + ')')).slice(0, 10); }
function encodeCall(name, types, values){ return selector(name, types) + encSeq(types, values); }

// ───────────────────────── ABX deploy call ─────────────────────────
const FIELD_T = { type: 'tuple', components: [{ name: 'field', type: 'bytes32' }, { name: 'representation', type: 'bytes32' }, { name: 'value', type: 'bytes' }] };
const PARAMS_T = { type: 'tuple', components: [
  { name: 'owner', type: 'address' }, { name: 'mintTo', type: 'address' }, { name: 'name', type: 'string' }, { name: 'symbol', type: 'string' },
  { name: 'tokenURIBase', type: 'string' }, { name: 'tokenURIRenderer', type: 'address' }, { name: 'contractURIBase', type: 'string' }, { name: 'contractURIRenderer', type: 'address' },
  { name: 'royaltyReceiver', type: 'address' }, { name: 'royaltyBps', type: 'uint16' }, { name: 'maxRoyaltyBps', type: 'uint16' }, { name: 'burnable', type: 'bool' }, { name: 'transferValidator', type: 'address' },
  { name: 'tokenFields', type: 'tuple[]', components: FIELD_T.components }, { name: 'contractFields', type: 'tuple[]', components: FIELD_T.components },
] };
const tag = s => '0x' + padRight(hexOf(utf8(s)), 1);                       // encodeTag: utf8, right-padded to 32 bytes
const inlineField = (field, text) => ({ field: tag(field), representation: tag('inline'), value: '0x' + hexOf(utf8(text)) });
function buildParams({ owner, name, symbol, description, svg }){
  return {
    owner, mintTo: owner, name, symbol, tokenURIBase: '', tokenURIRenderer: RENDERER, contractURIBase: '', contractURIRenderer: RENDERER,
    royaltyReceiver: owner, royaltyBps: ROYALTY_BPS, maxRoyaltyBps: MAX_ROYALTY_BPS, burnable: false, transferValidator: ZERO,
    tokenFields: [inlineField('image', svg), ...(description ? [inlineField('description', description)] : [])],
    contractFields: description ? [inlineField('description', description)] : [],
  };
}
const encodeDeploy = (params, salt) => encodeCall('deployDeterministic', [PARAMS_T, { type: 'bytes32' }], [params, salt]);
const encodePredict = salt => encodeCall('predictDeterministicAddress', [{ type: 'bytes32' }], [salt]);
function saltFor(owner){ const e = new Uint8Array(12); crypto.getRandomValues(e); return owner.toLowerCase() + hexOf(e); } // 20-byte deployer guard + 12 bytes entropy

// ───────────────────────── wallet (EIP-1193 + EIP-6963) ─────────────────────────
const providers = [];
window.addEventListener('eip6963:announceProvider', e => { if (!providers.some(p => p.info.uuid === e.detail.info.uuid)) providers.push(e.detail); render(); });
window.dispatchEvent(new Event('eip6963:requestProvider'));
let eth = null, account = null, chainId = null, busy = false, txState = null;
const rpc = (method, params = []) => eth.request({ method, params });
async function readChain(){ try { chainId = parseInt(await rpc('eth_chainId'), 16); } catch { chainId = null; } }
async function connect(p){
  eth = p || (providers[0] && providers[0].provider) || window.ethereum;
  if (!eth){ setStatus('No wallet found. Install MetaMask, Rabby or Coinbase Wallet, or open this page inside your wallet app.', 'err'); return; }
  try {
    const accs = await rpc('eth_requestAccounts'); account = accs[0] ? checksum(accs[0]) : null; await readChain();
    eth.on && eth.on('accountsChanged', a => { account = a[0] ? checksum(a[0]) : null; txState = null; render(); });
    eth.on && eth.on('chainChanged', async () => { await readChain(); txState = null; render(); });
    render();
  } catch (e){ setStatus(e.message || String(e), 'err'); }
}
async function switchChain(key){
  const c = CHAINS[key]; const hex = '0x' + c.id.toString(16);
  try { await rpc('wallet_switchEthereumChain', [{ chainId: hex }]); }
  catch (e){
    if (e && (e.code === 4902 || /unrecognized|not added|4902/i.test(e.message || ''))){
      try { await rpc('wallet_addEthereumChain', [{ chainId: hex, chainName: c.name, rpcUrls: c.rpc, nativeCurrency: { name: c.sym, symbol: c.sym, decimals: 18 }, blockExplorerUrls: [c.explorer] }]); }
      catch (e2){ setStatus('Could not add ' + c.name + ' to the wallet: ' + (e2.message || e2), 'err'); }
    } else setStatus('Switch your wallet to ' + c.name + ' to continue.', 'err');
  }
  await readChain(); render();
}

// ───────────────────────── mint flow ─────────────────────────
const CP = () => window.ChainPainter; // bridge exposed by the app
function wanted(){ return CHAINS[CP().chain()] || CHAINS.ethereum; }
async function preview(){
  const c = wanted(); busy = true; txState = { stage: 'preview' }; render();
  try {
    if (!CP().strokes()) throw new Error('Draw something first.');
    const code = await rpc('eth_getCode', [FACTORY, 'latest']);
    if (!code || code === '0x') throw new Error('The ABX factory is not deployed on ' + c.name + ' yet.');
    const svg = CP().svg(), bytes = utf8(svg).length;
    const params = buildParams({ owner: account, name: CP().name(), symbol: CP().symbol(), description: CP().desc(), svg });
    const salt = saltFor(account);
    const predicted = checksum('0x' + (await rpc('eth_call', [{ to: FACTORY, data: encodePredict(salt) }, 'latest'])).slice(-40));
    const data = encodeDeploy(params, salt);
    const gas = BigInt(await rpc('eth_estimateGas', [{ from: account, to: FACTORY, data }]));
    let feeWei = null; try { feeWei = gas * BigInt(await rpc('eth_gasPrice')); } catch {}
    txState = { stage: 'ready', params, salt, predicted, data, gas, feeWei, bytes, chain: c };
  } catch (e){ txState = { stage: 'error', msg: friendly(e) }; }
  busy = false; render();
}
async function mint(){
  const t = txState; if (!t || t.stage !== 'ready') return;
  busy = true; txState = { ...t, stage: 'signing' }; render();
  try {
    const gasLimit = '0x' + ((t.gas * 125n) / 100n).toString(16);
    const hash = await rpc('eth_sendTransaction', [{ from: account, to: FACTORY, data: t.data, value: '0x0', gas: gasLimit }]);
    txState = { ...t, stage: 'pending', hash }; render();
    let receipt = null;
    for (let i = 0; i < 400 && !receipt; i++){ await new Promise(r => setTimeout(r, 3000)); receipt = await rpc('eth_getTransactionReceipt', [hash]).catch(() => null); }
    if (!receipt) throw new Error('Still pending after 20 minutes. Check the explorer link.');
    if (receipt.status !== '0x1') throw new Error('The transaction reverted. Nothing was deployed; gas was spent.');
    const code = await rpc('eth_getCode', [t.predicted, 'latest']).catch(() => '0x');
    txState = { ...t, stage: 'done', hash, receipt, live: code && code !== '0x' };
  } catch (e){ txState = { ...t, stage: 'error', msg: friendly(e), hash: txState.hash }; }
  busy = false; render();
}
function friendly(e){
  const m = (e && (e.message || e.data?.message)) || String(e);
  if (/user rejected|denied|4001/i.test(m)) return 'You cancelled in the wallet.';
  if (/insufficient funds/i.test(m)) return 'Not enough ' + wanted().sym + ' in this wallet for gas.';
  if (/SaltSenderMismatch/i.test(m)) return 'Salt/sender mismatch: reconnect the wallet and preview again.';
  return m.length > 240 ? m.slice(0, 240) + '…' : m;
}
const fmtEth = wei => wei == null ? '?' : (Number(wei) / 1e18).toLocaleString(undefined, { maximumSignificantDigits: 3 }) + ' ' + wanted().sym;
const short = a => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';

// ───────────────────────── UI ─────────────────────────
let root = null, statusEl = null;
function setStatus(msg, kind){ if (statusEl){ statusEl.textContent = msg; statusEl.dataset.kind = kind || ''; } }
function el(tag, attrs = {}, ...kids){ const n = document.createElement(tag); for (const [k, v] of Object.entries(attrs)){ if (k === 'onclick') n.onclick = v; else if (k === 'html') n.innerHTML = v; else n.setAttribute(k, v); } for (const k of kids) n.append(k); return n; }
function render(){
  if (!root) return;
  root.innerHTML = '';
  const c = wanted();
  root.append(el('h3', {}, 'Mint from this page ', el('span', { class: 'dim' }, 'v2 test')));
  const steps = el('ol', { class: 'steps' }); root.append(steps);
  // 1. wallet
  const s1 = el('li'); steps.append(s1);
  if (!account){
    s1.append('Connect a browser wallet. ');
    if (providers.length > 1) providers.forEach(p => s1.append(el('button', { class: 'small', onclick: () => connect(p.provider) }, p.info.name)));
    else s1.append(el('button', { class: 'primary', onclick: () => connect() }, 'Connect wallet'));
  } else {
    const onRight = chainId === c.id;
    s1.append('Wallet ', el('code', {}, short(account)), ' on ', el('b', {}, chainId === null ? 'unknown network' : (Object.values(CHAINS).find(x => x.id === chainId) || { name: 'chain ' + chainId }).name), '. ');
    if (!onRight) s1.append(el('button', { class: 'primary', onclick: () => switchChain(CP().chain()) }, 'Switch to ' + c.name));
    else s1.append(el('span', { class: 'ok' }, '✓ ' + c.name));
  }
  // 2. preview
  const s2 = el('li'); steps.append(s2);
  const ready = account && chainId === c.id;
  s2.append('Preview the deploy: one transaction to the ABX factory. The SVG and description go on-chain as metadata fields; the canonical renderer answers tokenURI. ');
  s2.append(el('button', { class: 'small', onclick: preview, ...(ready && !busy ? {} : { disabled: '' }) }, txState && txState.stage !== 'preview' ? 'Preview again' : 'Preview'));
  const t = txState;
  if (t && t.stage === 'preview') s2.append(el('div', { class: 'hint' }, 'Estimating…'));
  if (t && (t.stage === 'ready' || t.stage === 'signing' || t.stage === 'pending' || t.stage === 'done')){
    const rows = [['Name', t.params.name], ['Symbol', t.params.symbol], ['Network', t.chain.name + (t.chain.testnet ? ' (testnet)' : ' (real funds)')], ['Owner · royalty 5%', short(account)],
      ['Contract will be', t.predicted], ['SVG on-chain', (t.bytes / 1024).toFixed(1) + ' KB' + (t.bytes > 24 * 1024 ? ' · over 24 KB, costs more' : '')], ['Gas estimate', t.gas.toString() + (t.feeWei != null ? ' ≈ ' + fmtEth(t.feeWei) : '')]];
    const tbl = el('table', { class: 'kv' }); rows.forEach(([k, v]) => tbl.append(el('tr', {}, el('td', {}, k), el('td', {}, v)))); s2.append(tbl);
  }
  // 3. mint
  const s3 = el('li'); steps.append(s3);
  if (!t || t.stage === 'preview' || t.stage === 'error' && !t.params) s3.append('Mint. The wallet shows the exact gas; confirm there.');
  else if (t.stage === 'ready') s3.append(el('button', { class: 'primary', onclick: mint }, 'Mint on ' + t.chain.name), el('span', { class: 'hint' }, t.chain.testnet ? ' Free test ETH only.' : ' Real funds. Check the fee in your wallet before confirming.'));
  else if (t.stage === 'signing') s3.append('Confirm in your wallet…');
  else if (t.stage === 'pending') s3.append('Sent. Waiting for confirmation… ', el('a', { href: t.chain.explorer + '/tx/' + t.hash, target: '_blank', rel: 'noopener' }, 'view transaction ↗'));
  else if (t.stage === 'done'){
    s3.append(el('b', { class: 'ok' }, t.live ? '✓ Minted. ' : '✓ Confirmed. '), 'Contract ', el('a', { href: t.chain.explorer + '/address/' + t.predicted, target: '_blank', rel: 'noopener' }, short(t.predicted) + ' ↗'), ' · token #0 · ',
      el('a', { href: t.chain.explorer + '/tx/' + t.hash, target: '_blank', rel: 'noopener' }, 'transaction ↗'));
    if (t.chain.opensea) s3.append(' · ', el('a', { href: 'https://opensea.io/assets/' + t.chain.opensea + '/' + t.predicted.toLowerCase() + '/0', target: '_blank', rel: 'noopener' }, 'OpenSea ↗'));
    s3.append(el('div', { class: 'hint' }, 'Metadata and image are served from the chain. Marketplaces may take a few minutes to index. Verify any time with: abx verify ' + t.predicted));
  }
  if (t && t.stage === 'error') s3.append(el('div', { class: 'err' }, t.msg), t.hash ? el('a', { href: c.explorer + '/tx/' + t.hash, target: '_blank', rel: 'noopener' }, ' transaction ↗') : '');
  statusEl = el('div', { class: 'status-line' }); root.append(statusEl);
  root.append(el('p', { class: 'hint' }, 'Same contracts and defaults as the abx command-line tool (factory ', el('code', {}, short(FACTORY)), ', renderer ', el('code', {}, short(RENDERER)), '). ABX is prerelease; rehearse on Sepolia first.'));
}
function mount(){
  const panel = document.getElementById('panel-abx'); if (!panel || root) return;
  root = el('div', { class: 'mintbox', id: 'mintbox' });
  panel.insertBefore(root, panel.querySelector('p.hint'));
  const css = document.createElement('style');
  css.textContent = '.mintbox{margin:10px 0 6px;padding:10px 10px 4px;background:rgba(0,0,0,.18);border:2px solid var(--chrome-edge)}.mintbox h3{font-size:14px;color:#fff;margin:0 0 6px}.mintbox .dim{font-weight:400;opacity:.8;font-size:12px}.mintbox .ok{color:#9ff0c5}.mintbox .err{color:#ffb3a7;font-size:13px;margin-top:4px}.mintbox table.kv{font-size:12px;margin:6px 0;border-collapse:collapse}.mintbox table.kv td{padding:2px 8px 2px 0;color:#e8f4f3;vertical-align:top;word-break:break-all}.mintbox table.kv td:first-child{color:#cfe9e8;white-space:nowrap}.mintbox code{font:12px ui-monospace,Menlo,Consolas,monospace;background:rgba(0,0,0,.25);padding:1px 4px;color:#fff}.mintbox .status-line{font-size:12px;color:#ffd9d0;min-height:1em}.mintbox .status-line[data-kind=err]{color:#ffb3a7}.mintbox button{margin:2px 4px 2px 0}';
  document.head.appendChild(css);
  render();
  CP().onChange(() => { if (txState && txState.stage === 'ready'){ txState = null; render(); } });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();

// Test hooks (pure functions only; nothing here touches a wallet).
window.__abxMint = { keccakHex, utf8, encodeCall, encodeDeploy, encodePredict, buildParams, selector, PARAMS_T, FACTORY, RENDERER, checksum, tag };
})();
