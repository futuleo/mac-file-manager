//! Registry of running file-operation tasks: cancellation, conflict answers and
//! the bridge from the engine's `TaskControl` to Tauri events.

use std::{
    collections::HashMap,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use crate::{
    contracts::{AppError, ConflictDecision, ErrorCategory, TaskEvent},
    operations::{ConflictPrompt, Resolution, TaskControl},
};

pub const MAX_CONCURRENT_TASKS: usize = 8;
const MAX_TASK_ID_LEN: usize = 128;

#[derive(Default)]
struct Slot {
    pending: Option<String>,
    answer: Option<Resolution>,
}

#[derive(Default)]
pub struct Task {
    cancel: AtomicBool,
    slot: Mutex<Slot>,
    wake: Condvar,
}

impl Task {
    fn slot(&self) -> std::sync::MutexGuard<'_, Slot> {
        self.slot.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[derive(Default)]
pub struct Tasks(Mutex<HashMap<String, Arc<Task>>>);

impl Tasks {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<Task>>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn register(&self, task_id: &str) -> Result<Arc<Task>, AppError> {
        let invalid =
            |m: &str| AppError::new(ErrorCategory::InvalidInput, "start the task", None, m);
        if task_id.is_empty() || task_id.len() > MAX_TASK_ID_LEN {
            return Err(invalid("The task identifier is invalid."));
        }
        let mut tasks = self.lock();
        if tasks.contains_key(task_id) {
            return Err(invalid("A task with this identifier is already running."));
        }
        if tasks.len() >= MAX_CONCURRENT_TASKS {
            return Err(invalid(
                "Too many file operations are running. Wait for one to finish.",
            ));
        }
        let task = Arc::new(Task::default());
        tasks.insert(task_id.into(), task.clone());
        Ok(task)
    }

    pub fn remove(&self, task_id: &str) {
        self.lock().remove(task_id);
    }

    pub fn is_empty(&self) -> bool {
        self.lock().is_empty()
    }

    /// Idempotent: cancelling a finished or unknown task is not an error.
    pub fn cancel(&self, task_id: &str) {
        if let Some(task) = self.lock().get(task_id) {
            task.cancel.store(true, Ordering::Relaxed);
            task.wake.notify_all();
        }
    }

    /// Answers the conflict a task is currently waiting on.
    pub fn resolve(
        &self,
        conflict_id: &str,
        decision: ConflictDecision,
        apply_to_all: bool,
    ) -> Result<(), AppError> {
        let tasks: Vec<Arc<Task>> = self.lock().values().cloned().collect();
        for task in tasks {
            let mut slot = task.slot();
            if slot.pending.as_deref() == Some(conflict_id) {
                slot.pending = None;
                slot.answer = Some(Resolution {
                    decision,
                    apply_to_all,
                });
                task.wake.notify_all();
                return Ok(());
            }
        }
        Err(AppError::new(
            ErrorCategory::InvalidInput,
            "resolve the conflict",
            None,
            "That conflict is no longer waiting for an answer.",
        ))
    }
}

/// Removes the registration when the task ends, however it ends.
pub struct TaskGuard<'a>(pub &'a Tasks, pub String);

impl Drop for TaskGuard<'_> {
    fn drop(&mut self) {
        self.0.remove(&self.1);
    }
}

/// Connects the engine to a registered task and an event sink.
pub struct HostControl<'a> {
    pub task_id: &'a str,
    pub task: &'a Task,
    pub sink: &'a (dyn Fn(TaskEvent) + Sync),
}

impl TaskControl for HostControl<'_> {
    fn is_cancelled(&self) -> bool {
        self.task.cancel.load(Ordering::Relaxed)
    }

    fn emit(&self, event: TaskEvent) {
        (self.sink)(event);
    }

    fn ask(&self, prompt: &ConflictPrompt) -> Option<Resolution> {
        {
            // Registered before the event is emitted so a fast answer is never lost.
            let mut slot = self.task.slot();
            slot.pending = Some(prompt.conflict_id.clone());
            slot.answer = None;
        }
        (self.sink)(prompt.to_event(self.task_id));
        let mut slot = self.task.slot();
        loop {
            if let Some(answer) = slot.answer.take() {
                return Some(answer);
            }
            if self.is_cancelled() {
                slot.pending = None;
                return None;
            }
            slot = self
                .task
                .wake
                .wait_timeout(slot, Duration::from_millis(100))
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_rejects_duplicates_invalid_ids_and_overflow() {
        let tasks = Tasks::default();
        assert!(tasks.register("a").is_ok());
        assert!(tasks.register("a").is_err());
        assert!(tasks.register("").is_err());
        assert!(tasks.register(&"x".repeat(200)).is_err());
        for i in 0..MAX_CONCURRENT_TASKS {
            let _ = tasks.register(&format!("t{i}"));
        }
        assert!(tasks.register("overflow").is_err());
        tasks.remove("a");
        assert!(tasks.register("again").is_ok());
        tasks.cancel("unknown");
    }

    #[test]
    fn unknown_conflicts_are_rejected_and_answers_are_delivered_once() {
        let tasks = Tasks::default();
        let task = tasks.register("t").unwrap();
        assert!(
            tasks
                .resolve("nope", ConflictDecision::Skip, false)
                .is_err()
        );
        let events = Mutex::new(Vec::new());
        let sink = |e: TaskEvent| events.lock().unwrap().push(e);
        let control = HostControl {
            task_id: "t",
            task: &task,
            sink: &sink,
        };
        let prompt = ConflictPrompt {
            conflict_id: "t-c1".into(),
            source: "/a/x".into(),
            destination: "/b/x".into(),
            source_kind: crate::contracts::EntryKind::File,
            destination_kind: crate::contracts::EntryKind::File,
            same_item: false,
        };
        std::thread::scope(|scope| {
            let asker = scope.spawn(|| control.ask(&prompt));
            while events.lock().unwrap().is_empty() {
                std::thread::sleep(Duration::from_millis(5));
            }
            tasks
                .resolve("t-c1", ConflictDecision::KeepBoth, true)
                .unwrap();
            let answer = asker.join().unwrap().unwrap();
            assert_eq!(answer.decision, ConflictDecision::KeepBoth);
            assert!(answer.apply_to_all);
        });
        assert!(
            tasks
                .resolve("t-c1", ConflictDecision::Skip, false)
                .is_err()
        );
    }

    #[test]
    fn cancelling_wakes_a_task_waiting_for_a_conflict_answer() {
        let tasks = Tasks::default();
        let task = tasks.register("t").unwrap();
        let sink = |_: TaskEvent| {};
        let control = HostControl {
            task_id: "t",
            task: &task,
            sink: &sink,
        };
        let prompt = ConflictPrompt {
            conflict_id: "t-c1".into(),
            source: "/a/x".into(),
            destination: "/b/x".into(),
            source_kind: crate::contracts::EntryKind::File,
            destination_kind: crate::contracts::EntryKind::File,
            same_item: false,
        };
        std::thread::scope(|scope| {
            let asker = scope.spawn(|| control.ask(&prompt));
            std::thread::sleep(Duration::from_millis(50));
            tasks.cancel("t");
            assert!(asker.join().unwrap().is_none());
        });
        assert!(
            tasks
                .resolve("t-c1", ConflictDecision::Skip, false)
                .is_err()
        );
    }
}
