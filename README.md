# Susej

Susej is a social-commerce marketplace that combines Instagram-style product discovery, OLX-style peer-to-peer selling, and Facebook-style communities in one mobile experience.

The repository contains the buyer and seller mobile app, the Susej admin/API surface, and the optional FastAPI service used by the legacy content and integration lanes.

## What is included

| Surface | Technology | Purpose |
| --- | --- | --- |
| `Frontend/` | React Native, Expo SDK 57, Expo Router, TypeScript | Buyer and seller mobile journeys |
| `susej-admin-panel/` | Next.js 16 App Router, Prisma 7, PostgreSQL | Admin dashboard and marketplace API |
| `backend/` | FastAPI, Pydantic, Uvicorn | Legacy API, auth/content integrations, and Python services |
| `assets/` and `Frontend/assets/` | Images and native assets | App icons, splash assets, and product media |
| `susej-admin-panel/prisma/` | Prisma schema and migrations | Marketplace data model and migration history |
| `.github/`, `tools/`, `scripts/`, `harness/`, and `maestro/` | Automation and verification | CI, probes, test flows, and delivery tooling |

The admin/API is configured for PostgreSQL-compatible databases such as Neon. The admin database client intentionally fails loudly when `DATABASE_URL` is missing or is not a PostgreSQL connection string; it does not silently switch to SQLite.

## Product experience

Susej supports three connected experiences:

- **Buyers** discover product posts, search across people and products, follow sellers, join communities, chat, negotiate, track orders, and leave reviews.
- **Sellers** create product posts and storefronts, manage catalog and inventory, fulfill orders, request payouts, and run marketplace promotions.
- **Admins** manage users, sellers, products, orders, refunds, disputes, payouts, moderation, promotions, commission settings, and operational settings.

The mobile app is offline-first: local AsyncStorage state keeps the experience usable while server synchronization reconnects real data to the Next.js API.

## Requirements

- Node.js 20 or newer
- npm
- Python 3.10+ for the optional FastAPI service
- PostgreSQL or a Neon PostgreSQL connection for the admin/API
- Expo Go or an EAS-built mobile client for device testing

The repository root is a multi-surface workspace and does not provide a single `npm start` command. Run each surface from its own directory.

## Quick start

### 1. Start the admin/API

Create `susej-admin-panel/.env` from your deployment environment and set `DATABASE_URL` to the intended PostgreSQL database.

```bash
cd susej-admin-panel
npm ci
npx prisma generate
npx prisma migrate deploy
npx prisma db seed
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Review and back up the target database before running `prisma migrate deploy`. The seed is configuration-only: it provisions admin, taxonomy, shipping, coupon, site, and commission configuration, but it does not fabricate marketplace users, products, orders, or activity. Set `SUSEJ_SEED_ADMIN_PASSWORD` and `SUSEJ_SEED_ADMIN_2FA` in the local/admin environment before running the seed.

### 2. Start the mobile app

```bash
cd Frontend
npm ci
npm start
```

Scan the Expo QR code with Expo Go, or run one of the platform commands:

```bash
npm run android
npm run ios
npm run web
```

`Frontend/.npmrc` enables the legacy peer-dependency resolution required by the current Expo dependency set. Keep it when installing the mobile dependencies.

For a physical Android device, reverse the local development ports when needed:

```bash
adb reverse tcp:8081 tcp:8081
adb reverse tcp:3000 tcp:3000
```

### 3. Run the optional FastAPI service

```bash
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m pip install psycopg2-binary
python -m uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

Install `psycopg2-binary` when the service uses PostgreSQL. Without `DATABASE_URL`, the legacy Python data adapters can use their local SQLite fallback; production deployments should use the intended PostgreSQL database instead.

## Configuration

Never commit real credentials, `.env` files, API keys, database URLs, or signing secrets. The most important service variables are:

