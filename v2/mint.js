/* ChainPainter v2 — mint from the page with ABX (Art Blocks) and a browser wallet.
 *
 * No dependencies; mirrors what the `abx` command-line tool sends.
 *  - Create contract: one transaction to the canonical SeriesImageFactory, `deployDeterministic(params, salt)`,
 *    deploys an empty Series contract (one contract, many artworks) owned by the wallet.
 *  - Mint artwork: one `multicall([setTokenField image/name/description, mint(owner)])` on that contract
 *    stores the SVG inline on-chain and mints the next id to the wallet (owner only). The canonical renderer
 *    answers tokenURI. Addresses are the ABX canonical CREATE2 set (same on every chain). Contracts are
 *    remembered in localStorage, per network. (The 1/1 factory encoder is kept for tests.)
 *
 * Wallets: any injected EIP-1193 provider (MetaMask, Rabby, Coinbase Wallet, Brave, in-app browsers),
 * discovered with EIP-6963. The JSON-RPC reads go through the wallet's own provider.
 */
(() => {
'use strict';

// ───────────────────────── constants (from @artblocks/abx-sdk deployments.ts) ─────────────────────────
const FACTORY = '0x2ff8828a9150401225bB217CAA8b9b5e666a1c97';   // OneOfOneImageFactory (single 1/1)
const SERIES_FACTORY = '0x83222f791cA243FEb0c1Fef93a8732eCe3001b4b'; // SeriesImageFactory (collections)
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

// ───────────────────────── ABX calls ─────────────────────────
const FIELD_T = { type: 'tuple', components: [{ name: 'field', type: 'bytes32' }, { name: 'representation', type: 'bytes32' }, { name: 'value', type: 'bytes' }] };
const TOKEN_FIELD_T = { type: 'tuple', components: [{ name: 'tokenId', type: 'uint256' }, ...FIELD_T.components] };
const BASE_T = [ // shared head of OneOfOneImage.InitParams and SeriesImage.InitParams (after owner / mintTo)
  { name: 'name', type: 'string' }, { name: 'symbol', type: 'string' },
  { name: 'tokenURIBase', type: 'string' }, { name: 'tokenURIRenderer', type: 'address' }, { name: 'contractURIBase', type: 'string' }, { name: 'contractURIRenderer', type: 'address' },
  { name: 'royaltyReceiver', type: 'address' }, { name: 'royaltyBps', type: 'uint16' }, { name: 'maxRoyaltyBps', type: 'uint16' }, { name: 'burnable', type: 'bool' }, { name: 'transferValidator', type: 'address' },
];
// OneOfOneImage.InitParams
const PARAMS_T = { type: 'tuple', components: [
  { name: 'owner', type: 'address' }, { name: 'mintTo', type: 'address' }, ...BASE_T,
  { name: 'tokenFields', type: 'tuple[]', components: FIELD_T.components }, { name: 'contractFields', type: 'tuple[]', components: FIELD_T.components },
] };
// SeriesImage.InitParams (contracts/src/tokens/SeriesImage.sol)
const SERIES_PARAMS_T = { type: 'tuple', components: [
  { name: 'owner', type: 'address' }, ...BASE_T,
  { name: 'maxInvocations', type: 'uint256' }, { name: 'primaryPayee', type: 'address' }, { name: 'minter', type: 'address' }, { name: 'paused', type: 'bool' },
  { name: 'mintTo', type: 'address' }, { name: 'mintCount', type: 'uint256' },
  { name: 'tokenFields', type: 'tuple[]', components: TOKEN_FIELD_T.components }, { name: 'contractFields', type: 'tuple[]', components: FIELD_T.components },
] };
const tag = s => '0x' + padRight(hexOf(utf8(s)), 1);                       // encodeTag: utf8, right-padded to 32 bytes
const inlineField = (field, text) => ({ field: tag(field), representation: tag('inline'), value: '0x' + hexOf(utf8(text)) });
function baseParams(owner, name, symbol){
  return { name, symbol, tokenURIBase: '', tokenURIRenderer: RENDERER, contractURIBase: '', contractURIRenderer: RENDERER,
    royaltyReceiver: owner, royaltyBps: ROYALTY_BPS, maxRoyaltyBps: MAX_ROYALTY_BPS, burnable: false, transferValidator: ZERO };
}
// 1/1: the drawing is the whole contract.
function buildParams({ owner, name, symbol, description, svg }){
  return { owner, mintTo: owner, ...baseParams(owner, name, symbol),
    tokenFields: [inlineField('image', svg), ...(description ? [inlineField('description', description)] : [])],
    contractFields: description ? [inlineField('description', description)] : [] };
}
// Per-token fields for one piece of a collection. The renderer falls back to "{collection} #{id}" when no name is set.
const pieceFields = (tokenId, { name, description, svg }) => [
  { tokenId, ...inlineField('image', svg) },
  ...(name ? [{ tokenId, ...inlineField('name', name) }] : []),
  ...(description ? [{ tokenId, ...inlineField('description', description) }] : []),
];
// Collection (Series): deploy once; optionally mint the current drawing as token #0 in the same transaction (piece=null → empty).
function buildSeriesParams({ owner, name, symbol, about, size, piece }){
  return { owner, ...baseParams(owner, name, symbol), maxInvocations: size, primaryPayee: owner, minter: ZERO, paused: false, mintTo: piece ? owner : ZERO, mintCount: piece ? 1 : 0,
    tokenFields: piece ? pieceFields(0, piece) : [], contractFields: about ? [inlineField('description', about)] : [] };
}
const encodeDeploy = (params, salt) => encodeCall('deployDeterministic', [PARAMS_T, { type: 'bytes32' }], [params, salt]);
const encodeSeriesDeploy = (params, salt) => encodeCall('deployDeterministic', [SERIES_PARAMS_T, { type: 'bytes32' }], [params, salt]);
const encodePredict = salt => encodeCall('predictDeterministicAddress', [{ type: 'bytes32' }], [salt]);
// Add one piece to an existing collection: set its fields and mint it, atomically, in one multicall (owner only).
const SET_FIELD_T = [{ type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes' }];
function encodeMintPiece(tokenId, piece, to){
  const calls = pieceFields(tokenId, piece).map(f => encodeCall('setTokenField', SET_FIELD_T, [tokenId, f.field, f.representation, f.value]));
  calls.push(encodeCall('mint', [{ type: 'address' }], [to]));
  return encodeCall('multicall', [{ type: 'bytes[]' }], [calls]);
}
const view = name => encodeCall(name, [], []);
const decodeUint = hex => BigInt('0x' + (hex.replace(/^0x/, '') || '0'));
const decodeAddress = hex => checksum('0x' + hex.replace(/^0x/, '').padStart(64, '0').slice(-40));
function decodeString(hex){ const h = hex.replace(/^0x/, ''); const off = Number(BigInt('0x' + h.slice(0, 64))) * 2, len = Number(BigInt('0x' + h.slice(off, off + 64))) * 2; return new TextDecoder().decode(bytesOf(h.slice(off + 64, off + 64 + len))); }
const TRANSFER_TOPIC = keccakHex(utf8('Transfer(address,address,uint256)'));
function mintedIds(receipt, contract){ return (receipt.logs || []).filter(l => l.address && l.address.toLowerCase() === contract.toLowerCase() && l.topics && l.topics[0] === TRANSFER_TOPIC && /^0x0{64}$/.test(l.topics[1] || '') && l.topics[3]).map(l => decodeUint(l.topics[3])); }
function saltFor(owner){ const e = new Uint8Array(12); crypto.getRandomValues(e); return owner.toLowerCase() + hexOf(e); } // 20-byte deployer guard + 12 bytes entropy

// ───────────────────────── remembered collections (this browser) ─────────────────────────
const LS_COLL = 'chainpainter:collections';
function loadColls(){ try { const v = JSON.parse(localStorage.getItem(LS_COLL) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } }
function saveColls(list){ try { localStorage.setItem(LS_COLL, JSON.stringify(list)); } catch {} }
function remember(c){ const list = loadColls().filter(x => !(x.chain === c.chain && x.address.toLowerCase() === c.address.toLowerCase())); list.unshift(c); saveColls(list.slice(0, 50)); }
function forget(c){ saveColls(loadColls().filter(x => !(x.chain === c.chain && x.address.toLowerCase() === c.address.toLowerCase()))); }
const collsHere = () => loadColls().filter(c => c.chain === CP().chain());

// ───────────────────────── wallet (EIP-1193 + EIP-6963) ─────────────────────────
const providers = [];
window.addEventListener('eip6963:announceProvider', e => { if (!providers.some(p => p.info.uuid === e.detail.info.uuid)) providers.push(e.detail); render(); });
window.dispatchEvent(new Event('eip6963:requestProvider'));
let eth = null, account = null, chainId = null, busy = false, txState = null;
const rpc = (method, params = []) => eth.request({ method, params });
const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);
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
const $ = id => document.getElementById(id);
function wanted(){ return CHAINS[CP().chain()] || CHAINS.ethereum; }
const DEFAULT_SIZE = 10000;              // room for 10,000 artworks per contract; can be lowered later with the abx tool, never raised
let pick = '';                           // selected contract address, or 'existing' while adding one by address
const form = { collName: '', existing: '' };
const symbolFor = name => { const s = name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); return s || 'ART'; };
const selected = () => collsHere().find(c => c.address === pick) || null;
async function requireCode(addr, what){ const code = await rpc('eth_getCode', [addr, 'latest']); if (!code || code === '0x') throw new Error(what); }
async function send(to, data){
  const gas = BigInt(await rpc('eth_estimateGas', [{ from: account, to, data }]));
  const hash = await rpc('eth_sendTransaction', [{ from: account, to, data, value: '0x0', gas: '0x' + ((gas * 125n) / 100n).toString(16) }]);
  txState = { ...txState, stage: 'pending', hash }; render();
  let receipt = null;
  for (let i = 0; i < 400 && !receipt; i++){ await new Promise(r => setTimeout(r, 3000)); receipt = await rpc('eth_getTransactionReceipt', [hash]).catch(() => null); }
  if (!receipt) throw new Error('Still pending after 20 minutes. Check the explorer link.');
  if (receipt.status !== '0x1') throw new Error('The transaction reverted. Nothing changed; gas was spent.');
  return { hash, receipt };
}
// Create contract: deploy an empty Series (no artwork yet) via the canonical factory.
async function createContract(){
  const c = wanted(); const name = form.collName.trim();
  if (!name){ setStatus('Give the contract a name first.', 'err'); return; }
  busy = true; txState = { stage: 'signing', kind: 'contract', chain: c, name }; render();
  try {
    await requireCode(SERIES_FACTORY, 'ABX is not deployed on ' + c.name + ' yet.');
    const params = buildSeriesParams({ owner: account, name, symbol: symbolFor(name), about: '', size: DEFAULT_SIZE, piece: null });
    const salt = saltFor(account);
    const predicted = decodeAddress(await call(SERIES_FACTORY, encodePredict(salt)));
    const { hash, receipt } = await send(SERIES_FACTORY, encodeSeriesDeploy(params, salt));
    const code = await rpc('eth_getCode', [predicted, 'latest']).catch(() => '0x');
    if (!code || code === '0x') throw new Error('Confirmed, but no contract found at ' + predicted + '. Check the transaction.');
    const coll = { chain: CP().chain(), address: predicted, name, symbol: params.symbol, size: DEFAULT_SIZE, minted: 0 };
    remember(coll); pick = predicted; form.collName = '';
    txState = { stage: 'done', kind: 'contract', chain: c, hash, receipt, contract: predicted, coll };
  } catch (e){ txState = { stage: 'error', kind: 'contract', chain: c, msg: friendly(e), hash: txState.hash }; }
  busy = false; render();
}
// Mint artwork: set the next token's fields and mint it to you, atomically, on the selected contract.
async function mintArtwork(){
  const c = wanted(); const coll = selected();
  if (!coll){ setStatus('Create a contract first, or pick one.', 'err'); return; }
  if (!CP().strokes()){ setStatus('Draw something first.', 'err'); return; }
  busy = true; txState = { stage: 'signing', kind: 'artwork', chain: c, coll }; render();
  try {
    await requireCode(coll.address, 'No contract at ' + coll.address + ' on ' + c.name + '.');
    const owner = decodeAddress(await call(coll.address, view('owner')));
    if (owner.toLowerCase() !== account.toLowerCase()) throw new Error('This wallet (' + short(account) + ') does not own ' + coll.name + '; its owner is ' + short(owner) + '.');
    const next = decodeUint(await call(coll.address, view('nextTokenId'))), max = decodeUint(await call(coll.address, view('maxInvocations')));
    if (next >= max) throw new Error(coll.name + ' is full: all ' + max + ' artworks are minted. Create a new contract.');
    const svg = CP().svg(); const piece = { name: CP().name(), description: CP().desc(), svg };
    const { hash, receipt } = await send(coll.address, encodeMintPiece(next, piece, account));
    const ids = mintedIds(receipt, coll.address); const tokenId = ids.length ? ids[0] : next;
    remember({ ...coll, minted: Number(tokenId) + 1 });
    txState = { stage: 'done', kind: 'artwork', chain: c, hash, receipt, contract: coll.address, coll, tokenId, piece, bytes: utf8(svg).length };
  } catch (e){ txState = { stage: 'error', kind: 'artwork', chain: c, msg: friendly(e), hash: txState.hash }; }
  busy = false; render();
}
// Remember a contract deployed elsewhere (abx CLI, another browser) after checking it on-chain.
async function addExisting(){
  const addr = form.existing.trim();
  if (!isAddress(addr)) { setStatus('Paste the contract address (0x…, 40 hex characters).', 'err'); return; }
  busy = true; render();
  try {
    await requireCode(addr, 'No contract at that address on ' + wanted().name + '.');
    const [owner, name, symbol, max, next] = await Promise.all([call(addr, view('owner')).then(decodeAddress), call(addr, view('name')).then(decodeString), call(addr, view('symbol')).then(decodeString), call(addr, view('maxInvocations')).then(decodeUint), call(addr, view('nextTokenId')).then(decodeUint)]);
    if (owner.toLowerCase() !== account.toLowerCase()) throw new Error('That contract is owned by ' + short(owner) + ', not this wallet.');
    const coll = { chain: CP().chain(), address: checksum(addr), name, symbol, size: Number(max), minted: Number(next) };
    remember(coll); pick = coll.address; form.existing = ''; txState = null;
  } catch (e){ txState = { stage: 'error', kind: 'add', chain: wanted(), msg: friendly(e) }; }
  busy = false; render();
}
function friendly(e){
  const m = (e && (e.message || e.data?.message)) || String(e);
  if (/user rejected|denied|4001/i.test(m)) return 'You cancelled in the wallet.';
  if (/insufficient funds/i.test(m)) return 'Not enough ' + wanted().sym + ' in this wallet for gas.';
  if (/SaltSenderMismatch/i.test(m)) return 'Salt/sender mismatch: reconnect the wallet and try again.';
  if (/Unauthorized/i.test(m)) return 'The contract refused: this wallet is not its owner.';
  return m.length > 240 ? m.slice(0, 240) + '…' : m;
}
const short = a => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';

// ───────────────────────── UI ─────────────────────────
let root = null, statusEl = null;
function setStatus(msg, kind){ if (statusEl){ statusEl.textContent = msg; statusEl.dataset.kind = kind || ''; } }
function el(tag, attrs = {}, ...kids){ const n = document.createElement(tag); for (const [k, v] of Object.entries(attrs)){ if (k === 'onclick') n.onclick = v; else if (k === 'oninput') n.oninput = v; else if (k === 'onchange') n.onchange = v; else if (k === 'html') n.innerHTML = v; else n.setAttribute(k, v); } for (const k of kids) n.append(k); return n; }
const link = (href, text) => el('a', { href, target: '_blank', rel: 'noopener' }, text);
// Mainnet / Sepolia tabs drive the app's own Network select (#abxChain) so both stay in step.
let lastMain = 'ethereum';
function setNet(test){
  const key = CP().chain(); if (!CHAINS[key].testnet) lastMain = key;
  const target = test ? (/base/.test(key) ? 'base-sepolia' : 'sepolia') : (key === 'base-sepolia' ? 'base' : lastMain);
  const sel = $('abxChain'); if (sel && sel.value !== target){ sel.value = target; sel.dispatchEvent(new Event('change', { bubbles: true })); }
  txState = null; if (!selected()) pick = (collsHere()[0] || {}).address || ''; render();
}
function input(key, attrs){ return el('input', { type: 'text', value: form[key], oninput: e => { form[key] = e.target.value; }, ...attrs }); }
function render(){
  if (!root) return;
  const focused = document.activeElement && root.contains(document.activeElement) ? document.activeElement.id : null;
  root.innerHTML = '';
  const c = wanted(), t = txState, colls = collsHere();
  if (!selected() && pick !== 'existing') pick = (colls[0] || {}).address || '';
  root.append(el('div', { class: 'head' }, el('h3', {}, 'Mint with ABX ', el('span', { class: 'dim' }, 'v2 test')),
    el('div', { class: 'nets' },
      el('button', { class: 'small' + (!c.testnet ? ' on' : ''), 'data-net': 'mainnet', onclick: () => setNet(false) }, 'Mainnet'),
      el('button', { class: 'small' + (c.testnet ? ' on' : ''), 'data-net': 'sepolia', onclick: () => setNet(true) }, 'Sepolia test'))));
  root.append(el('div', { class: 'hint' }, c.testnet ? c.name + ' · free test ETH, nothing real.' : c.name + ' · real funds. Gas is paid by your wallet.'));
  // wallet
  const w = el('div', { class: 'row wallet' }); root.append(w);
  if (!account){
    w.append(el('span', {}, 'Wallet '));
    if (providers.length > 1) providers.forEach(p => w.append(el('button', { class: 'small', onclick: () => connect(p.provider) }, p.info.name)));
    else w.append(el('button', { class: 'primary', onclick: () => connect() }, 'Connect wallet'));
  } else {
    const onRight = chainId === c.id;
    w.append('Wallet ', el('code', {}, short(account)), onRight ? el('span', { class: 'ok' }, ' ✓ ' + c.name) : el('button', { class: 'primary', onclick: () => switchChain(CP().chain()) }, 'Switch wallet to ' + c.name));
  }
  const ready = account && chainId === c.id && !busy;
  // 1. contract
  const s1 = el('div', { class: 'block' }); root.append(s1);
  s1.append(el('div', { class: 'row' }, el('label', {}, 'Contract / collection name ', input('collName', { id: 'collName', maxlength: '80', placeholder: 'e.g. Wobble Studies' })),
    el('button', { class: 'primary', id: 'createBtn', onclick: createContract, ...(ready ? {} : { disabled: '' }) }, 'Create contract')));
  if (colls.length || pick === 'existing'){
    const sel = el('select', { id: 'collPick', onchange: e => { pick = e.target.value; txState = null; render(); } });
    colls.forEach(x => sel.append(el('option', { value: x.address, ...(pick === x.address ? { selected: '' } : {}) }, x.name + ' · ' + (x.minted || 0) + ' minted · ' + short(x.address))));
    sel.append(el('option', { value: 'existing', ...(pick === 'existing' ? { selected: '' } : {}) }, 'Add a contract I deployed elsewhere…'));
    s1.append(el('div', { class: 'row' }, el('label', {}, 'Contract ', sel)));
  } else s1.append(el('div', { class: 'hint' }, 'No contracts on ' + c.name + ' yet. Create one above, or ', el('a', { href: '#', onclick: e => { e.preventDefault(); pick = 'existing'; render(); } }, 'add one you already deployed'), '.'));
  if (pick === 'existing'){
    s1.append(el('div', { class: 'row' }, el('label', {}, 'Address ', input('existing', { id: 'collAddr', size: '44', placeholder: '0x…', spellcheck: 'false' })),
      el('button', { class: 'small', onclick: addExisting, ...(account && !busy ? {} : { disabled: '' }) }, 'Check & add')));
  }
  // 2. artwork
  const s2 = el('div', { class: 'block' }); root.append(s2);
  const nameEl = el('input', { type: 'text', id: 'artName', maxlength: '80', placeholder: 'untitled', value: ($('tokName') || {}).value || '', oninput: e => { const tn = $('tokName'); if (tn){ tn.value = e.target.value; tn.dispatchEvent(new Event('input', { bubbles: true })); } } });
  s2.append(el('div', { class: 'row' }, el('label', {}, 'Artwork name ', nameEl),
    el('button', { class: 'primary', id: 'mintBtn', onclick: mintArtwork, ...(ready && selected() ? {} : { disabled: '' }) }, 'Mint artwork')));
  if (selected()) s2.append(el('div', { class: 'hint' }, 'Mints this drawing as the next piece of ', el('b', {}, selected().name), '. The description above goes with it. One transaction; the wallet shows the exact gas.'));
  // progress / result
  const r = el('div', { class: 'result' }); root.append(r);
  if (t && t.stage === 'signing') r.append(el('div', { class: 'hint' }, 'Estimating gas, then confirm in your wallet…'));
  else if (t && t.stage === 'pending') r.append(el('div', { class: 'hint' }, 'Sent. Waiting for confirmation… ', link(t.chain.explorer + '/tx/' + t.hash, 'view transaction ↗')));
  else if (t && t.stage === 'done'){
    if (t.kind === 'contract') r.append(el('b', { class: 'ok' }, '✓ Contract created. '), el('b', {}, t.coll.name), ' at ', link(t.chain.explorer + '/address/' + t.contract, short(t.contract) + ' ↗'), ' · ', link(t.chain.explorer + '/tx/' + t.hash, 'transaction ↗'), el('div', { class: 'hint' }, 'It is selected below. Now name the artwork and mint it.'));
    else {
      const id = t.tokenId.toString();
      r.append(el('b', { class: 'ok' }, '✓ Minted. '), el('b', {}, t.piece.name), ' is #' + id + ' of ' + t.coll.name + ' · ', link(t.chain.explorer + '/address/' + t.contract, 'contract ↗'), ' · ', link(t.chain.explorer + '/tx/' + t.hash, 'transaction ↗'));
      if (t.chain.opensea) r.append(' · ', link('https://opensea.io/assets/' + t.chain.opensea + '/' + t.contract.toLowerCase() + '/' + id, 'OpenSea ↗'));
      r.append(el('div', { class: 'hint' }, (t.bytes / 1024).toFixed(1) + ' KB of SVG stored on-chain. Marketplaces may take a few minutes to index. Draw the next one and mint again.'));
    }
  }
  else if (t && t.stage === 'error') r.append(el('div', { class: 'err' }, t.msg), t.hash ? link(c.explorer + '/tx/' + t.hash, ' transaction ↗') : '');
  statusEl = el('div', { class: 'status-line' }); root.append(statusEl);
  root.append(el('p', { class: 'hint foot' }, 'Each contract is an ABX Series (one contract, many artworks; up to ' + DEFAULT_SIZE.toLocaleString() + '). Image, name and description are stored on-chain; 5% royalty to you. Contracts you create are remembered in this browser, per network. ABX is prerelease; rehearse on Sepolia first.'));
  if (focused && $(focused)){ const f = $(focused); f.focus(); try { f.setSelectionRange(f.value.length, f.value.length); } catch {} }
}
function mount(){
  const host = document.querySelector('.export.mint'); if (!host || root) return;
  root = el('div', { class: 'mintbox', id: 'mintbox' });
  const plats = host.querySelector('.plats'); host.insertBefore(root, plats || null);
  const abx = host.querySelector('[data-plat=abx]'); if (abx && abx.getAttribute('aria-pressed') !== 'true') abx.click(); // ABX byte budget (raw SVG vs 24 KB)
  const css = document.createElement('style');
  css.textContent = '.export.mint .plats,.export.mint .panel{display:none!important}.mintbox{margin:6px 0 4px;padding:10px 10px 4px;background:rgba(0,0,0,.18);border:2px solid var(--chrome-edge)}.mintbox .head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:6px}.mintbox h3{font-size:14px;color:#fff;margin:0}.mintbox .dim{font-weight:400;opacity:.8;font-size:12px}.mintbox .ok{color:#9ff0c5}.mintbox .err{color:#ffb3a7;font-size:13px;margin-top:4px}.mintbox code{font:12px ui-monospace,Menlo,Consolas,monospace;background:rgba(0,0,0,.25);padding:1px 4px;color:#fff}.mintbox .status-line{font-size:12px;color:#ffd9d0;min-height:1em}.mintbox .status-line[data-kind=err]{color:#ffb3a7}.mintbox button{margin:2px 4px 2px 0}.mintbox .nets button.on{background:#fff;color:#1b3a3a;font-weight:700}.mintbox .block{margin:10px 0;padding-top:8px;border-top:1px solid rgba(255,255,255,.15)}.mintbox .row{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;margin:4px 0}.mintbox .row.wallet{margin-top:8px;font-size:13px;color:#e8f4f3}.mintbox .row label{display:flex;align-items:center;gap:6px;font-size:12px;color:#e8f4f3;flex:1 1 220px;min-width:0;max-width:100%}.mintbox .row input,.mintbox .row select{font-size:13px;padding:4px 6px;min-width:0;flex:1;max-width:100%}.mintbox .row select{text-overflow:ellipsis}.mintbox .result{margin:6px 0;font-size:13px;color:#e8f4f3}.mintbox a{color:#bfe9ff}.mintbox .hint{font-size:12px;opacity:.9}.mintbox .foot{margin:8px 0 4px}';
  document.head.appendChild(css);
  render();
  const tn = $('tokName'); if (tn) tn.addEventListener('input', () => { const a = $('artName'); if (a && a.value !== tn.value) a.value = tn.value; });
  const sel = $('abxChain'); if (sel) sel.addEventListener('change', () => { if (!CHAINS[sel.value].testnet) lastMain = sel.value; txState = null; if (!selected()) pick = (collsHere()[0] || {}).address || ''; render(); });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();

// Test hooks (pure functions only; nothing here touches a wallet).
window.__abxMint = { keccakHex, utf8, encodeCall, encodeDeploy, encodeSeriesDeploy, encodePredict, encodeMintPiece, buildParams, buildSeriesParams, pieceFields, selector, PARAMS_T, SERIES_PARAMS_T, FACTORY, SERIES_FACTORY, RENDERER, checksum, tag, decodeString, mintedIds, TRANSFER_TOPIC };
})();
