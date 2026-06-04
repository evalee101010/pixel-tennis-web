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
3. Enable GitHub Pages from the `main` branch and `/` root, or connect the repository to Netlify/Vercel.
4. After future edits, commit and push again. The live site will update from the new commit.

## Local Check

```sh
python3 -m http.server 4173
```

Open:

```text
http://localhost:4173/
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
