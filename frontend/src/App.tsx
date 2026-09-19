import { BrowserRouter, Link, NavLink, Route, Routes } from 'react-router-dom';
import { ThemeToggle } from './components/ThemeToggle';
import { AlertsBell } from './components/AlertsBell';
import { Dashboard } from './pages/Dashboard';
import { ProductDetail } from './pages/ProductDetail';
import { Runs } from './pages/Runs';

function NavItem({ to, label }: { to: string; label: string }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className={({ isActive }) =>
        'rounded px-2.5 py-1 text-body-sm transition-colors ' +
        (isActive ? 'bg-surface-hover font-medium text-ink' : 'text-muted hover:text-ink')
      }
    >
      {label}
    </NavLink>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-bg font-sans text-body-md text-ink">
        <header className="sticky top-0 z-50 flex h-14 items-center justify-between gap-space-md border-b border-rule bg-surface px-4">
          <div className="flex min-w-0 items-center gap-space-md">
            <Link to="/" className="shrink-0 text-headline-sm font-semibold tracking-tight text-ink">
              TrackScrape
            </Link>
            <span className="hidden shrink-0 items-center gap-1.5 rounded border border-rule bg-bg px-2 py-0.5 font-mono text-mono-sm text-muted sm:inline-flex">
              <span className="h-1.5 w-1.5 rounded-full bg-ok" />
              cron 2h interval
            </span>
            <div className="hidden h-4 w-px bg-rule sm:block" />
            <nav className="flex items-center gap-1">
              <NavItem to="/" label="Dashboard" />
              <NavItem to="/runs" label="Scrape Log" />
            </nav>
          </div>
          <div className="flex items-center gap-space-md">
            <AlertsBell />
            <ThemeToggle />
          </div>
        </header>
        <main className="w-full bg-bg px-4 py-4">
          <div className="mx-auto flex max-w-[1400px] flex-col gap-4">
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/product/:id" element={<ProductDetail />} />
              <Route path="/runs" element={<Runs />} />
            </Routes>
          </div>
        </main>
      </div>
    </BrowserRouter>
  );
}
