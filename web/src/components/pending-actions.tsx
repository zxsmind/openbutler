import { useState } from 'react';
import type { ApprovalRequest, PendingQuestion } from '../types.js';
import { Button } from './ui.js';

export function PendingActions({
  approval,
  question,
  onApprove,
  onAnswer,
}: {
  approval?: ApprovalRequest | null;
  question?: PendingQuestion | null;
  onApprove: (decision: 'allow' | 'deny' | 'always') => Promise<void>;
  onAnswer: (answer: string | null) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const act = async (action: () => Promise<void>) => {
    if (pending) return;
    setPending(true);
    try {
      await action();
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      {approval ? (
        <section className="approval" aria-label="Approval required">
          <strong>Approval required</strong>
          <span className="approval-tool">{approval.toolName}</span>
          <p>{approval.summary || approval.reason}</p>
          {approval.detail ? <pre className="code">{approval.detail}</pre> : null}
          <div className="approval-actions">
            <Button variant="primary" disabled={pending} onClick={() => void act(() => onApprove('allow'))}>
              Allow once
            </Button>
            <Button disabled={pending} onClick={() => void act(() => onApprove('always'))}>
              Always allow
            </Button>
            <Button variant="danger" disabled={pending} onClick={() => void act(() => onApprove('deny'))}>
              Deny
            </Button>
          </div>
        </section>
      ) : null}
      {question ? (
        <section className="approval question" aria-label="Question">
          <strong>{question.question}</strong>
          <div className="approval-actions">
            {question.options?.map((option) => (
              <Button disabled={pending} key={option} onClick={() => void act(() => onAnswer(option))}>
                {option}
              </Button>
            ))}
            <Button disabled={pending} onClick={() => void act(() => onAnswer(null))}>
              Skip
            </Button>
          </div>
        </section>
      ) : null}
    </>
  );
}
