# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and Oxlint's TypeScript related rules in your project.
# fx_orbit

## Running it

```bash
npm run dev     # Vite on :5173 + TradingView bridge on :5178
```

Run one dev stack at a time — both ports are fixed:

- The browser talks to the bridge on `:5178` (Settings → TradingView backend URL must match). If a second `npm run dev` starts while that port is taken, the bridge now says so, stays idle and retries every 5s instead of crashing: under `concurrently -k` a dead bridge also kills Vite, which leaves the page half-rendered.
- `TV_PORT=5179 npm run dev` moves the bridge, but the app keeps looking at `:5178` until you change the backend URL in Settings.
- The badge at the top right reports where the prices actually come from: `LIVE` = the bridge is streaming, `SIM` = simulated prices (hover it for the reason).
- Postgres on `:5432` (db `fxorbit`) is optional; the bridge keeps serving without it and just skips persistence.

To see what holds a port: `lsof -nP -iTCP:5178 -sTCP:LISTEN`.
