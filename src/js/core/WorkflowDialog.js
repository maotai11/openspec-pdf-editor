export async function resolveDialogSubmission(controller = {}) {
  const value = typeof controller.getValue === 'function'
    ? await controller.getValue()
    : undefined;
  const validationError = typeof controller.validate === 'function'
    ? await controller.validate(value)
    : '';

  return {
    value,
    validationError: validationError || '',
  };
}

export default {
  resolveDialogSubmission,
};
