import { describe, expect, it } from 'vitest';
import {
  BudgetExceededError,
  DomainError,
  InvalidOutputError,
  LlmTimeoutError,
  NotFoundError,
  ProviderUnavailableError,
  isDomainError,
  type DomainErrorCode,
  type KnownDomainError,
} from './errors.js';

describe('domain errors', () => {
  it.each<[KnownDomainError, DomainErrorCode, string]>([
    [new NotFoundError('Conversation', 'c-1'), 'NOT_FOUND', 'NotFoundError'],
    [new BudgetExceededError(2.5, 2), 'BUDGET_EXCEEDED', 'BudgetExceededError'],
    [new LlmTimeoutError(45_000), 'LLM_TIMEOUT', 'LlmTimeoutError'],
    [new ProviderUnavailableError('anthropic'), 'PROVIDER_UNAVAILABLE', 'ProviderUnavailableError'],
    [new InvalidOutputError(['days: expected 3']), 'INVALID_OUTPUT', 'InvalidOutputError'],
  ])('%s has a stable code and name', (error, code, name) => {
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(DomainError);
    expect(error.code).toBe(code);
    expect(error.name).toBe(name);
    expect(error.stack).toContain(name);
    expect(isDomainError(error)).toBe(true);
  });

  it('NotFoundError describes the missing resource', () => {
    const error = new NotFoundError('Conversation', 'c-1');
    expect(error.message).toBe('Conversation c-1 not found');
    expect(error.resource).toBe('Conversation');
    expect(error.id).toBe('c-1');
    expect(error.details).toEqual({ resource: 'Conversation', id: 'c-1' });
  });

  it('BudgetExceededError carries spent and limit amounts', () => {
    const error = new BudgetExceededError(2.000431, 2);
    expect(error.spentUsd).toBe(2.000431);
    expect(error.limitUsd).toBe(2);
    expect(error.details).toEqual({ spentUsd: 2.000431, limitUsd: 2 });
    expect(error.message).toContain('2.000431');
  });

  it('LlmTimeoutError keeps the deadline and the abort cause', () => {
    const cause = new DOMException('aborted', 'AbortError');
    const error = new LlmTimeoutError(90_000, { cause });
    expect(error.timeoutMs).toBe(90_000);
    expect(error.cause).toBe(cause);
    expect(error.message).toBe('LLM call timed out after 90000 ms');
  });

  it('ProviderUnavailableError records the upstream status when known', () => {
    const cause = new Error('overloaded');
    const withStatus = new ProviderUnavailableError('anthropic', { status: 529, cause });
    expect(withStatus.provider).toBe('anthropic');
    expect(withStatus.details).toEqual({ provider: 'anthropic', status: 529 });
    expect(withStatus.message).toBe('LLM provider anthropic is unavailable (HTTP 529)');
    expect(withStatus.cause).toBe(cause);

    const withoutStatus = new ProviderUnavailableError('anthropic');
    expect(withoutStatus.details).toEqual({ provider: 'anthropic' });
    expect(withoutStatus.message).toBe('LLM provider anthropic is unavailable');
    expect(withoutStatus.cause).toBeUndefined();
  });

  it('InvalidOutputError keeps an immutable copy of the validation issues', () => {
    const issues = ['days: expected 3 items', 'sourceRefs[0]: unknown chunk'];
    const error = new InvalidOutputError(issues);
    issues.push('mutated later');

    expect(error.issues).toEqual(['days: expected 3 items', 'sourceRefs[0]: unknown chunk']);
    expect(Object.isFrozen(error.issues)).toBe(true);
    expect(error.message).toBe('Model output is invalid: 2 issue(s)');
  });

  it('freezes details so logs see what was thrown', () => {
    const error = new NotFoundError('Run', 'r-1');
    expect(Object.isFrozen(error.details)).toBe(true);
  });

  it('narrows on code through the closed union', () => {
    const describeError = (error: KnownDomainError): string => {
      switch (error.code) {
        case 'NOT_FOUND':
          return error.resource;
        case 'BUDGET_EXCEEDED':
          return String(error.limitUsd);
        case 'LLM_TIMEOUT':
          return String(error.timeoutMs);
        case 'PROVIDER_UNAVAILABLE':
          return error.provider;
        case 'INVALID_OUTPUT':
          return error.issues.join(',');
      }
    };
    expect(describeError(new BudgetExceededError(3, 2))).toBe('2');
    expect(describeError(new InvalidOutputError(['a', 'b']))).toBe('a,b');
  });

  it.each([new Error('plain'), 'string', null, undefined, { code: 'NOT_FOUND' }])(
    'isDomainError rejects %s',
    (value) => {
      expect(isDomainError(value)).toBe(false);
    },
  );
});
