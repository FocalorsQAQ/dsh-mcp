import { StateStore } from '../../src/store.ts';

let store: StateStore | undefined;
process.on('message', message => {
  if (message === 'acquire') {
    try {
      store = new StateStore(process.argv[2]!);
      if (store.read().cursor === 0) store.write({ version: 1, cursor: 7, agents: [], events: [], deliveries: [] });
      process.send?.({ acquired: true });
    } catch (error) { process.send?.({ acquired: false, code: (error as { code?: string }).code }); }
  } else if (message === 'release') {
    store?.close(); process.exit(0);
  }
});
process.send?.({ ready: true });
