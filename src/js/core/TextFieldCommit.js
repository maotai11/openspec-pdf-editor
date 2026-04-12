const activeTextCommitBindings = new Set();

export function flushPendingTextCommits() {
  let committed = false;
  for (const binding of [...activeTextCommitBindings]) {
    if (binding.flushNow()) committed = true;
  }
  return committed;
}

export function bindBufferedTextCommit(input, options = {}) {
  const {
    documentTarget = globalThis.document,
    onCommit = () => {},
    isInsideTarget = (target) => target === input || Boolean(input?.contains?.(target)),
  } = options;

  let lastCommittedValue = String(input?.value ?? '');
  let timerId = null;
  let detached = false;
  let cancelled = false;

  const commit = () => {
    if (cancelled) return false;
    const nextValue = String(input?.value ?? '');
    if (nextValue === lastCommittedValue) return false;
    lastCommittedValue = nextValue;
    onCommit(nextValue);
    return true;
  };

  const scheduleCommit = () => {
    if (cancelled || timerId !== null) return;
    timerId = setTimeout(() => {
      timerId = null;
      commit();
    }, 0);
  };

  const handleBlur = () => scheduleCommit();
  const handleChange = () => scheduleCommit();
  const handlePointerDown = (event = {}) => {
    if (isInsideTarget(event.target)) return;
    scheduleCommit();
  };

  input?.addEventListener?.('blur', handleBlur);
  input?.addEventListener?.('change', handleChange);
  documentTarget?.addEventListener?.('pointerdown', handlePointerDown, true);

  const flushNow = () => {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
    return commit();
  };

  const binding = {
    commit,
    flushNow,
    scheduleCommit,
    cleanup({ cancelPending = false } = {}) {
      if (detached) return;
      detached = true;
      activeTextCommitBindings.delete(binding);
      input?.removeEventListener?.('blur', handleBlur);
      input?.removeEventListener?.('change', handleChange);
      documentTarget?.removeEventListener?.('pointerdown', handlePointerDown, true);
      if (cancelPending && timerId !== null) {
        cancelled = true;
        clearTimeout(timerId);
        timerId = null;
      }
    },
  };

  activeTextCommitBindings.add(binding);
  return binding;
}
