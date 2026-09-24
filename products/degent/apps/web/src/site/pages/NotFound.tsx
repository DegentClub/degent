import { useDocumentMeta } from '../lib/meta';
import { Cta, SectionTitle } from '../components/ui';

export function NotFound() {
  useDocumentMeta({ title: 'Page not found' });
  return (
    <div className="container narrow stack page-top center">
      <SectionTitle level={1} kicker="404" title="This room is members only" sub="We could not find that page." />
      <div className="cta-row cta-row--center">
        <Cta to="/">Back to the lobby</Cta>
        <Cta to="/collection" variant="dark">
          The Collection
        </Cta>
      </div>
    </div>
  );
}
