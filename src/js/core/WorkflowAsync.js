export function createFileScopedValueCache() {
  const cache = new WeakMap();

  return {
    async get(file, loader) {
      if (!file) return null;
      if (!cache.has(file)) {
        cache.set(file, Promise.resolve(loader(file)));
      }
      return cache.get(file);
    },
  };
}

export function createLatestAsyncRunner() {
  let generation = 0;

  return async (task) => {
    const requestId = ++generation;
    const value = await task();
    return {
      stale: requestId !== generation,
      value,
    };
  };
}

export default {
  createFileScopedValueCache,
  createLatestAsyncRunner,
};
