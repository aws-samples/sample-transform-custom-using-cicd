from __future__ import annotations

from models import Task, TodoList
from manager import (
    add_task, complete_task, filter_by_priority,
    filter_by_tag, get_overdue_tasks, get_stats, format_report,
)


def create_sample_data() -> TodoList:
    todo = TodoList(name="Work Tasks")

    tasks: list[Task] = [
        Task(
            title="Write API docs",
            priority="high",
            deadline="2024-12-01",
            tags=["docs", "api"],
            metadata={"assignee": "alice"},
        ),
        Task(
            title="Fix login bug",
            priority="high",
            deadline="2024-01-15",
            tags=["bug", "auth"],
        ),
        Task(
            title="Update dependencies",
            priority="medium",
            deadline="2025-03-01",
            tags=["maintenance"],
        ),
        Task(
            title="Refactor database layer",
            priority="low",
            tags=["refactor", "db"],
        ),
        Task(
            title="Add unit tests",
            priority="medium",
            deadline="2024-06-01",
            tags=["testing"],
            completed=True,
        ),
    ]

    for t in tasks:
        add_task(todo, t)

    return todo


def main() -> None:
    todo = create_sample_data()

    print(todo.summary())

    complete_task(todo, "Fix login bug")

    stats = get_stats(todo)
    report = format_report(todo, stats)
    print(report)

    high_priority = filter_by_priority(todo.tasks, "high")
    print("\nHigh priority tasks:")
    for t in high_priority:
        print(f"  - {t.title}")

    bug_tasks = filter_by_tag(todo.tasks, "bug")
    print("\nBug tasks:")
    for t in bug_tasks:
        print(f"  - {t.title} (completed: {t.completed})")

    overdue = get_overdue_tasks(todo.tasks)
    if overdue:
        print("\nOverdue tasks:")
        for t in overdue:
            print(f"  - {t.title} (deadline: {t.deadline})")


if __name__ == "__main__":
    main()
