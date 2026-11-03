/* The DOM matchers — toBeInTheDocument, toHaveFocus — for every component test. */
import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';
import { beforeEach } from 'vitest';
import { establishSessionIdentity } from '@mistriwork/kit/client/sessionIdentity.js';
import { installShell } from '@mistriwork/kit/client/shellMode.js';

// Component fixtures represent the standalone, unauthenticated browser.
beforeEach(() => {
  establishSessionIdentity({ signedIn: false });
});

// Fixtures that pin "12,345.5" and "Aug 1, 2026" say so, rather than
// passing only on a machine whose own locale happens to be American.
// A test about another locale registers its own source.
beforeEach(() => {
  installShell({ format: () => ({ locale: 'en-US' }) });
});

// A dialog or menu drawn from a part loaded on demand can take past the one-second
// default to appear on a loaded machine; the wait ends as soon as it does, so a
// longer ceiling costs a passing test nothing and keeps a slow one from failing.
configure({ asyncUtilTimeout: 5_000 });
