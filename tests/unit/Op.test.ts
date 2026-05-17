import { OpStore } from '../../src/op/Op';

describe('OpStore', () => {
  it('tracks async operation completion', async () => {
    const ops = new OpStore<{ ok: boolean }>();
    const op = ops.start({
      session_id: 'session',
      action: 'wait',
      run: async () => ({ ok: true }),
    });

    expect(ops.toStatus(op)).toEqual(expect.objectContaining({
      status: 'running',
      operation_id: op.operation_id,
    }));

    await until(() => ops.get(op.operation_id)?.state === 'done');
    expect(ops.toStatus(ops.get(op.operation_id)!)).toEqual(expect.objectContaining({
      status: 'completed',
      progress: 1,
      result: { ok: true },
    }));
  });

  it('keeps cancelled state and stores late result as partial result', async () => {
    const ops = new OpStore<{ late: boolean }>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const op = ops.start({
      session_id: 'session',
      action: 'wait',
      run: async () => {
        await gate;
        return { late: true };
      },
    });

    expect(ops.cancel(op.operation_id)).toEqual(expect.objectContaining({ state: 'cancelled' }));
    release();

    await until(() => Boolean(ops.get(op.operation_id)?.partial_result));
    expect(ops.toStatus(ops.get(op.operation_id)!)).toEqual(expect.objectContaining({
      status: 'cancelled',
      partial_result: { late: true },
    }));
  });
});

async function until(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1000) throw new Error('timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