| Variable | Used by | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Admin/API, optional backend | PostgreSQL connection string |
| `JWT_SECRET` | Admin/API | Stable production session-signing secret |
| `APP_API_KEY` | App-facing API routes | Server-side shared key; must match the mobile key |
| `APP_API_KEY_PREVIOUS` | App-facing API routes | Optional key-rotation overlap |
| `EXPO_PUBLIC_APP_KEY` | Mobile app | Runtime-bundled app key; set through EAS/build environment |
| `SUSEJ_APP_KEY` | Local tools | Optional local alias for scripts that call app-key routes |
| `CLOUDINARY_URL` | Admin/API | Production image storage and uploads |
| `APP_PUBLIC_BASE_URL` or `NEXT_PUBLIC_APP_URL` | Admin/API | Public origin for stored media URLs |
| `EXPO_PUBLIC_API_BASE_URL` | Mobile app | API base URL bundled into Expo clients |
| `UNIHUB_TOKEN_SECRET` | FastAPI | Legacy service token secret |
| `AUTH_DEV_MODE` | FastAPI | Local-only development OTP mode; never enable publicly |
| `EXPO_PUBLIC_DEV_BYPASS` | Mobile app | Local-only development bypass; never enable in production |
| `SUSEJ_SEED_ADMIN_PASSWORD` | Admin seed | Local seed-time admin password; never commit |
| `SUSEJ_SEED_ADMIN_2FA` | Admin seed | Local seed-time 2FA code; never commit |
| `SUSEJ_ADMIN_ID`, `SUSEJ_ADMIN_PASSWORD`, `SUSEJ_ADMIN_2FA` | Local audit tools | Optional values for scripts in `tools/`; never commit |

The root `.env.example` is a starting template for the legacy Python lane. Current admin/API variables belong in the admin service environment; do not assume that one example file covers every hosted deployment.

## Verification commands

Run checks from the relevant subproject:

```bash
# Mobile
cd Frontend
npx tsc --noEmit
npm test -- --passWithNoTests

# Admin/API
cd ../susej-admin-panel
npx tsc --noEmit
npm run lint
npm run build

# Optional FastAPI lane
cd ../backend
python -m pytest tests -v
```

The mobile package has a `lint` script, but no `Frontend/eslint.config.*` file is currently checked in, so that command is not runnable until a flat ESLint configuration is added. The mobile typecheck and test commands above are the current verification path.

## Deployment model

- **Mobile:** Expo/EAS; native Android and iOS configuration lives in `Frontend/`.
- **Admin/API:** Vercel-compatible Next.js deployment with the `susej-admin-panel/` directory as the project root.
- **FastAPI:** Railway-compatible service using `backend/Procfile`; set the service root to `backend/`.
- **Database:** PostgreSQL/Neon for the current admin/API data path.

Do not treat local `localhost` services as the production stack. Validate hosted changes through the real hosted surface and the database migration state.

## Deployment handoff

Push the project essentials so a fresh clone can build and deploy:

- `Frontend/`, `backend/`, and `susej-admin-panel/` source code
- `package.json` and lockfiles for each JavaScript surface
- `Frontend/app.json`, `Frontend/eas.json`, and native configuration
- `susej-admin-panel/prisma/schema.prisma`, migrations, and seed configuration
- Deployment configuration such as `backend/Procfile` and the Vercel/Expo project files
- Shared assets, product images, migrations, and this README
- Sanitized examples such as `.env.example` with placeholders only

Keep these local and out of Git:

- Real `.env`, `.env.local`, and other secret-bearing environment files
- `AGENTS.md`, `CLAUDE.md`, and local agent/tool directories
- `node_modules/`, `.next/`, `.expo/`, caches, logs, and TypeScript build info
- Local databases, uploads, backups, generated APKs, and temporary probe files
- Audit docs, memory-bank state, evidence screenshots, SQL dumps, logs, and tool output
- Local setup/production plans and credential-bearing probe files

For a teammate, share the repository plus a variable-name checklist, not secret values. Enter production values directly in Railway, Vercel, Neon, Cloudinary, EAS, or the team password manager. If a local `.env` must be transferred, use an approved encrypted secret-sharing channel and rotate any value that was exposed.

## Repository hygiene

Generated dependencies, build output, caches, local databases, upload folders, temporary probe scripts, and local agent/tool files are excluded from Git. Keep local instruction files such as `AGENTS.md` on the developer machine; they are not required in a clean public repository. Never add generated APKs, secrets, logs, or local database files to a commit.

## Contributing

Keep changes scoped to the surface they affect, preserve existing platform conventions, and run the relevant typecheck, lint, build, and test commands before submitting. Review migrations and deployment configuration carefully, and never push credentials or private environment files.
