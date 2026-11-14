/** A problem the user can fix; printed without a stack trace. */
export class UserError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'UserError';
  }
}
