import { useEffect, useState } from 'react';
import { BrowserRouter, Link, NavLink, Route, Routes } from 'react-router-dom';
import { ThemeToggle } from './components/ThemeToggle';
import { AlertsBell } from './components/AlertsBell';
import { Dashboard } from './pages/Dashboard';
import { ProductDetail } from './pages/ProductDetail';
import { Runs } from './pages/Runs';
import { RunStrip } from './components/RunStrip';
import { api, type Run } from './lib/api';

function NavItem({ to, label }: { to: string; label: string }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className={({ isActive }) =>
        'flex items-center gap-1.5 rounded px-2.5 py-1 font-mono text-[12px] transition-colors ' +
        (isActive ? 'border border-rule bg-bg font-medium text-ink' : 'text-muted hover:bg-surface-hover hover:text-ink')
      }
    >
      <span>{label}</span>
    </NavLink>
  );
}

function LiveClock() {
  const [timeStr, setTimeStr] = useState(() => new Date().toUTCString().slice(17, 25));

  useEffect(() => {
    const timer = setInterval(() => {
      setTimeStr(new Date().toUTCString().slice(17, 25));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  return <span>UTC: <span className="text-ink">{timeStr}</span></span>;
}

export default function App() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [productCount, setProductCount] = useState<number>(0);

  useEffect(() => {
    void api.listRuns().then((r) => setRuns(r.runs)).catch(() => {});
    void api.listProducts().then((p) => setProductCount(p.count)).catch(() => {});
  }, []);

  return (
    <BrowserRouter>
      <div className="flex min-h-screen flex-col bg-bg font-sans text-body-md text-ink antialiased">
        {/* 1. TOP SLIM TELEMETRY & CONTROL BAR (h-12) */}
        <header className="sticky top-0 z-50 flex h-12 w-full shrink-0 select-none items-center justify-between border-b border-rule bg-surface px-3">
          {/* Left: Brand & Navigation */}
          <div className="flex items-center gap-3 sm:gap-4">
            <div className="flex items-center gap-2 border-r border-rule pr-3">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-ok" />
              <Link to="/" className="font-sans text-[14px] font-semibold tracking-tight text-ink">
                TrackScrape
              </Link>
              <span className="rounded border border-rule bg-bg px-1.5 py-0.2 font-mono text-[9px] uppercase tracking-wider text-muted">
                v2.4
              </span>
            </div>

            <nav className="flex items-center gap-1 font-mono text-[12px]">
              <NavItem to="/" label="Dashboard" />
              <NavItem to="/runs" label="Scrape Log" />
            </nav>

            {/* Cron status pill */}
            <div className="hidden items-center gap-2 border-l border-rule pl-3 font-mono text-[11px] text-muted md:flex">
              <span className="flex items-center gap-1 rounded border border-ok/30 bg-ok/10 px-1.5 py-0.5 text-[10px] text-ok">
                <span className="h-1.5 w-1.5 rounded-full bg-ok" />
                cron 2h interval
              </span>
            </div>
          </div>

          {/* Right: Actions, Alerts, Theme */}
          <div className="flex items-center gap-2">
            <AlertsBell />
            <div className="h-3.5 w-px bg-rule" />
            <ThemeToggle />
          </div>
        </header>

        {/* 2. 72-HOUR SYSTEM RUN STRIP */}
        <RunStrip
          runs={runs}
          productCount={productCount}
          nextRun={runs.length ? new Date(new Date(runs[0]!.started_at).getTime() + 120 * 60 * 1000) : null}
          lastRunMs={runs.find((r) => r.finished_at) ? new Date(runs[0]!.finished_at!).getTime() - new Date(runs[0]!.started_at).getTime() : null}
        />

        {/* 3. MAIN WORKBENCH CONTENT */}
        <main className="w-full flex-1 bg-bg p-3">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/product/:id" element={<ProductDetail />} />
            <Route path="/runs" element={<Runs />} />
          </Routes>
        </main>

        {/* 4. SLIM STATIC BOTTOM STATUS BAR (h-7) */}
        <footer className="flex h-7 w-full shrink-0 select-none items-center justify-between border-t border-rule bg-bg px-3 font-mono text-[11px] text-muted">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-ok" />
              <span className="text-ink">Database:</span>
              <span>Supabase Postgres</span>
            </div>
            <div className="hidden h-3 w-px bg-rule sm:block" />
            <div className="hidden sm:block">
              Cadence: <span className="text-ink">2h scheduled</span>
            </div>
            <div className="hidden h-3 w-px bg-rule sm:block" />
            <div className="hidden sm:block">
              Targets: <span className="text-ok">{productCount} active</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1 text-ok">
              ✓ Storage synced
            </span>
            <div className="h-3 w-px bg-rule" />
            <LiveClock />
          </div>
        </footer>
      </div>
    </BrowserRouter>
  );
}
