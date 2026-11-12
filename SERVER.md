# Server setup

The app's API uses Node.js and SQLite. Hermes runs on the same machine as the API; the browser never receives Hermes credentials or connects to its backend directly.

## Requirements

- Node.js 22.13 or newer.
- Hermes Agent installed and configured with `hermes setup`.
- A Hermes web-search/extraction provider configured and able to access the public Instagram post.

The API invokes Hermes in one-shot mode with only the `web` toolset and ignores workspace rules. It does not enable shell, file, or other agent tools. It asks Hermes to return structured recipe data, validates the response, and stores the recipe and source URL in SQLite. An exact link is idempotent; another link with the same title and substantially matching ingredients is attached to the existing recipe.

Instagram posts must be public and accessible to Hermes' configured web provider. Private, login-gated, or unavailable posts cannot be imported reliably.

## Run locally

```sh
npm install
cp .env.example .env
npm run dev
```

The development command starts Vite and the API. Open the Vite URL it prints. The database is created at `data/recipetor.sqlite`.

## Home server

Build and run the production server:

```sh
npm ci
npm run build
cp .env.example .env
```

Set `RECIPETOR_HOST=0.0.0.0` and `RECIPETOR_PORT=8787` in `.env` if a reverse proxy on the home network needs to reach the service. Set `HERMES_BIN` to the absolute path to the Hermes executable if it is not on the service account's `PATH`. Keep Hermes' provider credentials in Hermes' own configuration; do not put them in the frontend or commit them.

Point a reverse proxy for the app's HTTPS hostname to this service. The app includes email/password sign-in, but recipe imports can still incur model usage, so keep the service behind a trusted reverse proxy and firewall. Do not expose the Hermes server port itself to the internet. Back up `data/recipetor.sqlite`.

Set `RECIPETOR_JWT_SECRET` to a long random value so login sessions survive restarts. If it is unset, the server generates one and stores it at `data/.jwt-secret`. Configure `SMTP_*` so verification and password reset codes can be delivered.

`RECIPETOR_ORIGIN` may be set to the exact public origin (for example `https://recipes.example.com`) to further restrict browser import requests. The API also limits imports to 10 per source connection per hour.
