import { LIMIT_ERROR, SPENDING_LIMITS_HREF } from '../../../shared/limits';

/** An error message; a spending-limit error also links to the limits in Settings. */
export function ErrorText({ message }: { message: string }) {
  return (
    <span>
      {message}
      {LIMIT_ERROR.test(message) && <> <a href={SPENDING_LIMITS_HREF}>Spending limits</a></>}
    </span>
  );
}
