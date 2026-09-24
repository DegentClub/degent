import { useSite, copyVisible } from '../context';
import { useDocumentMeta } from '../lib/meta';
import { Cta, Notice, SectionTitle } from '../components/ui';

const PAGES = {
  manifesto: { title: 'Manifesto', kicker: 'Manifesto', blurb: 'What the Decentralized Gentlemen Club stands for.' },
  about: { title: 'About', kicker: 'About', blurb: 'Who we are and how the club began.' },
} as const;

/**
 * Manifesto / About. The live copy was not captured and must not be invented: until it ships
 * (`VITE_COPY_READY`), demo mode shows a clearly marked TODO(copy) placeholder and production hides
 * the pages from navigation and shows a short "coming soon" page on direct visits.
 */
export function CopyPage({ page }: { page: 'manifesto' | 'about' }) {
  const { app } = useSite();
  const p = PAGES[page];
  useDocumentMeta({ title: p.title, description: p.blurb });
  const visible = copyVisible(app, page);
  return (
    <div className="container stack page-top narrow">
      <SectionTitle level={1} kicker={p.kicker} title={p.title} sub={p.blurb} />
      {visible && !app.copyReady.has(page) ? (
        <Notice tone="todo" title="TODO(copy)">
          <p>
            The {p.title} copy from the live site has not been provided yet. This placeholder is shown in demo mode only; in production the page
            is hidden from navigation until <code>VITE_COPY_READY</code> includes <code>{page}</code>.
          </p>
          <p data-testid="todo-copy">TODO(copy): {p.title} text goes here. Do not invent it.</p>
        </Notice>
      ) : !visible ? (
        <p className="muted">This page is coming soon.</p>
      ) : (
        <Notice tone="todo" title="TODO(copy)">
          <p>Copy is marked ready but no text is wired in yet: add it to this component.</p>
        </Notice>
      )}
      <div className="cta-row">
        <Cta to="/collection" variant="dark">
          See the collection
        </Cta>
      </div>
    </div>
  );
}
