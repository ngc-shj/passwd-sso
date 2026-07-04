import Foundation
import XCTest
@testable import PasswdSSOApp

/// Coverage for the process-global refresh gate that collapses redundant token
/// refreshes. The two failure modes it defends against (concurrent refreshes and
/// sequential re-tries with a stale token) both trip the server's replay detector,
/// so the single-flight join and the short success-cache are the load-bearing
/// behaviors these tests pin down.
final class TokenRefreshCoordinatorTests: XCTestCase {

  /// Thread-safe invocation counter for the injected refresh closure.
  private actor CallCounter {
    private(set) var count = 0
    func bump() -> Int {
      count += 1
      return count
    }
  }

  /// A one-shot gate: awaiters suspend until `open()` is called, then all proceed.
  /// Sendable so the `@Sendable` refresh closure can await it without capturing the
  /// (non-Sendable) XCTestCase.
  private actor Gate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func wait() async {
      if isOpen { return }
      await withCheckedContinuation { waiters.append($0) }
    }
    func open() {
      isOpen = true
      for w in waiters { w.resume() }
      waiters.removeAll()
    }
  }

  /// A controllable clock the coordinator reads via its injected `now` closure.
  private final class MutableClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Date
    init(_ start: Date) { value = start }
    func advance(by seconds: TimeInterval) {
      lock.lock(); defer { lock.unlock() }
      value = value.addingTimeInterval(seconds)
    }
    var now: Date {
      lock.lock(); defer { lock.unlock() }
      return value
    }
  }

  // MARK: - Single-flight (concurrent callers)

  /// N concurrent callers for the same key must collapse into exactly ONE refresh
  /// network call — the whole point of the gate. The refresh closure blocks on a
  /// continuation until every caller has joined, so the count is observed while
  /// all N are in flight (not merely serialized fast enough to look like one).
  func testConcurrentCallersCollapseToSingleRefresh() async throws {
    let coordinator = TokenRefreshCoordinator()
    let counter = CallCounter()
    let gate = Gate()
    let callerCount = 8

    // The single refresh blocks on the gate until all callers have queued, so the
    // invocation count is observed while all N are genuinely in flight.
    let refresh: @Sendable () async throws -> String = {
      _ = await counter.bump()
      await gate.wait()
      return "rotated-token"
    }

    // Launch all callers, then release the gate.
    async let results: [String] = withThrowingTaskGroup(of: String.self) { group in
      for _ in 0..<callerCount {
        group.addTask { try await coordinator.run(key: "k", refresh: refresh) }
      }
      var out: [String] = []
      for try await r in group { out.append(r) }
      return out
    }

    // Give the callers a moment to all reach the gate, then release.
    try await Task.sleep(nanoseconds: 100_000_000)
    await gate.open()

    let tokens = try await results
    XCTAssertEqual(tokens.count, callerCount)
    XCTAssertTrue(tokens.allSatisfy { $0 == "rotated-token" })
    let calls = await counter.count
    XCTAssertEqual(calls, 1, "concurrent callers must trigger exactly one refresh")
  }

  /// When the single flight THROWS while N callers are joined, every joined caller
  /// must receive the error (a dead session must not silently succeed for the
  /// joiners), and `inFlight` must be cleared so the NEXT call retries rather than
  /// joining a dead task. This is the concurrent-failure path the fix exists for.
  func testConcurrentCallersAllReceiveThrownErrorAndInFlightIsCleared() async throws {
    let coordinator = TokenRefreshCoordinator()
    let counter = CallCounter()
    let gate = Gate()
    let callerCount = 6
    struct Boom: Error {}

    // The single flight blocks until all callers queue, then throws.
    let failing: @Sendable () async throws -> String = {
      _ = await counter.bump()
      await gate.wait()
      throw Boom()
    }

    async let failures: Int = withTaskGroup(of: Bool.self) { group in
      for _ in 0..<callerCount {
        group.addTask {
          do { _ = try await coordinator.run(key: "k", refresh: failing); return false }
          catch is Boom { return true }
          catch { return false }
        }
      }
      var threw = 0
      for await didThrow in group where didThrow { threw += 1 }
      return threw
    }

    try await Task.sleep(nanoseconds: 100_000_000)
    await gate.open()

    let threwCount = await failures
    XCTAssertEqual(threwCount, callerCount, "every joined caller must receive the thrown error")
    let flights = await counter.count
    XCTAssertEqual(flights, 1, "the failure must collapse to exactly one flight, not one per caller")

    // inFlight must be cleared and the failure must NOT be cached: a fresh call
    // re-invokes the refresh (now succeeding) instead of joining a dead task or
    // replaying the error.
    let recovery: @Sendable () async throws -> String = {
      _ = await counter.bump()
      return "recovered"
    }
    let token = try await coordinator.run(key: "k", refresh: recovery)
    XCTAssertEqual(token, "recovered")
    let total = await counter.count
    XCTAssertEqual(total, 2, "a post-failure call must start a new refresh (inFlight cleared, failure not cached)")
  }

  // MARK: - Success cache (sequential callers)

  /// A repeat call within the TTL replays the first call's success without a
  /// second network refresh — the sequential-retry defense.
  func testSequentialCallWithinTTLReplaysCachedSuccess() async throws {
    let clock = MutableClock(Date(timeIntervalSince1970: 1000))
    let coordinator = TokenRefreshCoordinator(resultTTL: 3, now: { clock.now })
    let counter = CallCounter()
    let refresh: @Sendable () async throws -> String = {
      _ = await counter.bump()
      return "token-1"
    }

    let first = try await coordinator.run(key: "k", refresh: refresh)
    clock.advance(by: 1)  // still within the 3s TTL
    let second = try await coordinator.run(key: "k", refresh: refresh)

    XCTAssertEqual(first, "token-1")
    XCTAssertEqual(second, "token-1")
    let calls = await counter.count
    XCTAssertEqual(calls, 1, "a repeat within TTL must not hit the network again")
  }

  /// Once the TTL lapses, the next call performs a fresh refresh.
  func testCacheExpiresAfterTTL() async throws {
    let clock = MutableClock(Date(timeIntervalSince1970: 1000))
    let coordinator = TokenRefreshCoordinator(resultTTL: 3, now: { clock.now })
    let counter = CallCounter()
    let refresh: @Sendable () async throws -> String = {
      let n = await counter.bump()
      return "token-\(n)"
    }

    let first = try await coordinator.run(key: "k", refresh: refresh)
    clock.advance(by: 4)  // past the 3s TTL
    let second = try await coordinator.run(key: "k", refresh: refresh)

    XCTAssertEqual(first, "token-1")
    XCTAssertEqual(second, "token-2", "a call after TTL must refresh again")
    let calls = await counter.count
    XCTAssertEqual(calls, 2)
  }

  // MARK: - Failures are never cached

  /// A failure must NOT be cached: a re-sign-in can install a valid token at any
  /// moment, so the next call must be free to try again rather than replaying the
  /// error for the whole TTL.
  func testFailureIsNotCached() async throws {
    let clock = MutableClock(Date(timeIntervalSince1970: 1000))
    let coordinator = TokenRefreshCoordinator(resultTTL: 3, now: { clock.now })
    let counter = CallCounter()
    struct Boom: Error {}
    let refresh: @Sendable () async throws -> String = {
      let n = await counter.bump()
      if n == 1 { throw Boom() }
      return "recovered-token"
    }

    do {
      _ = try await coordinator.run(key: "k", refresh: refresh)
      XCTFail("Expected the first refresh to throw")
    } catch is Boom {
      // Expected
    }

    // Immediately retry within the TTL window — must re-invoke, not replay a failure.
    let second = try await coordinator.run(key: "k", refresh: refresh)
    XCTAssertEqual(second, "recovered-token")
    let calls = await counter.count
    XCTAssertEqual(calls, 2, "a failed refresh must stay retryable within the TTL")
  }

  // MARK: - Per-key isolation

  /// Distinct keys (distinct token stores) do not share a cache or an in-flight
  /// task — each refreshes independently.
  func testDifferentKeysDoNotShareCache() async throws {
    let clock = MutableClock(Date(timeIntervalSince1970: 1000))
    let coordinator = TokenRefreshCoordinator(resultTTL: 3, now: { clock.now })
    let counter = CallCounter()
    let refresh: @Sendable () async throws -> String = {
      let n = await counter.bump()
      return "token-\(n)"
    }

    let a = try await coordinator.run(key: "key-a", refresh: refresh)
    let b = try await coordinator.run(key: "key-b", refresh: refresh)

    XCTAssertNotEqual(a, b, "distinct keys must not replay each other's cached token")
    let calls = await counter.count
    XCTAssertEqual(calls, 2)
  }
}
