import type { ReactNode } from 'react';

/**
 * A gold picture frame with a plaque (site spec "Visual identity": gold frames with a DEGEN plaque,
 * hard offset shadow). The image is square (Degent rule `square`); the plaque reads DEGENT by default.
 */
export function Frame({
  src,
  alt,
  plaque = 'DEGENT',
  size = 'grid',
  children,
}: {
  src: string | null;
  alt: string;
  plaque?: string;
  size?: 'grid' | 'large' | 'thumb';
  children?: ReactNode;
}) {
  return (
    <figure className={`frame frame--${size}`}>
      <div className="frame__mat">
        {src ? <img className="frame__img" src={src} alt={alt} loading="lazy" decoding="async" /> : <div className="frame__img frame__img--empty" role="img" aria-label={alt} />}
      </div>
      <figcaption className="frame__plaque">{plaque}</figcaption>
      {children}
    </figure>
  );
}
