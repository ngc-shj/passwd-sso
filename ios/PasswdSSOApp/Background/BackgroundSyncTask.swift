import BackgroundTasks
import CryptoKit
import Foundation
import Shared

/// BGTaskScheduler glue for the best-effort 15-min cache top-up.
/// NOT unit-tested (Apple does not expose _simulateLaunchForTaskWithIdentifier to XCTest).
/// Manual exercise: see docs/archive/review/ios-autofill-mvp-manual-test.md §"BGTaskScheduler".
public enum BackgroundSyncTask {
  public static let identifier = "com.passwd-sso.cache-sync"

  /// Register on app launch. Must be called before the app finishes launching.
  public static func register(
    syncService: HostSyncService,
    vaultKey: @Sendable @escaping () -> SymmetricKey?
  ) {
    let runner = BackgroundSyncRunner(syncService: syncService, vaultKey: vaultKey)
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

// MARK: - Runner (Sendable wrapper)

/// Wraps the sync-service call in a type that can cross concurrency domains.
final class BackgroundSyncRunner: @unchecked Sendable {
  private let syncService: HostSyncService
  private let vaultKey: @Sendable () -> SymmetricKey?

  init(syncService: HostSyncService, vaultKey: @Sendable @escaping () -> SymmetricKey?) {
    self.syncService = syncService
    self.vaultKey = vaultKey
  }

  func run(task bgTask: BGTask) {
    // Box the BGTask so the detached closure can capture it safely.
    let box = TaskBox(task: bgTask)
    let service = syncService
    let keyProvider = vaultKey
    Task {
      await runAsync(box: box, service: service, keyProvider: keyProvider)
    }
  }

  private func runAsync(
    box: TaskBox,
    service: HostSyncService,
    keyProvider: @Sendable () -> SymmetricKey?
  ) async {
    guard let key = keyProvider() else {
      box.task.setTaskCompleted(success: false)
      BackgroundSyncTask.scheduleNext()
      return
    }
    do {
      _ = try await service.runSync(vaultKey: key)
      box.task.setTaskCompleted(success: true)
    } catch {
      box.task.setTaskCompleted(success: false)
    }
    BackgroundSyncTask.scheduleNext()
  }
}

// MARK: - Box to wrap non-Sendable BGTask

private final class TaskBox: @unchecked Sendable {
  let task: BGTask
  init(task: BGTask) { self.task = task }
}
