/**
 * State machines as data: `update(model, msg) → [model, effects]` is pure, effects are plain values, and a thin
 * runtime runs them and feeds their results back as messages. Tests replay message sequences (hostile orders included)
 * against `update` alone, in milliseconds, with no mocks: time is a message field, never a clock read.
 */

export type Update<Model, Msg, Effect> = (
  model: Model,
  msg: Msg
) => readonly [Model, readonly Effect[]];

/** Where a replay ends: the last model and every effect produced on the way. */
export type Replayed<Model, Effect> = { model: Model; effects: Effect[] };

/** A running machine: send it messages, read its current model. */
export type Runtime<Model, Msg> = { dispatch: (msg: Msg) => void; model: () => Model };

/** Feed messages through `update` from `model`, collecting every effect; for tests and simulations. */
export function replay<Model, Msg, Effect>(
  update: Update<Model, Msg, Effect>,
  model: Model,
  messages: readonly Msg[]
): Replayed<Model, Effect> {
  const effects: Effect[] = [];
  let current = model;

  for (const msg of messages) {
    const [next, produced] = update(current, msg);
    current = next;
    effects.push(...produced);
  }

  return { model: current, effects };
}

/** A runtime: holds the model, runs each message's effects, and tells `render` after every change. */
export function runtime<Model, Msg, Effect>(options: {
  model: Model;
  update: Update<Model, Msg, Effect>;
  run: (effect: Effect, dispatch: (msg: Msg) => void) => void;
  render: (model: Model) => void;
  /** Every message and its effects, for telemetry and debugging. */
  observe?: (msg: Msg, effects: readonly Effect[]) => void;
}): Runtime<Model, Msg> {
  let model = options.model;
  const queue: Msg[] = [];
  let draining = false;

  const dispatch = (msg: Msg): void => {
    queue.push(msg);

    // Messages an effect dispatches synchronously run after the current one, in order.
    if (draining) {
      return;
    }

    draining = true;

    try {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        const [updated, effects] = options.update(model, next);
        const changed = updated !== model;
        model = updated;
        options.observe?.(next, effects);

        if (changed) {
          options.render(model);
        }

        for (const effect of effects) {
          options.run(effect, dispatch);
        }
      }
    } finally {
      draining = false;
    }
  };

  return { dispatch, model: () => model };
}

/** Exhaustiveness: a switch that reaches this has forgotten a case, and the type checker says which. */
export function unreachable(value: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`);
}
