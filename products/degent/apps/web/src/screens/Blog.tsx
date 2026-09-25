/**
 * `#/blog` ("Degent Chronicles") and `#/blog/:slug`. Posts are Markdown files in `content/blog/`,
 * bundled at build time (`src/lib/blog.ts`); slugs keep the WordPress ones.
 */
import { Frame } from '../components/Frame';
import { Link } from '../components/Link';
import { PageHero } from '../components/Sections';
import { Badge } from '../components/ui';
import { POSTS, findPost, type BlogPost } from '../lib/blog';
import { renderMarkdown } from '../lib/markdown';
import { COPY } from '../lib/site';

function PostMeta({ post }: { post: BlogPost }) {
  return (
    <p className="post__meta small">
      <time dateTime={post.date} className="mono">
        {post.date}
      </time>
      {post.author ? <> · {post.author}</> : null}
      {post.example ? (
        <>
          {' '}
          <Badge tone="warn">Example post</Badge>
        </>
      ) : null}
    </p>
  );
}

export function Blog({ posts = POSTS }: { posts?: readonly BlogPost[] }) {
  return (
    <div className="screen screen--site screen--blog">
      <PageHero
        pill="Blog"
        title={
          <>
            Degent <span className="accent">Chronicles</span>
          </>
        }
        sub={COPY.blogSub}
      />
      {posts.length === 0 ? <p className="muted">No posts yet.</p> : null}
      <ul className="postcards" aria-label="Posts">
        {posts.map((p) => (
          <li key={p.slug} className="postcard">
            <Link to={{ name: 'blog-post', slug: p.slug }} className="postcard__link">
              <Frame src={p.cover} alt={p.cover ? `Cover: ${p.title}` : `No cover image for ${p.title}`} plaque={p.example ? 'EXAMPLE' : 'CHRONICLE'} />
              <span className="postcard__title">{p.title}</span>
            </Link>
            <PostMeta post={p} />
            {p.excerpt ? <p className="postcard__excerpt">{p.excerpt}</p> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function BlogPostPage({ slug }: { slug: string }) {
  const post = findPost(slug);
  if (!post) {
    return (
      <div className="screen screen--site">
        <div className="screen-heading">
          <p className="kicker">Blog</p>
          <h1 tabIndex={-1}>No such chronicle.</h1>
          <p className="lede">
            Nothing is published at <code className="mono">{slug}</code>. <Link to={{ name: 'blog' }}>All posts</Link>.
          </p>
        </div>
      </div>
    );
  }
  return (
    <article className="screen screen--site post">
      <p className="crumbs">
        <Link to={{ name: 'blog' }}>← Degent Chronicles</Link>
      </p>
      <header className="screen-heading">
        <h1 tabIndex={-1}>{post.title}</h1>
        <PostMeta post={post} />
      </header>
      {post.cover ? <img className="post__cover" src={post.cover} alt={`Cover: ${post.title}`} /> : null}
      <div className="prose">{renderMarkdown(post.body)}</div>
    </article>
  );
}
