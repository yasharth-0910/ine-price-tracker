# INE Price Tracker (TrackScrape)

An automated price and stock telemetry tracker for INE's mock storefront at [demo.inelabteamdev.com](https://demo.inelabteamdev.com). Users search the store catalogue mirror, track products, and the system scrapes prices and stock status on a 2-hour cron daemon with honest per-attempt telemetry, price comparison anchoring, and alert notifications.

| Deployment | URL |
|---|---|
| **Live Frontend** | [ine-assignment.yasharth.xyz](https://ine-assignment.yasharth.xyz) |
| **Backend API** | [ine-price-tracker.onrender.com](https://ine-price-tracker.onrender.com) |
| **GitHub Repository** | [github.com/yasharth-0910/ine-price-tracker](https://github.com/yasharth-0910/ine-price-tracker) |

---

## System Architecture

TrackScrape separates catalogue and metadata discovery (lightweight plain HTTP) from the anti-bot price reveal path (automated Playwright browser).

```mermaid
flowchart TD
    subgraph Scheduled & Manual Execution
        CronAction[GitHub Actions Cron / Scheduled Scraper]
        ManualRun[Manual / Headed Run Runner]
    end

    subgraph Target Storefront [INE Mock Storefront]
        StoreWASM["/api/challenge (WASM Proof-of-Work)"]
        StoreLayout["/api/layout (Selector Rotation & Classes)"]
        StoreCat["/api/catalog & /api/product/{id}"]
    end

    subgraph Core Engine [Scrape Engine & Worker]
        HTTPFetcher[HTTP Fetcher - undici / cheerio]
        PlaywrightFetcher[Browser Fetcher - Playwright Chromium]
        RetryLadder[Exponential Backoff Retry Ladder: 1s, 3s, 9s + Jitter]
        Validator[Price & Stock Normalizer & Invariant Validator]
    end

    subgraph Data & Storage [Supabase PostgreSQL]
        DB[(Supabase Postgres DB)]
        ProductsTable[(products)]
        PriceHistory[(price_history)]
        ScrapeLogs[(scrape_logs)]
        RunsTable[(scrape_runs)]
        AlertsTable[(alerts)]
        CatalogMirror[(store_catalog)]
    end

    subgraph Web Application Layer
        ExpressAPI[Express API Service on Render]
        ReactApp[React 18 + Vite + Tailwind Dashboard on Vercel]
    end

    CronAction -->|Executes headless| PlaywrightFetcher
    ManualRun -->|Executes headed / once| PlaywrightFetcher
    HTTPFetcher -->|Mirror 1000 items| StoreCat
    PlaywrightFetcher -->|Mouse Sweep & Solve| StoreWASM
    PlaywrightFetcher -->|Fetch active selector| StoreLayout
    PlaywrightFetcher --> RetryLadder
    RetryLadder --> Validator
    Validator -->|Validated Success Only| PriceHistory
    Validator -->|Every Attempt Recorded| ScrapeLogs
    Validator --> RunsTable
    Validator --> AlertsTable
    HTTPFetcher --> CatalogMirror

    ExpressAPI <--> DB
    ReactApp <-->|REST API + Telemetry| ExpressAPI
```

---

## Storefront Anti-Bot Handling & Scrape Sequence

The storefront implements multiple anti-scraping defenses:
1. **WASM Proof-of-Work**: Price data sits behind an interactive WebAssembly challenge at `/api/challenge`.
2. **Mouse Interaction Gate**: The reveal button requires simulated human mouse movement across the interaction gate before activating.
3. **Rotating Decoys**: The rendered DOM contains hidden decoy elements (`.price-value`, `[data-price]`) holding wrong prices scaled by $0.6\times$ to $1.3\times$. The true price is rendered exclusively inside the dynamic class name provided by `/api/layout`.
4. **Number Formatting Variants**: Prices render across 6 randomized formats (Unicode fullwidth digits, zero-width spaces, lakh grouping, and comma separators).

```mermaid
sequenceDiagram
    autonumber
    participant Runner as Scrape Worker
    participant Browser as Playwright Browser
    participant Store as INE Storefront
    participant DB as Supabase Postgres

    Runner->>Store: GET /api/layout (Fetch dynamic price selector & layout variant)
    Store-->>Runner: Return active class (.pv-q9) + cache TTL

    Runner->>Browser: Navigate to /product/{id}
    Browser->>Store: Request Page & Assets
    Browser->>Browser: Run WASM challenge worker (/api/challenge)
    
    Runner->>Browser: Move cursor across interaction gate (simulate human path)
    Runner->>Browser: Click 'Reveal price' button
    
    Store-->>Browser: HTTP 200 with verified price payload
    Browser->>Browser: Render price into dynamic class (.pv-q9)
    
    Runner->>Browser: Extract text from layout.classes.priceValue
    Runner->>Runner: Normalise Unicode digits, spaces, and currency symbols
    Runner->>Runner: Validate price > 0, price < 1M, valid stock enum

    alt Validation Succeeded
        Runner->>DB: INSERT into price_history (price, stock, source, layout_rev)
        Runner->>DB: INSERT into scrape_logs (status: 'success', duration, http_status: 200)
    else Verification Failed / Timeout / 5xx
        Runner->>Runner: Trigger exponential retry (attempt 1 -> 2 -> 3)
        Runner->>DB: INSERT into scrape_logs (status: 'retried'/'failed', error_code)
    end
```

---

## Database Entity Relationships

```mermaid
erDiagram
    PRODUCTS ||--o{ PRICE_HISTORY : "tracks"
    PRODUCTS ||--o{ SCRAPE_LOGS : "logs attempts"
    PRODUCTS ||--o{ ALERTS : "triggers"
    SCRAPE_RUNS ||--o{ SCRAPE_LOGS : "contains"
    
    PRODUCTS {
        uuid id PK
        text source_product_id UK
        text name
        text url
        text category
        boolean tracking_enabled
        int scrape_interval_mins
        timestamp last_success_at
        int consecutive_failures
        int last_layout_revision
        boolean layout_alert
        timestamp created_at
    }

    PRICE_HISTORY {
        bigserial id PK
        uuid product_id FK
        numeric price
        varchar currency
        varchar stock
        int stock_qty
        text extraction_source
        int layout_revision
        int layout_variant
        boolean anomalous
        timestamp scraped_at
    }

    SCRAPE_LOGS {
        bigserial id PK
        uuid product_id FK
        uuid run_id FK
        int attempt_no
        varchar status
        int http_status
        varchar error_code
        text error_message
        int duration_ms
        timestamp created_at
    }

    SCRAPE_RUNS {
        uuid id PK
        varchar trigger
        timestamp started_at
        timestamp finished_at
        int products_total
        int succeeded
        int failed
        int skipped
        int slowest_attempt_ms
    }

    STORE_CATALOG {
        int id PK
        text slug
        text name
        text brand
        text category
        text sku
        boolean missing
        timestamp last_seen_at
    }

    ALERTS {
        uuid id PK
        uuid product_id FK
        varchar kind
        text old_value
        text new_value
        boolean seen
        timestamp created_at
    }
```

---

## Hard Invariants & Reliability Rules

1. **Clean Price History**: `price_history` receives a row only when a scrape fully succeeds and passes validation. Failed attempts write strictly to `scrape_logs` and never insert zeroes, nulls, or placeholders.
2. **Honest Per-Attempt Logging**: Every attempt is preserved. A product that succeeded on attempt 3 is distinct in the logs from one that succeeded on attempt 1.
3. **Strict Decoy Avoidance**: The parser reads only the dynamic selector defined in `/api/layout` and enforces a deny-list against `.price-value` and `[data-price]`.
4. **Idempotency & Cooldown**: A product scraped within $0.75\times$ of its interval (e.g. 90 minutes on the 2h default) is logged as `skipped_recent` to prevent duplicate writes during overlapping triggers.

---

## Local Development & Setup

### Prerequisites
- Node.js 20+
- PostgreSQL 15+ (or local database)
- Playwright Chromium browser

### 1. Database Setup
```bash
# Create local Postgres database
createdb ine_local

# Apply schema & migrations
psql -d ine_local -f db/schema.sql
for m in db/migrations/*.sql; do psql -d ine_local -f "$m"; done
```

### 2. Backend Setup
```bash
cd backend
npm install
npx playwright install chromium

# Configure environment
cp .env.example .env
# Set DATABASE_URL=postgres://localhost:5432/ine_local
# Set CRON_SECRET=your_secret
# Set CORS_ORIGINS=http://localhost:5173

# Mirror catalogue & run verification harness
npm run crawl           # Crawls store items 1..1000 into store_catalog
npm run verify:scrape   # Runs 12/12 fault-injection test suite

# Start API server
npm run dev             # Server running on http://localhost:4000
```

### 3. Frontend Setup
```bash
cd ../frontend
npm install

cp .env.example .env.local
# Set VITE_API_URL=http://localhost:4000

npm run dev             # Vite running on http://localhost:5173
```

---

## NPM Scripts

### Backend (`/backend`)
| Script | Command | Purpose |
|---|---|---|
| `npm run dev` | `tsx watch src/index.ts` | Start backend API with hot reload |
| `npm run verify:scrape` | `tsx scripts/verify-scrape.ts` | Run 12-case fault-injection harness against fake store |
| `npm run scrape:headed` | `tsx scripts/headed.ts` | Run Playwright in visible headed mode for recordings |
| `npm run scrape:cron` | `tsx scripts/scrape-cron.ts` | Run full batch scrape across all tracked products |
| `npm run crawl` | `tsx scripts/catalog-crawl.ts` | Mirror all 1,000 store catalogue items into `store_catalog` |
| `npm run typecheck` | `tsc --noEmit` | Validate backend TypeScript types |

### Frontend (`/frontend`)
| Script | Command | Purpose |
|---|---|---|
| `npm run dev` | `vite` | Start local Vite development server |
| `npm run build` | `tsc -b && vite build` | Typecheck and build production bundle |
| `npm run typecheck` | `tsc --noEmit` | Validate frontend TypeScript types |

---

## Environment Variables

### Backend
| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string (`prepare: false` configured for Supabase transaction pooler). |
| `CRON_SECRET` | Yes | Shared authorization secret passed in `x-cron-secret` header. |
| `CORS_ORIGINS` | Yes | Comma-separated list of allowed frontend origins (e.g. `https://ine-assignment.yasharth.xyz`). |
| `STORE_BASE_URL` | No | Target store URL (defaults to `https://demo.inelabteamdev.com`). |
| `PORT` | No | Port for Express server (defaults to `4000`). |

### Frontend
| Variable | Required | Description |
|---|---|---|
| `VITE_API_URL` | Yes | Base URL of the backend API (e.g. `https://ine-price-tracker.onrender.com`). |

---

## Deployment Details

- **Frontend**: Deployed to Vercel via Vercel CLI (`vercel --prod`).
- **Backend API**: Deployed as a web service on Render.
- **Scheduled Scrapes**: Scheduled every 2 hours using GitHub Actions (`.github/workflows/scrape.yml`) with automated concurrency locking and direct writes to Supabase.
- **Continuous Integration**: `.github/workflows/ci.yml` runs typechecks, production builds, and the 12-case Playwright fault-injection harness on every pull request and push to `main`.
