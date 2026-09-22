// A compact coach-card for the first-run walkthrough. It sits beside the real
// control for the current step, holds its own space in the layout, and carries
// a Skip that ends the walkthrough for good. One short sentence per step.

type Step = 1 | 2 | 3;

function message(step: Step, hasFollowup: boolean): string {
  if (step === 1) return "Create a space for the person you're remembering.";
  if (step === 2) return "Record your first answer in your own voice.";
  return hasFollowup
    ? "This is the question your telling opened. Answer it, or keep it on the map."
    : "Your first memory is saved. Answer the next question, or step away and come back.";
}

export function Walkthrough({
  step,
  onSkip,
  hasFollowup = false,
}: {
  step: Step;
  onSkip: () => void;
  hasFollowup?: boolean;
}) {
  return (
    <aside className="walkthrough" role="note" aria-label="Getting started">
      <p className="walkthrough-step">Step {step} of 3</p>
      <p className="walkthrough-text">{message(step, hasFollowup)}</p>
      <button className="btn btn-quiet walkthrough-skip" type="button" onClick={onSkip}>
        Skip
      </button>
    </aside>
  );
}
