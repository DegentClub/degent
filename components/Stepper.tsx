'use client';

import type { MintState } from '@/lib/mint-machine';

export const STEPS = ['Connect', 'Create', 'Review', 'Sign', 'Track'] as const;
export type StepName = (typeof STEPS)[number];

/** Which step of the flow the user is on, derived purely from machine state. */
export function currentStep(state: MintState): number {
  if (state.phase === 'submitted' || state.phase === 'confirmed') return 4;
  if (state.phase === 'paying') return 3;
  if (!state.wallet) return 0;
  if (!state.file || !state.file.valid || !state.recipient) return 1;
  return 2;
}

export default function Stepper({ state }: { state: MintState }) {
  const active = currentStep(state);
  return (
    <nav aria-label="Minting progress" className="degent-card !py-4">
      <ol className="flex items-center justify-between gap-2">
        {STEPS.map((label, index) => {
          const status = index < active ? 'done' : index === active ? 'current' : 'todo';
          return (
            <li
              key={label}
              className="flex flex-1 items-center gap-2 last:flex-none"
              aria-current={status === 'current' ? 'step' : undefined}
            >
              <span
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-xs font-bold ${
                  status === 'done'
                    ? 'border-degent-green bg-degent-green text-degent-dark'
                    : status === 'current'
                      ? 'border-degent-green text-degent-green'
                      : 'border-degent-border text-degent-muted'
                }`}
              >
                {status === 'done' ? <i className="fas fa-check" aria-hidden="true"></i> : index + 1}
              </span>
              <span
                className={`hidden text-sm sm:inline ${status === 'todo' ? 'text-degent-muted' : 'text-white'}`}
              >
                {label}
              </span>
              <span className="sr-only">
                {label}: {status === 'done' ? 'completed' : status === 'current' ? 'current step' : 'not started'}
              </span>
              {index < STEPS.length - 1 && (
                <span
                  aria-hidden="true"
                  className={`mx-1 h-px flex-1 ${index < active ? 'bg-degent-green' : 'bg-degent-border'}`}
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
