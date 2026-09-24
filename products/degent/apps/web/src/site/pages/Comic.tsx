import { useState } from 'react';
import { useSite } from '../context';
import { useDocumentMeta } from '../lib/meta';
import { Cta, Notice, SectionTitle } from '../components/ui';
import { ComicCover, ComicTeaser, ordiscanUrl } from '../components/Sections';

/**
 * The on-chain comic, embedded from ord `/content/<id>` in a sandboxed iframe: scripts may run
 * (the comic is interactive) but with an opaque origin, no top navigation, no forms, no popups.
 */
export function Comic() {
  const { app, site } = useSite();
  useDocumentMeta({ title: 'The Comic', description: 'This is Gentlemen- The Comic: the Degent lore, inscribed on Bitcoin.' });
  const id = app.comicInscriptionId;
  const [tall, setTall] = useState(false);
  return (
    <div className="container stack page-top">
      <SectionTitle level={1} kicker="The Comic" title="This is Gentlemen- The Comic" sub="Learn the Degent Lore in this interactive comic book that is one of the biggest Bitcoin Ordinals in History." />
      {id ? (
        <section className="reader" aria-label="Comic reader">
          <div className="reader__bar">
            <span className="mono small mono--wrap">{id}</span>
            <div className="cta-row">
              <button type="button" className="cta cta--dark cta--sm" onClick={() => setTall((t) => !t)} aria-pressed={tall}>
                <span>{tall ? 'Standard height' : 'Taller reader'}</span>
              </button>
              <Cta href={site.ord.contentUrl(id)} variant="dark" className="cta--sm">
                Open full screen
              </Cta>
              <Cta href={ordiscanUrl(id)} variant="gradient" className="cta--sm">
                View in Ordiscan
              </Cta>
            </div>
          </div>
          <iframe
            className={`reader__frame ${tall ? 'is-tall' : ''}`}
            title="This is Gentlemen- The Comic (on-chain inscription)"
            src={site.ord.contentUrl(id)}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            loading="lazy"
          />
        </section>
      ) : (
        <section className="reader reader--placeholder" aria-label="Comic reader">
          <div className="reader__placeholder">
            <ComicCover />
            <Notice tone="todo" title="Comic inscription not configured">
              Set <code>VITE_COMIC_INSCRIPTION_ID</code> to the comic's inscription id to embed it here from ord
              {site.mode === 'demo' ? ' (demo mode never loads it: no network).' : '.'}
            </Notice>
          </div>
        </section>
      )}
      <ComicTeaser />
    </div>
  );
}
