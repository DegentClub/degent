import { Link } from '../router';
import { useSite } from '../context';
import { visiblePosts, findPost } from '../content';
import { renderMarkdown } from '../lib/markdown';
import { useDocumentMeta } from '../lib/meta';
import { gentlemanDataUrl } from '../lib/art';
import { safeUrl } from '../lib/markdown';
import { Hero, Notice, Pill } from '../components/ui';
import { ComicCover } from '../components/Sections';
import { NotFound } from './NotFound';
import type { Post } from '../lib/frontmatter';

function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/** Cover art: an image URL, or a built-in placeholder (`placeholder:fireworks|champagne|comic`). */
function Cover({ post }: { post: Post }) {
  if (post.cover.startsWith('placeholder:')) {
    const kind = post.cover.slice('placeholder:'.length);
    if (kind === 'comic') return <ComicCover />;
    if (kind === 'fireworks')
      return (
        <div className="cover-art cover-art--fireworks" role="img" aria-label="Placeholder cover: fireworks poster reading GO BIG OR GO HOME">
          <span>GO BIG OR GO HOME!</span>
        </div>
      );
    return <img src={gentlemanDataUrl(post.slug, { label: 'PLACEHOLDER' })} alt="Placeholder cover: a framed gentleman" />;
  }
  const src = safeUrl(post.cover);
  return src ? <img src={src} alt="" loading="lazy" /> : null;
}

export function Blog() {
  const { app } = useSite();
  useDocumentMeta({ title: 'Degent Chronicles', description: 'Stories from the blockchain, insights from the community, and updates from the Decentralized Gentlemen Club.' });
  const posts = visiblePosts(app.demo);
  return (
    <>
      <Hero
        kicker="Blog"
        title={
          <>
            Degent <span className="accent">Chronicles</span>
          </>
        }
        sub="Stories from the blockchain, insights from the community, and updates from the Decentralized Gentlemen Club."
        wall={[]}
      />
      <div className="container stack">
        {posts.length === 0 ? (
          <p className="muted center">No posts yet. Check back soon.</p>
        ) : (
          <ul className="posts" data-testid="posts">
            {posts.map((p) => (
              <li key={p.slug} className="post-card">
                <Link to={`/blog/${p.slug}`} className="post-card__a">
                  <div className="post-card__cover">
                    <Cover post={p} />
                  </div>
                  <div className="post-card__text">
                    <p className="post-card__meta">
                      <time dateTime={p.date}>{formatDate(p.date)}</time>
                      {p.draft ? <Pill tone="orange">Draft · placeholder</Pill> : null}
                    </p>
                    <h2>{p.title}</h2>
                    {p.excerpt ? <p>{p.excerpt}</p> : null}
                    <span className="post-card__more">Read more →</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

export function BlogPost({ slug }: { slug: string }) {
  const { app } = useSite();
  const post = findPost(slug, app.demo);
  useDocumentMeta(post ? { title: post.title, description: post.excerpt } : { title: 'Not found' });
  if (!post) return <NotFound />;
  return (
    <article className="container narrow stack page-top post">
      <p>
        <Link to="/blog">← Degent Chronicles</Link>
      </p>
      <header>
        <p className="post-card__meta">
          <time dateTime={post.date}>{formatDate(post.date)}</time>
          {post.draft ? <Pill tone="orange">Draft · placeholder</Pill> : null}
        </p>
        <h1 tabIndex={-1}>{post.title}</h1>
        <span className="rule" aria-hidden="true" />
      </header>
      {post.draft ? <Notice tone="todo" title="Placeholder post (draft)">Shown in demo mode only. Replace it with the imported WordPress post.</Notice> : null}
      <div className="post__cover">
        <Cover post={post} />
      </div>
      <div className="prose">{renderMarkdown(post.body)}</div>
    </article>
  );
}
