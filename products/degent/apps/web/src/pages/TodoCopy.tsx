/**
 * `/manifesto` and `/about`: the live site's copy was not captured and the spec forbids inventing it, so these
 * pages are marked `TODO(copy)` until the club supplies the text (products/degent/docs/site-spec.md).
 */
import { CtaLink, useDocumentMeta } from '../site/components';

export function TodoCopyPage({ title, kicker }: { title: string; kicker: string }) {
  useDocumentMeta({ title: `${title} · degent.club` });
  return (
    <div className="page">
      <div className="page-head">
        <p className="badge-pill">{kicker}</p>
        <h1 tabIndex={-1}>{title}</h1>
      </div>
      <section className="card" aria-label={`${title} text`}>
        <p className="todo-copy">TODO(copy): the {title} text from the club. It was not captured from the live site and is not to be invented.</p>
      </section>
      <div className="row">
        <CtaLink to="/collection">See the collection</CtaLink>
        <CtaLink to="/mint" variant="dark">
          Mint a Degent
        </CtaLink>
      </div>
    </div>
  );
}

export function Manifesto() {
  return <TodoCopyPage title="Manifesto" kicker="The creed" />;
}

export function About() {
  return <TodoCopyPage title="About" kicker="The club" />;
}

export function NotFound() {
  useDocumentMeta({ title: 'Not found · degent.club' });
  return (
    <div className="page">
      <div className="page-head">
        <h1 tabIndex={-1}>Page not found</h1>
        <p className="lede">The page you asked for is not here.</p>
      </div>
      <div className="row">
        <CtaLink to="/">Home</CtaLink>
        <CtaLink to="/collection" variant="dark">
          The Collection
        </CtaLink>
      </div>
    </div>
  );
}
