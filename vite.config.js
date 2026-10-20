import fs from 'node:fs'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// ── File watching ────────────────────────────────────────────────────────────
// Linux caps inotify watches per user (fs.inotify.max_user_watches, 65536 here)
// and an editor with a large workspace can hold almost all of them — VS Code
// alone held ~54k on this machine. Vite then died at startup with
// "ENOSPC: System limit for number of file watchers reached", and under
// `concurrently -k` it took the bridge down with it. Three defences:
//   1. Only watch what the browser bundle is built from: the bridge (server/,
//      incl. the vendored TradingView library), tests and build output are
//      never imported by the app.
//   2. When the user's free watches are short, poll instead of using inotify —
//      HMR keeps working, at a negligible CPU cost for a tree this small.
//      FXORBIT_POLL=1 forces polling, FXORBIT_POLL=0 forbids it.
//   3. A watcher that still hits the limit logs a warning instead of crashing.
const WATCH_IGNORED = ['**/server/**', '**/tests/**', '**/dist/**', '**/coverage/**']
const MIN_FREE_WATCHES = 2000

// Watches currently held by processes of this user — the ones that count
// against max_user_watches. Returns null where this cannot be read (not Linux).
function freeInotifyWatches() {
  try {
    const max = Number(fs.readFileSync('/proc/sys/fs/inotify/max_user_watches', 'utf8'))
    const uid = process.getuid?.()
    let used = 0
    for (const pid of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue
      try {
        if (uid != null && fs.statSync(`/proc/${pid}`).uid !== uid) continue
        for (const fd of fs.readdirSync(`/proc/${pid}/fdinfo`)) {
          const info = fs.readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8')
          if (!info.includes('inotify wd:')) continue
          for (const line of info.split('\n')) if (line.startsWith('inotify wd:')) used += 1
        }
      } catch { /* process exited or is not ours to read */ }
    }
    return Number.isFinite(max) ? max - used : null
  } catch {
    return null
  }
}

function shouldPoll() {
  if (process.env.FXORBIT_POLL === '1') return true
  if (process.env.FXORBIT_POLL === '0' || process.platform !== 'linux') return false
  const free = freeInotifyWatches()
  if (free == null || free >= MIN_FREE_WATCHES) return false
  console.warn(
    `[vite] Only ${free} inotify watches are free (an editor is holding the rest) — `
    + 'watching by polling instead. To give Vite native watching back, raise the limit: '
    + 'sudo sysctl fs.inotify.max_user_watches=524288',
  )
  return true
}

// Vite attaches no 'error' listener to its watcher, so one ENOSPC is an
// uncaught 'error' event that kills the process.
const survivableWatcher = {
  name: 'fxorbit:survivable-watcher',
  configureServer(server) {
    let warned = false
    server.watcher.on('error', (err) => {
      if (warned) return
      warned = true
      server.config.logger.warn(
        `[vite] File watching is degraded (${err.code ?? err.message}) — some edits may need a manual reload. `
        + 'Restart with FXORBIT_POLL=1 npm run dev, or raise fs.inotify.max_user_watches.',
      )
    })
  },
}

// https://vite.dev/config/
export default defineConfig(({ command }) => {
  const usePolling = command === 'serve' && shouldPoll()
  return {
    plugins: [react(), survivableWatcher],
    // Bind the IPv4 loopback as well: on the default 'localhost' Vite answers only
    // on ::1 here, so a client that resolves localhost to 127.0.0.1 gets refused
    // mid-page-load and ends up with a half-styled app. strictPort makes a second
    // `npm run dev` fail loudly instead of silently hopping to 5174 and shadowing
    // this one (which is how a stale instance once hid the bridge).
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      watch: { ignored: WATCH_IGNORED, ...(usePolling ? { usePolling: true, interval: 300 } : {}) },
    },
  }
})
