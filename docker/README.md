# Database in Docker

The project's PostgreSQL, containerized. `docker-compose.yml` (repo root) runs
PostgreSQL 17 as the container `fxorbit-db`, seeded on first boot from
[`init/01-fxorbit.sql`](init/01-fxorbit.sql) — a snapshot of the live `fxorbit`
database taken 2026-10-21 (123 trades, 852 news items).

## Run it

```bash
docker compose up -d
docker compose ps            # wait for "healthy"
```

No Docker runtime on macOS? The lightest fully-CLI stack is Colima:

```bash
brew install colima docker docker-compose
colima start                 # boots the Linux VM docker runs in
docker compose up -d
```

## Connect

```
postgres://fxorbit@localhost:5433/fxorbit
```

- Host port **5433**, so it never fights a PostgreSQL that already owns
  localhost:5432. Both can run side by side.
- The port is bound to **127.0.0.1 only** — same loopback-only posture as the
  bridge server.
- `POSTGRES_HOST_AUTH_METHOD=trust` means no password, mirroring the Homebrew
  default this container replaces. That is safe **only** because of the
  loopback binding; the binding and the trust auth must change together.

Point the bridge at the container:

```bash
DATABASE_URL='postgres://fxorbit@localhost:5433/fxorbit' npm run dev
```

Or to make it the default without an env var every time, switch the compose
port to `127.0.0.1:5432:5432` after stopping the other PostgreSQL
(`brew services stop postgresql@17`) — then the app's built-in default
`DATABASE_URL` works unchanged.

## Data lifecycle

- First `up` only: the seed script runs on an empty volume and is never
  re-read afterwards.
- `docker compose down` — stop, data survives in the `fxorbit-pgdata` volume.
- `docker compose down -v` — stop **and erase** the data; the next `up`
  reseeds from the snapshot.

## Refreshing the snapshot

To capture the current live database into the seed again:

```bash
pg_dump --no-owner --no-privileges postgres://<user>@localhost:5432/fxorbit \
  > docker/init/01-fxorbit.sql
```

(On this machine the live database is Homebrew PostgreSQL 17, user
`tahabangash`.) The seed is plain SQL — review it before committing, the same
way you would any data file.
