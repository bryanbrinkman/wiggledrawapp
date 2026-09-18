# ChainPainter

A tiny browser paint app that draws **SVG that wobbles**. Every stroke is jittered across a few frames and exported as a self‑contained, SMIL‑animated SVG — no JavaScript in the output, so it's ready for on‑chain or anywhere plain SVG renders.

- Pencil, line, rectangle, ellipse, eraser, and fill‑bucket tools (fills become wobbling vector polygons under the strokes; tap a fill to recolour it)
- Add your own colours to the palette with the **+** swatch (hold or right‑click one to remove it)
- Move tool: drag the whole layer, or nudge it with the arrow keys (Shift = 10 px)
- Layers (add, hide, reorder, rename, delete)
- Adjustable wiggle amplitude, speed, and frame count
- Undo / redo and keyboard shortcuts: `P L R O E G V` pick tools, `[ ]` brush size, `⌘/Ctrl+Z` undo, `⇧⌘/Ctrl+Z` redo, `Space` play/pause, `⌘/Ctrl+S` save, `F` full screen, `?` shows the list
- Save / open projects as JSON, autosave to the browser
- Download or copy the finished SVG
- **Copy link** makes a shareable URL that plays the animation; the whole project is compressed into the link itself, so nothing is uploaded and anyone can hit **Remix** to open it in the editor
- Mint‑ready export for [Transient Labs onchain art](https://docs.transientlabs.xyz/integrations/onchain-art): one‑click token URI with a live 24 KB budget meter

The whole app is a single file: [`index.html`](index.html). No build step, no dependencies.

## Run it locally

Open `index.html` in a browser, or serve the folder:

```sh
npx serve .
```

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

The **Mint onchain** section has a button per platform. Pick one and it expands into a guided flow. The 24 KB meter under the canvas switches to that platform's budget, and drawing is blocked at the limit.

**Transient Labs** counts the whole base64 token URI against 24 KB. The flow builds metadata per the [Transient Labs onchain art guide](https://docs.transientlabs.xyz/integrations/onchain-art) and [metadata structure](https://docs.transientlabs.xyz/integrations/metadata-structure): the SVG embedded as `data:image/svg+xml;base64,…` in `image`, plus `name`, `description`, `attributes`, `media` and `image_sha256`, all wrapped as `data:application/json;base64,…`. **Copy token URI** puts that string on your clipboard to paste into Transient Labs Studio.

**ABX (Art Blocks)** counts the raw SVG against 24 KB, so roughly 1.8× more art fits. ABX deploys from the command line with your browser wallet ([deploy guide](https://docs.abx.io/docs/using-abx/guides/deploy-a-digital-asset)). The flow takes a symbol and network, then gives you a ready‑to‑paste dry‑run command, the real `--sign` command, and a prefilled prompt for a coding agent using the ABX skill. It defaults to Base (production beta); pick Base Sepolia for a free rehearsal. ABX is prerelease, so check `abx deploy --help` if a flag has moved.

When over budget, **Fit to 24 KB** re‑simplifies strokes (and drops frames if it must) until the piece fits the selected platform. Fit can be undone until you draw again.

## How the export works

Each stroke's points are offset by a seeded random amount per frame (the same seed drives the on‑screen preview and the export, so what you see is what you get). The drawing is written once per frame as a group, and one `<animate attributeName="display">` per group flips between them at the chosen speed with `calcMode="discrete"`; the first group doubles as the static fallback. Strokes are stored as compact relative paths (`q` then `t` shorthand curves), consecutive strokes of the same colour and width share a group, and eraser strokes become a per‑layer, per‑frame `<mask>` rather than being baked into the paths.
