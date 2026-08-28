(function medicationOperationModule(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PhimorMedicationOperation = api;
})(typeof window !== 'undefined' ? window : globalThis, function buildMedicationOperation() {
  function create({ careProfileId, generation, profileConditions = [] }) {
    return Object.freeze({
      careProfileId:String(careProfileId || ''),
      generation:Number(generation),
      profileConditions:Object.freeze([...(Array.isArray(profileConditions) ? profileConditions : [])]),
    });
  }

  function matches(operation, { activeOperation, careProfileId, generation }) {
    return Boolean(operation)
      && operation === activeOperation
      && operation.careProfileId === String(careProfileId || '')
      && operation.generation === Number(generation);
  }

  return Object.freeze({ create, matches });
});
