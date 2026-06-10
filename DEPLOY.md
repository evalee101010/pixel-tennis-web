# Deploy

This project is a static Canvas game. The site root is this folder:

```text
pixel-tennis-web/
```

It can be hosted by any static website platform. No build command is required.

Live site:

```text
https://evalee101010.github.io/pixel-tennis-web/
```

GitHub repository:

```text
https://github.com/evalee101010/pixel-tennis-web
```

## Recommended Long-Term Flow

1. Keep this folder as its own Git repository.
2. Push the repository to GitHub.
3. Enable GitHub Pages from the `main` branch and `/` root for the single-player static site, or connect the repository to Netlify/Vercel.
4. After future edits, commit and push again. The live site will update from the new commit.

## Online Multiplayer

The online room mode needs a Node WebSocket server, so it cannot run on GitHub Pages alone. Deploy the repository as a Node web service when you want shareable online rooms.

The service entry point is:

```sh
npm start
```

The server uses the platform `PORT` environment variable and serves both the web app and `/ws` WebSocket endpoint from the same domain. In production, open:

```text
https://<your-service-domain>/?mode=online
```

The browser will automatically connect to:

```text
wss://<your-service-domain>/ws
```

For a Render-style deployment, `render.yaml` is included with:

- Build command: `npm ci --omit=dev`
- Start command: `npm start`
- Health check: `/health`

Keep the online server to one instance for now. Room state lives in process memory, so multi-instance scaling requires a shared room store or sticky routing.

## Local Check

```sh
python3 -m http.server 4173
```

Open:

```text
http://localhost:4173/
```

For online rooms locally:

```sh
npm start
```

Open:

```text
http://localhost:8787/?mode=online
```

## GitHub Pages

Use these settings in the repository:

- Source: Deploy from a branch
- Branch: `main`
- Folder: `/ (root)`

The `.nojekyll` file is included so GitHub Pages serves the static assets directly.

## Netlify

If connecting this repository to Netlify:

- Base directory: empty or project root
- Build command: empty
- Publish directory: `.`
