/** `#/comic`, `#/about`, `#/manifesto`: the pages whose copy was not (fully) captured, as marked placeholders. */
import { useMint } from '../flow/context';
import { Link } from '../components/Link';
import { ComicSection, PageHero, TodoCopy } from '../components/Sections';
import { SOCIAL } from '../lib/site';

export function Comic() {
  const { app } = useMint();
  return (
    <div className="screen screen--site screen--comic">
      <ComicSection headingLevel={1} />
      <TodoCopy>
        <p>
          The live site shows the comic's cover and links out to it; its inscription id, the Ordiscan link and the reader's
          chapter list were not captured. Set <code>VITE_COMIC_INSCRIPTION_ID</code> to embed the cover from the chain and
          enable “View in Ordiscan”
          {app.comicInscriptionId ? ' (configured for this build)' : ''}. Reader controls come with the inscription.
        </p>
      </TodoCopy>
      <p className="small muted">
        Meanwhile the lore lives with the community on <a href={SOCIAL.x} target="_blank" rel="noopener noreferrer">X</a> and{' '}
        <a href={SOCIAL.telegram} target="_blank" rel="noopener noreferrer">
          Telegram
        </a>
        .
      </p>
    </div>
  );
}

function Placeholder({ pill, title, what }: { pill: string; title: string; what: string }) {
  return (
    <div className="screen screen--site screen--placeholder" data-placeholder="true">
      <PageHero pill={pill} title={title} wall={false} />
      <TodoCopy>
        <p>
          <strong>Placeholder page.</strong> The {what} copy was not captured from the live degent.club site, and this rebuild
          does not invent it (site spec). The club supplies the text; until then this page stays a placeholder.
        </p>
      </TodoCopy>
      <div className="row">
        <Link to={{ name: 'collection', page: 1, perPage: null, item: null }} className="btn btn--dark">
          The Collection
        </Link>
        <Link to={{ name: 'mint-process' }} className="btn btn--dark">
          Mint Process
        </Link>
      </div>
    </div>
  );
}

export function About() {
  return <Placeholder pill="About" title="About" what="About page" />;
}

export function Manifesto() {
  return <Placeholder pill="Manifesto" title="Manifesto" what="Manifesto" />;
}
