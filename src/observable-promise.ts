import Observable from "zen-observable"

export type ObservablePromise<T> = Promise<T> & Observable<T>

type OnFulfilled<T, Result = void> = (value: T) => Result
type OnRejected<Result = void> = (error: Error) => Result

type Initializer<T> = (
  resolve: (value?: T) => void,
  reject: (error: Error) => void,
  observer: ZenObservable.SubscriptionObserver<T>
) => UnsubscribeFn | void

type UnsubscribeFn = () => void

const doNothing = () => undefined
const runDeferred = (fn: () => void) => Promise.resolve().then(fn)

/**
 * Creates a hybrid, combining the APIs of an Observable and a Promise.
 *
 * It is used to proxy async process states when we are initially not sure
 * if that async process will yield values/errors once (-> Promise) or
 * multiple times (-> Observable).
 *
 * Note that the observable promise inherits some of zen-observable's characteristics:
 * The `init` function will be called *once for every time anyone subscribes to it*.
 *
 * If this is undesired, derive a hot observable from it using `makeHot()` and
 * subscribe to that.
 */
export function ObservablePromise<T>(init: Initializer<T>): ObservablePromise<T> {
  let initHasRun = false
  const fulfillmentCallbacks: OnFulfilled<T>[] = []
  const rejectionCallbacks: OnRejected[] = []

  const onNext = (value: T) => {
    if (!firstValueSet) {
      firstValue = value
      firstValueSet = true
    }
  }
  const onError = (error: Error) => {
    state = "rejected"

    for (const onRejected of rejectionCallbacks) {
      // Promisifying the call to turn errors into unhandled promise rejections
      // instead of them failing sync and cancelling the iteration
      runDeferred(() => onRejected(error))
    }
  }
  const onCompletion = () => {
    state = "fulfilled"

    for (const onFulfilled of fulfillmentCallbacks) {
      // Promisifying the call to turn errors into unhandled promise rejections
      // instead of them failing sync and cancelling the iteration
      runDeferred(() => onFulfilled(firstValue as T))
    }
  }

  const observable = new Observable<T>(originalObserver => {
    const observer = {
      ...originalObserver,
      complete() {
        originalObserver.complete()
        onCompletion()
      },
      error(error: Error) {
        originalObserver.error(error)
        onError(error)
      },
      next(value: T) {
        originalObserver.next(value)
        onNext(value)
      }
    }
    const resolve: OnFulfilled<T | undefined> = (value?: T) => {
      if (value !== undefined) {
        observer.next(value)
      }
      observer.complete()
    }
    const reject: OnRejected = (error: Error) => observer.error(error)

    try {
      initHasRun = true
      return init(resolve, reject, observer)
    } catch (error) {
      reject(error)
    }
  })

  let firstValue: T | undefined
  let firstValueSet = false
  let rejection: Error | undefined
  let state: "fulfilled" | "pending" | "rejected" = "pending"

  function then<Result1 = T, Result2 = never>(
    onFulfilled: OnFulfilled<T, Result1> | null | undefined,
    onRejected?: OnRejected<Result2> | null | undefined
  ): Promise<Result1 | Result2> {
    return new Promise<Result1 | Result2>((resolve, reject) => {
      if (!initHasRun) {
        observable.subscribe({ error: reject })
      }
      if (state === "fulfilled" && onFulfilled) {
        return resolve(onFulfilled(firstValue as T))
      }
      if (state === "rejected" && onRejected) {
        return resolve(onRejected(rejection as Error))
      }
      if (!onFulfilled && !onRejected) {
        return resolve()
      }
      if (onFulfilled) {
        fulfillmentCallbacks.push(value => {
          try {
            resolve(onFulfilled(value))
          } catch (error) {
            reject(error)
          }
        })
      }
      if (onRejected) {
        rejectionCallbacks.push(error => {
          try {
            resolve(onRejected(error))
          } catch (anotherError) {
            reject(anotherError)
          }
        })
      } else {
        rejectionCallbacks.push(reject)
      }
    })
  }

  const catchFn = <Result = never>(
    onRejected: ((error: Error) => Promise<Result> | Result | void) | null | undefined
  ) => {
    return then(undefined, onRejected) as Promise<Result>
  }
  const finallyFn = (onCompleted: () => void) => {
    onCompleted = onCompleted || doNothing
    return then(
      (value: T) => {
        onCompleted()
        return value
      },
      () => onCompleted()
    )
  }

  return Object.assign(observable, {
    [Symbol.toStringTag]: "[object ObservablePromise]",

    then: then as Promise<T>["then"],
    catch: catchFn as Promise<T>["catch"],
    finally: finallyFn as Promise<T>["finally"]
  })
}

/**
 * Turns a cold observable into a hot observable.
 *
 * Returns a new observable promise that does exactly the same, but acts as a subscription aggregator,
 * so that N subscriptions to it only result in one subscription to the input observable promise.
 *
 * That one subscription on the input observable promise is setup immediately.
 */
export function makeHot<T>(async: ObservablePromise<T>): ObservablePromise<T> {
  let observers: Array<ZenObservable.SubscriptionObserver<T>> = []
  let resolvers: Array<(value?: T) => void> = []
  let rejectors: Array<(error: Error) => void> = []

  async.subscribe({
    complete() {
      observers.forEach(observer => observer.complete())
    },
    error(error) {
      observers.forEach(observer => observer.error(error))
    },
    next(value) {
      observers.forEach(observer => observer.next(value))
    }
  })
  async.then(
    result => {
      resolvers.forEach(resolve => resolve(result))
    },
    error => {
      rejectors.forEach(reject => reject(error))
    }
  )

  const aggregator = ObservablePromise<T>((resolve, reject, observer) => {
    resolvers.push(resolve)
    rejectors.push(reject)
    observers.push(observer)

    const unsubscribe = () => {
      observers = observers.filter(someObserver => someObserver !== observer)
      resolvers = resolvers.filter(someResolver => someResolver !== resolve)
      rejectors = rejectors.filter(someRejector => someRejector !== reject)
    }
    return unsubscribe
  })
  return aggregator
}
