import { Button } from "./Button";
import { Card } from "./Card";

export type StateScreenVariant = "solid" | "dashed";

interface StateScreenAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

/**
 * The shared shape behind every full-screen non-content state (error, offline,
 * empty — issue #170): a headline in the display face saying what the
 * situation is, one sentence saying what the household can do about it, and
 * exactly one action — never two competing ones (a broken state has exactly
 * one meaningful way out). `solid` is the "something broke" tone (error,
 * offline); `dashed` is "nothing broke, there's just nothing here yet" (empty
 * states), reusing the lighter dashed card the reference already uses for
 * `/lista`.
 *
 * `reference` is the only place a raw error code is allowed to render, and even
 * then only as a quiet, unheaded line below the action — never the server's raw
 * message, which never reaches this component at all (see errorPresentation.ts).
 */
export function StateScreen({
  variant,
  role,
  title,
  body,
  action,
  reference,
}: {
  variant: StateScreenVariant;
  /** "alert" for a genuine failure, "status" for offline/empty — matches the
   *  urgency screen readers should announce it with. */
  role: "alert" | "status";
  title: string;
  body: string;
  action: StateScreenAction;
  reference?: string;
}) {
  const content = (
    <>
      <h2>{title}</h2>
      <p role={role}>{body}</p>
      <Button type="button" variant="primary" onClick={action.onClick} disabled={action.disabled}>
        {action.label}
      </Button>
      {reference && <p className="state-screen__reference">{reference}</p>}
    </>
  );

  if (variant === "dashed") {
    return <div className="empty-state">{content}</div>;
  }
  return <Card className="state-card">{content}</Card>;
}
