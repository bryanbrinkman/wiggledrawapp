# Wiggle Paint

A tiny browser paint app that draws **SVG that wobbles**. Every stroke is jittered across a few frames and exported as a self‑contained, SMIL‑animated SVG — no JavaScript in the output, so it's ready for on‑chain or anywhere plain SVG renders.

- Pencil, line, rectangle, ellipse, and eraser tools
- Layers (add, hide, reorder, rename, delete)
- Adjustable wiggle amplitude, speed, and frame count
- Undo / redo, keyboard shortcuts (`⌘/Ctrl+Z`, `⇧⌘/Ctrl+Z`, `⌘/Ctrl+S`)
- Save / open projects as JSON, autosave to the browser
- Download or copy the finished SVG

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

## How the export works

Each stroke's points are offset by a seeded random amount per frame (the same seed drives the on‑screen preview and the export, so what you see is what you get). Frames are written as alternate `d` values on an `<animate>` element with `calcMode="discrete"`, which flips between them at the chosen speed. Eraser strokes become a per‑layer `<mask>` rather than being baked into the paths.
