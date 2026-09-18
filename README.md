# ChainPainter

A tiny browser paint app that draws **SVG that wobbles**. Every stroke is jittered across a few frames and exported as a self‑contained, SMIL‑animated SVG — no JavaScript in the output, so it's ready for on‑chain or anywhere plain SVG renders.

- Pencil, line, rectangle, ellipse, and eraser tools
- Move tool: drag the whole layer, or nudge it with the arrow keys (Shift = 10 px)
- Layers (add, hide, reorder, rename, delete)
- Adjustable wiggle amplitude, speed, and frame count
- Undo / redo and keyboard shortcuts: `P L R O E V` pick tools, `[ ]` brush size, `⌘/Ctrl+Z` undo, `⇧⌘/Ctrl+Z` redo, `Space` play/pause, `⌘/Ctrl+S` save, `F` full screen, `?` shows the list
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

## Minting onchain with Transient Labs

The **Mint onchain** section at the bottom builds a token URI that follows the [Transient Labs onchain art guide](https://docs.transientlabs.xyz/integrations/onchain-art) and [metadata structure](https://docs.transientlabs.xyz/integrations/metadata-structure):

- The SVG is embedded as `data:image/svg+xml;base64,…` in the `image` field.
- `name`, `description`, `attributes` (wiggle, speed, frames, layers, strokes), `media` (size, dimensions, mime type) and `image_sha256` are filled in for you.
- The whole metadata object is wrapped as `data:application/json;base64,…` — that string is the token URI.
- The meter shows the token URI's size against the 24 KB limit. When a stroke would cross it, the canvas flashes red, the stroke is rejected, and drawing is blocked until you undo, lower **Frames**, or press **Fit to 24 KB**, which re‑simplifies your strokes (and drops to 2 frames if it must) until the token fits. Fit can be undone until you draw again.
- Paths are stored as compact relative coordinates and strokes are simplified with Douglas‑Peucker as you draw, so a typical drawing is several times smaller than a naive export.

**Copy token URI** puts the finished string on your clipboard to paste into the mint form. **Download token JSON** saves the unwrapped metadata if you'd rather inspect or encode it yourself.

## How the export works

Each stroke's points are offset by a seeded random amount per frame (the same seed drives the on‑screen preview and the export, so what you see is what you get). The drawing is written once per frame as a group, and one `<animate attributeName="display">` per group flips between them at the chosen speed with `calcMode="discrete"`; the first group doubles as the static fallback. Strokes are stored as compact relative paths (`q` then `t` shorthand curves), consecutive strokes of the same colour and width share a group, and eraser strokes become a per‑layer, per‑frame `<mask>` rather than being baked into the paths.
