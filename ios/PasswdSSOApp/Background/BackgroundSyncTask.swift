import BackgroundTasks
import CryptoKit
import Foundation
import Shared

/// BGTaskScheduler glue for the best-effort 15-min cache top-up.
/// NOT unit-tested (Apple does not expose _simulateLaunchForTaskWithIdentifier to XCTest).
/// Manual exercise: see docs/archive/review/ios-autofill-mvp-manual-test.md §"BGTaskScheduler".
public enum BackgroundSyncTask {
  public static let identifier = "com.passwd-sso.cache-sync"

  /// Register on app launch. Must be called before the app finishes launching
  /// (PasswdSSOAppApp.init — once per process), which is long before a vault
  /// unlock exists, so all state is resolved lazily at task-launch time.
  public static func register(
    syncService: @Sendable @escaping () -> HostSyncService?,
    vaultKey: @Sendable @escaping () -> SymmetricKey?,
    userId: @Sendable @escaping () -> String?
  ) {
    let runner = BackgroundSyncRunner(syncService: syncService, vaultKey: vaultKey, userId: userId)
    BGTaskScheduler.shared.register(
      forTaskWithIdentifier: identifier,
      using: nil,
      launchHandler: runner.run(task:)
    )
  }

  /// Schedule the next background task request (~15 min from now). Best-effort.
  public static func scheduleNext() {
    let request = BGProcessingTaskRequest(identifier: identifier)
    request.requiresNetworkConnectivity = true
    request.requiresExternalPower = false
    request.earliestBeginDate = Date().addingTimeInterval(15 * 60)
    try? BGTaskScheduler.shared.submit(request)
  }
}

// MARK: - Context bridge

/// Mutable bridge between the SwiftUI app state and the BGTask launch handler.
/// BGTaskScheduler requires the handler to be registered before the app
/// finishes launching — long before a vault unlock can produce the sync
/// service and key — so the handler reads through this holder lazily.
public final class BackgroundSyncContext: @unchecked Sendable {
  private let lock = NSLock()
  private var syncService: HostSyncService?
  private var vaultKey: SymmetricKey?
  private var userId: String?

  public init() {}

  public func update(syncService: HostSyncService, vaultKey: SymmetricKey, userId: String) {
    lock.lock()
    defer { lock.unlock() }
    self.syncService = syncService
    self.vaultKey = vaultKey
    self.userId = userId
  }

  public func currentSyncService() -> HostSyncService? {
    lock.lock()
    defer { lock.unlock() }
    return syncService
  }

  public func currentVaultKey() -> SymmetricKey? {
    lock.lock()
    defer { lock.unlock() }
    return vaultKey
  }

  public func currentUserId() -> String? {
    lock.lock()
    defer { lock.unlock() }
    return userId
  }
}

// MARK: - Runner (Sendable wrapper)

/// Wraps the sync-service call in a type that can cross concurrency domains.
final class BackgroundSyncRunner: @unchecked Sendable {
  private let syncService: @Sendable () -> HostSyncService?
  private let vaultKey: @Sendable () -> SymmetricKey?
  private let userId: @Sendable () -> String?

  init(
    syncService: @Sendable @escaping () -> HostSyncService?,
    vaultKey: @Sendable @escaping () -> SymmetricKey?,
    userId: @Sendable @escaping () -> String?
  ) {
    self.syncService = syncService
    self.vaultKey = vaultKey
    self.userId = userId
  }

  func run(task bgTask: BGTask) {
    // Box the BGTask so the detached closure can capture it safely.
    let box = TaskBox(task: bgTask)
    let serviceProvider = syncService
    let keyProvider = vaultKey
    let userIdProvider = userId
    Task {
      await runAsync(box: box, serviceProvider: serviceProvider, keyProvider: keyProvider, userIdProvider: userIdProvider)
    }
  }

  private func runAsync(
    box: TaskBox,
    serviceProvider: @Sendable () -> HostSyncService?,
    keyProvider: @Sendable () -> SymmetricKey?,
    userIdProvider: @Sendable () -> String?
  ) async {
    guard let service = serviceProvider(), let key = keyProvider(), let uid = userIdProvider() else {
      box.task.setTaskCompleted(success: false)
      BackgroundSyncTask.scheduleNext()
      return
    }
    do {
      _ = try await service.runSync(vaultKey: key, userId: uid)
      box.task.setTaskCompleted(success: true)
      BackgroundSyncTask.scheduleNext()
    } catch MobileAPIError.authenticationRequired {
      // Refresh token is dead — do not reschedule; a dead token won't recover by retrying.
      box.task.setTaskCompleted(success: false)
    } catch {
      box.task.setTaskCompleted(success: false)
      BackgroundSyncTask.scheduleNext()
    }
  }
}

// MARK: - Box to wrap non-Sendable BGTask

private final class TaskBox: @unchecked Sendable {
  let task: BGTask
  init(task: BGTask) { self.task = task }
}
