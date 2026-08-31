/** Typed application errors. Each carries an HTTP status and a stable code the
 *  frontend can branch on without string-matching messages. */

export class AppError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, details?: unknown) { super(message, 400, 'BAD_REQUEST', details); }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) { super(message, 422, 'VALIDATION_FAILED', details); }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') { super(message, 401, 'UNAUTHORIZED'); }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action') {
    super(message, 403, 'FORBIDDEN');
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') { super(`${resource} not found`, 404, 'NOT_FOUND'); }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) { super(message, 409, 'CONFLICT', details); }
}

/**
 * The business rules from the brief's section 39, as distinct error types so
 * the UI can explain *why* an action was refused rather than showing a generic
 * failure. These are the rules the spreadsheet could only state in prose.
 */

export class ApprovalRequiredError extends AppError {
  constructor(operation: string) {
    super(
      `"${operation}" requires customer approval before it can start. Record the approval first.`,
      409, 'APPROVAL_REQUIRED',
    );
  }
}

export class QuantityRuleError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 422, 'QUANTITY_RULE_VIOLATION', details);
  }
}

export class TaskPrerequisiteError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 409, 'TASK_PREREQUISITE_UNMET', details);
  }
}

export class OverrideRequiredError extends AppError {
  constructor(message: string) {
    super(message, 403, 'OVERRIDE_REQUIRED');
  }
}

/**
 * Distinct from a plain 403 so the client can tell "set a new password" apart
 * from "you are not allowed to do this" — the first has a remedy the user can
 * act on themselves, the second does not.
 */
export class PasswordChangeRequiredError extends AppError {
  constructor() {
    super(
      'Your password was reset by an administrator. Choose a new password before continuing.',
      403, 'PASSWORD_CHANGE_REQUIRED',
    );
  }
}
