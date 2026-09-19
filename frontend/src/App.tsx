import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { ThemeToggle } from './components/ThemeToggle';
import { Dashboard } from './pages/Dashboard';
import { ProductDetail } from './pages/ProductDetail';

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-bg font-sans text-body-md text-ink">
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-rule bg-surface px-space-lg">
          <div className="flex items-center gap-space-md">
            <Link to="/" className="text-headline-sm font-semibold tracking-tight text-ink">
              TrackScrape
            </Link>
            <span className="rounded border border-rule bg-bg px-2 py-0.5 font-mono text-mono-sm text-muted">
              cron 2h interval
            </span>
          </div>
          <ThemeToggle />
        </header>
        <main>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/product/:id" element={<ProductDetail />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
