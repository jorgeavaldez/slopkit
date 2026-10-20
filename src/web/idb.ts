/**
 * IndexedDB, promised: open with an upgrade step, await a request, await a transaction's commit. A transaction is
 * the unit of atomicity: rows and their checkpoint go in one, so a crash or a closed tab leaves the last committed
 * state, never half of a newer one.
 */

export function openDatabase(
  factory: IDBFactory,
  name: string,
  version: number,
  upgrade: (db: IDBDatabase, from: number, transaction: IDBTransaction) => void
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const opening = factory.open(name, version);
    opening.onupgradeneeded = (event) => {
      if (opening.transaction !== null) {
        upgrade(opening.result, event.oldVersion, opening.transaction);
      }
    };

    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error ?? new Error(`can't open ${name}`));
    opening.onblocked = () => reject(new Error(`${name} is open in an older tab`));
  });
}

export function request<T>(pending: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    pending.onsuccess = () => resolve(pending.result);
    pending.onerror = () => reject(pending.error ?? new Error("IndexedDB request failed"));
  });
}

/** Resolves once the transaction commits; rejects if it errors or aborts (quota, a failed request). */
export function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}
