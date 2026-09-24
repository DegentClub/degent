import { DEGENT_RULES } from '@bsh/degent-mint-sdk';

const CHECK_LABEL = { automated: 'checked by code', vision: 'checked by eye', both: 'code + eye' } as const;

/** The five published Degent rules (`DEGENT_RULES`, mint-sdk) as pill badges. */
export function RulesPills({ label = 'Degent rules' }: { label?: string }) {
  return (
    <ul className="pills" aria-label={label}>
      {DEGENT_RULES.map((r) => (
        <li key={r.id} className="pill" data-testid={`rule-${r.id}`} title={r.text}>
          <span className="pill__title">{r.title}</span>
          <span className="pill__text">{r.text}</span>
          <span className="pill__check">{CHECK_LABEL[r.check]}</span>
        </li>
      ))}
    </ul>
  );
}
