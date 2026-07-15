interface PlaceholderPageProps {
  module: string;
  title: string;
  terms: string;
}

export function PlaceholderPage({ module, title, terms }: PlaceholderPageProps) {
  return (
    <main className="page-content placeholder-page">
      <header className="page-heading">
        <span>{module}</span>
        <h1>{title}</h1>
      </header>
      <div className="placeholder-structure" aria-hidden="true">
        <span /><span /><span /><span />
      </div>
      <p>{terms}</p>
    </main>
  );
}
