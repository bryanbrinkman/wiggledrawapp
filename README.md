# ChainPainter

A tiny browser paint app that draws **SVG that wobbles**. Every stroke is jittered across a few frames and exported as a self‑contained, SMIL‑animated SVG — no JavaScript in the output, so it's ready for on‑chain or anywhere plain SVG renders.

- Pencil, line, rectangle, ellipse, eraser, and fill‑bucket tools (fills become wobbling vector polygons under the strokes; tap a fill to recolour it)
- Add your own colours to the palette with the **+** swatch (hold or right‑click one to remove it)
- Move tool: drag the whole layer, or nudge it with the arrow keys (Shift = 10 px)
- Layers (add, hide, reorder, rename, delete)
- **Frame-by-frame** mode (like Procreate's animation assist): a frame strip under the canvas, strokes belong to the frame you draw them on, **All frames** for backgrounds and holds, onion skin, add / duplicate / delete frames, up to 12. Wiggle still applies on top.
- Adjustable wiggle amount, speed, and frame count; the amount can be set per layer with the **All layers / This layer** toggle
- Undo / redo and keyboard shortcuts: `P L R O E G V` pick tools, `[ ]` brush size, `⌘/Ctrl+Z` undo, `⇧⌘/Ctrl+Z` redo, `Space` play/pause, `⌘/Ctrl+S` save, `F` full screen, `?` shows the list
- Save / open projects as JSON, autosave to the browser
- Collapsible sections (click a heading), each remembered in the browser. On wide screens **Project** and **Mint onchain** start collapsed. On phones **Color & brush** sits right under the canvas, the Title and size panel follows it, and every section below starts collapsed
- The **Title** sits in the status bar under the canvas, always visible; it names downloads, the share link and the minted artwork
- Zoom the canvas with a two‑finger pinch, or Ctrl/⌘ + scroll (trackpad pinch) on desktop; scroll pans while zoomed and the percentage chip resets it. Drawing stays accurate at any zoom
- On phones the tools and Undo/Redo stay pinned to the top while the page scrolls
- A one‑time **Draw → Export → Mint** strip for first‑time visitors
- Download or copy the finished SVG
- **Copy link** makes a shareable URL that plays the animation; the whole project is compressed into the link itself, so nothing is uploaded and anyone can hit **Remix** to open it in the editor
- **Mint onchain** from the page with [ABX by Art Blocks](https://docs.abx.io/) and a browser wallet: create a contract, then mint each drawing into it, image and metadata stored fully on-chain, with a live 24 KB budget meter

The whole app is a single file: [`index.html`](index.html). No build step, no dependencies (the mint module ships its own keccak‑256 and ABI encoder).

## Run it locally

Open `index.html` in a browser, or serve the folder:

```sh
npx serve .
```

## Analytics

The page loads Vercel Web Analytics (`/_vercel/insights/script.js`) on the deployed site only. Turn it on under the project's **Analytics** tab in the Vercel dashboard; nothing else is needed and no npm package is involved.

## Deploy to Vercel

This is a static site, so Vercel needs no configuration beyond what's in `vercel.json`.

**From the dashboard**

1. Go to <https://vercel.com/new> and import this GitHub repository.
2. Leave **Framework Preset** as *Other*. Leave the build command and output directory empty.
3. Click **Deploy**. Every push to the default branch redeploys automatically.

**From the CLI**

```sh
npm i -g vercel
vercel        # preview deployment
vercel --prod # production deployment
```

## Sharing

**Copy link** packs the entire project (layers, strokes, wiggle settings) into the URL fragment using deflate + base64url. Opening the link shows a clean viewer with the animation, **Download SVG**, **Copy link** and **Remix in ChainPainter**, which loads the drawing into the editor. Because the data lives after the `#`, it never reaches the server; the link is also a complete backup of the piece. A drawing that fits the 24 KB onchain budget makes a link of roughly 3–8 KB.

## Minting onchain

The **Mint onchain** section mints straight from the page with ABX (Art Blocks) and a browser wallet (MetaMask, Rabby, Coinbase Wallet, Brave, or a wallet's in‑app browser; any injected EIP‑1193 provider, discovered via EIP‑6963). Pick **Mainnet** or **Sepolia test** at the top (Ethereum by default; the hidden network setting also knows Base and Arbitrum, and Base pairs with Base Sepolia), connect, then:

1. **Contract name → Create contract.** One transaction to ABX's canonical `SeriesImageFactory.deployDeterministic(params, salt)` deploys an empty Series contract (one contract, many artworks, room for 10,000; the cap can be lowered later with the `abx` tool, never raised). Defaults match the CLI: 5 % royalty with a 10 % cap, not burnable, plain ERC‑721, owner = payee = royalty receiver = your wallet; the symbol is derived from the name. Contracts you create are remembered in the browser per network and appear in a **Contract** dropdown; **Add a contract I deployed elsewhere** checks an address on‑chain (owner, name, symbol, size, minted count) and remembers it too.
2. **Artwork name → Mint artwork.** A review appears first with a thumbnail, what will be stored, the network and an estimated fee (`eth_estimateGas` × `eth_gasPrice`); nothing is sent until **Confirm**. Changing the drawing or its details clears a pending review. Create contract has the same review step. Then one `multicall([setTokenField(id, image), setTokenField(id, name), …, mint(you)])` on the selected contract stores the SVG and metadata inline on‑chain and mints the next id to you, atomically. Only the contract owner can mint. The page reads the id back from the `Transfer` log and links the explorer and OpenSea. The artwork name is the project Title. **More options** holds the description, traits (stored as an OpenSea‑style `attributes` JSON array; plain numbers become numeric values) and an external link, each written as its own on‑chain field (`description`, `attributes`, `external_url`). Traits and link are remembered for the next mint.

**Wallet and gallery.** A connected wallet is remembered (only the fact and the wallet's id, in localStorage) and reconnects silently on the next visit with `eth_accounts`, which never prompts; **disconnect** forgets it. Under the Contract dropdown the page shows what is already in the selected contract, newest first, read from the chain with `tokenURI` (up to 12, each linking to the explorer).

ABX counts the raw SVG against 24 KB; the meter under the canvas shows it, and drawing is blocked (the canvas flashes red) at the limit. The canonical ABX metadata renderer answers `tokenURI`, so marketplaces read everything from the chain. ABX is prerelease: rehearse on Sepolia first. Not included: WalletConnect QR pairing (needs Reown's hosted SDK and a project id).

**Download PNG** in Export & share saves a 2048 px still of the first frame, and **Download GIF** saves a looping GIF of the wiggle at 2× (up to 1024 px) for posts and previews. Both are built in the browser.

When over budget, **Fit to 24 KB** re‑simplifies strokes (and drops frames if it must) until the piece fits. Fit can be undone until you draw again.

## How the export works

Each stroke's points are offset by a seeded random amount per frame (the same seed drives the on‑screen preview and the export, so what you see is what you get). The drawing is written once per frame as a group, and one `<animate attributeName="display">` per group flips between them at the chosen speed with `calcMode="discrete"`; the first group doubles as the static fallback. Strokes are stored as compact relative paths (`q` then `t` shorthand curves), consecutive strokes of the same colour and width share a group, and eraser strokes become a per‑layer, per‑frame `<mask>` rather than being baked into the paths.
