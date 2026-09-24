// Copied from the template's packages/shared/src/utils/serializedQueue.ts.
// Each run(fn) waits for the previous to settle before invoking fn; a failure
// does not poison the chain. Errors still reject the caller's promise.

export type SerializedQueue = {
  run: <T>(fn: () => Promise<T>) => Promise<T>;
  size: () => number;
};

export const createSerializedQueue = (): SerializedQueue => {
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;

  return {
    run: <T>(fn: () => Promise<T>): Promise<T> => {
      pending++;
      const wrapped = async (): Promise<T> => {
        try {
          return await fn();
        } finally {
          pending--;
        }
      };
      const next = tail.then(wrapped, wrapped);
      tail = next;
      return next;
    },
    size: () => pending,
  };
};
