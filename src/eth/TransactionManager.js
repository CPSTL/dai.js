import { PublicService } from '@makerdao/services-core';
import TransactionObject from './TransactionObject';
import { uniqueId } from '../utils';
import { has, each } from 'lodash';
import { inspect } from 'util';
import debug from 'debug';
const log = debug('dai:TransactionManager');

export default class TransactionManager extends PublicService {
  constructor(name = 'transactionManager') {
    super(name, ['web3', 'log', 'nonce', 'proxy']);
    this._newTxListeners = [];
    this._tracker = new Tracker();
  }

  // this method must not be async
  sendContractCall(contract, method, args, name) {
    log(`sendContractCall: ${name}.${method} ${inspect(args)}`);
    if (!args) args = [];
    let options,
      promise,
      businessObject,
      metadata = {
        contract: name,
        method: method.replace(/\(.*\)$/g, ''),
        args
      },
      lastArg = args[args.length - 1];

    if (typeof lastArg === 'object' && lastArg.constructor === Object) {
      options = lastArg;
      args = args.slice(0, args.length - 1);

      // append additional metadata to the default values.
      if (options.metadata) {
        metadata = { ...metadata, ...options.metadata };
        delete options.metadata;
      }

      if (has(options, 'promise')) {
        if (options.promise) promise = options.promise;
        delete options.promise;
      }

      if (options.businessObject) {
        businessObject = options.businessObject;
        delete options.businessObject;
      }
    } else {
      options = {};
    }

    // for promise tracking to work, we must return to the caller the result of
    // _createTransactionObject, because that promise is the one stored for
    // lookup to attach lifecycle hooks.
    return this._createTransactionObject(
      (async () => {
        // so we do our async operations inside this immediately-executed
        // async function.
        const txOptions = await this._buildTransactionOptions(options);
        return this._execute(contract, method, args, txOptions);
      })(),
      {
        businessObject,
        metadata,
        promise
      }
    );
  }

  // this method must not be async
  sendTransaction(data, options) {
    return this._createTransactionObject(
      (async () => {
        const txOptions = await this._buildTransactionOptions(data);
        return this.get('web3').sendTransaction(txOptions);
      })(),
      options
    );
  }

  onNewTransaction(callback) {
    this._newTxListeners.push(callback);
  }

  getTransaction(promise, label) {
    return this._tracker.get(uniqueId(promise), label);
  }

  async confirm(promise, count) {
    await promise;
    const txs = this._tracker.getAll(uniqueId(promise));
    return Promise.all(txs.map(tx => tx.confirm(count)));
  }

  isMined(promise) {
    return this._tracker.get(uniqueId(promise)).isMined();
  }

  listen(promise, handlers) {
    if (typeof handlers === 'function') {
      this._tracker.listen(uniqueId(promise), {
        pending: tx => handlers(tx, 'pending'),
        mined: tx => handlers(tx, 'mined'),
        confirmed: tx => handlers(tx, 'confirmed'),
        error: (tx, err) => handlers(tx, 'error', err)
      });
    } else {
      this._tracker.listen(uniqueId(promise), handlers);
    }
  }

  // if options.dsProxy is set, execute this contract method through the
  // proxy contract at that address.
  _execute(contract, method, args, options) {
    if (!options.dsProxy) return contract[method](...args, options);

    let address;
    if (typeof options.dsProxy === 'string') {
      address = options.dsProxy;
    }

    delete options.dsProxy;
    return this.get('proxy').execute(contract, method, args, options, address);
  }

  _createTransactionObject(tx, { businessObject, metadata, promise } = {}) {
    const txo = new TransactionObject(tx, this.get('web3'), this.get('nonce'), {
      businessObject,
      metadata
    });

    this._newTxListeners.forEach(cb => cb(txo));

    const minePromise = txo.mine();

    // we store the transaction object under the unique id of its own mine
    // promise, so that it can be looked up when calling a contract function
    // directly from a service method, e.g. WethToken.deposit.
    this._tracker.store(uniqueId(minePromise), txo);

    // if the `promise` object is defined in the options argument, we also store
    // the transaction object under that promise's id, so that it can be looked
    // up when calling a contract function indirectly via two or more nested
    // service method calls, e.g.
    // EthereumCdpService.lockEth -> WethToken.deposit.
    if (promise) this._tracker.store(uniqueId(promise), txo);

    return minePromise;
  }

  async _buildTransactionOptions(data) {
    return {
      ...this.get('web3').transactionSettings(),
      ...data,
      nonce: await this.get('nonce').getNonce()
    };
  }
}

class Tracker {
  static states = ['initialized', 'pending', 'mined', 'finalized', 'error'];

  constructor() {
    this._listeners = {};
    this._transactions = {};
  }

  store(key, tx) {
    this._init(key);
    this._transactions[key].push(tx);

    for (let event of this.constructor.states) {
      tx.on(event, () =>
        this._listeners[key][event].forEach(
          cb => (tx.error ? cb(tx, tx.error) : cb(tx))
        )
      );
    }

    this._listeners[key].initialized.forEach(
      cb => (tx.error ? cb(tx, tx.error) : cb(tx))
    );
    this.clearExpiredTransactions();
  }

  listen(key, handlers) {
    this._init(key);

    for (let state in handlers) {
      const cb = handlers[state];
      if (state === 'confirmed') state = 'finalized';
      this._listeners[key][state].push(cb);

      // if event has already happened, call handler immediately
      this._transactions[key].forEach(
        tx =>
          tx &&
          tx.inOrPastState(state) &&
          (tx.error ? cb(tx, tx.error) : cb(tx))
      );
    }
  }

  getAll(key) {
    return this._transactions[key];
  }

  get(key) {
    const txs = this._transactions[key];
    if (!txs || txs.length === 0) {
      throw new Error(`No transactions for key ${key}`);
    }
    if (txs.length > 1) {
      console.warn(
        `Key ${key} matches ${txs.length} transactions; returning the first.`
      );
    }
    return txs[0];
  }

  clearExpiredTransactions() {
    each(this._transactions, (txList, key) => {
      txList.forEach(tx => {
        const txAge =
          (new Date().getTime() - new Date(tx._timeStampMined).getTime()) /
          60000;
        if ((tx.isError() || tx.isFinalized()) && txAge > 5) {
          const indexToRemove = this._transactions[key].indexOf(tx);
          this._transactions[key].splice(indexToRemove, 1);
          if (this._transactions[key].length === 0) {
            delete this._transactions[key];
            delete this._listeners[key];
          }
        }
      });
    });
  }

  _init(key) {
    if (!this._transactions[key]) this._transactions[key] = [];
    if (!this._listeners[key]) {
      this._listeners[key] = this.constructor.states.reduce((acc, state) => {
        acc[state] = [];
        return acc;
      }, {});
    }
  }
}
