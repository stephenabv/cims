import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
      <p className="text-sm font-semibold text-brand-700">404</p>
      <h1 className="text-2xl font-bold">Page not found</h1>
      <Link to="/app" className="text-sm font-medium text-brand-700 hover:underline">
        Go to home
      </Link>
    </div>
  );
}
